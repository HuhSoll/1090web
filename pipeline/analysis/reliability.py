"""
Phase 6B: coverage assessment and network reliability for a built dataset.

Reads (never writes) a dataset produced by build_dataset.py and writes research tables with a
metadata sidecar each (<name>.meta.json) to an output directory outside public/ (these files are
not needed by the browser and are not deployed).

Usage:
  python pipeline/analysis/reliability.py --dataset observed-2026-v2 \
      --compare-dataset observed-2026 --raw-flights "data/raw/flights/*.parquet" --fetch-eurostat

Everything here describes the observed data. No output is a capture rate (observed / operated),
because the data has no measured denominator.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import sys
import urllib.request
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import provenance  # noqa: E402
from analysis import coverage as cov  # noqa: E402
from analysis import network as net  # noqa: E402

SCRIPT_VERSION = "6b.1"
ROOT = Path(__file__).resolve().parents[2]

TIERS = ("T1_track", "T2_track_conflict", "T3_track_callsign", "T4_callsign_only")
TIER_CONDITIONS = {
    "A_T1": ("T1_track",),
    "B_T1-T2": ("T1_track", "T2_track_conflict"),
    "C_T1-T3": ("T1_track", "T2_track_conflict", "T3_track_callsign"),
    "D_T1-T4": TIERS,
}
FLIGHT_THRESHOLDS = (1, 4, 10, 30)
PERSISTENCE_MONTHS = (1, 3, 6)
GAP_RATIO_SENSITIVITY = (0.05, 0.1, 0.3)
BURST_RATIO = 1.6
EUROSTAT_AIRPORTS = {"DE_EDDF": "EDDF", "FR_LFPG": "LFPG", "NL_EHAM": "EHAM", "ES_LEMD": "LEMD", "IT_LIRF": "LIRF"}
EUROSTAT_URL = ("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/avia_paoa?format=JSON&lang=EN"
                "&freq=M&unit=FLIGHT&tra_meas=CAF_PAS&schedule=TOTAL&tra_cov=TOTAL&sinceTimePeriod={since}"
                + "".join(f"&rep_airp={k}" for k in EUROSTAT_AIRPORTS))

# Which indicators support analysis and which are context only (also written to the metadata).
INDICATOR_CATALOG = {
    "analysis": {
        "anomaly_days": "days flagged against the same-weekday baseline; use to exclude or annotate days",
        "gap_hours": "worldwide hours with (almost) no flights; attributable to data collection",
        "daily_cv": "day-to-day variation of observed volume within a month (stability of the record)",
        "tier_shares": "mix of airport evidence (T1-T4) for flights touching the scope",
        "callsign_only_end_share": "share of airport ends assigned from the callsign route only (R4): a risk flag",
        "route_persistence_share": "share of the scope's routes observed in >= 6 of the months in the data",
        "mom_change_observed": "month-on-month change of OBSERVED flights; read together with anomaly days",
    },
    "reference_only": {
        "observed_flights": "volume in the data; NOT a share of operated flights (no denominator)",
        "track_end_share": "share of ends supported by the track (R1/R2); NOT a capture rate",
        "cross_scope_volume_comparison": "regions differ in receiver density; volumes are not comparable as traffic",
    },
}


@dataclass
class Config:
    dataset_dir: Path
    out_dir: Path
    compare_dir: Path | None = None
    raw_flights: list[Path] = field(default_factory=list)
    eurostat_json: Path | None = None
    fetch_eurostat: bool = False
    focus_month: str = "2026-08"
    top_k: int = 20
    detection: cov.DetectionConfig = field(default_factory=cov.DetectionConfig)
    normalisation_quality_region: str = "WORLD"
    lock_path: Path | None = provenance.LOCK_PATH
    record_git: bool = True
    overwrite: bool = False
    log: Callable[[str], None] = print


# ---- small helpers -----------------------------------------------------------------------------

def _jsonable(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, Path):
        return o.as_posix()
    if isinstance(o, (set, tuple)):
        return list(o)
    raise TypeError(type(o))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False, default=_jsonable) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[Mapping], columns: list[str] | None = None) -> None:
    columns = columns or (list(rows[0].keys()) if rows else [])
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(columns)
        for r in rows:
            vals = []
            for c in columns:
                v = r.get(c)
                if isinstance(v, (list, tuple)):
                    v = ";".join(str(x) for x in v)
                elif isinstance(v, bool):
                    v = "true" if v else "false"
                elif isinstance(v, (date, datetime)):
                    v = v.isoformat()
                elif v is None:
                    v = ""
                vals.append(v)
            w.writerow(vals)


def _rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return p.name


class Outputs:
    """Writes each output plus <name>.meta.json with the common provenance block."""

    def __init__(self, cfg: Config, common: dict):
        self.cfg = cfg
        self.common = common
        self.written: list[str] = []

    def put(self, name: str, data, *, inputs: list[str], conditions: dict, thresholds: dict,
            method: str, columns: list[str] | None = None) -> None:
        path = self.cfg.out_dir / name
        if name.endswith(".csv"):
            write_csv(path, data, columns)
        else:
            write_json(path, data)
        meta = {
            "output": name,
            **self.common,
            "inputs": [i for i in self.common["inputFiles"] if i["role"] in inputs],
            "conditions": conditions,
            "thresholds": thresholds,
            "method": method,
        }
        meta.pop("inputFiles")
        write_json(self.cfg.out_dir / (name.rsplit(".", 1)[0] + ".meta.json"), meta)
        self.written.append(name)


# ---- loading -----------------------------------------------------------------------------------

def load_dataset(cfg: Config, con) -> dict:
    d = cfg.dataset_dir
    manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    months = [m["month"] for m in manifest["months"]]
    airports = {}
    with (d / "research" / "airports.csv").open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            airports[r["id"]] = {"continent": r["continent"] or None, "country": r["country"] or None}
    daily: dict[str, dict[date, int]] = defaultdict(dict)
    with (d / "research" / "coverage_daily.csv").open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            daily[r["region"]][date.fromisoformat(r["day"])] = int(r["flights"])
    pq = (d / "research" / "routes_monthly.parquet").as_posix()
    rows = con.execute(f"""
        SELECT month, origin, destination, tier, origin_rule, destination_rule, sum(flights)::BIGINT
        FROM read_parquet('{pq}') WHERE NOT coalesce(same_airport, false)
        GROUP BY ALL ORDER BY ALL""").fetchall()
    return {"manifest": manifest, "months": months, "airports": airports, "daily": dict(daily), "rows": rows}


def edges_by_month_tier(rows: Iterable[tuple]) -> dict[str, dict[str, dict[tuple[str, str], int]]]:
    """month -> tier -> {(origin, destination): flights} for flights on the map (T1-T4)."""
    out: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    for month, o, d, tier, _ro, _rd, n in rows:
        if tier in TIERS and o and d and o != d:
            out[month][tier][(o, d)] += n
    return out


def select_tiers(by_tier: Mapping[str, Mapping[tuple[str, str], int]], tiers: Iterable[str]) -> dict[tuple[str, str], int]:
    """Directed edges summed over the chosen tiers (T1-T4 filtering)."""
    out: dict[tuple[str, str], int] = defaultdict(int)
    for t in tiers:
        for e, n in by_tier.get(t, {}).items():
            out[e] += n
    return dict(out)


# ---- 2. regional quality -----------------------------------------------------------------------

def scope_quality(rows: Iterable[tuple], scope_of: Mapping[str, str | None], persistent: set[tuple[str, str]]) -> dict:
    """Per (scope, month) volumes, tier mix, end rules and route persistence.

    A flight 'touches' a scope when its origin or destination lies in it (counted once even if
    both do). End rules are attributed to the scope of that end's airport; R5 ends have no
    airport and are counted only through the X flights of the scope (by the known end).
    """
    acc: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "flights": 0, "tiers": defaultdict(int), "x_flights": 0, "ends": defaultdict(int), "routes": set()})
    for month, o, d, tier, ro, rd, n in rows:
        so = scope_of.get(o) if o else None
        sd = scope_of.get(d) if d else None
        touched = {s for s in (so, sd) if s}
        for s in touched:
            a = acc[(s, month)]
            if tier in TIERS:
                a["flights"] += n
                a["tiers"][tier] += n
                if o and d:
                    a["routes"].add((o, d) if o < d else (d, o))
            else:
                a["x_flights"] += n
        for s, rule in ((so, ro), (sd, rd)):
            if s and rule:
                acc[(s, month)]["ends"][rule] += n
    out = {}
    for key, a in acc.items():
        ends = a["ends"]
        known = sum(ends[r] for r in ("R1", "R2", "R3", "R4"))
        f = a["flights"]
        routes = a["routes"]
        out[key] = {
            "flights_on_map": f,
            "x_unresolved_touching": a["x_flights"],
            **{f"share_{t.split('_')[0]}": round(a["tiers"][t] / f, 4) if f else None for t in TIERS},
            **{f"ends_{r}": ends[r] for r in ("R1", "R2", "R3", "R4")},
            "track_end_share": round((ends["R1"] + ends["R2"]) / known, 4) if known else None,
            "track_or_match_end_share": round((ends["R1"] + ends["R2"] + ends["R3"]) / known, 4) if known else None,
            "callsign_only_end_share": round(ends["R4"] / known, 4) if known else None,
            "routes": len(routes),
            "route_persistence_share_6m": round(len(routes & persistent) / len(routes), 4) if routes else None,
        }
    return out


def daily_stats(series: Mapping[date, int], table_rows: Mapping[date, Mapping]) -> dict:
    vals = list(series.values())
    n = len(vals)
    mean = sum(vals) / n if n else 0
    var = sum((v - mean) ** 2 for v in vals) / (n - 1) if n > 1 else 0
    return {
        "daily_mean": round(mean, 1),
        "daily_cv": round(var ** 0.5 / mean, 4) if mean else None,
        "anomaly_days_low": sum(1 for d in series if table_rows.get(d, {}).get("low")),
        "anomaly_days_low_0.5": sum(1 for d in series if table_rows.get(d, {}).get("low_0.5")),
        "anomaly_days_high": sum(1 for d in series if table_rows.get(d, {}).get("high")),
        "zero_days": sum(1 for v in vals if v == 0),
    }


# ---- 7. external ------------------------------------------------------------------------------

def parse_eurostat(doc: dict) -> dict[str, dict[str, int]]:
    """JSON-stat 2.0 -> {airport: {month: value}} (only cells that are present)."""
    dims = doc["id"]
    sizes = doc["size"]
    idx = {k: {v: i for v, i in doc["dimension"][k]["category"]["index"].items()} for k in dims}
    inv = {k: {i: v for v, i in idx[k].items()} for k in dims}
    out: dict[str, dict[str, int]] = defaultdict(dict)
    for flat, val in doc["value"].items():
        flat = int(flat)
        coords = {}
        for k, size in reversed(list(zip(dims, sizes))):
            coords[k] = inv[k][flat % size]
            flat //= size
        out[coords["rep_airp"]][coords["time"]] = int(val)
    return dict(out)


def airport_class_movements(dataset_dir: Path, codes: set[str]) -> dict[str, dict[str, dict]]:
    """Departures + arrivals per class and basis from the Explore month files (v1 or v2)."""
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    routes = {i: (a, b) for i, a, b in json.loads((dataset_dir / "routes.json").read_text(encoding="utf-8"))}
    out: dict[str, dict[str, dict]] = defaultdict(dict)
    for m in manifest["months"]:
        recs = json.loads((dataset_dir / m["file"]).read_text(encoding="utf-8"))["records"]
        acc = {c: defaultdict(int) for c in codes}
        for rid, _dir, _al, p, c, u, basis in recs:
            for ap in routes[rid]:
                if ap in acc:
                    a = acc[ap]
                    a["passenger"] += p
                    a["cargo"] += c
                    a["unknown"] += u
                    if basis == 0:
                        a["passenger_observed"] += p
        for c in codes:
            out[c][m["month"]] = dict(acc[c])
    return dict(out)


# ---- main --------------------------------------------------------------------------------------

def run(cfg: Config) -> dict:
    import duckdb

    out = cfg.out_dir
    if out.exists() and any(out.iterdir()) and not cfg.overwrite:
        raise FileExistsError(f"{out} is not empty (use --overwrite to replace the analysis outputs)")
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    det = cfg.detection

    # inputs + provenance
    ds_manifest = json.loads((cfg.dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    input_files = [
        provenance.InputFile("dataset_manifest", cfg.dataset_dir / "manifest.json"),
        provenance.InputFile("routes_monthly", cfg.dataset_dir / "research" / "routes_monthly.parquet"),
        provenance.InputFile("coverage_daily", cfg.dataset_dir / "research" / "coverage_daily.csv"),
        provenance.InputFile("airports", cfg.dataset_dir / "research" / "airports.csv"),
    ]
    raw_ok = bool(cfg.raw_flights) and all(p.exists() for p in cfg.raw_flights)
    if raw_ok:
        input_files += [provenance.InputFile("raw_flights", p) for p in cfg.raw_flights]
    described = [{**f.describe(), "path": _rel(f.path)} for f in input_files]
    if raw_ok and cfg.lock_path:
        provenance.verify_against_lock([d for d in described if d["role"] == "raw_flights"], cfg.lock_path)
    cfg.log(f"inputs described ({len(described)} files)")

    data = load_dataset(cfg, con)
    months = data["months"]
    common = {
        "dataset": {"id": ds_manifest.get("datasetId"), "version": ds_manifest.get("datasetVersion"),
                    "path": _rel(cfg.dataset_dir)},
        "period": {"months": months, "from": months[0], "to": months[-1]},
        "generatedAt": provenance.now_utc(),
        "script": {"name": "pipeline/analysis/reliability.py", "version": SCRIPT_VERSION,
                   "git": provenance.git_state() if cfg.record_git else None},
        "environment": provenance.environment(),
        "inputFiles": described,
        "note": "Observed data only. No value is a share of operated flights.",
    }
    outs = Outputs(cfg, common)
    det_dict = asdict(det)

    # ---- 1. daily + hourly -----------------------------------------------------------------
    daily = data["daily"]
    start, end = min(min(s) for s in daily.values()), max(max(s) for s in daily.values())
    daily = {r: cov.complete_days(s, start, end) for r, s in daily.items()}
    table = cov.daily_table(daily, det)
    table_idx = {(r["region"], r["day"]): r for r in table}

    gap_runs: list[dict] = []
    hourly_rows: list[dict] = []
    gap_info: dict = {}
    gap_sensitivity: dict = {}
    bursts: list[dict] = []
    if raw_ok:
        files = ", ".join(f"'{p.as_posix()}'" for p in cfg.raw_flights)
        month_list = ", ".join(f"'{m}'" for m in months)
        year = int(months[0][:4])
        hours = con.execute(f"""
            WITH raw AS (SELECT Airline, Track_Origin_DateTime_UTC o, Track_Destination_DateTime_UTC d,
                           regexp_extract(filename, '_Q(\\d)_', 1)::INT q
                         FROM read_parquet([{files}], filename = true)),
            t AS (SELECT q, Airline, TRY_CAST(CASE WHEN o <> '-' THEN o ELSE d END AS TIMESTAMP) ts FROM raw)
            SELECT date_trunc('hour', ts) h, count(*) FROM t
            WHERE Airline <> '-' AND ts IS NOT NULL AND year(ts) = {year} AND (month(ts) - 1) // 3 + 1 = q
              AND strftime(ts, '%Y-%m') IN ({month_list})
            GROUP BY 1""").fetchall()
        hourly = {h: n for h, n in hours}
        hourly = cov.complete_hours(hourly, datetime.combine(start, datetime.min.time()),
                                    datetime.combine(end, datetime.min.time()).replace(hour=23))
        hbase = cov.hourly_baseline(hourly, det.window_days)
        gap_runs = cov.gap_runs(hourly, hbase, det.gap_ratio, det.gap_min_hours)
        gap_info = cov.deficits_by_day(hourly, hbase, gap_runs)
        for gr in GAP_RATIO_SENSITIVITY:
            gap_sensitivity[str(gr)] = [{k: v for k, v in x.items()} for x in cov.gap_runs(hourly, hbase, gr, 1)]
        bursts = cov.burst_hours(hourly, hbase, BURST_RATIO)
        for t in sorted(hourly):
            r = cov.ratio(hourly[t], hbase[t])
            hourly_rows.append({"hour": t, "flights": hourly[t], "baseline": hbase[t],
                                "ratio": round(r, 4) if r is not None else None})
        cfg.log(f"hourly: {len(hourly_rows)} hours, {len(gap_runs)} gap runs")
    anomalies = cov.classify_days(table, gap_info, det)

    det_method = ("baseline = median of the same weekday within +-window_days (excluding the day); "
                  "ratio = flights / baseline; low < low_ratio, high > high_ratio. Daily counts are the "
                  "dataset's coverage_daily.csv (flights with an assigned airport, region = continent of "
                  "the origin airport, else destination).")
    outs.put("coverage_daily_assessment.csv", table, inputs=["coverage_daily"],
             conditions={"regions": list(daily)}, thresholds=det_dict, method=det_method)
    if raw_ok:
        outs.put("coverage_hourly_world.csv", hourly_rows, inputs=["raw_flights"],
                 conditions={"scope": "airline-code flights in quarter scope (same as build), all tiers incl. unresolved",
                             "time": "track origin time, else destination time (UTC)"},
                 thresholds=det_dict, method="baseline = median of the same weekday and hour within +-window_days")
        outs.put("coverage_gaps.csv", gap_runs, inputs=["raw_flights"],
                 conditions={"scope": "worldwide"}, thresholds={"gap_ratio": det.gap_ratio, "gap_min_hours": det.gap_min_hours},
                 method="runs of consecutive hours with flights <= gap_ratio * hourly baseline")
    outs.put("coverage_anomalies.json", {
        "anomalies": anomalies,
        "gap_runs": gap_runs,
        "gap_ratio_sensitivity": gap_sensitivity,
        "burst_hours": bursts,
        "hourly_analysis": "run" if raw_ok else "not run (raw flight files not available)",
        "evidence_categories": {
            "collection_gap": "worldwide gap hours explain >= gap_explains_share of the day's shortfall; attributed to data collection (inferred)",
            "partial_gap_unexplained": "gap hours explain less than that share; the rest has no identifiable cause",
            "unexplained_low": "low without gap hours; cause cannot be identified from this data",
            "unexplained_high": "high; cause cannot be identified (may follow a gap as a backlog)",
        },
        "sensitivity_low_days": {
            str(t): sorted({str(r["day"]) for r in table if r["region"] == "WORLD" and r[f"low_{t:g}"]})
            for t in det.extra_low_ratios
        } | {str(det.low_ratio): sorted({str(r["day"]) for r in table if r["region"] == "WORLD" and r["low"]})},
    }, inputs=["coverage_daily", "raw_flights"], conditions={"regions": list(det.regions)}, thresholds=det_dict,
        method=det_method + " Scope: global when WORLD is low and >= global_min_regions regions are low. "
               "gap_ratio_sensitivity repeats the hourly gap search at other ratios (reported only); "
               f"burst_hours are hours >= {BURST_RATIO} x their hourly baseline.")

    # ---- persistence (needed by regional quality) --------------------------------------------
    mt = edges_by_month_tier(data["rows"])
    monthly_all = {m: net.undirected(select_tiers(mt[m], TIERS)) for m in months}
    present = net.months_present(monthly_all, 1)
    persistent6 = {e for e, k in present.items() if k >= 6}

    # ---- 2. regional quality ---------------------------------------------------------------
    airports = data["airports"]
    summary_rows = []
    for scope_type, scope_of in (
        ("world", {a: "WORLD" for a in airports}),
        ("continent", {a: v["continent"] for a, v in airports.items()}),
        ("country", {a: v["country"] for a, v in airports.items()}),
    ):
        q = scope_quality(data["rows"], scope_of, persistent6)
        scopes = sorted({s for s, _ in q})
        for s in scopes:
            prev = None
            for m in months:
                row = {"scope_type": scope_type, "scope_id": s, "month": m, **q.get((s, m), {"flights_on_map": 0})}
                f = row.get("flights_on_map", 0)
                row["mom_change_observed_pct"] = cov.pct_change(f, prev)
                prev = f
                region_key = s if scope_type in ("world", "continent") else None
                if region_key in daily:
                    series = {d: v for d, v in daily[region_key].items() if cov.month_of(d) == m}
                    rows_idx = {d: table_idx[(region_key, d)] for d in series}
                    row.update(daily_stats(series, rows_idx))
                summary_rows.append(row)
    cols = ["scope_type", "scope_id", "month", "flights_on_map", "mom_change_observed_pct", "x_unresolved_touching",
            "share_T1", "share_T2", "share_T3", "share_T4", "ends_R1", "ends_R2", "ends_R3", "ends_R4",
            "track_end_share", "track_or_match_end_share", "callsign_only_end_share", "routes",
            "route_persistence_share_6m", "daily_mean", "daily_cv", "anomaly_days_low", "anomaly_days_low_0.5",
            "anomaly_days_high", "zero_days"]
    outs.put("coverage_summary.csv", summary_rows, columns=cols, inputs=["routes_monthly", "coverage_daily", "airports"],
             conditions={"scope_types": ["world", "continent", "country"],
                         "touching": "a flight counts for a scope when its origin or destination lies in it",
                         "daily metrics": "world and continents only (daily counts by country are not in the dataset)"},
             thresholds=det_dict | {"persistence_months": 6},
             method=json.dumps(INDICATOR_CATALOG, ensure_ascii=False))
    cfg.log("coverage summary written")

    # ---- 3. monthly normalisation ----------------------------------------------------------
    qref = cfg.normalisation_quality_region
    qratio = {r["day"]: r["ratio"] for r in table if r["region"] == qref}
    norm_rows = []
    norm_regions = [r for r in ["WORLD", *det.regions] if r in daily]
    for region in norm_regions:
        prev = None
        for m in months:
            series = {d: v for d, v in daily[region].items() if cov.month_of(d) == m}
            dim = len(series)
            res = cov.normalise_month(series, qratio, dim, det.low_ratio)
            own = cov.normalise_month(series, {r["day"]: r["ratio"] for r in table if r["region"] == region}, dim, det.low_ratio)
            row = {"region": region, "month": m, **res,
                   "C1_own_region_quality": own["C1_per_effective_day"],
                   "C2_own_region_quality": own["C2_per_good_day"],
                   "effective_days_own_region": own["effective_days"]}
            for key in ("A_total", "B_per_calendar_day", "B_obs_per_observed_day", "C1_per_effective_day", "C2_per_good_day"):
                row[f"mom_{key}"] = cov.pct_change(row[key], prev[key] if prev else None)
            prev = row
            norm_rows.append(row)
    outs.put("monthly_normalization_comparison.csv", norm_rows, inputs=["coverage_daily"],
             conditions={"quality_reference_region": qref, "regions": norm_regions,
                         "volume": "coverage_daily flights (assigned airport, same-airport included)"},
             thresholds={"good_day_ratio": det.low_ratio, "window_days": det.window_days},
             method=cov.normalise_month.__doc__)

    # ---- 4. tier networks ------------------------------------------------------------------
    cont_of = {a: v["continent"] for a, v in airports.items()}
    tier_rows, tier_detail = [], {}
    for m in months:
        ref_edges = net.undirected(select_tiers(mt[m], TIERS))
        ref_deg = net.degree(ref_edges)
        tier_detail[m] = {}
        for name, tiers in TIER_CONDITIONS.items():
            e = net.undirected(select_tiers(mt[m], tiers))
            s = net.summarize(e)
            deg = net.degree(e)
            cmp_ = net.compare_rankings(ref_deg, deg, cfg.top_k)
            ret = {}
            for c in det.regions:
                ref_r = sum(1 for a, b in ref_edges if c in (cont_of.get(a), cont_of.get(b)))
                r = sum(1 for a, b in e if c in (cont_of.get(a), cont_of.get(b)))
                ret[c] = round(r / ref_r, 4) if ref_r else None
            tier_rows.append({"month": m, "condition": name, **s,
                              "spearman_vs_D_top20": cmp_["spearman_union_topk"],
                              "jaccard_vs_D_top20": cmp_["jaccard_topk"],
                              **{f"route_retention_{c}": ret[c] for c in det.regions}})
            tier_detail[m][name] = {"summary": s, "top": net.ranking(deg)[: cfg.top_k],
                                    "vs_D": cmp_, "route_retention_by_continent": ret}
    tier_meta = dict(inputs=["routes_monthly", "airports"],
                     conditions={k: list(v) for k, v in TIER_CONDITIONS.items()} | {"graph": "undirected airport pairs, same-airport excluded"},
                     thresholds={"top_k": cfg.top_k},
                     method="Tiers describe the airport evidence; they are NOT calibrated probabilities of being correct. "
                            "Route retention = routes touching the continent under the condition / under D.")
    outs.put("confidence_sensitivity.csv", tier_rows, **tier_meta)
    outs.put("confidence_sensitivity.json", tier_detail, **tier_meta)
    cfg.log("tier sensitivity written")

    # ---- 5. thresholds + persistence ---------------------------------------------------------
    thr_rows = []
    for m in months:
        und = monthly_all[m]
        dirg = select_tiers(mt[m], TIERS)
        ref_deg = net.degree(und)
        for k in FLIGHT_THRESHOLDS:
            e = net.threshold(und, k)
            de = net.threshold(dirg, k)
            s = net.summarize(e)
            pairs_dir = {(a, b) if a < b else (b, a) for a, b in de}
            one_way = sum(1 for a, b in pairs_dir if not ((a, b) in de and (b, a) in de))
            cmp_ = net.compare_rankings(ref_deg, net.degree(e), cfg.top_k)
            thr_rows.append({"month": m, "min_flights": k, "graph": "undirected", **s,
                             "directed_routes": len(de), "pairs_one_direction_only": one_way,
                             "spearman_vs_all_top20": cmp_["spearman_union_topk"],
                             "jaccard_vs_all_top20": cmp_["jaccard_topk"],
                             "top10": [f"{a}:{d}" for a, d in net.ranking(net.degree(e))[:10]]})
    max_month = defaultdict(int)
    for m in months:
        for e, n in monthly_all[m].items():
            max_month[e] = max(max_month[e], n)
    all_routes = len(max_month)
    total_flights = sum(sum(monthly_all[m].values()) for m in months)
    never4 = {e for e, n in max_month.items() if n < 4}
    never4_flights = sum(monthly_all[m].get(e, 0) for m in months for e in never4)
    outs.put("route_threshold_sensitivity.csv", thr_rows, inputs=["routes_monthly"],
             conditions={"tiers": list(TIERS), "graph": "undirected pair flights summed over both directions; "
                         "directed_routes applies the same threshold per direction"},
             thresholds={"min_flights_per_month": list(FLIGHT_THRESHOLDS), "top_k": cfg.top_k},
             method="Dropping low-frequency routes also drops seasonal and genuinely infrequent routes; it is not noise removal.")

    first_month = {}
    for i, m in enumerate(months):
        for e in monthly_all[m]:
            first_month.setdefault(e, i)
    dist = defaultdict(int)
    dist_flights = defaultdict(int)
    for e, k in present.items():
        dist[k] += 1
        dist_flights[k] += sum(monthly_all[m].get(e, 0) for m in months)
    fm = cfg.focus_month
    focus = monthly_all[fm]
    ref_deg = net.degree(focus)
    pers_rows = {}
    for k in PERSISTENCE_MONTHS:
        e = {x: n for x, n in focus.items() if present.get(x, 0) >= k}
        cmp_ = net.compare_rankings(ref_deg, net.degree(e), cfg.top_k)
        pers_rows[f"present_ge_{k}"] = {"summary": net.summarize(e), "vs_all": cmp_}
    late = sum(1 for e, i in first_month.items() if len(months) - i < 6)
    outs.put("route_persistence.json", {
        "months_in_data": months,
        "routes_total": all_routes,
        "routes_by_months_present": dict(sorted(dist.items())),
        "flight_share_by_months_present": {k: round(v / total_flights, 4) for k, v in sorted(dist_flights.items())},
        "routes_never_4_in_a_month": len(never4),
        "routes_never_4_share": round(len(never4) / all_routes, 4),
        "flights_on_those_routes": never4_flights,
        "flights_on_those_routes_share": round(never4_flights / total_flights, 4),
        "routes_first_seen_too_late_to_reach_6_months": late,
        f"focus_month_{fm}": pers_rows,
    }, inputs=["routes_monthly"],
        conditions={"tiers": list(TIERS), "graph": "undirected", "focus_month": fm},
        thresholds={"months_present": list(PERSISTENCE_MONTHS), "min_flights_for_present": 1},
        method="months_present counts the months IN THE DATA with >= 1 flight on the pair. A month without "
               "the pair is 'not observed', not 'suspended'. Routes first seen late in the period cannot reach "
               "high persistence.")
    cfg.log("thresholds and persistence written")

    # ---- 6. ranking robustness (focus month) ------------------------------------------------
    conds = {
        "all": monthly_all[fm],
        "min4": net.threshold(monthly_all[fm], 4),
        "min10": net.threshold(monthly_all[fm], 10),
        "T1-T3": net.undirected(select_tiers(mt[fm], TIER_CONDITIONS["C_T1-T3"])),
        "T1": net.undirected(select_tiers(mt[fm], TIER_CONDITIONS["A_T1"])),
    }
    degs = {k: net.degree(v) for k, v in conds.items()}
    rob = {"focus_month": fm, "reference": "all", "top_k": cfg.top_k,
           "top": {k: net.ranking(d)[: cfg.top_k] for k, d in degs.items()},
           "vs_reference": {k: net.compare_rankings(degs["all"], d, cfg.top_k) for k, d in degs.items() if k != "all"},
           "pairwise_spearman_union_top20": {a: {b: net.compare_rankings(degs[a], degs[b], cfg.top_k)["spearman_union_topk"]
                                                 for b in degs} for a in degs}}
    flat = []
    for k, c in rob["vs_reference"].items():
        for r in c["rows"]:
            flat.append({"condition": k, **r})
    rob_meta = dict(inputs=["routes_monthly"],
                    conditions={"all": "T1-T4, >= 1 flight", "min4": ">= 4 flights in the month (pair, both directions)",
                                "min10": ">= 10 flights", "T1-T3": "tiers T1-T3", "T1": "tier T1 only",
                                "score": "degree = number of distinct airports connected in the month"},
                    thresholds={"top_k": cfg.top_k},
                    method="Ranks: competition ranking (ties share the best rank). Correlations on the union of both "
                           "top-k sets using full degree values (absent = 0). Spearman = Pearson of average ranks; "
                           "Kendall tau-b tie-corrected.")
    outs.put(f"ranking_robustness_{fm}.json", rob, **rob_meta)
    outs.put(f"ranking_robustness_{fm}.csv", flat, **rob_meta)
    cfg.log("ranking robustness written")

    # ---- 7. external validation --------------------------------------------------------------
    ext = external_validation(cfg, out, table, months, outs)
    con.close()
    return {"outputs": outs.written, "anomalies": len(anomalies), "gap_runs": len(gap_runs), "external": ext}


def external_validation(cfg: Config, out: Path, table, months, outs: Outputs) -> str:
    doc = None
    retrieved = None
    if cfg.fetch_eurostat:
        url = EUROSTAT_URL.format(since=months[0])
        req = urllib.request.Request(url, headers={"User-Agent": "1090web-research/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            retrieved = provenance.now_utc()
            (out / "eurostat_avia_paoa.json").write_bytes(raw)
            doc = json.loads(raw)
        except (OSError, ValueError) as e:
            cfg.log(f"Eurostat fetch failed: {e}")
    if doc is None and cfg.eurostat_json and cfg.eurostat_json.exists():
        doc = json.loads(cfg.eurostat_json.read_text(encoding="utf-8"))
    if doc is None:
        outs.put("external_validation_summary.json", {"status": "not run: no Eurostat data available"},
                 inputs=[], conditions={}, thresholds={}, method="")
        return "not run"
    if retrieved:
        outs.common["inputFiles"].append({**provenance.InputFile("eurostat", out / "eurostat_avia_paoa.json").describe(),
                                          "path": "eurostat_avia_paoa.json", "url": EUROSTAT_URL.format(since=months[0]),
                                          "retrieved": retrieved})
    euro = parse_eurostat(doc)
    codes = set(EUROSTAT_AIRPORTS.values())
    v2 = airport_class_movements(cfg.dataset_dir, codes)
    v1 = airport_class_movements(cfg.compare_dir, codes) if cfg.compare_dir else {}
    eu_ratio = {r["day"]: r["ratio"] for r in table if r["region"] == "EU"}
    rows = []
    for geo, code in EUROSTAT_AIRPORTS.items():
        for m in months:
            e = euro.get(geo, {}).get(m)
            if e is None:
                continue
            b = v2[code][m]
            a = v1.get(code, {}).get(m, {})
            series_days = [r for r in table if r["region"] == "EU" and cov.month_of(r["day"]) == m]
            dim = len(series_days)
            eff = sum(1.0 if eu_ratio[r["day"]] is None else max(0.0, min(1.0, eu_ratio[r["day"]])) for r in series_days)
            v2_pu = b["passenger"] + b["unknown"]
            rows.append({
                "airport": code, "eurostat_geo": geo, "month": m, "eurostat_caf_pas": e,
                "v1_passenger": a.get("passenger"), "v2_passenger": b["passenger"],
                "v2_passenger_plus_unknown": v2_pu, "v2_all_classes": v2_pu + b["cargo"],
                "v2_passenger_observed_basis": b["passenger_observed"],
                "ratio_v1_passenger": round(a["passenger"] / e, 4) if a else None,
                "ratio_v2_passenger": round(b["passenger"] / e, 4),
                "ratio_v2_passenger_plus_unknown": round(v2_pu / e, 4),
                "ratio_v2_passenger_observed_basis": round(b["passenger_observed"] / e, 4),
                "eu_effective_days": round(eff, 3), "calendar_days": dim,
                "ratio_v2_passenger_plus_unknown_C1_scaled": round(v2_pu * dim / eff / e, 4) if eff else None,
            })
    outs.put("external_validation_summary.csv", rows, inputs=["eurostat"],
             conditions={"eurostat": "avia_paoa, unit FLIGHT, tra_meas CAF_PAS (commercial passenger air flights, "
                                     "arrivals + departures), schedule TOTAL, tra_cov TOTAL",
                         "ours": "departures + arrivals at the airport in the Explore month files (both bases); "
                                 "class = aircraft-variant class, not the purpose of the flight"},
             thresholds={},
             method="Ratios are descriptive. The definitions differ (Eurostat: commercial passenger flights reported "
                    "by the airport; ours: ADS-B flights with an airline code and an assigned airport, classed by "
                    "aircraft), so agreement is not accuracy. C1_scaled multiplies by calendar/effective days of the "
                    "EU daily series (experimental).")
    return f"{len(rows)} airport-months"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", required=True)
    p.add_argument("--compare-dataset")
    p.add_argument("--data-root", default=str(ROOT / "public" / "data"))
    p.add_argument("--out")
    p.add_argument("--raw-flights", help="glob of the quarterly Parquet files (enables the hourly gap analysis)")
    p.add_argument("--eurostat-json")
    p.add_argument("--fetch-eurostat", action="store_true")
    p.add_argument("--focus-month", default="2026-08")
    p.add_argument("--low-ratio", type=float, default=0.8)
    p.add_argument("--high-ratio", type=float, default=1.25)
    p.add_argument("--window-days", type=int, default=28)
    p.add_argument("--gap-ratio", type=float, default=0.05)
    p.add_argument("--quality-region", default="WORLD")
    p.add_argument("--overwrite", action="store_true")
    a = p.parse_args()
    root = Path(a.data_root)
    cfg = Config(
        dataset_dir=root / a.dataset,
        compare_dir=root / a.compare_dataset if a.compare_dataset else None,
        out_dir=Path(a.out) if a.out else ROOT / "data" / "research" / a.dataset / "phase6b",
        raw_flights=[Path(x) for x in sorted(glob.glob(a.raw_flights))] if a.raw_flights else [],
        eurostat_json=Path(a.eurostat_json) if a.eurostat_json else None,
        fetch_eurostat=a.fetch_eurostat,
        focus_month=a.focus_month,
        detection=cov.DetectionConfig(window_days=a.window_days, low_ratio=a.low_ratio, high_ratio=a.high_ratio,
                                      gap_ratio=a.gap_ratio),
        normalisation_quality_region=a.quality_region,
        overwrite=a.overwrite,
    )
    res = run(cfg)
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
