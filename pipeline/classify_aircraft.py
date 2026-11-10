"""
Builds pipeline/reference/aircraft_variant_class.csv: one row per (AC_Type, AC_Type_Detailed)
seen in the raw data, classified as passenger / cargo / unknown with the rule that decided it.

IMPORTANT: this classifies the AIRCRAFT VARIANT, not the purpose of an individual flight.
A passenger aircraft can fly empty, carry only cargo, or be a VIP/charter flight; a freighter is
almost always a cargo flight, but not provably every time. Treat the result as aircraft-based
evidence, never as a confirmed flight purpose.

Rules are deliberately conservative:
* cargo      only when the variant designation itself says freighter (777F, -400F, BCF, BDSF,
             SF, PCF, P2F, A300F4-, ...)
* passenger  when the variant is a known airliner without a freighter designation, or when the
             type only exists as a passenger aircraft (passenger_only_types.csv)
* unknown    no variant detail and a type that has freighter versions; business/VIP variants;
             or the ICAO type code and the variant detail contradict each other

Phase 6A fix (audit H2): the type/variant consistency check used to compare string prefixes, so
correct pairs such as A20N / "A320 251NSL" or B38M / "737-8" were rejected as contradictions.
It now compares manufacturer family, model/series and generation (ceo/neo, NG/MAX) explicitly.

Usage: python pipeline/classify_aircraft.py data/raw/flights/2026_Q*_detailed_github.parquet
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

REF = Path(__file__).parent / "reference"
OUT = REF / "aircraft_variant_class.csv"


def load_passenger_only(path: Path = REF / "passenger_only_types.csv") -> set[str]:
    with path.open(encoding="utf-8") as f:
        return {row["ac_type"] for row in csv.DictReader(f)}


PASSENGER_ONLY = load_passenger_only()

NON_AIRLINE_MARKERS = re.compile(r"\b(BBJ|VIP|ACJ)\b")

# ---- type codes (ICAO) ---------------------------------------------------------------------

# Airbus: ICAO type -> (model, generation)
AIRBUS_TYPES = {
    "A318": ("A318", "ceo"), "A319": ("A319", "ceo"), "A320": ("A320", "ceo"), "A321": ("A321", "ceo"),
    "A19N": ("A319", "neo"), "A20N": ("A320", "neo"), "A21N": ("A321", "neo"),
    "A306": ("A300", None), "A30B": ("A300", None), "A310": ("A310", None),
    "A332": ("A330", None), "A333": ("A330", None), "A337": ("A330", None), "A338": ("A330", None), "A339": ("A330", None),
    "A342": ("A340", None), "A343": ("A340", None), "A345": ("A340", None), "A346": ("A340", None),
    "A359": ("A350", None), "A35K": ("A350", None), "A388": ("A380", None),
}

# Boeing: ICAO type -> (family, series, generation). Series "F" is the 777F (ICAO B77L).
BOEING_TYPES = {
    "B712": ("717", "2", None),
    "B721": ("727", "1", None), "B722": ("727", "2", None),
    "B731": ("737", "1", "classic"), "B732": ("737", "2", "classic"), "B733": ("737", "3", "classic"),
    "B734": ("737", "4", "classic"), "B735": ("737", "5", "classic"),
    "B736": ("737", "6", "NG"), "B737": ("737", "7", "NG"), "B738": ("737", "8", "NG"), "B739": ("737", "9", "NG"),
    "B37M": ("737", "7", "MAX"), "B38M": ("737", "8", "MAX"), "B39M": ("737", "9", "MAX"), "B3XM": ("737", "10", "MAX"),
    "B741": ("747", "1", None), "B742": ("747", "2", None), "B743": ("747", "3", None), "B744": ("747", "4", None),
    "B748": ("747", "8", None),
    "B752": ("757", "2", None), "B753": ("757", "3", None),
    "B762": ("767", "2", None), "B763": ("767", "3", None), "B764": ("767", "4", None),
    "B772": ("777", "2", None), "B77L": ("777", "2|F", None), "B773": ("777", "3", None), "B77W": ("777", "3", None),
    "B778": ("777", "8", None), "B779": ("777", "9", None),
    "B788": ("787", "8", None), "B789": ("787", "9", None), "B78X": ("787", "10", None),
}

# Other manufacturers: ICAO type prefix -> family label used to detect contradictions only.
OTHER_TYPE_FAMILIES = [
    (re.compile(r"^AT[0-9][0-9A-Z]$"), "ATR"),
    (re.compile(r"^(F28|F50|F70|F100)$"), "FOKKER"),
    (re.compile(r"^CRJ[0-9X]$"), "CRJ"),
    (re.compile(r"^DH8[A-D]$"), "DHC8"),
    (re.compile(r"^(E1[3-9]\d|E1[3-9][0-9A-Z]|E17\d|E19\d|E75[LS]|E29\d|E2\d\d)$"), "EMBRAER_JET"),
    (re.compile(r"^(MD8\d|MD9\d|DC9\d?|DC93|DC91)$"), "DC9"),
    (re.compile(r"^MD11$"), "MD11"),
    (re.compile(r"^DC10$"), "DC10"),
    (re.compile(r"^SF34$"), "SAAB340"),
    (re.compile(r"^E120$"), "EMB120"),
    (re.compile(r"^IL76$"), "IL76"),
]

# ---- variant details ---------------------------------------------------------------------------

AIRBUS_DETAIL = re.compile(r"^(A3\d0|A318|A319|A320|A321)\b|^(A3\d\d)")
BOEING_DETAIL = re.compile(r"^(717|727|737NG|737MAX|737|747|757|767|777|787)(?=[ -]|$)")
OTHER_DETAIL_FAMILIES = [
    (re.compile(r"^ATR\b"), "ATR"),
    (re.compile(r"^F(28|50|70|100)(\s|$)"), "FOKKER"),
    (re.compile(r"^CRJ\b"), "CRJ"),
    (re.compile(r"^(DHC-8|Q400|DASH 8)\b"), "DHC8"),
    (re.compile(r"^(ERJ|E-?1[79]\d|E-?2\d\d|EMB-1[79]\d)"), "EMBRAER_JET"),
    (re.compile(r"^(DC-9|MD-8\d|MD-9\d)\b"), "DC9"),
    (re.compile(r"^MD-11\b"), "MD11"),
    (re.compile(r"^DC-10\b"), "DC10"),
    (re.compile(r"^340\b"), "SAAB340"),
    (re.compile(r"^EMB-120\b"), "EMB120"),
    (re.compile(r"^IL-76\b"), "IL76"),
]

# Freighter designations outside Boeing (Boeing is parsed from its designation structure).
OTHER_FREIGHTER = [
    re.compile(r"\(P2F\)|\(F\)"),           # Airbus passenger-to-freighter conversions
    re.compile(r"^A300 F4-"),                # A300F4-600R
    re.compile(r"^A3\d0 [0-9A-Z-]*\dR?F$"),  # A330 243F, A300 B4-622RF, A310 308F
    re.compile(r"^ATR \d\d \d{3}F$"),        # ATR 72 500F
    re.compile(r"^EMB-120 (ER/F|RT/F|FC)$"),
    re.compile(r"^CRJ \d{3} ?[SP]F$"),       # CRJ 200SF / 700 SF / 200PF
    re.compile(r"^DC-9 \d\d[A-Z]*C?F$"),     # DC-9 83SF, 32F, 15RCF, 33CF
    re.compile(r"^MD-11 (ER)?F$"),
    re.compile(r"^DC-10 \d\dF$"),
    re.compile(r"^340 F$"),                  # Saab 340 freighter
    re.compile(r"^F50 F$"),                  # Fokker 50 freighter
    re.compile(r"^IL-76 "),                  # Il-76: freighter airframe
]


def airbus_detail(detail: str) -> tuple[str, str | None] | None:
    """('A320', 'neo'|'ceo'|None) from details like 'A320 251NSL', 'A320-251N', 'A321NX'."""
    m = re.match(r"^(A3\d\d|A3\d0)", detail)
    if not m:
        return None
    model = m.group(1)
    model = {"A332": "A330", "A333": "A330", "A359": "A350"}.get(model, model)
    if model in ("A318", "A319", "A320", "A321"):
        rest = detail[len(m.group(1)):]
        # neo designations carry an N after the 3-digit engine/variant code (251N, 271NX) or "NX".
        code = re.search(r"(\d{3})([A-Z]*)", rest)
        if re.search(r"\bNX\b|^N", rest.strip()) or (code and "N" in code.group(2)):
            return model, "neo"
        if code:
            return model, "ceo"
        return model, None
    return model, None


def boeing_detail(detail: str) -> tuple[str, str | None, str | None, str] | None:
    """(family, series, generation, variant token) from a Boeing variant detail.

    Handles '737NG 8AS/W', '737MAX 8', '737-8', '737-8 MAX', '737-8200', '737 476', '777 FS2'.
    """
    m = BOEING_DETAIL.match(detail)
    if not m:
        return None
    head = m.group(1)
    family = "737" if head.startswith("737") else head
    rest = detail[len(head):].strip(" -")
    token = rest.replace("/W", "").replace(" ", "").upper()
    if family == "737":
        if head == "737MAX" or "MAX" in token:
            gen = "MAX"
        elif head == "737NG":
            gen = "NG"
        elif re.fullmatch(r"(7|8|9|10)(200)?", token):
            gen = "MAX"  # '737-8', '737-9', '737-8200': MAX naming without a customer code
        elif re.fullmatch(r"[2-5][0-9A-Z]{2}.*", token):
            gen = "classic"  # '737 476', '737 490SF'
        elif re.fullmatch(r"[6-9][0-9A-Z]{2}.*", token):
            gen = "NG"  # '737-8FH' (NG with customer code FH)
        else:
            gen = None
        token = token.replace("MAX", "")
    else:
        gen = None
    if family == "777" and token.startswith("F"):
        series = "F"
    else:
        sm = re.match(r"(10|\d)", token)
        series = sm.group(1) if sm else None
    return family, series, gen, token


def detail_family(detail: str) -> str | None:
    if AIRBUS_DETAIL.match(detail):
        return "AIRBUS"
    if BOEING_DETAIL.match(detail):
        return "BOEING"
    for rx, fam in OTHER_DETAIL_FAMILIES:
        if rx.search(detail):
            return fam
    return None


def type_family(ac_type: str) -> str | None:
    if ac_type in AIRBUS_TYPES:
        return "AIRBUS"
    if ac_type in BOEING_TYPES:
        return "BOEING"
    for rx, fam in OTHER_TYPE_FAMILIES:
        if rx.match(ac_type):
            return fam
    return None


def consistency(ac_type: str, detail: str) -> str | None:
    """None when the type code and the variant detail agree, else a short reason."""
    tf, df = type_family(ac_type), detail_family(detail)
    if tf and df and tf != df:
        return f"type family {tf} vs variant family {df}"
    if tf == "AIRBUS" and df == "AIRBUS":
        model, gen = AIRBUS_TYPES[ac_type]
        parsed = airbus_detail(detail)
        if parsed is None:
            return None
        dmodel, dgen = parsed
        if dmodel != model:
            return f"Airbus model {model} vs {dmodel}"
        if gen and dgen and gen != dgen:
            return f"Airbus {gen} type vs {dgen} variant"
    if tf == "BOEING" and df == "BOEING":
        family, series, gen = BOEING_TYPES[ac_type]
        parsed = boeing_detail(detail)
        if parsed is None:
            return None
        dfam, dseries, dgen, _ = parsed
        if dfam != family:
            return f"Boeing {family} vs {dfam}"
        if dseries and dseries not in series.split("|"):
            return f"Boeing series {family}-{series} vs {dseries}"
        if gen and dgen and gen != dgen:
            return f"Boeing {gen} type vs {dgen} variant"
    return None


def classify_boeing(detail: str) -> tuple[str, str]:
    parsed = boeing_detail(detail)
    if parsed is None:
        return "unknown", "boeing: unparsed"
    family, _series, gen, token = parsed
    if family == "737" and gen == "MAX":
        return "passenger", "boeing: 737 MAX (no freighter variant)"
    if family == "777" and token.startswith("F"):
        return "cargo", "boeing: 777F"
    if not token[:1].isdigit():
        return "unknown", "boeing: unparsed token"
    rest = token[1:] if not token.startswith("10") else token[2:]
    # Customer code is two characters; whatever follows is the variant suffix.
    suffix = rest[2:] if len(rest) >= 2 else rest
    if len(rest) >= 2 and rest[:2] == "00":
        suffix = rest[2:]  # "767 300F" style
    if "F" in suffix:
        return "cargo", f"boeing: freighter suffix '{suffix}'"
    return "passenger", f"boeing: suffix '{suffix or '-'}'"


def classify(ac_type: str | None, detail: str | None) -> tuple[str, str]:
    ac_type = (ac_type or "").strip()
    detail = (detail or "").strip()
    if detail in ("-", ""):
        if ac_type in PASSENGER_ONLY:
            return "passenger", "type has no freighter variant"
        return "unknown", "no variant detail"
    if NON_AIRLINE_MARKERS.search(detail):
        return "unknown", "business / VIP variant"
    reason = consistency(ac_type, detail)
    if reason:
        return "unknown", f"type code and variant disagree: {reason}"
    if detail_family(detail) == "BOEING":
        return classify_boeing(detail)
    for rx in OTHER_FREIGHTER:
        if rx.search(detail):
            return "cargo", f"freighter designation /{rx.pattern}/"
    if detail.startswith("An-2"):
        return "unknown", "utility aircraft"
    return "passenger", "commercial variant without freighter designation"


def main(paths: list[str]) -> None:
    import duckdb

    con = duckdb.connect()
    files = ", ".join(f"'{Path(p).as_posix()}'" for p in paths)
    rows = con.execute(
        f"""SELECT AC_Type, AC_Type_Detailed, count(*) AS flights
            FROM read_parquet([{files}])
            WHERE Airline <> '-'
            GROUP BY 1, 2
            ORDER BY flights DESC, AC_Type NULLS LAST, AC_Type_Detailed NULLS LAST"""  # total order: reproducible file
    ).fetchall()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    totals: dict[str, int] = {}
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["ac_type", "ac_type_detailed", "class", "rule", "flights_2026_q1_q3"])
        for ac_type, detail, n in rows:
            cls, rule = classify(ac_type or "", detail or "-")
            totals[cls] = totals.get(cls, 0) + n
            w.writerow([ac_type, detail, cls, rule, n])
    print(f"wrote {OUT} ({len(rows)} variants)")
    for k, v in sorted(totals.items()):
        print(f"  {k:9} {v:>12,} flights")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
