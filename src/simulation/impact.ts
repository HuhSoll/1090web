/**
 * Connectivity impact of a scenario: the baseline graph against the simulated graph on the SAME
 * node set (the airports of the baseline network), so removing an airport never shrinks the
 * denominator and never makes the network look more efficient.
 *
 *   Total system impact: every ordered pair of baseline airports (targets included; a closed
 *     airport stays in the node set as an isolated node).
 *   Spillover impact: only pairs of airports that are not a target of the scenario, and not a
 *     suspended airport pair. Before = paths in the baseline graph (they may pass through the
 *     targets); after = paths in the simulated graph. The difference is what the rest of the
 *     network loses because the targets can no longer be passed through.
 *
 * Paths count hops (unweighted). Flights are never used as distances. Exact breadth-first search
 * from every airport; no sampling. Pure functions; run in a Web Worker for real networks.
 */
import { buildGraph, weakComponents, type Graph } from '../research/graph';

export interface ImpactInput {
  /** nodes 0..n-1 = baseline airports */
  n: number;
  directed: boolean;
  before: { src: Int32Array; dst: Int32Array };
  after: { src: Int32Array; dst: Int32Array };
  /** scenario target airports (local indices) */
  targets: Int32Array;
  /** suspended airport pairs (local indices, flattened [a0, b0, a1, b1, ...]; both orders excluded) */
  excludedPairs: Int32Array;
  /** how many lost pairs to list (all are counted) */
  maxLostPairs?: number;
}

export interface ReachStats {
  /** ordered pairs evaluated */
  pairs: number;
  reachable: number;
  /** pairs within 1, 2, 3 hops */
  hop1: number;
  hop2: number;
  hop3: number;
  /** global efficiency: mean of 1/d over the evaluated pairs (0 when unreachable) */
  efficiency: number;
}

export interface ImpactResult {
  n: number;
  directed: boolean;
  edges: { before: number; after: number };
  /** airports with at least one connection */
  connectedNodes: { before: number; after: number };
  components: { before: { count: number; largest: number }; after: { count: number; largest: number } };
  total: { before: ReachStats; after: ReachStats };
  spillover: { nodes: number; before: ReachStats; after: ReachStats };
  /** spillover pairs reachable before: hop count after (lost = no path any more) */
  hopChange: { same: number; plus1: number; plus2: number; plus3more: number; lost: number };
  perNode: {
    degBefore: Int32Array;
    degAfter: Int32Array;
    /** reachable non-target airports (out-direction when directed) */
    reachBefore: Int32Array;
    reachAfter: Int32Array;
    hop2Before: Int32Array;
    hop2After: Int32Array;
    hop3Before: Int32Array;
    hop3After: Int32Array;
    /** partners reachable before and not after */
    lost: Int32Array;
    /** partners still reachable but with more hops */
    longer: Int32Array;
    /** sum of the added hops over `longer` */
    addedHops: Int32Array;
  };
  /** spillover pairs that lost every path (undirected: listed once, i < j) */
  lostPairs: { total: number; list: Int32Array };
  elapsedMs: number;
}

const emptyStats = (): ReachStats => ({ pairs: 0, reachable: 0, hop1: 0, hop2: 0, hop3: 0, efficiency: 0 });

export function graphOf(n: number, e: { src: Int32Array; dst: Int32Array }, directed: boolean): Graph {
  return buildGraph({ n, src: e.src, dst: e.dst, weight: new Float64Array(e.src.length).fill(1), directed });
}

/** Hop distances from s (-1 = unreachable); `skip` nodes are treated as removed. */
export function bfs(g: Graph, s: number, dist: Int32Array, queue: Int32Array, skip?: Uint8Array): void {
  dist.fill(-1);
  if (skip && skip[s]) return;
  dist[s] = 0;
  let head = 0;
  let tail = 0;
  queue[tail++] = s;
  while (head < tail) {
    const v = queue[head++]!;
    const dv = dist[v]! + 1;
    for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
      const w = g.outNbr[p]!;
      if (dist[w] === -1 && !(skip && skip[w])) {
        dist[w] = dv;
        queue[tail++] = w;
      }
    }
  }
}

