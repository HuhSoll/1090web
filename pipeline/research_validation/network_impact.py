"""Independent check of Systemic / Spillover (Phase 9I).

Phase 9E computed the exact baseline ranking of March 2026 with pipeline/experiments (numpy BFS),
and the browser computes the same definitions in src/simulation/impact.ts. This script rebuilds
the network with its own SQL (directed, T1-T4, at least one flight per ordered airport pair,
origin != destination) and computes the efficiencies with scipy.sparse.csgraph (C code), from the
definitions alone:

  efficiency(G, P) = mean over ordered pairs (s, t) in P of 1/d(s, t)  (0 when unreachable)
  Systemic(v)  = eff(G, all pairs of V)            - eff(G with v isolated, all pairs of V)
  Spillover(v) = eff(G, pairs of V \\ {v})          - eff(G without v,  pairs of V \\ {v})

The node set V is every airport with at least one arc in the month (the baseline node set).

Usage: python pipeline/research_validation/network_impact.py [IATA ...]
"""
from __future__ import annotations

import csv
import json
import sys
import time
from pathlib import Path

import duckdb
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import shortest_path

ROOT = Path(__file__).resolve().parents[2]
DATASET = "observed-2026-v2"
PARQUET = ROOT / "data" / "research" / DATASET / "temporal" / "flights_2026-03.parquet"
BASELINE = ROOT / "data" / "experiments" / "march-exact-baseline" / "rankings.csv"


def network() -> tuple[list[str], csr_matrix]:
    con = duckdb.connect()
    rows = con.execute(f"""
        select originAirport, destinationAirport from read_parquet('{str(PARQUET).replace(chr(92), '/')}')
        where onMap and confidenceTier like 'T%' and originAirport <> destinationAirport
          and referenceTimeUtc >= '2026-03-01' and referenceTimeUtc < '2026-04-01'
        group by 1, 2""").fetchall()
    ids = sorted({a for r in rows for a in r})
    ix = {a: i for i, a in enumerate(ids)}
    src = np.array([ix[a] for a, _ in rows])
    dst = np.array([ix[b] for _, b in rows])
    return ids, csr_matrix((np.ones(len(rows)), (src, dst)), shape=(len(ids), len(ids)))


def inv_dist(g: csr_matrix) -> np.ndarray:
    d = shortest_path(g, method="D", directed=True, unweighted=True)
    with np.errstate(divide="ignore"):
        inv = np.where(np.isfinite(d) & (d > 0), 1.0 / d, 0.0)
    return inv


def without(g: csr_matrix, v: int) -> csr_matrix:
    g = g.tolil(copy=True)
    g[v, :] = 0
    g[:, v] = 0
    return g.tocsr()


def main() -> None:
    picks = sys.argv[1:] or ["PER", "ANC", "BOG", "HND", "ORD", "LIM"]
    t0 = time.time()
    ids, g = network()
    n = len(ids)
    base = inv_dist(g)
    total_before = base.sum() / (n * (n - 1))
    ref = {r["iata"]: r for r in csv.DictReader(BASELINE.open(encoding="utf-8")) if r["iata"]}
    ap = {a["iata"]: a["id"] for a in json.loads((ROOT / "public" / "data" / DATASET / "airports.json").read_text(encoding="utf-8")) if a.get("iata")}
    print(f"nodes {n} arcs {g.nnz} efficiency {total_before:.6f} ({time.time() - t0:.0f}s)")
    out = {"nodes": n, "arcs": int(g.nnz), "efficiency": total_before, "airports": {}}
    for code in picks:
        v = ids.index(ap[code])
        after = inv_dist(without(g, v))
        systemic = total_before - after.sum() / (n * (n - 1))
        mask = np.ones(n, bool)
        mask[v] = False
        m = (n - 1) * (n - 2)
        spill = base[np.ix_(mask, mask)].sum() / m - after[np.ix_(mask, mask)].sum() / m
        r = ref.get(code)
        out["airports"][code] = {"systemic": systemic, "spillover": spill,
                                 "baselineSystemic": float(r["systemic_drop"]) if r else None,
                                 "baselineSpillover": float(r["spillover_drop"]) if r else None}
        print(f"{code}: systemic {systemic:.9f} (9E {r['systemic_drop'] if r else '-'}), spillover {spill:.9f} (9E {r['spillover_drop'] if r else '-'})")
    (ROOT / "data" / "quality").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "quality" / "validation-9i-network.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
