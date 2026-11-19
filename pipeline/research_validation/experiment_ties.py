"""Phase 9I: how much floating-point noise affected the rank correlations of Phase 9E.

Phase 9E ranked airports on values rounded to 1e-12 (rank_value), but computed Spearman / Kendall
on the unrounded values. Impacts that are zero in exact arithmetic (e.g. Spillover of an end
airport) come out as tiny positive or negative numbers, so ties were broken by noise. This script
recomputes the correlations from the stored (rounded) values of each experiment and compares them
with the stored ones.

Usage: python pipeline/research_validation/experiment_ties.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import stats

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    out = {}
    for f in sorted((ROOT / "data" / "experiments").glob("*/result.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        name = f.parent.name
        sy = np.array([a["ref"]["systemicDrop"] for a in r["airports"]])
        sp = np.array([a["ref"]["spilloverDrop"] for a in r["airports"]])
        rec = {"candidates": len(sy), "sysSpillStored": r["systemicVsSpillover"]["spearman"],
               "sysSpillTied": round(float(stats.spearmanr(sy, sp).statistic), 4),
               "zeroSpillover": int((sp == 0).sum()), "runs": []}
        for j, run in enumerate(r["runs"]):
            for metric in ("systemic", "spillover"):
                y = np.array([a["runs"][metric][j] for a in r["airports"]], float)
                ref = sy if metric == "systemic" else sp
                s = float(stats.spearmanr(ref, y).statistic)
                stored = run["comparison"][metric]["spearman"]
                rec["runs"].append({"run": run["label"], "metric": metric, "stored": stored, "tied": round(s, 4)})
        diffs = [abs(x["tied"] - x["stored"]) for x in rec["runs"] if x["stored"] is not None]
        rec["maxRunDifference"] = round(max(diffs), 4) if diffs else None
        out[name] = rec
        print(f"{name:36s} candidates {rec['candidates']:5d} zeroSpill {rec['zeroSpillover']:5d} sys~spill stored {rec['sysSpillStored']} tied {rec['sysSpillTied']}  max run diff {rec['maxRunDifference']}")
    (ROOT / "data" / "quality" / "validation-9i-experiments.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
