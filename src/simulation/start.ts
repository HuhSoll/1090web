/**
 * Opening the simulation and editing its events from anywhere in the app (small: no engine code).
 * Every edit goes through the store's history, so it can be undone.
 */
import { useAppStore } from '../state/store';
import { defaultSelection, windowFor } from '../temporal/window';
import { airportClosure, durationMs, isoMinute, newId, newScenario, parseIsoUtc, routeSuspension, type SimulationEvent, type SimulationScenario } from './model';

/** The period shown in Explore: the temporal window, else the calendar month. */
export function currentPeriod(): { startMs: number; endMs: number } | null {
  const st = useAppStore.getState();
  if (st.exploreTime === 'temporal') {
    if (st.temporalStatus.state === 'ready') return st.temporalStatus.result.window;
    if (st.temporalSel) return windowFor(st.temporalSel);
  }
  const m = st.network?.manifest.months[st.monthIndex]?.month;
  if (!m) return null;
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7)) - 1;
  return { startMs: Date.UTC(y, mo, 1), endMs: Date.UTC(y, mo + 1, 1) };
}

function ensureScenario(): SimulationScenario | null {
  const st = useAppStore.getState();
  if (st.simScenario) return st.simScenario;
  const p = currentPeriod();
  if (!p || !st.network) return null;
  return newScenario(st.network.manifest.datasetId ?? '', null, p.startMs, p.endMs);
}

/** Puts the app's clock (the temporal explorer's cursor) at the scenario's simulation time. */
export function syncClock(s: SimulationScenario): void {
  const st = useAppStore.getState();
  const at = parseIsoUtc(s.evaluationTime) ?? parseIsoUtc(s.analysisStart);
  if (at === null) return;
  const stepMs = durationMs(s.timeline.step) ?? 3_600_000;
  if (st.temporalSel) {
    if (st.temporalSel.cursorMs !== at || st.temporalSel.stepMs !== stepMs) st.patchTemporalSel({ cursorMs: at, stepMs });
  } else {
    const end = parseIsoUtc(s.analysisEnd) ?? at + 86_400_000;
    st.setTemporalSel({ ...defaultSelection({ startMs: at, endMs: end }), cursorMs: at, stepMs });
  }
}

function open(s: SimulationScenario, edit: boolean): void {
  const st = useAppStore.getState();
  const wasOpen = st.simOpen;
  if (edit && st.simScenario) st.editSimScenario(s);
  else st.setSimScenario(s);
  if (!wasOpen) {
    st.setSimOpen(true);
    syncClock(s);
  }
}

export function openSimulation(): void {
  const s = ensureScenario();
  if (s) open(s, false);
}

/** Loads a scenario (file, URL): undoable when one is already open; the clock moves to its time. */
export function loadScenario(s: SimulationScenario): void {
  open(s, true);
  syncClock(s);
}

export function editEvents(events: SimulationEvent[]): void {
  const s = useAppStore.getState().simScenario;
  if (s) useAppStore.getState().editSimScenario({ ...s, events });
}

export function editScenario(p: Partial<SimulationScenario>): void {
  const s = useAppStore.getState().simScenario;
  if (s) useAppStore.getState().editSimScenario({ ...s, ...p });
}

/** The event that collects airports picked for a quick closure: an airport closure without times. */
const isQuick = (e: SimulationEvent) =>
  (e.eventType === 'AIRPORT_CLOSURE' || e.eventType === 'MULTIPLE_AIRPORT_CLOSURE') && e.enabled && e.direction === 'both'
  && e.startTimeUtc === null && e.endTimeUtc === null;

/** Quick simulation: the airport is closed for the whole period (one click from the airport panel). */
export function closeAirport(id: string): void {
  const s = ensureScenario();
  if (!s) return;
  const events = s.events.map((e) => ({ ...e, targetIds: [...e.targetIds] }));
  if (!events.some((e) => isQuick(e) && e.targetIds.includes(id))) {
    const q = events.find(isQuick);
    if (q) {
      q.targetIds.push(id);
      q.eventType = q.targetIds.length > 1 ? 'MULTIPLE_AIRPORT_CLOSURE' : 'AIRPORT_CLOSURE';
    } else events.push(airportClosure([id]));
  }
  open({ ...s, events }, true);
}

