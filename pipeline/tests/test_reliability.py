"""Phase 6B runner: unit checks of its aggregation helpers and an end-to-end run on a synthetic build."""

from __future__ import annotations

import csv
import json
from datetime import date

import pytest

from analysis import reliability as rel
from analysis.coverage import DetectionConfig
from build_dataset import BuildConfig, build
from synthetic import write_inputs

# (month, origin, destination, tier, origin_rule, destination_rule, flights)
ROWS = [
    ("2026-03", "AAAA", "BBBB", "T1_track", "R1", "R1", 5),
    ("2026-03", "BBBB", "AAAA", "T2_track_conflict", "R1", "R2", 2),
    ("2026-03", "AAAA", "CCCC", "T3_track_callsign", "R3", "R1", 1),
    ("2026-03", "CCCC", "DDDD", "T4_callsign_only", "R1", "R4", 4),
    ("2026-03", "DDDD", None, "X_unresolved", "R1", "R5", 3),
    ("2026-04", "AAAA", "BBBB", "T1_track", "R1", "R1", 1),
]
SCOPE = {"AAAA": "EU", "BBBB": "EU", "CCCC": "AS", "DDDD": "NA"}


def test_tier_filtering():
    mt = rel.edges_by_month_tier(ROWS)
    march = mt["2026-03"]
    assert "X_unresolved" not in march  # unresolved flights never enter a network
    assert rel.select_tiers(march, ["T1_track"]) == {("AAAA", "BBBB"): 5}
    assert rel.select_tiers(march, ["T1_track", "T2_track_conflict"]) == {("AAAA", "BBBB"): 5, ("BBBB", "AAAA"): 2}
    assert len(rel.select_tiers(march, rel.TIERS)) == 4


def test_regional_aggregation_by_hand():
    q = rel.scope_quality(ROWS, SCOPE, persistent={("AAAA", "BBBB")})
    eu = q[("EU", "2026-03")]
    # flights touching EU: A-B 5 + B-A 2 + A-C 1 (each counted once although both ends are in EU)
    assert eu["flights_on_map"] == 8
    assert eu["share_T1"] == round(5 / 8, 4) and eu["share_T2"] == round(2 / 8, 4) and eu["share_T4"] == 0
    # ends located in EU: A-B (R1, R1) x5, B-A (R1, R2) x2, A (R3) x1
    assert (eu["ends_R1"], eu["ends_R2"], eu["ends_R3"], eu["ends_R4"]) == (12, 2, 1, 0)
    assert eu["track_end_share"] == round(14 / 15, 4)
    assert eu["routes"] == 2 and eu["route_persistence_share_6m"] == 0.5
    na = q[("NA", "2026-03")]
    assert na["flights_on_map"] == 4 and na["share_T4"] == 1.0
    assert na["x_unresolved_touching"] == 3          # the X flight is counted through its known end
    assert na["ends_R4"] == 4 and na["ends_R1"] == 3  # R5 end has no airport and is not attributed
    assert na["callsign_only_end_share"] == round(4 / 7, 4)


def test_parse_eurostat_json_stat():
    doc = {"id": ["freq", "rep_airp", "time"], "size": [1, 2, 2],
           "dimension": {"freq": {"category": {"index": {"M": 0}}},
                         "rep_airp": {"category": {"index": {"DE_EDDF": 0, "FR_LFPG": 1}}},
                         "time": {"category": {"index": {"2026-01": 0, "2026-02": 1}}}},
           "value": {"0": 10, "1": 11, "3": 21}}
    assert rel.parse_eurostat(doc) == {"DE_EDDF": {"2026-01": 10, "2026-02": 11}, "FR_LFPG": {"2026-02": 21}}