function components(g: Graph): { count: number; largest: number } {
  const { sizes } = weakComponents(g);
  return { count: sizes.length, largest: sizes.reduce((a, b) => Math.max(a, b), 0) };
}

export function computeImpact(input: ImpactInput, onProgress?: (done: number, total: number) => void): ImpactResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { n, directed } = input;
  const gB = graphOf(n, input.before, directed);
  const gA = graphOf(n, input.after, directed);
  const isTarget = new Uint8Array(n);
  for (const t of input.targets) isTarget[t] = 1;
  const excluded = new Set<number>();
  for (let i = 0; i + 1 < input.excludedPairs.length; i += 2) {
    const a = input.excludedPairs[i]!;
    const b = input.excludedPairs[i + 1]!;
    excluded.add(a * n + b);
    excluded.add(b * n + a);
  }
  const maxLost = input.maxLostPairs ?? 5000;

  const total = { before: emptyStats(), after: emptyStats() };
  const spill = { before: emptyStats(), after: emptyStats() };
  const hopChange = { same: 0, plus1: 0, plus2: 0, plus3more: 0, lost: 0 };
  const per = {
    degBefore: new Int32Array(n), degAfter: new Int32Array(n),
    reachBefore: new Int32Array(n), reachAfter: new Int32Array(n),
    hop2Before: new Int32Array(n), hop2After: new Int32Array(n),
    hop3Before: new Int32Array(n), hop3After: new Int32Array(n),
    lost: new Int32Array(n), longer: new Int32Array(n), addedHops: new Int32Array(n),
  };
  for (let v = 0; v < n; v++) {
    per.degBefore[v] = gB.outStart[v + 1]! - gB.outStart[v]!;
    per.degAfter[v] = gA.outStart[v + 1]! - gA.outStart[v]!;
  }
  const lostList: number[] = [];
  let lostTotal = 0;

  const dB = new Int32Array(n);
  const dA = new Int32Array(n);
  const queue = new Int32Array(n);
  const add = (st: ReachStats, d: number) => {
    st.pairs++;
    if (d > 0) {
      st.reachable++;
      st.efficiency += 1 / d;
      if (d <= 1) st.hop1++;
      if (d <= 2) st.hop2++;
      if (d <= 3) st.hop3++;
    }
  };
  for (let s = 0; s < n; s++) {
    bfs(gB, s, dB, queue);
    bfs(gA, s, dA, queue);
    for (let t = 0; t < n; t++) {
      if (t === s) continue;
      const b = dB[t]!;
      const a = dA[t]!;
      add(total.before, b);
      add(total.after, a);
      // partners counted per airport: non-target airports, suspended pairs left out
      if (isTarget[t] || excluded.has(s * n + t)) continue;
      if (b > 0) {
        per.reachBefore[s]!++;
        if (b <= 2) per.hop2Before[s]!++;
        if (b <= 3) per.hop3Before[s]!++;
      }
      if (a > 0) {
        per.reachAfter[s]!++;
        if (a <= 2) per.hop2After[s]!++;
        if (a <= 3) per.hop3After[s]!++;
      }
      if (b > 0 && a < 0) per.lost[s]!++;
      else if (b > 0 && a > b) {
        per.longer[s]!++;
        per.addedHops[s]! += a - b;
      }
      if (isTarget[s]) continue;
      add(spill.before, b);
      add(spill.after, a);
      if (b > 0) {
        if (a < 0) {
          hopChange.lost++;
          if (directed || s < t) {
            lostTotal++;
            if (lostList.length < maxLost * 2) lostList.push(s, t);
          }
        } else if (a === b) hopChange.same++;
        else if (a === b + 1) hopChange.plus1++;
        else if (a === b + 2) hopChange.plus2++;
        else hopChange.plus3more++;
      }
    }
    if (onProgress && (s % 64 === 63 || s === n - 1)) onProgress(s + 1, n);
  }
  for (const st of [total.before, total.after, spill.before, spill.after]) st.efficiency = st.pairs > 0 ? st.efficiency / st.pairs : 0;
  let spillNodes = 0;
  for (let v = 0; v < n; v++) if (!isTarget[v]) spillNodes++;
  const connected = (g: Graph) => {
    let c = 0;
    for (let v = 0; v < n; v++) if (g.outStart[v + 1]! > g.outStart[v]! || g.inStart[v + 1]! > g.inStart[v]!) c++;
    return c;
  };
  return {
    n, directed,
    edges: { before: gB.edgeCount, after: gA.edgeCount },
    connectedNodes: { before: connected(gB), after: connected(gA) },
    components: { before: components(gB), after: components(gA) },
    total,
    spillover: { nodes: spillNodes, ...spill },
    hopChange,
    perNode: per,
    lostPairs: { total: lostTotal, list: Int32Array.from(lostList) },
    elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
  };
}

