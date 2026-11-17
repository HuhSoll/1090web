/**
 * Airport criticality (Phase 9E): the impact of stopping ONE airport, for many candidate airports
 * on the same baseline graph. The definitions are those of Phase 9C (simulation/impact.ts):
 *
 *   Systemic   node set V fixed (n airports); the stopped airport stays as an isolated node;
 *              efficiency over the n(n-1) ordered pairs before and after.
 *   Spillover  node set V \ {v}; before = paths in the full graph (they may pass through v),
 *              after = paths without v; (n-1)(n-2) ordered pairs before and after.
 *
 * Efficiency = mean of 1/d over ordered pairs (unweighted hops; 1/d = 0 when unreachable).
 *
 * Exact when every airport is a source. With a sample of sources S (same S for every candidate,
 * so candidates are compared on the same pairs) every quantity is estimated from the BFS of the
 * sources in S: an unbiased estimate of the efficiencies; pair counts are scaled to all sources.
 * The same algorithm is implemented in pipeline/experiments/impact.py (cross-checked in tests).
 */
import type { Graph } from '../research/graph';
import { bfs, graphOf } from '../simulation/impact';

export interface CriticalityInput {
  n: number;
  directed: boolean;
  src: Int32Array;
  dst: Int32Array;
  /** flights per arc (for the flights lost); optional */
  weight?: Float64Array;
  /** local indices of the airports to stop, one at a time */
  candidates: Int32Array;
  /** BFS sources; null = every airport (exact) */
  sources: Int32Array | null;
}

export interface CriticalityResult {
  n: number;
  directed: boolean;
  exact: boolean;
  sources: number;
  edges: number;
  before: { efficiency: number; reachable: number; hop1: number; hop2: number; hop3: number };
  /** per candidate (same order as input.candidates) */
  systemicDrop: Float64Array;
  spilloverDrop: Float64Array;
  spilloverBefore: Float64Array;
  /** spillover pairs that lose every path (estimated when sampled) */
  unreachablePairs: Float64Array;
  /** drop of the share of spillover pairs within 1 / 2 / 3 hops */
  hop1Drop: Float64Array;
  hop2Drop: Float64Array;
  hop3Drop: Float64Array;
  /** distinct airports directly connected to the candidate (in or out) */
  directLost: Int32Array;
  /** flights on the candidate's arcs */
  flightsLost: Float64Array;
  elapsedMs: number;
}

/** Sources: every airport (exact) or k airports drawn without replacement with a seeded generator. */
export function sampleSources(n: number, k: number | null, seed: number): Int32Array | null {
  if (k === null || k >= n) return null;
  let a = seed >>> 0 || 1;
  const rnd = () => {
    // mulberry32 (the generator of research/graph.ts sampleSources)
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const x = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = x;
  }
  return Int32Array.from(idx.subarray(0, k)).sort();
}

