"""
Build the history of EASA Conflict Zone Information Bulletins for the browser (Phase 9G).

Reads the live pages, the live export and the archived captures downloaded by fetch_easa.py and
writes public/data/events/easa-czib-history.json: one record per (bulletin, revision) that could
be verified from a captured page, with every capture that shows it.

Rules
- Nothing is inferred. A revision with no captured page is listed as missing, not reconstructed.
- Issue date, revision date, validity ("valid until") and the time a version was first seen are
  kept apart. EASA publishes dates (local time, no hour); the first capture is only an upper bound
  of the publication time. `publicationTimestamp` stays null unless a source states it.
- A bulletin is a safety advisory to operators, never an airspace or airport closure.
- A record without a source URL and a captured file is rejected.

  python pipeline/events/build_events.py
"""

from __future__ import annotations

import gzip
import hashlib
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "events" / "easa"
HERE = Path(__file__).resolve().parent
OUT = ROOT / "public" / "data" / "events" / "easa-czib-history.json"
SCHEMA_VERSION = 1
EASA = "https://www.easa.europa.eu"
CZIB_URL = EASA + "/en/domains/air-operations/czibs/"

sys.path.insert(0, str(ROOT / "pipeline"))
from build_advisories import COUNTRIES  # noqa: E402  (EASA country names -> ISO codes)

FIELDS = {
    "status": "field-easa-cz-status",
    "number": "field-easa-czib-number",
    "issue": "field-easa-conflict-zone-up-date",
    "revdate": "field-easa-conflict-zone-revdate",
    "revdesc": "field-easa-cz-rev",
    "validUntil": "field-easa-valid-until-descr",
    "airspace": "field-easa-cz-aff-air",
    "countries": "field-easa-related-country",
    "applicability": "field-easa-applicability-descr",
    "description": "field-easa-cz-description",
    "recommendations": "field-easa-cz-recommendations",
}


def text(s: str) -> str:
    s = re.sub(r"<br\s*/?>|</p>|</li>|</div>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\s*\n\s*", "\n", s).strip()


def field(page: str, name: str) -> str | None:
    """Text of a Drupal field (the block from its wrapper to the next field wrapper)."""
    m = re.search(rf'<div class="[^"]*field-name-{name}\b[^"]*"', page)
    if not m:
        return None
    rest = page[m.end():]
    nxt = re.search(r'<div class="[^"]*field-wrapper field ', rest)
    block = rest[: nxt.start()] if nxt else rest[:20000]
    t = text(block).lstrip(">").strip()
    label = re.match(r"^[^\n]*?(CZIB number|Issue date|Revision date|Revision description|Valid until|Affected Airspace|Affected Countries|Status|Applicability Description|Description|Recommendation\(s\)|Recommendations)\s*\n?", t)
    if label:
        t = t[label.end():].strip()
    return t or None


def dmy(s: str | None) -> str | None:
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m[3]}-{m[2]}-{m[1]}" if m else None


def title_of(page: str) -> str | None:
    m = re.search(r'<h1[^>]*>(.*?)</h1>', page, re.S) or re.search(r"<title>(.*?)</title>", page, re.S)
    if not m:
        return None
    t = text(m.group(1)).split("|")[0].strip()
    return t or None


def countries(page: str) -> list[dict]:
    """Affected countries: the country names inside the related-country field (it nests one
    field per country, so the block runs to the applicability field)."""
    m = re.search(r'<div class="[^"]*field-name-field-easa-related-country', page)
    if not m:
        return []
    end = re.search(r'<div class="[^"]*field-name-field-easa-cz-applicability', page[m.end():])
    block = text(page[m.end(): m.end() + (end.start() if end else 20000)])
    out, seen = [], set()
    for line in block.split("\n"):
        name = line.strip()
        if not name or name == "Affected Countries" or name in seen or '"' in name or ">" in name:
            continue
        seen.add(name)
        hit = COUNTRIES.get(name)
        out.append({"name": name, "iso2": hit[0] if hit else None})
    return out


def named_countries(airspace: str | None) -> list[dict]:
    """Country names written in the airspace description (older pages have no country field)."""
    a = airspace or ""
    out, seen = [], set()
    for name, (iso2, _) in COUNTRIES.items():
        if iso2 not in seen and re.search(r"\b" + re.escape(name) + r"\b", a):
            seen.add(iso2)
            out.append({"name": name, "iso2": iso2})
    return out


