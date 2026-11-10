"""
Observation-volume diagnostics as pure functions (tests/test_coverage_analysis.py).

Everything here describes how many flights the ADS-B data CONTAINS. None of it measures how many
flights actually operated: there is no denominator for that in the data. A low day can be a
collection gap, a holiday, weather, a real cut in operations or a change in the receiver
network. Only the patterns below are treated as evidence:

- a worldwide hour (or run of hours) with (almost) no airline flights: airline traffic does not
  stop worldwide, so such hours are attributed to data collection (category, not verified at
  the source);
- everything else that is unusually low or high is reported with its scope (worldwide or which
  regions) and the cause is left unknown.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

REGIONS = ("AF", "AS", "EU", "NA", "OC", "SA")


@dataclass(frozen=True)
class DetectionConfig:
    window_days: int = 28               # same-weekday neighbours within +-window (excluding the day)
    low_ratio: float = 0.8              # day flagged low when flights < low_ratio * baseline
    high_ratio: float = 1.25            # day flagged high when flights > high_ratio * baseline
    extra_low_ratios: tuple[float, ...] = (0.5, 0.7, 0.9)  # reported side by side (sensitivity)
    gap_ratio: float = 0.05             # an hour counts as a gap when flights <= gap_ratio * baseline
    gap_min_hours: int = 1              # minimum run length of gap hours to report
    gap_explains_share: float = 0.5     # gap hours must account for >= this share of the day's shortfall
    global_min_regions: int = 4         # regions that must also be low for "global" scope
    regions: tuple[str, ...] = field(default=REGIONS)


# ---- baselines ---------------------------------------------------------------------------------

def weekday_baseline(series: Mapping[date, int], window_days: int = 28) -> dict[date, float | None]:
    """Median of the same weekday within +-window_days, excluding the day itself.
    Matches the SQL in build_dataset.coverage() (RANGE window, EXCLUDE CURRENT ROW)."""
    days = sorted(series)
    out: dict[date, float | None] = {}
    for d in days:
        vals = [series[o] for o in days
                if o != d and o.weekday() == d.weekday() and abs((o - d).days) <= window_days]
        out[d] = float(statistics.median(vals)) if vals else None
    return out


def hourly_baseline(series: Mapping[datetime, int], window_days: int = 28) -> dict[datetime, float | None]:
    """Median of the same weekday and hour within +-window_days, excluding the hour itself."""
    by_slot: dict[tuple[int, int], list[datetime]] = defaultdict(list)
    for t in series:
        by_slot[(t.weekday(), t.hour)].append(t)
    out: dict[datetime, float | None] = {}
    for slot, ts in by_slot.items():
        ts.sort()
        for t in ts:
            vals = [series[o] for o in ts if o != t and abs((o - t).days) <= window_days]
            out[t] = float(statistics.median(vals)) if vals else None
    return out


def complete_days(series: Mapping[date, int], start: date, end: date) -> dict[date, int]:
    """Every calendar day in [start, end], with 0 where the series has no entry."""
    out = {}
    d = start
    while d <= end:
        out[d] = int(series.get(d, 0))
        d += timedelta(days=1)
    return out


def complete_hours(series: Mapping[datetime, int], start: datetime, end: datetime) -> dict[datetime, int]:
    out = {}
    t = start
    while t <= end:
        out[t] = int(series.get(t, 0))
        t += timedelta(hours=1)
    return out


def ratio(value: float, base: float | None) -> float | None:
    return value / base if base else None


# ---- detection ---------------------------------------------------------------------------------

def gap_runs(hourly: Mapping[datetime, int], baseline: Mapping[datetime, float | None],
             gap_ratio: float = 0.05, min_hours: int = 1) -> list[dict]:
    """Runs of consecutive hours with flights <= gap_ratio * baseline (baseline > 0)."""
    runs: list[dict] = []
    cur: list[datetime] = []

    def close():
        if len(cur) >= min_hours:
            runs.append({
                "start": cur[0], "end": cur[-1], "hours": len(cur),
                "flights": sum(hourly[t] for t in cur),
                "baseline_flights": round(sum(baseline[t] or 0 for t in cur), 1),
            })

    for t in sorted(hourly):
        b = baseline.get(t)
        if b and hourly[t] <= gap_ratio * b:
            if cur and t - cur[-1] != timedelta(hours=1):
                close()
                cur = []
            cur.append(t)
        else:
            if cur:
                close()
            cur = []
    if cur:
        close()
    return runs


def burst_hours(hourly: Mapping[datetime, int], baseline: Mapping[datetime, float | None],
                min_ratio: float = 1.6) -> list[dict]:
    """Hours with flights >= min_ratio * baseline. A burst right after a gap is consistent with
    records delivered late in a batch; it is reported, not corrected."""
    out = []
    for t in sorted(hourly):
        b = baseline.get(t)
        if b and hourly[t] >= min_ratio * b:
            out.append({"hour": t, "flights": hourly[t], "baseline": b, "ratio": round(hourly[t] / b, 3)})
    return out


def gap_hours_by_day(runs: Sequence[Mapping]) -> dict[date, int]:
    out: dict[date, int] = defaultdict(int)
    for r in runs:
        t = r["start"]
        while t <= r["end"]:
            out[t.date()] += 1
            t += timedelta(hours=1)
    return dict(out)


def deficits_by_day(hourly: Mapping[datetime, int], baseline: Mapping[datetime, float | None],
                    runs: Sequence[Mapping]) -> dict[date, dict]:
    """Per day: shortfall against the hourly baseline over all hours, and over gap hours only.
    Both use the same hourly series, so their ratio says how much of the day's drop the gap
    hours explain."""
    in_gap: set[datetime] = set()
    for r in runs:
        t = r["start"]
        while t <= r["end"]:
            in_gap.add(t)
            t += timedelta(hours=1)
    out: dict[date, dict] = defaultdict(lambda: {"day_shortfall": 0.0, "gap_shortfall": 0.0, "gap_hours": 0})
    for t, n in hourly.items():
        b = baseline.get(t) or 0.0
        o = out[t.date()]
        o["day_shortfall"] += b - n
        if t in in_gap:
            o["gap_shortfall"] += b - n
            o["gap_hours"] += 1
    return {d: {k: (round(v, 1) if isinstance(v, float) else v) for k, v in o.items()} for d, o in out.items()}


def daily_table(daily: Mapping[str, Mapping[date, int]], cfg: DetectionConfig) -> list[dict]:
    """One row per (day, region) with baseline, ratio and low/high flags at every threshold."""
    rows = []
    for region, series in daily.items():
        base = weekday_baseline(series, cfg.window_days)
        for d in sorted(series):
            r = ratio(series[d], base[d])
            row = {"day": d, "region": region, "flights": series[d], "baseline": base[d],
                   "ratio": round(r, 4) if r is not None else None,
                   "low": r is not None and r < cfg.low_ratio,
                   "high": r is not None and r > cfg.high_ratio}
            for t in cfg.extra_low_ratios:
                row[f"low_{t:g}"] = r is not None and r < t
            rows.append(row)
    return rows


def classify_days(table: Sequence[Mapping], gaps: Mapping[date, Mapping], cfg: DetectionConfig,
                  world: str = "WORLD") -> list[dict]:
    """Anomalous days with scope and evidence.

    scope: 'global' when WORLD is flagged and at least `global_min_regions` regions are flagged
    too; 'global_partial' when WORLD is flagged with fewer regions; 'regional' when only regions
    are flagged.
    evidence / cause_category:
      collection_gap       worldwide gap hours account for >= gap_explains_share of the day's
                           shortfall -> attributed to data collection (inferred, not confirmed by
                           the data provider)
      partial_gap_unexplained  gap hours exist but explain less than that share; the rest of the
                           drop has no identifiable cause
      unexplained_low      low, no gap hours: cause not identifiable from this data
    `gaps` maps a day to {"gap_hours", "gap_shortfall", "day_shortfall"} (see deficits_by_day).
      unexplained_high     high: cause not identifiable (can also be a backlog after a gap)
    """
    by_day: dict[date, dict[str, Mapping]] = defaultdict(dict)
    for row in table:
        by_day[row["day"]][row["region"]] = row
    out = []
    for d in sorted(by_day):
        rows = by_day[d]
        w = rows.get(world)
        low_regions = [r for r in cfg.regions if rows.get(r, {}).get("low")]
        high_regions = [r for r in cfg.regions if rows.get(r, {}).get("high")]
        w_low = bool(w and w["low"])
        w_high = bool(w and w["high"])
        g = gaps.get(d) or {}
        gap_h = g.get("gap_hours", 0)
        day_sf = g.get("day_shortfall", 0.0)
        explained = (g.get("gap_shortfall", 0.0) / day_sf) if gap_h and day_sf > 0 else (1.0 if gap_h else 0.0)
        if not (w_low or w_high or low_regions or high_regions or gap_h):
            continue
        direction = "low" if (w_low or low_regions or gap_h) else "high"
        if w_low or w_high:
            n = len(low_regions) if w_low else len(high_regions)
            scope = "global" if n >= cfg.global_min_regions else "global_partial"
        else:
            scope = "regional"
        if gap_h and explained >= cfg.gap_explains_share:
            evidence = "collection_gap"
            cause = "data collection (inferred from worldwide gap hours; not confirmed at the source)"
        elif gap_h:
            evidence = "partial_gap_unexplained"
            cause = "partly data collection (gap hours); the remaining drop has no identifiable cause"
        elif direction == "low":
            evidence = "unexplained_low"
            cause = "unknown (collection, holiday, weather, real operations and receiver changes are not separable here)"
        else:
            evidence = "unexplained_high"
            cause = "unknown"
        out.append({
            "day": d, "direction": direction, "scope": scope, "evidence": evidence,
            "cause_category": cause, "cause_identifiable": evidence == "collection_gap",
            "world_flights": w["flights"] if w else None,
            "world_baseline": w["baseline"] if w else None,
            "world_ratio": w["ratio"] if w else None,
            "gap_hours": gap_h,
            "gap_share_of_shortfall": round(explained, 3) if gap_h else None,
            "low_regions": low_regions, "high_regions": high_regions,
            "region_ratios": {r: rows[r]["ratio"] for r in cfg.regions if r in rows},
        })
    return out


# ---- monthly normalisation ---------------------------------------------------------------------

def month_of(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def normalise_month(series: Mapping[date, int], quality_ratio: Mapping[date, float | None],
                    days_in_month: int, threshold: float = 0.8) -> dict:
    """Per-day volume of one month under several definitions.

    A   total flights
    B   A / calendar days
    B_obs  A / days with >= 1 flight (the method the Explore UI uses)
    C1  A / effective days, effective days = sum over days of min(1, quality ratio)
    C2  mean flights over days whose quality ratio >= threshold
    The quality ratio comes from a reference series (e.g. WORLD) and is the day's flights divided
    by its same-weekday baseline. C1 and C2 are experimental: they assume the missing part of a
    day looked like its neighbours, which is exactly what cannot be observed.
    """
    total = sum(series.values())
    observed = sum(1 for v in series.values() if v > 0)
    eff = 0.0
    good_days, good_flights = 0, 0
    excluded = []
    for d, v in series.items():
        q = quality_ratio.get(d)
        q_eff = 1.0 if q is None else max(0.0, min(1.0, q))
        eff += q_eff
        if q is None or q >= threshold:
            good_days += 1
            good_flights += v
        else:
            excluded.append(d)
    return {
        "A_total": total,
        "B_per_calendar_day": round(total / days_in_month, 2) if days_in_month else None,
        "B_obs_per_observed_day": round(total / observed, 2) if observed else None,
        "C1_per_effective_day": round(total / eff, 2) if eff else None,
        "C2_per_good_day": round(good_flights / good_days, 2) if good_days else None,
        "calendar_days": days_in_month,
        "observed_days": observed,
        "effective_days": round(eff, 3),
        "good_days": good_days,
        "excluded_days": sorted(excluded),
    }


def pct_change(new: float | None, old: float | None) -> float | None:
    if new is None or not old:
        return None
    return round(100 * (new - old) / old, 2)
