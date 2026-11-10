import type { MonthData, StaticNetwork } from '../data/model/network';
import { computeNetworkView, type NetworkFilters, type NetworkView } from './networkView';

/**
 * Month-to-month comparison.
 *
 * Months have different numbers of observed days (data gaps, 28 vs 31 days), so every
 * comparison uses flights per observed day, never raw monthly totals.
 */

export const ChangeKind = {
  Hidden: 0,
  Stable: 1,
  Up: 2,
  Down: 3,
  New: 4,
  Gone: 5,
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

/** A route counts as up/down only if both the relative and the absolute change are meaningful. */
export const CHANGE_RATIO = 0.15;
/** Minimum absolute change, in flights per observed day (= about 4 flights a month). */
export const CHANGE_MIN_PER_DAY = 4 / 30;

export interface RouteChange {
  routeId: number;
  /** flights per observed day */
  base: number;
  target: number;
}

export interface Comparison {
  base: NetworkView;
  target: NetworkView;
  baseDays: number;
  targetDays: number;
  /** per route: ChangeKind */
  kind: Uint8Array;
  /** per route: max(base, target) monthly-equivalent flights, used for line weight */
  weight: Float32Array;
  maxWeight: number;
  /** per airport: per-day movements */
  airportBase: Float32Array;
  airportTarget: Float32Array;
  counts: Record<'stable' | 'up' | 'down' | 'new' | 'gone', number>;
  perDay: { base: number; target: number };
  topGainers: RouteChange[];
  topLosers: RouteChange[];
}

/**
 * Routes below CHANGE_MIN_PER_DAY in both months are left out: one-off flights (diversions,
 * positioning, misread tracks) would otherwise dominate the new/gone counts.
 */
export function classifyChange(base: number, target: number): ChangeKind {
  if (Math.max(base, target) < CHANGE_MIN_PER_DAY) return ChangeKind.Hidden;
  if (base <= 0) return ChangeKind.New;
  if (target <= 0) return ChangeKind.Gone;
  const delta = target - base;
  if (Math.abs(delta) < CHANGE_MIN_PER_DAY || Math.abs(delta) / base < CHANGE_RATIO) return ChangeKind.Stable;
  return delta > 0 ? ChangeKind.Up : ChangeKind.Down;
}

export function computeComparison(
  network: StaticNetwork,
  baseMonth: MonthData,
  targetMonth: MonthData,
  filters: NetworkFilters,
  topN = 8,
): Comparison {
  // The threshold applies to either month, so a route that fell below it is still shown as "gone".
  const unthresholded = { ...filters, minFlights: 0 };
  const base = computeNetworkView(network, baseMonth, unthresholded);
  const target = computeNetworkView(network, targetMonth, unthresholded);
  const baseDays = Math.max(1, baseMonth.observedDays);
  const targetDays = Math.max(1, targetMonth.observedDays);

  const n = network.routes.length;
  const kind = new Uint8Array(n);
  const weight = new Float32Array(n);
  const airportBase = new Float32Array(network.airports.length);
  const airportTarget = new Float32Array(network.airports.length);
  const counts = { stable: 0, up: 0, down: 0, new: 0, gone: 0 };
  const changes: RouteChange[] = [];
  let maxWeight = 0;
  let perDayBase = 0;
  let perDayTarget = 0;

  for (let i = 0; i < n; i++) {
    const bm = base.routeFlights[i]!;
    const tm = target.routeFlights[i]!;
    if (Math.max(bm, tm) < Math.max(filters.minFlights, 1e-9)) continue;
    const b = bm / baseDays;
    const t = tm / targetDays;
    const k = classifyChange(b, t);
    if (k === ChangeKind.Hidden) continue;
    kind[i] = k;
    // Weight in "flights per 30 days" so line brightness is comparable across months.
    const w = Math.max(b, t) * 30;
    weight[i] = w;
    if (w > maxWeight) maxWeight = w;
    perDayBase += b;
    perDayTarget += t;
    const r = network.routes[i]!;
    airportBase[r.a]! += b;
    airportBase[r.b]! += b;
    airportTarget[r.a]! += t;
    airportTarget[r.b]! += t;
    if (k === ChangeKind.Stable) counts.stable++;
    else if (k === ChangeKind.Up) counts.up++;
    else if (k === ChangeKind.Down) counts.down++;
    else if (k === ChangeKind.New) counts.new++;
    else counts.gone++;
    changes.push({ routeId: i, base: b, target: t });
  }

  const byDelta = (x: RouteChange, y: RouteChange) => y.target - y.base - (x.target - x.base);
  const sorted = changes.sort(byDelta);
  return {
    base,
    target,
    baseDays,
    targetDays,
    kind,
    weight,
    maxWeight,
    airportBase,
    airportTarget,
    counts,
    perDay: { base: perDayBase, target: perDayTarget },
    topGainers: sorted.slice(0, topN).filter((c) => c.target > c.base),
    topLosers: sorted
      .slice(-topN)
      .reverse()
      .filter((c) => c.target < c.base),
  };
}

/** Relative change as a fraction (0.12 = +12%); null when the base is zero. */
export function relativeChange(base: number, target: number): number | null {
  return base > 0 ? (target - base) / base : null;
}

/**
 * Routes that should stand out in compare mode: the busiest new and no-longer-seen routes
 * (by the larger month's flights), excluding hidden categories.
 */
export function standoutChanges(c: Comparison, hidden: readonly number[], limit = 120): { routeId: number; kind: ChangeKind }[] {
  const out: { routeId: number; kind: ChangeKind; w: number }[] = [];
  c.kind.forEach((k, routeId) => {
    if ((k === ChangeKind.New || k === ChangeKind.Gone) && !hidden.includes(k)) out.push({ routeId, kind: k as ChangeKind, w: c.weight[routeId]! });
  });
  return out
    .sort((a, b) => b.w - a.w)
    .slice(0, limit)
    .map(({ routeId, kind }) => ({ routeId, kind }));
}

/**
 * The comparison as a NetworkView, so the map and panels can reuse the normal code paths:
 * route and airport values are the larger of the two months, as flights per 30 days.
 * Routes in hidden categories (compare legend) are left out.
 */
export function comparisonAsView(c: Comparison, hidden: readonly number[] = []): NetworkView {
  const routeFlights = hidden.length === 0 ? c.weight : c.weight.map((w, i) => (hidden.includes(c.kind[i]!) ? 0 : w));
  const airportFlights = new Float32Array(c.airportBase.length);
  let maxAirportFlights = 0;
  let visibleAirportCount = 0;
  for (let i = 0; i < airportFlights.length; i++) {
    const v = Math.max(c.airportBase[i]!, c.airportTarget[i]!) * 30;
    airportFlights[i] = v;
    if (v > 0) visibleAirportCount++;
    if (v > maxAirportFlights) maxAirportFlights = v;
  }
  let visibleRouteCount = 0;
  for (const w of routeFlights) if (w > 0) visibleRouteCount++;
  return {
    month: `${c.base.month}..${c.target.month}`,
    routeFlights,
    airportFlights,
    visibleRouteCount,
    visibleAirportCount,
    totalFlights: c.perDay.target * 30,
    callsignFlights: 0,
    maxRouteFlights: c.maxWeight,
    maxRouteFlightsUnthresholded: c.maxWeight,
    maxAirportFlights,
    carrierFlights: c.target.carrierFlights,
  };
}
