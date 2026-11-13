/**
 * Incremental aggregation of time windows of any length (pure; runs in the temporal worker and
 * in tests). Day files are added one at a time, so a window of weeks or months never keeps all
 * of its flights in memory: only the aggregate (route x direction x airline x tier x class) and
 * the time series grow.
 *
 * The aggregate keeps every attribute the monthly data and Research Mode filter on, so a calendar
 * month aggregated from day files equals the monthly file (tests/temporalData.test.ts).
 */
import type { MonthData } from '../data/model/network';
import type { MonthRecordTuple } from '../data/model/schema';
import type { ResearchMonth } from '../research/data';
import { affected, matchFlight, MATCH, type Disruption } from '../simulation/disruption';
import { lowerBound, type DayEvents } from './model';
import type { TimeBasisFilter, TimeWindow } from './window';

/** Static route information the series filters need (from the network). */
export interface RouteGeo {
  /** airport index of each route end */
  a: Int32Array;
  b: Int32Array;
  /** country index of each airport */
  airportCountry: Int32Array;
}

/** Filters for the time series (the aggregate itself is unfiltered except for the time basis). */
export interface SeriesFilter {
  country: number | null;
  carrier: number | null;
  passengerOnly: boolean;
  /** false = only T1-T3 (Explore's "observed only") */
  includeT4: boolean;
  /** airport index whose connections are counted per bin */
  airport: number | null;
}

export interface AggregateRows {
  size: number;
  route: Int32Array;
  dir: Uint8Array;
  carrier: Int32Array;
  /** 1..4 */
  tier: Uint8Array;
  /** 0 passenger, 1 cargo, 2 unknown */
  cls: Uint8Array;
  count: Int32Array;
}

export interface WindowSeries {
  startMs: number;
  binMs: number;
  /** flights per bin after the series filter */
  flights: number[];
  /** distinct routes with >= 1 flight per bin after the series filter */
  routes: number[];
  /** distinct airports connected to the selected airport per bin (null without airport) */
  partners: number[] | null;
}

export interface AggregateResult {
  window: TimeWindow;
  basis: TimeBasisFilter;
  rows: AggregateRows;
  /** flights in the window by time basis (before the basis filter) */
  trackStart: number;
  fallback: number;
  /** flights kept after the basis filter */
  flights: number;
  series: WindowSeries;
  /** days in the window, the days with a file, the days loaded */
  days: string[];
  missingDays: string[];
  /** Phase 9C: flights selected by the scenario (null without one) */
  affected?: AggregateRows | null;
  disruption?: DisruptionStats | null;
}

/**
 * Flights of the window matched against a scenario (Phase 9C), from the flight records before any
 * aggregation. Counts are observed flights selected as affected by the hypothetical disruption.
 */
export interface DisruptionStats {
  proxy: 'endpoint' | 'reference';
  /** affected flights under the chosen proxy (each flight once) */
  affected: number;
  /** affected flights by the flight's time basis: [TRACK_START, TRACK_END_FALLBACK] */
  byBasis: [number, number];
  /** matched by the departure side, the arrival side, a route suspension (a flight can have several) */
  dep: number;
  arr: number;
  route: number;
  /** touching a closed airport on a side without any time (kept, not counted as affected) */
  undetermined: number;
  /** the same selection with the other proxy, for comparison (null when unavailable) */
  affectedReference: number;
  affectedEndpoint: number | null;
  /** affected flights per series bin */
  series: number[];
  /** days matched without track ends (reference proxy used for them) */
  daysWithoutEndpoints: string[];
}

const N_CLASS = 3;
const N_TIER = 4;

export class WindowAggregator {
  private readonly counts = new Map<number, number>();
  trackStart = 0;
  fallback = 0;
  flights = 0;
  private readonly binFlights: number[];
  private readonly binRoutes: Set<number>[];
  private readonly binPartners: Set<number>[] | null;
  private disruption: Disruption | null = null;
  private proxy: 'endpoint' | 'reference' = 'endpoint';
  private readonly affectedCounts = new Map<number, number>();
  private stats: DisruptionStats | null = null;

  constructor(
    readonly window: TimeWindow,
    readonly basis: TimeBasisFilter,
    readonly carriers: number,
    readonly binMs: number,
    readonly geo: RouteGeo | null = null,
    readonly filter: SeriesFilter | null = null,
  ) {
    const bins = Math.max(1, Math.ceil((window.endMs - window.startMs) / binMs));
    this.binFlights = new Array<number>(bins).fill(0);
    this.binRoutes = Array.from({ length: bins }, () => new Set<number>());
    this.binPartners = filter?.airport != null ? Array.from({ length: bins }, () => new Set<number>()) : null;
  }

