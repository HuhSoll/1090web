"""Independent check of the island lab (Phase 9F) on the published data (Phase 9I).

The browser (src/islands/access.ts) and the pipeline (pipeline/islands/access.py) share one
algorithm. This script answers only the reachability question with a plain breadth-first search
(no times, no tie-breaking): which mesh population can still reach the destination by any chain
of road links and usable services, when an airport is stopped, at a given service level.

Checks: mesh codes unique (no population counted twice), island totals against the 2020 census
figures in meta.json, and people cut off when New Ishigaki (ISG) or Miyako (MMY) stops.

Usage: python pipeline/research_validation/island_access.py
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "public" / "data" / "islands" / "okinawa-pilot"
LEVEL = {"any": 1e-9, "weekly": 1, "daily": 7}


def reachable(net: dict, stopped: set[str], level: str, dest: str, bridges: bool = True) -> set[int]:
    ids = [g["id"] for g in net["gateways"]]
    ix = {g: i for i, g in enumerate(ids)}
    adj = defaultdict(set)
    for s in net["services"]:
        if s["status"] == "suspended" or s["status"] == "seasonal":
            continue
        if s["roundTripsPerWeek"] < LEVEL[level] or s["a"] in stopped or s["b"] in stopped:
            continue
        adj[ix[s["a"]]].add(ix[s["b"]])
        adj[ix[s["b"]]].add(ix[s["a"]])
    for i, j, _ in net["roadLinks"]["withBridges" if bridges else "noBridges"]:
        adj[i].add(j)
        adj[j].add(i)
    targets = [ix[n] for d in net["destinations"] if d["id"] == dest for n in d["nodes"] if n in ix]
    seen = set(targets)
    q = deque(targets)
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v not in seen:
                seen.add(v)
                q.append(v)
    return seen


def main() -> None:
    meta = json.loads((DIR / "meta.json").read_text(encoding="utf-8"))
    net = json.loads((DIR / "network.json").read_text(encoding="utf-8"))
    rows = json.loads((DIR / "meshes.json").read_text(encoding="utf-8"))["rows"]
    codes = Counter(r[0] for r in rows)
    dup = [c for c, n in codes.items() if n > 1]
    by_island = defaultdict(int)
    for r in rows:
        by_island[r[4]] += r[3]
    census = {i["id"]: i["population2020"] for i in meta["islands"]}
    print("duplicate mesh codes:", len(dup))
    print("island totals vs meta:", {k: (by_island.get(k, 0), v) for k, v in census.items()})
    out = {"duplicateMeshCodes": len(dup), "islands": {k: {"meshes": by_island.get(k, 0), "meta": v} for k, v in census.items()}, "cases": {}}
    ap = {g["iata"]: g["id"] for g in net["gateways"] if g.get("iata")}
    dest = meta["defaultDestination"]
    for code in ["ISG", "MMY", "OGN", "TRA", "MMD", "KTD"]:
        if code not in ap:
            continue
        res = {}
        for level in ["daily", "weekly", "any"]:
            before = reachable(net, set(), level, dest)
            after = reachable(net, {ap[code]}, level, dest)
            lost = defaultdict(int)
            for r in rows:
                g_before = any(g in before for g, _ in r[7])
                g_after = any(g in after for g, _ in r[7])
                if g_before and not g_after:
                    lost[r[4]] += r[3]
            res[level] = {"lost": sum(lost.values()), "byIsland": dict(lost)}
        out["cases"][code] = res
        print(code, {k: (v["lost"], v["byIsland"]) for k, v in res.items()})
    (ROOT / "data" / "quality").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "quality" / "validation-9i-islands.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
