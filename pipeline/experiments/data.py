"""Flights of a period, the networks built from them, and the missingness models (flight level).

Networks follow Research Mode (src/research/network.ts buildResearchNetwork + edgeArrays):
  - flights filtered by tier set, aircraft class and time basis
  - an airport pair (both directions summed) is kept when it has >= min_flights flights
  - directed: an arc a->b for every kept pair with flights a->b; undirected: one edge per pair
  - nodes: airports with at least one kept pair, in the order of the dataset's airports.json
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TIER_SETS = {"A": (1,), "B": (1, 2), "C": (1, 2, 3), "D": (1, 2, 3, 4)}
TIER_CODE = {"T1_track": 1, "T2_track_conflict": 2, "T3_track_callsign": 3, "T4_callsign_only": 4}
CLASSES = ("passenger", "cargo", "unknown")


@dataclass
class Flights:
    """One row per observed flight on the map, ordered by flight id (deterministic)."""
    org: np.ndarray      # airport index (airports.json order)
    dst: np.ndarray
    tier: np.ndarray     # 1..4
    cls: np.ndarray      # 0 passenger, 1 cargo, 2 unknown
    basis: np.ndarray    # 0 TRACK_START, 1 TRACK_END_FALLBACK

    def __len__(self) -> int:
        return len(self.org)


@dataclass
class Dataset:
    dataset_id: str
    version: str | None
    airport_ids: list[str]
    countries: list[str]
    continents: list[str]


def load_dataset(dataset_id: str, root: Path = ROOT) -> Dataset:
    base = root / "public" / "data" / dataset_id
    airports = json.loads((base / "airports.json").read_text(encoding="utf-8"))
    manifest = json.loads((base / "temporal" / "manifest.json").read_text(encoding="utf-8"))
    q = json.loads((base / "research-web" / "quality.json").read_text(encoding="utf-8"))
    cont = q.get("continents", {})
    return Dataset(dataset_id, manifest.get("datasetVersion"), [a["id"] for a in airports], [a["country"] for a in airports],
                   [cont.get(a["country"], "") for a in airports])


def _months(start: datetime, end: datetime) -> list[str]:
    """Calendar months touched by [start, end)."""
    last = end - timedelta(microseconds=1)
    out, y, m = [], start.year, start.month
    while (y, m) <= (last.year, last.month):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def load_flights(ds: Dataset, start: str, end: str, root: Path = ROOT) -> Flights:
    """Flights with start <= referenceTime < end (UTC), from the research Parquet (Phase 9A)."""
    s = datetime.fromisoformat(start.replace("Z", "+00:00")).replace(tzinfo=None)
    e = datetime.fromisoformat(end.replace("Z", "+00:00")).replace(tzinfo=None)
    files = [root / "data" / "research" / ds.dataset_id / "temporal" / f"flights_{m}.parquet" for m in _months(s, e)]
    files = [f for f in files if f.exists()]
    if not files:
        raise FileNotFoundError(f"no research flights for {start} .. {end}")
    con = duckdb.connect()
    # the airport index, loaded in bulk
    con.execute("CREATE OR REPLACE TABLE ap AS SELECT * FROM (SELECT unnest(?::VARCHAR[]) AS id, unnest(range(?)) AS i)", [ds.airport_ids, len(ds.airport_ids)])
    src = "[" + ", ".join(f"'{f.as_posix()}'" for f in files) + "]"
    case = "CASE " + " ".join(f"WHEN f.confidenceTier = '{k}' THEN {v}" for k, v in TIER_CODE.items()) + " END"
    res = con.execute(f"""
        SELECT a.i::INTEGER AS org, b.i::INTEGER AS dst, ({case})::TINYINT AS tier,
               (CASE f.aircraftClass WHEN 'passenger' THEN 0 WHEN 'cargo' THEN 1 ELSE 2 END)::TINYINT AS cls,
               (CASE f.timeBasis WHEN 'TRACK_START' THEN 0 ELSE 1 END)::TINYINT AS basis
        FROM read_parquet({src}) f
        JOIN ap a ON a.id = f.originAirport JOIN ap b ON b.id = f.destinationAirport
        WHERE f.onMap AND f.referenceTimeUtc >= ?::TIMESTAMP AND f.referenceTimeUtc < ?::TIMESTAMP
        ORDER BY f.flightId""", [s, e]).fetchnumpy()
    return Flights(res["org"].astype(np.int64), res["dst"].astype(np.int64), res["tier"].astype(np.int8), res["cls"].astype(np.int8), res["basis"].astype(np.int8))


@dataclass
class Network:
    nodes: np.ndarray        # global airport indices, ascending
    src: np.ndarray          # local indices
    dst: np.ndarray
    weight: np.ndarray       # flights per arc (undirected: both directions)
    flights: int
    pairs: int


def select(fl: Flights, keep: np.ndarray | None, tiers: str, classes, basis: str) -> np.ndarray:
    m = np.isin(fl.tier, TIER_SETS[tiers]) & np.isin(fl.cls, [CLASSES.index(c) for c in classes])
    if basis == "start":
        m &= fl.basis == 0
    if keep is not None:
        m &= keep
    return m


def build_network(fl: Flights, mask: np.ndarray, min_flights: int, directed: bool, n_airports: int) -> Network:
    o, d = fl.org[mask], fl.dst[mask]
    ok = o != d
    o, d = o[ok], d[ok]
    a, b = np.minimum(o, d), np.maximum(o, d)
    pair = a * n_airports + b
    upair, pinv, pcount = np.unique(pair, return_inverse=True, return_counts=True)
    keep_pair = pcount >= min_flights
    sel = keep_pair[pinv]
    o, d, a, b = o[sel], d[sel], a[sel], b[sel]
    nodes = np.unique(np.concatenate([a, b]))
    loc = np.full(n_airports, -1, dtype=np.int64)
    loc[nodes] = np.arange(len(nodes))
    if directed:
        key = o * n_airports + d
        uk, cnt = np.unique(key, return_counts=True)
        s, t = uk // n_airports, uk % n_airports
    else:
        key = a * n_airports + b
        uk, cnt = np.unique(key, return_counts=True)
        s, t = uk // n_airports, uk % n_airports
    return Network(nodes, loc[s], loc[t], cnt.astype(float), int(len(o)), int(keep_pair.sum()))


def on_nodes(net: Network, ref_nodes: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Arcs of `net` in the numbering of a fixed reference node set (missing nodes stay isolated)."""
    pos = {int(g): i for i, g in enumerate(ref_nodes)}
    gs, gt = net.nodes[net.src], net.nodes[net.dst]
    keep = np.array([int(x) in pos and int(y) in pos for x, y in zip(gs, gt)], dtype=bool)
    m = np.vectorize(pos.get, otypes=[np.int64])
    if not keep.any():
        return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0)
    return m(gs[keep]), m(gt[keep]), net.weight[keep]


