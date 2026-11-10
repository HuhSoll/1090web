"""
Builds a public dataset from the raw quarterly flight schedules (ADS-B, MrAirspace, ODbL).

Outputs (in <out_dir>, e.g. public/data/observed-2026-v2/):
  Explore format (unchanged schema, read by the web app)
    manifest.json, airports.json, routes.json, months/YYYY-MM.json
  Research files (research/)
    routes_monthly.parquet   directed flights by month x origin x destination x airline x class
                             x origin rule x destination rule x conflict flags x tier
    airports.csv             canonical airports in the data
    airport_aliases.csv      codes merged into a canonical airport, and unresolved code collisions
    coverage_daily.csv       flights per day and region, with a suspected-gap DETECTION flag
    README.md                column definitions and caveats
  provenance.json            dataset version, inputs + SHA-256, rules, git commit, environment

Airport resolution, per end of every flight (thresholds below):
  R1  track end on the ground or <= NEAR_AIRPORT_FT, exactly one candidate airport
  R2  same, several candidates; nearest taken when the runner-up is >= AMBIGUOUS_KM further
  R3  the callsign-route airport is among the track-end candidates
  R4  only the callsign route names an airport
  R5  not resolvable
Candidates are de-duplicated by OurAirports record, so the old and new code of one airport count
as one candidate (see airports.py).

Confidence tiers, per flight (research use; "track" does not mean certain):
  T1_track            both ends R1/R2, the callsign route agrees or is absent
  T2_track_conflict   both ends R1/R2, the callsign route names another airport on >= 1 end
  T3_track_callsign   both ends R1-R3, >= 1 end R3
  T4_callsign_only    >= 1 end R4 (and no R5)
  X_unresolved        >= 1 end R5 (excluded from the network)
The Explore files keep the earlier two-level basis: 0 = T1-T3, 1 = T4.

Usage:
  python pipeline/build_dataset.py --dataset observed-2026-v2 --version 2.0.0
  python pipeline/build_dataset.py --dataset scratch --months 2026-01 --no-lock
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import sys

import duckdb

# Sibling modules (airports, provenance) must import even under `python -I` (isolated mode).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from airports import aliases_sql, load_airports  # noqa: E402
import provenance  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
REF = ROOT / "pipeline" / "reference"

# A track end at or below this altitude is close enough to an airport to count as observed.
NEAR_AIRPORT_FT = 3000
# Two candidate airports closer than this to each other (relative to the track end) are ambiguous.
AMBIGUOUS_KM = 1.0
# Coverage detection: a day is flagged when its flights fall below this share of the median of the
# same weekday within +-COVERAGE_WINDOW_DAYS (detection only, nothing is corrected).
COVERAGE_LOW_RATIO = 0.8
COVERAGE_WINDOW_DAYS = 28

RULESET = {
    "version": "2026.11-r2",
    "nearAirportFt": NEAR_AIRPORT_FT,
    "ambiguousKm": AMBIGUOUS_KM,
    "candidateDedupe": "by OurAirports record",
    "excludedAirportTypes": ["heliport", "balloonport", "closed"],
    "scope": "flights with an airline code; month of origin time (else destination time) must lie in the file's quarter",
    "sameAirport": "excluded from the network, counted",
    "coverage": {"lowRatio": COVERAGE_LOW_RATIO, "windowDays": COVERAGE_WINDOW_DAYS, "use": "detection only"},
}
EXPLORE_SCHEMA_VERSION = 1
RESEARCH_SCHEMA_VERSION = 1


@dataclass
class BuildConfig:
    flight_files: list[Path]
    ourairports_csv: Path
    classes_csv: Path
    out_dir: Path
    dataset_id: str
    dataset_version: str
    year: int = 2026
    months: list[str] | None = None
    quality_path: Path | None = None
    lock_path: Path | None = provenance.LOCK_PATH
    record_git: bool = True
    log: callable = field(default=print)


# ---- SQL stages ------------------------------------------------------------------------------


def load_flights(con, cfg: BuildConfig) -> dict:
    files = ", ".join(f"'{p.as_posix()}'" for p in cfg.flight_files)
    month_filter = ""
    if cfg.months:
        month_filter = "AND strftime(ref_time, '%Y-%m') IN (" + ", ".join(f"'{m}'" for m in cfg.months) + ")"
    con.execute(f"""
    CREATE OR REPLACE TABLE raw AS
    SELECT *, regexp_extract(filename, '_Q(\\d)_', 1)::INT AS quarter
    FROM read_parquet([{files}], filename = true);

    CREATE OR REPLACE TABLE flights AS
    WITH t AS (
      SELECT *,
        TRY_CAST(CASE WHEN Track_Origin_DateTime_UTC <> '-' THEN Track_Origin_DateTime_UTC
                      ELSE Track_Destination_DateTime_UTC END AS TIMESTAMP) AS ref_time
      FROM raw)
    SELECT
      row_number() OVER (ORDER BY quarter, ICAO_Hex, Track_Origin_DateTime_UTC, Track_Destination_DateTime_UTC,
                                  Callsign, Track_Origin_ApplicableAirports, Track_Destination_ApplicableAirports) AS fid,
      quarter, ref_time, ref_time::DATE AS day, strftime(ref_time, '%Y-%m') AS month,
      Airline AS airline, AC_Type AS ac_type, AC_Type_Detailed AS ac_type_detailed,
      regexp_extract_all(Track_Origin_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS org_cands,
      regexp_extract_all(Track_Destination_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS dst_cands,
      TRY_CAST(Track_Origin_Lat AS DOUBLE) AS org_lat, TRY_CAST(Track_Origin_Lon AS DOUBLE) AS org_lon,
      TRY_CAST(Track_Destination_Lat AS DOUBLE) AS dst_lat, TRY_CAST(Track_Destination_Lon AS DOUBLE) AS dst_lon,
      coalesce(Track_Origin_FL_Ft = 'ground' OR TRY_CAST(Track_Origin_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}, false) AS org_near,
      coalesce(Track_Destination_FL_Ft = 'ground' OR TRY_CAST(Track_Destination_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}, false) AS dst_near,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 1) END AS val_org,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 2) END AS val_dst
    FROM t
    WHERE Airline <> '-'
      AND ref_time IS NOT NULL
      AND year(ref_time) = {cfg.year}
      AND (month(ref_time) - 1) // 3 + 1 = quarter
      {month_filter};
    """)
    stats = {
        "raw_rows": con.execute("SELECT count(*) FROM raw").fetchone()[0],
        "raw_rows_without_airline": con.execute("SELECT count(*) FROM raw WHERE Airline = '-'").fetchone()[0],
        "flights_in_scope": con.execute("SELECT count(*) FROM flights").fetchone()[0],
    }
    if not cfg.months:
        stats["removed_quarter_overlap_or_bad_time"] = (
            con.execute("SELECT count(*) FROM raw WHERE Airline <> '-'").fetchone()[0] - stats["flights_in_scope"]
        )
    con.execute("DROP TABLE raw")
    return stats


def resolve_side(con, side: str) -> None:
    """side = 'org' or 'dst'. Creates <side>_res(fid, code, rule, conflict, track_code, callsign_code)."""
    val = f"val_{side}"
    con.execute(f"""
    CREATE OR REPLACE TABLE {side}_cand AS
    SELECT DISTINCT f.fid, c.canon, c.lat, c.lon,
           2 * 6371 * asin(sqrt(
             pow(sin(radians(c.lat - f.{side}_lat) / 2), 2) +
             cos(radians(f.{side}_lat)) * cos(radians(c.lat)) *
             pow(sin(radians(c.lon - f.{side}_lon) / 2), 2))) AS km
    FROM flights f, unnest(f.{side}_cands) AS u(code)
    JOIN ap_code c ON c.code = u.code;

    CREATE OR REPLACE TABLE {side}_best AS
    SELECT fid, count(*) AS n_valid,
           first(canon ORDER BY km, canon) AS nearest,
           min(km) AS d1, list_sort(list(km))[2] AS d2,
           list(canon) AS valid
    FROM {side}_cand GROUP BY fid;

    CREATE OR REPLACE TABLE {side}_res AS
    WITH j AS (
      SELECT f.fid, f.{side}_near AS near, b.n_valid, b.nearest, b.d1, b.d2, b.valid,
             v.canon AS callsign_code
      FROM flights f
      LEFT JOIN {side}_best b USING (fid)
      LEFT JOIN ap_code v ON v.code = f.{val})
    SELECT fid,
      CASE
        WHEN near AND n_valid = 1 THEN 'R1'
        WHEN near AND n_valid > 1 AND (d2 - d1) >= {AMBIGUOUS_KM} THEN 'R2'
        WHEN callsign_code IS NOT NULL AND list_contains(valid, callsign_code) THEN 'R3'
        WHEN callsign_code IS NOT NULL THEN 'R4'
        ELSE 'R5' END AS rule,
      CASE
        WHEN near AND n_valid = 1 THEN nearest
        WHEN near AND n_valid > 1 AND (d2 - d1) >= {AMBIGUOUS_KM} THEN nearest
        WHEN callsign_code IS NOT NULL THEN callsign_code
        END AS code,
      -- the track pointed at an airport (near, >= 1 candidate) and the callsign route names another
      coalesce(near AND n_valid >= 1 AND callsign_code IS NOT NULL AND NOT list_contains(valid, callsign_code), false) AS conflict,
      coalesce(near AND n_valid > 1 AND (d2 - d1) < {AMBIGUOUS_KM}, false) AS ambiguous_near
    FROM j;
    """)


def resolve(con) -> None:
    resolve_side(con, "org")
    resolve_side(con, "dst")
    con.execute("""
    CREATE OR REPLACE TABLE resolved AS
    SELECT f.fid, f.month, f.day, f.airline,
           o.code AS org, o.rule AS org_rule, o.conflict AS org_conflict,
           d.code AS dst, d.rule AS dst_rule, d.conflict AS dst_conflict,
           o.ambiguous_near OR d.ambiguous_near AS ambiguous_near,
           coalesce(c.class, 'unknown') AS class,
           CASE
             WHEN o.rule = 'R5' OR d.rule = 'R5' THEN 'X_unresolved'
             WHEN o.rule = 'R4' OR d.rule = 'R4' THEN 'T4_callsign_only'
             WHEN o.rule = 'R3' OR d.rule = 'R3' THEN 'T3_track_callsign'
             WHEN o.conflict OR d.conflict THEN 'T2_track_conflict'
             ELSE 'T1_track' END AS tier
    FROM flights f
    JOIN org_res o USING (fid)
    JOIN dst_res d USING (fid)
    LEFT JOIN aircls c ON c.ac_type = f.ac_type AND c.ac_type_detailed = f.ac_type_detailed;

    -- Explore basis: 0 = airports supported by the track (T1-T3), 1 = callsign route only (T4)
    CREATE OR REPLACE TABLE on_map AS
    SELECT *, CASE WHEN tier = 'T4_callsign_only' THEN 1 ELSE 0 END AS basis
    FROM resolved WHERE tier <> 'X_unresolved' AND org <> dst;
    """)


def aggregate(con) -> None:
    con.execute("""
    CREATE OR REPLACE TABLE agg AS
    SELECT month,
           least(org, dst) AS a, greatest(org, dst) AS b,
           CASE WHEN org < dst THEN 0 ELSE 1 END AS dir,
           airline, basis,
           count(*) FILTER (WHERE class = 'passenger') AS pax,
           count(*) FILTER (WHERE class = 'cargo') AS cargo,
           count(*) FILTER (WHERE class = 'unknown') AS unk
    FROM on_map
    GROUP BY ALL;

    CREATE OR REPLACE TABLE route_ids AS
    SELECT row_number() OVER (ORDER BY a, b) - 1 AS id, a, b FROM (SELECT DISTINCT a, b FROM agg);

    CREATE OR REPLACE TABLE used_codes AS
    SELECT DISTINCT code FROM (
      SELECT unnest(org_cands) AS code FROM flights UNION SELECT unnest(dst_cands) FROM flights
      UNION SELECT val_org FROM flights UNION SELECT val_dst FROM flights) WHERE code IS NOT NULL;

    CREATE OR REPLACE TABLE used_airports AS
    SELECT r.* FROM ap_rec r WHERE r.canon IN (SELECT a FROM route_ids UNION SELECT b FROM route_ids)
    ORDER BY r.canon;

    CREATE OR REPLACE TABLE days AS
    SELECT month, count(DISTINCT day) AS days_with_data, max(day(last_day(day))) AS days_in_month
    FROM resolved GROUP BY month;
    """)


def coverage(con) -> None:
    """Daily flights per region with a DETECTION flag. Nothing is corrected or imputed here."""
    con.execute(f"""
    CREATE OR REPLACE TABLE cov_counts AS
    WITH f AS (
      SELECT r.day, coalesce(ao.continent, ad.continent, 'unknown') AS region
      FROM resolved r
      LEFT JOIN ap_rec ao ON ao.canon = r.org
      LEFT JOIN ap_rec ad ON ad.canon = r.dst
      WHERE r.tier <> 'X_unresolved')
    SELECT day, region, count(*) AS flights FROM f GROUP BY 1, 2
    UNION ALL
    SELECT day, 'WORLD', count(*) FROM resolved WHERE tier <> 'X_unresolved' GROUP BY 1;

    CREATE OR REPLACE TABLE coverage_daily AS
    WITH cal AS (
      SELECT unnest(generate_series((SELECT min(day) FROM flights), (SELECT max(day) FROM flights), INTERVAL 1 DAY))::DATE AS day),
    regions AS (SELECT DISTINCT region FROM cov_counts),
    grid AS (
      SELECT c.day, r.region, coalesce(n.flights, 0) AS flights
      FROM cal c CROSS JOIN regions r LEFT JOIN cov_counts n ON n.day = c.day AND n.region = r.region),
    w AS (
      SELECT *, dayofweek(day) AS dow,
             median(flights) OVER (
               PARTITION BY region, dayofweek(day) ORDER BY day
               RANGE BETWEEN INTERVAL {COVERAGE_WINDOW_DAYS} DAYS PRECEDING AND INTERVAL {COVERAGE_WINDOW_DAYS} DAYS FOLLOWING
               EXCLUDE CURRENT ROW) AS baseline
      FROM grid)
    SELECT day, region, dow, flights, baseline,
           CASE WHEN baseline > 0 THEN round(flights / baseline, 3) END AS ratio,
           coalesce(baseline > 0 AND flights < {COVERAGE_LOW_RATIO} * baseline, false) AS suspected_low
    FROM w ORDER BY region, day;
    """)


# ---- writers --------------------------------------------------------------------------------


def write_explore(con, cfg: BuildConfig, out: Path) -> list[dict]:
    (out / "months").mkdir(parents=True, exist_ok=True)
    airports = [
        {"id": canon, "iata": iata, "icao": icao if icao and len(icao) == 4 and icao.isalpha() else None,
         "name": name, "city": city or "", "country": country, "lat": round(lat, 5), "lon": round(lon, 5)}
        for canon, iata, icao, name, city, country, lat, lon in con.execute(
            "SELECT canon, iata, icao, name, city, country, lat, lon FROM used_airports ORDER BY canon").fetchall()
    ]
    (out / "airports.json").write_text(json.dumps(airports, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    routes = [[i, a, b] for i, a, b in con.execute("SELECT id, a, b FROM route_ids ORDER BY id").fetchall()]
    (out / "routes.json").write_text(json.dumps(routes, separators=(",", ":")), encoding="utf-8")

    suspected = {
        m: [str(d) for (d,) in con.execute(
            "SELECT day FROM coverage_daily WHERE region = 'WORLD' AND suspected_low AND strftime(day, '%Y-%m') = ? ORDER BY day", [m]).fetchall()]
        for (m,) in con.execute("SELECT DISTINCT month FROM days").fetchall()
    }
    months = []
    for month, days_with_data, days_in_month in con.execute("SELECT * FROM days ORDER BY month").fetchall():
        recs = con.execute("""
            SELECT r.id, g.dir, g.airline, g.pax, g.cargo, g.unk, g.basis
            FROM agg g JOIN route_ids r USING (a, b)
            WHERE g.month = ? ORDER BY r.id, g.dir, g.airline, g.basis""", [month]).fetchall()
        body = {
            "month": month,
            "observedDays": days_with_data,
            "daysInMonth": days_in_month,
            "recordColumns": ["routeId", "direction", "carrierId", "passenger", "cargo", "unknown", "basis"],
            "records": recs,
        }
        path = out / "months" / f"{month}.json"
        path.write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
        months.append({"month": month, "file": f"months/{month}.json", "observedDays": days_with_data,
                       "daysInMonth": days_in_month, "recordCount": len(recs),
                       # informational: flagged by detection, NOT used for normalisation (Phase 6B)
                       "suspectedLowDays": suspected.get(month, [])})
        cfg.log(f"{month}: {len(recs):,} records, {path.stat().st_size / 1e6:.1f} MB, {days_with_data}/{days_in_month} days")
    return months


def write_research(con, out: Path) -> None:
    r = out / "research"
    r.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
    COPY (
      SELECT month, org AS origin, dst AS destination, airline, class,
             org_rule AS origin_rule, dst_rule AS destination_rule,
             org_conflict AS origin_conflict, dst_conflict AS destination_conflict,
             tier, org IS NOT NULL AND org = dst AS same_airport, count(*) AS flights
      FROM resolved
      GROUP BY ALL
      ORDER BY month, origin NULLS LAST, destination NULLS LAST, airline, class, origin_rule, destination_rule,
               origin_conflict, destination_conflict, tier
    ) TO '{(r / "routes_monthly.parquet").as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD);

    COPY (SELECT canon AS id, rec_id AS ourairports_id, ident, icao, iata, name, city, country, continent, type, lat, lon
          FROM used_airports ORDER BY canon)
      TO '{(r / "airports.csv").as_posix()}' (HEADER, DELIMITER ',');

    COPY ({aliases_sql("used_codes")}) TO '{(r / "airport_aliases.csv").as_posix()}' (HEADER, DELIMITER ',');

    COPY (SELECT * FROM coverage_daily ORDER BY region, day) TO '{(r / "coverage_daily.csv").as_posix()}' (HEADER, DELIMITER ',');
    """)
    (r / "README.md").write_text(RESEARCH_README, encoding="utf-8")


