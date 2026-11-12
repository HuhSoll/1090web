"""Phase 9A temporal data on synthetic flights with deliberate time edge cases (no real data)."""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

import duckdb
import pytest

import temporal
from build_dataset import BuildConfig, build
from classify_aircraft import classify
from synthetic import AIRPORT_COLUMNS, AIRPORTS, FLIGHT_COLUMNS, f

A = (0.0, 0.0, "ground", ["AAAA"])
B = (0.0, 10.0, "ground", ["BBBB"])
C = (10.0, 0.0, "ground", ["CCCC"])

Q1 = [
    f("d01", "A20N", "A320 251NSL", "AAA", "A1", A, B, "AAAA-BBBB", "2026-03-31 23:30:00", "2026-04-01 01:10:00"),  # crosses day, month, quarter
    f("d02", "A20N", "A320 251NSL", "AAA", "A2", None, B, "AAAA-BBBB", "-", "2026-03-10 05:00:00"),  # start missing -> end fallback (T4 origin)
    f("d03", "A20N", "A320 251NSL", "AAA", "A3", A, B, "AAAA-BBBB", "2026-03-10 12:00:00", "2026-03-10 13:00:00"),  # window start boundary
    f("d03", "A20N", "A320 251NSL", "AAA", "A3", A, B, "AAAA-BBBB", "2026-03-10 12:00:00", "2026-03-10 13:00:00"),  # identical raw row
    f("d04", "A20N", "A320 251NSL", "BBB", "B4", B, A, "BBBB-AAAA", "2026-03-10 17:59:59", "2026-03-10 19:00:00"),  # last second inside
    f("d05", "B77L", "777 F", "CCC", "C5", A, C, "AAAA-CCCC", "2026-03-10 18:00:00", "2026-03-10 20:00:00"),  # window end: outside
    f("d06", "A20N", "A320 251NSL", "AAA", "A6", A, B, "AAAA-BBBB", "2026-03-11 10:00:00", "2026-03-11 09:00:00"),  # end before start
    f("d07", "A20N", "A320 251NSL", "AAA", "A7", A, C, "AAAA-CCCC", "2026-03-12 00:00:00", "2026-03-13 02:00:00"),  # 26 h track
    f("d08", "A20N", "A320 251NSL", "AAA", "A8", A, B, "AAAA-BBBB", "garbage", "2026-03-14 10:00:00"),  # unparseable start
    f("d09", "C172", "-", "DDD", "D9", (5.0, 5.0, "30000", []), (6.0, 6.0, "30000", []), "nan", "2026-03-15 10:00:00", "2026-03-15 11:00:00"),  # X
]
Q2 = [
    f("d01", "A20N", "A320 251NSL", "AAA", "A1", A, B, "AAAA-BBBB", "2026-03-31 23:30:00", "2026-04-01 01:10:00"),  # overlap copy
    f("d10", "A20N", "A320 251NSL", "AAA", "A10", B, A, "BBBB-AAAA", "2026-04-02 08:00:00", "2026-04-02 08:03:00"),  # 3 min track
]


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
    cols = ", ".join(f'"{c}" VARCHAR' for c in FLIGHT_COLUMNS)
    for q, rows in (("Q1", Q1), ("Q2", Q2)):
        con.execute(f"CREATE OR REPLACE TABLE t ({cols})")
        con.executemany(f"INSERT INTO t VALUES ({', '.join('?' for _ in FLIGHT_COLUMNS)})", rows)
        path = root / f"2026_{q}_detailed_github.parquet"
        con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
        files.append(path)
    classes = root / "classes.csv"
    with classes.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ac_type", "ac_type_detailed", "class", "rule", "flights_2026_q1_q3"])
        for ac, detail in sorted({(r[2], r[3]) for r in Q1 + Q2}):
            w.writerow([ac, detail, *classify(ac, detail), 0])
    return {"flights": files, "airports": ap, "classes": classes}


def run(tmp: Path, inputs: dict, name: str, **kw):
    ds = tmp / "ds"
    if not ds.exists():
        build(BuildConfig(flight_files=inputs["flights"], ourairports_csv=inputs["airports"], classes_csv=inputs["classes"],
                          out_dir=ds, dataset_id="ds", dataset_version="0.0.1", quality_path=tmp / "q.json",
                          lock_path=None, record_git=False, log=lambda *_: None))
    cfg = temporal.TemporalConfig(flight_files=inputs["flights"], ourairports_csv=inputs["airports"], classes_csv=inputs["classes"],
                                  dataset_dir=ds, research_out=tmp / name / "research", public_out=tmp / name / "public",
                                  lock_path=None, record_git=False, log=lambda *_: None, **kw)
    return cfg, temporal.run(cfg)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("temporal")
    inputs = write_inputs(tmp / "in")
    cfg, res = run(tmp, inputs, "a")
    return tmp, inputs, cfg, res


