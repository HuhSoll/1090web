"""Phase 9C: the second track time for every flight of the public day files.

The day files (Phase 9A) hold one reference time per flight: the track start, else the track end.
Whether a flight touched an airport during a closure depends on the side: the departure side is
best approximated by the track start, the arrival side by the track end. This script adds, per
day, the track end of each flight in exactly the order of the day file, so the browser can match
both sides. The existing day files are read, not changed.

  endpoints/YYYY-MM-DD.json  {"schemaVersion": 1, "day": ..., "n": ..., "e": [...]}
    e[i] = whole minutes from the reference minute of flight i to the minute of its track end
           (floor of each, so minute-aligned windows select exactly), or -1 when unknown:
           - the flight's reference time already is the track end (TRACK_END_FALLBACK; its
             track start is missing, so its departure-side time is unknown)
           - the track end is missing, or earlier than the track start

Flights that are identical in every published field are interchangeable in the day file; their
values are assigned in ascending order (deterministic).

Usage:
  python pipeline/temporal_endpoints.py --dataset observed-2026-v2
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from temporal import BASIS_CODE, CLASS_CODE, TIER_CODE, decode_day, encoded, gz_size  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 1
SCRIPT_VERSION = "9c.1"
MISSING = -1


def _case(column: str, mapping: dict[str, int]) -> str:
    return "CASE " + " ".join(f"WHEN {column} = '{k}' THEN {v}" for k, v in mapping.items()) + " END"


def load_tables(con, dataset_dir: Path, research_dir: Path) -> None:
    routes = json.loads((dataset_dir / "routes.json").read_text(encoding="utf-8"))
    carriers = [c["id"] for c in json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))["carriers"]]
    # bulk load through temporary CSV files (executemany and list parameters are row by row: far too slow)
    with tempfile.TemporaryDirectory() as tmp:
        rp, cp = Path(tmp) / "routes.csv", Path(tmp) / "carriers.csv"
        with rp.open("w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerows([r[0], r[1], r[2]] for r in routes)
        with cp.open("w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerows(enumerate(carriers))
        con.execute(f"CREATE OR REPLACE TABLE routes AS SELECT * FROM read_csv('{rp.as_posix()}', header=false, "
                    "columns={'rid': 'INTEGER', 'a': 'VARCHAR', 'b': 'VARCHAR'})")
        con.execute(f"CREATE OR REPLACE TABLE carriers AS SELECT * FROM read_csv('{cp.as_posix()}', header=false, "
                    "columns={'ci': 'INTEGER', 'id': 'VARCHAR'})")
    files = sorted(research_dir.glob("flights_*.parquet"))
    if not files:
        raise FileNotFoundError(f"no research flights in {research_dir}")
    src = "[" + ", ".join(f"'{p.as_posix()}'" for p in files) + "]"
    # the same selection, minute and codes as temporal.day_events()
    con.execute(f"""
    CREATE OR REPLACE TABLE ep AS
    WITH f AS (
      SELECT originAirport AS o, destinationAirport AS d, airlineCode AS al, aircraftClass AS cls, confidenceTier AS tier,
             timeBasis AS basis, referenceTimeUtc AS rt, trackEndTimeUtc AS te, CAST(referenceTimeUtc AS DATE) AS day
      FROM read_parquet({src}) WHERE onMap)
    SELECT f.day,
           r.rid,
           floor((epoch(f.rt) - epoch(f.day::TIMESTAMP)) / 60)::INT AS minute,
           c.ci,
           (CASE WHEN f.o < f.d THEN 0 ELSE 1 END) + 2 * ({_case('f.cls', CLASS_CODE)})
             + 6 * (({_case('f.tier', TIER_CODE)}) - 1) + 24 * ({_case('f.basis', BASIS_CODE)}) AS code,
           CASE WHEN f.basis = 'TRACK_START' AND f.te IS NOT NULL
                THEN floor((epoch(f.te) - epoch(f.day::TIMESTAMP)) / 60)::INT
                     - floor((epoch(f.rt) - epoch(f.day::TIMESTAMP)) / 60)::INT
                ELSE {MISSING} END AS e
    FROM f
    JOIN routes r ON r.a = least(f.o, f.d) AND r.b = greatest(f.o, f.d)
    JOIN carriers c ON c.id = f.al
    ORDER BY f.day""")


def day_endpoints(con, day: str) -> tuple[list[tuple[int, int, int, int]], list[int]]:
    rows = con.execute(f"SELECT rid, minute, ci, code, e FROM ep WHERE day = '{day}'::DATE ORDER BY rid, minute, ci, code, e").fetchall()
    return [r[:4] for r in rows], [r[4] for r in rows]


def check_alignment(doc: dict, keys: list[tuple[int, int, int, int]]) -> None:
    """The day file's flights, in file order, must be exactly the keys (same route, minute, airline, codes)."""
    decoded = [(e["route"], e["minute"], e["carrier"], e["direction"] + 2 * e["class"] + 6 * (e["tier"] - 1) + 24 * e["basis"])
               for e in decode_day(doc)]
    if decoded != keys:
        n = next((i for i, (x, y) in enumerate(zip(decoded, keys)) if x != y), min(len(decoded), len(keys)))
        raise RuntimeError(f"{doc['day']}: endpoint rows do not match the day file (first difference at {n}; "
                           f"{len(decoded)} vs {len(keys)} flights)")


