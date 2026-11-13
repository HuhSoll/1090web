/**
 * Scenario application, as pure functions.
 *
 * Events are first resolved into one DISRUPTION: for every airport side (departures, arrivals)
 * and every route direction, the union of the intervals in which it is closed. The union is
 * built from the set of enabled events, so the result does not depend on the order of the
 * events, and repeating an event changes nothing (idempotent). A flight is either affected or
 * not; it is never subtracted twice, however many events touch it.
 *
 * Later event types that are not commutative (e.g. a capacity reduction factor) would be applied
 * after this union, in a documented order (docs/simulation-methodology.md, "Order of operations").
 */
import type { MonthData, StaticNetwork } from '../data/model/network';
import type { MonthRecordTuple } from '../data/model/schema';
import type { ResearchMonth } from '../research/data';
import { eventIssues, isImplemented, parseIsoUtc, type ScenarioContext, type ScenarioIssue, type SimulationEvent } from './model';

/** Half-open [s, e) in UTC ms; -Infinity / Infinity for open ends. */
export interface Interval {
  s: number;
  e: number;
}

export interface Disruption {
  /** airport index -> intervals in which its departures / arrivals are closed */
  dep: Map<number, Interval[]>;
  arr: Map<number, Interval[]>;
  /** route id -> intervals per direction (ab = a -> b as in routes.json) */
  ab: Map<number, Interval[]>;
  ba: Map<number, Interval[]>;
  /** airports that are a target of an applied closure (any side) */
  targetAirports: number[];
  /** airport pairs [a, b] (route a < b order) that are a target of an applied suspension */
  targetRoutes: number[];
  issues: ScenarioIssue[];
  /** ids of the events that were applied */
  applied: string[];
}

/** Sorted union of intervals (touching intervals are merged; [1,2) + [2,3) = [1,3)). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((x) => x.e > x.s).sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ s: x.s, e: x.e });
  }
  return out;
}

export function inIntervals(list: readonly Interval[] | undefined, t: number): boolean {
  if (!list || !Number.isFinite(t)) return false;
  for (const x of list) if (t >= x.s && t < x.e) return true;
  return false;
}

export function overlaps(list: readonly Interval[] | undefined, w: Interval): boolean {
  if (!list) return false;
  for (const x of list) if (x.s < w.e && x.e > w.s) return true;
  return false;
}

export interface NetworkIndex {
  airportIndex: Map<string, number>;
  /** "A|B" (A < B) -> route id */
  routeIndex: Map<string, number>;
  routeEnds: (rid: number) => [number, number];
}

export function networkIndex(network: StaticNetwork): NetworkIndex {
  const airportIndex = new Map(network.airports.map((a, i) => [a.id, i]));
  const routeIndex = new Map(network.routes.map((r, i) => {
    const a = network.airports[r.a]!.id;
    const b = network.airports[r.b]!.id;
    return [a < b ? `${a}|${b}` : `${b}|${a}`, i] as const;
  }));
  return { airportIndex, routeIndex, routeEnds: (rid) => [network.routes[rid]!.a, network.routes[rid]!.b] };
}

export function scenarioContext(network: StaticNetwork, datasetVersion: string | null, dataStartMs: number, dataEndMs: number): ScenarioContext {
  const ids = network.airports.map((a) => a.id);
  return {
    datasetId: network.manifest.datasetId ?? '',
    datasetVersion,
    airportIds: new Set(ids),
    routeKeys: new Set(network.routes.map((r) => {
      const a = ids[r.a]!;
      const b = ids[r.b]!;
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    })),
    dataStartMs,
    dataEndMs,
  };
}

/**
 * Resolves the enabled, valid events into a Disruption. Invalid events or targets are reported
 * in `issues` and skipped; nothing is guessed.
 */
