"""
Lightweight files that Research Mode loads in the browser (Phase 8).

Research Mode reuses the Explore month files (routes, airline codes, classes, basis 0/1) and adds
only what they lack, so nothing is published twice:

  research-web/tiers/<YYYY-MM>.json   T2 and T3 flights per [route, direction, airline] with class
                                      counts. T1 = Explore basis 0 minus T2 minus T3; T4 = basis 1.
  research-web/persistence.json       per route, in how many months of the data it has >= 1 flight,
                                      for each tier set (one digit per route).
  research-web/quality.json           dataset provenance, monthly tier mix, anomalous days and
                                      collection gaps (Phase 6B), experimental normalisation, and
                                      the external validation rows (Phase 7) with their conditions.
  research-web/manifest.json          versions, SHA-256 of every file and of the inputs.

Raw data, research Parquet files and large comparison tables are NOT published.

  python pipeline/research_web.py --dataset observed-2026-v2
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import provenance  # noqa: E402

SCHEMA_VERSION = 1
SCRIPT_VERSION = "8.1"
ROOT = Path(__file__).resolve().parents[1]
TIER_CODE = {"T1_track": 1, "T2_track_conflict": 2, "T3_track_callsign": 3, "T4_callsign_only": 4}
TIER_SETS = {"A": (1,), "B": (1, 2), "C": (1, 2, 3), "D": (1, 2, 3, 4)}
# External validation rows kept for the browser (the full grids stay in data/research).
BTS_REPORTED = ("all_reported_carrier_matched",)
ANAC_REPORTED = ("regular_carrier_matched",)
EXT_FIELDS = ["source", "scope", "months", "reported", "observed", "tiers", "direction", "min_flights",
              "share_reported_found", "share_observed_confirmed", "reported_routes_absent_in_observed",
              "observed_routes_absent_in_reported", "vol_n", "vol_sum_observed", "vol_sum_reported", "vol_WAPE",
              "vol_bias", "vol_pearson", "vol_spearman", "vol_rel_error_median", "vol_share_within_10pct"]
AIRPORT_MIN_REPORTED = 300


def _num(v: str):
    if v in ("", None):
        return None
    try:
        f = float(v)
    except ValueError:
        return v
    return int(f) if f.is_integer() and "." not in v else round(f, 4)


def _sha(path: Path) -> str:
    return provenance.sha256_file(path)


def _write(path: Path, data) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def route_ids(dataset_dir: Path) -> dict[tuple[str, str], int]:
    return {(a, b): i for i, a, b in json.loads((dataset_dir / "routes.json").read_text(encoding="utf-8"))}


def build_tiers(con, parquet: Path, ids: dict, months: list[str]) -> dict[str, list]:
    """T2/T3 records per month in the Explore record layout: [route, dir, airline, tier, p, c, u]."""
    rows = con.execute(f"""
        SELECT month, origin, destination, airline, tier,
               sum(flights) FILTER (WHERE class = 'passenger')::BIGINT,
               sum(flights) FILTER (WHERE class = 'cargo')::BIGINT,
               sum(flights) FILTER (WHERE class = 'unknown')::BIGINT
        FROM read_parquet('{parquet.as_posix()}')
        WHERE tier IN ('T2_track_conflict', 'T3_track_callsign') AND NOT coalesce(same_airport, false)
        GROUP BY ALL ORDER BY ALL""").fetchall()
    out: dict[str, list] = {m: [] for m in months}
    for month, o, d, al, tier, p, c, u in rows:
        if month not in out:
            continue
        a, b = (o, d) if o < d else (d, o)
        rid = ids.get((a, b))
        if rid is None:
            raise ValueError(f"route {a}-{b} missing from routes.json")
        out[month].append([rid, 0 if o < d else 1, al, TIER_CODE[tier], p or 0, c or 0, u or 0])
    for recs in out.values():
        recs.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
    return out


def build_persistence(con, parquet: Path, ids: dict, months: list[str]) -> dict[str, str]:
    """For each tier set, one digit per route id: months (of those in the data) with >= 1 flight."""
    rows = con.execute(f"""
        SELECT least(origin, destination), greatest(origin, destination), month, tier, sum(flights)::BIGINT
        FROM read_parquet('{parquet.as_posix()}')
        WHERE tier <> 'X_unresolved' AND NOT coalesce(same_airport, false)
        GROUP BY ALL""").fetchall()
    present: dict[str, dict[int, set]] = {k: defaultdict(set) for k in TIER_SETS}
    ms = set(months)
    for a, b, month, tier, n in rows:
        if month not in ms or n < 1:
            continue
        rid = ids[(a, b)]
        t = TIER_CODE[tier]
        for k, tiers in TIER_SETS.items():
            if t in tiers:
                present[k][rid].add(month)
    n_routes = len(ids)
    return {k: "".join(str(min(9, len(present[k].get(i, ())))) for i in range(n_routes)) for k in TIER_SETS}


def build_quality(con, parquet: Path, dataset_dir: Path, research_dir: Path, months: list[str]) -> dict:
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    prov = json.loads((dataset_dir / "provenance.json").read_text(encoding="utf-8"))
    p6b, p7 = research_dir / "phase6b", research_dir / "phase7"

    tiers = defaultdict(lambda: {"T1": 0, "T2": 0, "T3": 0, "T4": 0, "X": 0})
    for month, tier, n in con.execute(f"""
            SELECT month, tier, sum(flights)::BIGINT FROM read_parquet('{parquet.as_posix()}')
            WHERE NOT coalesce(same_airport, false) GROUP BY ALL""").fetchall():
        key = "X" if tier == "X_unresolved" else f"T{TIER_CODE[tier]}"
        tiers[month][key] += n

    anomalies = json.loads((p6b / "coverage_anomalies.json").read_text(encoding="utf-8"))
    norm = {r["month"]: r for r in csv.DictReader((p6b / "monthly_normalization_comparison.csv").open(encoding="utf-8"))
            if r["region"] == "WORLD"}
    month_rows = []
    by_month_anoms = defaultdict(list)
    for a in anomalies["anomalies"]:
        by_month_anoms[a["day"][:7]].append(a)
    entries = {m["month"]: m for m in manifest["months"]}
    for m in months:
        nr = norm.get(m, {})
        anoms = by_month_anoms.get(m, [])
        month_rows.append({
            "month": m, "calendarDays": entries[m].get("daysInMonth"), "observedDays": entries[m]["observedDays"],
            "tiers": tiers[m],
            "gapDays": sorted(a["day"] for a in anoms if a["evidence"] == "collection_gap"),
            "anomalyDays": sorted(a["day"] for a in anoms if a["direction"] == "low"),
            "normalisationWorld": {
                "A_total": _num(nr.get("A_total", "")), "B_per_calendar_day": _num(nr.get("B_per_calendar_day", "")),
                "C2_per_good_day": _num(nr.get("C2_per_good_day", "")), "good_days": _num(nr.get("good_days", "")),
                "excluded_days": [d for d in (nr.get("excluded_days") or "").split(";") if d]},
        })

    regions = []
    for r in csv.DictReader((p6b / "coverage_summary.csv").open(encoding="utf-8")):
        if r["scope_type"] in ("world", "continent") and r["month"] in months:
            regions.append({k: _num(r[k]) if k not in ("scope_id", "month", "scope_type") else r[k] for k in (
                "scope_type", "scope_id", "month", "flights_on_map", "share_T1", "share_T2", "share_T3", "share_T4",
                "callsign_only_end_share", "track_end_share", "anomaly_days_low", "daily_cv")})

    continents = {}
    with (dataset_dir / "research" / "airports.csv").open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["country"] and r["continent"]:
                continents.setdefault(r["country"], r["continent"])

    external = {"available": p7.exists()}
    if p7.exists():
        ext_rows = []
        for r in csv.DictReader((p7 / "bts_condition_metrics.csv").open(encoding="utf-8")):
            if r["reported"] in BTS_REPORTED and r["observed"] == "carrier_matched":
                ext_rows.append({k: _num(r[k]) if k not in ("source", "scope", "months", "reported", "observed",
                                                            "tiers", "direction") else r[k] for k in EXT_FIELDS})
        for r in csv.DictReader((p7 / "anac_condition_metrics.csv").open(encoding="utf-8")):
            if (r["reported"] in ANAC_REPORTED and r["observed"] == "carrier_matched"
                    and r["source"] == "ANAC_DADOS_ESTATISTICOS"):
                ext_rows.append({k: _num(r[k]) if k not in ("source", "scope", "months", "reported", "observed",
                                                            "tiers", "direction") else r[k] for k in EXT_FIELDS})
        japan = [{k: _num(v) if k not in ("source", "month", "tiers") else v for k, v in r.items()}
                 for r in csv.DictReader((p7 / "japan_national_comparison.csv").open(encoding="utf-8"))]
        airports = []
        for r in csv.DictReader((p7 / "airport_validation.csv").open(encoding="utf-8")):
            if r["tiers"] == "T1-T4" and float(r["reported"] or 0) >= AIRPORT_MIN_REPORTED:
                airports.append([r["source"], r["month"], r["airport"], _num(r["observed"]), _num(r["reported"])])
        lock = json.loads((ROOT / "pipeline" / "validation" / "external_inputs.lock.json").read_text(encoding="utf-8"))
        sources = defaultdict(lambda: {"files": 0, "retrieved": set(), "urls": set()})
        for e in lock["files"].values():
            s = sources[e["source"]]
            s["files"] += 1
            s["retrieved"].add(e["retrieved"][:10])
            s["urls"].add(e["url"].split("?")[0])
        crosswalk = [r["airline"] for r in csv.DictReader((p7 / "bts_carrier_crosswalk.csv").open(encoding="utf-8"))
                     if r["status"] == "matched"]
        external.update({
            # columnar to keep the file small: rows = list of values in the order of rowFields
            "rowFields": EXT_FIELDS, "rows": [[r[k] for k in EXT_FIELDS] for r in ext_rows], "japan": japan,
            "airportFields": ["source", "month", "airport", "observed", "reported"], "airports": airports, "btsMatchedAirlines": sorted(crosswalk),
            "airportMinReported": AIRPORT_MIN_REPORTED,
            "sources": {k: {"files": v["files"], "retrieved": sorted(v["retrieved"]), "urls": sorted(v["urls"])}
                        for k, v in sorted(sources.items())},
            "limitations": json.loads((p7 / "validation_limitations.json").read_text(encoding="utf-8")),
        })

    return {
        "schemaVersion": SCHEMA_VERSION,
        "dataset": {"id": manifest["datasetId"], "version": manifest.get("datasetVersion"),
                    "generatedAt": manifest["generatedAt"], "ruleset": prov.get("ruleset", {}).get("version"),
                    "commit": (prov.get("git") or {}).get("commit"),
                    "inputs": [{"file": i.get("file"), "sha256": i.get("sha256")} for i in prov.get("inputs", [])]},
        "months": month_rows,
        "anomalies": anomalies["anomalies"],
        "gapRuns": anomalies.get("gap_runs", []),
        "regions": regions,
        "continents": dict(sorted(continents.items())),
        "external": external,
    }


def build(dataset: str, data_root: Path = ROOT / "public" / "data", research_root: Path = ROOT / "data" / "research") -> dict:
    import duckdb

    dataset_dir = data_root / dataset
    parquet = dataset_dir / "research" / "routes_monthly.parquet"
    research_dir = research_root / dataset
    out = dataset_dir / "research-web"
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    months = [m["month"] for m in manifest["months"]]
    con = duckdb.connect()
    ids = route_ids(dataset_dir)
    files = {}
    for m, recs in build_tiers(con, parquet, ids, months).items():
        files[f"tiers/{m}.json"] = _write(out / "tiers" / f"{m}.json", {"month": m, "recordColumns": [
            "routeId", "direction", "carrierId", "tier", "passenger", "cargo", "unknown"], "records": recs})
    pers = build_persistence(con, parquet, ids, months)
    files["persistence.json"] = _write(out / "persistence.json", {"months": months, "routeCount": len(ids),
                                                                    "minFlights": 1, "tierSets": pers})
    files["quality.json"] = _write(out / "quality.json", build_quality(con, parquet, dataset_dir, research_dir, months))
    inputs = {"routes_monthly.parquet": _sha(parquet), "routes.json": _sha(dataset_dir / "routes.json")}
    for sub in ("phase6b", "phase7"):
        for f in sorted((research_dir / sub).glob("*.csv")) + sorted((research_dir / sub).glob("*.json")):
            if not f.name.endswith(".meta.json"):
                inputs[f"{sub}/{f.name}"] = _sha(f)
    web_manifest = {
        "schemaVersion": SCHEMA_VERSION, "datasetId": manifest["datasetId"],
        "datasetVersion": manifest.get("datasetVersion"), "months": months,
        "generatedAt": provenance.now_utc(),
        "script": {"name": "pipeline/research_web.py", "version": SCRIPT_VERSION},
        "tiers": {"1": "T1_track", "2": "T2_track_conflict", "3": "T3_track_callsign", "4": "T4_callsign_only"},
        "files": files, "inputs": inputs,
    }
    _write(out / "manifest.json", web_manifest)
    return web_manifest


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", default="observed-2026-v2")
    a = p.parse_args()
    m = build(a.dataset)
    print(json.dumps({"files": len(m["files"]), "months": m["months"]}, indent=1))


if __name__ == "__main__":
    main()
