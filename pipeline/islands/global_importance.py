"""
Phase 9E indicators (Systemic / Spillover) for the island airports (Phase 9F comparison).

Two networks, both March 2026, directed, T1-T4, threshold 1 (the Phase 9E exact baseline):
  observed   the ADS-B network as in Phase 9E. Airports with no observed flight (Yonaguni, Tarama,
             Minami / Kita Daito: the RAC routes are absent from the ADS-B data) are not in it.
  augmented  the observed network plus the scheduled routes of the island config that ADS-B did not
             see (both directions, one arc each). Only for the comparison; never mixed with 9E.

Ranks in the observed network are the Phase 9E exact ranks (3,883 airports). In the augmented
network only the island airports are recomputed, so their position is measured against the 9E
baseline distribution of all airports (1 + number of airports with a larger value): close to, but
not exactly, a rank in the augmented network.

  python pipeline/islands/global_importance.py [--region okinawa-pilot]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from experiments import data as D  # noqa: E402
from experiments import impact as I  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BASELINE = ROOT / "data" / "experiments" / "march-exact-baseline" / "result.json"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--region", default="okinawa-pilot")
    a = p.parse_args()
    cfg = json.loads((HERE / f"{a.region}.json").read_text(encoding="utf-8"))
    island_airports = [x["id"] for x in cfg["airports"] if x["island"]] + ["ROAH"]

    ds = D.load_dataset("observed-2026-v2")
    fl = D.load_flights(ds, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")
    mask = D.select(fl, None, "D", list(D.CLASSES), "all")
    ids = list(ds.airport_ids)
    net = D.build_network(fl, mask, 1, True, len(ids))
    n0 = len(net.nodes)
    glob_nodes = list(net.nodes)
    pos = {g: i for i, g in enumerate(glob_nodes)}

    # observed network
    present = {x: pos.get(ids.index(x)) if x in ids else None for x in island_airports}
    prep = I.prepare(n0, net.src, net.dst, net.weight, True, None)
    cand = np.array([v for v in present.values() if v is not None])
    obs = I.evaluate(prep, cand)

    # augmented network
    extra_ids = [x for x in island_airports if present[x] is None]
    aug_index = {x: n0 + i for i, x in enumerate(extra_ids)}
    loc = lambda x: present.get(x) if present.get(x) is not None else aug_index.get(x)  # noqa: E731
    have = set(zip(net.src.tolist(), net.dst.tolist()))
    add_src, add_dst, added = [], [], []
    for s in cfg["services"]:
        if s["mode"] != "air" or s.get("status", "operating") != "operating":
            continue
        u, v = loc(s["a"]), loc(s["b"])
        if u is None:
            u = pos.get(ids.index(s["a"])) if s["a"] in ids else None
        if v is None:
            v = pos.get(ids.index(s["b"])) if s["b"] in ids else None
        if u is None or v is None:
            continue
        for x, y in ((u, v), (v, u)):
            if (x, y) not in have:
                add_src.append(x)
                add_dst.append(y)
                have.add((x, y))
                added.append(s["id"])
    n1 = n0 + len(extra_ids)
    src = np.concatenate([net.src, np.array(add_src, dtype=net.src.dtype)])
    dst = np.concatenate([net.dst, np.array(add_dst, dtype=net.dst.dtype)])
    w = np.concatenate([net.weight, np.ones(len(add_src))])
    prep2 = I.prepare(n1, src, dst, w, True, None)
    cand2 = np.array([loc(x) for x in island_airports])
    aug = I.evaluate(prep2, cand2)

    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    bs = np.array([x["ref"]["systemicDrop"] for x in base["airports"]])
    bp = np.array([x["ref"]["spilloverDrop"] for x in base["airports"]])
    bref = {x["id"]: x["ref"] for x in base["airports"]}
    out = []
    oi = {x: i for i, x in enumerate([x for x in island_airports if present[x] is not None])}
    for i, x in enumerate(island_airports):
        rec = {"airport": x, "observed": None}
        if x in oi:
            j = oi[x]
            r = bref.get(x, {})
            rec["observed"] = {"systemicDrop": round(float(obs["systemicDrop"][j]), 12), "spilloverDrop": round(float(obs["spilloverDrop"][j]), 12),
                               "unreachablePairs": float(obs["unreachablePairs"][j]), "directLost": int(obs["directLost"][j]),
                               "rankSystemic": r.get("rankSystemic"), "rankSpillover": r.get("rankSpillover"),
                               "of": len(base["airports"])}
            # the recomputation must equal the 9E exact baseline
            if r and abs(r["systemicDrop"] - rec["observed"]["systemicDrop"]) > 1e-9:  # noqa: SIM102
                raise SystemExit(f"{x}: recomputed systemic differs from the Phase 9E baseline")
        sd, sp = round(float(aug["systemicDrop"][i]), 12), round(float(aug["spilloverDrop"][i]), 12)
        rec["augmented"] = {"systemicDrop": sd, "spilloverDrop": sp, "unreachablePairs": float(aug["unreachablePairs"][i]),
                            "directLost": int(aug["directLost"][i]),
                            "positionSystemic": int((bs > sd + 1e-12).sum()) + 1, "positionSpillover": int((bp > sp + 1e-12).sum()) + 1,
                            "of": len(base["airports"])}
        out.append(rec)
    res = {"schemaVersion": 1, "region": a.region, "month": "2026-03",
           "network": {"tiers": "T1-T4", "minFlights": 1, "directed": True, "observedAirports": n0, "augmentedAirports": n1,
                       "addedArcs": len(add_src), "addedServices": sorted(set(added))},
           "baseline": "data/experiments/march-exact-baseline (Phase 9E exact, 3,883 airports)",
           "airports": out}
    dest = ROOT / "public" / "data" / "islands" / a.region / "global.json"
    dest.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for r in out:
        o = r["observed"]
        print(r["airport"], "observed", None if o is None else (o["rankSystemic"], o["rankSpillover"], round(o["spilloverDrop"], 7)),
              "augmented", r["augmented"]["positionSystemic"], r["augmented"]["positionSpillover"], round(r["augmented"]["spilloverDrop"], 7),
              int(r["augmented"]["unreachablePairs"]))
    print("added arcs", len(add_src), sorted(set(added)))


if __name__ == "__main__":
    main()
