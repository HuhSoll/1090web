"""
Network metrics as pure functions on plain Python data, so they can be checked by hand on tiny
graphs (tests/test_network.py).

An edge list is a mapping {(a, b): flights}. Undirected edges use a sorted key (a < b); directed
edges keep (origin, destination). Self-loops are never counted (the dataset excludes them).
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping

Edge = tuple[str, str]


# ---- building and filtering -------------------------------------------------------------------

def undirected(directed: Mapping[Edge, int]) -> dict[Edge, int]:
    """Sum both directions of each airport pair. Self-loops are dropped."""
    out: dict[Edge, int] = defaultdict(int)
    for (a, b), n in directed.items():
        if a == b:
            continue
        out[(a, b) if a < b else (b, a)] += n
    return dict(out)


def threshold(edges: Mapping[Edge, int], min_flights: int) -> dict[Edge, int]:
    """Keep edges with at least `min_flights` flights."""
    return {e: n for e, n in edges.items() if n >= min_flights}


def restrict(edges: Mapping[Edge, int], keep: Iterable[Edge]) -> dict[Edge, int]:
    keep = set(keep)
    return {e: n for e, n in edges.items() if e in keep}


# ---- node metrics ------------------------------------------------------------------------------

def nodes(edges: Iterable[Edge]) -> set[str]:
    out: set[str] = set()
    for a, b in edges:
        out.add(a)
        out.add(b)
    return out


def degree(edges: Iterable[Edge]) -> dict[str, int]:
    """Number of distinct neighbours. For a directed edge list this is the undirected degree of
    the underlying pairs (a pair served in both directions counts once)."""
    nb: dict[str, set[str]] = defaultdict(set)
    for a, b in edges:
        if a == b:
            continue
        nb[a].add(b)
        nb[b].add(a)
    return {k: len(v) for k, v in nb.items()}


def out_in_degree(directed: Iterable[Edge]) -> tuple[dict[str, int], dict[str, int]]:
    out_d: dict[str, set[str]] = defaultdict(set)
    in_d: dict[str, set[str]] = defaultdict(set)
    for a, b in directed:
        if a == b:
            continue
        out_d[a].add(b)
        in_d[b].add(a)
    return {k: len(v) for k, v in out_d.items()}, {k: len(v) for k, v in in_d.items()}


def strength(edges: Mapping[Edge, int]) -> dict[str, int]:
    """Flights touching each airport (departures + arrivals for directed input)."""
    s: dict[str, int] = defaultdict(int)
    for (a, b), n in edges.items():
        if a == b:
            continue
        s[a] += n
        s[b] += n
    return dict(s)


# ---- connectivity ------------------------------------------------------------------------------

def components(edges: Iterable[Edge]) -> list[int]:
    """Sizes of the connected components (weakly connected for directed input), largest first."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for a, b in edges:
        for x in (a, b):
            parent.setdefault(x, x)
        ra, rb = find(a), find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb
    sizes: dict[str, int] = defaultdict(int)
    for x in parent:
        sizes[find(x)] += 1
    return sorted(sizes.values(), reverse=True)


def summarize(edges: Mapping[Edge, int]) -> dict:
    """Route count, airports, flights, degree statistics and connectivity of an undirected graph."""
    deg = degree(edges)
    comp = components(edges)
    n = len(deg)
    degs = sorted(deg.values())
    return {
        "routes": len(edges),
        "airports": n,
        "flights": int(sum(edges.values())),
        "mean_degree": round(2 * len(edges) / n, 3) if n else 0.0,
        "median_degree": _median(degs) if degs else 0,
        "max_degree": degs[-1] if degs else 0,
        "components": len(comp),
        "largest_component": comp[0] if comp else 0,
        "largest_component_share": round(comp[0] / n, 4) if n else 0.0,
        "airports_outside_largest": n - (comp[0] if comp else 0),
        "components_size_le_2": sum(1 for c in comp if c <= 2),
    }


def _median(sorted_vals: list[int | float]) -> float:
    m = len(sorted_vals) // 2
    if len(sorted_vals) % 2:
        return sorted_vals[m]
    return (sorted_vals[m - 1] + sorted_vals[m]) / 2


