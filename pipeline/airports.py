"""
Airport lookup with canonical identities (audit H1).

OurAirports keeps ONE record per airport, but a record can carry several codes: its `ident`
(often a former ICAO code, e.g. WARJ), its current `icao_code` (WAHH) and a `gps_code`. The flight
data uses whichever code its own lookup had, so treating every code as an airport split some
airports into two nodes. Here every code resolves to an OurAirports RECORD, and each record has
one canonical code. Codes are only merged when they belong to the same record (same row, same
coordinates); a shared IATA code alone is never treated as evidence.

Tables created (DuckDB):
  ap_raw     the CSV as text
  ap_rec     one row per usable record: rec_id, canon, ident, icao, iata, name, city, country,
             continent, type, lat, lon
  ap_code    code -> rec_id (+ canon, coords), with `ambiguous` = the code matches >1 record;
             ambiguous codes resolve to the highest-priority record (ICAO code > ident > GPS code,
             then larger airport, then lowest record id) and are reported, not silently merged
"""

from __future__ import annotations

from pathlib import Path

EXCLUDED_TYPES = ("heliport", "balloonport", "closed")


OVERRIDES = Path(__file__).parent / "reference" / "airport_canonical_overrides.csv"


def load_airports(con, csv_path: Path, overrides_csv: Path | None = OVERRIDES) -> None:
    """Canonical code per record: an entry in airport_canonical_overrides.csv (reviewed, with a
    reason) wins; otherwise the record's ICAO code, else its GPS code, else its OurAirports ident."""
    excluded = ", ".join(f"'{t}'" for t in EXCLUDED_TYPES)
    if overrides_csv is not None and Path(overrides_csv).exists():
        ov = f"SELECT ourairports_id, canonical, iata, status FROM read_csv('{Path(overrides_csv).as_posix()}', all_varchar=true)"
    else:
        ov = "SELECT NULL::VARCHAR AS ourairports_id, NULL::VARCHAR AS canonical, NULL::VARCHAR AS iata, NULL::VARCHAR AS status WHERE false"
    con.execute(f"""
    CREATE OR REPLACE TABLE ap_raw AS
      SELECT * FROM read_csv('{Path(csv_path).as_posix()}', all_varchar=true);

    CREATE OR REPLACE TABLE ap_override AS {ov};

    CREATE OR REPLACE TABLE ap_rec AS
    SELECT a.id AS rec_id,
           coalesce(o.canonical, a.icao_code, a.gps_code, a.ident) AS canon,
           a.ident, a.icao_code AS icao, coalesce(o.iata, a.iata_code) AS iata, a.name, a.municipality AS city,
           a.iso_country AS country, a.continent, a.type,
           a.latitude_deg::DOUBLE AS lat, a.longitude_deg::DOUBLE AS lon,
           o.status AS override_status
    FROM ap_raw a LEFT JOIN ap_override o ON o.ourairports_id = a.id
    WHERE a.type NOT IN ({excluded});

    CREATE OR REPLACE TABLE ap_code AS
    WITH codes AS (
      SELECT icao_code AS code, 1 AS pri, id AS rec_id, type FROM ap_raw WHERE icao_code IS NOT NULL AND type NOT IN ({excluded})
      UNION ALL SELECT ident, 2, id, type FROM ap_raw WHERE type NOT IN ({excluded})
      UNION ALL SELECT gps_code, 3, id, type FROM ap_raw WHERE gps_code IS NOT NULL AND type NOT IN ({excluded})
    ),
    ranked AS (
      SELECT code, rec_id,
             row_number() OVER (PARTITION BY code ORDER BY pri,
               CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 ELSE 2 END,
               rec_id::BIGINT) AS rk,
             count(DISTINCT rec_id) OVER (PARTITION BY code) AS n_recs
      FROM codes
    )
    SELECT r.code, r.rec_id, r.n_recs > 1 AS ambiguous, a.canon, a.lat, a.lon
    FROM ranked r JOIN ap_rec a USING (rec_id)
    WHERE r.rk = 1;
    """)


def aliases_sql(used_codes_table: str) -> str:
    """Rows for airport_aliases.csv: every code seen in the flight data whose canonical code
    differs from itself, or that is ambiguous."""
    return f"""
    SELECT c.code AS code, c.canon AS canonical, c.rec_id AS ourairports_id, r.ident, r.icao, r.iata, r.name,
           CASE
             WHEN c.ambiguous THEN 'unresolved: code matches several OurAirports records; highest-priority record used'
             WHEN r.override_status IS NOT NULL AND c.code <> c.canon
               THEN 'merged (label ' || r.override_status || '): same OurAirports record; canonical label from reviewed override'
             WHEN c.code = r.ident AND c.code <> c.canon THEN 'merged: former/alternate ident of the same OurAirports record'
             WHEN c.code <> c.canon THEN 'merged: GPS/alternate code of the same OurAirports record'
             ELSE 'canonical'
           END AS status,
           c.ambiguous
    FROM {used_codes_table} u JOIN ap_code c ON c.code = u.code JOIN ap_rec r ON r.rec_id = c.rec_id
    WHERE c.code <> c.canon OR c.ambiguous OR r.override_status IS NOT NULL
    ORDER BY c.canon, c.code
    """
