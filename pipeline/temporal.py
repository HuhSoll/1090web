"""
Phase 9A: time-resolved observed flights.

Runs the same front half as the monthly build (build_dataset.prepare: scope, quarter overlap,
airport resolution R1-R5, tiers, aircraft classes) and keeps every flight with its times instead
of aggregating by month. Nothing here re-implements airport resolution or classification.

Times (UTC, naive timestamps in the source):
  trackStartTime   first point of the ADS-B track (Track_Origin_DateTime_UTC); NOT the take-off time
  trackEndTime     last point of the track (Track_Destination_DateTime_UTC); NOT the landing time
  referenceTime    the time the monthly data is built on: trackStartTime, else trackEndTime
  timeBasis        TRACK_START or TRACK_END_FALLBACK (which of the two referenceTime is)
A time window [start, end) contains a flight when start <= referenceTime < end ("reference-time
membership"). Flights possibly airborne in a window are a different question and are not mixed in.

Outputs
  research (not published, Parquet):  data/research/<dataset>/temporal/flights_<YYYY-MM>.parquet
  public   (browser, per UTC day):     public/data/<dataset>/temporal/   (see write_public)

  python pipeline/temporal.py --dataset observed-2026-v2 --months 2026-03 [--days 2026-03-01,2026-03-02]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import provenance  # noqa: E402
from build_dataset import BuildConfig, prepare  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RESEARCH_SCHEMA_VERSION = 1
PUBLIC_SCHEMA_VERSION = 1
SCRIPT_VERSION = "9a.1"
TIER_CODE = {"T1_track": 1, "T2_track_conflict": 2, "T3_track_callsign": 3, "T4_callsign_only": 4}
CLASS_CODE = {"passenger": 0, "cargo": 1, "unknown": 2}
BASIS_CODE = {"TRACK_START": 0, "TRACK_END_FALLBACK": 1}
# time-quality thresholds (reported, never used to delete flights)
LONG_TRACK_HOURS = 20
SHORT_TRACK_MINUTES = 5
MAX_PLAUSIBLE_KMH = 1300
# public data budget (GitHub Pages: 1 GB site, 100 MB per file; we stay far below)
MAX_PUBLIC_FILE_BYTES = 5_000_000
MAX_PUBLIC_TOTAL_BYTES = 300_000_000


@dataclass
class TemporalConfig:
    flight_files: list[Path]
    ourairports_csv: Path
    classes_csv: Path
    dataset_dir: Path                 # the monthly dataset the temporal data belongs to (route ids)
    research_out: Path | None
    public_out: Path | None
    months: list[str] | None = None
    days: list[str] | None = None     # restrict the PUBLIC output to these UTC days
    year: int = 2026
    lock_path: Path | None = provenance.LOCK_PATH
    record_git: bool = True
    log: callable = field(default=print)


# ---- build ---------------------------------------------------------------------------------------

def temporal_table(con) -> None:
    """One row per flight in scope, with the resolution results of build_dataset.prepare()."""
    con.execute("""
    CREATE OR REPLACE TABLE temporal AS
    WITH j AS (
      SELECT f.row_key, f.fid, r.org, r.dst, f.org_time, f.dst_time, f.ref_time, f.time_basis, r.airline, r.class,
             r.org_rule, r.dst_rule, r.tier, coalesce(r.org_conflict OR r.dst_conflict, false) AS conflict,
             f.quarter, r.month, r.day
      FROM resolved r JOIN flights f USING (fid))
    SELECT
      -- identical raw rows share a row_key; a suffix keeps ids unique (the rows are interchangeable)
      row_key || '-' || row_number() OVER (PARTITION BY row_key ORDER BY fid) AS flight_id,
      * EXCLUDE (row_key, fid),
      tier <> 'X_unresolved' AND org IS NOT NULL AND dst IS NOT NULL AND org <> dst AS on_map,
      coalesce(org = dst, false) AS same_airport
    FROM j
    ORDER BY ref_time, flight_id;
    """)


def time_quality(con, flight_files: list[Path], year: int) -> dict:
    """Raw-level and flight-level checks of the time fields. Nothing is deleted here."""
    files = ", ".join(f"'{p.as_posix()}'" for p in flight_files)
    raw = con.execute(f"""
        WITH r AS (SELECT Airline, Track_Origin_DateTime_UTC o, Track_Destination_DateTime_UTC d,
                          regexp_extract(filename, '_Q(\\d)_', 1)::INT q FROM read_parquet([{files}], filename = true)),
        t AS (SELECT *, TRY_CAST(CASE WHEN o <> '-' THEN o ELSE d END AS TIMESTAMP) AS rt FROM r WHERE Airline <> '-')
        SELECT count(*),
          count(*) FILTER (WHERE o = '-' AND d = '-'),
          count(*) FILTER (WHERE (o <> '-' AND TRY_CAST(o AS TIMESTAMP) IS NULL) OR (d <> '-' AND TRY_CAST(d AS TIMESTAMP) IS NULL)),
          count(*) FILTER (WHERE o = '-' AND d <> '-'),
          count(*) FILTER (WHERE o <> '-' AND d = '-'),
          count(*) FILTER (WHERE regexp_matches(o, '[TZ+]') OR regexp_matches(d, '[TZ+]')),
          count(*) FILTER (WHERE rt IS NOT NULL AND year(rt) = {year} AND (month(rt) - 1) // 3 + 1 <> q),
          count(*) FILTER (WHERE rt IS NOT NULL AND year(rt) <> {year})
        FROM t""").fetchone()
    keys = ["airline_rows", "both_times_missing", "time_parse_failures", "start_missing_end_only",
            "end_missing_start_only", "times_with_timezone_markers", "outside_file_quarter", "outside_year"]
    out = {"raw": dict(zip(keys, raw))}
    f = con.execute(f"""
        WITH t AS (SELECT *, epoch(dst_time) - epoch(org_time) AS dur FROM temporal)
        SELECT count(*), count(*) FILTER (WHERE org_time IS NULL), count(*) FILTER (WHERE dst_time IS NULL),
          count(*) FILTER (WHERE dur < 0), count(*) FILTER (WHERE dur = 0),
          count(*) FILTER (WHERE dur > 0 AND dur < {SHORT_TRACK_MINUTES} * 60),
          count(*) FILTER (WHERE dur > {LONG_TRACK_HOURS} * 3600),
          count(*) FILTER (WHERE org_time::DATE <> dst_time::DATE),
          count(*) FILTER (WHERE strftime(org_time, '%Y-%m') <> strftime(dst_time, '%Y-%m')),
          count(*) FILTER (WHERE (month(org_time) - 1) // 3 <> (month(dst_time) - 1) // 3),
          quantile_cont(dur, 0.5) FILTER (WHERE dur > 0), quantile_cont(dur, 0.99) FILTER (WHERE dur > 0),
          max(dur)
        FROM t""").fetchone()
    fkeys = ["flights", "track_start_missing", "track_end_missing", "end_before_start", "zero_duration",
             f"shorter_than_{SHORT_TRACK_MINUTES}_min", f"longer_than_{LONG_TRACK_HOURS}_h", "crosses_utc_day",
             "crosses_month", "crosses_quarter", "duration_median_s", "duration_p99_s", "duration_max_s"]
    out["flights"] = dict(zip(fkeys, [round(x, 1) if isinstance(x, float) else x for x in f]))
    # implied ground speed between the two airports (only both-ends-known, positive duration)
    sp = con.execute(f"""
        WITH t AS (
          SELECT 2 * 6371 * asin(sqrt(pow(sin(radians(b.lat - a.lat) / 2), 2) +
                 cos(radians(a.lat)) * cos(radians(b.lat)) * pow(sin(radians(b.lon - a.lon) / 2), 2))) AS km,
                 (epoch(t.dst_time) - epoch(t.org_time)) / 3600.0 AS h
          FROM temporal t JOIN ap_rec a ON a.canon = t.org JOIN ap_rec b ON b.canon = t.dst
          WHERE t.on_map AND t.org_time IS NOT NULL AND t.dst_time IS NOT NULL AND t.dst_time > t.org_time)
        SELECT count(*), count(*) FILTER (WHERE km / h > {MAX_PLAUSIBLE_KMH}) FROM t""").fetchone()
    out["implied_speed"] = {"checked": sp[0], f"faster_than_{MAX_PLAUSIBLE_KMH}_kmh": sp[1],
                            "note": "airport-to-airport distance / track duration; the track may start after take-off, "
                                    "so high values point to track or time problems, not to fast aircraft"}
    out["time_basis_by_tier"] = {f"{t}|{b}": n for t, b, n in con.execute(
        "SELECT tier, time_basis, count(*) FROM temporal GROUP BY ALL ORDER BY ALL").fetchall()}
    out["start_missing_by_region"] = {c or "?": [n, m] for c, n, m in con.execute("""
        SELECT coalesce(a.continent, b.continent), count(*), count(*) FILTER (WHERE t.org_time IS NULL)
        FROM temporal t LEFT JOIN ap_rec a ON a.canon = t.org LEFT JOIN ap_rec b ON b.canon = t.dst
        GROUP BY 1 ORDER BY 1""").fetchall()}
    dup = con.execute("SELECT count(*) - count(DISTINCT split_part(flight_id, '-', 1)) FROM temporal").fetchone()[0]
    out["identical_raw_rows_extra_copies"] = dup
    out["thresholds"] = {"long_track_hours": LONG_TRACK_HOURS, "short_track_minutes": SHORT_TRACK_MINUTES,
                         "max_plausible_kmh": MAX_PLAUSIBLE_KMH}
    return out


def write_research(con, out: Path, months: list[str]) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    written = {}
    for m in months:
        path = out / f"flights_{m}.parquet"
        con.execute(f"""
            COPY (SELECT flight_id AS flightId, org AS originAirport, dst AS destinationAirport,
                         org_time AS trackStartTimeUtc, dst_time AS trackEndTimeUtc, ref_time AS referenceTimeUtc,
                         time_basis AS timeBasis, airline AS airlineCode, class AS aircraftClass,
                         org_rule AS originRule, dst_rule AS destinationRule, tier AS confidenceTier,
                         conflict AS callsignConflict, on_map AS onMap, same_airport AS sameAirport,
                         'Q' || quarter AS sourceQuarter
                  FROM temporal WHERE month = '{m}' ORDER BY ref_time, flight_id)
            TO '{path.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        written[path.name] = path.stat().st_size
    return written


# ---- public data ---------------------------------------------------------------------------------

def route_index(dataset_dir: Path) -> dict[tuple[str, str], int]:
    return {(a, b): i for i, a, b in json.loads((dataset_dir / "routes.json").read_text(encoding="utf-8"))}


def day_events(con, day: str, routes: dict, carriers: dict[str, int]) -> dict:
    """Compact per-day events for the flights on the map, grouped by route (smallest after gzip;
    see the benchmark in docs/phase9a-report.md).

      r  route ids of the groups, delta-encoded (ascending)
      k  number of flights in each group
      t  referenceTime in whole minutes since 00:00 UTC; delta-encoded inside each group
         (the first flight of a group is absolute). Minute-aligned windows are exact.
      c  airline code index (dataset manifest order), one per flight
      x  direction + 2*class + 6*(tier-1) + 24*timeBasis, one per flight
    Flights inside a group are ordered by (minute, c, x). Track durations stay in the research data.
    """
    rows = con.execute(f"""
        SELECT floor((epoch(ref_time) - epoch('{day}'::TIMESTAMP)) / 60)::INT AS minute, org, dst, airline, class, tier, time_basis
        FROM temporal WHERE on_map AND day = '{day}'::DATE""").fetchall()
    flights = []
    for minute, o, d, al, cls, tier, basis in rows:
        a, b = (o, d) if o < d else (d, o)
        flights.append((routes[(a, b)], int(minute), carriers[al],
                        (0 if o < d else 1) + 2 * CLASS_CODE[cls] + 6 * (TIER_CODE[tier] - 1) + 24 * BASIS_CODE[basis]))
    flights.sort()
    r, k, t, c, x = [], [], [], [], []
    prev_route, prev_min = -1, 0
    for rid, minute, ci, code in flights:
        if rid != prev_route:
            r.append(rid - (prev_route if prev_route >= 0 else 0))
            k.append(0)
            prev_route, prev_min = rid, 0
        k[-1] += 1
        t.append(minute - prev_min)
        prev_min = minute
        c.append(ci)
        x.append(code)
    return {"schemaVersion": PUBLIC_SCHEMA_VERSION, "day": day, "n": len(flights), "r": r, "k": k, "t": t, "c": c, "x": x}


def day_aggregates(events: dict) -> list[list[int]]:
    """Daily route aggregate (option A) from a day file: [route, dir, carrier, class, tier, flights]."""
    acc: dict[tuple, int] = defaultdict(int)
    for e in decode_day(events):
        acc[(e["route"], e["direction"], e["carrier"], e["class"], e["tier"])] += 1
    return [[*k, n] for k, n in sorted(acc.items())]


def encoded(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


def gz_size(b: bytes) -> int:
    return len(gzip.compress(b, compresslevel=6))


def benchmark(events: dict) -> dict:
    """Sizes of candidate formats for one day (raw and gzip). B_events_route_grouped is published."""
    dec = decode_day(events)
    hourly: dict[tuple, int] = defaultdict(int)
    for e in dec:
        hourly[(e["minute"] // 60, e["route"], e["direction"], e["carrier"], e["class"], e["tier"])] += 1
    by_time = sorted(dec, key=lambda e: (e["minute"], e["route"]))
    prev, tcol = 0, []
    for e in by_time:
        tcol.append(e["minute"] - prev)
        prev = e["minute"]
    time_sorted = {"t": tcol, "r": [e["route"] for e in by_time], "c": [e["carrier"] for e in by_time],
                   "x": [e["direction"] + 2 * e["class"] + 6 * (e["tier"] - 1) + 24 * e["basis"] for e in by_time]}
    cand = {
        "A_daily_route_aggregate": encoded(day_aggregates(events)),
        "A2_hourly_route_aggregate": encoded([[*k, n] for k, n in sorted(hourly.items())]),
        "B_events_time_sorted": encoded(time_sorted),
        "B_events_route_grouped (published)": encoded(events),
    }
    return {k: {"raw": len(v), "gzip": gz_size(v)} for k, v in cand.items()}


def hourly_counts(con, day: str) -> list[int]:
    rows = dict(con.execute(f"""SELECT hour(ref_time), count(*) FROM temporal WHERE on_map AND day = '{day}'::DATE GROUP BY 1""").fetchall())
    return [int(rows.get(h, 0)) for h in range(24)]


def region_counts(con, day: str) -> dict[str, int]:
    return {c or "?": n for c, n in con.execute(f"""
        SELECT coalesce(a.continent, b.continent), count(*) FROM temporal t
        LEFT JOIN ap_rec a ON a.canon = t.org LEFT JOIN ap_rec b ON b.canon = t.dst
        WHERE t.on_map AND t.day = '{day}'::DATE GROUP BY 1 ORDER BY 1""").fetchall()}


def coverage_flags(research_dir: Path) -> dict:
    """Phase 6B detection results (anomalous days, gap hours) to attach to the days."""
    p = research_dir / "phase6b" / "coverage_anomalies.json"
    if not p.exists():
        return {"available": False}
    a = json.loads(p.read_text(encoding="utf-8"))
    by_day = {x["day"]: {"direction": x["direction"], "scope": x["scope"], "evidence": x["evidence"],
                         "worldRatio": x["world_ratio"], "gapHours": x["gap_hours"],
                         "gapShareOfShortfall": x.get("gap_share_of_shortfall")} for x in a["anomalies"]}
    return {"available": True, "days": by_day, "gapRuns": a.get("gap_runs", []), "burstHours": a.get("burst_hours", []),
            "gapRatioSensitivity": {k: [(g["start"], g["end"], g["hours"]) for g in v] for k, v in a.get("gap_ratio_sensitivity", {}).items()}}


def calendar_days(months: list[str]) -> list[str]:
    """Every UTC day of the months, including days without any flight (they get an empty file,
    so 'no flights observed' is distinguishable from 'no data file')."""
    out = []
    for m in months:
        d = date.fromisoformat(f"{m}-01")
        while d.strftime("%Y-%m") == m:
            out.append(d.isoformat())
            d += timedelta(days=1)
    return out


def write_public(con, cfg: TemporalConfig, days: list[str], quality: dict) -> dict:
    out = cfg.public_out
    out.mkdir(parents=True, exist_ok=True)
    (out / "days").mkdir(exist_ok=True)
    manifest_ds = json.loads((cfg.dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    carriers = {c["id"]: i for i, c in enumerate(manifest_ds["carriers"])}
    routes = route_index(cfg.dataset_dir)
    research_dir = ROOT / "data" / "research" / manifest_ds["datasetId"]
    flags = coverage_flags(research_dir)
    index, files, bench = [], {}, {}
    for d in days:
        ev = day_events(con, d, routes, carriers)
        body = encoded(ev)
        name = f"days/{d}.json"
        (out / name).write_bytes(body)
        files[name] = {"bytes": len(body), "gzip": gz_size(body), "sha256": hashlib.sha256(body).hexdigest()}
        if len(bench) < 3:
            bench[d] = benchmark(ev)
        flag = flags.get("days", {}).get(d) if flags.get("available") else None
        index.append({"day": d, "flights": ev["n"], "file": name, "hourly": hourly_counts(con, d),
                      "regions": region_counts(con, d), "anomaly": flag})
    q = {
        "schemaVersion": PUBLIC_SCHEMA_VERSION,
        "datasetId": manifest_ds["datasetId"], "datasetVersion": manifest_ds.get("datasetVersion"),
        "timeDefinitions": TIME_DEFINITIONS,
        "timeQuality": quality,
        "coverage": {k: v for k, v in flags.items() if k != "days"} | {
            "thresholds": {"lowRatio": 0.8, "windowDays": 28, "gapRatio": 0.05, "note": "Phase 6B detection; detection only, nothing corrected"},
            "knownGap": KNOWN_GAP},
    }
    files_q = encoded(q)
    (out / "quality.json").write_bytes(files_q)
    files["quality.json"] = {"bytes": len(files_q), "gzip": gz_size(files_q), "sha256": hashlib.sha256(files_q).hexdigest()}
    idx = {"schemaVersion": PUBLIC_SCHEMA_VERSION, "datasetId": manifest_ds["datasetId"],
           "datasetVersion": manifest_ds.get("datasetVersion"), "days": index}
    body = encoded(idx)
    (out / "index.json").write_bytes(body)
    files["index.json"] = {"bytes": len(body), "gzip": gz_size(body), "sha256": hashlib.sha256(body).hexdigest()}
    total = sum(f["bytes"] for f in files.values())
    biggest = max(f["bytes"] for f in files.values())
    if biggest > MAX_PUBLIC_FILE_BYTES or total > MAX_PUBLIC_TOTAL_BYTES:
        raise RuntimeError(f"public temporal data exceeds the budget (largest {biggest} B, total {total} B)")
    manifest = {
        "schemaVersion": PUBLIC_SCHEMA_VERSION, "datasetId": manifest_ds["datasetId"],
        "datasetVersion": manifest_ds.get("datasetVersion"), "generatedAt": provenance.now_utc(),
        "script": {"name": "pipeline/temporal.py", "version": SCRIPT_VERSION,
                   "git": provenance.git_state() if cfg.record_git else None},
        "days": {"from": days[0], "to": days[-1], "count": len(days)},
        "format": EVENT_FORMAT, "timeDefinitions": TIME_DEFINITIONS,
        "routes": "routes.json of the dataset (route ids)", "carriers": "manifest.json carriers (index order)",
        "sources": manifest_ds.get("sources", []),
        "license": "ODbL-1.0 (derived from MrAirspace/aircraft-flight-schedules); see DATA_LICENSE.md",
        "privacy": "no registration, ICAO address, callsign or flight id is published",
        "files": files, "totalBytes": total, "totalGzipBytes": sum(f["gzip"] for f in files.values()),
        "benchmark": bench,
    }
    (out / "manifest.json").write_bytes(json.dumps(manifest, indent=1).encode("utf-8"))
    return manifest


TIME_DEFINITIONS = {
    "trackStartTime": "first point of the ADS-B track (UTC); not necessarily the take-off time",
    "trackEndTime": "last point of the ADS-B track (UTC); not necessarily the landing time",
    "referenceTime": "trackStartTime, else trackEndTime (the definition used by the monthly data)",
    "timeBasis": {"TRACK_START": "referenceTime is the track start", "TRACK_END_FALLBACK": "track start missing; referenceTime is the track end"},
    "windowMembership": "a flight belongs to [start, end) when start <= referenceTime < end (UTC)",
    "dayFiles": "a day file holds the flights whose referenceTime falls on that UTC date (minute resolution; track times in full precision are in the research data)",
    "notMixed": "flights possibly airborne during a window (track start/end overlapping it) are a different selection and are not used",
}
EVENT_FORMAT = {
    "r": "route ids of the groups (one group per route), delta-encoded; ids from the dataset's routes.json",
    "k": "number of flights in each group",
    "t": "referenceTime in whole minutes since 00:00 UTC of the day; delta-encoded inside each group, first value absolute",
    "c": "airline code index into the dataset's manifest carriers (one per flight)",
    "x": "direction + 2*class + 6*(tier-1) + 24*timeBasis; direction 0 = route a->b; class 0 passenger 1 cargo 2 unknown; "
         "tier 1..4 = T1..T4; timeBasis 0 TRACK_START 1 TRACK_END_FALLBACK",
    "resolution": "minute: windows whose bounds are whole minutes select exactly the same flights as with full timestamps",
}
KNOWN_GAP = {
    "from": "2026-05-05T00:00:00Z", "to": "2026-05-07T18:00:00Z", "hours": 66,
    "evidence": "worldwide flights <= 5% of the same weekday-hour baseline (Phase 6B); 6 flights against about 271,700 expected",
    "interpretation": "data-collection gap (inferred, not confirmed by the data provider); not a reduction of air traffic",
}


# ---- reading the public data (reference implementation; the browser does the same) --------------------

def decode_day(doc: dict) -> list[dict]:
    """Day file -> one dict per flight: minute of the UTC day and the decoded fields."""
    out = []
    i, route = 0, 0
    for g, (dr, k) in enumerate(zip(doc["r"], doc["k"])):
        route = dr if g == 0 else route + dr
        minute = 0
        for _ in range(k):
            minute += doc["t"][i]
            code = doc["x"][i]
            out.append({"minute": minute, "route": route, "carrier": doc["c"][i], "direction": code % 2,
                        "class": (code // 2) % 3, "tier": (code // 6) % 4 + 1, "basis": code // 24})
            i += 1
    return out


def days_for_window(start: datetime, end: datetime) -> list[str]:
    """UTC days whose files can hold flights with start <= referenceTime < end."""
    if end <= start:
        return []
    d, last = start.date(), (end - timedelta(microseconds=1)).date()
    out = []
    while d <= last:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def window_events(day_docs: dict[str, dict], start: datetime, end: datetime) -> list[dict]:
    """Events with start <= referenceTime < end (half-open, UTC)."""
    out = []
    for day in days_for_window(start, end):
        doc = day_docs.get(day)
        if doc is None:
            continue
        base = datetime.fromisoformat(day)
        for e in decode_day(doc):
            ts = base + timedelta(minutes=e["minute"])
            if start <= ts < end:
                out.append({**e, "day": day, "time": ts})
    return out


def aggregate(events: list[dict], directed: bool) -> dict[tuple, int]:
    """Route flights: directed (route, direction) or undirected (route). Each flight counted once."""
    acc: dict[tuple, int] = defaultdict(int)
    for e in events:
        acc[(e["route"], e["direction"]) if directed else (e["route"],)] += 1
    return dict(acc)


# ---- consistency with the monthly data ------------------------------------------------------------

def monthly_consistency(con, dataset_dir: Path, months: list[str]) -> dict:
    """Sums of the temporal flights (on the map) by month vs the published monthly records."""
    routes = route_index(dataset_dir)
    out = {}
    for m in months:
        recs = json.loads((dataset_dir / "months" / f"{m}.json").read_text(encoding="utf-8"))["records"]
        mon = defaultdict(int)
        for rid, d, al, p, c, u, *b in recs:
            basis = b[0] if b else 0
            for cls, n in (("passenger", p), ("cargo", c), ("unknown", u)):
                if n:
                    mon[(rid, d, al, cls, basis)] += n
        tem = defaultdict(int)
        for o, dst, al, cls, tier, n in con.execute(f"""
                SELECT org, dst, airline, class, tier, count(*) FROM temporal WHERE on_map AND month = '{m}' GROUP BY ALL""").fetchall():
            a, b = (o, dst) if o < dst else (dst, o)
            tem[(routes[(a, b)], 0 if o < dst else 1, al, cls, 1 if tier == "T4_callsign_only" else 0)] += n
        keys = set(mon) | set(tem)
        diff = {k: tem.get(k, 0) - mon.get(k, 0) for k in keys if tem.get(k, 0) != mon.get(k, 0)}
        out[m] = {"monthly_flights": sum(mon.values()), "temporal_flights": sum(tem.values()),
                  "record_keys": len(keys), "keys_differing": len(diff), "flights_differing": sum(abs(v) for v in diff.values())}
    return out


# ---- main ------------------------------------------------------------------------------------------

def run(cfg: TemporalConfig) -> dict:
    import duckdb

    t0 = time.time()
    log = lambda m: cfg.log(f"[{time.time() - t0:6.1f}s] {m}")  # noqa: E731
    described = [provenance.InputFile("flights", p).describe() for p in cfg.flight_files]
    if cfg.lock_path is not None:
        provenance.verify_against_lock(described + [provenance.InputFile("airports", cfg.ourairports_csv).describe()], cfg.lock_path)
        log("inputs verified against lock file")
    con = duckdb.connect()
    bcfg = BuildConfig(flight_files=cfg.flight_files, ourairports_csv=cfg.ourairports_csv, classes_csv=cfg.classes_csv,
                       out_dir=Path("."), dataset_id="temporal", dataset_version="-", year=cfg.year, months=cfg.months,
                       lock_path=None, record_git=False, stable_fid=False)
    stats = prepare(con, bcfg, log)
    temporal_table(con)
    log("temporal table built")
    months = [m for (m,) in con.execute("SELECT DISTINCT month FROM temporal ORDER BY 1").fetchall()]
    quality = time_quality(con, cfg.flight_files, cfg.year)
    quality["scope"] = {k: stats[k] for k in stats}
    log("time quality checked")
    result = {"months": months, "timeQuality": quality, "seconds": {}}
    if cfg.research_out:
        result["research"] = write_research(con, cfg.research_out, months)
        meta = {"schemaVersion": RESEARCH_SCHEMA_VERSION, "generatedAt": provenance.now_utc(), "months": months,
                "timeDefinitions": TIME_DEFINITIONS, "timeQuality": quality, "inputs": described,
                "script": {"name": "pipeline/temporal.py", "version": SCRIPT_VERSION,
                           "git": provenance.git_state() if cfg.record_git else None},
                "note": "Research data: not published. flightId is derived from the raw row content and is stable across runs."}
        (cfg.research_out / "temporal_meta.json").write_text(json.dumps(meta, indent=1, default=str), encoding="utf-8")
        log("research Parquet written")
    result["consistency"] = monthly_consistency(con, cfg.dataset_dir, months)
    log("monthly consistency checked")
    if cfg.public_out:
        days = [d for d in calendar_days(months) if not cfg.days or d in cfg.days]
        result["public"] = write_public(con, cfg, days, quality)
        log(f"public data written ({len(days)} days)")
    result["seconds"]["total"] = round(time.time() - t0, 1)
    return result


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", default="observed-2026-v2")
    p.add_argument("--months", help="comma-separated YYYY-MM (default: all months of the inputs)")
    p.add_argument("--days", help="comma-separated YYYY-MM-DD for the public output (default: every day)")
    p.add_argument("--no-public", action="store_true")
    p.add_argument("--public-out", help="default: public/data/<dataset>/temporal")
    p.add_argument("--research-out", help="default: data/research/<dataset>/temporal")
    a = p.parse_args()
    dataset_dir = ROOT / "public" / "data" / a.dataset
    cfg = TemporalConfig(
        flight_files=sorted((ROOT / "data" / "raw" / "flights").glob("2026_Q*_detailed_github.parquet")),
        ourairports_csv=ROOT / "data" / "raw" / "ourairports" / "airports.csv",
        classes_csv=ROOT / "pipeline" / "reference" / "aircraft_variant_class.csv",
        dataset_dir=dataset_dir,
        research_out=Path(a.research_out) if a.research_out else ROOT / "data" / "research" / a.dataset / "temporal",
        public_out=None if a.no_public else (Path(a.public_out) if a.public_out else dataset_dir / "temporal"),
        months=a.months.split(",") if a.months else None,
        days=a.days.split(",") if a.days else None,
    )
    res = run(cfg)
    summary = {k: v for k, v in res.items() if k != "public"}
    if "public" in res:
        summary["public"] = {k: res["public"][k] for k in ("days", "totalBytes", "totalGzipBytes", "benchmark")}
    print(json.dumps(summary, indent=1, default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
