/**
 * Result exports. Every CSV row carries the scenario hash, the dataset and the period, so a file
 * can always be matched to the scenario JSON that reproduces it.
 */
import type { StaticNetwork } from '../data/model/network';
import { csvEscape } from '../research/results';
import type { SimulationOutput } from './engine';
import type { ImpactResult, ReachStats } from './impact';
import { isoMinute, scenarioHash, SIM_SCHEMA_VERSION, type SimulationScenario } from './model';

export const RESULT_FORMAT = '1090web-simulation-result';

function stampOf(s: SimulationScenario, out: SimulationOutput) {
  return {
    cols: ['scenario_hash', 'dataset_id', 'dataset_version', 'period_start_utc', 'period_end_utc', 'simulation_model', 'baseline_mode',
      'time_proxy', 'tiers', 'min_flights', 'directed'],
    values: [scenarioHash(s, out.window), s.datasetId, s.datasetVersion ?? '', isoMinute(out.window.startMs), isoMinute(out.window.endMs),
      s.simulationModel, s.baselineMode, s.simulationModel === 'temporal' ? s.filters.timeProxy : '', s.filters.tiers, s.filters.minFlights,
      s.analysisSettings.directed ? 'directed' : 'undirected'] as (string | number)[],
  };
}

function csv(cols: string[], rows: (string | number | null)[][]): string {
  return [cols.join(','), ...rows.map((r) => r.map((v) => csvEscape(v ?? '')).join(','))].join('\n') + '\n';
}

const code = (net: StaticNetwork, i: number) => net.airports[i]!.iata ?? net.airports[i]!.id;

/** Network measures before / after, total and spillover. */
export function metricsCsv(s: SimulationScenario, out: SimulationOutput, imp: ImpactResult | null): string {
  const st = stampOf(s, out);
  const rows: (string | number)[][] = [];
  const add = (scope: string, metric: string, before: number, after: number) => rows.push([...st.values, scope, metric, before, after, after - before]);
  add('network', 'airports_with_connections', out.before.net.airports.length, out.after.net.airports.length);
  add('network', 'connections_undirected', out.before.net.routes.length, out.after.net.routes.length);
  add('network', 'connections_directed', out.before.net.directedRoutes, out.after.net.directedRoutes);
  add('network', 'observed_flights', out.before.net.flights, out.after.net.flights);
  add('direct', 'selected_observed_flights', 0, out.direct.flights);
  add('direct', 'lost_connections', 0, out.direct.lostConnections);
  add('direct', 'reduced_connections', 0, out.direct.reducedConnections);
  add('direct', 'affected_airports_excluding_targets', 0, out.direct.affectedAirports);
  if (imp) {
    const reach = (scope: string, b: ReachStats, a: ReachStats) => {
      add(scope, 'ordered_pairs', b.pairs, a.pairs);
      add(scope, 'reachable_pairs', b.reachable, a.reachable);
      add(scope, 'pairs_within_1_hop', b.hop1, a.hop1);
      add(scope, 'pairs_within_2_hops', b.hop2, a.hop2);
      add(scope, 'pairs_within_3_hops', b.hop3, a.hop3);
      add(scope, 'global_efficiency', b.efficiency, a.efficiency);
    };
    reach('total', imp.total.before, imp.total.after);
    reach('spillover', imp.spillover.before, imp.spillover.after);
    add('total', 'weak_components_including_isolated', imp.components.before.count, imp.components.after.count);
    add('total', 'largest_component', imp.components.before.largest, imp.components.after.largest);
    add('spillover', 'pairs_that_lost_every_path', 0, imp.lostPairs.total);
  }
  return csv([...st.cols, 'scope', 'metric', 'before', 'after', 'change'], rows);
}

