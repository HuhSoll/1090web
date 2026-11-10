"""
Compares two published datasets (Explore format) month by month, plus the research/provenance
data of the newer one. Used to decide whether a regenerated dataset may replace the old one.

Usage:
  python pipeline/compare_datasets.py public/data/observed-2026 public/data/observed-2026-v2 \
      --out docs/audit-data/phase6a-v1-v2-comparison.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

MAJOR = ["KATL", "KORD", "KDFW", "KDEN", "EGLL", "LFPG", "EHAM", "EDDF", "LTFM", "OMDB", "RJTT", "WSSS", "VHHH",
         "ZBAA", "YSSY", "SBGR", "KPBI", "WAHS", "WAHQ", "WAHH", "VOBM", "VOHB", "LERJ", "HEAX"]


def load(d: Path) -> dict:
    manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    routes = {i: (a, b) for i, a, b in json.loads((d / "routes.json").read_text(encoding="utf-8"))}
    airports = json.loads((d / "airports.json").read_text(encoding="utf-8"))
    months = {}
    for m in manifest["months"]:
        recs = json.loads((d / m["file"]).read_text(encoding="utf-8"))["records"]
        tot = {"passenger": 0, "cargo": 0, "unknown": 0}
        basis = [0, 0]
        mov = defaultdict(int)
        partners = defaultdict(set)
        used_routes = set()
        for rid, _dir, _al, p, c, u, b in recs:
            tot["passenger"] += p
            tot["cargo"] += c
            tot["unknown"] += u
            basis[b] += p + c + u
            a, bb = routes[rid]
            mov[a] += p + c + u
            mov[bb] += p + c + u
            partners[a].add(bb)
            partners[bb].add(a)
            used_routes.add(rid)
        months[m["month"]] = {
            "flights": sum(tot.values()), "classes": tot, "basis": {"observed": basis[0], "callsign": basis[1]},
            "airports": len(mov), "routes": len(used_routes),
            "major_movements": {k: mov.get(k, 0) for k in MAJOR},
            "major_degree": {k: len(partners.get(k, ())) for k in MAJOR},
        }
    size = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
    return {"manifest": manifest, "airports_total": len(airports), "routes_total": len(routes),
            "months": months, "bytes_total": size,
            "bytes_months": sum((d / m["file"]).stat().st_size for m in manifest["months"])}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("old")
    p.add_argument("new")
    p.add_argument("--out", required=True)
    args = p.parse_args()
    old, new = load(Path(args.old)), load(Path(args.new))

    def total(ds, key):
        return sum(m[key] for m in ds["months"].values())

    def total_cls(ds):
        out = defaultdict(int)
        for m in ds["months"].values():
            for k, v in m["classes"].items():
                out[k] += v
        return dict(out)

    def total_basis(ds):
        out = defaultdict(int)
        for m in ds["months"].values():
            for k, v in m["basis"].items():
                out[k] += v
        return dict(out)

    def major(ds, key):
        out = defaultdict(int)
        for m in ds["months"].values():
            for k, v in m[key].items():
                out[k] += v
        return dict(out)

    aug = "2026-08"
    report = {
        "old": args.old, "new": args.new,
        "flights_on_map": {"old": total(old, "flights"), "new": total(new, "flights")},
        "classes": {"old": total_cls(old), "new": total_cls(new)},
        "basis": {"old": total_basis(old), "new": total_basis(new)},
        "airports": {"old": old["airports_total"], "new": new["airports_total"]},
        "routes": {"old": old["routes_total"], "new": new["routes_total"]},
        "per_month": {m: {"old": old["months"][m]["flights"], "new": new["months"].get(m, {}).get("flights")}
                      for m in old["months"]},
        "major_airport_movements_jan_sep": {k: [major(old, "major_movements")[k], major(new, "major_movements")[k]] for k in MAJOR},
        "major_airport_degree_aug": {k: [old["months"][aug]["major_degree"][k], new["months"][aug]["major_degree"][k]] for k in MAJOR},
        "bytes": {"old": {"total": old["bytes_total"], "months": old["bytes_months"]},
                  "new": {"total": new["bytes_total"], "months": new["bytes_months"]}},
        "new_quality": new["manifest"].get("quality"),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
