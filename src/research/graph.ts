/**
 * Network metrics on the observed airport network (Research Mode). Pure functions on compact
 * arrays so they run in a Web Worker and can be checked by hand on tiny graphs
 * (tests/research/graph.test.ts). Definitions follow NetworkX unless stated otherwise; see
 * docs/research-methodology.md.
 *
 * The graph: nodes 0..n-1, edges (src, dst, weight). Weights are observed monthly flights.
 * Self-loops are dropped and duplicate edges are merged (weights summed) when the graph is built.
 * Shortest paths count hops: weights are NOT used as lengths.
 */

export interface EdgeInput {
  n: number;
  src: Int32Array;
  dst: Int32Array;
  weight: Float64Array;
  directed: boolean;
}

/** Compressed sparse rows. For undirected graphs every edge appears in both directions. */
export interface Graph {
  n: number;
  directed: boolean;
  /** Distinct edges (an undirected edge counts once). */
  edgeCount: number;
  outStart: Int32Array;
  outNbr: Int32Array;
  outW: Float64Array;
  inStart: Int32Array;
  inNbr: Int32Array;
  inW: Float64Array;
}

export function buildGraph(input: EdgeInput): Graph {
  const { n, directed } = input;
  // merge duplicates and drop self-loops
  const merged = new Map<number, number>();
  for (let i = 0; i < input.src.length; i++) {
    let a = input.src[i]!;
    let b = input.dst[i]!;
    if (a === b) continue;
    if (!directed && a > b) [a, b] = [b, a];
    const key = a * n + b;
    merged.set(key, (merged.get(key) ?? 0) + input.weight[i]!);
  }
  const keys = [...merged.keys()].sort((x, y) => x - y);
  const arcs: [number, number, number][] = [];
  for (const k of keys) {
    const a = Math.floor(k / n);
    const b = k % n;
    const w = merged.get(k)!;
    arcs.push([a, b, w]);
    if (!directed) arcs.push([b, a, w]);
  }
  const csr = (by: 0 | 1) => {
    const start = new Int32Array(n + 1);
    for (const arc of arcs) start[arc[by] + 1]!++;
    for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
    const nbr = new Int32Array(arcs.length);
    const w = new Float64Array(arcs.length);
    const pos = start.slice(0, n);
    // stable: arcs are sorted by (a, b) so neighbour lists come out sorted
    const order = by === 0 ? arcs : [...arcs].sort((x, y) => x[1] - y[1] || x[0] - y[0]);
    for (const arc of order) {
      const from = arc[by];
      const to = arc[by === 0 ? 1 : 0];
      const p = pos[from]!++;
      nbr[p] = to;
      w[p] = arc[2];
    }
    return { start, nbr, w };
  };
  const out = csr(0);
  const inn = directed ? csr(1) : out;
  return {
    n,
    directed,
    edgeCount: keys.length,
    outStart: out.start,
    outNbr: out.nbr,
    outW: out.w,
    inStart: inn.start,
    inNbr: inn.nbr,
    inW: inn.w,
  };
}

// ---- degree and strength ------------------------------------------------------------------------

export interface DegreeResult {
  /** distinct neighbours in either direction */
  degree: Float64Array;
  inDegree: Float64Array;
  outDegree: Float64Array;
  /** flights touching the node (in + out for directed graphs) */
  strength: Float64Array;
  inStrength: Float64Array;
  outStrength: Float64Array;
  /** NetworkX degree_centrality: (in + out degree) / (n - 1); undirected: degree / (n - 1) */
  degreeCentrality: Float64Array;
}

export function degrees(g: Graph): DegreeResult {
  const { n } = g;
  const inDegree = new Float64Array(n);
  const outDegree = new Float64Array(n);
  const inStrength = new Float64Array(n);
  const outStrength = new Float64Array(n);
  const degree = new Float64Array(n);
  const strength = new Float64Array(n);
  const degreeCentrality = new Float64Array(n);
  const mark = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    outDegree[v] = g.outStart[v + 1]! - g.outStart[v]!;
    inDegree[v] = g.inStart[v + 1]! - g.inStart[v]!;
    for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) outStrength[v]! += g.outW[p]!;
    for (let p = g.inStart[v]!; p < g.inStart[v + 1]!; p++) inStrength[v]! += g.inW[p]!;
    if (g.directed) {
      let d = 0;
      for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
        mark[g.outNbr[p]!] = v;
        d++;
      }
      for (let p = g.inStart[v]!; p < g.inStart[v + 1]!; p++) if (mark[g.inNbr[p]!] !== v) d++;
      degree[v] = d;
      strength[v] = inStrength[v]! + outStrength[v]!;
      degreeCentrality[v] = n > 1 ? (inDegree[v]! + outDegree[v]!) / (n - 1) : 0;
    } else {
      degree[v] = outDegree[v]!;
      strength[v] = outStrength[v]!;
      degreeCentrality[v] = n > 1 ? degree[v]! / (n - 1) : 0;
    }
  }
  return { degree, inDegree, outDegree, strength, inStrength, outStrength, degreeCentrality };
}

