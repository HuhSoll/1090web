import type { MonthData, StaticNetwork } from '../data/model/network';

export type TrafficMode = 'all' | 'passenger';

export interface NetworkFilters {
  /** ISO alpha-2. A route matches when either endpoint is in the country. */
  country: string | null;
  carrierId: string | null;
  /**
   * 'all'       = passenger + cargo + unknown
   * 'passenger' = flights classified as passenger only (unknown is excluded, never guessed)
   */
  mode: TrafficMode;
  /** Routes with fewer monthly flights (after the filters above) are hidden. */
  minFlights: number;
}

export const DEFAULT_FILTERS: NetworkFilters = {
  country: null,
  carrierId: null,
  mode: 'all',
  minFlights: 0,
};

/**
 * Result of applying filters to one month. Arrays are indexed by route id / airport index so
 * that the renderer can upload them directly to the GPU without per-route objects.
 */
export interface NetworkView {
  month: string;
  /** Monthly flights per route (both directions) after filters; 0 = hidden. */
  routeFlights: Float32Array;
  /** Monthly movements (departures + arrivals) per airport over visible routes. */
  airportFlights: Float32Array;
  visibleRouteCount: number;
  visibleAirportCount: number;
  totalFlights: number;
  maxRouteFlights: number;
  /** Max route flights ignoring the threshold (keeps the threshold slider range stable). */
  maxRouteFlightsUnthresholded: number;
  maxAirportFlights: number;
}

export function countryMatches(network: StaticNetwork, routeId: number, country: string | null): boolean {
  if (!country) return true;
  const route = network.routes[routeId];
  if (!route) return false;
  return network.airports[route.a]?.country === country || network.airports[route.b]?.country === country;
}

export function flightsForMode(mode: TrafficMode, passenger: number, cargo: number, unknown: number): number {
  return mode === 'passenger' ? passenger : passenger + cargo + unknown;
}

export function computeNetworkView(
  network: StaticNetwork,
  month: MonthData,
  filters: NetworkFilters,
): NetworkView {
  const routeCount = network.routes.length;
  const routeFlights = new Float32Array(routeCount);

  // Country match is per route, not per record: precompute once.
  let countryMask: Uint8Array | null = null;
  if (filters.country) {
    countryMask = new Uint8Array(routeCount);
    for (let i = 0; i < routeCount; i++) countryMask[i] = countryMatches(network, i, filters.country) ? 1 : 0;
  }

  for (const [routeId, , carrierId, passenger, cargo, unknown] of month.records) {
    if (filters.carrierId && carrierId !== filters.carrierId) continue;
    if (countryMask && countryMask[routeId] === 0) continue;
    routeFlights[routeId]! += flightsForMode(filters.mode, passenger, cargo, unknown);
  }

  const airportFlights = new Float32Array(network.airports.length);
  let visibleRouteCount = 0;
  let totalFlights = 0;
  let maxRouteFlights = 0;
  let maxRouteFlightsUnthresholded = 0;
  for (let i = 0; i < routeCount; i++) {
    const f = routeFlights[i]!;
    if (f > maxRouteFlightsUnthresholded) maxRouteFlightsUnthresholded = f;
    if (f <= 0 || f < filters.minFlights) {
      routeFlights[i] = 0;
      continue;
    }
    const route = network.routes[i]!;
    visibleRouteCount++;
    totalFlights += f;
    if (f > maxRouteFlights) maxRouteFlights = f;
    airportFlights[route.a]! += f;
    airportFlights[route.b]! += f;
  }

  let visibleAirportCount = 0;
  let maxAirportFlights = 0;
  for (const f of airportFlights) {
    if (f > 0) visibleAirportCount++;
    if (f > maxAirportFlights) maxAirportFlights = f;
  }

  return {
    month: month.month,
    routeFlights,
    airportFlights,
    visibleRouteCount,
    visibleAirportCount,
    totalFlights,
    maxRouteFlights,
    maxRouteFlightsUnthresholded,
    maxAirportFlights,
  };
}