export function resolveDisruption(events: readonly SimulationEvent[], idx: NetworkIndex, ctx: ScenarioContext): Disruption {
  const dep = new Map<number, Interval[]>();
  const arr = new Map<number, Interval[]>();
  const ab = new Map<number, Interval[]>();
  const ba = new Map<number, Interval[]>();
  const targetAirports = new Set<number>();
  const targetRoutes = new Set<number>();
  const issues: ScenarioIssue[] = [];
  const applied: string[] = [];
  const add = (m: Map<number, Interval[]>, k: number, x: Interval) => {
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  };
  for (const e of events) {
    if (!e.enabled) continue;
    const problems = eventIssues(e, ctx);
    issues.push(...problems);
    if (!isImplemented(e.eventType) || problems.some((p) => p.code === 'invalid_event_period' || p.code === 'no_targets')) continue;
    const s = e.startTimeUtc === null ? -Infinity : parseIsoUtc(e.startTimeUtc)!;
    const t = e.endTimeUtc === null ? Infinity : parseIsoUtc(e.endTimeUtc)!;
    const x = { s, e: t };
    let used = false;
    for (const id of e.targetIds) {
      if (e.targetType === 'airport') {
        const i = idx.airportIndex.get(id);
        if (i === undefined) continue;
        if (e.direction !== 'arrivals') add(dep, i, x);
        if (e.direction !== 'departures') add(arr, i, x);
        targetAirports.add(i);
        used = true;
      } else {
        const [a, b] = id.split('>');
        const rid = a && b ? idx.routeIndex.get(a < b ? `${a}|${b}` : `${b}|${a}`) : undefined;
        if (rid === undefined) continue;
        const [ra] = idx.routeEnds(rid);
        const forward = idx.airportIndex.get(a!) === ra; // listed direction is the route's a -> b
        if (e.direction === 'both' || forward) add(ab, rid, x);
        if (e.direction === 'both' || !forward) add(ba, rid, x);
        targetRoutes.add(rid);
        used = true;
      }
    }
    if (used) applied.push(e.eventId);
  }
  const merge = (m: Map<number, Interval[]>) => new Map([...m].map(([k, v]) => [k, mergeIntervals(v)]));
  return {
    dep: merge(dep), arr: merge(arr), ab: merge(ab), ba: merge(ba),
    targetAirports: [...targetAirports].sort((x, y) => x - y),
    targetRoutes: [...targetRoutes].sort((x, y) => x - y),
    issues, applied,
  };
}

export const isEmpty = (d: Disruption) => d.dep.size + d.arr.size + d.ab.size + d.ba.size === 0;

// ---- structural model ---------------------------------------------------------------------------

/**
 * What is unavailable in the structural model. `at` = an instant (fixed baseline): intervals that
 * contain it; `window` = a period (dynamic baseline): intervals that overlap it. null = every
 * applied event regardless of its times.
 */
export interface StructuralState {
  dep: Set<number>;
  arr: Set<number>;
  ab: Set<number>;
  ba: Set<number>;
}

export function structuralState(d: Disruption, when: { at: number } | { window: Interval } | null): StructuralState {
  const pick = (m: Map<number, Interval[]>) => {
    const out = new Set<number>();
    for (const [k, list] of m) {
      if (when === null || ('at' in when ? inIntervals(list, when.at) : overlaps(list, when.window))) out.add(k);
    }
    return out;
  };
  return { dep: pick(d.dep), arr: pick(d.arr), ab: pick(d.ab), ba: pick(d.ba) };
}

export const structuralEmpty = (s: StructuralState) => s.dep.size + s.arr.size + s.ab.size + s.ba.size === 0;

/** Is a directed movement on route `rid` (dir 0 = a -> b) unavailable in the structural state? */
export function structuralRemoved(s: StructuralState, rid: number, dir: number, a: number, b: number): boolean {
  const origin = dir === 0 ? a : b;
  const dest = dir === 0 ? b : a;
  return s.dep.has(origin) || s.arr.has(dest) || (dir === 0 ? s.ab.has(rid) : s.ba.has(rid));
}

/** Research rows without the unavailable movements (a new month; the input is not changed). */
export function applyStructuralResearch(m: ResearchMonth, s: StructuralState, routeEnds: (rid: number) => [number, number]): ResearchMonth {
  const keep: number[] = [];
  for (let i = 0; i < m.size; i++) {
    const [a, b] = routeEnds(m.route[i]!);
    if (!structuralRemoved(s, m.route[i]!, m.dir[i]!, a, b)) keep.push(i);
  }
  return selectRows(m, keep);
}

export function selectRows(m: ResearchMonth, keep: readonly number[]): ResearchMonth {
  const pick = <T extends Int32Array | Uint8Array | Float64Array>(arr: T): T => {
    const out = new (arr.constructor as new (n: number) => T)(keep.length);
    keep.forEach((src, k) => {
      out[k] = arr[src]!;
    });
    return out;
  };
  return {
    ...m, size: keep.length, route: pick(m.route), dir: pick(m.dir), carrier: pick(m.carrier), tier: pick(m.tier),
    passenger: pick(m.passenger), cargo: pick(m.cargo), unknown: pick(m.unknown),
  };
}