export function density(g: Graph): number {
  const { n } = g;
  if (n < 2) return 0;
  return g.directed ? g.edgeCount / (n * (n - 1)) : (2 * g.edgeCount) / (n * (n - 1));
}

// ---- shortest-path measures --------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so sampled results can be reproduced from the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct nodes chosen uniformly (partial Fisher-Yates with the seeded PRNG), sorted. */
export function sampleSources(n: number, k: number, seed: number): Int32Array {
  const idx = Int32Array.from({ length: n }, (_, i) => i);
  const rnd = mulberry32(seed);
  const m = Math.min(k, n);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const t = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = t;
  }
  return idx.slice(0, m).sort();
}

export interface PathOptions {
  /** null = every node is a source (exact); otherwise the sampled sources */
  sources: Int32Array | null;
  onProgress?: (done: number, total: number) => void;
}

export interface PathResult {
  /** NetworkX convention: undirected pairs counted once, directed ordered pairs */
  betweennessRaw: Float64Array;
  /** divided by (n-1)(n-2) (directed) or (n-1)(n-2)/2 (undirected) */
  betweenness: Float64Array;
  /** sum over u != v of 1 / d(u, v) (distance from u TO v; 0 when unreachable) */
  harmonic: Float64Array;
  /** harmonic / (n - 1) */
  harmonicNormalized: Float64Array;
  exact: boolean;
  sourcesUsed: number;
}

/**
 * Brandes' algorithm (hop counts, unweighted) for betweenness, with harmonic closeness from the
 * same breadth-first searches. With sampled sources the values are estimates: betweenness is
 * scaled by n / k (Brandes & Pich 2007); harmonic closeness of v by (n - 1) / (sources other than v).
 */
export function pathMeasures(g: Graph, opts: PathOptions): PathResult {
  const { n } = g;
  const bc = new Float64Array(n);
  const h = new Float64Array(n);
  const hitBy = new Float64Array(n); // number of sources other than v (for the harmonic scaling)
  const dist = new Int32Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const order = new Int32Array(n);
  const sources = opts.sources ?? Int32Array.from({ length: n }, (_, i) => i);
  const total = sources.length;
  for (let si = 0; si < total; si++) {
    const s = sources[si]!;
    dist.fill(-1);
    sigma.fill(0);
    delta.fill(0);
    dist[s] = 0;
    sigma[s] = 1;
    let head = 0;
    let tail = 0;
    order[tail++] = s;
    while (head < tail) {
      const v = order[head++]!;
      const dv = dist[v]!;
      for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) {
        const w = g.outNbr[p]!;
        if (dist[w]! < 0) {
          dist[w] = dv + 1;
          order[tail++] = w;
        }
        if (dist[w] === dv + 1) sigma[w]! += sigma[v]!;
      }
    }
    for (let i = tail - 1; i > 0; i--) {
      const w = order[i]!;
      const dw = dist[w]!;
      h[w]! += 1 / dw;
      const coeff = (1 + delta[w]!) / sigma[w]!;
      for (let p = g.inStart[w]!; p < g.inStart[w + 1]!; p++) {
        const v = g.inNbr[p]!;
        if (dist[v] === dw - 1) delta[v]! += sigma[v]! * coeff;
      }
      bc[w]! += delta[w]!;
    }
    for (let v = 0; v < n; v++) if (v !== s) hitBy[v]!++;
    if (opts.onProgress && (si % 32 === 31 || si === total - 1)) opts.onProgress(si + 1, total);
  }
  const exact = opts.sources === null || total === n;
  const betweennessRaw = new Float64Array(n);
  const betweenness = new Float64Array(n);
  const harmonic = new Float64Array(n);
  const harmonicNormalized = new Float64Array(n);
  const scale = exact ? 1 : n / total;
  const norm = n > 2 ? 1 / ((n - 1) * (n - 2)) : 0;
  for (let v = 0; v < n; v++) {
    // undirected: each pair was counted from both ends
    const raw = (bc[v]! * scale) / (g.directed ? 1 : 2);
    betweennessRaw[v] = raw;
    betweenness[v] = raw * norm * (g.directed ? 1 : 2);
    const hv = exact ? h[v]! : hitBy[v]! > 0 ? (h[v]! * (n - 1)) / hitBy[v]! : 0;
    harmonic[v] = hv;
    harmonicNormalized[v] = n > 1 ? hv / (n - 1) : 0;
  }
  return { betweennessRaw, betweenness, harmonic, harmonicNormalized, exact, sourcesUsed: total };
}

// ---- PageRank -------------------------------------------------------------------------------------

export interface PageRankResult {
  rank: Float64Array;
  iterations: number;
  converged: boolean;
}