export function airportsCsv(s: SimulationScenario, out: SimulationOutput, imp: ImpactResult, net: StaticNetwork): string {
  const st = stampOf(s, out);
  const targets = new Set(out.targetAirports);
  const p = imp.perNode;
  const rows = out.impactNodes.map((g, i) => [
    ...st.values, net.airports[g]!.id, net.airports[g]!.iata ?? '', net.airports[g]!.name, net.airports[g]!.country, targets.has(g) ? 'target' : 'other',
    p.degBefore[i]!, p.degAfter[i]!, p.reachBefore[i]!, p.reachAfter[i]!, p.hop2Before[i]!, p.hop2After[i]!, p.hop3Before[i]!, p.hop3After[i]!,
    p.lost[i]!, p.longer[i]!, p.addedHops[i]!,
  ]);
  rows.sort((x, y) => (y[st.values.length + 14] as number) - (x[st.values.length + 14] as number));
  return csv([...st.cols, 'airport_id', 'iata', 'name', 'country', 'role', 'connections_before', 'connections_after', 'reachable_before',
    'reachable_after', 'within_2_hops_before', 'within_2_hops_after', 'within_3_hops_before', 'within_3_hops_after', 'partners_lost',
    'partners_with_longer_paths', 'added_hops'], rows);
}

export function routesCsv(s: SimulationScenario, out: SimulationOutput, net: StaticNetwork): string {
  const st = stampOf(s, out);
  const suspended = new Set(out.targetRoutes);
  return csv([...st.cols, 'airport_a', 'airport_b', 'flights_before', 'flights_after', 'status', 'directly_suspended'],
    out.direct.routes.map((r) => [...st.values, net.airports[r.a]!.id, net.airports[r.b]!.id, r.before, r.after, r.after === 0 ? 'lost' : 'reduced',
      suspended.has(r.routeId) ? 'yes' : 'no']));
}

/** Airport pairs (not targets) with a path before and none after: the alternative-path analysis. */
export function lostPairsCsv(s: SimulationScenario, out: SimulationOutput, imp: ImpactResult, net: StaticNetwork): string {
  const st = stampOf(s, out);
  const rows: (string | number)[][] = [];
  for (let i = 0; i + 1 < imp.lostPairs.list.length; i += 2) {
    const a = out.impactNodes[imp.lostPairs.list[i]!]!;
    const b = out.impactNodes[imp.lostPairs.list[i + 1]!]!;
    rows.push([...st.values, net.airports[a]!.id, net.airports[b]!.id, code(net, a), code(net, b)]);
  }
  return csv([...st.cols, 'from_airport', 'to_airport', 'from_code', 'to_code', `listed_${rows.length}_of_${imp.lostPairs.total}`], rows);
}

export function areasCsv(s: SimulationScenario, out: SimulationOutput): string {
  const st = stampOf(s, out);
  return csv([...st.cols, 'unit', 'key', 'selected_observed_flights'], [
    ...out.direct.byRegion.map((r) => [...st.values, 'region_of_origin', r.region, r.flights]),
    ...out.direct.byCountry.map((r) => [...st.values, 'country_of_origin', r.country, r.flights]),
    ...out.direct.byCarrier.map((r) => [...st.values, 'airline_code', r.carrier, r.flights]),
  ]);
}

/** Result document: the scenario (reproducible), what was computed, and the headline numbers. */
export function resultJson(s: SimulationScenario, out: SimulationOutput, imp: ImpactResult | null): string {
  return `${JSON.stringify({
    format: RESULT_FORMAT,
    schemaVersion: SIM_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scenarioHash: scenarioHash(s, out.window),
    scenario: s,
    analysedPeriod: { startTimeUtc: isoMinute(out.window.startMs), endTimeUtc: isoMinute(out.window.endMs) },
    algorithms: {
      reachability: 'breadth-first search from every airport, hop counts (exact, no sampling)',
      globalEfficiency: 'E = 1 / (N (N - 1)) * sum over ordered pairs of 1 / d(i, j); 1 / d = 0 when unreachable; same node set before and after',
      spillover: 'pairs of airports that are not scenario targets and not suspended pairs; paths through targets allowed before',
      temporalMatching: s.simulationModel === 'temporal'
        ? `flight records, half-open [start, end), minute precision; proxy = ${s.filters.timeProxy}` : null,
      approximation: 'none',
    },
    direct: { ...out.direct, routes: out.direct.routes.length },
    temporal: out.temporal,
    impact: imp ? { total: imp.total, spillover: imp.spillover, components: imp.components, edges: imp.edges, hopChange: imp.hopChange, lostPairs: imp.lostPairs.total, elapsedMs: imp.elapsedMs } : null,
    interpretation: 'Structural statements about the observed ADS-B network under a hypothetical disruption. Not a forecast of cancellations, passengers or airline operations.',
  }, null, 1)}\n`;
}
