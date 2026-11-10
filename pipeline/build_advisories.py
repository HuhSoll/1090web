"""
Builds public/data/advisories/easa-czib.json from EASA's Conflict Zone Information Bulletins.

Source: https://www.easa.europa.eu/en/domains/air-operations/czibs (JSON export)
Terms:  "Reproduction is authorised, provided the source is acknowledged" (EASA copyright notice).

These are SAFETY WARNINGS (advisories to operators). They do not mean flights stopped, and the
app must never remove routes because of them. Each bulletin keeps its own period of effect so
the map can show which ones applied in the month being viewed.

Period of effect:
  start = issue date
  end   = "valid until" for active bulletins; for withdrawn ones the earlier of "valid until"
          and the last update (EASA does not publish the withdrawal date itself, so the last
          update is used and flagged as approximate)

Usage:
  python pipeline/build_advisories.py            # uses data/raw/advisories/easa-czib.json
  python pipeline/build_advisories.py --fetch    # downloads a fresh copy first
"""

import argparse
import html
import json
import re
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "advisories" / "easa-czib.json"
OUT = ROOT / "public" / "data" / "advisories" / "easa-czib.json"
SOURCE_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs"
EXPORT_URL = SOURCE_URL + "/export-json?page&_format=json"

# EASA country names -> (ISO 3166-1 alpha-2, ISO numeric as used by world-atlas)
COUNTRIES = {
    "Afghanistan": ("AF", "004"),
    "Bahrain": ("BH", "048"),
    "Democratic People's Republic of Korea": ("KP", "408"),
    "Democratic Republic of the Congo": ("CD", "180"),
    "Egypt": ("EG", "818"),
    "Ethiopia": ("ET", "231"),
    "India": ("IN", "356"),
    "Iran": ("IR", "364"),
    "Iraq": ("IQ", "368"),
    "Israel": ("IL", "376"),
    "Jordan": ("JO", "400"),
    "Kenya": ("KE", "404"),
    "Kuwait": ("KW", "414"),
    "Lebanon": ("LB", "422"),
    "Libya": ("LY", "434"),
    "Mali": ("ML", "466"),
    "Myanmar": ("MM", "104"),
    "Niger": ("NE", "562"),
    "Oman": ("OM", "512"),
    "Pakistan": ("PK", "586"),
    "Qatar": ("QA", "634"),
    "Russia": ("RU", "643"),
    "Russian Federation": ("RU", "643"),
    "Saudi Arabia": ("SA", "682"),
    "Somalia": ("SO", "706"),
    "South Sudan": ("SS", "728"),
    "Sudan": ("SD", "729"),
    "Syria": ("SY", "760"),
    "Ukraine": ("UA", "804"),
    "United Arab Emirates": ("AE", "784"),
    "Venezuela": ("VE", "862"),
    "Yemen": ("YE", "887"),
    "North Korea": ("KP", "408"),
}


def clean(s: str | None) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).replace("\xa0", " ").strip()


def parse_iso_date(s: str) -> date | None:
    # Values are plain ISO strings or wrapped in <time> markup; the calendar date is all we need.
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    return date(int(m[1]), int(m[2]), int(m[3])) if m else None


def parse_dmy(s: str) -> date | None:
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", (s or "").strip())
    return date(int(m[3]), int(m[2]), int(m[1])) if m else None


def countries_for(record: dict) -> list[dict]:
    field = clean(record.get("country"))
    names = [n.strip() for n in field.split(",") if n.strip()] if field else []
    if not names:
        # Older/withdrawn entries sometimes leave the country empty; fall back to the title.
        title = clean(record.get("name"))
        names = [n for n in COUNTRIES if re.search(rf"\b{re.escape(n)}\b", title)]
    out, seen = [], set()
    for n in names:
        hit = COUNTRIES.get(n)
        if not hit:
            print(f"  ! unmapped country name: {n!r} in {clean(record.get('name'))!r}")
            continue
        if hit[0] in seen:
            continue
        seen.add(hit[0])
        out.append({"iso2": hit[0], "isoNumeric": hit[1], "name": n})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="download a fresh copy from EASA first")
    args = ap.parse_args()

    if args.fetch or not RAW.exists():
        RAW.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(EXPORT_URL, headers={"User-Agent": "1090web-pipeline"})
        with urllib.request.urlopen(req, timeout=60) as r:
            RAW.write_bytes(r.read())
        print(f"downloaded {RAW}")
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    retrieved = datetime.fromtimestamp(RAW.stat().st_mtime, timezone.utc).replace(microsecond=0)

    items = []
    for r in raw["conflict_zones"]:
        title = clean(r.get("name"))
        status = clean(r.get("status"))
        issued = parse_iso_date(r.get("issued_date"))
        valid_until = parse_dmy(r.get("valid_until_date"))
        updated = parse_iso_date(r.get("updated"))
        if status == "Withdrawn":
            candidates = [d for d in (valid_until, updated) if d]
            end = min(candidates) if candidates else None
            approximate = not valid_until or (updated is not None and updated < valid_until)
        else:
            end, approximate = valid_until, False
        if issued and end and end < issued:
            # Seen in old entries: the last update predates the issue date. Keep a 1-day period.
            end, approximate = issued, True
        countries = countries_for(r)
        whole_country = bool(re.fullmatch(r"Airspace of [^–\-,]+", title)) and len(countries) == 1
        items.append({
            "id": f"easa-{r.get('Nid')}",
            "kind": "safety-warning",
            "title": title,
            "status": status.lower(),
            "issued": issued.isoformat() if issued else None,
            "end": end.isoformat() if end else None,
            "endIsApproximate": approximate,
            "validUntilNote": clean(r.get("field_easa_valid_until_descr")),
            "countries": countries,
            # Part of a country (e.g. one FIR or province) or a multi-country region: the map can
            # only tint whole countries, so the UI says the area is approximate.
            "partialArea": not whole_country,
        })
    items.sort(key=lambda x: (x["issued"] or "", x["title"]), reverse=True)

    out = {
        "schemaVersion": 1,
        "source": {
            "id": "easa-czib",
            "name": "EASA Conflict Zone Information Bulletins",
            "url": SOURCE_URL,
            "license": "© European Union Aviation Safety Agency. Reproduction authorised provided the source is acknowledged.",
            "retrievedAt": retrieved.isoformat().replace("+00:00", "Z"),
        },
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT}: {len(items)} bulletins, {sum(1 for i in items if i['status'] == 'active')} active")


if __name__ == "__main__":
    main()
