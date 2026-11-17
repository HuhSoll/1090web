/**
 * Research experiments (Phase 9E): definitions and results.
 *
 * A definition says WHAT is compared (conditions or missingness trials, candidates, seeds); the
 * engine (engine.ts) computes it, summarize.ts turns raw impacts into statistics, and the views
 * only read an ExperimentResult. The result format is shared with the Python batch runner
 * (pipeline/experiments/run.py), so batch results can be imported and shown the same way.
 */
import type { ResearchConfig, TierSet, AircraftClass } from '../research/model';

export const DEFINITION_FORMAT = '1090web-experiment';
export const RESULT_FORMAT = '1090web-experiment-result';
export const SCHEMA_VERSION = 1;
export const METHOD_VERSION = '9e.1';

export type ExperimentType = 'sensitivity' | 'missingness';
export type CombineRule = 'origin' | 'destination' | 'max' | 'either' | 'both';

export type MissingnessModel =
  | { model: 'uniform'; rate: number }
  | { model: 'regional'; regionRates: Record<string, number>; otherRate: number; combine: CombineRule }
  | {
      model: 'route';
      lowFrequency: { threshold: number; rateLow: number; rateOther: number; unit: 'flight' | 'route' };
      /** the network on which "low frequency" was decided (recorded for reproducibility) */
      thresholdPeriod?: string;
    };

/** What a condition may change (the rest comes from the baseline). */
export interface ConditionFields {
  tiers: TierSet;
  minFlights: number;
  directed: boolean;
  classes: AircraftClass[];
  /** Python runner only: 'start' = only flights timed by their track start */
  basis?: 'all' | 'start';
  region?: string | null;
  start?: string;
  end?: string;
}

export interface Condition extends Partial<ConditionFields> {
  id: string;
}

export interface ExperimentDefinition {
  format: typeof DEFINITION_FORMAT;
  schemaVersion: number;
  experimentId: string;
  name: string;
  datasetId: string;
  experimentType: ExperimentType;
  /**
   * Python: {start, end, tiers, minFlights, directed, classes, basis, region}.
   * Browser: the Research Mode config of the baseline is kept in `research`.
   */
  baseline: Partial<ConditionFields> & { start?: string; end?: string; research?: ResearchConfig };
  conditions?: Condition[];
  missingness?: MissingnessModel;
  /** 'all' = every airport of the reference network; or airport ids; browser Quick: top-N */
  candidates: 'all' | string[] | { top: number; by: 'degree' };
  /** airports always included as candidates (e.g. the stopped airports of a simulation) */
  include?: string[];
  computation: { sources: number | null; sourceSeed: number };
  randomSeed: number;
  repetitions?: number;
  topK: number[];
}

export const METRICS = ['systemicDrop', 'spilloverDrop', 'spilloverBefore', 'unreachablePairs', 'hop1Drop', 'hop2Drop', 'hop3Drop', 'directLost', 'flightsLost'] as const;
export type Metric = (typeof METRICS)[number];

export interface RankComparison {
  spearman: number | null;
  kendall: number | null;
  /** on the airports present in both the reference and this run */
  spearmanCommon: number | null;
  /** top{k}: overlap share; jaccard{k} */
  [key: string]: number | null;
}

export interface RunRecord {
  runId: string;
  label: string;
  kind: 'condition' | 'reference' | 'trial';
  trial: number;
  conditions: Record<string, unknown>;
  nodes: number;
  arcs: number;
  flights: number;
  pairs: number;
  exact: boolean;
  sources: number;
  sourceSeed: number;
  randomSeed: number;
  complete: boolean;
  errors: unknown[];
  seconds: number;
  /** candidates present in this run's graph but without any route */
  isolated: string[];
  /** candidates absent from this run's graph (impact 0) */
  absent: number;
  comparison: { systemic: RankComparison; spillover: RankComparison };
}

