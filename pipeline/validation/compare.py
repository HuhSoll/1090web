"""
Comparisons between ADS-B observations (this dataset) and an official statistic, on the common
format. Pure functions on plain dicts so that every rule can be tested on synthetic inputs.

Keys: a directed route-month is (ym, origin_canon, destination_canon). Observed counts come from
research/routes_monthly.parquet (airline, class, tier per row); reported counts from
common.ExternalCount after airport resolution.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping

from validation import common

RouteKey = tuple[str, str, str]  # (ym, origin, destination)

TIER_SETS = {
    "T1": ("T1_track",),
    "T1-T2": ("T1_track", "T2_track_conflict"),
    "T1-T3": ("T1_track", "T2_track_conflict", "T3_track_callsign"),
    "T1-T4": ("T1_track", "T2_track_conflict", "T3_track_callsign", "T4_callsign_only"),
}
THRESHOLDS = (1, 4, 10, 30)


# ---- external side ----------------------------------------------------------------------------

def resolve_external(records: Iterable[common.ExternalCount], resolver: common.AirportResolver,
                     classes: Iterable[str] | None = None,
                     months: Iterable[str] | None = None) -> tuple[dict, dict, dict]:
    """Resolve airport codes and sum reported flights per directed route-month.

    Returns (counts, by_carrier, exclusions):
      counts      {(ym, o, d): flights}
      by_carrier  {carrier: {(ym, o, d): flights}}
      exclusions  {reason: {"rows": n, "flights": f}} - rows that could not be used, by reason
    Rows with an ambiguous or unknown airport are excluded (never guessed). Rows outside the
    requested classes or months are not counted as exclusions (they are out of scope).
    """
    classes = set(classes) if classes else None
    months = set(months) if months else None
    counts: dict[RouteKey, float] = defaultdict(float)
    by_carrier: dict[str, dict[RouteKey, float]] = defaultdict(lambda: defaultdict(float))
    excl: dict[str, dict] = defaultdict(lambda: {"rows": 0, "flights": 0.0})
    cache: dict[tuple[str, str], common.Resolution] = {}

    def res(code: str, country: str) -> common.Resolution:
        k = (code, country)
        if k not in cache:
            cache[k] = resolver.resolve(code, country)
        return cache[k]

    for r in records:
        if classes is not None and r.service_class not in classes:
            continue
        if months is not None and r.ym not in months:
            continue
        o = res(r.origin_airport, r.origin_country)
        d = res(r.destination_airport, r.destination_country)
        if o.canon is None or d.canon is None:
            bad = o if o.canon is None else d
            e = excl[f"airport_{bad.method}"]
            e["rows"] += 1
            e["flights"] += r.reported_flights
            continue
        if o.canon == d.canon:
            e = excl["same_airport_after_resolution"]
            e["rows"] += 1
            e["flights"] += r.reported_flights
            continue
        k = (r.ym, o.canon, d.canon)
        counts[k] += r.reported_flights
        by_carrier[r.carrier][k] += r.reported_flights
    return dict(counts), {c: dict(v) for c, v in by_carrier.items()}, {k: dict(v) for k, v in excl.items()}


def unresolved_codes(records: Iterable[common.ExternalCount], resolver: common.AirportResolver) -> Counter:
    c: Counter = Counter()
    for r in records:
        for code, country in ((r.origin_airport, r.origin_country), (r.destination_airport, r.destination_country)):
            x = resolver.resolve(code, country)
            if x.canon is None:
                c[(code, country, x.method)] += r.reported_flights
    return c


# ---- observed side ----------------------------------------------------------------------------

def observed_counts(rows: Iterable[tuple], *, tiers: Iterable[str] | None = None,
                    airlines: Iterable[str] | None = None, classes: Iterable[str] | None = None,
                    scope: Callable[[str, str], bool] | None = None,
                    months: Iterable[str] | None = None) -> dict[RouteKey, int]:
    """rows: (ym, origin, destination, airline, class, tier, flights) -> {(ym, o, d): flights}."""
    tiers = set(tiers) if tiers else None
    airlines = set(airlines) if airlines is not None else None
    classes = set(classes) if classes else None
    months = set(months) if months else None
    out: dict[RouteKey, int] = defaultdict(int)
    for ym, o, d, al, cls, tier, n in rows:
        if not o or not d or o == d:
            continue
        if tiers is not None and tier not in tiers:
            continue
        if airlines is not None and al not in airlines:
            continue
        if classes is not None and cls not in classes:
            continue
        if months is not None and ym not in months:
            continue
        if scope is not None and not scope(o, d):
            continue
        out[(ym, o, d)] += n
    return dict(out)


def restrict(counts: Mapping[RouteKey, float], scope: Callable[[str, str], bool]) -> dict[RouteKey, float]:
    return {k: v for k, v in counts.items() if scope(k[1], k[2])}


def undirected(counts: Mapping[RouteKey, float]) -> dict[RouteKey, float]:
    out: dict[RouteKey, float] = defaultdict(float)
    for (ym, o, d), n in counts.items():
        a, b = (o, d) if o < d else (d, o)
        out[(ym, a, b)] += n
    return dict(out)


# ---- route comparison ------------------------------------------------------------------------

def compare_routes(observed: Mapping[RouteKey, float], reported: Mapping[RouteKey, float],
                   min_flights: int = 1, min_base: float = 10) -> dict:
    """Route-level agreement at a monthly threshold.

    route sets: a route-month belongs to a side when that side has >= min_flights.
    only_reported / only_observed: present (>= min_flights) on one side and ABSENT (0) on the
    other, so a threshold never turns a small count into a 'missing' route.
    volume metrics: over route-months with reported >= min_flights (observed may be 0).
    """
    a_set = {k for k, v in observed.items() if v >= min_flights}
    b_set = {k for k, v in reported.items() if v >= min_flights}
    ov = common.set_overlap(a_set, b_set)
    only_rep = {k for k in b_set if observed.get(k, 0) == 0}
    only_obs = {k for k in a_set if reported.get(k, 0) == 0}
    pairs = [(float(observed.get(k, 0)), float(reported[k])) for k in sorted(b_set)]
    return {
        "min_flights": min_flights,
        **ov,
        "reported_routes_absent_in_observed": len(only_rep),
        "reported_flights_on_those": round(sum(reported[k] for k in only_rep), 1),
        "observed_routes_absent_in_reported": len(only_obs),
        "observed_flights_on_those": int(sum(observed[k] for k in only_obs)),
        "volume": common.error_metrics(pairs, min_base),
    }


def route_rows(observed: Mapping[RouteKey, float], reported: Mapping[RouteKey, float]) -> list[dict]:
    """One row per route-month present on either side."""
    rows = []
    for k in sorted(set(observed) | set(reported)):
        a, b = float(observed.get(k, 0)), float(reported.get(k, 0))
        rows.append({"month": k[0], "origin": k[1], "destination": k[2], "observed": a, "reported": b,
                     "abs_error": a - b, "rel_error": common.rel_error(a, b, 10)})
    return rows


def airport_movements(counts: Mapping[RouteKey, float]) -> dict[tuple[str, str], float]:
    """(ym, airport) -> departures + arrivals."""
    out: dict[tuple[str, str], float] = defaultdict(float)
    for (ym, o, d), n in counts.items():
        out[(ym, o)] += n
        out[(ym, d)] += n
    return dict(out)


def route_support_rate(observed: Mapping[RouteKey, float], reported: Mapping[RouteKey, float]) -> dict:
    """Share of observed flights on route-months that the official statistic also lists (>= 1).
    Not a correctness rate: a route can exist in the statistic while a given flight was assigned
    wrongly, and a route absent from the statistic can still be real (non-reporting operators)."""
    tot = sum(observed.values())
    sup = sum(v for k, v in observed.items() if reported.get(k, 0) >= 1)
    return {"observed_flights": int(tot), "on_reported_routes": int(sup),
            "support_rate": round(sup / tot, 4) if tot else None}


# ---- carrier crosswalk (evidence-based, reviewable) ------------------------------------------------

def cosine(u: Mapping, v: Mapping) -> float:
    if len(u) > len(v):
        u, v = v, u
    dot = sum(x * v.get(k, 0.0) for k, x in u.items())
    nu = math.sqrt(sum(x * x for x in u.values()))
    nv = math.sqrt(sum(x * x for x in v.values()))
    return dot / (nu * nv) if nu and nv else 0.0


def carrier_crosswalk(observed_by_airline: Mapping[str, Mapping[RouteKey, float]],
                      reported_by_carrier: Mapping[str, Mapping[RouteKey, float]],
                      min_flights: int = 200, min_cosine: float = 0.7, min_margin: float = 0.15,
                      volume_range: tuple[float, float] = (0.5, 2.0)) -> list[dict]:
    """Match an ADS-B airline code (ICAO-style) to a reporting carrier by the similarity of their
    route-month flight vectors. Accepted only when the best match is clearly better than the
    second (margin) and volumes are of the same order. This identifies carriers; it says nothing
    about the operation type of individual flights. Every candidate row is returned with its
    evidence so the table can be reviewed."""
    index: dict[RouteKey, list[str]] = defaultdict(list)
    for c, vec in reported_by_carrier.items():
        for k in vec:
            index[k].append(c)
    out = []
    for al, vec in sorted(observed_by_airline.items()):
        total = sum(vec.values())
        if total < min_flights:
            continue
        cands = {c for k in vec for c in index.get(k, ())}
        scored = sorted(((cosine(vec, reported_by_carrier[c]), c) for c in cands), reverse=True)
        best = scored[0] if scored else (0.0, "")
        second = scored[1] if len(scored) > 1 else (0.0, "")
        rep_total = sum(reported_by_carrier[best[1]].values()) if best[1] else 0
        ratio = total / rep_total if rep_total else None
        ok = (best[0] >= min_cosine and best[0] - second[0] >= min_margin and ratio is not None
              and volume_range[0] <= ratio <= volume_range[1])
        out.append({"airline": al, "observed_flights": int(total), "carrier": best[1] if ok else "",
                    "best_candidate": best[1], "cosine": round(best[0], 4),
                    "second_candidate": second[1], "second_cosine": round(second[0], 4),
                    "volume_ratio": round(ratio, 3) if ratio else None,
                    "status": "matched" if ok else "unmatched"})
    return out
