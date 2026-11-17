/**
 * Observed changes between a before and an after window (Phase 9G): routes, airports, airlines,
 * split by their relation to the advisory's area. Input: the aggregates of the two windows from
 * the temporal worker (the same rows Explore and Research use).
 *
 * Vocabulary: a route "observed only after" is not a new service and a route "no longer observed"
 * is not a discontinued one: the data are ADS-B observations, not schedules.
 *
 * Area classes of a route (airport countries; an advisory area given as FIRs or flight levels is
 * NOT the same as the countries, see docs/historical-events-methodology.md):
 *   A  both ends in the area countries
 *   B  one end in the area, the other outside
 *   C  touches a neighbour country, not the area
 *   other
 */
import type { StaticNetwork } from '../data/model/network';
import type { AggregateRows } from '../temporal/aggregate';

export type AreaClass = 'A' | 'B' | 'C' | 'other';
export type RouteChange = 'onlyAfter' | 'notAfter' | 'up' | 'down' | 'stable';

export interface ChangeOptions {
  includeT4: boolean;
  passengerOnly: boolean;
  /** flights in a window for a route to count as observed in it */
  minFlights: number;
  /** relative change of flights per day to count as up / down */
  ratio: number;
  /** absolute change of flights per day to count as up / down */
  minDelta: number;
}

export const DEFAULT_CHANGE_OPTIONS: ChangeOptions = { includeT4: true, passengerOnly: false, minFlights: 1, ratio: 1.5, minDelta: 0.5 };

export interface RouteRowChange {
  route: number;
  a: number;
  b: number;
  cls: AreaClass;
  before: number;
  after: number;
  /** flights per day */
  beforeDaily: number;
  afterDaily: number;
  change: RouteChange;
}

export interface ClassTotals {
  cls: AreaClass;
  beforeDaily: number;
  afterDaily: number;
  routesBefore: number;
  routesAfter: number;
  onlyAfter: number;
  notAfter: number;
  up: number;
  down: number;
}

export interface AirportChange {
  airport: number;
  inArea: boolean;
  neighbour: boolean;
  beforeDaily: number;
  afterDaily: number;
  partnersBefore: number;
  partnersAfter: number;
}

export interface CarrierChange {
  carrier: number;
  beforeDaily: number;
  afterDaily: number;
}

export interface Changes {
  routes: RouteRowChange[];
  classes: ClassTotals[];
  airports: AirportChange[];
  /** flights touching the area, by airline code */
  carriers: CarrierChange[];
  airportsObserved: { before: number; after: number };
}

function perRoute(rows: AggregateRows, o: ChangeOptions): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < rows.size; i++) {
    if (!o.includeT4 && rows.tier[i] === 4) continue;
    if (o.passengerOnly && rows.cls[i] !== 0) continue;
    m.set(rows.route[i]!, (m.get(rows.route[i]!) ?? 0) + rows.count[i]!);
  }
  return m;
}

function perCarrier(rows: AggregateRows, o: ChangeOptions, touches: (route: number) => boolean): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < rows.size; i++) {
    if (!o.includeT4 && rows.tier[i] === 4) continue;
    if (o.passengerOnly && rows.cls[i] !== 0) continue;
    if (!touches(rows.route[i]!)) continue;
    m.set(rows.carrier[i]!, (m.get(rows.carrier[i]!) ?? 0) + rows.count[i]!);
  }
  return m;
}

export function areaSets(network: StaticNetwork, area: readonly string[], neighbours: readonly string[]) {
  const a = new Set(area);
  const n = new Set(neighbours.filter((c) => !a.has(c)));
  const inArea = network.airports.map((x) => a.has(x.country));
  const nb = network.airports.map((x) => n.has(x.country));
  const cls = (route: number): AreaClass => {
    const r = network.routes[route]!;
    const ia = inArea[r.a]!;
    const ib = inArea[r.b]!;
    if (ia && ib) return 'A';
    if (ia || ib) return 'B';
    if (nb[r.a] || nb[r.b]) return 'C';
    return 'other';
  };
  return { inArea, neighbour: nb, cls };
}