RESEARCH_README = """# Research files

Derived from ADS-B observations (MrAirspace/aircraft-flight-schedules, ODbL-1.0) and OurAirports.
Not an official timetable. See docs/research-readiness-audit.md and docs/phase6a-report.md.

## routes_monthly.parquet
One row per (month, origin, destination, airline code, class, origin_rule, destination_rule,
origin_conflict, destination_conflict, tier, same_airport) with `flights` = number of flights.
Directed: origin -> destination. Includes unresolved ends (NULL airport, rule R5) and flights
from an airport to itself (`same_airport`), which the map excludes.

- class: passenger / cargo / unknown, from the aircraft VARIANT (aircraft-based evidence, not the
  purpose of the flight).
- rules (per end): R1 track end near one candidate airport; R2 nearest of several candidates;
  R3 callsign-route airport among the track-end candidates; R4 callsign route only; R5 unresolved.
- conflict: the track pointed at an airport and the callsign route names another one.
- tier (per flight): T1_track, T2_track_conflict, T3_track_callsign, T4_callsign_only,
  X_unresolved. "Track" means supported by the track end, not certain. Callsign-route mismatch
  rates measured on checkable ends (e.g. ~26% in North America) are NOT the error rate of
  unverified R4 ends.

## airports.csv / airport_aliases.csv
Canonical airport per OurAirports record. Codes are merged only when they belong to the same
OurAirports record. Codes matching several records are listed as `unresolved`.

## coverage_daily.csv
Flights per day and region (continent of the origin airport, else destination; WORLD = all).
`baseline` = median of the same weekday within +-28 days (excluding the day).
`suspected_low` = flights < 0.8 x baseline. This is a DETECTION flag only: holidays, seasonality,
regional differences and receiver changes also move the ratio. Nothing is imputed.
"""


