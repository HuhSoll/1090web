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

  /** Adds the part of a decoded day inside the window. */
  addDay(ev: DayEvents): void {
    const from = lowerBound(ev.timeMs, this.window.startMs);
    const to = lowerBound(ev.timeMs, this.window.endMs);
    const geo = this.geo;
    const airport = this.filter?.airport ?? null;
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
    const keys = [...this.counts.keys()].sort((x, y) => x - y);
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
      r.count[i] = this.counts.get(k)!;
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
