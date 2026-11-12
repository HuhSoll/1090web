/**
 * Time-resolved observed flights (Phase 9A): types, decoding and time-window selection.
 * Pure functions; loading is in loader.ts. Format produced by pipeline/temporal.py.
 *
 * Time semantics (UTC):
 *  - referenceTime = ADS-B track start, else track end (`timeBasis`). It is NOT a scheduled or
 *    actual departure time.
 *  - A window [start, end) contains a flight when start <= referenceTime < end. The public files
 *    keep the reference time to the minute, so minute-aligned windows are exact.
 *  - Flights possibly airborne during a window are a different selection (not implemented).
 */
import type { ResearchMonth } from '../research/data';

export const TEMPORAL_SCHEMA_VERSION = 1;
export const DAY_MS = 86_400_000;

/**
 * One UTC day file, grouped by route (pipeline/temporal.py day_events):
 *  r  route ids of the groups, delta-encoded; k  flights per group;
 *  t  referenceTime in minutes since 00:00 UTC, delta-encoded inside each group;
 *  c  airline index; x  direction + 2*class + 6*(tier-1) + 24*timeBasis (one per flight).
 */
export interface DayFile {
  schemaVersion: number;
  day: string;
  n: number;
  r: number[];
  k: number[];
  t: number[];
  c: number[];
  x: number[];
}

export interface DayIndexEntry {
  day: string;
  flights: number;
  file: string;
  hourly: number[];
  regions: Record<string, number>;
  anomaly: null | {
    direction: 'low' | 'high';
    scope: string;
    evidence: string;
    worldRatio: number | null;
    gapHours: number;
    gapShareOfShortfall: number | null;
  };
}

export interface TemporalIndex {
  schemaVersion: number;
  datasetId: string;
  datasetVersion: string | null;
  days: DayIndexEntry[];
}

export type TimeBasis = 'TRACK_START' | 'TRACK_END_FALLBACK';

/** Decoded day: typed arrays, absolute epoch milliseconds (UTC) of the reference time. */
export interface DayEvents {
  day: string;
  size: number;
  timeMs: Float64Array;
  route: Int32Array;
  carrier: Int32Array;
  direction: Uint8Array;
  /** 0 passenger, 1 cargo, 2 unknown */
  aircraftClass: Uint8Array;
  /** 1..4 */
  tier: Uint8Array;
  /** 0 TRACK_START, 1 TRACK_END_FALLBACK */
  basis: Uint8Array;
}

