/**
 * Graph metrics for one analysed network (runs inside the Web Worker; also callable directly in
 * tests). The method used for path-based measures is recorded with the result.
 */
import { buildGraph, clustering, degrees, density, pageRank, pathMeasures, sampleSources, strongComponents, weakComponents, type EdgeInput } from './graph';
import type { PathMethod } from './model';

/** Exact betweenness when n * (n + m) stays below this (about a few seconds in a worker). */
export const EXACT_WORK_LIMIT = 6e8;
export const PAGERANK_ALPHA = 0.85;
export const PAGERANK_TOL = 1e-10;

export interface MetricsOptions {
  pathMethod: PathMethod;
  samples: number;
  seed: number;
}

export interface PathMethodInfo {
  exact: boolean;
  algorithm: string;
  sources: number;
  seed: number | null;
  normalisation: string;
  lengths: string;
}

export interface MetricsResult {
  n: number;
  edgeCount: number;
  directed: boolean;
  degree: Float64Array;
  inDegree: Float64Array;
  outDegree: Float64Array;
  strength: Float64Array;
  inStrength: Float64Array;
  outStrength: Float64Array;
  degreeCentrality: Float64Array;
  betweenness: Float64Array;
  betweennessRaw: Float64Array;
  harmonic: Float64Array;
  harmonicNormalized: Float64Array;
  pagerank: Float64Array;
  clustering: Float64Array;
  summary: {
    density: number;
    components: number;
    largestComponent: number;
    strongComponents: number | null;
    largestStrongComponent: number | null;
    averageClustering: number;
    transitivity: number;
    triangles: number;
    pagerankIterations: number;
    pagerankConverged: boolean;
    path: PathMethodInfo;
    elapsedMs: number;
  };
}

export function choosePathMethod(method: PathMethod, n: number, m: number): 'exact' | 'sampled' {
  if (method !== 'auto') return method;
  return n * (n + m) <= EXACT_WORK_LIMIT ? 'exact' : 'sampled';
}

export function computeMetrics(input: EdgeInput, opts: MetricsOptions, onProgress?: (done: number, total: number) => void): MetricsResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const g = buildGraph(input);
  const d = degrees(g);
  const method = choosePathMethod(opts.pathMethod, g.n, g.edgeCount);
  const sources = method === 'exact' ? null : sampleSources(g.n, opts.samples, opts.seed);
  const paths = pathMeasures(g, { sources, onProgress });
  const pr = pageRank(g, PAGERANK_ALPHA, PAGERANK_TOL);
  const weak = weakComponents(g);
  const strong = g.directed ? strongComponents(g) : null;
  const cl = clustering(g);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    n: g.n,
    edgeCount: g.edgeCount,
    directed: g.directed,
    ...d,
    betweenness: paths.betweenness,
    betweennessRaw: paths.betweennessRaw,
    harmonic: paths.harmonic,
    harmonicNormalized: paths.harmonicNormalized,
    pagerank: pr.rank,
    clustering: cl.local,
    summary: {
      density: density(g),
      components: weak.sizes.length,
      largestComponent: weak.sizes[0] ?? 0,
      strongComponents: strong ? strong.length : null,
      largestStrongComponent: strong ? strong[0] ?? 0 : null,
      averageClustering: cl.average,
      transitivity: cl.transitivity,
      triangles: cl.triangles,
      pagerankIterations: pr.iterations,
      pagerankConverged: pr.converged,
      path: {
        exact: paths.exact,
        algorithm: paths.exact ? 'Brandes (2001), breadth-first search from every node' : 'Brandes & Pich (2007) pivot sampling, uniform sources without replacement',
        sources: paths.sourcesUsed,
        seed: paths.exact ? null : opts.seed,
        normalisation: 'betweenness / ((n-1)(n-2)) for ordered pairs (directed), / ((n-1)(n-2)/2) for unordered pairs (undirected); harmonic / (n-1)',
        lengths: 'hop count (each route = 1); flights are not used as lengths',
      },
      elapsedMs: Math.round(t1 - t0),
    },
  };
}

/** Typed arrays of a result, for postMessage transfer. */
export function transferables(r: MetricsResult): ArrayBuffer[] {
  return [r.degree, r.inDegree, r.outDegree, r.strength, r.inStrength, r.outStrength, r.degreeCentrality, r.betweenness,
    r.betweennessRaw, r.harmonic, r.harmonicNormalized, r.pagerank, r.clustering].map((a) => a.buffer as ArrayBuffer);
}
