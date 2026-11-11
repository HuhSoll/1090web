/**
 * From a ResearchMonth and a ResearchConfig to the analysed network, route table and country /
 * region networks. Pure functions; the heavy graph metrics run in the worker (analysis.ts).
 */
import type { StaticNetwork } from '../data/model/network';
import type { PersistenceFile, ResearchMonth } from './data';
import { TIER_SETS, type ResearchConfig } from './model';

export interface RouteAgg {
  routeId: number;
  /** airport indices, as in routes.json (a < b by id) */
  a: number;
  b: number;
  /** flights a -> b and b -> a */
  ab: number;
  ba: number;
  /** per direction, flights by tier T1..T4 */
  tiersAB: [number, number, number, number];
  tiersBA: [number, number, number, number];
  /** months of the data with >= 1 flight under the same tier set; null when unknown */
  monthsPresent: number | null;
}

export interface ResearchNetwork {
  month: string;
  daysInMonth: number;
  routes: RouteAgg[];
  /** airport indices with at least one route, ascending */
  airports: number[];
  flights: number;
  directedRoutes: number;
  tierFlights: [number, number, number, number];
  /** before the thresholds (after the other filters) */
  candidateRoutes: number;
  candidateFlights: number;
  droppedByMinFlights: { routes: number; flights: number };
  droppedByMinMonths: { routes: number; flights: number };
}

export interface ScopeContext {
  network: StaticNetwork;
  continentOf: readonly string[];
  persistence: PersistenceFile | null;
}

/** Does an airport pair pass the geographic scope (country / region / relation / airport)? */
export function inScope(ctx: ScopeContext, config: ResearchConfig, a: number, b: number): boolean {
  const A = ctx.network.airports[a]!;
  const B = ctx.network.airports[b]!;
  if (config.airport && A.id !== config.airport && B.id !== config.airport) return false;
  let inA: boolean;
  let inB: boolean;
  if (config.country) {
    inA = A.country === config.country;
    inB = B.country === config.country;
  } else if (config.region) {
    inA = ctx.continentOf[a] === config.region;
    inB = ctx.continentOf[b] === config.region;
  } else {
    // no area: domestic = both ends in the same country
    const same = A.country === B.country;
    if (config.relation === 'domestic') return same;
    if (config.relation === 'international') return !same;
    return true;
  }
  if (config.relation === 'domestic') return inA && inB;
  if (config.relation === 'international') return inA !== inB;
  return inA || inB;
}

export function buildResearchNetwork(ctx: ScopeContext, month: ResearchMonth, config: ResearchConfig): ResearchNetwork {
  const tiers = new Set(TIER_SETS[config.tiers]);
  const useP = config.classes.includes('passenger');
  const useC = config.classes.includes('cargo');
  const useU = config.classes.includes('unknown');
  const carrierIdx = config.carrier ? month.carriers.indexOf(config.carrier) : -1;
  const routes = ctx.network.routes;
  const byRoute = new Map<number, RouteAgg>();
  const scopeCache = new Map<number, boolean>();
  for (let i = 0; i < month.size; i++) {
    if (!tiers.has(month.tier[i]!)) continue;
    if (config.carrier && month.carrier[i] !== carrierIdx) continue;
    const f = (useP ? month.passenger[i]! : 0) + (useC ? month.cargo[i]! : 0) + (useU ? month.unknown[i]! : 0);
    if (f <= 0) continue;
    const rid = month.route[i]!;
    const r = routes[rid]!;
    let ok = scopeCache.get(rid);
    if (ok === undefined) {
      ok = inScope(ctx, config, r.a, r.b);
      scopeCache.set(rid, ok);
    }
    if (!ok) continue;
    let agg = byRoute.get(rid);
    if (!agg) {
      agg = { routeId: rid, a: r.a, b: r.b, ab: 0, ba: 0, tiersAB: [0, 0, 0, 0], tiersBA: [0, 0, 0, 0], monthsPresent: null };
      byRoute.set(rid, agg);
    }
    const t = month.tier[i]! - 1;
    if (month.dir[i] === 0) {
      agg.ab += f;
      agg.tiersAB[t]! += f;
    } else {
      agg.ba += f;
      agg.tiersBA[t]! += f;
    }
  }
  const digits = ctx.persistence?.tierSets[config.tiers] ?? null;
  let candidateFlights = 0;
  const dropF = { routes: 0, flights: 0 };
  const dropM = { routes: 0, flights: 0 };
  const kept: RouteAgg[] = [];
  for (const agg of [...byRoute.values()].sort((x, y) => x.routeId - y.routeId)) {
    const total = agg.ab + agg.ba;
    candidateFlights += total;
    agg.monthsPresent = digits ? Number(digits[agg.routeId] ?? 0) : null;
    if (total < config.minFlights) {
      dropF.routes++;
      dropF.flights += total;
      continue;
    }
    if (config.minMonths > 0 && (agg.monthsPresent ?? 0) < config.minMonths) {
      dropM.routes++;
      dropM.flights += total;
      continue;
    }
    kept.push(agg);
  }
  const airportSet = new Set<number>();
  const tierFlights: [number, number, number, number] = [0, 0, 0, 0];
  let flights = 0;
  let directedRoutes = 0;
  for (const r of kept) {
    airportSet.add(r.a);
    airportSet.add(r.b);
    flights += r.ab + r.ba;
    directedRoutes += (r.ab > 0 ? 1 : 0) + (r.ba > 0 ? 1 : 0);
    for (let t = 0; t < 4; t++) tierFlights[t]! += r.tiersAB[t]! + r.tiersBA[t]!;
  }
  return {
    month: month.month,
    daysInMonth: month.daysInMonth,
    routes: kept,
    airports: [...airportSet].sort((x, y) => x - y),
    flights,
    directedRoutes,
    tierFlights,
    candidateRoutes: byRoute.size,
    candidateFlights,
    droppedByMinFlights: dropF,
    droppedByMinMonths: dropM,
  };
}