export function observedChanges(
  network: StaticNetwork, before: AggregateRows, after: AggregateRows, beforeDays: number, afterDays: number,
  area: readonly string[], neighbours: readonly string[], o: ChangeOptions = DEFAULT_CHANGE_OPTIONS,
): Changes {
  const sets = areaSets(network, area, neighbours);
  const pb = perRoute(before, o);
  const pa = perRoute(after, o);
  const ids = new Set([...pb.keys(), ...pa.keys()]);
  const routes: RouteRowChange[] = [];
  const classes = new Map<AreaClass, ClassTotals>((['A', 'B', 'C', 'other'] as const).map((c) => [c, { cls: c, beforeDaily: 0, afterDaily: 0, routesBefore: 0, routesAfter: 0, onlyAfter: 0, notAfter: 0, up: 0, down: 0 }]));
  const ap = new Map<number, { b: number; a: number; pb: Set<number>; pa: Set<number> }>();
  const touchAp = (i: number) => {
    let x = ap.get(i);
    if (!x) ap.set(i, (x = { b: 0, a: 0, pb: new Set(), pa: new Set() }));
    return x;
  };
  const obsB = new Set<number>();
  const obsA = new Set<number>();
  for (const id of ids) {
    const r = network.routes[id]!;
    const b = pb.get(id) ?? 0;
    const a = pa.get(id) ?? 0;
    const seenB = b >= o.minFlights;
    const seenA = a >= o.minFlights;
    if (seenB) { obsB.add(r.a); obsB.add(r.b); }
    if (seenA) { obsA.add(r.a); obsA.add(r.b); }
    const bd = beforeDays ? b / beforeDays : 0;
    const ad = afterDays ? a / afterDays : 0;
    let change: RouteChange;
    if (!seenB && seenA) change = 'onlyAfter';
    else if (seenB && !seenA) change = 'notAfter';
    else if (ad - bd >= o.minDelta && ad >= bd * o.ratio) change = 'up';
    else if (bd - ad >= o.minDelta && bd >= ad * o.ratio) change = 'down';
    else change = 'stable';
    const cls = sets.cls(id);
    const t = classes.get(cls)!;
    t.beforeDaily += bd;
    t.afterDaily += ad;
    if (seenB) t.routesBefore++;
    if (seenA) t.routesAfter++;
    if (change === 'onlyAfter') t.onlyAfter++;
    else if (change === 'notAfter') t.notAfter++;
    else if (change === 'up') t.up++;
    else if (change === 'down') t.down++;
    if (cls !== 'other' && (seenA || seenB)) routes.push({ route: id, a: r.a, b: r.b, cls, before: b, after: a, beforeDaily: bd, afterDaily: ad, change });
    for (const [x, y] of [[r.a, r.b], [r.b, r.a]] as const) {
      if (!sets.inArea[x] && !sets.neighbour[x]) continue;
      const s = touchAp(x);
      s.b += bd;
      s.a += ad;
      if (seenB) s.pb.add(y);
      if (seenA) s.pa.add(y);
    }
  }
  const touches = (route: number) => sets.cls(route) === 'A' || sets.cls(route) === 'B';
  const cb = perCarrier(before, o, touches);
  const ca = perCarrier(after, o, touches);
  const carriers = [...new Set([...cb.keys(), ...ca.keys()])].map((c) => ({
    carrier: c, beforeDaily: beforeDays ? (cb.get(c) ?? 0) / beforeDays : 0, afterDaily: afterDays ? (ca.get(c) ?? 0) / afterDays : 0,
  })).sort((x, y) => (y.beforeDaily + y.afterDaily) - (x.beforeDaily + x.afterDaily));
  routes.sort((x, y) => Math.abs(y.afterDaily - y.beforeDaily) - Math.abs(x.afterDaily - x.beforeDaily));
  const airports = [...ap.entries()].map(([i, s]) => ({
    airport: i, inArea: sets.inArea[i]!, neighbour: sets.neighbour[i]!, beforeDaily: s.b, afterDaily: s.a, partnersBefore: s.pb.size, partnersAfter: s.pa.size,
  })).sort((x, y) => Math.abs(y.afterDaily - y.beforeDaily) - Math.abs(x.afterDaily - x.beforeDaily));
  return { routes, classes: [...classes.values()], airports, carriers, airportsObserved: { before: obsB.size, after: obsA.size } };
}
