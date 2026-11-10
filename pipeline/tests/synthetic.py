"""
Tiny synthetic inputs for pipeline tests: two quarterly Parquet files, an OurAirports-style CSV
and an aircraft class table. Every flight row is a deliberate case; the expected outcome is in
EXPECTED. No real data is read.
"""

from __future__ import annotations

import csv
from pathlib import Path

import duckdb

from classify_aircraft import classify

AIRPORT_COLUMNS = ["id", "ident", "type", "name", "latitude_deg", "longitude_deg", "continent",
                   "iso_country", "municipality", "icao_code", "iata_code", "gps_code"]

# id, ident, type, name, lat, lon, continent, country, city, icao_code, iata_code, gps_code
AIRPORTS = [
    ("1", "AAAA", "large_airport", "Alpha", "0", "0", "EU", "AA", "A city", "AAAA", "AAA", "AAAA"),
    ("2", "BBBB", "large_airport", "Bravo", "0", "10", "EU", "AA", "B city", "BBBB", "BBB", "BBBB"),
    # One airport, two codes: former ident OLD1, current ICAO code NEW1 (same record).
    ("3", "OLD1", "medium_airport", "Renamed", "0", "20", "AS", "BB", "R city", "NEW1", "NWW", "NEW1"),
    # Two different airports ~0.55 km apart: ambiguous when both are candidates.
    ("4", "CCCC", "medium_airport", "Charlie", "10", "0", "AS", "BB", "C city", "CCCC", "CCC", "CCCC"),
    ("5", "CCC2", "small_airport", "Charlie 2", "10", "0.005", "AS", "BB", "C city", "CCC2", None, "CCC2"),
    # Two airports ~11 km apart: the nearer is chosen (R2).
    ("6", "DDDD", "medium_airport", "Delta", "20", "0", "NA", "CC", "D city", "DDDD", "DDD", "DDDD"),
    ("7", "EEEE", "small_airport", "Echo", "20", "0.1", "NA", "CC", "E city", "EEEE", None, "EEEE"),
    # Closed airport: never a candidate.
    ("8", "ZZZZ", "closed", "Closed field", "30", "0", "NA", "CC", "Z city", "ZZZZ", None, "ZZZZ"),
    # Code collision: DUPC is the ICAO code of record 9 and the ident of record 10.
    ("9", "X-0001", "medium_airport", "Dup current", "40", "0", "AF", "DD", "X city", "DUPC", "DUP", None),
    ("10", "DUPC", "small_airport", "Dup old", "41", "0", "AF", "DD", "X city", None, None, None),
]

FLIGHT_COLUMNS = [
    "ICAO_Hex", "Reg", "AC_Type", "AC_Type_Detailed", "Airline", "Callsign",
    "Track_Origin_Lat", "Track_Origin_Lon", "Track_Origin_FL_Ft", "Track_Origin_DateTime_UTC", "Track_Origin_ApplicableAirports",
    "Track_Destination_Lat", "Track_Destination_Lon", "Track_Destination_FL_Ft", "Track_Destination_DateTime_UTC", "Track_Destination_ApplicableAirports",
    "Route_Validation_Based_on_Callsign",
]


def f(hex_, ac, detail, airline, cs, o, d, route, t0="2026-03-10 08:00:00", t1="2026-03-10 10:00:00"):
    """o / d = (lat, lon, fl, candidates) or None for a missing end."""
    def end(x, t):
        if x is None:
            return ["-", "-", "-", "-", "-"]
        lat, lon, fl, cands = x
        return [str(lat), str(lon), fl, t, str(cands)]
    return [hex_, "REG", ac, detail, airline, cs, *end(o, t0), *end(d, t1), route]


A = (0.0, 0.0, "ground", ["AAAA"])
B = (0.0, 10.0, "ground", ["BBBB"])

