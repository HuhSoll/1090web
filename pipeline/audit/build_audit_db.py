"""
Builds a local audit database (data/interim/audit-<year>.duckdb, not committed) that re-applies the
airport-resolution rules of pipeline/build_dataset.py to the raw flight schedules, but keeps
flight identifiers and records WHICH rule decided each end of each flight.

It does not write any public data. Its first job is to reproduce the published totals in
data/quality/<dataset>.json exactly (see audit_queries.py, check "reproduces_published_totals");
only then are its finer-grained measurements trusted.

Usage: python pipeline/audit/build_audit_db.py --year 2026
"""

import argparse
import sys
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from build_dataset import AMBIGUOUS_KM, NEAR_AIRPORT_FT  # noqa: E402  (same thresholds as the pipeline)

RAW = ROOT / "data" / "raw"
REF = ROOT / "pipeline" / "reference"


def side_sql(prefix: str, val: str) -> str:
    """Mirror of build_dataset.sql_side, plus the rule that decided the airport."""
    return f"""
    CREATE OR REPLACE TABLE {prefix}_cand AS
    SELECT fid, c.code, ap.type,
           2 * 6371 * asin(sqrt(
             pow(sin(radians(ap.lat - f.{prefix}_lat) / 2), 2) +
             cos(radians(f.{prefix}_lat)) * cos(radians(ap.lat)) *
             pow(sin(radians(ap.lon - f.{prefix}_lon) / 2), 2))) AS km
    FROM flights f, unnest(f.{prefix}_cands) AS c(code)
    JOIN ap ON ap.code = c.code;

    CREATE OR REPLACE TABLE {prefix}_best AS
    SELECT fid, count(*) AS n_valid, arg_min(code, km) AS nearest, min(km) AS d1,
           list_sort(list(km))[2] AS d2, list(code) AS valid_codes
    FROM {prefix}_cand GROUP BY fid;

    CREATE OR REPLACE TABLE {prefix}_res AS
    SELECT f.fid,
      len(f.{prefix}_cands) AS n_cands,
      coalesce(b.n_valid, 0) AS n_valid,
      b.d1, b.d2,
      CASE
        WHEN f.{prefix}_near AND b.n_valid = 1 THEN 'R1_near_single'
        WHEN f.{prefix}_near AND b.n_valid > 1 AND (b.d2 - b.d1) >= {AMBIGUOUS_KM} THEN 'R2_near_nearest'
        WHEN f.{val} IS NOT NULL AND list_contains(b.valid_codes, f.{val}) THEN 'R3_callsign_in_candidates'
        WHEN f.{val} IS NOT NULL AND va.code IS NOT NULL THEN 'R4_callsign_only'
        ELSE 'R5_unknown' END AS rule,
      CASE
        WHEN f.{prefix}_near AND b.n_valid = 1 THEN b.nearest
        WHEN f.{prefix}_near AND b.n_valid > 1 AND (b.d2 - b.d1) >= {AMBIGUOUS_KM} THEN b.nearest
        WHEN f.{val} IS NOT NULL AND list_contains(b.valid_codes, f.{val}) THEN f.{val}
        WHEN f.{val} IS NOT NULL AND va.code IS NOT NULL THEN f.{val}
        END AS code,
      (f.{prefix}_near AND b.n_valid >= 1 AND f.{val} IS NOT NULL
        AND NOT list_contains(b.valid_codes, f.{val})) AS conflict,
      -- for conflicts: the airport the track pointed to and the callsign-route airport
      CASE WHEN f.{prefix}_near AND b.n_valid >= 1 THEN b.nearest END AS track_airport,
      f.{val} AS callsign_airport,
      va.code IS NOT NULL AS callsign_airport_known
    FROM flights f
    LEFT JOIN {prefix}_best b USING (fid)
    LEFT JOIN ap va ON va.code = f.{val};
    """


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2026)
    args = p.parse_args()
    t0 = time.time()
    log = lambda m: print(f"[{time.time() - t0:6.1f}s] {m}", flush=True)

    out = ROOT / "data" / "interim" / f"audit-{args.year}.duckdb"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    con = duckdb.connect(str(out))
    files = sorted((RAW / "flights").glob(f"{args.year}_Q*_detailed_github.parquet"))
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)

    # Same airport lookup as build_dataset.py
    con.execute(f"""
    CREATE TABLE ap_raw AS SELECT * FROM read_csv('{(RAW / 'ourairports' / 'airports.csv').as_posix()}', all_varchar=true);
    CREATE TABLE ap AS
    WITH codes AS (
      SELECT icao_code AS code, 1 AS pri, * FROM ap_raw WHERE icao_code IS NOT NULL
      UNION ALL SELECT ident, 2, * FROM ap_raw
      UNION ALL SELECT gps_code, 3, * FROM ap_raw WHERE gps_code IS NOT NULL
    )
    SELECT code,
           arg_min(ident, pri * 10 + CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 ELSE 2 END) AS ident,
           arg_min(name, pri) AS name, arg_min(iso_country, pri) AS country, arg_min(continent, pri) AS continent,
           arg_min(iata_code, pri) AS iata, arg_min(type, pri) AS type,
           arg_min(latitude_deg::DOUBLE, pri) AS lat, arg_min(longitude_deg::DOUBLE, pri) AS lon,
           count(DISTINCT ident) AS n_idents
    FROM codes WHERE type NOT IN ('heliport', 'balloonport', 'closed') GROUP BY code;
    CREATE TABLE aircls AS SELECT ac_type, ac_type_detailed, class FROM read_csv('{(REF / 'aircraft_variant_class.csv').as_posix()}', all_varchar=true);
    """)
    log("reference tables")

    con.execute(f"""
    CREATE TABLE raw AS
    SELECT *, regexp_extract(filename, '_Q(\\d)_', 1)::INT AS quarter
    FROM read_parquet([{file_list}], filename = true);
    """)
    log("raw loaded")

    con.execute(f"""
    CREATE TABLE flights AS
    WITH t AS (
      SELECT *,
        TRY_CAST(CASE WHEN Track_Origin_DateTime_UTC <> '-' THEN Track_Origin_DateTime_UTC
                      ELSE Track_Destination_DateTime_UTC END AS TIMESTAMP) AS ref_time
      FROM raw)
    SELECT
      row_number() OVER () AS fid, quarter, ref_time, strftime(ref_time, '%Y-%m') AS month,
      ICAO_Hex AS hex, Callsign AS callsign, Airline AS airline, AC_Type AS ac_type, AC_Type_Detailed AS ac_type_detailed,
      Track_Origin_DateTime_UTC AS org_time_raw, Track_Destination_DateTime_UTC AS dst_time_raw,
      Track_Origin_FL_Ft AS org_fl, Track_Destination_FL_Ft AS dst_fl,
      regexp_extract_all(Track_Origin_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS org_cands,
      regexp_extract_all(Track_Destination_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS dst_cands,
      TRY_CAST(Track_Origin_Lat AS DOUBLE) AS org_lat, TRY_CAST(Track_Origin_Lon AS DOUBLE) AS org_lon,
      TRY_CAST(Track_Destination_Lat AS DOUBLE) AS dst_lat, TRY_CAST(Track_Destination_Lon AS DOUBLE) AS dst_lon,
      (Track_Origin_FL_Ft = 'ground' OR TRY_CAST(Track_Origin_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}) AS org_near,
      (Track_Destination_FL_Ft = 'ground' OR TRY_CAST(Track_Destination_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}) AS dst_near,
      Route_Validation_Based_on_Callsign AS route_raw,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 1) END AS val1,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 2) END AS val2
    FROM t
    WHERE Airline <> '-' AND ref_time IS NOT NULL AND year(ref_time) = {args.year}
      AND (month(ref_time) - 1) // 3 + 1 = quarter;
    """)
    log("flights in scope")

    con.execute(side_sql("org", "val1"))
    log("origins")
    con.execute(side_sql("dst", "val2"))
    log("destinations")

    con.execute("""
    CREATE TABLE resolved AS
    SELECT f.fid, f.month, f.ref_time, f.quarter, f.hex, f.callsign, f.airline, f.ac_type, f.ac_type_detailed,
           f.org_time_raw, f.dst_time_raw, f.val1, f.val2,
           o.code AS org, o.rule AS org_rule, o.conflict AS org_conflict, o.track_airport AS org_track, o.n_valid AS org_n_valid,
           d.code AS dst, d.rule AS dst_rule, d.conflict AS dst_conflict, d.track_airport AS dst_track, d.n_valid AS dst_n_valid,
           coalesce(c.class, 'unknown') AS class,
           CASE WHEN o.rule = 'R5_unknown' OR d.rule = 'R5_unknown' THEN 'unknown'
                WHEN o.rule = 'R4_callsign_only' OR d.rule = 'R4_callsign_only' THEN 'callsign'
                ELSE 'observed' END AS basis
    FROM flights f
    JOIN org_res o USING (fid) JOIN dst_res d USING (fid)
    LEFT JOIN aircls c ON c.ac_type = f.ac_type AND c.ac_type_detailed = f.ac_type_detailed;
    """)
    log("resolved")
    con.close()
    log(f"done -> {out}")


if __name__ == "__main__":
    main()