export interface CarrierShare {
  carrierId: string;
  flights: number;
}

export interface RouteDetail {
  routeId: number;
  /** flights from route.a to route.b */
  forward: number;
  /** flights from route.b to route.a */
  backward: number;
  passenger: number;
  cargo: number;
  unknown: number;
  carriers: CarrierShare[];
}

/**
 * Detailed breakdown for a single route under the current filters (except the threshold,
 * which only controls visibility). Linear in the month's record count; called on demand.
 */
export function computeRouteDetail(
  network: StaticNetwork,
  month: MonthData,
  filters: NetworkFilters,
  routeId: number,
): RouteDetail {
  const detail: RouteDetail = { routeId, forward: 0, backward: 0, passenger: 0, cargo: 0, unknown: 0, carriers: [] };
  if (!countryMatches(network, routeId, filters.country)) return detail;
  const byCarrier = new Map<string, number>();
  for (const [rid, dir, carrierId, passenger, cargo, unknown] of month.records) {
    if (rid !== routeId) continue;
    if (filters.carrierId && carrierId !== filters.carrierId) continue;
    const f = flightsForMode(filters.mode, passenger, cargo, unknown);
    if (f <= 0) continue;
    if (dir === 0) detail.forward += f;
    else detail.backward += f;
    detail.passenger += passenger;
    if (filters.mode === 'all') {
      detail.cargo += cargo;
      detail.unknown += unknown;
    }
    byCarrier.set(carrierId, (byCarrier.get(carrierId) ?? 0) + f);
  }
  detail.carriers = [...byCarrier.entries()]
    .map(([carrierId, flights]) => ({ carrierId, flights }))
    .sort((x, y) => y.flights - x.flights);
  return detail;
}

export interface ConnectedRoute {
  routeId: number;
  /** airport index of the other end */
  other: number;
  flights: number;
}

/** Visible routes touching an airport, sorted by flights (descending). */
export function connectedRoutes(network: StaticNetwork, view: NetworkView, airportIndex: number): ConnectedRoute[] {
  const out: ConnectedRoute[] = [];
  for (const routeId of network.routesByAirport[airportIndex] ?? []) {
    const flights = view.routeFlights[routeId] ?? 0;
    if (flights <= 0) continue;
    const r = network.routes[routeId]!;
    out.push({ routeId, other: r.a === airportIndex ? r.b : r.a, flights });
  }
  return out.sort((x, y) => y.flights - x.flights);
}

/** Threshold steps for the "minimum monthly flights" slider (log-like spacing). */
export const THRESHOLD_STEPS = [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000] as const;

export function thresholdStepsFor(maxRouteFlights: number): number[] {
  const steps = THRESHOLD_STEPS.filter((s) => s <= Math.max(maxRouteFlights, 1));
  return steps.length > 0 ? [...steps] : [0];
}

export const MAX_NOTABLE_ROUTES = 150;

/**
 * The few routes worth singling out: the highest-volume visible routes. The count grows with
 * the square root of the visible network (about 20 of 400 routes, capped at 150), so the
 * emphasis stays selective at any scale. Ties are broken by route id for stable output.
 */
export function notableRoutes(view: NetworkView): { routeId: number; flights: number }[] {
  if (view.visibleRouteCount === 0) return [];
  const count = Math.min(MAX_NOTABLE_ROUTES, Math.max(3, Math.ceil(Math.sqrt(view.visibleRouteCount))));
  const ids: number[] = [];
  view.routeFlights.forEach((f, i) => {
    if (f > 0) ids.push(i);
  });
  ids.sort((a, b) => view.routeFlights[b]! - view.routeFlights[a]! || a - b);
  return ids.slice(0, count).map((routeId) => ({ routeId, flights: view.routeFlights[routeId]! }));
}
