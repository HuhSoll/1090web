"""
Builds the public "observed" dataset from the raw quarterly flight schedules.

Input (not committed, see README):
  data/raw/flights/<year>_Q<n>_detailed_github.parquet   MrAirspace/aircraft-flight-schedules (ODbL)
  data/raw/ourairports/airports.csv                      OurAirports
  pipeline/reference/aircraft_variant_class.csv          reviewed passenger/cargo classification

Output:
  public/data/<dataset>/manifest.json, airports.json, routes.json, months/YYYY-MM.json
  data/quality/<dataset>.json                            full quality report

Rules (see docs/phase2-data-survey.md):
  * Only flights with an airline code are aggregated. Others are counted in the report.
  * Overlap between quarterly files is removed by keeping only flights whose month (origin
    time, else destination time) belongs to the file's quarter.
  * Each end of a flight is resolved to one airport, with a basis:
      observed  - the track starts/ends at (or close above) an airport, or the callsign route
                  agrees with the airports near the track end
      callsign  - only the callsign route says which airport it was
      unknown   - not resolvable; the flight is excluded from the network
  * A flight's basis is the weaker of its two ends. Flights from an airport to itself are excluded.

Usage:
  python pipeline/build_dataset.py --year 2026 --dataset observed-2026
"""

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
REF = ROOT / "pipeline" / "reference"

# A track end at or below this altitude is close enough to an airport to count as observed.
NEAR_AIRPORT_FT = 3000
# Two candidate airports closer than this to each other (relative to the track end) are ambiguous.
AMBIGUOUS_KM = 1.0
BASIS_CODE = {"observed": 0, "callsign": 1}


def sql_side(prefix: str, side: str) -> str:
    """SQL that resolves one end of every flight. side = 'Origin' or 'Destination'."""
    val_idx = 1 if side == "Origin" else 2
    return f"""
    CREATE OR REPLACE TABLE {prefix}_cand AS
    SELECT fid, c.code, ap.lat, ap.lon,
           2 * 6371 * asin(sqrt(
             pow(sin(radians(ap.lat - f.{prefix}_lat) / 2), 2) +
             cos(radians(f.{prefix}_lat)) * cos(radians(ap.lat)) *
             pow(sin(radians(ap.lon - f.{prefix}_lon) / 2), 2))) AS km
    FROM flights f, unnest(f.{prefix}_cands) AS c(code)
    JOIN ap ON ap.code = c.code;

    CREATE OR REPLACE TABLE {prefix}_best AS
    SELECT fid,
           count(*) AS n_valid,
           arg_min(code, km) AS nearest,
           min(km) AS d1,
           list_sort(list(km))[2] AS d2,
           list(code) AS valid_codes
    FROM {prefix}_cand GROUP BY fid;

    CREATE OR REPLACE TABLE {prefix}_resolved AS
    SELECT f.fid,
      CASE
        WHEN f.{prefix}_near AND b.n_valid = 1 THEN b.nearest
        WHEN f.{prefix}_near AND b.n_valid > 1 AND (b.d2 - b.d1) >= {AMBIGUOUS_KM} THEN b.nearest
        WHEN f.val{val_idx} IS NOT NULL AND list_contains(b.valid_codes, f.val{val_idx}) THEN f.val{val_idx}
        WHEN f.val{val_idx} IS NOT NULL AND va.code IS NOT NULL THEN f.val{val_idx}
        ELSE NULL END AS code,
      CASE
        WHEN f.{prefix}_near AND b.n_valid = 1 THEN 'observed'
        WHEN f.{prefix}_near AND b.n_valid > 1 AND (b.d2 - b.d1) >= {AMBIGUOUS_KM} THEN 'observed'
        WHEN f.val{val_idx} IS NOT NULL AND list_contains(b.valid_codes, f.val{val_idx}) THEN 'observed'
        WHEN f.val{val_idx} IS NOT NULL AND va.code IS NOT NULL THEN 'callsign'
        ELSE 'unknown' END AS basis,
      -- observed airport differs from the callsign route (kept as observed, counted in the report)
      (f.{prefix}_near AND b.n_valid >= 1 AND f.val{val_idx} IS NOT NULL
        AND NOT list_contains(b.valid_codes, f.val{val_idx})) AS conflict
    FROM flights f
    LEFT JOIN {prefix}_best b USING (fid)
    LEFT JOIN ap va ON va.code = f.val{val_idx};
    """