  private key(route: number, dir: number, carrier: number, tier: number, cls: number): number {
    return (((route * 2 + dir) * this.carriers + carrier) * N_TIER + (tier - 1)) * N_CLASS + cls;
  }

  private passesSeries(route: number, carrier: number, tier: number, cls: number): boolean {
    const f = this.filter;
    if (!f) return true;
    if (f.carrier !== null && carrier !== f.carrier) return false;
    if (f.passengerOnly && cls !== 0) return false;
    if (!f.includeT4 && tier === 4) return false;
    if (f.country !== null && this.geo) {
      const ca = this.geo.airportCountry[this.geo.a[route]!];
      const cb = this.geo.airportCountry[this.geo.b[route]!];
      if (ca !== f.country && cb !== f.country) return false;
    }
    return true;
  }

  /**
   * Matches every flight against a disruption while aggregating. The endpoint proxy needs days
   * with track ends (attachEndpoints); without them the reference proxy is used and reported.
   */
  setDisruption(d: Disruption, proxy: 'endpoint' | 'reference'): void {
    this.disruption = d;
    this.proxy = proxy;
    this.stats = {
      proxy, affected: 0, byBasis: [0, 0], dep: 0, arr: 0, route: 0, undetermined: 0,
      affectedReference: 0, affectedEndpoint: proxy === 'endpoint' ? 0 : null, series: this.binFlights.map(() => 0), daysWithoutEndpoints: [],
    };
  }

  disruptionStats(): DisruptionStats | null {
    return this.stats;
  }

  /** Adds the part of a decoded day inside the window. */
  addDay(ev: DayEvents): void {
    const from = lowerBound(ev.timeMs, this.window.startMs);
    const to = lowerBound(ev.timeMs, this.window.endMs);
    const geo = this.geo;
    const airport = this.filter?.airport ?? null;
    if (this.stats && this.proxy === 'endpoint' && !ev.endMs && from < to) {
      this.stats.daysWithoutEndpoints.push(ev.day);
      this.stats.affectedEndpoint = null;
    }
    for (let i = from; i < to; i++) {
      const basis = ev.basis[i]!;
      if (basis === 0) this.trackStart++;
      else this.fallback++;
      if (this.basis === 'start' && basis !== 0) continue;
      const route = ev.route[i]!;
      const dir = ev.direction[i]!;
      const carrier = ev.carrier[i]!;
      const tier = ev.tier[i]!;
      const cls = ev.aircraftClass[i]!;
      const k = this.key(route, dir, carrier, tier, cls);
      this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
      this.flights++;
      if (this.disruption && geo) {
        const st = this.stats!;
        const times = { refMs: ev.timeMs[i]!, basis, endMs: ev.endMs ? ev.endMs[i]! : NaN };
        const ra = geo.a[route]!;
        const rb = geo.b[route]!;
        const ref = matchFlight(this.disruption, route, dir, ra, rb, times, 'reference');
        const end = ev.endMs ? matchFlight(this.disruption, route, dir, ra, rb, times, 'endpoint') : null;
        if (affected(ref)) st.affectedReference++;
        if (end !== null && affected(end) && st.affectedEndpoint !== null) st.affectedEndpoint++;
        const flags = this.proxy === 'endpoint' && end !== null ? end : ref;
        if (affected(flags)) {
          this.affectedCounts.set(k, (this.affectedCounts.get(k) ?? 0) + 1);
          st.affected++;
          st.byBasis[basis === 0 ? 0 : 1]++;
          if (flags & MATCH.DEP) st.dep++;
          if (flags & MATCH.ARR) st.arr++;
          if (flags & MATCH.ROUTE) st.route++;
          st.series[Math.floor((ev.timeMs[i]! - this.window.startMs) / this.binMs)]!++;
        } else if (flags & MATCH.UNDETERMINED) st.undetermined++;
      }
      if (this.passesSeries(route, carrier, tier, cls)) {
        const bin = Math.floor((ev.timeMs[i]! - this.window.startMs) / this.binMs);
        this.binFlights[bin]!++;
        this.binRoutes[bin]!.add(route);
        if (this.binPartners && geo) {
          const a = geo.a[route]!;
          const b = geo.b[route]!;
          if (a === airport) this.binPartners[bin]!.add(b);
          else if (b === airport) this.binPartners[bin]!.add(a);
        }
      }
    }
  }

  rows(): AggregateRows {
    return this.rowsOf(this.counts);
  }

  /** The flights selected by the disruption, in the same row layout (empty without one). */
  affectedRows(): AggregateRows {
    return this.rowsOf(this.affectedCounts);
  }

