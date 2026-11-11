import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  clustering,
  degrees,
  density,
  pageRank,
  pathMeasures,
  sampleSources,
  strongComponents,
  weakComponents,
} from '../../src/research/graph';

const edges = (n: number, list: [number, number, number?][], directed: boolean) =>
  buildGraph({
    n,
    src: Int32Array.from(list.map((e) => e[0])),
    dst: Int32Array.from(list.map((e) => e[1])),
    weight: Float64Array.from(list.map((e) => e[2] ?? 1)),
    directed,
  });

const arr = (a: Float64Array) => Array.from(a);

describe('graph construction', () => {
  it('merges duplicate edges, drops self-loops and keeps directions apart', () => {
    const g = edges(3, [[0, 1, 2], [0, 1, 3], [1, 0, 4], [2, 2, 9]], true);
    expect(g.edgeCount).toBe(2);
    const d = degrees(g);
    expect(arr(d.outStrength)).toEqual([5, 4, 0]);
    expect(arr(d.inStrength)).toEqual([4, 5, 0]);
    expect(arr(d.degree)).toEqual([1, 1, 0]); // one neighbour in either direction
    const u = edges(3, [[0, 1, 2], [1, 0, 4]], false);
    expect(u.edgeCount).toBe(1);
    expect(arr(degrees(u).strength)).toEqual([6, 6, 0]);
  });
});

describe('degree, strength, density', () => {
  it('path a-b-c (undirected)', () => {
    const g = edges(3, [[0, 1, 5], [1, 2, 1]], false);
    const d = degrees(g);
    expect(arr(d.degree)).toEqual([1, 2, 1]);
    expect(arr(d.degreeCentrality)).toEqual([0.5, 1, 0.5]);
    expect(arr(d.strength)).toEqual([5, 6, 1]);
    expect(density(g)).toBeCloseTo(2 / 3);
  });
  it('directed: in/out degree and NetworkX degree centrality (in + out) / (n - 1)', () => {
    const g = edges(3, [[0, 1], [1, 2], [2, 1]], true);
    const d = degrees(g);
    expect(arr(d.outDegree)).toEqual([1, 1, 1]);
    expect(arr(d.inDegree)).toEqual([0, 2, 1]);
    expect(arr(d.degreeCentrality)).toEqual([0.5, 1.5, 1]);
    expect(density(g)).toBeCloseTo(3 / 6);
  });
});

describe('betweenness and harmonic closeness (hops)', () => {
  it('path of three: the middle node lies on the only path', () => {
    const r = pathMeasures(edges(3, [[0, 1], [1, 2]], false), { sources: null });
    expect(arr(r.betweennessRaw)).toEqual([0, 1, 0]);
    expect(arr(r.betweenness)).toEqual([0, 1, 0]); // NetworkX: {b: 1.0}
    expect(arr(r.harmonic)).toEqual([1.5, 2, 1.5]);
    expect(arr(r.harmonicNormalized)).toEqual([0.75, 1, 0.75]);
    expect(r.exact).toBe(true);
  });
  it('triangle with a pendant: node 2 bridges two pairs', () => {
    const r = pathMeasures(edges(4, [[0, 1], [1, 2], [0, 2], [2, 3]], false), { sources: null });
    expect(r.betweenness[2]).toBeCloseTo(2 / 3); // NetworkX 0.6667
    expect(r.betweenness[0]).toBe(0);
  });
  it('directed path: ordered pairs, distances towards the node', () => {
    const r = pathMeasures(edges(3, [[0, 1], [1, 2]], true), { sources: null });
    expect(r.betweenness[1]).toBeCloseTo(0.5); // 1 / ((n-1)(n-2))
    expect(arr(r.harmonic)).toEqual([0, 1, 1.5]);
  });
  it('splits shortest paths evenly (diamond)', () => {
    const r = pathMeasures(edges(4, [[0, 1], [0, 2], [1, 3], [2, 3]], false), { sources: null });
    expect(r.betweennessRaw[1]).toBeCloseTo(0.5);
    expect(r.betweennessRaw[2]).toBeCloseTo(0.5);
  });
  it('disconnected graphs: unreachable pairs contribute nothing', () => {
    const r = pathMeasures(edges(4, [[0, 1], [2, 3]], false), { sources: null });
    expect(arr(r.betweenness)).toEqual([0, 0, 0, 0]);
    expect(arr(r.harmonic)).toEqual([1, 1, 1, 1]);
  });
  it('sampling all sources reproduces the exact result; sampling is seeded', () => {
    const g = edges(5, [[0, 1], [1, 2], [2, 3], [3, 4], [1, 3]], false);
    const exact = pathMeasures(g, { sources: null });
    const all = pathMeasures(g, { sources: sampleSources(5, 5, 7) });
    expect(arr(all.betweenness)).toEqual(arr(exact.betweenness));
    expect(Array.from(sampleSources(100, 10, 42))).toEqual(Array.from(sampleSources(100, 10, 42)));
    expect(Array.from(sampleSources(100, 10, 42))).not.toEqual(Array.from(sampleSources(100, 10, 43)));
    const approx = pathMeasures(g, { sources: sampleSources(5, 2, 1) });
    expect(approx.exact).toBe(false);
    expect(approx.sourcesUsed).toBe(2);
  });
});

describe('PageRank', () => {
  it('matches NetworkX on a two-node graph with a dangling node', () => {
    const r = pageRank(edges(2, [[0, 1]], true));
    expect(r.rank[0]).toBeCloseTo(0.3508771929, 8);
    expect(r.rank[1]).toBeCloseTo(0.649122807, 8);
    expect(r.converged).toBe(true);
  });
  it('is uniform on a symmetric cycle and sums to 1', () => {
    const r = pageRank(edges(4, [[0, 1], [1, 2], [2, 3], [3, 0]], false));
    for (const v of r.rank) expect(v).toBeCloseTo(0.25, 10);
  });
  it('uses flights as weights', () => {
    const heavy = pageRank(edges(3, [[0, 1, 9], [0, 2, 1], [1, 0], [2, 0]], true));
    expect(heavy.rank[1]!).toBeGreaterThan(heavy.rank[2]!);
  });
});

describe('components, clustering', () => {
  it('weak and strong components', () => {
    const g = edges(5, [[0, 1], [1, 2], [2, 0], [2, 3]], true);
    expect(weakComponents(g).sizes).toEqual([4, 1]);
    expect(strongComponents(g)).toEqual([3, 1, 1]);
  });
  it('clustering of a triangle with a pendant (NetworkX values)', () => {
    const c = clustering(edges(4, [[0, 1], [1, 2], [0, 2], [2, 3]], false));
    expect(arr(c.local)).toEqual([1, 1, 1 / 3, 0]);
    expect(c.average).toBeCloseTo((1 + 1 + 1 / 3) / 4);
    expect(c.transitivity).toBeCloseTo(0.6);
    expect(c.triangles).toBe(1);
  });
  it('clustering of a directed graph uses the underlying undirected graph', () => {
    const c = clustering(edges(3, [[0, 1], [1, 2], [2, 0]], true));
    expect(arr(c.local)).toEqual([1, 1, 1]);
  });
});
