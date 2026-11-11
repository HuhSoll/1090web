"""
Shared pieces for external validation.

- ExternalCount: one row of an official statistic in a common format.
- AirportResolver: maps codes used by official sources (IATA, FAA LID, ICAO) to the dataset's
  canonical airport labels through OurAirports records. A code that matches several records is
  ambiguous and is EXCLUDED (with the reason recorded), never guessed.
- metrics: errors and agreement measures. None of them is called "accuracy": the official
  statistics and the ADS-B observations do not cover the same flights.
- registry: downloaded files are recorded with SHA-256, size, URL and retrieval time.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import sys
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis.network import spearman as _spearman  # noqa: E402
from analysis.network import pearson as _pearson  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EXTERNAL_RAW = ROOT / "data" / "raw" / "external"
REGISTRY = Path(__file__).resolve().parent / "external_inputs.lock.json"


# ---- common record -----------------------------------------------------------------------------

@dataclass(frozen=True)
class ExternalCount:
    source: str                    # e.g. "BTS_T100_SEGMENT"
    year: int
    month: int
    origin_airport: str            # code as published by the source
    destination_airport: str
    service_class: str             # source-specific class code (kept as published)
    reported_flights: float        # e.g. DEPARTURES_PERFORMED
    carrier: str = ""
    source_version: str = ""       # e.g. file name / publication date
    source_reference: str = ""     # URL or table id
    origin_country: str | frozenset = ""
    destination_country: str | frozenset = ""
    extra: tuple = ()              # source-specific (key, value) pairs

    @property
    def ym(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"


# ---- airport codes -----------------------------------------------------------------------------

@dataclass
class Resolution:
    canon: str | None
    method: str          # iata | faa_lid | icao | unresolved | ambiguous
    detail: str = ""


@dataclass
class AirportResolver:
    """Code -> canonical label, using OurAirports records (the same records as the dataset).

    by_iata / by_local / by_icao: code -> list of (rec_id, canon, country)
    """
    by_iata: dict[str, list[tuple[str, str, str]]] = field(default_factory=dict)
    by_local: dict[str, list[tuple[str, str, str]]] = field(default_factory=dict)
    by_icao: dict[str, list[tuple[str, str, str]]] = field(default_factory=dict)

    @classmethod
    def from_rows(cls, rows: Iterable[Mapping]) -> "AirportResolver":
        """rows: dicts with rec_id, canon, iata, local_code, icao, ident, gps_code, country."""
        r = cls(defaultdict(list), defaultdict(list), defaultdict(list))
        for a in rows:
            item = (a["rec_id"], a["canon"], a.get("country") or "")
            if a.get("iata"):
                r.by_iata[a["iata"]].append(item)
            if a.get("local_code"):
                r.by_local[a["local_code"]].append(item)
            for k in {a.get("icao"), a.get("ident"), a.get("gps_code"), a.get("canon")}:
                if k and len(k) == 4:
                    r.by_icao[k].append(item)
        r.by_iata, r.by_local, r.by_icao = dict(r.by_iata), dict(r.by_local), dict(r.by_icao)
        return r

    @classmethod
    def from_ourairports(cls, airports_csv: Path, overrides_csv: Path | None = None) -> "AirportResolver":
        import duckdb

        from airports import OVERRIDES, load_airports

        con = duckdb.connect()
        load_airports(con, airports_csv, overrides_csv if overrides_csv is not None else OVERRIDES)
        rows = con.execute("""
            SELECT r.rec_id, r.canon, r.iata, a.local_code, r.icao, r.ident, a.gps_code, r.country
            FROM ap_rec r JOIN ap_raw a ON a.id = r.rec_id""").fetchall()
        cols = ["rec_id", "canon", "iata", "local_code", "icao", "ident", "gps_code", "country"]
        return cls.from_rows(dict(zip(cols, x)) for x in rows)

    def resolve(self, code: str, country: str | frozenset = "") -> Resolution:
        """country: ISO code or a set of codes (e.g. the U.S. with its territories)."""
        code = (code or "").strip().upper()
        countries = ({country} if isinstance(country, str) else set(country)) - {""}
        if not code:
            return Resolution(None, "unresolved", "empty code")
        tables = [("iata", self.by_iata)] if len(code) == 3 else []
        if len(code) in (3, 4) and countries:
            tables.append(("faa_lid", self.by_local))
        if len(code) == 4:
            tables.append(("icao", self.by_icao))
        for method, table in tables:
            cands = table.get(code, [])
            if countries and method != "icao":
                # a known country must match: an IATA code of an airport elsewhere is never used
                cands = [c for c in cands if c[2] in countries]
            recs = {c[0] for c in cands}
            if len(recs) == 1:
                return Resolution(cands[0][1], method)
            if len(recs) > 1:
                return Resolution(None, "ambiguous", f"{method} code matches {len(recs)} OurAirports records")
        return Resolution(None, "unresolved", "no OurAirports record with this code")


# ISO codes that official U.S. statistics report as "US"
US_AND_TERRITORIES = frozenset({"US", "PR", "VI", "GU", "AS", "MP", "UM"})


# ---- metrics -----------------------------------------------------------------------------------

METRIC_DEFINITIONS = {
    "abs_error": "a - b (observed minus reported), per item",
    "rel_error": "(a - b) / b, only when b >= min_base (default 10) to avoid unstable ratios on small counts",
    "MAE": "mean of |a - b| over items",
    "RMSE": "sqrt(mean of (a - b)^2) over items",
    "WAPE": "sum |a - b| / sum b; undefined when sum b = 0",
    "bias": "sum a / sum b - 1",
    "pearson": "Pearson correlation of a and b over items (needs >= 3 items and variance)",
    "spearman": "Spearman rank correlation (average ranks for ties)",
    "jaccard": "|A and B| / |A or B| for route sets",
    "note": "a = ADS-B observations (this dataset), b = official statistic. Coverage differs, so these are "
            "conditional external comparisons, not accuracy.",
}


def rel_error(a: float, b: float, min_base: float = 10) -> float | None:
    return (a - b) / b if b >= min_base and b > 0 else None


def error_metrics(pairs: list[tuple[float, float]], min_base: float = 10) -> dict:
    """a/b pairs -> MAE, RMSE, WAPE, bias, correlations, relative-error quantiles."""
    n = len(pairs)
    if n == 0:
        return {"n": 0}
    sa = sum(a for a, _ in pairs)
    sb = sum(b for _, b in pairs)
    abs_err = [abs(a - b) for a, b in pairs]
    rels = sorted(r for a, b in pairs if (r := rel_error(a, b, min_base)) is not None)
    xs, ys = [a for a, _ in pairs], [b for _, b in pairs]
    pr = _pearson(xs, ys) if n >= 3 else None
    sr = _spearman(xs, ys) if n >= 3 else None
    return {
        "n": n,
        "sum_observed": round(sa, 3),
        "sum_reported": round(sb, 3),
        "MAE": round(sum(abs_err) / n, 4),
        "RMSE": round(math.sqrt(sum(e * e for e in abs_err) / n), 4),
        "WAPE": round(sum(abs_err) / sb, 4) if sb else None,
        "bias": round(sa / sb - 1, 4) if sb else None,
        "pearson": round(pr, 4) if pr is not None else None,
        "spearman": round(sr, 4) if sr is not None else None,
        "rel_error_n": len(rels),
        "rel_error_min_base": min_base,
        "rel_error_p10": _q(rels, 0.10),
        "rel_error_median": _q(rels, 0.50),
        "rel_error_p90": _q(rels, 0.90),
        "share_within_10pct": round(sum(1 for r in rels if abs(r) <= 0.10) / len(rels), 4) if rels else None,
        "share_within_25pct": round(sum(1 for r in rels if abs(r) <= 0.25) / len(rels), 4) if rels else None,
    }


def _q(sorted_vals: list[float], q: float) -> float | None:
    if not sorted_vals:
        return None
    i = (len(sorted_vals) - 1) * q
    lo, hi = math.floor(i), math.ceil(i)
    v = sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)
    return round(v, 4)


def set_overlap(a: Iterable, b: Iterable) -> dict:
    a, b = set(a), set(b)
    u = a | b
    return {"both": len(a & b), "only_observed": len(a - b), "only_reported": len(b - a),
            "jaccard": round(len(a & b) / len(u), 4) if u else None,
            "share_reported_found": round(len(a & b) / len(b), 4) if b else None,
            "share_observed_confirmed": round(len(a & b) / len(a), 4) if a else None}


# ---- registry of downloaded inputs ---------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rel(p: Path) -> str:
    try:
        return Path(p).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return Path(p).name


class HashMismatch(RuntimeError):
    pass


def load_registry(path: Path = REGISTRY) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"files": {}}


def register(path: Path, *, source: str, url: str, retrieved: str, note: str = "",
             registry_path: Path = REGISTRY) -> dict:
    """Record a downloaded or manually imported file (hash, size, URL, time)."""
    reg = load_registry(registry_path)
    entry = {"source": source, "path": _rel(path), "bytes": Path(path).stat().st_size,
             "sha256": sha256_file(path), "url": url, "retrieved": retrieved, "note": note}
    reg["files"][Path(path).name] = entry
    registry_path.write_text(json.dumps(reg, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    return entry


def verify(path: Path, registry_path: Path = REGISTRY) -> dict:
    """The file must be registered and its SHA-256 must match the registry."""
    reg = load_registry(registry_path)
    entry = reg["files"].get(Path(path).name)
    if entry is None:
        raise HashMismatch(f"{Path(path).name} is not registered in {registry_path.name}")
    got = sha256_file(path)
    if got != entry["sha256"]:
        raise HashMismatch(f"{Path(path).name}: sha256 {got[:12]}… does not match registry {entry['sha256'][:12]}…")
    return entry


# ---- output helpers ---------------------------------------------------------------------------

def write_csv(path: Path, rows: list[Mapping], columns: list[str] | None = None) -> None:
    columns = columns or (list(rows[0].keys()) if rows else [])
    with Path(path).open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(columns)
        for r in rows:
            out = []
            for c in columns:
                v = r.get(c)
                if isinstance(v, bool):
                    v = "true" if v else "false"
                elif isinstance(v, (list, tuple)):
                    v = ";".join(map(str, v))
                elif v is None:
                    v = ""
                out.append(v)
            w.writerow(out)


def write_json(path: Path, data) -> None:
    def default(o):
        if hasattr(o, "__dataclass_fields__"):
            return asdict(o)
        if isinstance(o, (set, tuple)):
            return list(o)
        if isinstance(o, Path):
            return o.as_posix()
        raise TypeError(type(o))
    Path(path).write_text(json.dumps(data, indent=1, ensure_ascii=False, default=default) + "\n", encoding="utf-8")