# ---- rankings ----------------------------------------------------------------------------------

def ranking(scores: Mapping[str, float]) -> list[tuple[str, float]]:
    """Sorted by score descending, ties broken by id so the order is deterministic."""
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def competition_ranks(scores: Mapping[str, float]) -> dict[str, int]:
    """'1224' ranking: tied scores share the best rank."""
    out: dict[str, int] = {}
    prev = None
    rank = 0
    for i, (k, v) in enumerate(ranking(scores), start=1):
        if v != prev:
            rank = i
            prev = v
        out[k] = rank
    return out


def average_ranks(values: list[float]) -> list[float]:
    """Ranks 1..n (1 = largest value) with ties given the mean of their positions."""
    order = sorted(range(len(values)), key=lambda i: -values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 2:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def spearman(x: list[float], y: list[float]) -> float | None:
    """Spearman's rho = Pearson correlation of average ranks (handles ties)."""
    return pearson(average_ranks(x), average_ranks(y))


def kendall_tau_b(x: list[float], y: list[float]) -> float | None:
    """Kendall's tau-b (tie-corrected), O(n^2): intended for top-k lists."""
    n = len(x)
    conc = disc = tx = ty = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx = x[i] - x[j]
            dy = y[i] - y[j]
            if dx == 0 and dy == 0:
                continue
            if dx == 0:
                tx += 1
            elif dy == 0:
                ty += 1
            elif (dx > 0) == (dy > 0):
                conc += 1
            else:
                disc += 1
    denom = math.sqrt((conc + disc + tx) * (conc + disc + ty))
    return (conc - disc) / denom if denom else None


def compare_rankings(ref: Mapping[str, float], other: Mapping[str, float], k: int = 20) -> dict:
    """How a top-k ranking changes under another condition.

    - rows: the reference top-k with each airport's score and competition rank under both
      conditions (missing airport = score 0, rank None), rank change and score change in %.
    - spearman / kendall: computed on the union of both top-k sets, using each condition's full
      scores (an airport absent from a condition has score 0).
    - jaccard: |top-k(ref) & top-k(other)| / |union|; entered / left: membership changes.
    """
    ref_rank, oth_rank = competition_ranks(ref), competition_ranks(other)
    ref_top = [a for a, _ in ranking(ref)[:k]]
    oth_top = [a for a, _ in ranking(other)[:k]]
    rows = []
    for a in ref_top:
        r0, r1 = ref_rank.get(a), oth_rank.get(a)
        s0, s1 = ref.get(a, 0), other.get(a, 0)
        rows.append({
            "airport": a, "score_ref": s0, "score_other": s1,
            "rank_ref": r0, "rank_other": r1,
            "rank_change": (r1 - r0) if r1 is not None else None,
            "score_change_pct": round(100 * (s1 - s0) / s0, 2) if s0 else None,
        })
    union = sorted(set(ref_top) | set(oth_top))
    x = [ref.get(a, 0) for a in union]
    y = [other.get(a, 0) for a in union]
    inter = set(ref_top) & set(oth_top)
    rho = spearman(x, y)
    tau = kendall_tau_b(x, y)
    return {
        "k": k,
        "rows": rows,
        "spearman_union_topk": round(rho, 4) if rho is not None else None,
        "kendall_tau_b_union_topk": round(tau, 4) if tau is not None else None,
        "jaccard_topk": round(len(inter) / len(union), 4) if union else None,
        "entered": [a for a in oth_top if a not in set(ref_top)],
        "left": [a for a in ref_top if a not in set(oth_top)],
    }


# ---- persistence -------------------------------------------------------------------------------

def months_present(monthly: Mapping[str, Mapping[Edge, int]], min_flights: int = 1) -> dict[Edge, int]:
    """For each edge, in how many of the given months it has at least `min_flights` flights.
    Only months that are in the data are counted: a month without the edge is 'not observed',
    not 'suspended'."""
    out: dict[Edge, int] = defaultdict(int)
    for edges in monthly.values():
        for e, n in edges.items():
            if n >= min_flights:
                out[e] += 1
    return dict(out)
