"""
Phase 7 runner: compares the observed dataset with official statistics and writes the results.

  python pipeline/validation/report.py --dataset observed-2026-v2

Inputs: the dataset's research files, OurAirports (the same file as the build), and the external
files registered in pipeline/validation/external_inputs.lock.json (hash-checked before use). A
source whose files are missing is reported as "not run"; nothing is filled in.

Outputs go to data/research/<dataset>/phase7/ (outside public/, not deployed). Parquet tables are
not committed to Git (see docs/research-data-release.md); CSV/JSON summaries are.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import provenance  # noqa: E402
from analysis import network as net  # noqa: E402
from validation import anac, bts, common, compare, japan  # noqa: E402

SCRIPT_VERSION = "7.1"
ROOT = common.ROOT
NEARBY_KM = 40.0
TOP_N = 50

CENSUS_REGION = {
    **dict.fromkeys(["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"], "Northeast"),
    **dict.fromkeys(["IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE", "ND", "SD"], "Midwest"),
    **dict.fromkeys(["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV", "AL", "KY", "MS", "TN", "AR", "LA",
                     "OK", "TX"], "South"),
    **dict.fromkeys(["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI", "OR", "WA"], "West"),
}

LIMITATIONS = {
    "all_sources": [
        "Official statistics and ADS-B observations do not cover the same flights; agreement is a conditional "
        "external comparison, not accuracy.",
        "The observed month is UTC (track start); official months are usually local departure dates.",
        "Airport codes that match several OurAirports records, or none, are excluded (counts recorded).",
        "Tiers T1-T4 describe the evidence for the airports; no probability of correctness is attached.",
    ],
    "BTS_T100_SEGMENT": [
        "T-100 covers certificated U.S. carriers (all their segments) and foreign carriers on flights touching the "
        "U.S.; business aviation, general aviation and on-demand air taxis are not reported.",
        "Comparisons are restricted to routes with at least one U.S. airport (incl. territories).",
        "The carrier-matched condition uses an evidence-based crosswalk (route-vector similarity); unmatched "
        "airline codes are kept apart, not classified.",
        "2026-05 contains a 66-hour ADS-B collection gap (05-05 00:00 to 05-07 17:00 UTC); summaries are also "
        "given without May.",
    ],
    "ANAC": [
        "Dados Estatísticos covers Brazilian companies (all flights) and foreign companies (flights to/from Brazil); "
        "VRA covers scheduled flights only.",
        "GRUPO_DE_VOO 'IMPRODUTIVO' (non-revenue) flights are reported separately and compared separately.",
    ],
    "MLIT_AIR_TRANSPORT_FLASH": [
        "Only national domestic flight totals of Japanese carriers are available monthly; no route or airport "
        "flight counts. Flash (速報) figures can be revised.",
    ],
}


# ---- helpers -----------------------------------------------------------------------------------

def haversine(a, b) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


class Context:
    def __init__(self, dataset_dir: Path, out_dir: Path, ourairports: Path):
        import duckdb

        from airports import OVERRIDES, load_airports

        self.dataset_dir = dataset_dir
        self.out_dir = out_dir
        self.manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
        self.months = [m["month"] for m in self.manifest["months"]]
        con = duckdb.connect()
        load_airports(con, ourairports, OVERRIDES)
        self.resolver = common.AirportResolver.from_rows(dict(zip(
            ["rec_id", "canon", "iata", "local_code", "icao", "ident", "gps_code", "country"], r)) for r in con.execute(
            "SELECT r.rec_id, r.canon, r.iata, a.local_code, r.icao, r.ident, a.gps_code, r.country "
            "FROM ap_rec r JOIN ap_raw a ON a.id = r.rec_id").fetchall())
        self.info = {}
        for canon, country, continent, region, lat, lon, typ in con.execute(
                "SELECT r.canon, r.country, r.continent, a.iso_region, r.lat, r.lon, r.type "
                "FROM ap_rec r JOIN ap_raw a ON a.id = r.rec_id").fetchall():
            self.info.setdefault(canon, {"country": country, "continent": continent, "region": region,
                                         "pos": (lat, lon), "type": typ})
        pq = (dataset_dir / "research" / "routes_monthly.parquet").as_posix()
        self.rows = con.execute(f"""
            SELECT month, origin, destination, airline, class, tier, sum(flights)::BIGINT
            FROM read_parquet('{pq}') WHERE NOT coalesce(same_airport, false) AND tier <> 'X_unresolved'
            GROUP BY ALL ORDER BY ALL""").fetchall()
        self.observed_airports = {(r[0], r[1]) for r in self.rows} | {(r[0], r[2]) for r in self.rows}
        self.inputs = [{**provenance.InputFile("routes_monthly", dataset_dir / "research" / "routes_monthly.parquet").describe(),
                        "path": common._rel(dataset_dir / "research" / "routes_monthly.parquet")},
                       {**provenance.InputFile("ourairports", ourairports).describe(), "path": common._rel(ourairports)}]
        self.con = con
        self.written: list[str] = []

    def country(self, a: str) -> str:
        return (self.info.get(a) or {}).get("country") or ""

    def us_region(self, a: str) -> str:
        i = self.info.get(a) or {}
        if i.get("country") in common.US_AND_TERRITORIES - {"US"}:
            return "Territories"
        st = (i.get("region") or "").split("-")[-1]
        return CENSUS_REGION.get(st, "Unknown")

    def nearby(self, a: str, km: float = NEARBY_KM) -> set[str]:
        pos = (self.info.get(a) or {}).get("pos")
        if not pos:
            return set()
        if not hasattr(self, "_obs_pos"):
            self._obs_pos = {x: self.info[x]["pos"] for _, x in self.observed_airports if x in self.info}
        return {b for b, p in self._obs_pos.items() if b != a and abs(p[0] - pos[0]) < 1 and haversine(pos, p) <= km}

    def meta(self, name: str, *, source: str, external_files: list[dict], period: dict, conditions: dict,
             counts: dict, results: dict | None = None, limitations: list[str] | None = None) -> None:
        m = {
            "output": name, "externalSource": source,
            "dataset": {"id": self.manifest.get("datasetId"), "version": self.manifest.get("datasetVersion")},
            "externalFiles": external_files, "datasetInputs": self.inputs,
            "period": period, "conditions": conditions, "metricDefinitions": common.METRIC_DEFINITIONS,
            "counts": counts, "results": results or {},
            "limitations": LIMITATIONS["all_sources"] + (limitations or []),
            "generatedAt": provenance.now_utc(),
            "script": {"name": "pipeline/validation/report.py", "version": SCRIPT_VERSION, "git": provenance.git_state()},
        }
        common.write_json(self.out_dir / (name.rsplit(".", 1)[0] + ".meta.json"), m)

    def write_parquet(self, name: str, rows: list[dict], columns: list[str]) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "t.csv"
            common.write_csv(tmp, rows, columns)
            self.con.execute(f"COPY (SELECT * FROM read_csv('{tmp.as_posix()}', header=true, all_varchar=false)) "
                             f"TO '{(self.out_dir / name).as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        self.written.append(name)

    def write_csv(self, name: str, rows: list[dict], columns: list[str] | None = None) -> None:
        common.write_csv(self.out_dir / name, rows, columns)
        self.written.append(name)

    def write_json(self, name: str, data) -> None:
        common.write_json(self.out_dir / name, data)
        self.written.append(name)


def verified_files(source_prefix: str, names: list[str]) -> list[dict]:
    reg = common.load_registry()
    out = []
    for n in names:
        e = reg["files"].get(n)
        if e is None:
            continue
        path = ROOT / e["path"]
        if not path.exists():
            continue
        common.verify(path)
        out.append({**e, "file": n})
    return out


def obs_by_airline(rows, scope, months) -> dict[str, dict]:
    out: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    ms = set(months)
    for ym, o, d, al, _cls, _tier, n in rows:
        if ym in ms and o and d and o != d and scope(o, d):
            out[al][(ym, o, d)] += n
    return {k: dict(v) for k, v in out.items()}


def month_sets(months: list[str], gap_month: str = "2026-05") -> dict[str, list[str]]:
    sets = {m: [m] for m in months}
    sets["all"] = list(months)
    if gap_month in months:
        sets[f"all_excl_{gap_month}"] = [m for m in months if m != gap_month]
    return sets


def condition_grid(ctx: Context, *, source: str, months: list[str], reported_sets: dict[str, dict],
                   observed_sets: dict[str, dict], scope_name: str) -> list[dict]:
    """Metrics for every (months, reported class set, observed scope, tiers, direction, threshold)."""
    out = []
    for ms_name, ms in month_sets(months).items():
        mset = set(ms)
        for rep_name, rep_all in reported_sets.items():
            rep_m = {k: v for k, v in rep_all.items() if k[0] in mset}
            for obs_name, obs_by_tier in observed_sets.items():
                for tier_name, obs_all in obs_by_tier.items():
                    if obs_name.endswith("matched") and not rep_name.endswith("matched"):
                        continue
                    if not obs_name.endswith("matched") and rep_name.endswith("matched"):
                        continue
                    obs_m = {k: v for k, v in obs_all.items() if k[0] in mset}
                    for direction in ("directed", "undirected"):
                        a = obs_m if direction == "directed" else compare.undirected(obs_m)
                        b = rep_m if direction == "directed" else compare.undirected(rep_m)
                        for k in compare.THRESHOLDS:
                            c = compare.compare_routes(a, b, k)
                            v = c.pop("volume")
                            out.append({"source": source, "scope": scope_name, "months": ms_name,
                                        "reported": rep_name, "observed": obs_name, "tiers": tier_name,
                                        "direction": direction, **c,
                                        **{f"vol_{x}": v.get(x) for x in ("n", "sum_observed", "sum_reported", "MAE",
                                                                         "RMSE", "WAPE", "bias", "pearson", "spearman",
                                                                         "rel_error_median", "rel_error_p10",
                                                                         "rel_error_p90", "share_within_10pct",
                                                                         "share_within_25pct")}})
    return out


def tier_split(rows, *, scope, months, airlines=None) -> dict[str, dict]:
    return {name: compare.observed_counts(rows, tiers=tiers, scope=scope, months=months, airlines=airlines)
            for name, tiers in compare.TIER_SETS.items()}


def route_detail_rows(ctx: Context, obs_tiers: dict[str, dict], rep: dict, rep_by_class: dict[str, dict],
                      obs_all_airlines: dict, airline_mix: dict) -> list[dict]:
    keys = set(rep) | set(obs_tiers["T1-T4"]) | set(obs_all_airlines)
    rows = []
    for k in sorted(keys):
        ym, o, d = k
        t1 = obs_tiers["T1"].get(k, 0)
        t12 = obs_tiers["T1-T2"].get(k, 0)
        t13 = obs_tiers["T1-T3"].get(k, 0)
        t14 = obs_tiers["T1-T4"].get(k, 0)
        b = rep.get(k, 0)
        rows.append({
            "month": ym, "origin": o, "destination": d,
            "origin_country": ctx.country(o), "destination_country": ctx.country(d),
            "observed_T1": t1, "observed_T2": t12 - t1, "observed_T3": t13 - t12, "observed_T4": t14 - t13,
            "observed_matched_total": t14, "observed_all_airlines": obs_all_airlines.get(k, 0),
            "reported_total": b, **{f"reported_{c}": v.get(k, 0) for c, v in rep_by_class.items()},
            "abs_error": t14 - b, "rel_error": common.rel_error(t14, b, 10),
            "top_airlines": ";".join(f"{a}:{n}" for a, n in Counter(airline_mix.get(k, {})).most_common(3)),
        })
    return rows


def diagnose_missing(ctx: Context, k, obs_any: dict, obs_dir_all: dict) -> dict:
    """Possible reasons for a route the statistic lists but the observations do not."""
    ym, o, d = k
    near_o, near_d = ctx.nearby(o), ctx.nearby(d)
    subst = sum(n for (m, a, b), n in obs_dir_all.items() if m == ym and
                ((a == o and b in near_d) or (a in near_o and b == d) or (a in near_o and b in near_d)))
    return {
        "reverse_observed": obs_any.get((ym, d, o), 0),
        "observed_any_airline": obs_any.get(k, 0),
        "origin_in_observed": (ym, o) in ctx.observed_airports,
        "destination_in_observed": (ym, d) in ctx.observed_airports,
        "nearby_substitute_flights": subst,
    }


def extremes(ctx: Context, detail: list[dict], obs_any: dict, obs_dir_all: dict, min_rep: int = 30) -> dict:
    over = sorted((r for r in detail if r["reported_total"] >= min_rep), key=lambda r: -(r["abs_error"]))[:TOP_N]
    under = sorted((r for r in detail if r["reported_total"] >= min_rep), key=lambda r: r["abs_error"])[:TOP_N]
    missing = sorted((r for r in detail if r["reported_total"] >= 1 and r["observed_matched_total"] == 0),
                     key=lambda r: -r["reported_total"])[:TOP_N]
    extra = sorted((r for r in detail if r["reported_total"] == 0 and r["observed_all_airlines"] >= 1),
                   key=lambda r: -r["observed_all_airlines"])[:TOP_N]
    for r in missing:
        r.update(diagnose_missing(ctx, (r["month"], r["origin"], r["destination"]), obs_any, obs_dir_all))
    return {"over_counted": over, "under_counted": under, "reported_not_observed": missing,
            "observed_not_reported": extra}


def airport_rows(ctx: Context, obs: dict, rep: dict, obs_all: dict, source: str, tiers: str) -> list[dict]:
    ao, ar, aa = compare.airport_movements(obs), compare.airport_movements(rep), compare.airport_movements(obs_all)
    out = []
    for key in sorted(set(ao) | set(ar)):
        ym, ap = key
        a, b = ao.get(key, 0), ar.get(key, 0)
        out.append({"source": source, "tiers": tiers, "month": ym, "airport": ap, "country": ctx.country(ap),
                    "region": ctx.us_region(ap) if ctx.country(ap) in common.US_AND_TERRITORIES else ctx.country(ap),
                    "observed": a, "reported": b, "observed_all_airlines": aa.get(key, 0),
                    "ratio": round(a / b, 4) if b else None, "rel_error": common.rel_error(a, b, 100)})
    return out


def ranking_comparison(obs: dict, rep: dict, k: int = 20) -> dict:
    so = defaultdict(float)
    sr = defaultdict(float)
    for (_ym, ap), v in compare.airport_movements(obs).items():
        so[ap] += v
    for (_ym, ap), v in compare.airport_movements(rep).items():
        sr[ap] += v
    c = net.compare_rankings(dict(sr), dict(so), k)
    return {"spearman_union_top20": c["spearman_union_topk"], "jaccard_top20": c["jaccard_topk"],
            "entered": c["entered"], "left": c["left"],
            "top_reported": [a for a, _ in net.ranking(dict(sr))[:k]],
            "top_observed": [a for a, _ in net.ranking(dict(so))[:k]]}


# ---- BTS ---------------------------------------------------------------------------------------

def run_bts(ctx: Context) -> dict:
    names = sorted(n for n, e in common.load_registry()["files"].items() if e["source"] == bts.SOURCE)
    files = verified_files(bts.SOURCE, names)
    if not files:
        return {"status": "not run: no registered T-100 files"}
    records = []
    for f in files:
        records += bts.read_zip(ROOT / f["path"])
    months = sorted({r.ym for r in records} & set(ctx.months))
    us = common.US_AND_TERRITORIES
    scope = lambda o, d: ctx.country(o) in us or ctx.country(d) in us  # noqa: E731
    domestic = lambda o, d: ctx.country(o) in us and ctx.country(d) in us  # noqa: E731

    rep_sets, rep_carrier, excl = {}, {}, {}
    for name, classes in bts.CLASS_SETS.items():
        c, byc, ex = compare.resolve_external(records, ctx.resolver, classes, months)
        rep_sets[name] = compare.restrict(c, scope)
        rep_carrier[name] = {car: compare.restrict(v, scope) for car, v in byc.items()}
        excl[name] = ex
    unres = compare.unresolved_codes((r for r in records if r.ym in set(months)), ctx.resolver)

    # crosswalk on all reported classes
    oba = obs_by_airline(ctx.rows, scope, months)
    cw = compare.carrier_crosswalk(oba, rep_carrier["all_reported"])
    matched = {x["airline"]: x["carrier"] for x in cw if x["status"] == "matched"}
    mcar = set(matched.values())
    ctx.write_csv("bts_carrier_crosswalk.csv", cw)
    ctx.meta("bts_carrier_crosswalk.csv", source=bts.SOURCE, external_files=files,
             period={"months": months}, conditions={"method": compare.carrier_crosswalk.__doc__,
                                                    "min_flights": 200, "min_cosine": 0.7, "min_margin": 0.15,
                                                    "volume_range": [0.5, 2.0]},
             counts={"candidates": len(cw), "matched": len(matched)})

    rep_matched = {}
    for name in bts.CLASS_SETS:
        acc = defaultdict(float)
        for car, v in rep_carrier[name].items():
            if car in mcar:
                for k, n in v.items():
                    acc[k] += n
        rep_matched[name] = dict(acc)
    reported_sets = {**rep_sets, **{f"{k}_carrier_matched": v for k, v in rep_matched.items()}}
    observed_sets = {"all_airlines": tier_split(ctx.rows, scope=scope, months=months),
                     "carrier_matched": tier_split(ctx.rows, scope=scope, months=months, airlines=set(matched))}
    grid = condition_grid(ctx, source=bts.SOURCE, months=months, reported_sets=reported_sets,
                          observed_sets=observed_sets, scope_name="US-touching")
    # domestic-only grid for the headline conditions
    dom_rep = {f"{k}_carrier_matched": compare.restrict(v, domestic) for k, v in rep_matched.items()}
    dom_obs = {"carrier_matched": {t: compare.restrict(v, domestic) for t, v in observed_sets["carrier_matched"].items()}}
    grid += condition_grid(ctx, source=bts.SOURCE, months=months, reported_sets=dom_rep, observed_sets=dom_obs,
                           scope_name="US-domestic")
    ctx.write_csv("bts_condition_metrics.csv", grid)

    # route detail (headline condition: carrier matched, all reported classes)
    obs_any = compare.observed_counts(ctx.rows, scope=scope, months=months)
    mix = defaultdict(Counter)
    for ym, o, d, al, _c, _t, n in ctx.rows:
        if ym in set(months) and o and d and scope(o, d):
            mix[(ym, o, d)][al] += n
    rep_by_class = {}
    for cls in bts.SERVICE_CLASSES:
        c, byc, _ = compare.resolve_external(records, ctx.resolver, (cls,), months)
        acc = defaultdict(float)
        for car, v in byc.items():
            if car in mcar:
                for k, n in v.items():
                    if scope(k[1], k[2]):
                        acc[k] += n
        rep_by_class[cls] = dict(acc)
    detail = route_detail_rows(ctx, observed_sets["carrier_matched"], rep_matched["all_reported"], rep_by_class,
                               obs_any, mix)
    cols = list(detail[0].keys())
    ctx.write_parquet("bts_route_comparison.parquet", detail, cols)
    ext = extremes(ctx, [r for r in detail if r["month"] != "2026-05"], obs_any, obs_any)
    ctx.write_json("bts_route_extremes.json", ext)

    # airports
    ap = airport_rows(ctx, observed_sets["carrier_matched"]["T1-T4"], rep_matched["all_reported"], obs_any, bts.SOURCE, "T1-T4")
    ap += airport_rows(ctx, observed_sets["carrier_matched"]["T1-T3"], rep_matched["all_reported"], obs_any, bts.SOURCE, "T1-T3")

    # tiers: support rates, monthly, regions, rankings
    tier_rows = []
    exclusive = {"T1": ("T1_track",), "T2": ("T2_track_conflict",), "T3": ("T3_track_callsign",),
                 "T4": ("T4_callsign_only",)}
    rep_any = rep_matched["all_reported"]
    for m in months:
        for name, tiers in exclusive.items():
            for scope_name, sc in (("US-touching", scope), ("US-domestic", domestic)):
                o = compare.observed_counts(ctx.rows, tiers=tiers, scope=sc, months=[m], airlines=set(matched))
                s = compare.route_support_rate(o, rep_any)
                tier_rows.append({"month": m, "tier": name, "scope": scope_name, **s})
    rank = {}
    excl_may = [m for m in months if m != "2026-05"]
    for name, obs in observed_sets["carrier_matched"].items():
        o = {k: v for k, v in obs.items() if k[0] in set(excl_may)}
        r = {k: v for k, v in rep_any.items() if k[0] in set(excl_may)}
        rank[name] = ranking_comparison(o, r)
    region_rows = []
    for name, obs in observed_sets["carrier_matched"].items():
        for grp in ("Northeast", "Midwest", "South", "West", "Territories"):
            sc = lambda o, d, g=grp: domestic(o, d) and g in (ctx.us_region(o), ctx.us_region(d))  # noqa: E731
            a = {k: v for k, v in compare.restrict(obs, sc).items() if k[0] in set(excl_may)}
            b = {k: v for k, v in compare.restrict(rep_any, sc).items() if k[0] in set(excl_may)}
            c = compare.compare_routes(a, b, 10)
            region_rows.append({"tiers": name, "group": f"US {grp}", "months": "all_excl_2026-05", **{
                x: c[x] for x in ("both", "only_observed", "only_reported", "share_reported_found",
                                  "reported_routes_absent_in_observed")}, **{f"vol_{x}": c["volume"].get(x) for x in
                                                                              ("n", "WAPE", "bias", "spearman")}})
        conts = sorted({(ctx.info.get(x) or {}).get("continent") or "?" for k in rep_any for x in k[1:]
                        if ctx.country(x) not in us})
        for cont in conts:
            sc = lambda o, d, c_=cont: scope(o, d) and not domestic(o, d) and c_ in (  # noqa: E731
                (ctx.info.get(o) or {}).get("continent"), (ctx.info.get(d) or {}).get("continent"))
            a = {k: v for k, v in compare.restrict(obs, sc).items() if k[0] in set(excl_may)}
            b = {k: v for k, v in compare.restrict(rep_any, sc).items() if k[0] in set(excl_may)}
            c = compare.compare_routes(a, b, 10)
            region_rows.append({"tiers": name, "group": f"international {cont}", "months": "all_excl_2026-05", **{
                x: c[x] for x in ("both", "only_observed", "only_reported", "share_reported_found",
                                  "reported_routes_absent_in_observed")}, **{f"vol_{x}": c["volume"].get(x) for x in
                                                                              ("n", "WAPE", "bias", "spearman")}})
    ctx.write_csv("bts_region_summary.csv", region_rows)
    ctx.write_csv("bts_tier_support.csv", tier_rows)

    # unmatched airline codes on US routes (outside T-100 carrier scope or not identified)
    unmatched = sorted(((al, sum(v.values())) for al, v in oba.items() if al not in matched), key=lambda x: -x[1])
    tot_obs = sum(sum(v.values()) for v in oba.values())
    rep_total = sum(sum(v.values()) for v in rep_carrier["all_reported"].values())
    rep_mt = sum(sum(v.values()) for c, v in rep_carrier["all_reported"].items() if c in mcar)
    summary = {
        "months": months,
        "records": len(records),
        "exclusions_by_class_set": excl,
        "unresolved_codes_top": [{"code": c, "country": sorted(k) if isinstance(k, frozenset) else k, "reason": m,
                                  "flights": f} for (c, k, m), f in unres.most_common(30)],
        "crosswalk": {"matched_codes": len(matched),
                      "observed_US_flights_matched_share": round(sum(sum(oba[a].values()) for a in matched) / tot_obs, 4),
                      "reported_flights_matched_share": round(rep_mt / rep_total, 4),
                      "top_unmatched_codes": unmatched[:25]},
        "rankings_vs_reported_excl_may": rank,
    }
    ctx.write_json("bts_summary.json", summary)
    for name in ("bts_condition_metrics.csv", "bts_route_comparison.parquet", "bts_route_extremes.json",
                 "bts_region_summary.csv", "bts_tier_support.csv", "bts_summary.json"):
        ctx.meta(name, source=bts.SOURCE, external_files=files, period={"months": months},
                 conditions={"class_sets": bts.CLASS_SETS, "tier_sets": compare.TIER_SETS,
                             "thresholds": compare.THRESHOLDS, "scope": "routes with >= 1 U.S. airport",
                             "carrier_matched": "observed airline codes matched to T-100 carriers (bts_carrier_crosswalk.csv)",
                             "reported_flights": "DEPARTURES_PERFORMED"},
                 counts={"records": len(records), "route_months_detail": len(detail)},
                 limitations=LIMITATIONS["BTS_T100_SEGMENT"])
    return {"status": "run", "months": months, "airports": ap, "summary": summary, "grid": grid}


# ---- ANAC --------------------------------------------------------------------------------------

def run_anac(ctx: Context) -> dict:
    reg = common.load_registry()["files"]
    stats = verified_files(anac.SOURCE_STATS, [n for n, e in reg.items() if e["source"] == anac.SOURCE_STATS])
    vra = verified_files(anac.SOURCE_VRA, sorted(n for n, e in reg.items() if e["source"] == anac.SOURCE_VRA))
    if not stats and not vra:
        return {"status": "not run: no registered ANAC files"}
    br = lambda o, d: ctx.country(o) == "BR" or ctx.country(d) == "BR"  # noqa: E731
    dom = lambda o, d: ctx.country(o) == "BR" and ctx.country(d) == "BR"  # noqa: E731
    out = {"status": "run"}
    sources = []
    if stats:
        recs = anac.read_stats(ROOT / stats[0]["path"], int(ctx.months[0][:4]))
        sources.append(("ANAC_DADOS_ESTATISTICOS", recs, stats))
    if vra:
        recs = []
        for f in vra:
            recs += anac.read_vra(ROOT / f["path"])
        sources.append(("ANAC_VRA", recs, vra))
    grid, detail_all, airports, extremes_all, summaries = [], [], [], {}, {}
    for src, recs, files in sources:
        months = sorted({r.ym for r in recs} & set(ctx.months))
        classes = sorted({r.service_class for r in recs})
        carriers = {r.carrier for r in recs}
        rep_sets, excl = {}, {}
        sets = {"all": None}
        if src == "ANAC_DADOS_ESTATISTICOS":
            sets = {"revenue": [c for c in classes if not c.endswith("IMPRODUTIVO")],
                    "regular": [c for c in classes if c.endswith("/REGULAR")],
                    "all_incl_non_revenue": None}
        for name, cls in sets.items():
            c, byc, ex = compare.resolve_external(recs, ctx.resolver, cls, months)
            rep_sets[f"{name}_carrier_matched"] = compare.restrict(c, br)
            excl[name] = ex
        obs_sets = {"carrier_matched": tier_split(ctx.rows, scope=br, months=months, airlines=carriers)}
        grid += condition_grid(ctx, source=src, months=months, reported_sets=rep_sets, observed_sets=obs_sets,
                               scope_name="Brazil-touching")
        dom_rep = {k: compare.restrict(v, dom) for k, v in rep_sets.items()}
        dom_obs = {"carrier_matched": {t: compare.restrict(v, dom) for t, v in obs_sets["carrier_matched"].items()}}
        grid += condition_grid(ctx, source=src, months=months, reported_sets=dom_rep, observed_sets=dom_obs,
                               scope_name="Brazil-domestic")
        head = list(rep_sets)[0]
        obs_any = compare.observed_counts(ctx.rows, scope=br, months=months)
        mix = defaultdict(Counter)
        for ym, o, d, al, _c, _t, n in ctx.rows:
            if ym in set(months) and o and d and br(o, d):
                mix[(ym, o, d)][al] += n
        by_cls = {}
        for cls in classes:
            c, _, _ = compare.resolve_external(recs, ctx.resolver, (cls,), months)
            by_cls[cls.replace("/", "_").replace(" ", "_")] = compare.restrict(c, br)
        detail = route_detail_rows(ctx, obs_sets["carrier_matched"], rep_sets[head], by_cls, obs_any, mix)
        for r in detail:
            r["source"] = src
        detail_all.append((src, detail))
        extremes_all[src] = extremes(ctx, [r for r in detail if r["month"] != "2026-05"], obs_any, obs_any)
        airports += airport_rows(ctx, obs_sets["carrier_matched"]["T1-T4"], rep_sets[head], obs_any, src, "T1-T4")
        tiers = []
        for m in months:
            for tn, tset in {"T1": ("T1_track",), "T2": ("T2_track_conflict",), "T3": ("T3_track_callsign",),
                             "T4": ("T4_callsign_only",)}.items():
                o = compare.observed_counts(ctx.rows, tiers=tset, scope=dom, months=[m], airlines=carriers)
                tiers.append({"source": src, "month": m, "tier": tn, "scope": "Brazil-domestic",
                              **compare.route_support_rate(o, compare.restrict(rep_sets[head], dom))})
        # regional (by the Brazilian end's state region, from OurAirports iso_region)
        reg_rows = []
        excl_may = set(m for m in months if m != "2026-05")
        for tn, obs in obs_sets["carrier_matched"].items():
            regions = sorted({(ctx.info.get(x) or {}).get("region") or "?" for k in rep_sets[head] for x in k[1:]
                              if ctx.country(x) == "BR"})
            for rg in regions:
                sc = lambda o, d, r_=rg: dom(o, d) and r_ in ((ctx.info.get(o) or {}).get("region"),  # noqa: E731
                                                               (ctx.info.get(d) or {}).get("region"))
                a = {k: v for k, v in compare.restrict(obs, sc).items() if k[0] in excl_may}
                b = {k: v for k, v in compare.restrict(rep_sets[head], sc).items() if k[0] in excl_may}
                c = compare.compare_routes(a, b, 10)
                reg_rows.append({"source": src, "tiers": tn, "state": rg, **{
                    x: c[x] for x in ("both", "only_observed", "only_reported", "share_reported_found",
                                      "reported_routes_absent_in_observed", "reported_flights_on_those")},
                    **{f"vol_{x}": c["volume"].get(x) for x in ("n", "sum_observed", "sum_reported", "WAPE", "bias")}})
        summaries[src] = {"months": months, "records": len(recs), "classes": classes, "exclusions": excl,
                          "files": files, "tier_support": tiers, "regions": reg_rows,
                          "unresolved_codes_top": [{"code": c, "reason": m, "flights": f} for (c, _k, m), f in
                                                   compare.unresolved_codes(recs, ctx.resolver).most_common(20)],
                          "rankings_vs_reported_excl_may": {
                              tn: ranking_comparison({k: v for k, v in obs.items() if k[0] in excl_may},
                                                     {k: v for k, v in rep_sets[head].items() if k[0] in excl_may})
                              for tn, obs in obs_sets["carrier_matched"].items()}}
    ctx.write_csv("anac_condition_metrics.csv", grid)
    for src, detail in detail_all:
        cols = sorted({c for r in detail for c in r}, key=lambda c: (c != "source", c))
        ctx.write_parquet(f"anac_route_comparison_{src.split('_', 1)[1].lower()}.parquet", detail, cols)
    ctx.write_json("anac_route_extremes.json", extremes_all)
    ctx.write_json("anac_summary.json", summaries)
    files_all = [f for _s, _r, fs in sources for f in fs]
    for name in ["anac_condition_metrics.csv", "anac_route_extremes.json", "anac_summary.json"] + \
            [f"anac_route_comparison_{s.split('_', 1)[1].lower()}.parquet" for s, _ in detail_all]:
        ctx.meta(name, source="ANAC", external_files=files_all,
                 period={"months": sorted({m for s in summaries.values() for m in s["months"]})},
                 conditions={"scope": "routes with >= 1 Brazilian airport",
                             "carrier_matched": "observed airline codes that appear in the ANAC file (ICAO codes)",
                             "dados_estatisticos": "DECOLAGENS by NATUREZA/GRUPO_DE_VOO",
                             "vra": "flights with Situação Voo = REALIZADO", "tier_sets": compare.TIER_SETS,
                             "thresholds": compare.THRESHOLDS},
                 counts={s: {"records": v["records"]} for s, v in summaries.items()},
                 limitations=LIMITATIONS["ANAC"])
    out.update({"airports": airports, "summaries": summaries, "grid": grid})
    return out


# ---- Japan -------------------------------------------------------------------------------------

def run_japan(ctx: Context) -> dict:
    reg = common.load_registry()["files"]
    files = verified_files(japan.SOURCE, sorted(n for n, e in reg.items() if e["source"] == japan.SOURCE))
    if not files:
        return {"status": "not run: no registered MLIT files"}
    jp = lambda o, d: ctx.country(o) == "JP" and ctx.country(d) == "JP"  # noqa: E731
    rows = []
    for f in files:
        ym = f["file"].removeprefix("koku_sokuho_").removesuffix(".xlsx").replace("_", "-")
        if ym not in ctx.months:
            continue
        nat = japan.national_flights(ROOT / f["path"])
        rep = nat["domestic_scheduled"] + nat["domestic_other"]
        for tn, tiers in compare.TIER_SETS.items():
            obs = sum(compare.observed_counts(ctx.rows, tiers=tiers, scope=jp, months=[ym]).values())
            rows.append({"source": japan.SOURCE, "month": ym, "tiers": tn, "observed_jp_domestic": obs,
                         "reported_domestic_scheduled": nat["domestic_scheduled"],
                         "reported_domestic_other": nat["domestic_other"], "reported_domestic_total": rep,
                         "ratio": round(obs / rep, 4) if rep else None})
    ctx.write_csv("japan_national_comparison.csv", rows)
    ctx.meta("japan_national_comparison.csv", source=japan.SOURCE, external_files=files,
             period={"months": sorted({r["month"] for r in rows})},
             conditions={"observed": "flights with both airports in Japan, all airline codes, by tier set",
                         "reported": "運航回数, 国内定期 + 国内その他 (Japanese carriers)"},
             counts={"months": len({r["month"] for r in rows})}, limitations=LIMITATIONS["MLIT_AIR_TRANSPORT_FLASH"])
    return {"status": "run", "rows": rows}


# ---- main --------------------------------------------------------------------------------------

def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", default="observed-2026-v2")
    p.add_argument("--data-root", default=str(ROOT / "public" / "data"))
    p.add_argument("--ourairports", default=str(ROOT / "data" / "raw" / "ourairports" / "airports.csv"))
    p.add_argument("--out")
    p.add_argument("--sources", default="bts,anac,japan")
    a = p.parse_args()
    out = Path(a.out) if a.out else ROOT / "data" / "research" / a.dataset / "phase7"
    out.mkdir(parents=True, exist_ok=True)
    ctx = Context(Path(a.data_root) / a.dataset, out, Path(a.ourairports))
    print(f"observed rows: {len(ctx.rows)}")
    results = {}
    srcs = a.sources.split(",")
    if "bts" in srcs:
        results["BTS_T100_SEGMENT"] = run_bts(ctx)
        print("BTS:", results["BTS_T100_SEGMENT"]["status"])
    if "anac" in srcs:
        results["ANAC"] = run_anac(ctx)
        print("ANAC:", results["ANAC"]["status"])
    if "japan" in srcs:
        results["MLIT"] = run_japan(ctx)
        print("MLIT:", results["MLIT"]["status"])

    airports = [r for k in ("BTS_T100_SEGMENT", "ANAC") for r in results.get(k, {}).get("airports", [])]
    if airports:
        ctx.write_csv("airport_validation.csv", airports)
        ctx.meta("airport_validation.csv", source="BTS_T100_SEGMENT, ANAC", external_files=[],
                 period={"months": ctx.months}, conditions={"movements": "departures + arrivals per airport-month",
                                                            "observed": "carrier-matched airline codes"},
                 counts={"rows": len(airports)})
    headline = []
    for src, res in results.items():
        for r in res.get("grid", []):
            if (r["direction"] == "directed" and r["min_flights"] in (1, 10, 30)
                    and r["months"] in ("all", "all_excl_2026-05")):
                headline.append(r)
        for r in res.get("rows", []):
            headline.append({"source": r["source"], "scope": "Japan-domestic (national total)", "months": r["month"],
                             "reported": "domestic scheduled + other", "observed": "all_airlines", "tiers": r["tiers"],
                             "direction": "", "min_flights": "", "vol_sum_observed": r["observed_jp_domestic"],
                             "vol_sum_reported": r["reported_domestic_total"],
                             "vol_bias": round(r["ratio"] - 1, 4) if r["ratio"] else None})
    cols = sorted({c for r in headline for c in r}, key=lambda c: (
        ["source", "scope", "months", "reported", "observed", "tiers", "direction", "min_flights"].index(c)
        if c in ["source", "scope", "months", "reported", "observed", "tiers", "direction", "min_flights"] else 99, c))
    ctx.write_csv("external_validation_summary.csv", headline, cols)
    ctx.meta("external_validation_summary.csv", source="all", external_files=[], period={"months": ctx.months},
             conditions={"selection": "directed routes, thresholds 1/10/30, all months and all months without May"},
             counts={"rows": len(headline)})
    ctx.write_json("validation_metrics.json", {
        "definitions": common.METRIC_DEFINITIONS,
        "thresholds": compare.THRESHOLDS, "tier_sets": compare.TIER_SETS,
        "status": {k: v.get("status") for k, v in results.items()},
    })
    ctx.write_json("validation_limitations.json", LIMITATIONS | {
        "not_run": {k: v["status"] for k, v in results.items() if str(v.get("status", "")).startswith("not run")}})
    print(json.dumps({"written": ctx.written}, indent=1))


if __name__ == "__main__":
    main()
