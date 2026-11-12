"""
Independent checks of the generated temporal data against the published monthly dataset.

  python pipeline/temporal_verify.py --dataset observed-2026-v2

1. public day files, summed by month  vs  monthly Explore records, key by key
   (route, direction, airline, class, basis 0 = T1-T3 / 1 = T4) and by major airport
2. research Parquet (per flight)       vs  research/routes_monthly.parquet, key by key
   (month, origin, destination, airline, class, tier)
3. day index totals                    vs  day files
Writes data/research/<dataset>/temporal/verification.json and exits non-zero on any difference.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from temporal import decode_day  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CLASSES = ("passenger", "cargo", "unknown")
MAJOR = ["KATL", "KORD", "KDFW", "EGLL", "LFPG", "EHAM", "EDDF", "LTFM", "OMDB", "RJTT", "RJAA", "WSSS", "VHHH", "ZBAA",
         "YSSY", "SBGR", "SBSP", "SBGL", "KLAX", "KJFK"]


def verify(dataset_dir: Path, temporal_public: Path, temporal_research: Path) -> dict:
    import duckdb

    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    carriers = [c["id"] for c in manifest["carriers"]]
    routes = {i: (a, b) for i, a, b in json.loads((dataset_dir / "routes.json").read_text(encoding="utf-8"))}
    index = json.loads((temporal_public / "index.json").read_text(encoding="utf-8"))
    out: dict = {"months": {}, "index_vs_files": {"days": 0, "differing": []}}

    pub = defaultdict(lambda: defaultdict(int))
    pub_airports = defaultdict(lambda: defaultdict(int))
    for entry in index["days"]:
        doc = json.loads((temporal_public / entry["file"]).read_text(encoding="utf-8"))
        ev = decode_day(doc)
        out["index_vs_files"]["days"] += 1
        if len(ev) != entry["flights"] or sum(entry["hourly"]) != entry["flights"]:
            out["index_vs_files"]["differing"].append(entry["day"])
        m = entry["day"][:7]
        acc = pub[m]
        for e in ev:
            acc[(e["route"], e["direction"], carriers[e["carrier"]], CLASSES[e["class"]], 1 if e["tier"] == 4 else 0)] += 1
            a, b = routes[e["route"]]
            pub_airports[m][a] += 1
            pub_airports[m][b] += 1

    for entry in manifest["months"]:
        m = entry["month"]
        recs = json.loads((dataset_dir / entry["file"]).read_text(encoding="utf-8"))["records"]
        mon = defaultdict(int)
        mon_airports = defaultdict(int)
        for rid, d, al, p, c, u, *b in recs:
            basis = b[0] if b else 0
            for cls, n in zip(CLASSES, (p, c, u)):
                if n:
                    mon[(rid, d, al, cls, basis)] += n
            a, bb = routes[rid]
            mon_airports[a] += p + c + u
            mon_airports[bb] += p + c + u
        tem = pub.get(m, {})
        keys = set(mon) | set(tem)
        diff = [k for k in keys if mon.get(k, 0) != tem.get(k, 0)]
        out["months"][m] = {
            "monthly_flights": sum(mon.values()), "daily_sum_flights": sum(tem.values()),
            "keys": len(keys), "keys_differing": len(diff),
            "major_airports_differing": [x for x in MAJOR if mon_airports.get(x, 0) != pub_airports[m].get(x, 0)],
            "major_airport_movements": {x: mon_airports.get(x, 0) for x in MAJOR},
        }

    # research Parquet vs routes_monthly.parquet (per tier)
    rm = (dataset_dir / "research" / "routes_monthly.parquet").as_posix()
    tp = (temporal_research / "flights_*.parquet").as_posix()
    rows = duckdb.sql(f"""
        WITH a AS (SELECT month, origin, destination, airline, class, tier, sum(flights)::BIGINT AS n FROM read_parquet('{rm}')
                   WHERE NOT coalesce(same_airport, false) AND tier <> 'X_unresolved' GROUP BY ALL),
             b AS (SELECT strftime(referenceTimeUtc, '%Y-%m') AS month, originAirport AS origin, destinationAirport AS destination,
                          airlineCode AS airline, aircraftClass AS class, confidenceTier AS tier, count(*)::BIGINT AS n
                   FROM read_parquet('{tp}') WHERE onMap GROUP BY ALL)
        SELECT coalesce(a.month, b.month), count(*), count(*) FILTER (WHERE coalesce(a.n, 0) <> coalesce(b.n, 0)),
               sum(coalesce(a.n, 0)), sum(coalesce(b.n, 0))
        FROM a FULL JOIN b USING (month, origin, destination, airline, class, tier) GROUP BY 1 ORDER BY 1""").fetchall()
    out["research_vs_routes_monthly"] = {m: {"keys": k, "keys_differing": d, "routes_monthly_flights": x, "temporal_flights": y}
                                         for m, k, d, x, y in rows}
    tiers = duckdb.sql(f"""SELECT confidenceTier, count(*) FROM read_parquet('{tp}') WHERE onMap GROUP BY 1 ORDER BY 1""").fetchall()
    out["tiers_on_map"] = dict(tiers)
    out["ok"] = (not out["index_vs_files"]["differing"]
                 and all(v["keys_differing"] == 0 and not v["major_airports_differing"] for v in out["months"].values())
                 and all(v["keys_differing"] == 0 for v in out["research_vs_routes_monthly"].values()))
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", default="observed-2026-v2")
    a = p.parse_args()
    ds = ROOT / "public" / "data" / a.dataset
    research = ROOT / "data" / "research" / a.dataset / "temporal"
    res = verify(ds, ds / "temporal", research)
    (research / "verification.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps({"ok": res["ok"], "months": {m: {k: v[k] for k in ("monthly_flights", "daily_sum_flights", "keys_differing")}
                                                  for m, v in res["months"].items()},
                      "research_vs_routes_monthly": res["research_vs_routes_monthly"], "tiers_on_map": res["tiers_on_map"]}, indent=1))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