export interface Stats {
  mean: number | null;
  median: number | null;
  sd: number | null;
  p05: number | null;
  p25: number | null;
  p75: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export interface AirportRow {
  id: string;
  iata: string | null;
  name: string | null;
  country: string | null;
  continent: string;
  lat: number | null;
  lon: number | null;
  ref: Record<Metric, number | null> & { rankSystemic: number; rankSpillover: number };
  runs: { systemic: (number | null)[]; spillover: (number | null)[]; rankSystemic: number[]; rankSpillover: number[] };
  isolatedIn: string[];
  systemicStats: Stats;
  spilloverStats: Stats;
  systemicRankStats: Stats;
  spilloverRankStats: Stats;
  /** systemicTop10Share etc. */
  [key: string]: unknown;
}

export interface ExperimentResult {
  format: typeof RESULT_FORMAT;
  schemaVersion: number;
  methodVersion: string;
  definitionHash: string;
  definition: ExperimentDefinition;
  /** continentRule: how airports were put on continents ("airport-v1" since Phase 9F; absent = old country rule) */
  dataset: { id: string; version: string | null; continentRule?: string };
  createdAt: string;
  source: string;
  computation: { exact: boolean; sources: number[]; sourceSeed: number; randomSeed: number; note: string };
  candidates: { count: number; rule: unknown };
  complete: boolean;
  runs: RunRecord[];
  systemicVsSpillover: Record<string, number | null>;
  airports: AirportRow[];
  interpretation: Record<string, string>;
}

// ---- defaults -------------------------------------------------------------------------------------

export const SENSITIVITY_PRESETS = {
  /** tier sets x thresholds (3 x 3) */
  tiersThresholds: [
    { id: 'T1-T4 min1', tiers: 'D', minFlights: 1 }, { id: 'T1-T4 min4', tiers: 'D', minFlights: 4 }, { id: 'T1-T4 min10', tiers: 'D', minFlights: 10 },
    { id: 'T1-T3 min1', tiers: 'C', minFlights: 1 }, { id: 'T1-T3 min4', tiers: 'C', minFlights: 4 }, { id: 'T1-T3 min10', tiers: 'C', minFlights: 10 },
    { id: 'T1 min1', tiers: 'A', minFlights: 1 }, { id: 'T1 min4', tiers: 'A', minFlights: 4 }, { id: 'T1 min10', tiers: 'A', minFlights: 10 },
  ] as Condition[],
  tiers: [{ id: 'T1-T4', tiers: 'D' }, { id: 'T1-T3', tiers: 'C' }, { id: 'T1', tiers: 'A' }] as Condition[],
  thresholds: [{ id: 'min1', minFlights: 1 }, { id: 'min4', minFlights: 4 }, { id: 'min10', minFlights: 10 }] as Condition[],
  direction: [{ id: 'directed', directed: true }, { id: 'undirected', directed: false }] as Condition[],
  classes: [{ id: 'all classes', classes: ['passenger', 'cargo', 'unknown'] }, { id: 'passenger only', classes: ['passenger'] }] as Condition[],
};

export const REPETITION_PRESETS = { interactive: [10, 30], batch: [100, 500, 1000] } as const;

export function newDefinition(research: ResearchConfig, datasetId: string, type: ExperimentType): ExperimentDefinition {
  return {
    format: DEFINITION_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    experimentId: `exp-${Date.now().toString(36)}`,
    name: '',
    datasetId,
    experimentType: type,
    baseline: { tiers: research.tiers, minFlights: research.minFlights, directed: true, classes: [...research.classes], region: research.region, research: { ...research, directed: true } },
    conditions: type === 'sensitivity' ? SENSITIVITY_PRESETS.tiersThresholds.slice(0, 1).concat(SENSITIVITY_PRESETS.tiersThresholds.slice(3, 4), SENSITIVITY_PRESETS.tiersThresholds.slice(6, 7)) : undefined,
    missingness: type === 'missingness' ? { model: 'uniform', rate: 0.1 } : undefined,
    candidates: { top: 30, by: 'degree' },
    computation: { sources: 1024, sourceSeed: 1 },
    randomSeed: 1,
    repetitions: type === 'missingness' ? 10 : undefined,
    topK: [10, 20],
  };
}

// ---- validation -------------------------------------------------------------------------------------

const isRate = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** Problems of a definition (empty = valid). Messages are i18n keys with an optional detail. */
export function definitionProblems(d: ExperimentDefinition): string[] {
  const out: string[] = [];
  if (d.experimentType === 'sensitivity' && !(d.conditions ?? []).length) out.push('x.err.noConditions');
  if (d.experimentType === 'missingness') {
    const m = d.missingness;
    if (!m) out.push('x.err.noModel');
    else if (m.model === 'uniform' && !isRate(m.rate)) out.push('x.err.rate');
    else if (m.model === 'regional' && (![...Object.values(m.regionRates), m.otherRate].every(isRate))) out.push('x.err.rate');
    else if (m.model === 'route' && (!isRate(m.lowFrequency.rateLow) || !isRate(m.lowFrequency.rateOther) || !(m.lowFrequency.threshold >= 1))) out.push('x.err.rate');
    if (!(Number.isInteger(d.repetitions) && d.repetitions! >= 1)) out.push('x.err.repetitions');
  }
  if (d.computation.sources !== null && !(Number.isInteger(d.computation.sources) && d.computation.sources >= 8)) out.push('x.err.sources');
  if (!Number.isInteger(d.randomSeed)) out.push('x.err.seed');
  return out;
}

/** The runs of a definition (same order and ids as the Python runner). */
export interface PlannedRun {
  runId: string;
  label: string;
  kind: RunRecord['kind'];
  trial: number;
  condition: Condition | null;
}

export function runsOf(d: ExperimentDefinition): PlannedRun[] {
  if (d.experimentType === 'sensitivity') {
    return (d.conditions ?? []).map((c, i) => ({ runId: `c${String(i).padStart(2, '0')}`, label: c.id || `condition ${i}`, kind: 'condition', trial: 0, condition: c }));
  }
  const reps = d.repetitions ?? 0;
  const out: PlannedRun[] = [{ runId: 't0000', label: 'reference (no added missingness)', kind: 'reference', trial: 0, condition: null }];
  for (let t = 1; t <= reps; t++) out.push({ runId: `t${String(t).padStart(4, '0')}`, label: `trial ${t}`, kind: 'trial', trial: t, condition: null });
  return out;
}

/** Stable short hash of the result-relevant part of a definition (names and ids left out). */
export function definitionHash(d: ExperimentDefinition): string {
  const keep = Object.fromEntries(Object.entries(d).filter(([k]) => !['name', 'experimentId', 'description'].includes(k)).sort(([a], [b]) => a.localeCompare(b)));
  const s = JSON.stringify(keep);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * The Python runner's definition for the same experiment, when the baseline is something the
 * runner can rebuild (a calendar month or window, no scenario, no carrier / country / airport scope).
 */
export function toBatchDefinition(d: ExperimentDefinition): { ok: true; definition: ExperimentDefinition } | { ok: false; reason: string } {
  const r = d.baseline.research;
  if (!r) return { ok: true, definition: d };
  if (r.scenario) return { ok: false, reason: 'x.batch.scenario' };
  if (r.carrier || r.country || r.airport || r.relation !== 'all') return { ok: false, reason: 'x.batch.scope' };
  if (r.minMonths) return { ok: false, reason: 'x.batch.minMonths' };
  const y = Number(r.month.slice(0, 4));
  const m = Number(r.month.slice(5, 7));
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const start = r.window ? iso(r.window.startMs) : iso(Date.UTC(y, m - 1, 1));
  const end = r.window ? iso(r.window.endMs) : iso(Date.UTC(y, m, 1));
  const { research: _research, ...base } = d.baseline;
  void _research;
  return {
    ok: true,
    definition: {
      ...d,
      baseline: { ...base, start, end, basis: r.window?.basis ?? 'all', region: r.region },
      candidates: Array.isArray(d.candidates) || d.candidates === 'all' ? d.candidates : 'all',
    },
  };
}

// ---- cost ---------------------------------------------------------------------------------------------

export interface CostEstimate {
  runs: number;
  candidates: number;
  /** BFS runs in total */
  bfs: number;
  seconds: number;
  level: 'ok' | 'slow' | 'batch';
}

/**
 * Cost before running: every run does one BFS per source for the baseline and one per source for
 * each candidate. `bfsMs` is measured on the reference graph (one BFS).
 */
export function estimateCost(runs: number, candidates: number, sources: number, bfsMs: number): CostEstimate {
  const bfs = runs * sources * (candidates + 1);
  const seconds = (bfs * bfsMs) / 1000;
  return { runs, candidates, bfs, seconds, level: seconds < 60 ? 'ok' : seconds < 600 ? 'slow' : 'batch' };
}

// ---- import ---------------------------------------------------------------------------------------------

export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;

export type ImportCheck =
  | { ok: true; result: ExperimentResult; warnings: string[] }
  | { ok: false; error: string };

/** Validates an imported result file (Python batch or a browser export). */
/** Does the definition use continents (regional missingness or a region filter)? */
export function usesContinents(d: ExperimentDefinition): boolean {
  if (d.missingness?.model === 'regional') return true;
  if (d.baseline.region || d.baseline.research?.region) return true;
  return (d.conditions ?? []).some((c) => !!c.region);
}

export function checkImport(raw: unknown, datasetId: string, datasetVersion: string | null, continentRule = 'airport-v1'): ImportCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'x.import.notJson' };
  const r = raw as Partial<ExperimentResult>;
  if (r.format !== RESULT_FORMAT) return { ok: false, error: 'x.import.format' };
  if (typeof r.schemaVersion !== 'number' || r.schemaVersion > SCHEMA_VERSION) return { ok: false, error: 'x.import.schema' };
  if (!Array.isArray(r.runs) || !Array.isArray(r.airports) || !r.definition || !r.dataset || !r.computation) return { ok: false, error: 'x.import.fields' };
  const nRuns = r.runs.length;
  for (const a of r.airports) {
    if (!a || typeof a.id !== 'string' || !a.runs || !Array.isArray(a.runs.systemic) || a.runs.systemic.length !== nRuns || a.runs.spillover.length !== nRuns) {
      return { ok: false, error: 'x.import.airports' };
    }
  }
  const warnings: string[] = [];
  if (r.dataset.id !== datasetId) warnings.push('x.import.otherDataset');
  else if (datasetVersion && r.dataset.version !== datasetVersion) warnings.push('x.import.otherVersion');
  if (!r.complete) warnings.push('x.import.incomplete');
  if (!r.computation.exact) warnings.push('x.import.approximate');
  if (r.methodVersion !== METHOD_VERSION) warnings.push('x.import.method');
  if ((r.dataset.continentRule ?? 'country-first') !== continentRule) {
    warnings.push(usesContinents(r.definition) ? 'x.import.continentRuleRegional' : 'x.import.continentRule');
  }
  return { ok: true, result: r as ExperimentResult, warnings };
}