def firs(airspace: str | None) -> list[str]:
    """ICAO FIR codes named in the airspace text: 'FIR XXXX', 'FIR - XXXX', 'FIR Jeddah - XXXX', '(XXXX)', 'XXXX/FIR'."""
    a = airspace or ""
    codes = set(re.findall(r"FIR[^A-Z(]{0,6}([A-Z]{4})\b", a))
    codes |= set(re.findall(r"[–\-/]\s*([A-Z]{4})\b", a))
    codes |= set(re.findall(r"\(([A-Z]{4})(?:/|\))", a))
    return sorted(codes)


def recommendation_types(rec: str | None) -> list[str]:
    r = (rec or "").lower()
    out = []
    if re.search(r"should not operate|not to operate|refrain from operating", r):
        out.append("do-not-operate")
    if "caution" in r:
        out.append("operate-with-caution")
    if "risk assessment" in r:
        out.append("risk-assessment")
    if re.search(r"flight level|fl\s?\d{3}|altitude", r):
        out.append("altitude-specific")
    return out or ["unclassified"]


def summary(s: str | None, n: int = 600) -> str | None:
    if not s:
        return None
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n].rsplit(" ", 1)[0] + " …"


def split_number(num: str) -> tuple[str, str]:
    """'2026-03-R14' -> ('2026-03', 'R14'); '2026-03' -> ('2026-03', 'R0')."""
    m = re.match(r"^(?:CZIB-)?(\d{4}-\d{2})(?:[\s-]*R(\d+))?$", num.strip(), re.I)
    if not m:
        raise ValueError(f"unexpected CZIB number {num!r}")
    return m[1], f"R{int(m[2]) if m[2] else 0}"


def read(path: Path) -> str:
    """Text of a downloaded file. Some archived captures keep the server's gzip encoding."""
    b = path.read_bytes()
    if b[:2] == bytes([0x1F, 0x8B]):
        b = gzip.decompress(b)
    return b.decode("utf-8", errors="replace")


def parse(path: Path) -> dict | None:
    page = read(path)
    num = field(page, FIELDS["number"])
    if not num:
        return None
    bid, rid = split_number(num.split("\n")[0])
    vals = {k: field(page, v) for k, v in FIELDS.items()}
    rec = vals["recommendations"]
    return {
        "bulletinId": bid, "revisionId": rid, "czibNumber": num.split("\n")[0].strip(),
        "title": title_of(page),
        "status": (vals["status"] or "").split("\n")[0] or None,
        "issueDate": dmy(vals["issue"]), "revisionDate": dmy(vals["revdate"]),
        "revisionDescription": summary(vals["revdesc"], 800),
        "validUntil": dmy(vals["validUntil"]), "validUntilText": summary(vals["validUntil"], 200),
        "coveredAirspace": summary(vals["airspace"], 900), "firs": firs(vals["airspace"]),
        "coveredCountries": countries(page),
        "countriesNamedInAirspace": named_countries(vals["airspace"]),
        "recommendationType": recommendation_types(rec), "recommendationTextSummary": summary(rec),
        "affectedOperatorScope": summary(vals["applicability"], 500),
        "contentHash": hashlib.sha256(json.dumps([vals[k] for k in ("number", "issue", "revdate", "validUntil", "airspace", "countries", "recommendations")], ensure_ascii=False).encode()).hexdigest()[:16],
    }