export function dayStartMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`bad day ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Decodes a day file into typed arrays sorted by reference time (for binary-searched windows). */
export function decodeDay(f: DayFile): DayEvents {
  if (f.schemaVersion !== TEMPORAL_SCHEMA_VERSION) throw new Error(`unsupported temporal schema ${f.schemaVersion}`);
  const n = f.n;
  if (f.t.length !== n || f.c.length !== n || f.x.length !== n || f.r.length !== f.k.length || f.k.reduce((a, b) => a + b, 0) !== n) {
    throw new Error(`day ${f.day}: column lengths do not match n`);
  }
  const base = dayStartMs(f.day);
  const minute = new Int32Array(n);
  const route = new Int32Array(n);
  let i = 0;
  let rid = 0;
  for (let g = 0; g < f.r.length; g++) {
    rid = g === 0 ? f.r[0]! : rid + f.r[g]!;
    let m = 0;
    for (let j = 0; j < f.k[g]!; j++, i++) {
      m += f.t[i]!;
      if (m < 0 || m >= 1440) throw new Error(`day ${f.day}: time outside the day`);
      minute[i] = m;
      route[i] = rid;
    }
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => minute[a]! - minute[b]! || a - b);
  const ev: DayEvents = {
    day: f.day,
    size: n,
    timeMs: new Float64Array(n),
    route: new Int32Array(n),
    carrier: new Int32Array(n),
    direction: new Uint8Array(n),
    aircraftClass: new Uint8Array(n),
    tier: new Uint8Array(n),
    basis: new Uint8Array(n),
  };
  order.forEach((src, k) => {
    ev.timeMs[k] = base + minute[src]! * 60_000;
    ev.route[k] = route[src]!;
    ev.carrier[k] = f.c[src]!;
    const x = f.x[src]!;
    ev.direction[k] = x % 2;
    ev.aircraftClass[k] = Math.floor(x / 2) % 3;
    ev.tier[k] = (Math.floor(x / 6) % 4) + 1;
    ev.basis[k] = Math.floor(x / 24);
  });
  return ev;
}

/** UTC days whose files can contain flights with start <= referenceTime < end. */
export function daysForWindow(startMs: number, endMs: number): string[] {
  if (!(endMs > startMs)) return [];
  const out: string[] = [];
  let d = Math.floor(startMs / DAY_MS) * DAY_MS;
  const last = Math.floor((endMs - 1) / DAY_MS) * DAY_MS;
  for (; d <= last; d += DAY_MS) out.push(utcDay(d));
  return out;
}

/** First index with timeMs >= t (arrays are sorted). */
export function lowerBound(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface WindowSelection {
  startMs: number;
  endMs: number;
  /** [day, from, to) index ranges within each loaded day */
  ranges: { events: DayEvents; from: number; to: number }[];
  flights: number;
  /** days the window needs but that are not in the data */
  missingDays: string[];
}

/** Half-open selection [start, end) over decoded days (binary search, no copying). */
export function selectWindow(days: ReadonlyMap<string, DayEvents>, startMs: number, endMs: number): WindowSelection {
  const ranges: WindowSelection['ranges'] = [];
  const missingDays: string[] = [];
  let flights = 0;
  for (const d of daysForWindow(startMs, endMs)) {
    const ev = days.get(d);
    if (!ev) {
      missingDays.push(d);
      continue;
    }
    const from = lowerBound(ev.timeMs, startMs);
    const to = lowerBound(ev.timeMs, endMs);
    if (to > from) {
      ranges.push({ events: ev, from, to });
      flights += to - from;
    }
  }
  return { startMs, endMs, ranges, flights, missingDays };
}

/**
 * The selection as a ResearchMonth (one row per flight), so Research Mode's network building,
 * filters (tiers, classes, airline, area, threshold) and metrics apply unchanged to any window.
 * `carriers` is the dataset's carrier list (manifest order), which the day files index into.
 */
export function windowAsResearchMonth(sel: WindowSelection, carriers: readonly string[], label: string): ResearchMonth {
  const n = sel.flights;
  const m: ResearchMonth = {
    month: label,
    observedDays: 0,
    daysInMonth: (sel.endMs - sel.startMs) / DAY_MS,
    size: n,
    route: new Int32Array(n),
    dir: new Uint8Array(n),
    carrier: new Int32Array(n),
    carriers: [...carriers],
    tier: new Uint8Array(n),
    passenger: new Float64Array(n),
    cargo: new Float64Array(n),
    unknown: new Float64Array(n),
    inconsistencies: 0,
  };
  let k = 0;
  for (const { events: ev, from, to } of sel.ranges) {
    for (let i = from; i < to; i++, k++) {
      m.route[k] = ev.route[i]!;
      m.dir[k] = ev.direction[i]!;
      m.carrier[k] = ev.carrier[i]!;
      m.tier[k] = ev.tier[i]!;
      const cls = ev.aircraftClass[i]!;
      if (cls === 0) m.passenger[k] = 1;
      else if (cls === 1) m.cargo[k] = 1;
      else m.unknown[k] = 1;
    }
  }
  return m;
}

/** Route flights in a selection: directed (route*2 + direction) or undirected (route). */
export function routeCounts(sel: WindowSelection, directed: boolean): Map<number, number> {
  const out = new Map<number, number>();
  for (const { events: ev, from, to } of sel.ranges) {
    for (let i = from; i < to; i++) {
      const key = directed ? ev.route[i]! * 2 + ev.direction[i]! : ev.route[i]!;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/** Flights per hour of the window (bin i = [start + i h, start + (i+1) h)). */
export function hourlyCounts(sel: WindowSelection): number[] {
  const hours = Math.ceil((sel.endMs - sel.startMs) / 3_600_000);
  const out = new Array<number>(hours).fill(0);
  for (const { events: ev, from, to } of sel.ranges) {
    for (let i = from; i < to; i++) out[Math.floor((ev.timeMs[i]! - sel.startMs) / 3_600_000)]!++;
  }
  return out;
}
