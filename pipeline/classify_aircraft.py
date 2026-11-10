"""
Builds pipeline/reference/aircraft_variant_class.csv: one row per (AC_Type, AC_Type_Detailed)
seen in the raw data, classified as passenger / cargo / unknown with the rule that decided it.

The CSV is committed so the classification can be reviewed by a human; the build pipeline only
joins on it. Anything not in the CSV is 'unknown'. Rules are deliberately conservative: a
flight is only 'cargo' when the aircraft variant itself is a freighter, never because of the
operator's name or a guess.

Usage: python pipeline/classify_aircraft.py data/raw/flights/2026_Q*_detailed_github.parquet
"""

import csv
import re
import sys
from pathlib import Path

import duckdb

REF = Path(__file__).parent / "reference"
OUT = REF / "aircraft_variant_class.csv"

# Airliner types that only exist as passenger aircraft (reviewed list with notes).
with (REF / "passenger_only_types.csv").open(encoding="utf-8") as _f:
    PASSENGER_ONLY = {row["ac_type"] for row in csv.DictReader(_f)}

# Boeing: "<family> <series><2-char customer code><suffix>", e.g. 737NG 8ASBCF/W, 767 34AF/W,
# 777 3F2ER (customer F2, passenger), 777 FS2 (777F for customer S2).
BOEING_FAMILIES = {"727": "B72", "737": "B73", "737NG": "B73", "737MAX": "B3", "747": "B74", "757": "B75", "767": "B76", "777": "B77", "787": "B78"}
# Suffix letters that mark a freighter: F, ERF, BF, BCF, BDSF, SF, PCF, PF, FSCD, ...
FREIGHTER_SUFFIX = re.compile(r"F")

NON_AIRLINE_MARKERS = re.compile(r"\b(BBJ|VIP|ACJ)\b")

# Other manufacturers: explicit freighter designations only.
OTHER_FREIGHTER = [
    re.compile(r"\(P2F\)|\(F\)"),          # Airbus passenger-to-freighter conversions
    re.compile(r"^A300 F4-"),               # A300F4-600R
    re.compile(r"^A3\d0 [0-9A-Z-]*\dR?F$"),  # A330 243F, A300 B4-622RF, A310 308F
    re.compile(r"^ATR \d\d \d{3}F$"),       # ATR 72 500F
    re.compile(r"^EMB-120 (ER/F|RT/F|FC)$"),
    re.compile(r"^CRJ \d{3} ?[SP]F$"),      # CRJ 200SF / 700 SF / 200PF
    re.compile(r"^DC-9 \d\d[A-Z]*C?F$"),    # DC-9 83SF, 32F, 15RCF, 33CF
    re.compile(r"^MD-11 (ER)?F$|^MD-11 F$"),
    re.compile(r"^DC-10 \d\dF$"),
    re.compile(r"^340 F$"),                 # Saab 340 freighter
    re.compile(r"^F50 F$"),                 # Fokker 50 freighter
    re.compile(r"^IL-76 "),                 # Il-76: freighter airframe
]


def family_prefix(detail: str) -> str | None:
    head = re.split(r"[ -]", detail, maxsplit=1)[0]
    return BOEING_FAMILIES.get(head)


def classify_boeing(detail: str) -> tuple[str, str]:
    m = re.match(r"^(727|737NG|737MAX|737|747|757|767|777|787)[ -](.+)$", detail)
    if not m:
        return "unknown", "boeing: unparsed"
    token = m.group(2).replace("/W", "").replace(" ", "").upper()
    if m.group(1) == "777" and token.startswith("F"):
        return "cargo", "boeing: 777F"
    if not token[:1].isdigit():
        return "unknown", "boeing: unparsed token"
    rest = token[1:]
    # Customer code is two characters; whatever follows is the variant suffix.
    suffix = rest[2:] if len(rest) >= 2 else rest
    if len(rest) >= 2 and rest[:2].isdigit() and rest[:2] == "00":
        suffix = rest[2:]  # "767 300F" style
    if FREIGHTER_SUFFIX.search(suffix):
        return "cargo", f"boeing: freighter suffix '{suffix}'"
    return "passenger", f"boeing: suffix '{suffix or '-'}'"


FOKKER = re.compile(r"^F(28|50|70|100)(\s|$)")


def classify(ac_type: str, detail: str) -> tuple[str, str]:
    if detail in ("-", "", None):
        if ac_type in PASSENGER_ONLY:
            return "passenger", "type has no freighter variant"
        return "unknown", "no variant detail"
    if NON_AIRLINE_MARKERS.search(detail):
        return "unknown", "business / VIP variant"
    fam = family_prefix(detail)
    if fam is not None:
        if not (ac_type or "").startswith(fam if fam != "B3" else "B3"):
            return "unknown", "type code and variant disagree"
        return classify_boeing(detail)
    for rx in OTHER_FREIGHTER:
        if rx.search(detail):
            return "cargo", f"freighter designation /{rx.pattern}/"
    if FOKKER.search(detail) and not (ac_type or "").startswith("F"):
        return "unknown", "type code and variant disagree"
    if detail.startswith("An-2"):
        return "unknown", "utility aircraft"
    # Airbus detail must match the ICAO family letter, e.g. A320 with A32x.
    if detail.startswith("A3") and not (ac_type or "").startswith(detail[:3]):
        if not (detail[:4] == "A300" and ac_type.startswith("A30")):
            return "unknown", "type code and variant disagree"
    if detail.startswith("ATR") and not (ac_type or "").startswith("AT"):
        return "unknown", "type code and variant disagree"
    return "passenger", "commercial variant without freighter designation"


def main(paths: list[str]) -> None:
    con = duckdb.connect()
    files = ", ".join(f"'{p}'" for p in paths)
    rows = con.execute(
        f"""SELECT AC_Type, AC_Type_Detailed, count(*) AS flights
            FROM read_parquet([{files}])
            WHERE Airline <> '-'
            GROUP BY 1, 2 ORDER BY flights DESC"""
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
