/**
 * Assembles an analysis result (network + metrics) into tables, and writes / reads the export
 * files. Every CSV row carries the config hash and dataset version that the JSON also records,
 * so a CSV can always be matched with the conditions that produced it.
 */
import type { StaticNetwork } from '../data/model/network';
import { PAGERANK_ALPHA, PAGERANK_TOL, type MetricsResult } from './analysis';
import type { ResearchMeta } from './data';
import { configHash, sanitizeConfig, type ConfigContext, type ResearchConfig } from './model';
import type { AreaNetwork, ResearchNetwork, RouteRow } from './network';

export const EXPORT_FORMAT = '1090web-research-analysis';
export const EXPORT_FORMAT_VERSION = 1;

export type AirportMetricKey =
  | 'degree'
  | 'inDegree'
  | 'outDegree'
  | 'strength'
  | 'degreeCentrality'
  | 'betweenness'
  | 'harmonicNormalized'
  | 'pagerank'
  | 'clustering';

export const AIRPORT_METRICS: readonly AirportMetricKey[] = [
  'degree', 'strength', 'degreeCentrality', 'betweenness', 'harmonicNormalized', 'pagerank', 'clustering', 'inDegree', 'outDegree',
];

export interface AnalysisResult {
  config: ResearchConfig;
  hash: string;
  network: ResearchNetwork;
  metrics: MetricsResult;
  routes: RouteRow[];
  countries: AreaNetwork;
  regions: AreaNetwork;
  /** routes of the same config in the previous month (for the month-over-month column) */
  previousMonth: string | null;
  computedAt: string;
}

/** Metric value of airport index `a` (0 when the airport is not in the network). */
export function airportScores(r: AnalysisResult, key: AirportMetricKey): Map<number, number> {
  const arr = r.metrics[key];
  const out = new Map<number, number>();
  r.network.airports.forEach((a, node) => out.set(a, arr[node]!));
  return out;
}

// ---- CSV ------------------------------------------------------------------------------------------

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(10)))) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

function stamp(r: AnalysisResult, meta: ResearchMeta) {
  return [r.hash, meta.manifest.datasetId, meta.manifest.datasetVersion ?? '', r.config.month];
}
const STAMP_COLS = ['config_hash', 'dataset_id', 'dataset_version', 'month'];

export function airportsCsv(r: AnalysisResult, net: StaticNetwork, meta: ResearchMeta, sortBy: AirportMetricKey = 'degree'): string {
  const scores = airportScores(r, sortBy);
  const order = r.network.airports.map((a, node) => ({ a, node })).sort((x, y) =>
    scores.get(y.a)! - scores.get(x.a)! || net.airports[x.a]!.id.localeCompare(net.airports[y.a]!.id));
  const cols = [...STAMP_COLS, 'rank_by', 'rank', 'airport_id', 'iata', 'icao', 'name', 'country', 'degree', 'in_degree', 'out_degree',
    'strength_flights', 'in_strength', 'out_strength', 'degree_centrality', 'betweenness', 'betweenness_raw', 'harmonic_closeness',
    'harmonic_closeness_normalized', 'pagerank', 'clustering'];
  let rank = 0;
  let prev: number | null = null;
  const rows = order.map(({ a, node }, i) => {
    const s = scores.get(a)!;
    if (s !== prev) {
      rank = i + 1;
      prev = s;
    }
    const ap = net.airports[a]!;
    const m = r.metrics;
    return [...stamp(r, meta), sortBy, rank, ap.id, ap.iata, ap.icao, ap.name, ap.country, m.degree[node], m.inDegree[node], m.outDegree[node],
      m.strength[node], m.inStrength[node], m.outStrength[node], m.degreeCentrality[node], m.betweenness[node], m.betweennessRaw[node],
      m.harmonic[node], m.harmonicNormalized[node], m.pagerank[node], m.clustering[node]];
  });
  return toCsv(cols, rows);
}

export function routesCsv(r: AnalysisResult, net: StaticNetwork, meta: ResearchMeta): string {
  const cols = [...STAMP_COLS, 'origin', 'destination', 'directed', 'flights', 'previous_month', 'previous_flights', 'change_pct',
    'flights_T1', 'flights_T2', 'flights_T3', 'flights_T4', 'months_present'];
  const rows = r.routes.map((x) => [...stamp(r, meta), net.airports[x.origin]!.id, net.airports[x.destination]!.id, x.directed, x.flights,
    r.previousMonth ?? '', x.previous, x.previous ? (100 * (x.flights - x.previous)) / x.previous : '', ...x.tiers, x.monthsPresent]);
  return toCsv(cols, rows);
}

export function areaCsv(r: AnalysisResult, meta: ResearchMeta, area: AreaNetwork): string {
  const cols = [...STAMP_COLS, 'unit', 'from', 'to', 'directed', 'flights'];
  const rows = [
    ...area.pairs.map((p) => [...stamp(r, meta), area.unit, p.from, p.to, area.directed, p.flights]),
    ...area.stats.filter((s) => s.domestic > 0).map((s) => [...stamp(r, meta), area.unit, s.area, s.area, area.directed, s.domestic]),
  ];
  return toCsv(cols, rows);
}