/** Compact edge arrays for the worker. Node ids are positions in net.airports. */
export function edgeArrays(net: ResearchNetwork, directed: boolean) {
  const node = new Map(net.airports.map((a, i) => [a, i]));
  const src: number[] = [];
  const dst: number[] = [];
  const w: number[] = [];
  for (const r of net.routes) {
    const a = node.get(r.a)!;
    const b = node.get(r.b)!;
    if (directed) {
      if (r.ab > 0) {
        src.push(a);
        dst.push(b);
        w.push(r.ab);
      }
      if (r.ba > 0) {
        src.push(b);
        dst.push(a);
        w.push(r.ba);
      }
    } else {
      src.push(a);
      dst.push(b);
      w.push(r.ab + r.ba);
    }
  }
  return { n: net.airports.length, src: Int32Array.from(src), dst: Int32Array.from(dst), weight: Float64Array.from(w), directed };
}

// ---- route table ----------------------------------------------------------------------------------

export interface RouteRow {
  routeId: number;
  origin: number;
  destination: number;
  /** false for undirected rows (origin/destination are just the two ends) */
  directed: boolean;
  flights: number;
  /** same config in the previous month of the data; null when there is no previous month */
  previous: number | null;
  tiers: [number, number, number, number];
  monthsPresent: number | null;
}

export function routeRows(net: ResearchNetwork, directed: boolean, previous: ResearchNetwork | null): RouteRow[] {
  const prev = new Map<string, number>();
  if (previous) {
    for (const r of previous.routes) {
      if (directed) {
        prev.set(`${r.a}>${r.b}`, r.ab);
        prev.set(`${r.b}>${r.a}`, r.ba);
      } else prev.set(`${r.a}-${r.b}`, r.ab + r.ba);
    }
  }
  const out: RouteRow[] = [];
  for (const r of net.routes) {
    if (directed) {
      for (const [o, d, f, t] of [[r.a, r.b, r.ab, r.tiersAB], [r.b, r.a, r.ba, r.tiersBA]] as const) {
        if (f <= 0) continue;
        out.push({ routeId: r.routeId, origin: o, destination: d, directed: true, flights: f,
          previous: previous ? prev.get(`${o}>${d}`) ?? 0 : null, tiers: [...t] as RouteRow['tiers'], monthsPresent: r.monthsPresent });
      }
    } else {
      out.push({ routeId: r.routeId, origin: r.a, destination: r.b, directed: false, flights: r.ab + r.ba,
        previous: previous ? prev.get(`${r.a}-${r.b}`) ?? 0 : null,
        tiers: r.tiersAB.map((x, i) => x + r.tiersBA[i]!) as RouteRow['tiers'], monthsPresent: r.monthsPresent });
    }
  }
  return out.sort((x, y) => y.flights - x.flights || x.routeId - y.routeId);
}

// ---- country / region networks ---------------------------------------------------------------------

export interface AreaPair {
  from: string;
  to: string;
  flights: number;
}

export interface AreaStat {
  area: string;
  /** flights with both airports in the area */
  domestic: number;
  /** flights leaving + entering the area */
  international: number;
  partners: number;
  topPartners: { area: string; flights: number }[];
}

export interface AreaNetwork {
  unit: 'country' | 'region';
  directed: boolean;
  pairs: AreaPair[];
  stats: AreaStat[];
}

/**
 * Aggregates airport-to-airport flights to countries or regions. Each flight is counted once
 * (on its origin -> destination area pair); flights inside an area are 'domestic' for that area.
 */
export function areaNetwork(net: ResearchNetwork, areaOf: (airport: number) => string, unit: 'country' | 'region', directed: boolean): AreaNetwork {
  const pair = new Map<string, number>();
  const domestic = new Map<string, number>();
  const add = (o: number, d: number, f: number) => {
    if (f <= 0) return;
    const A = areaOf(o) || '?';
    const B = areaOf(d) || '?';
    if (A === B) {
      domestic.set(A, (domestic.get(A) ?? 0) + f);
      return;
    }
    const key = directed ? `${A}>${B}` : A < B ? `${A}>${B}` : `${B}>${A}`;
    pair.set(key, (pair.get(key) ?? 0) + f);
  };
  for (const r of net.routes) {
    add(r.a, r.b, r.ab);
    add(r.b, r.a, r.ba);
  }
  const pairs = [...pair].map(([k, flights]) => {
    const [from, to] = k.split('>') as [string, string];
    return { from, to, flights };
  }).sort((x, y) => y.flights - x.flights || (x.from + x.to).localeCompare(y.from + y.to));
  const partners = new Map<string, Map<string, number>>();
  for (const p of pairs) {
    for (const [x, y] of [[p.from, p.to], [p.to, p.from]] as const) {
      const m = partners.get(x) ?? new Map<string, number>();
      m.set(y, (m.get(y) ?? 0) + p.flights);
      partners.set(x, m);
    }
  }
  const areas = new Set([...domestic.keys(), ...partners.keys()]);
  const stats = [...areas].map((area) => {
    const m = partners.get(area) ?? new Map<string, number>();
    const top = [...m].map(([a, flights]) => ({ area: a, flights })).sort((x, y) => y.flights - x.flights || x.area.localeCompare(y.area));
    return { area, domestic: domestic.get(area) ?? 0, international: top.reduce((s, t) => s + t.flights, 0), partners: m.size, topPartners: top.slice(0, 5) };
  }).sort((x, y) => y.international - x.international || x.area.localeCompare(y.area));
  return { unit, directed, pairs, stats };
}
