/**
 * Experiment engine (Phase 9E, browser). For each run of a definition: the network of that run
 * (a sensitivity condition, or a missingness trial on the reference node set), then the impact of
 * stopping each candidate (criticality.ts, in a Web Worker), then summarize.ts.
 *
 * - Sensitivity: each condition has its own node set; candidates absent from it get impact 0.
 * - Missingness: every trial uses the node set of the reference network (fixed denominators, an
 *   airport that loses all its routes stays as an isolated node). Within one trial, the same
 *   thinned network is used for every candidate.
 * - The same BFS sources (sourceSeed) are used for every candidate of a run.
 */
import type { StaticNetwork } from '../data/model/network';
import type { ResearchMonth } from '../research/data';
import type { ResearchConfig } from '../research/model';
import { buildResearchNetwork, type ResearchNetwork, type ScopeContext } from '../research/network';
import { bfs, graphOf } from '../simulation/impact';
import { evaluateCriticality, sampleSources, type CriticalityInput, type CriticalityResult } from './criticality';
import { applyMissingness } from './missingness';
import { definitionHash, estimateCost, METRICS, runsOf, type Condition, type CostEstimate, type ExperimentDefinition, type ExperimentResult, type Metric, type PlannedRun } from './model';
import { summarize, type AirportMeta, type RawRun } from './summarize';

// ---- worker client ----------------------------------------------------------------------------------

export class CancelledRun extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledRun';
  }
}

export class ExperimentClient {
  private worker: Worker | null = null;
  private pending: { id: number; resolve: (r: CriticalityResult) => void; reject: (e: Error) => void; onProgress?: (d: number, t: number) => void } | null = null;
  private nextId = 1;

  run(input: CriticalityInput, onProgress?: (done: number, total: number) => void): Promise<CriticalityResult> {
    if (typeof Worker === 'undefined') return Promise.resolve(evaluateCriticality(input, onProgress));
    if (!this.worker) {
      this.worker = new Worker(new URL('./experiments.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; type: string; done?: number; total?: number; result?: CriticalityResult; message?: string }>) => {
        const p = this.pending;
        if (!p || p.id !== e.data.id) return;
        if (e.data.type === 'progress') p.onProgress?.(e.data.done!, e.data.total!);
        else {
          this.pending = null;
          if (e.data.type === 'done') p.resolve(e.data.result!);
          else p.reject(new Error(e.data.message ?? 'worker error'));
        }
      };
      this.worker.onerror = (e) => {
        const p = this.pending;
        this.pending = null;
        this.worker = null;
        p?.reject(new Error(e.message || 'worker error'));
      };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress };
      this.worker!.postMessage({ id, input });
    });
  }

  /** Stops the running computation (the worker is terminated: a busy worker cannot be interrupted otherwise). */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const p = this.pending;
    this.pending = null;
    p?.reject(new CancelledRun());
  }

  dispose(): void {
    this.cancel();
  }
}

// ---- planning -----------------------------------------------------------------------------------------

export interface ExperimentDeps {
  network: StaticNetwork;
  scope: ScopeContext;
  /** the baseline rows (month or window of the baseline config, scenario applied) */
  month: ResearchMonth;
  datasetId: string;
  datasetVersion: string | null;
  /** how continents were assigned (quality.json continentRule) */
  continentRule?: string;
}

export interface ExperimentPlan {
  hash: string;
  reference: ResearchNetwork;
  /** global airport indices, ascending */
  candidates: number[];
  runs: PlannedRun[];
  bfsMs: number;
  cost: CostEstimate;
}

/** The Research Mode config of a run: the baseline with the condition's fields. */
export function runConfig(d: ExperimentDefinition, c: Condition | null): ResearchConfig {
  const base = d.baseline.research!;
  const b = d.baseline;
  const x = { ...b, ...(c ?? {}) };
  return {
    ...base,
    tiers: x.tiers ?? base.tiers,
    minFlights: x.minFlights ?? base.minFlights,
    directed: x.directed ?? true,
    classes: x.classes ?? base.classes,
    region: x.region !== undefined ? x.region : base.region,
  };
}

