"""Daily/hourly anomaly detection and monthly normalisation on hand-made series."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from analysis import coverage as cov

D0 = date(2026, 3, 2)  # a Monday


def weeks(values_by_week: list[int], weekday_offset: int = 0) -> dict[date, int]:
    return {D0 + timedelta(days=7 * i + weekday_offset): v for i, v in enumerate(values_by_week)}


def test_weekday_baseline_by_hand():
    s = weeks([10, 20, 30, 40, 50])
    b = cov.weekday_baseline(s, window_days=28)
    assert b[D0 + timedelta(days=14)] == 30.0   # neighbours 10, 20, 40, 50
    assert b[D0] == 35.0                         # 20, 30, 40, 50 (28 days away is inside)
    assert cov.weekday_baseline(s, window_days=14)[D0] == 25.0  # 20, 30
    # other weekdays never enter the baseline
    s2 = {**s, D0 + timedelta(days=1): 1000}
    assert cov.weekday_baseline(s2, 28)[D0] == 35.0
    assert cov.weekday_baseline(s2, 28)[D0 + timedelta(days=1)] is None


def test_daily_totals_complete_calendar_with_zero_days():
    s = cov.complete_days({D0: 5, D0 + timedelta(days=2): 7}, D0, D0 + timedelta(days=3))
    assert s == {D0: 5, D0 + timedelta(days=1): 0, D0 + timedelta(days=2): 7, D0 + timedelta(days=3): 0}
    assert sum(s.values()) == 12


def _daily(region_values: dict[str, list[int]]) -> dict[str, dict[date, int]]:
    """Five Mondays per region."""
    return {r: weeks(v) for r, v in region_values.items()}


def test_weekday_anomaly_detection_and_configurable_threshold():
    daily = _daily({"WORLD": [100, 100, 75, 100, 100]})
    cfg = cov.DetectionConfig(regions=())
    t = {r["day"]: r for r in cov.daily_table(daily, cfg)}
    mid = D0 + timedelta(days=14)
    assert t[mid]["ratio"] == 0.75 and t[mid]["low"] is True
    assert t[mid]["low_0.7"] is False and t[mid]["low_0.9"] is True
    t2 = {r["day"]: r for r in cov.daily_table(daily, cov.DetectionConfig(low_ratio=0.7, regions=()))}
    assert t2[mid]["low"] is False


def test_completely_missing_day_is_detected_as_collection_gap():
    regions = ("AF", "AS", "EU", "NA", "OC", "SA")
    vals = {r: [10, 10, 0, 10, 10] for r in regions}
    vals["WORLD"] = [60, 60, 0, 60, 60]
    cfg = cov.DetectionConfig()
    table = cov.daily_table(_daily(vals), cfg)
    mid = D0 + timedelta(days=14)
    # without hourly evidence the cause stays unknown, even for a zero day
    a = cov.classify_days(table, {}, cfg)
    assert [x["day"] for x in a] == [mid]
    assert a[0]["scope"] == "global" and a[0]["evidence"] == "unexplained_low" and not a[0]["cause_identifiable"]
    # with worldwide gap hours on that day it is attributed to collection
    b = cov.classify_days(table, {mid: {"gap_hours": 24, "gap_shortfall": 60.0, "day_shortfall": 60.0}}, cfg)
    assert b[0]["evidence"] == "collection_gap" and b[0]["cause_identifiable"] and b[0]["gap_hours"] == 24
    # one gap hour that explains only a small part of the drop does not make it a collection gap
    c = cov.classify_days(table, {mid: {"gap_hours": 1, "gap_shortfall": 5.0, "day_shortfall": 60.0}}, cfg)
    assert c[0]["evidence"] == "partial_gap_unexplained" and not c[0]["cause_identifiable"]
    assert c[0]["gap_share_of_shortfall"] == round(5 / 60, 3)


def test_regional_drop_scope_and_unknown_cause():
    regions = ("AF", "AS", "EU", "NA", "OC", "SA")
    vals = {r: [10, 10, 10, 10, 10] for r in regions}
    vals["EU"] = [10, 10, 2, 10, 10]
    vals["WORLD"] = [60, 60, 52, 60, 60]
    cfg = cov.DetectionConfig()
    a = cov.classify_days(cov.daily_table(_daily(vals), cfg), {}, cfg)
    assert len(a) == 1
    assert a[0]["scope"] == "regional" and a[0]["low_regions"] == ["EU"]
    assert a[0]["evidence"] == "unexplained_low" and a[0]["cause_category"].startswith("unknown")


def test_world_low_with_few_regions_is_partial():
    regions = ("AF", "AS", "EU", "NA", "OC", "SA")
    vals = {r: [10, 10, 10, 10, 10] for r in regions}
    vals["EU"] = [10, 10, 1, 10, 10]
    vals["NA"] = [40, 40, 4, 40, 40]
    vals["WORLD"] = [90, 90, 45, 90, 90]
    cfg = cov.DetectionConfig()
    a = cov.classify_days(cov.daily_table(_daily(vals), cfg), {}, cfg)
    assert a[0]["scope"] == "global_partial" and a[0]["low_regions"] == ["EU", "NA"]


def test_hourly_gap_runs():
    t0 = datetime(2026, 3, 2, 0)
    hourly = {}
    for w in range(5):
        for h in range(24):
            hourly[t0 + timedelta(days=7 * w, hours=h)] = 100
    gap_day = t0 + timedelta(days=14)
    for h in (3, 4, 5, 9):
        hourly[gap_day + timedelta(hours=h)] = 2
    hourly = cov.complete_hours(hourly, t0, t0 + timedelta(days=28, hours=23))
    base = cov.hourly_baseline(hourly, 28)
    runs = cov.gap_runs(hourly, base, gap_ratio=0.05)
    assert [(r["start"].hour, r["hours"], r["flights"]) for r in runs] == [(3, 3, 6), (9, 1, 2)]
    assert cov.gap_runs(hourly, base, gap_ratio=0.05, min_hours=2)[0]["hours"] == 3
    assert cov.gap_hours_by_day(runs) == {gap_day.date(): 4}
    burst = gap_day + timedelta(hours=10)
    assert cov.burst_hours({**hourly, burst: 250}, base, 1.6) == [
        {"hour": burst, "flights": 250, "baseline": 100.0, "ratio": 2.5}]
    d = cov.deficits_by_day(hourly, base, runs)[gap_day.date()]
    # baseline 100 per hour; gap hours 3, 4, 5, 9 at 2 flights -> shortfall 4 * 98, nothing else short
    assert d == {"day_shortfall": 392.0, "gap_shortfall": 392.0, "gap_hours": 4}


def test_monthly_normalisation_by_hand():
    d = [date(2026, 5, i) for i in (1, 2, 3, 4)]
    series = dict(zip(d, [100, 100, 0, 50]))
    quality = dict(zip(d, [1.0, 1.2, 0.0, 0.5]))
    r = cov.normalise_month(series, quality, days_in_month=4, threshold=0.8)
    assert r["A_total"] == 250
    assert r["B_per_calendar_day"] == 62.5
    assert r["B_obs_per_observed_day"] == pytest.approx(83.33)
    assert r["effective_days"] == 2.5            # 1 + 1 (capped) + 0 + 0.5
    assert r["C1_per_effective_day"] == 100.0
    assert r["C2_per_good_day"] == 100.0         # (100 + 100) / 2
    assert r["excluded_days"] == [d[2], d[3]]
    assert cov.pct_change(110, 100) == 10.0 and cov.pct_change(1, 0) is None
