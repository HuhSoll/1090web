"""Independent check of the daily counts (Phase 9I).

Three counts per UTC day, made separately:

  raw       rows of the original ADS-B quarter files (data/raw/flights) with an operator code (the
            scope of the dataset: Airline <> '-'), reference time =
            Track_Origin_DateTime_UTC, else Track_Destination_DateTime_UTC, parsed here as text
  research  rows of the per-flight research parquet (all rows, and rows on the map)
  public    flights of the public day index (index.json), which the browser reads

and per month the public monthly file (months/YYYY-MM.json) against the sum of its days.

raw == research(all) checks the time parsing, the fallback and the half-open UTC days.
research(onMap) == public checks the day files. The monthly check is between two outputs of the
same pipeline, so it checks consistency, not the airport assignment.

Usage: python pipeline/research_validation/temporal_counts.py
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DATASET = "observed-2026-v2"


def main() -> None:
    con = duckdb.connect()
    raw_files = sorted(str(p).replace("\\", "/") for p in (ROOT / "data" / "raw" / "flights").glob("2026_Q*_detailed_github.parquet"))
    # scope as built: rows with an operator code, each day taken from the file of its own quarter
    # (the quarter files overlap by a few days and the overlapping rows are not identical)
    raw: dict = defaultdict(int)
    overlap: dict = defaultdict(int)
    for f in raw_files:
        q = int(f.split("_Q")[1][0])
        for d, n in con.execute(f"""
            select substr(coalesce(nullif(Track_Origin_DateTime_UTC, '-'), nullif(Track_Destination_DateTime_UTC, '-')), 1, 10) d, count(*)
            from read_parquet('{f}') where Airline <> '-' group by 1""").fetchall():
            if d and (int(d[5:7]) - 1) // 3 + 1 == q:
                raw[d] += n
            elif d and d.startswith("2026"):
                overlap[d] += n
    res_files = sorted(str(p).replace("\\", "/") for p in (ROOT / "data" / "research" / DATASET / "temporal").glob("flights_*.parquet"))
    res = {str(d): (a, m) for d, a, m in con.execute(f"""
        select cast(referenceTimeUtc as date) d, count(*), count(*) filter (where onMap)
        from read_parquet({res_files!r}) group by 1""").fetchall()}
    idx = json.loads((ROOT / "public" / "data" / DATASET / "temporal" / "index.json").read_text(encoding="utf-8"))
    pub = {d["day"]: d["flights"] for d in idx["days"]}
    days = sorted(pub)
    out = {"days": len(days), "rawVsResearch": [], "researchVsPublic": [], "months": {}, "rawNoTime": raw.get(None, 0),
           "quarterOverlapRowsLeftOut": [{"day": d, "rows": n} for d, n in sorted(overlap.items())]}
    for d in days:
        a, m = res.get(d, (0, 0))
        if raw.get(d, 0) != a:
            out["rawVsResearch"].append({"day": d, "raw": raw.get(d, 0), "research": a})
        if m != pub[d]:
            out["researchVsPublic"].append({"day": d, "researchOnMap": m, "public": pub[d]})
    month_days = defaultdict(int)
    for d in days:
        month_days[d[:7]] += pub[d]
    for f in sorted((ROOT / "public" / "data" / DATASET / "months").glob("*.json")):
        m = json.loads(f.read_text(encoding="utf-8"))
        total = sum(r[3] + r[4] + r[5] for r in m["records"])
        out["months"][m["month"]] = {"monthly": total, "sumOfDays": month_days[m["month"]], "equal": total == month_days[m["month"]]}
    print(f"days {len(days)}; raw rows without any time {out['rawNoTime']}")
    print(f"raw vs research (all rows): {len(out['rawVsResearch'])} days differ {out['rawVsResearch'][:5]}")
    print(f"rows of another quarter's file left out: {out['quarterOverlapRowsLeftOut']}")
    print(f"research (on map) vs public day index: {len(out['researchVsPublic'])} days differ {out['researchVsPublic'][:5]}")
    for k, v in out["months"].items():
        print(k, v)
    (ROOT / "data" / "quality").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "quality" / "validation-9i-temporal.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