export function summaryCsv(r: AnalysisResult, meta: ResearchMeta): string {
  const s = r.metrics.summary;
  const rows: [string, unknown][] = [
    ['airports', r.network.airports.length], ['routes_undirected', r.network.routes.length], ['routes_directed', r.network.directedRoutes],
    ['flights', r.network.flights], ['density', s.density], ['components', s.components], ['largest_component', s.largestComponent],
    ['strong_components', s.strongComponents], ['largest_strong_component', s.largestStrongComponent], ['average_clustering', s.averageClustering],
    ['transitivity', s.transitivity], ['flights_T1', r.network.tierFlights[0]], ['flights_T2', r.network.tierFlights[1]],
    ['flights_T3', r.network.tierFlights[2]], ['flights_T4', r.network.tierFlights[3]],
    ['dropped_by_min_flights_routes', r.network.droppedByMinFlights.routes], ['dropped_by_min_flights_flights', r.network.droppedByMinFlights.flights],
    ['dropped_by_min_months_routes', r.network.droppedByMinMonths.routes], ['path_measures_exact', s.path.exact], ['path_sources', s.path.sources],
  ];
  return toCsv([...STAMP_COLS, 'metric', 'value'], rows.map(([k, v]) => [...stamp(r, meta), k, v]));
}

// ---- JSON (conditions + provenance) ----------------------------------------------------------------

export interface AnalysisDocument {
  format: string;
  formatVersion: number;
  dataset: { id: string; version: string | null; generatedAt: string; researchWebGeneratedAt: string; inputs: Record<string, string>; files: Record<string, string> };
  config: ResearchConfig;
  configHash: string;
  algorithms: Record<string, unknown>;
  approximate: boolean;
  externalValidation: { sources: unknown; note: string };
  computedAt: string;
  summary: Record<string, unknown>;
  comparison?: { config: ResearchConfig; configHash: string; changed: string[] };
}

export function analysisDocument(r: AnalysisResult, meta: ResearchMeta, comparison?: AnalysisDocument['comparison']): AnalysisDocument {
  const s = r.metrics.summary;
  const files: Record<string, string> = {};
  const exploreFile = `months/${r.config.month}.json`;
  for (const [k, v] of Object.entries(meta.manifest.files)) if (k === `tiers/${r.config.month}.json` || k === 'persistence.json' || k === 'quality.json') files[`research-web/${k}`] = v;
  files[exploreFile] = '(Explore month file; identified by dataset version)';
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    dataset: {
      id: meta.manifest.datasetId,
      version: meta.manifest.datasetVersion,
      generatedAt: meta.quality.dataset.generatedAt,
      researchWebGeneratedAt: meta.manifest.generatedAt,
      inputs: meta.manifest.inputs,
      files,
    },
    config: r.config,
    configHash: r.hash,
    algorithms: {
      graph: r.config.directed ? 'directed: one arc per observed direction' : 'undirected: airport pairs, both directions summed',
      weights: 'observed monthly flights (selected aircraft classes and tiers)',
      selfLoops: 'excluded', duplicateEdges: 'merged (weights summed)',
      degreeCentrality: 'NetworkX degree_centrality: (in + out degree) / (n - 1)',
      pathMeasures: s.path,
      pagerank: { alpha: PAGERANK_ALPHA, tol: PAGERANK_TOL, weight: 'flights', dangling: 'uniform', iterations: s.pagerankIterations, converged: s.pagerankConverged },
      clustering: 'local clustering on the underlying undirected simple graph (unweighted); average over all nodes; transitivity = 3 triangles / triples',
      components: r.config.directed ? 'weakly and strongly connected components' : 'connected components',
      threshold: 'route = airport pair; both directions summed; >= minFlights in the month',
      persistence: 'months of the data with >= 1 flight under the same tier set; months not in the data are not counted',
    },
    approximate: !s.path.exact,
    externalValidation: {
      sources: meta.quality.external.sources ?? null,
      note: 'External comparisons are conditional (different coverage and definitions); they are not accuracy. See docs/phase7-report.md.',
    },
    computedAt: r.computedAt,
    summary: {
      airports: r.network.airports.length, routes: r.network.routes.length, directedRoutes: r.network.directedRoutes,
      flights: r.network.flights, tierFlights: r.network.tierFlights, density: s.density, components: s.components,
      largestComponent: s.largestComponent, averageClustering: s.averageClustering, transitivity: s.transitivity,
    },
    ...(comparison ? { comparison } : {}),
  };
}

export interface ImportResult {
  config: ResearchConfig | null;
  errors: string[];
  warnings: string[];
}

/** Reads an exported JSON: checks the format, the dataset id / version, and the config hash. */
export function importDocument(text: string, meta: ResearchMeta, ctx: ConfigContext): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc: Partial<AnalysisDocument>;
  try {
    doc = JSON.parse(text) as Partial<AnalysisDocument>;
  } catch {
    return { config: null, errors: ['invalid_json'], warnings };
  }
  if (doc.format !== EXPORT_FORMAT || typeof doc.config !== 'object' || doc.config === null) {
    return { config: null, errors: ['not_an_analysis_file'], warnings };
  }
  if ((doc.formatVersion ?? 0) > EXPORT_FORMAT_VERSION) warnings.push('newer_format');
  if (doc.dataset?.id !== meta.manifest.datasetId) warnings.push('dataset_id_differs');
  else if (doc.dataset?.version !== meta.manifest.datasetVersion) warnings.push('dataset_version_differs');
  const { config, dropped } = sanitizeConfig(doc.config, ctx);
  if (dropped.length) warnings.push(`dropped:${dropped.join(',')}`);
  if (doc.configHash && dropped.length === 0 && configHash(config) !== doc.configHash) warnings.push('hash_mismatch');
  return { config, errors, warnings };
}