# ---- missingness models (applied to observed flights; they remove, never add) --------------------

COMBINE = {
    # how the rates of the departure and arrival regions combine for one flight
    "origin": lambda po, pd: po,
    "destination": lambda po, pd: pd,
    "max": np.maximum,
    "either": lambda po, pd: 1 - (1 - po) * (1 - pd),   # missed if missed at either end (independent)
    "both": lambda po, pd: po * pd,                       # missed only if missed at both ends (independent)
}


def rng_for(seed: int, trial: int, stream: int = 0) -> np.random.Generator:
    """One generator per (seed, trial, stream): results do not depend on run order or parallelism."""
    return np.random.Generator(np.random.PCG64(np.random.SeedSequence([seed, trial, stream])))


def missingness_keep(fl: Flights, model: dict, seed: int, trial: int, ds: Dataset, ref_pair_flights: dict[int, int] | None, n_airports: int) -> np.ndarray:
    """Boolean mask of the flights kept in one trial (trial 0 = no added missingness)."""
    n = len(fl)
    if trial == 0 or model is None:
        return np.ones(n, dtype=bool)
    kind = model["model"]
    u = rng_for(seed, trial, 0).random(n)
    if kind == "uniform":
        p = np.full(n, float(model["rate"]))
    elif kind == "regional":
        rates = model.get("regionRates", {})
        other = float(model.get("otherRate", 0.0))
        cont = np.array([rates.get(c, other) for c in ds.continents], dtype=float)
        p = COMBINE[model.get("combine", "max")](cont[fl.org], cont[fl.dst])
    elif kind == "route":
        lf = model["lowFrequency"]
        a, b = np.minimum(fl.org, fl.dst), np.maximum(fl.org, fl.dst)
        pair = a * n_airports + b
        low = np.array([ref_pair_flights.get(int(x), 0) < lf["threshold"] for x in pair]) if ref_pair_flights is not None else np.zeros(n, bool)
        if lf.get("unit", "flight") == "route":
            # whole low-frequency routes disappear together (one draw per route, sorted route order)
            upair = np.unique(pair[low])
            draws = rng_for(seed, trial, 1).random(len(upair))
            gone = set(upair[draws < float(lf["rateLow"])].tolist())
            drop = np.array([int(x) in gone for x in pair]) & low
            other = u < float(lf.get("rateOther", 0.0))
            return ~(drop | (~low & other))
        p = np.where(low, float(lf["rateLow"]), float(lf.get("rateOther", 0.0)))
    else:
        raise ValueError(f"unknown missingness model {kind}")
    return u >= p


def pair_flights(fl: Flights, mask: np.ndarray, n_airports: int) -> dict[int, int]:
    """Flights per airport pair (both directions) among the selected flights."""
    o, d = fl.org[mask], fl.dst[mask]
    ok = o != d
    pair = np.minimum(o[ok], d[ok]) * n_airports + np.maximum(o[ok], d[ok])
    u, c = np.unique(pair, return_counts=True)
    return dict(zip(u.tolist(), c.tolist()))
