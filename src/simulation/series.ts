/**
 * The scenario over time (Phase 9D). Pure functions.
 *
 * Each value belongs to one instant (structural model) or one window (temporal model / dynamic
 * baseline) and is computed for it; nothing is interpolated between instants. In the structural
 * model with a fixed baseline the network can only change at event boundaries, so the series is
 * computed once per distinct set of events in effect and shared by every instant with that set.
 */
import type { StaticNetwork } from '../data/model/network';
import type { ResearchMonth } from '../research/data';
import { buildResearchNetwork, type ResearchNetwork, type ScopeContext } from '../research/network';
import {
  activeSignature,
  applyStructuralResearch,
  boundaries,
  eventActiveAt,
  networkIndex,
  resolveDisruption,
  structuralState,
  type Disruption,
} from './disruption';
import { directImpact, impactInputOf, researchConfigOf, restrictTo, type DirectImpact } from './engine';
import { alternativePaths, distancesFrom, graphOf } from './impact';
import type { Graph } from '../research/graph';
import { durationMs, parseIsoUtc, type ScenarioContext, type SimulationEvent, type SimulationScenario } from './model';

export interface SeriesPoint {
  t: number;
  /** ids of the enabled events in effect at t */
  active: string[];
  /** structural: signature of the unavailable set at t (shared results); null in the temporal model */
  sig: string | null;
  lostConnections: number | null;
  reducedConnections: number | null;
  /** observed flights selected (structural: on unavailable connections over the baseline period;
   *  temporal: records inside the disruption in the window / bin) */
  flights: number | null;
  affectedAirports: number | null;
  /** spillover pairs that lost every path (only where the connectivity analysis was run) */
  unreachable: number | null;
  efficiency: number | null;
}

/** Shown range: the scenario's own, else the baseline period widened to the event times (clamped to the data). */
export function timelineRange(s: SimulationScenario, events: readonly SimulationEvent[], data: { startMs: number; endMs: number }): { startMs: number; endMs: number } {
  const clamp = (x: number) => Math.min(data.endMs, Math.max(data.startMs, x));
  const ts = parseIsoUtc(s.timeline.start);
  const te = parseIsoUtc(s.timeline.end);
  if (ts !== null && te !== null && te > ts) return { startMs: clamp(ts), endMs: clamp(te) };
  let start = parseIsoUtc(s.analysisStart) ?? data.startMs;
  let end = parseIsoUtc(s.analysisEnd) ?? start + 86_400_000;
  for (const e of events) {
    if (!e.enabled) continue;
    const a = parseIsoUtc(e.startTimeUtc);
    const b = parseIsoUtc(e.endTimeUtc);
    if (a !== null) start = Math.min(start, a);
    if (b !== null) end = Math.max(end, b);
  }
  // a little room after the last boundary so a reopening is visible
  const pad = Math.max(3_600_000, Math.round((end - start) * 0.04 / 3_600_000) * 3_600_000);
  return { startMs: clamp(Math.floor(start / 3_600_000) * 3_600_000), endMs: clamp(Math.ceil((end + pad) / 3_600_000) * 3_600_000) };
}

export function stepOf(s: SimulationScenario): number {
  return durationMs(s.timeline.step) ?? 3_600_000;
}

/** Step instants in [start, end), at most `max` (the step is widened if needed). */
export function seriesTimes(range: { startMs: number; endMs: number }, stepMs: number, max = 480): { times: number[]; stepMs: number } {
  let step = stepMs;
  while ((range.endMs - range.startMs) / step > max) step *= 2;
  const times: number[] = [];
  for (let t = range.startMs; t < range.endMs; t += step) times.push(t);
  return { times, stepMs: step };
}

/** Next / previous event boundary from t (null when there is none). */
export function nextBoundary(d: Disruption, t: number, dir: 1 | -1): number | null {
  const b = boundaries(d);
  if (dir > 0) return b.find((x) => x > t) ?? null;
  for (let i = b.length - 1; i >= 0; i--) if (b[i]! < t) return b[i]!;
  return null;
}

export const activeEventIds = (events: readonly SimulationEvent[], t: number) => events.filter((e) => eventActiveAt(e, t)).map((e) => e.eventId);

export interface StructuralBase {
  network: StaticNetwork;
  scope: ScopeContext;
  scenario: SimulationScenario;
  beforeR: ResearchMonth;
  beforeNet: ResearchNetwork;
}

/** Direct impact of the structural model at one instant (no connectivity analysis). */
export function structuralDirectAt(b: StructuralBase, d: Disruption, at: number): DirectImpact {
  const routeEnds = (rid: number): [number, number] => [b.network.routes[rid]!.a, b.network.routes[rid]!.b];
  const afterR = applyStructuralResearch(b.beforeR, structuralState(d, { at }), routeEnds);
  const month = b.beforeR.month.slice(0, 7);
  const config = researchConfigOf(b.scenario, /^\d{4}-\d{2}/.test(month) ? month : '2026-01');
  const afterNet = restrictTo(buildResearchNetwork(b.scope, afterR, { ...config, minFlights: 1 }), b.beforeNet);
  return directImpact(b.network, b.scope, b.scenario, d, b.beforeR, afterR, b.beforeNet, afterNet);
}