@pytest.fixture(scope="module")
def analysed(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("rel")
    inputs = write_inputs(tmp / "inputs")
    ds = tmp / "ds"
    build(BuildConfig(flight_files=inputs["flights"], ourairports_csv=inputs["airports"],
                      classes_csv=inputs["classes"], out_dir=ds, dataset_id="ds", dataset_version="0.0.0-test",
                      quality_path=tmp / "q.json", lock_path=None, record_git=False, log=lambda *_: None))
    out = tmp / "analysis"
    cfg = rel.Config(dataset_dir=ds, out_dir=out, compare_dir=ds, raw_flights=inputs["flights"],
                     focus_month="2026-03", lock_path=None, record_git=False, log=lambda *_: None)
    res = rel.run(cfg)
    return cfg, out, res


def test_runner_writes_every_output_with_metadata(analysed):
    cfg, out, res = analysed
    expected = {"coverage_daily_assessment.csv", "coverage_hourly_world.csv", "coverage_gaps.csv",
                "coverage_anomalies.json", "coverage_summary.csv", "monthly_normalization_comparison.csv",
                "confidence_sensitivity.csv", "confidence_sensitivity.json", "route_threshold_sensitivity.csv",
                "route_persistence.json", "ranking_robustness_2026-03.json", "ranking_robustness_2026-03.csv",
                "external_validation_summary.json"}
    assert set(res["outputs"]) == expected
    for name in expected:
        meta = json.loads((out / (name.rsplit(".", 1)[0] + ".meta.json")).read_text(encoding="utf-8"))
        for key in ("dataset", "inputs", "period", "conditions", "thresholds", "method", "generatedAt", "script"):
            assert key in meta, (name, key)
        assert meta["dataset"]["version"] == "0.0.0-test"
        assert meta["script"]["version"] == rel.SCRIPT_VERSION
    ext = json.loads((out / "external_validation_summary.json").read_text(encoding="utf-8"))
    assert ext["status"].startswith("not run")  # no Eurostat data given: reported, nothing invented


def test_runner_baseline_matches_the_build(analysed):
    """The recomputed daily baseline equals the one build_dataset wrote (same definition)."""
    cfg, out, _ = analysed
    with (cfg.dataset_dir / "research" / "coverage_daily.csv").open(encoding="utf-8") as fh:
        built = {(r["day"], r["region"]): r for r in csv.DictReader(fh)}
    with (out / "coverage_daily_assessment.csv").open(encoding="utf-8") as fh:
        ours = list(csv.DictReader(fh))
    assert len(ours) == len(built)
    for r in ours:
        b = built[(r["day"], r["region"])]
        assert int(r["flights"]) == int(b["flights"])
        assert (float(r["baseline"]) if r["baseline"] else None) == (float(b["baseline"]) if b["baseline"] else None)


def test_runner_tier_conditions_are_nested(analysed):
    _, out, _ = analysed
    with (out / "confidence_sensitivity.csv").open(encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r["month"] == "2026-03"]
    flights = {r["condition"]: int(r["flights"]) for r in rows}
    assert flights["A_T1"] <= flights["B_T1-T2"] <= flights["C_T1-T3"] <= flights["D_T1-T4"]
    # the D network is the map network of that month
    manifest = json.loads((out.parent / "ds" / "manifest.json").read_text(encoding="utf-8"))
    month = json.loads((out.parent / "ds" / "months" / "2026-03.json").read_text(encoding="utf-8"))["records"]
    assert flights["D_T1-T4"] == sum(r[3] + r[4] + r[5] for r in month)
    assert manifest["months"][0]["month"] == "2026-03"


def test_runner_refuses_to_overwrite(analysed):
    cfg, _, _ = analysed
    with pytest.raises(FileExistsError):
        rel.run(cfg)


def test_runner_threshold_rows(analysed):
    _, out, _ = analysed
    with (out / "route_threshold_sensitivity.csv").open(encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r["month"] == "2026-03"]
    routes = {int(r["min_flights"]): int(r["routes"]) for r in rows}
    assert routes[1] >= routes[4] >= routes[10] >= routes[30]
    assert routes[30] == 0


def test_detection_config_is_recorded(analysed):
    _, out, _ = analysed
    meta = json.loads((out / "coverage_anomalies.meta.json").read_text(encoding="utf-8"))
    assert meta["thresholds"]["low_ratio"] == DetectionConfig().low_ratio
    assert meta["thresholds"]["window_days"] == 28
    assert date.fromisoformat(meta["period"]["from"] + "-01")