def run(dataset_id: str, log=print) -> dict:
    return generate(dataset_id, ROOT / "public" / "data" / dataset_id, ROOT / "public" / "data" / dataset_id / "temporal",
                    ROOT / "data" / "research" / dataset_id / "temporal", log)


def generate(dataset_id: str, dataset_dir: Path, temporal_dir: Path, research_dir: Path, log=print) -> dict:
    """Writes temporal_dir/endpoints/ from the research flights; every day is checked against its day file."""
    out = temporal_dir / "endpoints"
    out.mkdir(parents=True, exist_ok=True)
    index = json.loads((temporal_dir / "index.json").read_text(encoding="utf-8"))
    con = duckdb.connect()
    t0 = time.time()
    load_tables(con, dataset_dir, research_dir)
    files, stats = {}, {"flights": 0, "endKnown": 0, "fallback": 0, "endMissing": 0, "maxMinutes": 0, "endBeforeStart": 0}
    for entry in index["days"]:
        day = entry["day"]
        doc = json.loads((temporal_dir / entry["file"]).read_text(encoding="utf-8"))
        keys, e = day_endpoints(con, day)
        check_alignment(doc, keys)
        # a track that ends before it starts has no usable end time: unknown, and counted
        for i, v in enumerate(e):
            if v < MISSING:
                e[i] = MISSING
                stats["endBeforeStart"] += 1
        for (_, _, _, code), v in zip(keys, e):
            stats["flights"] += 1
            if v >= 0:
                stats["endKnown"] += 1
                stats["maxMinutes"] = max(stats["maxMinutes"], v)
            elif code // 24 == 1:
                stats["fallback"] += 1
            else:
                stats["endMissing"] += 1
        body = encoded({"schemaVersion": SCHEMA_VERSION, "day": day, "n": len(e), "e": e})
        name = f"endpoints/{day}.json"
        (temporal_dir / name).write_bytes(body)
        files[name] = {"bytes": len(body), "gzip": gz_size(body), "sha256": hashlib.sha256(body).hexdigest()}
    manifest = {
        "schemaVersion": SCHEMA_VERSION, "datasetId": dataset_id, "script": {"name": "pipeline/temporal_endpoints.py", "version": SCRIPT_VERSION},
        "source": f"data/research/{dataset_id}/temporal/flights_*.parquet (trackEndTimeUtc)",
        "format": {
            "e": "minutes from the flight's reference minute to its track-end minute (floor of each); -1 = unknown "
                 "(reference time is already the track end, or the track end is missing). Same order as days/<day>.json.",
            "meaning": "track end is the last ADS-B point, not necessarily the landing time; it is a proxy for the arrival side",
        },
        "stats": stats, "files": files,
        "totalBytes": sum(f["bytes"] for f in files.values()), "totalGzipBytes": sum(f["gzip"] for f in files.values()),
        "elapsedSeconds": round(time.time() - t0, 1),
    }
    (out / "manifest.json").write_bytes(json.dumps(manifest, indent=1).encode("utf-8"))
    log(json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=1))
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dataset", default="observed-2026-v2")
    args = ap.parse_args()
    run(args.dataset)


if __name__ == "__main__":
    main()
