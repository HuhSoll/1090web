"""End-to-end pipeline tests on synthetic inputs (no real data)."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import duckdb
import pytest

import provenance
from build_dataset import BuildConfig, build
from synthetic import EXPECTED, write_inputs


def run(tmp: Path, name: str, inputs: dict, **kw) -> tuple[Path, dict]:
    out = tmp / name
    cfg = BuildConfig(
        flight_files=inputs["flights"],
        ourairports_csv=inputs["airports"],
        classes_csv=inputs["classes"],
        out_dir=out,
        dataset_id=name,
        dataset_version="0.0.0-test",
        quality_path=tmp / f"{name}-quality.json",
        lock_path=None,
        record_git=False,
        log=lambda *_: None,
        **kw,
    )
    return out, build(cfg)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("build")
    inputs = write_inputs(tmp / "inputs")
    out, stats = run(tmp, "ds", inputs)
    return tmp, inputs, out, stats


def research_rows(out: Path) -> list[tuple]:
    return duckdb.sql(f"SELECT * FROM read_parquet('{(out / 'research' / 'routes_monthly.parquet').as_posix()}')").fetchall()


def test_scope_and_quarter_overlap(built):
    _, _, _, stats = built
    # 12 Q1 rows + 2 Q2 rows; minus 1 without airline code; the overlap copy of h11 in Q2 is out of
    # its quarter (March) and dropped, so h11 is counted once.
    assert stats["raw_rows"] == 14
    assert stats["raw_rows_without_airline"] == 1
    assert stats["flights_in_scope"] == 12
    assert stats["removed_quarter_overlap_or_bad_time"] == 1


def test_every_synthetic_flight_resolves_as_expected(built):
    _, _, out, _ = built
    # The research table keeps rules and tiers; each synthetic flight has a unique
    # (origin, destination, airline, month, rules) signature except where noted.
    rows = research_rows(out)
    cols = ["month", "origin", "destination", "airline", "class", "origin_rule", "destination_rule",
            "origin_conflict", "destination_conflict", "tier", "same_airport", "flights"]
    recs = [dict(zip(cols, r)) for r in rows]
    for hex_, (o, orule, d, drule, tier) in EXPECTED.items():
        match = [r for r in recs if r["origin"] == o and r["destination"] == d and r["origin_rule"] == orule
                 and r["destination_rule"] == drule and r["tier"] == tier]
        assert match, f"{hex_}: no research row for {o}({orule}) -> {d}({drule}) {tier}"


def test_tier_counts(built):
    _, _, _, stats = built
    assert stats["tiers"] == {
        "T1_track": 7,           # h01 h02 h04 h09 h11 h12 h13
        "T2_track_conflict": 1,  # h07
        "T3_track_callsign": 1,  # h03
        "T4_callsign_only": 2,   # h05 h08
        "X_unresolved": 1,       # h06
    }
    assert stats["conflict_flights"] == 1
    assert stats["same_airport_excluded"] == 1   # h09
    assert stats["flights_on_map"] == 12 - 1 - 1  # minus unresolved, minus same airport


def test_rules_per_end(built):
    _, _, _, stats = built
    assert stats["rules"]["origin"] == {"R1": 7, "R2": 1, "R3": 1, "R4": 2, "R5": 1}
    assert stats["rules"]["destination"] == {"R1": 11, "R5": 1}


def test_duplicate_codes_merge_only_within_one_record(built):
    _, _, out, _ = built
    airports = {a["id"] for a in json.loads((out / "airports.json").read_text(encoding="utf-8"))}
    assert "NEW1" in airports and "OLD1" not in airports  # same record -> one node
    assert "ZZZZ" not in airports                          # closed airport never used
    with (out / "research" / "airport_aliases.csv").open(encoding="utf-8") as fh:
        aliases = {r["code"]: r for r in csv.DictReader(fh)}
    assert aliases["OLD1"]["canonical"] == "NEW1" and aliases["OLD1"]["status"].startswith("merged")
    assert aliases["DUPC"]["status"].startswith("unresolved")  # matches two records: reported, not merged


def test_canonical_override_keeps_label_but_merges(tmp_path):
    from airports import load_airports
    from synthetic import write_inputs
    inputs = write_inputs(tmp_path / "in")
    ov = tmp_path / "ov.csv"
    ov.write_text("ourairports_id,canonical,iata,status,reason\n3,OLD1,OLD,label_unverified,test\n", encoding="utf-8")
    con = duckdb.connect()
    load_airports(con, inputs["airports"], ov)
    got = dict(con.execute("SELECT code, canon FROM ap_code WHERE code IN ('OLD1','NEW1')").fetchall())
    assert got == {"OLD1": "OLD1", "NEW1": "OLD1"}  # still one airport, label from the override


def test_monthly_explore_aggregation(built):
    _, _, out, _ = built
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert [m["month"] for m in manifest["months"]] == ["2026-03", "2026-04"]
    routes = {i: (a, b) for i, a, b in json.loads((out / "routes.json").read_text(encoding="utf-8"))}
    march = json.loads((out / "months" / "2026-03.json").read_text(encoding="utf-8"))["records"]
    ab = [r for r in march if routes[r[0]] == ("AAAA", "BBBB")]
    # AAAA->BBBB in March: h01, h07 (T2 counts as basis 0), h11 -> 3 passenger flights, basis 0;
    # h05 (AAAA from callsign, cargo) -> basis 1.
    by_basis = {(r[1], r[6]): (r[3], r[4], r[5]) for r in ab}
    assert by_basis[(0, 0)] == (3, 0, 0)
    assert by_basis[(0, 1)] == (0, 1, 0)
    april = json.loads((out / "months" / "2026-04.json").read_text(encoding="utf-8"))["records"]
    assert [(routes[r[0]], r[1], r[3]) for r in april] == [(("AAAA", "BBBB"), 1, 1)]  # h12, direction B->A


def test_existing_output_is_never_overwritten(built):
    tmp, inputs, out, _ = built
    with pytest.raises(FileExistsError):
        run(tmp, "ds", inputs)


def test_same_inputs_give_identical_outputs(built):
    tmp, inputs, out, _ = built
    out2, _ = run(tmp, "ds2", inputs)
    files = sorted(p.relative_to(out) for p in out.rglob("*") if p.is_file())
    assert files == sorted(p.relative_to(out2) for p in out2.rglob("*") if p.is_file())
    for rel in files:
        a, b = (out / rel).read_bytes(), (out2 / rel).read_bytes()
        if rel.name in ("manifest.json", "provenance.json"):
            ja, jb = json.loads(a), json.loads(b)
            for j in (ja, jb):
                j.pop("generatedAt", None)
                j.pop("datasetId", None)
            assert ja == jb, rel
        elif rel.suffix == ".parquet":
            assert research_rows(out) == research_rows(out2)
        else:
            assert a == b, rel


def test_lock_detects_changed_input(tmp_path):
    p = tmp_path / "x.bin"
    p.write_bytes(b"abc")
    d = provenance.InputFile("flights", p).describe()
    lock = tmp_path / "lock.json"
    lock.write_text(json.dumps({"inputs": [{**d, "sha256": "0" * 64}]}), encoding="utf-8")
    with pytest.raises(provenance.LockMismatch):
        provenance.verify_against_lock([d], lock)
    lock.write_text(json.dumps({"inputs": [d]}), encoding="utf-8")
    assert provenance.verify_against_lock([d], lock)["x.bin"]["sha256"] == d["sha256"]


def test_coverage_detection_flags_but_does_not_correct(built):
    _, _, out, _ = built
    with (out / "research" / "coverage_daily.csv").open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert rows and {"day", "region", "flights", "baseline", "ratio", "suspected_low"} <= set(rows[0])
    world = [r for r in rows if r["region"] == "WORLD"]
    # calendar is complete: days without flights appear with 0 (detectable), nothing is imputed
    assert any(r["flights"] == "0" for r in world)