/** Distinct partners per airport (both directions). */
function degrees(net: ResearchNetwork): Map<number, number> {
  const deg = new Map<number, number>();
  for (const r of net.routes) {
    deg.set(r.a, (deg.get(r.a) ?? 0) + 1);
    deg.set(r.b, (deg.get(r.b) ?? 0) + 1);
  }
  return deg;
}

export function chooseCandidates(d: ExperimentDefinition, ref: ResearchNetwork, network: StaticNetwork): number[] {
  const base = baseCandidates(d, ref, network);
  if (!d.include?.length) return base;
  const inRef = new Set(ref.airports);
  const extra = d.include.map((id) => network.airportIndexById.get(id)).filter((i): i is number => i !== undefined && inRef.has(i));
  return [...new Set([...base, ...extra])].sort((x, y) => x - y);
}

function baseCandidates(d: ExperimentDefinition, ref: ResearchNetwork, network: StaticNetwork): number[] {
  if (d.candidates === 'all') return [...ref.airports];
  if (Array.isArray(d.candidates)) {
    const inRef = new Set(ref.airports);
    return d.candidates.map((id) => network.airportIndexById.get(id)).filter((i): i is number => i !== undefined && inRef.has(i)).sort((x, y) => x - y);
  }
  const deg = degrees(ref);
  return [...deg.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, d.candidates.top).map(([a]) => a).sort((x, y) => x - y);
}

/** Edge arrays of a network on a given node list (nodes not in the list are dropped). */
export function edgesOn(net: ResearchNetwork, nodes: readonly number[], directed: boolean) {
  const node = new Map(nodes.map((a, i) => [a, i]));
  const src: number[] = [];
  const dst: number[] = [];
  const w: number[] = [];
  for (const r of net.routes) {
    const a = node.get(r.a);
    const b = node.get(r.b);
    if (a === undefined || b === undefined) continue;
    if (directed) {
      if (r.ab > 0) { src.push(a); dst.push(b); w.push(r.ab); }
      if (r.ba > 0) { src.push(b); dst.push(a); w.push(r.ba); }
    } else {
      src.push(a); dst.push(b); w.push(r.ab + r.ba);
    }
  }
  return { n: nodes.length, src: Int32Array.from(src), dst: Int32Array.from(dst), weight: Float64Array.from(w) };
}

/** Milliseconds per BFS on the reference graph (a few BFS, for the cost estimate). */
function measureBfs(n: number, e: { src: Int32Array; dst: Int32Array }, directed: boolean): number {
  if (n < 2) return 0;
  const g = graphOf(n, e, directed);
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  const reps = Math.min(8, n);
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) bfs(g, Math.floor((i * n) / reps), dist, queue);
  // the per-target accumulation roughly doubles the bare BFS time
  return ((performance.now() - t0) / reps) * 2;
}

export function planExperiment(d: ExperimentDefinition, deps: ExperimentDeps): ExperimentPlan {
  const runs = runsOf(d);
  const refConfig = runConfig(d, runs[0]?.condition ?? null);
  const reference = buildResearchNetwork(deps.scope, deps.month, refConfig);
  const candidates = chooseCandidates(d, reference, deps.network);
  const e = edgesOn(reference, reference.airports, refConfig.directed);
  const bfsMs = measureBfs(e.n, e, refConfig.directed);
  const k = d.computation.sources === null ? reference.airports.length : Math.min(d.computation.sources, reference.airports.length);
  return { hash: definitionHash(d), reference, candidates, runs, bfsMs, cost: estimateCost(runs.length, candidates.length, k, bfsMs) };
}

// ---- running ---------------------------------------------------------------------------------------------

export interface RunProgress {
  run: number;
  runs: number;
  label: string;
  done: number;
  total: number;
  elapsedMs: number;
}