/**
 * Structural series on a fixed baseline: one evaluation per distinct unavailable set.
 * `memo` (signature -> direct impact) can be kept between calls.
 */
export function structuralSeries(b: StructuralBase, d: Disruption, times: readonly number[], memo = new Map<string, DirectImpact>()): SeriesPoint[] {
  return times.map((t) => {
    const sig = activeSignature(d, t);
    let di = memo.get(sig);
    if (!di) {
      di = structuralDirectAt(b, d, t);
      memo.set(sig, di);
    }
    return {
      t, active: activeEventIds(b.scenario.events, t), sig,
      lostConnections: di.lostConnections, reducedConnections: di.reducedConnections, flights: di.flights,
      affectedAirports: di.affectedAirports, unreachable: null, efficiency: null,
    };
  });
}

export interface EventContribution {
  eventId: string;
  /** with every event / with this event left out */
  lostWith: number;
  lostWithout: number;
  flightsWith: number;
  flightsWithout: number;
}

/**
 * Leave-one-out comparison at one instant (structural model): the scenario with every event,
 * against the scenario without one event. The differences are NOT additive: with overlapping
 * closures a connection lost by two events is not lost when only one is left out.
 */
export function leaveOneOut(b: StructuralBase, ctx: ScenarioContext, at: number): EventContribution[] {
  const idx = networkIndex(b.network);
  const all = resolveDisruption(b.scenario.events, idx, ctx);
  const withAll = structuralDirectAt(b, all, at);
  return b.scenario.events
    .filter((e) => eventActiveAt(e, at))
    .map((e) => {
      const d = resolveDisruption(b.scenario.events.filter((x) => x.eventId !== e.eventId), idx, ctx);
      const w = structuralDirectAt(b, d, at);
      return { eventId: e.eventId, lostWith: withAll.lostConnections, lostWithout: w.lostConnections, flightsWith: withAll.flights, flightsWithout: w.flights };
    });
}

export interface PairCause {
  /** shortest path before (global airport indices), [] when none */
  before: number[];
  after: number[];
  /** airports on the original path that are scenario targets */
  targetsOnPath: number[];
  /** consecutive airport pairs of the original path that are not connected afterwards */
  lostLegs: [number, number][];
  /** structural model: for each event in effect, the hops when only that event is left out (-1 = still unreachable) */
  withoutEvent: { eventId: string; hops: number }[];
}

/**
 * Why a pair changed. The original path's stopped airports and lost legs are listed; whether one
 * event alone explains the change is checked by leaving it out (structural model only). With
 * several overlapping events, none of them is named "the cause" on its own.
 */
export function pairCause(
  b: StructuralBase, ctx: ScenarioContext, at: number, s: number, t: number,
  graphs: { before: Graph; after: Graph; nodes: number[] }, targets: readonly number[], withLeaveOneOut: boolean,
): PairCause | null {
  const local = new Map(graphs.nodes.map((g, i) => [g, i]));
  const ls = local.get(s);
  const lt = local.get(t);
  if (ls === undefined || lt === undefined) return null;
  const toGlobal = (p: number[]) => p.map((i) => graphs.nodes[i]!);
  const before = toGlobal(alternativePaths(graphs.before, ls, lt, 1)[0] ?? []);
  const after = toGlobal(alternativePaths(graphs.after, ls, lt, 1)[0] ?? []);
  const tset = new Set(targets);
  const targetsOnPath = before.slice(1, -1).filter((x) => tset.has(x));
  const lostLegs: [number, number][] = [];
  for (let i = 0; i + 1 < before.length; i++) {
    const a = local.get(before[i]!)!;
    const c = local.get(before[i + 1]!)!;
    let ok = false;
    for (let p = graphs.after.outStart[a]!; p < graphs.after.outStart[a + 1]!; p++) if (graphs.after.outNbr[p] === c) ok = true;
    if (!ok) lostLegs.push([before[i]!, before[i + 1]!]);
  }
  const withoutEvent: PairCause['withoutEvent'] = [];
  if (withLeaveOneOut && b.scenario.simulationModel === 'structural') {
    const idx = networkIndex(b.network);
    const routeEnds = (rid: number): [number, number] => [b.network.routes[rid]!.a, b.network.routes[rid]!.b];
    const config = researchConfigOf(b.scenario, '2026-01');
    for (const e of b.scenario.events.filter((x) => eventActiveAt(x, at))) {
      const d = resolveDisruption(b.scenario.events.filter((x) => x.eventId !== e.eventId), idx, ctx);
      const afterR = applyStructuralResearch(b.beforeR, structuralState(d, { at }), routeEnds);
      const afterNet = restrictTo(buildResearchNetwork(b.scope, afterR, { ...config, minFlights: 1 }), b.beforeNet);
      const { input } = impactInputOf(b.beforeNet, afterNet, d, b.scenario.analysisSettings.directed);
      const g = graphOf(input.n, input.after, input.directed);
      const dist = distancesFrom(g, ls);
      withoutEvent.push({ eventId: e.eventId, hops: dist[lt]! });
    }
  }
  return { before, after, targetsOnPath, lostLegs, withoutEvent };
}