/** Explore records without the unavailable movements. */
export function applyStructuralExplore(m: MonthData, s: StructuralState, routeEnds: (rid: number) => [number, number]): MonthData {
  return {
    ...m,
    records: m.records.filter((r: MonthRecordTuple) => {
      const [a, b] = routeEnds(r[0]);
      return !structuralRemoved(s, r[0], r[1], a, b);
    }),
  };
}

// ---- temporal model: one flight ------------------------------------------------------------------

/**
 * Longest track assumed when one end has no time (99.99% of tracks are shorter; 1,005 of 26.9 M
 * flights are longer than 20 h). Used only to decide whether an unknown time COULD fall inside a
 * closure; it never moves a flight into or out of the affected set.
 */
export const MAX_TRACK_MS = 24 * 3_600_000;

/** Why a flight is affected (bit flags). UNDETERMINED: a closed side without a time that could fall inside. */
export const MATCH = { DEP: 1, ARR: 2, ROUTE: 4, UNDETERMINED: 8 } as const;

export interface FlightTimes {
  /** reference time (track start, else track end) */
  refMs: number;
  /** 0 TRACK_START, 1 TRACK_END_FALLBACK */
  basis: number;
  /** track end; NaN when unknown (only used with the endpoint proxy) */
  endMs: number;
}

/**
 * Matches one observed flight against the disruption (records, not aggregates).
 *
 *  endpoint proxy:  departure side = track start (unknown for TRACK_END_FALLBACK flights),
 *                   arrival side   = track end (unknown when missing)
 *  reference proxy: both sides use the reference time (Phase 9A definition)
 *  route suspension: the flight's reference time, in either proxy (the time the route was flown)
 *
 * Returns MATCH flags; a flight is affected when any of DEP, ARR, ROUTE is set. UNDETERMINED is
 * set (and the flight kept) when a side of a closed airport has no time at all.
 */
export function matchFlight(d: Disruption, rid: number, dir: number, a: number, b: number, t: FlightTimes, proxy: 'endpoint' | 'reference'): number {
  const origin = dir === 0 ? a : b;
  const dest = dir === 0 ? b : a;
  const depMs = proxy === 'reference' ? t.refMs : t.basis === 0 ? t.refMs : NaN;
  const arrMs = proxy === 'reference' ? t.refMs : t.basis === 1 ? t.refMs : t.endMs;
  let flags = 0;
  const depList = d.dep.get(origin);
  if (depList) {
    if (Number.isFinite(depMs)) {
      if (inIntervals(depList, depMs)) flags |= MATCH.DEP;
    } else if (Number.isFinite(arrMs) && overlaps(depList, { s: arrMs - MAX_TRACK_MS, e: arrMs + 1 })) {
      flags |= MATCH.UNDETERMINED; // departed at most MAX_TRACK_MS before its known arrival
    }
  }
  const arrList = d.arr.get(dest);
  if (arrList) {
    if (Number.isFinite(arrMs)) {
      if (inIntervals(arrList, arrMs)) flags |= MATCH.ARR;
    } else if (Number.isFinite(depMs) && overlaps(arrList, { s: depMs, e: depMs + MAX_TRACK_MS })) {
      flags |= MATCH.UNDETERMINED; // arrived at most MAX_TRACK_MS after its known departure
    }
  }
  const routeList = dir === 0 ? d.ab.get(rid) : d.ba.get(rid);
  if (routeList && inIntervals(routeList, t.refMs)) flags |= MATCH.ROUTE;
  if (flags & (MATCH.DEP | MATCH.ARR | MATCH.ROUTE)) flags &= ~MATCH.UNDETERMINED;
  return flags;
}

export const affected = (flags: number) => (flags & (MATCH.DEP | MATCH.ARR | MATCH.ROUTE)) !== 0;

/** Structured-clone friendly form of a Disruption (for the worker). */
export interface DisruptionWire {
  dep: [number, Interval[]][];
  arr: [number, Interval[]][];
  ab: [number, Interval[]][];
  ba: [number, Interval[]][];
}
export const toWire = (d: Disruption): DisruptionWire => ({ dep: [...d.dep], arr: [...d.arr], ab: [...d.ab], ba: [...d.ba] });
export function fromWire(w: DisruptionWire): Disruption {
  return { dep: new Map(w.dep), arr: new Map(w.arr), ab: new Map(w.ab), ba: new Map(w.ba), targetAirports: [], targetRoutes: [], issues: [], applied: [] };
}
