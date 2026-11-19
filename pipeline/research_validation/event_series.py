"""Independent check of the event-study numbers (Phase 9I).

The browser computes the event study from the public day files with the TypeScript aggregator
(src/temporal/aggregate.ts) and the statistics in src/events/analysis.ts. This script recomputes
the same quantities another way:

- counting: SQL over the per-flight research parquet (data/research/<dataset>/temporal), not the
  day files, with the airport country taken from airports.json;
- statistics: numpy / scipy (linregress for OLS), and the Newey-West standard error written out
  from its textbook definition.

It shares the airport assignment (R1-R5, T1-T4) with the pipeline, so it checks the counting,
windows and statistics, not the assignment itself.

Usage: python pipeline/research_validation/event_series.py [--out data/quality/validation-9i-events.json]
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
from scipy import stats

ROOT = Path(__file__).resolve().parents[2]
DATASET = "observed-2026-v2"
PARQUET = ROOT / "data" / "research" / DATASET / "temporal"
AIRPORTS = ROOT / "public" / "data" / DATASET / "airports.json"

NEIGHBOURS = ["TR", "EG", "CY", "SY", "YE", "PK", "AF", "AZ", "AM", "GE", "TM", "SD"]
COMPARISON = ["TH", "MY", "SG", "ID", "VN", "PH"]
CZIB_AREA = ["BH", "IR", "IQ", "IL", "JO", "KW", "LB", "OM", "QA", "SA", "AE"]

CASES = {
    "CZIB:2026-03/R0": CZIB_AREA,
    "RST-AE-2026-02-28-PARTIAL": ["AE"],
    "CLS-QA-2026-02-28": ["QA"],
    "CLS-KW-2026-02-28": ["KW"],
}
EVENT_DAY = date(2026, 2, 28)
WINDOW = 14
SPAN = 60


def daily_counts(con, area: list[str], first: date, last: date) -> dict[str, list[int]]:
    """Flights per UTC day of reference time: area (either end), comparison (no area/neighbour end)."""
    months = sorted({f"{d:%Y-%m}" for d in (first + timedelta(days=i) for i in range((last - first).days + 1))})
    files = [str(PARQUET / f"flights_{m}.parquet").replace("\\", "/") for m in months]
    con.execute("create or replace temp table ap as select * from read_json_auto(?)", [str(AIRPORTS).replace("\\", "/")])
    q = f"""
    with f as (
      select cast(referenceTimeUtc as date) as d, o.country as co, x.country as cd
      from read_parquet({files!r}) p
      join ap o on o.id = p.originAirport
      join ap x on x.id = p.destinationAirport
      where p.onMap and p.confidenceTier like 'T%'
        and referenceTimeUtc >= ? and referenceTimeUtc < ?
    )
    select d,
      count(*) filter (where co in ({','.join('?' * len(area))}) or cd in ({','.join('?' * len(area))})) as area,
      count(*) filter (where (co in ({','.join('?' * len(COMPARISON))}) or cd in ({','.join('?' * len(COMPARISON))}))
                        and co not in ({','.join('?' * (len(area) + len(NEIGHBOURS)))})
                        and cd not in ({','.join('?' * (len(area) + len(NEIGHBOURS)))})) as comparison,
      count(*) as world
    from f group by d order by d
    """
    excl = area + NEIGHBOURS
    rows = con.execute(q, [first, last + timedelta(days=1), *area, *area, *COMPARISON, *COMPARISON, *excl, *excl]).fetchall()
    by = {r[0]: r for r in rows}
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    return {k: [int(by[d][j]) if d in by else 0 for d in days] for j, k in ((1, "area"), (2, "comparison"), (3, "world"))} | {"days": [d.isoformat() for d in days]}


def ols_t(y: np.ndarray) -> tuple[float, float]:
    r = stats.linregress(np.arange(len(y)), y)
    return float(r.slope), float(r.slope / r.stderr)


def newey_west_t(y: np.ndarray, lag: int) -> float:
    """t of the OLS slope with the Newey-West (Bartlett) standard error."""
    n = len(y)
    X = np.column_stack([np.ones(n), np.arange(n)])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    u = y - X @ beta
    S = (X * u[:, None]).T @ (X * u[:, None])
    for l in range(1, lag + 1):
        w = 1 - l / (lag + 1)
        G = (X[l:] * u[l:, None]).T @ (X[:-l] * u[:-l, None])
        S += w * (G + G.T)
    XtX_inv = np.linalg.inv(X.T @ X)
    V = XtX_inv @ S @ XtX_inv * n / (n - 2)  # small-sample scaling as in the browser
    return float(beta[1] / math.sqrt(V[1, 1]))


def nw_lag(n: int) -> int:
    return int(math.floor(4 * (n / 100) ** (2 / 9)))


def study(series: dict, start: date) -> dict:
    idx = {d: i for i, d in enumerate(series["days"])}
    e = idx[EVENT_DAY.isoformat()]
    area = np.array(series["area"], float)
    comp = np.array(series["comparison"], float)
    b = slice(e - WINDOW, e)
    a = slice(e + 1, e + 1 + WINDOW)
    bm, am = area[b].mean(), area[a].mean()
    cbm, cam = comp[b].mean(), comp[a].mean()
    log_change = math.log((am + 1) / (bm + 1))
    did = log_change - math.log((cam + 1) / (cbm + 1))
    y = np.log(area[b] + 1)
    yr = np.log((area[b] + 1) / (comp[b] + 1))
    slope, t_ols = ols_t(y)
    _, tr_ols = ols_t(yr)
    lag = nw_lag(WINDOW)
    # placebos: every 7 days back, the whole placebo pair inside the series, no day after the event
    placebos, did_placebos, tried = [], [], 0
    for k in range(1, 30):
        d = e - 7 * k
        if d - WINDOW < 0:
            break
        tried += 1
        if d + 1 + WINDOW > e:
            continue
        pb, pa = slice(d - WINDOW, d), slice(d + 1, d + 1 + WINDOW)
        pl = math.log((area[pa].mean() + 1) / (area[pb].mean() + 1))
        placebos.append(pl)
        did_placebos.append(pl - math.log((comp[pa].mean() + 1) / (comp[pb].mean() + 1)))
    return {
        "eventDayValue": int(area[e]), "lastBeforeDay": int(area[e - 1]), "firstAfterDay": int(area[e + 1]),
        "beforeMean": bm, "afterMean": am, "change": am / bm - 1 if bm else None, "logChange": log_change,
        "comparison": {"beforeMean": cbm, "afterMean": cam, "change": cam / cbm - 1},
        "preTrend": {"impliedChange": math.exp(slope * (WINDOW - 1)) - 1, "tOls": t_ols, "tNeweyWest": newey_west_t(y, lag), "lag": lag},
        "ratioPreTrend": {"tOls": tr_ols, "tNeweyWest": newey_west_t(yr, lag)},
        "placebo": {"tried": tried, "valid": len(placebos), "asLarge": sum(abs(p) >= abs(log_change) for p in placebos),
                    "values": [math.exp(p) - 1 for p in placebos]},
        "didLogDifference": did, "didRelative": math.exp(did) - 1,
        "didPlacebos": {"valid": len(did_placebos), "asLarge": sum(abs(p) >= abs(did) for p in did_placebos)},
        "levelRatioBefore": bm / cbm if cbm else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "quality" / "validation-9i-events.json"))
    args = ap.parse_args()
    con = duckdb.connect()
    # the series is clipped to the observed data (from 2026-01-01), as in the browser
    first, last = max(EVENT_DAY - timedelta(days=SPAN), date(2026, 1, 1)), EVENT_DAY + timedelta(days=SPAN)
    out = {"dataset": DATASET, "eventDay": EVENT_DAY.isoformat(), "windowDays": WINDOW, "spanDays": SPAN, "tiers": "T1-T4", "cases": {}}
    for k, area in CASES.items():
        s = daily_counts(con, area, first, last)
        out["cases"][k] = {"area": area, **study(s, first), "series": {"days": s["days"], "area": s["area"], "comparison": s["comparison"]}}
        c = out["cases"][k]
        print(f"{k:28s} {c['beforeMean']:8.1f} -> {c['afterMean']:7.1f} ({c['change']:+.1%}) pre t_ols {c['preTrend']['tOls']:+.2f} t_nw {c['preTrend']['tNeweyWest']:+.2f}"
              f" ratio t_ols {c['ratioPreTrend']['tOls']:+.2f} t_nw {c['ratioPreTrend']['tNeweyWest']:+.2f} placebo {c['placebo']['asLarge']}/{c['placebo']['valid']} (tried {c['placebo']['tried']})"
              f" did {c['didRelative']:+.1%} event day {c['eventDayValue']} last before {c['lastBeforeDay']} first after {c['firstAfterDay']}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