def build() -> dict:
    lock = json.loads((HERE / "sources.lock.json").read_text(encoding="utf-8"))["files"]
    cfg = json.loads((HERE / "easa-bulletins.json").read_text(encoding="utf-8"))
    nid_of = {b["czib"]: b["nid"] for b in cfg["bulletins"]}
    found: dict[tuple[str, str], list[tuple[str, dict, dict]]] = {}
    rejected = []
    for rel, meta in sorted(lock.items()):
        if not rel.endswith(".html"):
            continue
        p = RAW / rel
        if not p.exists():
            rejected.append({"file": rel, "reason": "file missing"})
            continue
        r = parse(p)
        if r is None:
            rejected.append({"file": rel, "reason": "no CZIB number on the page (not a bulletin page)"})
            continue
        if not meta.get("url") or not meta.get("sha256"):
            rejected.append({"file": rel, "reason": "no source URL or checksum"})
            continue
        live = meta["kind"] == "live-page"
        seen = meta.get("capturedAt") or meta["retrievedAt"]
        cap = {"source": "easa-live" if live else "wayback", "at": seen, "url": meta["url"], "sha256": meta["sha256"], "contentHash": r["contentHash"]}
        found.setdefault((r["bulletinId"], r["revisionId"]), []).append((seen, r, cap))
    # the earliest capture of a revision defines its record; later captures are kept as evidence
    versions: dict[tuple[str, str], dict] = {}
    for key, items in found.items():
        items.sort(key=lambda x: x[0])
        versions[key] = {**items[0][1], "captures": [c for _, _, c in items]}
    bulletins: dict[str, dict] = {}
    for (bid, rid), v in sorted(versions.items(), key=lambda kv: (kv[0][0], int(kv[0][1][1:]))):
        caps = sorted(v.pop("captures"), key=lambda c: c["at"])
        variants = sorted({c["contentHash"] for c in caps})
        if not caps or not any(c["url"] for c in caps):
            rejected.append({"file": f"{bid}-{rid}", "reason": "no source URL"})
            continue
        slug = (f"czib-{bid}-{rid.lower()}" if int(bid[5:]) >= 4 and bid.startswith("2026") else f"{bid}-{rid.lower()}") if rid != "R0" else bid
        rec = {
            **{k: v[k] for k in ("bulletinId", "revisionId", "czibNumber", "title", "status", "issueDate", "revisionDate",
                                 "revisionDescription", "validUntil", "validUntilText", "coveredCountries", "countriesNamedInAirspace", "coveredAirspace", "firs",
                                 "recommendationType", "recommendationTextSummary", "affectedOperatorScope")},
            "issuingAuthority": "EASA",
            "kind": "safety-advisory",
            "isClosure": False,
            # the date the version took effect as published (R0: issue date; Rn: revision date)
            "effectiveDate": v["revisionDate"] if rid != "R0" and v["revisionDate"] else v["issueDate"],
            "validFrom": None,
            "validFromNote": "EASA does not state a start of validity; a version applies from its publication (date only, EASA local time).",
            "publicationTimestamp": None,
            "firstSeenAt": caps[0]["at"],
            "firstSeenSource": caps[0]["source"],
            "sourceUrl": CZIB_URL + slug,
            "captures": [{k: c[k] for k in ("source", "at", "url", "sha256")} for c in caps],
            "contentVariants": len(variants),
            "verificationStatus": "official-live" if all(c["source"] == "easa-live" for c in caps) else (
                "official-live+archived" if any(c["source"] == "easa-live" for c in caps) else "archived-capture"),
        }
        b = bulletins.setdefault(bid, {"bulletinId": bid, "nid": nid_of.get(bid), "issuingAuthority": "EASA", "revisions": []})
        b["revisions"].append(rec)
    for b in bulletins.values():
        nums = [int(r["revisionId"][1:]) for r in b["revisions"]]
        b["latestKnownRevision"] = f"R{max(nums)}"
        b["missingRevisions"] = [f"R{i}" for i in range(0, max(nums)) if i not in nums]
        b["title"] = b["revisions"][-1]["title"]
        b["issueDate"] = next((r["issueDate"] for r in b["revisions"] if r["issueDate"]), None)
        b["historyComplete"] = not b["missingRevisions"]
    # status and validity of every bulletin as listed in each export (live and archived)
    exports = []
    for rel, meta in sorted(lock.items()):
        if not rel.endswith(".json"):
            continue
        d = json.loads(read(RAW / rel))
        rows = []
        for r in d.get("conflict_zones", []):
            upd = re.search(r'datetime="([^"]+)"', r.get("updated") or "")
            rows.append({"nid": int(r["Nid"]), "title": text(r.get("name") or ""), "status": text(r.get("status") or ""),
                         "issued": (r.get("issued_date") or "")[:10] or None, "validUntil": dmy(r.get("valid_until_date")),
                         "updatedAt": upd[1] if upd else None})
        exports.append({"at": meta.get("capturedAt") or meta["retrievedAt"], "source": "wayback" if meta["kind"].startswith("wayback") else "easa-live",
                        "url": meta["url"], "sha256": meta["sha256"], "rows": rows})
    body = {"bulletins": sorted(bulletins.values(), key=lambda b: b["bulletinId"]), "exports": exports, "rejected": rejected}
    version = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "recordsVersion": version,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"id": "easa-czib", "name": "EASA Conflict Zone Information Bulletins", "url": CZIB_URL.rstrip("/"),
                   "licence": "© European Union Aviation Safety Agency. Reproduction authorised provided the source is acknowledged.",
                   "archive": "Earlier revisions: captures of the EASA pages by the Internet Archive Wayback Machine (web.archive.org)."},
        "meaning": "Safety advisories to operators. Not an airspace closure, not an airport closure, not a flight ban.",
        **body,
    }


def main() -> None:
    out = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    for b in out["bulletins"]:
        print(b["bulletinId"], b["title"], "revisions", [r["revisionId"] for r in b["revisions"]], "missing", b["missingRevisions"])
    print("rejected", len(out["rejected"]), "exports", len(out["exports"]), "version", out["recordsVersion"])


if __name__ == "__main__":
    main()
