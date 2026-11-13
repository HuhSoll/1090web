/**
 * From an observed aggregate and a scenario to the baseline and simulated networks, direct impact
 * and the input of the connectivity analysis. Pure functions (no React, no store): the UI hook and
 * the tests call the same code.
 *
 * Both networks use the Research Mode network builder with the same conditions. The minimum
 * flight count selects the BASELINE routes; the simulated network keeps a baseline route while it
 * still has at least one flight, so a partly affected route never disappears only because it fell
 * below the threshold.
 */
import type { MonthData, StaticNetwork } from '../data/model/network';
import type { ResearchMonth } from '../research/data';
import { defaultConfig, TIER_SETS, type ResearchConfig } from '../research/model';
import { buildResearchNetwork, edgeArrays, type ResearchNetwork, type ScopeContext } from '../research/network';
import { subtractRows, toMonthData, toResearchMonth, type AggregateRows, type DisruptionStats } from '../temporal/aggregate';
import {
  applyStructuralExplore,
  applyStructuralResearch,
  structuralState,
  type Disruption,
  type Interval,
  type StructuralState,
} from './disruption';
import type { ImpactInput } from './impact';
import { parseIsoUtc, type SimulationScenario } from './model';

export interface SimNetworks {
  explore: MonthData;
  research: ResearchMonth;
  net: ResearchNetwork;
}

export interface DirectImpact {
  /** scenario target airports present in the baseline network (global indices) */
  targets: number[];
  /** targets of the scenario that have no connection in the baseline network */
  targetsNotInBaseline: number[];
  /** airports with fewer connections afterwards, targets excluded */
  affectedAirports: number;
  /** airport pairs (undirected) with flights before and none after */
  lostConnections: number;
  /** directed connections lost */
  lostDirected: number;
  /** pairs that keep flights but fewer */
  reducedConnections: number;
  /** observed flights of the baseline that the scenario selects (structural: on unavailable
   *  connections; temporal: records inside the disruption) */
  flights: number;
  baselineFlights: number;
  byCarrier: { carrier: string; flights: number }[];
  byCountry: { country: string; flights: number }[];
  byRegion: { region: string; flights: number }[];
  /** per route: flights before / after (only changed routes) */
  routes: { routeId: number; a: number; b: number; before: number; after: number }[];
}

export interface SimulationOutput {
  key: string;
  window: { startMs: number; endMs: number };
  model: SimulationScenario['simulationModel'];
  baselineMode: SimulationScenario['baselineMode'];
  /** structural model: which events counted */
  evaluation: { at: number } | { window: Interval } | null;
  structural: StructuralState | null;
  temporal: DisruptionStats | null;
  before: SimNetworks;
  after: SimNetworks;
  direct: DirectImpact;
  impactInput: ImpactInput;
  /** scenario targets (global indices): airports and directly suspended routes */
  targetAirports: number[];
  targetRoutes: number[];
  /** global airport index of each impact node */
  impactNodes: number[];
}

export function researchConfigOf(s: SimulationScenario, month: string): ResearchConfig {
  return {
    ...defaultConfig(month),
    tiers: s.filters.tiers,
    classes: [...s.filters.classes],
    minFlights: s.filters.minFlights,
    directed: s.analysisSettings.directed,
    pathMethod: s.analysisSettings.pathMethod,
    samples: s.analysisSettings.samples,
    seed: s.analysisSettings.seed,
  };
}

/** Which events count in the structural model (see the module doc of disruption.ts). */
export function structuralWhen(s: SimulationScenario, window: Interval): { at: number } | { window: Interval } | null {
  if (s.baselineMode === 'dynamic') return { window };
  const at = parseIsoUtc(s.evaluationTime);
  return at === null ? { window } : { at };
}

/** Baseline route ids (after thresholds) restrict the simulated network to the same routes. */
function restrictTo(net: ResearchNetwork, base: ResearchNetwork): ResearchNetwork {
  const keep = new Set(base.routes.map((r) => r.routeId));
  const routes = net.routes.filter((r) => keep.has(r.routeId));
  const airports = new Set<number>();
  let flights = 0;
  let directedRoutes = 0;
  const tierFlights: [number, number, number, number] = [0, 0, 0, 0];
  for (const r of routes) {
    airports.add(r.a);
    airports.add(r.b);
    flights += r.ab + r.ba;
    directedRoutes += (r.ab > 0 ? 1 : 0) + (r.ba > 0 ? 1 : 0);
    for (let t = 0; t < 4; t++) tierFlights[t]! += r.tiersAB[t]! + r.tiersBA[t]!;
  }
  return { ...net, routes, airports: [...airports].sort((x, y) => x - y), flights, directedRoutes, tierFlights };
}