/**
 * Runs every run of the plan. When cancelled, the finished runs are summarised and the result is
 * marked incomplete (complete: false).
 */
export async function runExperiment(
  d: ExperimentDefinition,
  plan: ExperimentPlan,
  deps: ExperimentDeps,
  client: ExperimentClient,
  onProgress: (p: RunProgress) => void,
  meta: (id: string) => AirportMeta,
): Promise<ExperimentResult> {
  const t0 = performance.now();
  const ids = deps.network.airports.map((a) => a.id);
  const raw: RawRun[] = [];
  const refNodes = plan.reference.airports;
  const routeFlights = new Map(plan.reference.routes.map((r) => [r.routeId, r.ab + r.ba]));
  let complete = true;
  for (let ri = 0; ri < plan.runs.length; ri++) {
    const r = plan.runs[ri]!;
    const tRun = performance.now();
    const config = runConfig(d, r.condition);
    let month = deps.month;
    if (d.experimentType === 'missingness' && d.missingness) {
      month = applyMissingness(deps.month, d.missingness, d.randomSeed, r.trial, {
        ends: (rid) => [deps.network.routes[rid]!.a, deps.network.routes[rid]!.b],
        continentOf: deps.scope.continentOf,
        routeFlights,
      });
    }
    const net = ri === 0 ? plan.reference : buildResearchNetwork(deps.scope, month, config);
    const nodes = d.experimentType === 'missingness' ? refNodes : net.airports;
    const e = edgesOn(net, nodes, config.directed);
    const local = new Map(nodes.map((a, i) => [a, i]));
    const present = plan.candidates.filter((a) => local.has(a));
    const sources = sampleSources(e.n, d.computation.sources, d.computation.sourceSeed);
    let res: CriticalityResult;
    try {
      res = await client.run(
        { ...e, directed: config.directed, candidates: Int32Array.from(present.map((a) => local.get(a)!)), sources },
        (done, total) => onProgress({ run: ri + 1, runs: plan.runs.length, label: r.label, done, total, elapsedMs: performance.now() - t0 }),
      );
    } catch (err) {
      if (err instanceof CancelledRun) {
        complete = false;
        break;
      }
      throw err;
    }
    const touched = new Uint8Array(e.n);
    for (let i = 0; i < e.src.length; i++) {
      touched[e.src[i]!] = 1;
      touched[e.dst[i]!] = 1;
    }
    raw.push({
      runId: r.runId, label: r.label, kind: r.kind, trial: r.trial,
      conditions: { ...configSummary(config), ...(r.condition ? { id: r.condition.id } : {}) },
      nodes: e.n, arcs: e.src.length, flights: net.flights, pairs: net.routes.length,
      exact: res.exact, sources: res.sources, sourceSeed: d.computation.sourceSeed, randomSeed: d.randomSeed,
      complete: true, errors: [], seconds: Math.round((performance.now() - tRun) / 100) / 10,
      isolated: present.filter((a) => !touched[local.get(a)!]).map((a) => ids[a]!),
      candidates: present.map((a) => ids[a]!),
      values: Object.fromEntries(METRICS.map((k) => [k, res[k]])) as unknown as Record<Metric, ArrayLike<number>>,
    });
  }
  if (!raw.length) throw new CancelledRun();
  return summarize(d, plan.hash, { id: deps.datasetId, version: deps.datasetVersion, continentRule: deps.continentRule ?? 'country-first' }, raw, plan.candidates.map((a) => ids[a]!), meta,
    complete && raw.length === plan.runs.length);
}

function configSummary(c: ResearchConfig) {
  return { month: c.month, window: c.window ? { startMs: c.window.startMs, endMs: c.window.endMs, basis: c.window.basis } : null, tiers: c.tiers, minFlights: c.minFlights,
    directed: c.directed, classes: c.classes, region: c.region, country: c.country, carrier: c.carrier, scenario: c.scenario?.name ?? null };
}