/** Timeline: a new closure event of its own (own row), from `startMs` (null = open start). */
export function addAirportEvent(id: string, startMs: number | null, endMs: number | null): string | null {
  const s = ensureScenario();
  if (!s) return null;
  const e = airportClosure([id], startMs, endMs);
  open({ ...s, events: [...s.events, e] }, true);
  useAppStore.getState().setSimSelectedEvent(e.eventId);
  return e.eventId;
}

export function addRouteEvent(a: string, b: string, direction: 'both' | 'directed', startMs: number | null = null, endMs: number | null = null): string | null {
  const s = ensureScenario();
  if (!s) return null;
  const e = routeSuspension(a, b, direction, startMs, endMs);
  open({ ...s, events: [...s.events, e] }, true);
  useAppStore.getState().setSimSelectedEvent(e.eventId);
  return e.eventId;
}

/** Kept for the 9C panel flow: stops a route for the whole period. */
export const suspendRoute = (a: string, b: string, direction: 'both' | 'directed') => addRouteEvent(a, b, direction);

/** Removes an airport from every closure event (events left without targets are dropped). */
export function reopenAirport(id: string): void {
  const s = useAppStore.getState().simScenario;
  if (!s) return;
  editEvents(s.events
    .map((e) => (e.targetType === 'airport' ? { ...e, targetIds: e.targetIds.filter((x) => x !== id) } : e))
    .filter((e) => e.targetIds.length > 0)
    .map((e) => (e.targetType === 'airport' && (e.eventType === 'AIRPORT_CLOSURE' || e.eventType === 'MULTIPLE_AIRPORT_CLOSURE')
      ? { ...e, eventType: e.targetIds.length > 1 ? 'MULTIPLE_AIRPORT_CLOSURE' as const : 'AIRPORT_CLOSURE' as const } : e)));
}

export function resumeRoute(a: string, b: string): void {
  const s = useAppStore.getState().simScenario;
  if (!s) return;
  const hit = (id: string) => id === `${a}>${b}` || id === `${b}>${a}`;
  editEvents(s.events.filter((e) => !(e.targetType === 'route' && e.targetIds.some(hit))));
}

export function updateEvent(id: string, p: Partial<SimulationEvent>): void {
  const s = useAppStore.getState().simScenario;
  if (!s) return;
  editEvents(s.events.map((e) => (e.eventId === id ? { ...e, ...p } : e)));
}

export function removeEvent(id: string): void {
  const st = useAppStore.getState();
  const s = st.simScenario;
  if (!s) return;
  editEvents(s.events.filter((e) => e.eventId !== id));
  if (st.simSelectedEvent === id) st.setSimSelectedEvent(null);
}

export function duplicateEvent(id: string): void {
  const s = useAppStore.getState().simScenario;
  const e = s?.events.find((x) => x.eventId === id);
  if (!s || !e) return;
  const copy = { ...e, eventId: newId('evt'), targetIds: [...e.targetIds], label: e.label ? `${e.label} (2)` : '' };
  editEvents([...s.events, copy]);
  useAppStore.getState().setSimSelectedEvent(copy.eventId);
}

/** Sets a time of an event (ms or null); keeps start < end by refusing an invalid change. */
export function setEventTime(id: string, which: 'start' | 'end', ms: number | null): boolean {
  const s = useAppStore.getState().simScenario;
  const e = s?.events.find((x) => x.eventId === id);
  if (!s || !e) return false;
  const start = which === 'start' ? ms : parseIsoUtc(e.startTimeUtc);
  const end = which === 'end' ? ms : parseIsoUtc(e.endTimeUtc);
  if (start !== null && end !== null && !(end > start)) return false;
  updateEvent(id, which === 'start' ? { startTimeUtc: ms === null ? null : isoMinute(ms) } : { endTimeUtc: ms === null ? null : isoMinute(ms) });
  return true;
}