  private rowsOf(counts: Map<number, number>): AggregateRows {
    const keys = [...counts.keys()].sort((x, y) => x - y);
    const n = keys.length;
    const r: AggregateRows = {
      size: n,
      route: new Int32Array(n),
      dir: new Uint8Array(n),
      carrier: new Int32Array(n),
      tier: new Uint8Array(n),
      cls: new Uint8Array(n),
      count: new Int32Array(n),
    };
    keys.forEach((k, i) => {
      r.count[i] = counts.get(k)!;
      r.cls[i] = k % N_CLASS;
      let rest = Math.floor(k / N_CLASS);
      r.tier[i] = (rest % N_TIER) + 1;
      rest = Math.floor(rest / N_TIER);
      r.carrier[i] = rest % this.carriers;
      rest = Math.floor(rest / this.carriers);
      r.dir[i] = rest % 2;
      r.route[i] = Math.floor(rest / 2);
    });
    return r;
  }

  series(): WindowSeries {
    return {
      startMs: this.window.startMs,
      binMs: this.binMs,
      flights: [...this.binFlights],
      routes: this.binRoutes.map((s) => s.size),
      partners: this.binPartners ? this.binPartners.map((s) => s.size) : null,
    };
  }
}

/**
 * Explore month records [route, dir, airline, passenger, cargo, unknown, basis] from an aggregate
 * (basis 1 = T4, 0 = T1-T3), so the map, panels and comparisons work unchanged on any window.
 */
export function toMonthData(rows: AggregateRows, carriers: readonly string[], label: string, days: number): MonthData {
  const acc = new Map<number, [number, number, number, number, number, number]>();
  for (let i = 0; i < rows.size; i++) {
    const basis = rows.tier[i] === 4 ? 1 : 0;
    const key = ((rows.route[i]! * 2 + rows.dir[i]!) * carriers.length + rows.carrier[i]!) * 2 + basis;
    let a = acc.get(key);
    if (!a) {
      a = [rows.route[i]!, rows.dir[i]!, rows.carrier[i]!, 0, 0, 0];
      acc.set(key, a);
    }
    a[3 + rows.cls[i]!]! += rows.count[i]!;
  }
  const records: MonthRecordTuple[] = [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([key, [rid, dir, ci, p, c, u]]) => [rid, dir as 0 | 1, carriers[ci]!, p, c, u, (key % 2) as 0 | 1]);
  return { month: label, observedDays: days, daysInMonth: days, records };
}

/** Research Mode input from an aggregate: one row per route x direction x airline x tier x class. */
export function toResearchMonth(rows: AggregateRows, carriers: readonly string[], label: string, days: number): ResearchMonth {
  const n = rows.size;
  const m: ResearchMonth = {
    month: label,
    observedDays: days,
    daysInMonth: days,
    size: n,
    route: rows.route.slice(),
    dir: rows.dir.slice(),
    carrier: rows.carrier.slice(),
    carriers: [...carriers],
    tier: rows.tier.slice(),
    passenger: new Float64Array(n),
    cargo: new Float64Array(n),
    unknown: new Float64Array(n),
    inconsistencies: 0,
  };
  for (let i = 0; i < n; i++) {
    const target = rows.cls[i] === 0 ? m.passenger : rows.cls[i] === 1 ? m.cargo : m.unknown;
    target[i] = rows.count[i]!;
  }
  return m;
}

/** rows minus affected rows (same keys; rows with nothing left are dropped). Inputs are not changed. */
export function subtractRows(all: AggregateRows, minus: AggregateRows): AggregateRows {
  const sub = new Map<string, number>();
  for (let i = 0; i < minus.size; i++) {
    sub.set(`${minus.route[i]},${minus.dir[i]},${minus.carrier[i]},${minus.tier[i]},${minus.cls[i]}`, minus.count[i]!);
  }
  const keep: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < all.size; i++) {
    const c = all.count[i]! - (sub.get(`${all.route[i]},${all.dir[i]},${all.carrier[i]},${all.tier[i]},${all.cls[i]}`) ?? 0);
    if (c < 0) throw new Error('affected flights exceed observed flights');
    if (c > 0) {
      keep.push(i);
      counts.push(c);
    }
  }
  const pick = <T extends Int32Array | Uint8Array>(a: T): T => {
    const out = new (a.constructor as new (n: number) => T)(keep.length);
    keep.forEach((src, k) => {
      out[k] = a[src]!;
    });
    return out;
  };
  return { size: keep.length, route: pick(all.route), dir: pick(all.dir), carrier: pick(all.carrier), tier: pick(all.tier), cls: pick(all.cls), count: Int32Array.from(counts) };
}
