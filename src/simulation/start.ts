/**
 * Opening the simulation and editing its targets from anywhere in the app (small: no engine code).
 */
import { useAppStore } from '../state/store';
import { windowFor } from '../temporal/window';
import { airportClosure, newScenario, routeSuspension, type SimulationEvent, type SimulationScenario } from './model';

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

export function openSimulation(): void {
  const s = ensureScenario();
  if (!s) return;
  const st = useAppStore.getState();
  st.setSimScenario(s);
  st.setSimOpen(true);
}

/** The event that collects airports picked on the map: an airport closure without times. */
const isQuick = (e: SimulationEvent) =>
  (e.eventType === 'AIRPORT_CLOSURE' || e.eventType === 'MULTIPLE_AIRPORT_CLOSURE') && e.enabled && e.direction === 'both';

/** Adds an airport to the closures (quick simulation: open + one click). */
export function closeAirport(id: string, times: { startMs: number | null; endMs: number | null } = { startMs: null, endMs: null }): void {
  const s = ensureScenario();
  if (!s) return;
  const sameTimes = (e: SimulationEvent) =>
    (e.startTimeUtc === null) === (times.startMs === null) && (e.endTimeUtc === null) === (times.endMs === null)
    && (times.startMs === null || e.startTimeUtc === airportClosure([], times.startMs, times.endMs).startTimeUtc)
    && (times.endMs === null || e.endTimeUtc === airportClosure([], times.startMs, times.endMs).endTimeUtc);
  const events = s.events.map((e) => ({ ...e, targetIds: [...e.targetIds] }));
  if (events.some((e) => e.targetType === 'airport' && e.enabled && e.targetIds.includes(id) && sameTimes(e))) {
    // already a target with these times
  } else {
    const q = events.find((e) => isQuick(e) && sameTimes(e));
    if (q) {
      q.targetIds.push(id);
      q.eventType = q.targetIds.length > 1 ? 'MULTIPLE_AIRPORT_CLOSURE' : 'AIRPORT_CLOSURE';
    } else events.push(airportClosure([id], times.startMs, times.endMs));
  }
  const st = useAppStore.getState();
  st.setSimScenario({ ...s, events });
  st.setSimOpen(true);
}

/** Removes an airport from every closure event (events left without targets are dropped). */
export function reopenAirport(id: string): void {
  const s = useAppStore.getState().simScenario;
  if (!s) return;
  const events = s.events
    .map((e) => (e.targetType === 'airport' ? { ...e, targetIds: e.targetIds.filter((x) => x !== id) } : e))
    .filter((e) => e.targetIds.length > 0)
    .map((e) => (e.targetType === 'airport' && e.eventType !== 'AIRPORT_CLOSURE' && e.eventType !== 'MULTIPLE_AIRPORT_CLOSURE' ? e
      : e.targetType === 'airport' ? { ...e, eventType: e.targetIds.length > 1 ? 'MULTIPLE_AIRPORT_CLOSURE' as const : 'AIRPORT_CLOSURE' as const } : e));
  useAppStore.getState().setSimScenario({ ...s, events });
}

export function suspendRoute(a: string, b: string, direction: 'both' | 'directed'): void {
  const s = ensureScenario();
  if (!s) return;
  const st = useAppStore.getState();
  st.setSimScenario({ ...s, events: [...s.events, routeSuspension(a, b, direction)] });
  st.setSimOpen(true);
}

export function resumeRoute(a: string, b: string): void {
  const s = useAppStore.getState().simScenario;
  if (!s) return;
  const hit = (id: string) => id === `${a}>${b}` || id === `${b}>${a}`;
  useAppStore.getState().setSimScenario({ ...s, events: s.events.filter((e) => !(e.targetType === 'route' && e.targetIds.some(hit))) });
}