def research_rows(cfg, month):
    return duckdb.sql(f"SELECT * FROM read_parquet('{(cfg.research_out / f'flights_{month}.parquet').as_posix()}')").fetchall()


def test_time_definitions_and_fallback(built):
    _, _, cfg, _ = built
    cols = [c[0] for c in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{(cfg.research_out / 'flights_2026-03.parquet').as_posix()}')").fetchall()]
    rows = [dict(zip(cols, r)) for r in research_rows(cfg, "2026-03")]
    d02 = [r for r in rows if r["timeBasis"] == "TRACK_END_FALLBACK"]
    assert len(d02) == 1 and d02[0]["trackStartTimeUtc"] is None
    assert d02[0]["referenceTimeUtc"] == datetime(2026, 3, 10, 5, 0)          # no departure time invented
    d01 = [r for r in rows if r["trackStartTimeUtc"] == datetime(2026, 3, 31, 23, 30)]
    assert len(d01) == 1                                                       # quarter overlap counted once
    assert d01[0]["trackEndTimeUtc"] == datetime(2026, 4, 1, 1, 10)            # end kept as observed
    assert {"flightId", "originAirport", "destinationAirport", "confidenceTier", "originRule", "sourceQuarter"} <= set(cols)
    assert not {"ICAO_Hex", "Reg", "Callsign"} & set(cols)


def test_time_quality_checks(built):
    _, _, _, res = built
    q = res["timeQuality"]
    assert q["raw"]["time_parse_failures"] == 1           # d08 ('garbage' start): out of scope, counted
    assert q["raw"]["start_missing_end_only"] == 1        # d02
    assert q["raw"]["outside_file_quarter"] == 1          # d01 copy in the Q2 file
    fl = q["flights"]
    assert fl["end_before_start"] == 1                    # d06: kept, reported
    assert fl["longer_than_20_h"] == 1                    # d07
    assert fl["shorter_than_5_min"] == 1                  # d10
    assert fl["crosses_utc_day"] == 2 and fl["crosses_month"] == 1 and fl["crosses_quarter"] == 1
    assert q["identical_raw_rows_extra_copies"] == 1      # d03 twice
    assert fl["track_start_missing"] == 1


def test_ids_are_unique_and_reproducible(built):
    tmp, inputs, cfg, _ = built
    ids = [r[0] for r in research_rows(cfg, "2026-03")]
    assert len(ids) == len(set(ids))
    cfg2, _ = run(tmp, inputs, "b", months=["2026-03"])  # subset run: same ids for the same rows
    assert sorted(ids) == sorted(r[0] for r in research_rows(cfg2, "2026-03"))


def test_monthly_consistency(built):
    _, _, _, res = built
    for m, c in res["consistency"].items():
        assert c["keys_differing"] == 0 and c["monthly_flights"] == c["temporal_flights"], m


def load_days(cfg) -> dict:
    out = {}
    for p in sorted((cfg.public_out / "days").glob("*.json")):
        out[p.stem] = json.loads(p.read_text(encoding="utf-8"))
    return out


def test_public_files_schema_and_privacy(built):
    _, _, cfg, _ = built
    man = json.loads((cfg.public_out / "manifest.json").read_text(encoding="utf-8"))
    assert man["schemaVersion"] == temporal.PUBLIC_SCHEMA_VERSION
    assert man["license"].startswith("ODbL-1.0") and man["privacy"]
    assert man["timeDefinitions"]["windowMembership"].startswith("a flight belongs to [start, end)")
    for name, info in man["files"].items():
        body = (cfg.public_out / name).read_bytes()
        assert len(body) == info["bytes"] <= temporal.MAX_PUBLIC_FILE_BYTES
    day = json.loads((cfg.public_out / "days" / "2026-03-10.json").read_text(encoding="utf-8"))
    assert set(day) == {"schemaVersion", "day", "n", "r", "k", "t", "c", "x"}
    assert sum(day["k"]) == day["n"] == len(day["t"]) == len(day["c"]) == len(day["x"])
    text = (cfg.public_out / "days" / "2026-03-10.json").read_text(encoding="utf-8")
    assert "A3" not in text and "d03" not in text                             # no callsign / aircraft id
    idx = json.loads((cfg.public_out / "index.json").read_text(encoding="utf-8"))
    assert [d["day"] for d in idx["days"]] == sorted(load_days(cfg))
    # every calendar day of the months has an entry, days without flights included
    assert len(idx["days"]) == 31 + 30 and idx["days"][0]["day"] == "2026-03-01"
    empty = next(d for d in idx["days"] if d["day"] == "2026-03-02")
    assert empty["flights"] == 0 and json.loads((cfg.public_out / empty["file"]).read_text(encoding="utf-8"))["n"] == 0
    assert all(sum(d["hourly"]) == d["flights"] for d in idx["days"])


def test_half_open_windows_and_day_boundaries(built):
    _, _, cfg, _ = built
    docs = load_days(cfg)
    w = temporal.window_events(docs, datetime(2026, 3, 10, 12), datetime(2026, 3, 10, 18))
    assert sorted(e["minute"] for e in w) == [720, 720, 1079]                 # d03 x2 at 12:00, d04 at 17:59(:59); d05 at 18:00 out
    assert temporal.window_events(docs, datetime(2026, 3, 10, 18), datetime(2026, 3, 10, 19))[0]["minute"] == 1080
    # a window across midnight reads both days; d01 belongs to 31 Mar (reference time), not to 1 Apr
    assert len(temporal.window_events(docs, datetime(2026, 3, 31, 23), datetime(2026, 4, 1, 1))) == 1
    assert temporal.window_events(docs, datetime(2026, 4, 1), datetime(2026, 4, 2)) == []
    assert temporal.days_for_window(datetime(2026, 3, 1), datetime(2026, 3, 2)) == ["2026-03-01"]
    assert temporal.days_for_window(datetime(2026, 3, 1, 12), datetime(2026, 3, 1, 12)) == []


def test_daily_sums_match_monthly_and_directions_do_not_double_count(built):
    _, _, cfg, _ = built
    docs = load_days(cfg)
    march = temporal.window_events(docs, datetime(2026, 3, 1), datetime(2026, 4, 1))
    month = json.loads((cfg.dataset_dir / "months" / "2026-03.json").read_text(encoding="utf-8"))["records"]
    assert len(march) == sum(r[3] + r[4] + r[5] for r in month)
    directed = temporal.aggregate(march, directed=True)
    undirected = temporal.aggregate(march, directed=False)
    assert sum(directed.values()) == sum(undirected.values()) == len(march)
    tiers = {t: sum(1 for e in march if e["tier"] == t) for t in (1, 2, 3, 4)}
    assert tiers[4] == sum(r[3] + r[4] + r[5] for r in month if len(r) > 6 and r[6] == 1)


def test_same_inputs_give_identical_public_files(built):
    tmp, inputs, cfg, _ = built
    cfg2, _ = run(tmp, inputs, "c")
    for p in (cfg.public_out / "days").glob("*.json"):
        assert p.read_bytes() == (cfg2.public_out / "days" / p.name).read_bytes()
    assert (cfg.public_out / "index.json").read_bytes() == (cfg2.public_out / "index.json").read_bytes()


def test_known_gap_metadata_present(built):
    _, _, cfg, _ = built
    q = json.loads((cfg.public_out / "quality.json").read_text(encoding="utf-8"))
    assert q["coverage"]["knownGap"]["from"] == "2026-05-05T00:00:00Z"
    assert q["coverage"]["thresholds"]["gapRatio"] == 0.05


def test_independent_verification_passes(built):
    import temporal_verify
    _, _, cfg, _ = built
    res = temporal_verify.verify(cfg.dataset_dir, cfg.public_out, cfg.research_out)
    assert res["ok"], res
    assert res["months"]["2026-03"]["daily_sum_flights"] == res["months"]["2026-03"]["monthly_flights"]
    assert all(v["keys_differing"] == 0 for v in res["research_vs_routes_monthly"].values())


def test_public_size_budget_is_enforced(built, monkeypatch):
    tmp, inputs, _, _ = built
    monkeypatch.setattr(temporal, "MAX_PUBLIC_FILE_BYTES", 100)
    with pytest.raises(RuntimeError, match="exceeds the budget"):
        run(tmp, inputs, "d")