export function evaluateCriticality(inp: CriticalityInput, onProgress?: (done: number, total: number) => void, cancelled?: () => boolean): CriticalityResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { n, directed } = inp;
  const g = graphOf(n, { src: inp.src, dst: inp.dst }, directed);
  const sources = inp.sources ?? Int32Array.from({ length: n }, (_, i) => i);
  const k = sources.length;
  const inS = new Uint8Array(n);
  for (const s of sources) inS[s] = 1;
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);

  // before: per-source row sums, and per-node column sums over the sources (to leave v out later)
  const row = { inv: new Float64Array(n), reach: new Float64Array(n), h1: new Float64Array(n), h2: new Float64Array(n), h3: new Float64Array(n) };
  const col = { inv: new Float64Array(n), reach: new Float64Array(n), h1: new Float64Array(n), h2: new Float64Array(n), h3: new Float64Array(n) };
  for (const s of sources) {
    bfs(g, s, dist, queue);
    for (let t = 0; t < n; t++) {
      const d = dist[t]!;
      if (t === s || d <= 0) continue;
      const inv = 1 / d;
      row.inv[s]! += inv;
      row.reach[s]!++;
      col.inv[t]! += inv;
      col.reach[t]!++;
      if (d <= 1) { row.h1[s]!++; col.h1[t]!++; }
      if (d <= 2) { row.h2[s]!++; col.h2[t]!++; }
      if (d <= 3) { row.h3[s]!++; col.h3[t]!++; }
    }
  }
  const sum = (a: Float64Array) => sources.reduce((acc, s) => acc + a[s]!, 0);
  const tot = { inv: sum(row.inv), reach: sum(row.reach), h1: sum(row.h1), h2: sum(row.h2), h3: sum(row.h3) };
  const pairsAll = k * (n - 1);

  const C = inp.candidates.length;
  const res: CriticalityResult = {
    n, directed, exact: k === n, sources: k, edges: g.edgeCount,
    before: { efficiency: pairsAll ? tot.inv / pairsAll : 0, reachable: tot.reach, hop1: tot.h1, hop2: tot.h2, hop3: tot.h3 },
    systemicDrop: new Float64Array(C), spilloverDrop: new Float64Array(C), spilloverBefore: new Float64Array(C),
    unreachablePairs: new Float64Array(C), hop1Drop: new Float64Array(C), hop2Drop: new Float64Array(C), hop3Drop: new Float64Array(C),
    directLost: new Int32Array(C), flightsLost: new Float64Array(C), elapsedMs: 0,
  };
  const skip = new Uint8Array(n);
  const weightOf = arcWeights(g, inp);
  for (let ci = 0; ci < C; ci++) {
    if (cancelled?.()) break;
    const v = inp.candidates[ci]!;
    skip[v] = 1;
    let inv = 0;
    let reach = 0;
    let h1 = 0;
    let h2 = 0;
    let h3 = 0;
    for (const s of sources) {
      if (s === v) continue;
      bfs(g, s, dist, queue, skip);
      for (let t = 0; t < n; t++) {
        const d = dist[t]!;
        if (t === s || d <= 0) continue;
        inv += 1 / d;
        reach++;
        if (d <= 1) h1++;
        if (d <= 2) h2++;
        if (d <= 3) h3++;
      }
    }
    skip[v] = 0;
    // spillover before: the sources other than v, the targets other than v
    const kv = k - (inS[v] ? 1 : 0);
    const spillPairs = kv * (n - 2);
    const sb = {
      inv: tot.inv - (inS[v] ? row.inv[v]! : 0) - col.inv[v]!,
      reach: tot.reach - (inS[v] ? row.reach[v]! : 0) - col.reach[v]!,
      h1: tot.h1 - (inS[v] ? row.h1[v]! : 0) - col.h1[v]!,
      h2: tot.h2 - (inS[v] ? row.h2[v]! : 0) - col.h2[v]!,
      h3: tot.h3 - (inS[v] ? row.h3[v]! : 0) - col.h3[v]!,
    };
    res.systemicDrop[ci] = pairsAll ? (tot.inv - inv) / pairsAll : 0;
    res.spilloverBefore[ci] = spillPairs ? sb.inv / spillPairs : 0;
    res.spilloverDrop[ci] = spillPairs ? (sb.inv - inv) / spillPairs : 0;
    // pair counts scaled from the sampled sources to all n-1 non-stopped sources
    res.unreachablePairs[ci] = kv ? ((sb.reach - reach) * (n - 1)) / kv : 0;
    res.hop1Drop[ci] = spillPairs ? (sb.h1 - h1) / spillPairs : 0;
    res.hop2Drop[ci] = spillPairs ? (sb.h2 - h2) / spillPairs : 0;
    res.hop3Drop[ci] = spillPairs ? (sb.h3 - h3) / spillPairs : 0;
    const partners = new Set<number>();
    let flights = 0;
    for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
      partners.add(g.outNbr[p]!);
      flights += weightOf.out[p]!;
    }
    if (directed) {
      for (let p = g.inStart[v]!; p < g.inStart[v + 1]!; p++) {
        partners.add(g.inNbr[p]!);
        flights += weightOf.in[p]!;
      }
    }
    res.directLost[ci] = partners.size;
    res.flightsLost[ci] = flights;
    if (onProgress && (ci % 4 === 3 || ci === C - 1)) onProgress(ci + 1, C);
  }
  res.elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  return res;
}

/** Flights per CSR arc (out / in), from the optional input weights. */
function arcWeights(g: Graph, inp: CriticalityInput): { out: Float64Array; in: Float64Array } {
  if (!inp.weight) return { out: new Float64Array(g.outNbr.length), in: new Float64Array(g.inNbr.length) };
  const wg = (() => {
    // rebuild with the real weights (graphOf uses unit weights for distances)
    const n = inp.n;
    const merged = new Map<number, number>();
    for (let i = 0; i < inp.src.length; i++) {
      let a = inp.src[i]!;
      let b = inp.dst[i]!;
      if (a === b) continue;
      if (!inp.directed && a > b) [a, b] = [b, a];
      merged.set(a * n + b, (merged.get(a * n + b) ?? 0) + inp.weight![i]!);
    }
    return merged;
  })();
  const lookup = (a: number, b: number) => wg.get((inp.directed || a < b ? a : b) * inp.n + (inp.directed || a < b ? b : a)) ?? 0;
  const out = new Float64Array(g.outNbr.length);
  const inn = new Float64Array(g.inNbr.length);
  for (let v = 0; v < inp.n; v++) {
    for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) out[p] = lookup(v, g.outNbr[p]!);
    for (let p = g.inStart[v]!; p < g.inStart[v + 1]!; p++) inn[p] = lookup(g.inNbr[p]!, v);
  }
  return { out, in: inn };
}

/** Rounded so that tiny float differences (summation order) do not split ties. */
export const rankValue = (x: number) => Math.round(x * 1e12) / 1e12;
