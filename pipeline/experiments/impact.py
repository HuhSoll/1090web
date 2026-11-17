"""Airport criticality: the impact of stopping one airport, for many candidates on one graph.

Same definitions and algorithm as src/experiments/criticality.ts (and Phase 9C impact.ts):

  Systemic   node set V fixed (n airports, the stopped airport stays isolated); efficiency over
             the n(n-1) ordered pairs before and after.
  Spillover  node set V minus v; before = paths in the full graph (through v allowed), after =
             without v; (n-1)(n-2) ordered pairs.

Efficiency is the mean of 1/d over ordered pairs (unweighted hops; 1/d = 0 when unreachable).
Exact when every airport is a BFS source; with a sample of sources (the same sample for all
candidates) every quantity is estimated from those sources and pair counts are scaled to n-1
sources. Distances come from scipy's C breadth-first search (shortest_path, unweighted).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import csr_matrix, diags
from scipy.sparse.csgraph import shortest_path

BATCH = 256  # sources per shortest_path call (memory: BATCH x n float64)


def sample_sources(n: int, k: int | None, seed: int) -> np.ndarray | None:
    """Identical to sampleSources() in criticality.ts (mulberry32, partial Fisher-Yates)."""
    if k is None or k >= n:
        return None
    a = (seed & 0xFFFFFFFF) or 1

    def rnd() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    idx = list(range(n))
    for i in range(k):
        j = i + int(rnd() * (n - i))
        idx[i], idx[j] = idx[j], idx[i]
    return np.array(sorted(idx[:k]), dtype=np.int64)


def _imul(x: int, y: int) -> int:
    return (x * y) & 0xFFFFFFFF


def graph(n: int, src: np.ndarray, dst: np.ndarray, directed: bool) -> csr_matrix:
    """Unit-weight adjacency; self-loops dropped, duplicates merged; symmetric when undirected."""
    keep = src != dst
    s, d = src[keep], dst[keep]
    if not directed:
        s, d = np.concatenate([s, d]), np.concatenate([d, s])
    m = csr_matrix((np.ones(len(s)), (s, d)), shape=(n, n))
    m.data[:] = 1.0  # merged duplicates -> 1
    return m


def _sums(g: csr_matrix, sources: np.ndarray, n: int):
    """Per-source row sums and per-target column sums of 1/d, reachability and hop<=1,2,3."""
    row = np.zeros((5, n))
    col = np.zeros((5, n))
    for i in range(0, len(sources), BATCH):
        idx = sources[i:i + BATCH]
        d = shortest_path(g, method="D", directed=True, unweighted=True, indices=idx)
        d[np.arange(len(idx)), idx] = np.inf  # the pair (s, s) is not counted
        fin = np.isfinite(d)
        inv = np.where(fin, 1.0 / np.where(fin, d, 1.0), 0.0)
        parts = (inv, fin, fin & (d <= 1), fin & (d <= 2), fin & (d <= 3))
        for j, p in enumerate(parts):
            row[j, idx] = p.sum(axis=1)
            col[j] += p.sum(axis=0)
    return row, col


@dataclass
class Prepared:
    n: int
    directed: bool
    g: csr_matrix
    sources: np.ndarray
    in_s: np.ndarray
    row: np.ndarray
    col: np.ndarray
    tot: np.ndarray
    weight_out: dict
    edges: int
    g_t: csr_matrix


def prepare(n: int, src: np.ndarray, dst: np.ndarray, weight: np.ndarray | None, directed: bool, sources: np.ndarray | None) -> Prepared:
    g = graph(n, src, dst, directed)
    srcs = np.arange(n, dtype=np.int64) if sources is None else sources
    in_s = np.zeros(n, dtype=bool)
    in_s[srcs] = True
    row, col = _sums(g, srcs, n)
    tot = row[:, srcs].sum(axis=1)
    # flights per airport (both directions, as in criticality.ts)
    w = np.ones(len(src)) if weight is None else weight
    flights = np.zeros(n)
    keep = src != dst
    np.add.at(flights, src[keep], w[keep])
    np.add.at(flights, dst[keep], w[keep])
    edges = int(g.nnz if directed else g.nnz // 2)
    return Prepared(n, directed, g, srcs, in_s, row, col, tot, {"flights": flights}, edges, g.T.tocsr())


def evaluate(p: Prepared, candidates: np.ndarray) -> dict[str, np.ndarray]:
    """Impact of stopping each candidate (one at a time)."""
    n = p.n
    k = len(p.sources)
    out = {key: np.zeros(len(candidates)) for key in
           ("systemicDrop", "spilloverDrop", "spilloverBefore", "unreachablePairs", "hop1Drop", "hop2Drop", "hop3Drop", "directLost", "flightsLost")}
    pairs_all = k * (n - 1)
    for ci, v in enumerate(candidates):
        mask = np.ones(n)
        mask[v] = 0.0
        dm = diags(mask)
        gv = (dm @ p.g @ dm).tocsr()
        gv.eliminate_zeros()
        srcs = p.sources[p.sources != v]
        after = np.zeros(5)
        for i in range(0, len(srcs), BATCH):
            idx = srcs[i:i + BATCH]
            d = shortest_path(gv, method="D", directed=True, unweighted=True, indices=idx)
            d[np.arange(len(idx)), idx] = np.inf
            fin = np.isfinite(d)
            after[0] += np.where(fin, 1.0 / np.where(fin, d, 1.0), 0.0).sum()
            after[1] += fin.sum()
            after[2] += (fin & (d <= 1)).sum()
            after[3] += (fin & (d <= 2)).sum()
            after[4] += (fin & (d <= 3)).sum()
        kv = k - (1 if p.in_s[v] else 0)
        spill_pairs = kv * (n - 2)
        sb = p.tot - (p.row[:, v] if p.in_s[v] else 0) - p.col[:, v]
        out["systemicDrop"][ci] = (p.tot[0] - after[0]) / pairs_all if pairs_all else 0
        out["spilloverBefore"][ci] = sb[0] / spill_pairs if spill_pairs else 0
        out["spilloverDrop"][ci] = (sb[0] - after[0]) / spill_pairs if spill_pairs else 0
        out["unreachablePairs"][ci] = (sb[1] - after[1]) * (n - 1) / kv if kv else 0
        for j, key in ((2, "hop1Drop"), (3, "hop2Drop"), (4, "hop3Drop")):
            out[key][ci] = (sb[j] - after[j]) / spill_pairs if spill_pairs else 0
        nb = set(p.g.indices[p.g.indptr[v]:p.g.indptr[v + 1]].tolist())
        if p.directed:
            nb |= set(p.g_t.indices[p.g_t.indptr[v]:p.g_t.indptr[v + 1]].tolist())
        out["directLost"][ci] = len(nb)
        out["flightsLost"][ci] = p.weight_out["flights"][v]
    return out


def rank_value(x: float) -> float:
    """Rounded like rankValue() in criticality.ts so float noise does not split ties."""
    return round(x * 1e12) / 1e12