/**
 * Weighted PageRank (NetworkX `pagerank(G, alpha, weight='weight')`): transition probabilities
 * proportional to observed flights, dangling nodes jump uniformly, uniform teleport.
 * Stops when the L1 change is below tol.
 */
export function pageRank(g: Graph, alpha = 0.85, tol = 1e-10, maxIter = 1000): PageRankResult {
  const { n } = g;
  if (n === 0) return { rank: new Float64Array(0), iterations: 0, converged: true };
  const outSum = new Float64Array(n);
  for (let v = 0; v < n; v++) for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) outSum[v]! += g.outW[p]!;
  let x = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let it = 1; it <= maxIter; it++) {
    let dangling = 0;
    for (let v = 0; v < n; v++) if (outSum[v] === 0) dangling += x[v]!;
    const base = (1 - alpha) / n + (alpha * dangling) / n;
    next.fill(base);
    for (let v = 0; v < n; v++) {
      if (outSum[v] === 0) continue;
      const share = (alpha * x[v]!) / outSum[v]!;
      for (let p = g.outStart[v]!; p < g.outStart[v + 1]!; p++) next[g.outNbr[p]!]! += share * g.outW[p]!;
    }
    let err = 0;
    for (let v = 0; v < n; v++) err += Math.abs(next[v]! - x[v]!);
    [x, next] = [next, x];
    if (err < tol) return { rank: x, iterations: it, converged: true };
  }
  return { rank: x, iterations: maxIter, converged: false };
}

// ---- components -----------------------------------------------------------------------------------

/** Weakly connected components (connected components for undirected graphs). Sizes, largest first. */
export function weakComponents(g: Graph): { label: Int32Array; sizes: number[] } {
  const { n } = g;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1) continue;
    const c = sizes.length;
    let top = 0;
    stack[top++] = s;
    label[s] = c;
    let size = 0;
    while (top > 0) {
      const v = stack[--top]!;
      size++;
      for (const [start, nbr] of [[g.outStart, g.outNbr], [g.inStart, g.inNbr]] as const) {
        for (let p = start[v]!; p < start[v + 1]!; p++) {
          const w = nbr[p]!;
          if (label[w] === -1) {
            label[w] = c;
            stack[top++] = w;
          }
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes: [...sizes].sort((a, b) => b - a) };
}

/** Strongly connected components (iterative Tarjan). Sizes, largest first. */
export function strongComponents(g: Graph): number[] {
  const { n } = g;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const sizes: number[] = [];
  const iter = new Int32Array(n);
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const call: number[] = [s];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    iter[s] = g.outStart[s]!;
    while (call.length > 0) {
      const v = call[call.length - 1]!;
      if (iter[v]! < g.outStart[v + 1]!) {
        const w = g.outNbr[iter[v]!]!;
        iter[v]!++;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          iter[w] = g.outStart[w]!;
          call.push(w);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
      } else {
        call.pop();
        if (call.length > 0) {
          const parent = call[call.length - 1]!;
          low[parent] = Math.min(low[parent]!, low[v]!);
        }
        if (low[v] === index[v]) {
          let size = 0;
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            size++;
          } while (w !== v);
          sizes.push(size);
        }
      }
    }
  }
  return sizes.sort((a, b) => b - a);
}

// ---- clustering -----------------------------------------------------------------------------------

export interface ClusteringResult {
  /** local clustering on the underlying undirected simple graph (unweighted) */
  local: Float64Array;
  /** mean of local over all nodes (nodes with degree < 2 count as 0, as in NetworkX) */
  average: number;
  /** 3 x triangles / connected triples */
  transitivity: number;
  triangles: number;
}

export function clustering(g: Graph): ClusteringResult {
  const { n } = g;
  // undirected neighbour sets
  const nb: Int32Array[] = [];
  const mark = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const set: number[] = [];
    for (const [start, nbr] of [[g.outStart, g.outNbr], [g.inStart, g.inNbr]] as const) {
      for (let p = start[v]!; p < start[v + 1]!; p++) {
        const w = nbr[p]!;
        if (w !== v && mark[w] !== v) {
          mark[w] = v;
          set.push(w);
        }
      }
    }
    nb.push(Int32Array.from(set));
  }
  mark.fill(-1);
  const local = new Float64Array(n);
  let triTimes3 = 0;
  let triples = 0;
  let sum = 0;
  for (let v = 0; v < n; v++) {
    const nv = nb[v]!;
    const k = nv.length;
    if (k < 2) continue;
    for (const u of nv) mark[u] = v;
    let links = 0;
    for (const u of nv) for (const w of nb[u]!) if (mark[w] === v) links++;
    const t = links / 2; // triangles through v
    local[v] = (2 * t) / (k * (k - 1));
    sum += local[v]!;
    triTimes3 += t;
    triples += (k * (k - 1)) / 2;
  }
  return { local, average: n > 0 ? sum / n : 0, transitivity: triples > 0 ? triTimes3 / triples : 0, triangles: triTimes3 / 3 };
}