# ---- main build -------------------------------------------------------------------------------


def build(cfg: BuildConfig) -> dict:
    t0 = time.time()
    log = lambda m: cfg.log(f"[{time.time() - t0:6.1f}s] {m}")
    out = cfg.out_dir
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f"{out} already exists and is not empty; refusing to overwrite a dataset")
    out.mkdir(parents=True, exist_ok=True)

    inputs = [provenance.InputFile("flights", p) for p in cfg.flight_files]
    inputs += [provenance.InputFile("airports", cfg.ourairports_csv), provenance.InputFile("aircraft_classes", cfg.classes_csv)]
    described = [i.describe() for i in inputs]
    locked = None
    if cfg.lock_path is not None:
        locked = provenance.verify_against_lock([d for d in described if d["role"] != "aircraft_classes"], cfg.lock_path)
        log("inputs verified against lock file")

    con = duckdb.connect()
    load_airports(con, cfg.ourairports_csv)
    con.execute(f"CREATE TABLE aircls AS SELECT ac_type, ac_type_detailed, class FROM read_csv('{cfg.classes_csv.as_posix()}', all_varchar=true)")
    stats = load_flights(con, cfg)
    log(f"flights in scope: {stats['flights_in_scope']:,}")
    resolve(con)
    log("airports resolved")
    aggregate(con)
    coverage(con)
    q = lambda s: con.execute(s).fetchall()

    stats["rules"] = {
        "origin": dict(q("SELECT org_rule, count(*) FROM resolved GROUP BY 1 ORDER BY 1")),
        "destination": dict(q("SELECT dst_rule, count(*) FROM resolved GROUP BY 1 ORDER BY 1")),
    }
    stats["tiers"] = dict(q("SELECT tier, count(*) FROM resolved GROUP BY 1 ORDER BY 1"))
    stats["tiers_on_map"] = dict(q("SELECT tier, count(*) FROM on_map GROUP BY 1 ORDER BY 1"))
    stats["basis"] = {
        "observed": q("SELECT count(*) FROM resolved WHERE tier IN ('T1_track','T2_track_conflict','T3_track_callsign')")[0][0],
        "callsign": stats["tiers"].get("T4_callsign_only", 0),
        "unknown": stats["tiers"].get("X_unresolved", 0),
    }
    stats["conflict_ends"] = {
        "origin": q("SELECT count(*) FROM resolved WHERE org_conflict")[0][0],
        "destination": q("SELECT count(*) FROM resolved WHERE dst_conflict")[0][0],
    }
    stats["conflict_flights"] = q("SELECT count(*) FROM resolved WHERE org_conflict OR dst_conflict")[0][0]
    stats["ambiguous_near_flights"] = q("SELECT count(*) FROM resolved WHERE ambiguous_near")[0][0]
    stats["same_airport_excluded"] = q("SELECT count(*) FROM resolved WHERE tier <> 'X_unresolved' AND org = dst")[0][0]
    stats["flights_on_map"] = q("SELECT count(*) FROM on_map")[0][0]
    stats["class_on_map"] = dict(q("SELECT class, count(*) FROM on_map GROUP BY 1 ORDER BY 1"))
    stats["routes"] = q("SELECT count(*) FROM route_ids")[0][0]
    stats["airports"] = q("SELECT count(*) FROM used_airports")[0][0]
    stats["airlines"] = q("SELECT count(DISTINCT airline) FROM agg")[0][0]
    stats["alias_codes_merged"] = q(f"SELECT count(*) FROM ({aliases_sql('used_codes')}) WHERE NOT ambiguous")[0][0]
    stats["alias_codes_unresolved"] = q(f"SELECT count(*) FROM ({aliases_sql('used_codes')}) WHERE ambiguous")[0][0]
    log(f"tiers: {stats['tiers']}")

    months = write_explore(con, cfg, out)
    write_research(con, out)
    log("research files written")

    carriers = [{"id": c, "name": c, "operatorType": "unknown", "flights": int(n)}
                for c, n in q("SELECT airline, sum(pax + cargo + unk) n FROM agg GROUP BY 1 ORDER BY n DESC, airline")]

    generated = provenance.now_utc()
    prov = {
        "datasetId": cfg.dataset_id,
        "datasetVersion": cfg.dataset_version,
        "generatedAt": generated,
        "schemaVersions": {"explore": EXPLORE_SCHEMA_VERSION, "research": RESEARCH_SCHEMA_VERSION},
        "ruleset": RULESET,
        "inputs": [
            {**d, **({k: locked[d["file"]][k] for k in ("source", "retrieved", "release") if k in locked.get(d["file"], {})} if locked else {})}
            for d in described
        ],
        "months": [m["month"] for m in months],
        "git": provenance.git_state() if cfg.record_git else None,
        "environment": provenance.environment(),
        "generator": "pipeline/build_dataset.py",
    }
    (out / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")

    total = stats["flights_in_scope"]
    manifest = {
        "schemaVersion": EXPLORE_SCHEMA_VERSION,
        "datasetId": cfg.dataset_id,
        "datasetVersion": cfg.dataset_version,
        "kind": "observed",
        "title": f"Flights observed via ADS-B, {cfg.year}",
        "generatedAt": generated,
        "generator": "pipeline/build_dataset.py",
        "months": months,
        "carriers": carriers,
        "sources": [
            {"id": "mrairspace", "name": "MrAirspace / aircraft-flight-schedules",
             "url": "https://github.com/MrAirspace/aircraft-flight-schedules",
             "description": "Flight schedules extracted from ADS-B position reports (ADSBlol network), with callsign route validation (vradarserver standing data) and aircraft type details (adsbdb.com). Not an official timetable.",
             "license": "ODbL-1.0", "files": [p.name for p in cfg.flight_files]},
            {"id": "ourairports", "name": "OurAirports", "url": "https://ourairports.com/data/",
             "description": "Airport names, codes and coordinates.", "license": "See ourairports.com/data (to be confirmed)"},
            {"id": "this-dataset", "name": "1090web aggregated dataset",
             "description": "Monthly route counts derived from the sources above by pipeline/build_dataset.py. As a derived database it is offered under the same licence.",
             "license": "ODbL-1.0"},
        ],
        "quality": {
            "flightsWithAirlineCode": total,
            "flightsOnMap": stats["flights_on_map"],
            "basis": stats["basis"],
            "classes": stats["class_on_map"],
            "observedVsCallsignConflicts": stats["conflict_ends"],
            "conflictFlights": stats["conflict_flights"],
            "tiers": stats["tiers"],
            "flightsWithoutAirlineCode": stats["raw_rows_without_airline"],
        },
        "provenance": {"file": "provenance.json", "rulesetVersion": RULESET["version"],
                       "gitCommit": (prov["git"] or {}).get("commit")},
        "disclaimer": "Flights observed via ADS-B, not an official timetable. Coverage varies by region and month; some airports are inferred from the callsign route rather than observed; passenger/cargo is unknown when the aircraft variant does not say.",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    if cfg.quality_path:
        cfg.quality_path.parent.mkdir(parents=True, exist_ok=True)
        cfg.quality_path.write_text(json.dumps({"generatedAt": generated, **stats, "months": months}, indent=2, default=int), encoding="utf-8")
    log(f"done -> {out}")
    return stats


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2026)
    p.add_argument("--dataset", required=True, help="dataset id, e.g. observed-2026-v2 (new directory)")
    p.add_argument("--version", required=True, help="dataset version, e.g. 2.0.0")
    p.add_argument("--months", default="", help="comma-separated YYYY-MM subset (testing)")
    p.add_argument("--out-root", default=str(ROOT / "public" / "data"))
    p.add_argument("--no-lock", action="store_true", help="skip input hash verification (development only)")
    args = p.parse_args()

    months = [m for m in args.months.split(",") if m]
    quarters = sorted({(int(m[5:7]) - 1) // 3 + 1 for m in months}) if months else None
    files = sorted((RAW / "flights").glob(f"{args.year}_Q*_detailed_github.parquet"))
    if quarters:
        files = [f for f in files if int(f.name.split("_Q")[1][0]) in quarters]
    if not files:
        raise SystemExit(f"no raw files for {args.year} in {RAW / 'flights'}")
    cfg = BuildConfig(
        flight_files=files,
        ourairports_csv=RAW / "ourairports" / "airports.csv",
        classes_csv=REF / "aircraft_variant_class.csv",
        out_dir=Path(args.out_root) / args.dataset,
        dataset_id=args.dataset,
        dataset_version=args.version,
        year=args.year,
        months=months or None,
        quality_path=ROOT / "data" / "quality" / f"{args.dataset}.json",
        lock_path=None if args.no_lock else provenance.LOCK_PATH,
    )
    build(cfg)


if __name__ == "__main__":
    main()