export interface BuildInput {
  network: StaticNetwork;
  scope: ScopeContext;
  scenario: SimulationScenario;
  disruption: Disruption;
  window: { startMs: number; endMs: number };
  label: string;
  days: number;
  rows: AggregateRows;
  affected: AggregateRows | null;
  temporal: DisruptionStats | null;
  key: string;
}

export function buildSimulation(inp: BuildInput): SimulationOutput {
  const { network, scenario: s } = inp;
  const carriers = network.carriers.map((c) => c.id);
  const month = new Date(inp.window.startMs).toISOString().slice(0, 7);
  const config = researchConfigOf(s, month);
  const routeEnds = (rid: number): [number, number] => [network.routes[rid]!.a, network.routes[rid]!.b];

  const beforeR = toResearchMonth(inp.rows, carriers, inp.label, inp.days);
  const beforeE = toMonthData(inp.rows, carriers, inp.label, inp.days);
  let afterR: ResearchMonth;
  let afterE: MonthData;
  let structural: StructuralState | null = null;
  let evaluation: SimulationOutput['evaluation'] = null;
  if (s.simulationModel === 'structural') {
    evaluation = structuralWhen(s, { s: inp.window.startMs, e: inp.window.endMs });
    structural = structuralState(inp.disruption, evaluation);
    afterR = applyStructuralResearch(beforeR, structural, routeEnds);
    afterE = applyStructuralExplore(beforeE, structural, routeEnds);
  } else {
    const kept = inp.affected ? subtractRows(inp.rows, inp.affected) : inp.rows;
    afterR = toResearchMonth(kept, carriers, inp.label, inp.days);
    afterE = toMonthData(kept, carriers, inp.label, inp.days);
  }
  const beforeNet = buildResearchNetwork(inp.scope, beforeR, config);
  const afterNet = restrictTo(buildResearchNetwork(inp.scope, afterR, { ...config, minFlights: 1 }), beforeNet);

  const direct = directImpact(network, inp.scope, s, inp.disruption, beforeR, afterR, beforeNet, afterNet);
  const { input, nodes } = impactInputOf(beforeNet, afterNet, inp.disruption, s.analysisSettings.directed);
  return {
    key: inp.key, window: inp.window, model: s.simulationModel, baselineMode: s.baselineMode, evaluation, structural,
    temporal: inp.temporal,
    before: { explore: beforeE, research: beforeR, net: beforeNet },
    after: { explore: afterE, research: afterR, net: afterNet },
    direct, impactInput: input, impactNodes: nodes,
    targetAirports: inp.disruption.targetAirports, targetRoutes: inp.disruption.targetRoutes,
  };
}

export function impactInputOf(before: ResearchNetwork, after: ResearchNetwork, d: Disruption, directed: boolean): { input: ImpactInput; nodes: number[] } {
  const nodes = before.airports;
  const local = new Map(nodes.map((a, i) => [a, i]));
  const eb = edgeArrays(before, directed);
  // the simulated edges in the baseline's node numbering
  const src: number[] = [];
  const dst: number[] = [];
  for (const r of after.routes) {
    const a = local.get(r.a);
    const b = local.get(r.b);
    if (a === undefined || b === undefined) continue;
    if (directed) {
      if (r.ab > 0) {
        src.push(a);
        dst.push(b);
      }
      if (r.ba > 0) {
        src.push(b);
        dst.push(a);
      }
    } else {
      src.push(a);
      dst.push(b);
    }
  }
  const targets = d.targetAirports.map((a) => local.get(a)).filter((x): x is number => x !== undefined);
  const pairs: number[] = [];
  for (const rid of d.targetRoutes) {
    const r = before.routes.find((x) => x.routeId === rid);
    if (!r) continue;
    pairs.push(local.get(r.a)!, local.get(r.b)!);
  }
  return {
    nodes,
    input: {
      n: nodes.length, directed,
      before: { src: eb.src, dst: eb.dst },
      after: { src: Int32Array.from(src), dst: Int32Array.from(dst) },
      targets: Int32Array.from(targets),
      excludedPairs: Int32Array.from(pairs),
    },
  };
}