export function impactTransferables(r: ImpactResult): ArrayBuffer[] {
  return [...Object.values(r.perNode).map((a) => (a as Int32Array).buffer as ArrayBuffer), r.lostPairs.list.buffer as ArrayBuffer];
}

// ---- alternative paths (one pair, on demand) ------------------------------------------------------

/**
 * Up to k shortest paths from s to t that share no intermediate airport (each found by BFS after
 * removing the intermediate airports of the previous ones). Structural paths in the graph only:
 * they say nothing about schedules, seats or interline agreements.
 */
export function alternativePaths(g: Graph, s: number, t: number, k = 3): number[][] {
  const n = g.n;
  const skip = new Uint8Array(n);
  const dist = new Int32Array(n);
  const prev = new Int32Array(n);
  const queue = new Int32Array(n);
  const out: number[][] = [];
  for (let round = 0; round < k; round++) {
    dist.fill(-1);
    prev.fill(-1);
    dist[s] = 0;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    while (head < tail && dist[t] === -1) {
      const v = queue[head++]!;
      for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
        const w = g.outNbr[p]!;
        if (dist[w] === -1 && !skip[w]) {
          dist[w] = dist[v]! + 1;
          prev[w] = v;
          queue[tail++] = w;
        }
      }
    }
    if (dist[t] === -1) break;
    const path = [t];
    for (let v = prev[t]!; v !== -1; v = prev[v]!) path.push(v);
    path.reverse();
    out.push(path);
    if (path.length <= 2) {
      // a direct connection: alternatives must avoid it, so drop the edge by skipping nothing more
      // (a second direct edge cannot exist); look for paths with an intermediate airport instead
      const g2 = withoutEdge(g, s, t);
      return [path, ...alternativePaths(g2, s, t, k - 1)];
    }
    for (let i = 1; i < path.length - 1; i++) skip[path[i]!] = 1;
  }
  return out;
}

function withoutEdge(g: Graph, s: number, t: number): Graph {
  const src: number[] = [];
  const dst: number[] = [];
  for (let v = 0; v < g.n; v++) {
    for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
      const w = g.outNbr[p]!;
      if ((v === s && w === t) || (!g.directed && v === t && w === s)) continue;
      if (!g.directed && w < v) continue; // undirected arcs appear twice
      src.push(v);
      dst.push(w);
    }
  }
  return graphOf(g.n, { src: Int32Array.from(src), dst: Int32Array.from(dst) }, g.directed);
}

/** Hop distance from s to every node (-1 unreachable). */
export function distancesFrom(g: Graph, s: number): Int32Array {
  const d = new Int32Array(g.n);
  bfs(g, s, d, new Int32Array(g.n));
  return d;
}
