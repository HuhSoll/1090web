import type { MonthData, StaticNetwork } from '../data/model/network';
import { ChangeKind, type Comparison, type RouteChange } from './comparison';
import { computeNetworkView, type NetworkFilters } from './networkView';

/**
 * Baseline vs simulated network on the map (Phase 9C). Same period, so no per-day scaling and no
 * thresholds: every baseline route is classified exactly.
 *   Gone   - no flights left (connection lost)
 *   Down   - fewer flights (temporal model: part of the period affected)
 *   Stable - unchanged (drawn faint, so the affected routes stand out)
 * Uses the Comparison shape, so the renderer's compare colours are reused.
 */
export function computeSimulationOverlay(network: StaticNetwork, before: MonthData, after: MonthData, filters: NetworkFilters): Comparison {
  const f = { ...filters, minFlights: 0 };
  const base = computeNetworkView(network, before, f);
  const target = computeNetworkView(network, after, f);
  const n = network.routes.length;
  const kind = new Uint8Array(n);
  const weight = new Float32Array(n);
  const airportBase = new Float32Array(network.airports.length);
  const airportTarget = new Float32Array(network.airports.length);
  const counts = { stable: 0, up: 0, down: 0, new: 0, gone: 0 };
  const changes: RouteChange[] = [];
  let maxWeight = 0;
  let sumB = 0;
  let sumT = 0;
  for (let i = 0; i < n; i++) {
    const b = base.routeFlights[i]!;
    const t = target.routeFlights[i]!;
    if (b <= 0 || b < filters.minFlights) continue;
    const k = t <= 0 ? ChangeKind.Gone : t < b ? ChangeKind.Down : ChangeKind.Stable;
    kind[i] = k;
    weight[i] = b;
    if (b > maxWeight) maxWeight = b;
    sumB += b;
    sumT += t;
    const r = network.routes[i]!;
    airportBase[r.a]! += b;
    airportBase[r.b]! += b;
    airportTarget[r.a]! += t;
    airportTarget[r.b]! += t;
    if (k === ChangeKind.Gone) counts.gone++;
    else if (k === ChangeKind.Down) counts.down++;
    else counts.stable++;
    if (k !== ChangeKind.Stable) changes.push({ routeId: i, base: b, target: t });
  }
  const days = Math.max(1e-9, before.observedDays);
  // comparisonAsView multiplies by 30 (per-day units); keep the same convention
  const perDay = (x: number) => x / 30;
  for (let i = 0; i < n; i++) weight[i] = perDay(weight[i]!) * 30;
  for (let i = 0; i < airportBase.length; i++) {
    airportBase[i] = perDay(airportBase[i]!);
    airportTarget[i] = perDay(airportTarget[i]!);
  }
  changes.sort((x, y) => y.base - y.target - (x.base - x.target));
  return {
    base, target, baseDays: days, targetDays: days, kind, weight, maxWeight, airportBase, airportTarget, counts,
    perDay: { base: perDay(sumB), target: perDay(sumT) },
    topGainers: [],
    topLosers: changes.slice(0, 8),
  };
}