function directImpact(
  network: StaticNetwork, scope: ScopeContext, s: SimulationScenario, d: Disruption,
  beforeR: ResearchMonth, afterR: ResearchMonth, before: ResearchNetwork, after: ResearchNetwork,
): DirectImpact {
  const inBase = new Set(before.airports);
  const afterRoutes = new Map(after.routes.map((r) => [r.routeId, r]));
  let lostConnections = 0;
  let lostDirected = 0;
  let reducedConnections = 0;
  const degBefore = new Map<number, number>();
  const degAfter = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
  const routes: DirectImpact['routes'] = [];
  for (const r of before.routes) {
    bump(degBefore, r.a);
    bump(degBefore, r.b);
    const x = afterRoutes.get(r.routeId);
    const fb = r.ab + r.ba;
    const fa = x ? x.ab + x.ba : 0;
    if (x) {
      bump(degAfter, r.a);
      bump(degAfter, r.b);
    }
    if (!x) lostConnections++;
    else if (fa < fb) reducedConnections++;
    lostDirected += (r.ab > 0 && !(x && x.ab > 0) ? 1 : 0) + (r.ba > 0 && !(x && x.ba > 0) ? 1 : 0);
    if (fa < fb) routes.push({ routeId: r.routeId, a: r.a, b: r.b, before: fb, after: fa });
  }
  const targets = new Set(d.targetAirports);
  let affectedAirports = 0;
  for (const [a, n] of degBefore) if (!targets.has(a) && (degAfter.get(a) ?? 0) < n) affectedAirports++;

  // flights the scenario selects: baseline rows minus simulated rows, on baseline routes, same
  // tier / class conditions as the networks
  const tiers = new Set(TIER_SETS[s.filters.tiers]);
  const cls = s.filters.classes;
  const baseRoutes = new Set(before.routes.map((r) => r.routeId));
  const sumRows = (m: ResearchMonth) => {
    const byKey = new Map<string, { rid: number; dir: number; carrier: number; f: number }>();
    for (let i = 0; i < m.size; i++) {
      if (!tiers.has(m.tier[i]!) || !baseRoutes.has(m.route[i]!)) continue;
      const f = (cls.includes('passenger') ? m.passenger[i]! : 0) + (cls.includes('cargo') ? m.cargo[i]! : 0) + (cls.includes('unknown') ? m.unknown[i]! : 0);
      if (f <= 0) continue;
      const k = `${m.route[i]},${m.dir[i]},${m.carrier[i]}`;
      const e = byKey.get(k);
      if (e) e.f += f;
      else byKey.set(k, { rid: m.route[i]!, dir: m.dir[i]!, carrier: m.carrier[i]!, f });
    }
    return byKey;
  };
  const b = sumRows(beforeR);
  const a = sumRows(afterR);
  const byCarrier = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const byRegion = new Map<string, number>();
  let flights = 0;
  let baselineFlights = 0;
  for (const [k, e] of b) {
    baselineFlights += e.f;
    const diff = e.f - (a.get(k)?.f ?? 0);
    if (diff <= 0) continue;
    flights += diff;
    const carrier = beforeR.carriers[e.carrier] ?? '?';
    byCarrier.set(carrier, (byCarrier.get(carrier) ?? 0) + diff);
    const r = network.routes[e.rid]!;
    const origin = e.dir === 0 ? r.a : r.b;
    const country = network.airports[origin]!.country;
    byCountry.set(country, (byCountry.get(country) ?? 0) + diff);
    const region = scope.continentOf[origin] ?? '?';
    byRegion.set(region, (byRegion.get(region) ?? 0) + diff);
  }
  const sorted = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return {
    targets: d.targetAirports.filter((x) => inBase.has(x)),
    targetsNotInBaseline: d.targetAirports.filter((x) => !inBase.has(x)),
    affectedAirports, lostConnections, lostDirected, reducedConnections,
    flights, baselineFlights,
    byCarrier: sorted(byCarrier).map(([carrier, f]) => ({ carrier, flights: f })),
    byCountry: sorted(byCountry).map(([country, f]) => ({ country, flights: f })),
    byRegion: sorted(byRegion).map(([region, f]) => ({ region, flights: f })),
    routes: routes.sort((x, y) => y.before - y.after - (x.before - x.after)),
  };
}