def main() -> None:
    ap_ = argparse.ArgumentParser()
    ap_.add_argument("--year", type=int, default=2026)
    ap_.add_argument("--dataset", default="observed-2026")
    ap_.add_argument("--threads", type=int, default=0)
    args = ap_.parse_args()

    t0 = time.time()
    out_dir = ROOT / "public" / "data" / args.dataset
    (out_dir / "months").mkdir(parents=True, exist_ok=True)
    for old in (out_dir / "months").glob("*.json"):
        old.unlink()

    files = sorted((RAW / "flights").glob(f"{args.year}_Q*_detailed_github.parquet"))
    if not files:
        raise SystemExit(f"no raw files for {args.year} in {RAW / 'flights'}")
    con = duckdb.connect()
    if args.threads:
        con.execute(f"SET threads={args.threads}")
    log = lambda msg: print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)
    q1 = lambda sql: con.execute(sql).fetchone()

    # ---- reference tables --------------------------------------------------------------
    con.execute(f"""
    CREATE TABLE ap_raw AS SELECT * FROM read_csv('{(RAW / 'ourairports' / 'airports.csv').as_posix()}', all_varchar=true);
    -- One row per code. A code can be an ICAO code, an OurAirports ident or a GPS code; prefer
    -- the ICAO code, then larger airports. Heliports, balloonports and closed sites are excluded.
    CREATE TABLE ap AS
    WITH codes AS (
      SELECT icao_code AS code, 1 AS pri, * FROM ap_raw WHERE icao_code IS NOT NULL
      UNION ALL SELECT ident, 2, * FROM ap_raw
      UNION ALL SELECT gps_code, 3, * FROM ap_raw WHERE gps_code IS NOT NULL
    )
    SELECT code,
           arg_min(ident, pri * 10 + CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 ELSE 2 END) AS ident,
           arg_min(name, pri) AS name, arg_min(municipality, pri) AS city, arg_min(iso_country, pri) AS country,
           arg_min(iata_code, pri) AS iata, arg_min(type, pri) AS type,
           arg_min(latitude_deg::DOUBLE, pri) AS lat, arg_min(longitude_deg::DOUBLE, pri) AS lon
    FROM codes
    WHERE type NOT IN ('heliport', 'balloonport', 'closed')
    GROUP BY code;
    CREATE TABLE aircls AS SELECT ac_type, ac_type_detailed, class FROM read_csv('{(REF / 'aircraft_variant_class.csv').as_posix()}', all_varchar=true);
    """)
    log(f"airports in lookup: {q1('SELECT count(*) FROM ap')[0]:,}")

    # ---- flights: overlap removal and parsing ------------------------------------------
    file_list = ", ".join(f"'{p.as_posix()}'" for p in files)
    con.execute(f"""
    CREATE TABLE raw AS
    SELECT *, regexp_extract(filename, '_Q(\\d)_', 1)::INT AS quarter
    FROM read_parquet([{file_list}], filename = true);

    CREATE TABLE flights AS
    WITH t AS (
      SELECT *,
        TRY_CAST(CASE WHEN Track_Origin_DateTime_UTC <> '-' THEN Track_Origin_DateTime_UTC
                      ELSE Track_Destination_DateTime_UTC END AS TIMESTAMP) AS ref_time
      FROM raw)
    SELECT
      row_number() OVER () AS fid,
      quarter, ref_time,
      strftime(ref_time, '%Y-%m') AS month,
      Airline AS airline, AC_Type AS ac_type, AC_Type_Detailed AS ac_type_detailed,
      regexp_extract_all(Track_Origin_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS org_cands,
      regexp_extract_all(Track_Destination_ApplicableAirports, '[A-Z0-9]{{3,4}}') AS dst_cands,
      TRY_CAST(Track_Origin_Lat AS DOUBLE) AS org_lat, TRY_CAST(Track_Origin_Lon AS DOUBLE) AS org_lon,
      TRY_CAST(Track_Destination_Lat AS DOUBLE) AS dst_lat, TRY_CAST(Track_Destination_Lon AS DOUBLE) AS dst_lon,
      (Track_Origin_FL_Ft = 'ground' OR TRY_CAST(Track_Origin_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}) AS org_near,
      (Track_Destination_FL_Ft = 'ground' OR TRY_CAST(Track_Destination_FL_Ft AS INT) <= {NEAR_AIRPORT_FT}) AS dst_near,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 1) END AS val1,
      CASE WHEN regexp_matches(Route_Validation_Based_on_Callsign, '^[A-Z0-9]{{3,4}}-[A-Z0-9]{{3,4}}$')
           THEN split_part(Route_Validation_Based_on_Callsign, '-', 2) END AS val2
    FROM t
    WHERE Airline <> '-'
      AND ref_time IS NOT NULL
      AND year(ref_time) = {args.year}
      AND (month(ref_time) - 1) // 3 + 1 = quarter;
    """)
    stats: dict = {}
    stats["raw_rows"] = q1("SELECT count(*) FROM raw")[0]
    stats["raw_rows_without_airline"] = q1("SELECT count(*) FROM raw WHERE Airline = '-'")[0]
    stats["flights_in_scope"] = q1("SELECT count(*) FROM flights")[0]
    stats["removed_quarter_overlap_or_bad_time"] = q1(
        "SELECT count(*) FROM raw WHERE Airline <> '-'"
    )[0] - stats["flights_in_scope"]
    con.execute("DROP TABLE raw")
    log(f"flights in scope: {stats['flights_in_scope']:,}")

    # ---- airport resolution -------------------------------------------------------------
    con.execute(sql_side("org", "Origin"))
    log("origins resolved")
    con.execute(sql_side("dst", "Destination"))
    log("destinations resolved")

    con.execute("""
    CREATE TABLE resolved AS
    SELECT f.fid, f.month, f.ref_time, f.airline,
           o.code AS org, o.basis AS org_basis, o.conflict AS org_conflict,
           d.code AS dst, d.basis AS dst_basis, d.conflict AS dst_conflict,
           coalesce(c.class, 'unknown') AS class,
           CASE WHEN o.basis = 'unknown' OR d.basis = 'unknown' THEN 'unknown'
                WHEN o.basis = 'callsign' OR d.basis = 'callsign' THEN 'callsign'
                ELSE 'observed' END AS basis
    FROM flights f
    JOIN org_resolved o USING (fid)
    JOIN dst_resolved d USING (fid)
    LEFT JOIN aircls c ON c.ac_type = f.ac_type AND c.ac_type_detailed = f.ac_type_detailed;
    """)

    stats["basis"] = dict(con.execute("SELECT basis, count(*) FROM resolved GROUP BY 1").fetchall())
    stats["end_basis"] = {
        "origin": dict(con.execute("SELECT org_basis, count(*) FROM resolved GROUP BY 1").fetchall()),
        "destination": dict(con.execute("SELECT dst_basis, count(*) FROM resolved GROUP BY 1").fetchall()),
    }
    stats["observed_vs_callsign_conflicts"] = {
        "origin": q1("SELECT count(*) FROM resolved WHERE org_conflict")[0],
        "destination": q1("SELECT count(*) FROM resolved WHERE dst_conflict")[0],
    }
    stats["same_airport_excluded"] = q1("SELECT count(*) FROM resolved WHERE basis <> 'unknown' AND org = dst")[0]
    stats["class"] = dict(con.execute("SELECT class, count(*) FROM resolved WHERE basis <> 'unknown' GROUP BY 1").fetchall())
    log(f"basis: {stats['basis']}")

    # ---- aggregation --------------------------------------------------------------------
    con.execute("""
    CREATE TABLE agg AS
    SELECT month,
           least(org, dst) AS a, greatest(org, dst) AS b,
           CASE WHEN org < dst THEN 0 ELSE 1 END AS dir,
           airline, basis,
           count(*) FILTER (WHERE class = 'passenger') AS pax,
           count(*) FILTER (WHERE class = 'cargo') AS cargo,
           count(*) FILTER (WHERE class = 'unknown') AS unk
    FROM resolved
    WHERE basis <> 'unknown' AND org <> dst
    GROUP BY ALL;

    CREATE TABLE route_ids AS
    SELECT row_number() OVER (ORDER BY a, b) - 1 AS id, a, b FROM (SELECT DISTINCT a, b FROM agg);

    CREATE TABLE used_airports AS
    SELECT ap.* FROM ap WHERE code IN (SELECT a FROM route_ids UNION SELECT b FROM route_ids) ORDER BY code;

    CREATE TABLE days AS
    SELECT month, count(DISTINCT ref_time::DATE) AS days_with_data, max(day(last_day(ref_time::DATE))) AS days_in_month
    FROM resolved GROUP BY month;
    """)
    stats["routes"] = q1("SELECT count(*) FROM route_ids")[0]
    stats["airports"] = q1("SELECT count(*) FROM used_airports")[0]
    stats["airlines"] = q1("SELECT count(DISTINCT airline) FROM agg")[0]
    log(f"routes {stats['routes']:,}, airports {stats['airports']:,}, airlines {stats['airlines']:,}")

    # ---- export -------------------------------------------------------------------------
    airports = [
        {"id": code, "iata": iata, "icao": code if len(code) == 4 and code.isalpha() else None,
         "name": name, "city": city or "", "country": country, "lat": round(lat, 5), "lon": round(lon, 5)}
        for code, iata, name, city, country, lat, lon in con.execute(
            "SELECT code, iata, name, city, country, lat, lon FROM used_airports").fetchall()
    ]
    (out_dir / "airports.json").write_text(json.dumps(airports, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    routes = [[i, a, b] for i, a, b in con.execute("SELECT id, a, b FROM route_ids ORDER BY id").fetchall()]
    (out_dir / "routes.json").write_text(json.dumps(routes, separators=(",", ":")), encoding="utf-8")

    months = []
    for month, days_with_data, days_in_month in con.execute("SELECT * FROM days ORDER BY month").fetchall():
        recs = con.execute("""
            SELECT r.id, g.dir, g.airline, g.pax, g.cargo, g.unk, CASE g.basis WHEN 'observed' THEN 0 ELSE 1 END
            FROM agg g JOIN route_ids r USING (a, b)
            WHERE g.month = ? ORDER BY r.id, g.dir, g.airline, g.basis""", [month]).fetchall()
        body = {
            "month": month,
            "observedDays": days_with_data,
            "daysInMonth": days_in_month,
            "recordColumns": ["routeId", "direction", "carrierId", "passenger", "cargo", "unknown", "basis"],
            "records": recs,
        }
        path = out_dir / "months" / f"{month}.json"
        path.write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
        months.append({"month": month, "file": f"months/{month}.json", "observedDays": days_with_data,
                       "daysInMonth": days_in_month, "recordCount": len(recs)})
        log(f"{month}: {len(recs):,} records, {path.stat().st_size / 1e6:.1f} MB, {days_with_data}/{days_in_month} days")

    # Airline codes come from callsign prefixes; no name source is bundled yet, so name = code.
    # Sorted by flights so the UI can list the busiest first.
    carriers = [{"id": c, "name": c, "operatorType": "unknown", "flights": int(n)}
                for c, n in con.execute(
                    "SELECT airline, sum(pax + cargo + unk) n FROM agg GROUP BY 1 ORDER BY n DESC, airline").fetchall()]

    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    total = stats["flights_in_scope"]
    manifest = {
        "schemaVersion": 1,
        "datasetId": args.dataset,
        "kind": "observed",
        "title": f"Flights observed via ADS-B, {args.year}",
        "generatedAt": generated,
        "generator": "pipeline/build_dataset.py",
        "months": months,
        "carriers": carriers,
        "sources": [
            {"id": "mrairspace", "name": "MrAirspace / aircraft-flight-schedules",
             "url": "https://github.com/MrAirspace/aircraft-flight-schedules",
             "description": "Flight schedules extracted from ADS-B position reports (ADSBlol network), with callsign route validation (vradarserver standing data) and aircraft type details (adsbdb.com). Not an official timetable.",
             "license": "ODbL-1.0", "files": [p.name for p in files]},
            {"id": "ourairports", "name": "OurAirports", "url": "https://ourairports.com/data/",
             "description": "Airport names, codes and coordinates.", "license": "See ourairports.com/data (to be confirmed)"},
            {"id": "this-dataset", "name": "1090web aggregated dataset",
             "description": "Monthly route counts derived from the sources above by pipeline/build_dataset.py. As a derived database it is offered under the same licence.",
             "license": "ODbL-1.0"},
        ],
        "quality": {
            "flightsWithAirlineCode": total,
            "flightsOnMap": int(stats["basis"].get("observed", 0) + stats["basis"].get("callsign", 0) - stats["same_airport_excluded"]),
            "basis": {k: int(v) for k, v in stats["basis"].items()},
            "classes": {k: int(v) for k, v in stats["class"].items()},
            "observedVsCallsignConflicts": stats["observed_vs_callsign_conflicts"],
            "flightsWithoutAirlineCode": stats["raw_rows_without_airline"],
        },
        "disclaimer": "Flights observed via ADS-B, not an official timetable. Coverage varies by region and month; some airports are inferred from the callsign route rather than observed; passenger/cargo is unknown when the aircraft variant does not say.",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    quality_dir = ROOT / "data" / "quality"
    quality_dir.mkdir(parents=True, exist_ok=True)
    (quality_dir / f"{args.dataset}.json").write_text(json.dumps({"generatedAt": generated, **stats, "months": months}, indent=2, default=int), encoding="utf-8")
    log(f"done -> {out_dir}")


if __name__ == "__main__":
    main()