Q1 = [
    f("h01", "A20N", "A320 251NSL", "AAA", "AAA1", A, B, "AAAA-BBBB"),                          # R1/R1  T1, passenger (H2 fix)
    f("h02", "B38M", "737-8", "AAA", "AAA2", (0.0, 20.0, "ground", ["OLD1", "NEW1"]), A, "nan"),  # old+new code -> one candidate: R1 NEW1
    f("h03", "A320", "A320 214", "AAA", "AAA3", (10.0, 0.002, "ground", ["CCCC", "CCC2"]), A, "CCCC-AAAA"),  # ambiguous -> R3
    f("h04", "B738", "737NG 8AS/W", "AAA", "AAA4", (20.0, 0.01, "500", ["DDDD", "EEEE"]), B, "DDDD-BBBB"),  # R2 DDDD
    f("h05", "B77L", "777 F", "CCC", "CCC5", (20.0, 0.0, "25000", ["DDDD"]), B, "AAAA-BBBB"),     # R4 origin AAAA, T4, cargo
    f("h06", "C172", "-", "DDD", "DDD6", (5.0, 5.0, "30000", []), (6.0, 6.0, "30000", []), "nan"),  # R5/R5  X_unresolved
    f("h07", "A20N", "A320 251NSL", "AAA", "AAA7", A, B, "CCCC-BBBB"),                           # conflict at origin, T2
    f("h08", "A20N", "A320 251NSL", "AAA", "AAA8", (30.0, 0.0, "ground", ["ZZZZ"]), B, "DDDD-BBBB"),  # closed -> R4 DDDD
    f("h09", "C172", "-", "AAA", "AAA9", A, A, "nan"),                                           # same airport: excluded
    f("h10", "A20N", "A320 251NSL", "-", "NOAIRLINE", A, B, "nan"),                              # no airline code: out of scope
    f("h11", "A20N", "A320 251NSL", "AAA", "AAA11", A, B, "AAAA-BBBB", "2026-03-31 23:00:00", "2026-04-01 01:00:00"),  # also in Q2 file
    f("h13", "A20N", "A320 251NSL", "AAA", "AAA13", (40.0, 0.0, "ground", ["DUPC"]), A, "nan"),  # ambiguous code DUPC
]
Q2 = [
    f("h11", "A20N", "A320 251NSL", "AAA", "AAA11", A, B, "AAAA-BBBB", "2026-03-31 23:00:00", "2026-04-01 01:00:00"),  # overlap copy
    f("h12", "A20N", "A320 251NSL", "AAA", "AAA12", B, A, "BBBB-AAAA", "2026-04-02 08:00:00", "2026-04-02 10:00:00"),  # April B->A
]

EXPECTED = {
    "h01": ("AAAA", "R1", "BBBB", "R1", "T1_track"),
    "h02": ("NEW1", "R1", "AAAA", "R1", "T1_track"),
    "h03": ("CCCC", "R3", "AAAA", "R1", "T3_track_callsign"),
    "h04": ("DDDD", "R2", "BBBB", "R1", "T1_track"),
    "h05": ("AAAA", "R4", "BBBB", "R1", "T4_callsign_only"),
    "h06": (None, "R5", None, "R5", "X_unresolved"),
    "h07": ("AAAA", "R1", "BBBB", "R1", "T2_track_conflict"),
    "h08": ("DDDD", "R4", "BBBB", "R1", "T4_callsign_only"),
    "h09": ("AAAA", "R1", "AAAA", "R1", "T1_track"),
    "h11": ("AAAA", "R1", "BBBB", "R1", "T1_track"),
    "h12": ("BBBB", "R1", "AAAA", "R1", "T1_track"),
    "h13": ("DUPC", "R1", "AAAA", "R1", "T1_track"),
}


def write_inputs(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    ap = root / "airports.csv"
    with ap.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(AIRPORT_COLUMNS)
        for row in AIRPORTS:
            w.writerow(["" if v is None else v for v in row])

    con = duckdb.connect()
    files = []
    for q, rows in (("Q1", Q1), ("Q2", Q2)):
        cols = ", ".join(f'"{c}" VARCHAR' for c in FLIGHT_COLUMNS)
        con.execute(f"CREATE OR REPLACE TABLE t ({cols})")
        con.executemany(f"INSERT INTO t VALUES ({', '.join('?' for _ in FLIGHT_COLUMNS)})", rows)
        path = root / f"2026_{q}_detailed_github.parquet"
        con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
        files.append(path)

    classes = root / "aircraft_variant_class.csv"
    pairs = sorted({(r[2], r[3]) for r in Q1 + Q2})
    with classes.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ac_type", "ac_type_detailed", "class", "rule", "flights_2026_q1_q3"])
        for ac, detail in pairs:
            cls, rule = classify(ac, detail)
            w.writerow([ac, detail, cls, rule, 0])
    return {"airports": ap, "flights": files, "classes": classes}
