"""
Build the event registry for the browser (Phase 9H): public/data/events/events.json.

Input: pipeline/events/curated/*.json (events written from documents), pipeline/events/sources.json
(the documents) and pipeline/events/sources-documents.lock.json (what was downloaded). EASA CZIB
versions stay in easa-czib-history.json (Phase 9G) and are mapped to the same model in the browser.

Every event is checked; an event that fails a check is rejected with the reason (never fixed up):
- known event type and verification status
- every source reference names a downloaded document (status ok, checksum)
- every time names one of the event's sources; a date-only time has no UTC instant (it is never
  turned into 00:00 UTC); a UTC instant agrees with the stated local time and offset
- 'Verified' needs an authority document (or an archived capture of one); 'Partially Verified'
  needs an authority document or a state news agency; press alone is 'Unverified'
- a reopening names the event it reopens; ids are unique; one record per (authority, document,
  revision)

  python pipeline/events/build_registry.py
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / "public" / "data" / "events" / "events.json"
SCHEMA_VERSION = 1

EVENT_TYPES = {
    "SAFETY_ADVISORY": "Safety advisory (recommendation to operators; not a closure)",
    "AIRSPACE_RESTRICTION": "Official restriction of an airspace for some operators, aircraft, altitudes or times",
    "AIRSPACE_CLOSURE": "Officially confirmed closure of an airspace",
    "AIRPORT_CLOSURE": "Officially confirmed suspension of an airport's operations",
    "SECURITY_INCIDENT": "Military action, attack or security incident that may affect air traffic",
    "AIRSPACE_REOPENING": "Lifting of a restriction or closure (not a return to normal operations)",
    "OTHER_VERIFIED_EVENT": "Other event with a checkable source",
}
STATUSES = ["Verified", "Partially Verified", "Disputed", "Incomplete", "Unverified"]
PRECISIONS = ["minute", "hour", "date", "month", "unknown"]
TIME_FIELDS = ["occurrence", "publication", "effectiveFrom", "effectiveUntil"]
CLOSURE_SCOPES = ["full", "partial", "aircraft-types", "operators", "unknown"]


def check_time(ev: dict, field: str, t: dict, refs: set[str], errors: list[str]) -> None:
    if t.get("precision") not in PRECISIONS:
        errors.append(f"{field}: bad precision {t.get('precision')!r}")
    if t.get("sourceId") not in refs:
        errors.append(f"{field}: time from {t.get('sourceId')!r}, which is not a source of the event")
    if t.get("precision") in ("date", "month", "unknown") and t.get("utc"):
        errors.append(f"{field}: a {t['precision']}-precision time must not carry a UTC instant")
    if t.get("utc"):
        try:
            u = datetime.fromisoformat(t["utc"].replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"{field}: bad UTC {t['utc']!r}")
            return
        m = re.match(r"^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}):(\d{2})$", t.get("local") or "")
        if m:
            off = int(m[4]) * 60 + (1 if int(m[4]) >= 0 else -1) * int(m[5])
            local = datetime.fromisoformat(f"{m[1]}T{m[2]}:{m[3]}:00").replace(tzinfo=timezone(timedelta(minutes=off)))
            if abs((local - u).total_seconds()) > 60:
                errors.append(f"{field}: UTC {t['utc']} does not match local {t['local']}")


def build() -> dict:
    sources = {s["id"]: s for s in json.loads((HERE / "sources.json").read_text(encoding="utf-8"))["sources"]}
    lock = json.loads((HERE / "sources-documents.lock.json").read_text(encoding="utf-8"))["files"]
    events, rejected, not_captured = [], [], []
    seen_ids: set[str] = set()
    seen_docs: set[tuple] = set()
    for f in sorted((HERE / "curated").glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        not_captured += [{**x, "file": f.name} for x in data.get("notCaptured", [])]
        for ev in data["events"]:
            errors: list[str] = []
            if ev.get("eventType") not in EVENT_TYPES:
                errors.append(f"unknown event type {ev.get('eventType')!r}")
            if ev.get("verificationStatus") not in STATUSES:
                errors.append(f"unknown status {ev.get('verificationStatus')!r}")
            if ev.get("closureScope") is not None and ev["closureScope"] not in CLOSURE_SCOPES:
                errors.append(f"unknown closure scope {ev['closureScope']!r}")
            if ev["eventId"] in seen_ids:
                errors.append("duplicate eventId")
            doc = (ev.get("issuingAuthority"), ev.get("documentId"), ev.get("revisionId"))
            if ev.get("documentId"):
                if doc in seen_docs:
                    errors.append(f"duplicate document {doc}")
            refs = {r["sourceId"] for r in ev.get("sourceReferences", [])}
            expanded = []
            for r in ev.get("sourceReferences", []):
                s, l = sources.get(r["sourceId"]), lock.get(r["sourceId"])
                if not s:
                    errors.append(f"source {r['sourceId']!r} not in sources.json")
                    continue
                if not l or l.get("status") != "ok":
                    errors.append(f"source {r['sourceId']!r} was not downloaded ({(l or {}).get('error', 'missing')})")
                    continue
                expanded.append({"sourceId": s["id"], "publisher": s["publisher"], "sourceType": s["sourceType"], "title": s["title"],
                                 "url": s["url"], "capturedAt": s.get("capturedAt"), "retrievedAt": l["retrievedAt"], "sha256": l["sha256"],
                                 "supports": r.get("supports", [])})
            types = {x["sourceType"] for x in expanded}
            st = ev.get("verificationStatus")
            if st == "Verified" and not types & {"authority", "archive"}:
                errors.append("'Verified' needs an authority document")
            if st == "Partially Verified" and not types & {"authority", "archive", "state-news-agency"}:
                errors.append("'Partially Verified' needs an authority document or a state news agency")
            if ev.get("eventType") == "AIRSPACE_REOPENING" and not any(x.get("relation") == "reopens" for x in ev.get("relatedEvents", [])):
                errors.append("a reopening must name the event it reopens")
            for field in TIME_FIELDS:
                for t in ev.get(field, []):
                    check_time(ev, field, t, refs, errors)
            if errors:
                rejected.append({"eventId": ev.get("eventId"), "file": f.name, "errors": errors})
                continue
            seen_ids.add(ev["eventId"])
            if ev.get("documentId"):
                seen_docs.add(doc)
            first = min((x["capturedAt"] or x["retrievedAt"]) for x in expanded) if expanded else None
            events.append({
                "schemaVersion": SCHEMA_VERSION,
                "eventId": ev["eventId"], "eventType": ev["eventType"], "title": ev["title"], "titleJa": ev.get("titleJa"),
                "description": ev.get("description"), "issuingAuthority": ev.get("issuingAuthority"),
                "documentType": ev.get("documentType"), "documentId": ev.get("documentId"), "revisionId": ev.get("revisionId"),
                **{k: ev.get(k, []) for k in TIME_FIELDS},
                "firstVerifiedAt": first,
                "coveredCountries": ev.get("coveredCountries", []), "coveredFIRs": ev.get("coveredFIRs", []),
                "affectedAirports": ev.get("affectedAirports", []), "affectedOperators": ev.get("affectedOperators"),
                "affectedAircraftTypes": ev.get("affectedAircraftTypes", []), "altitudeRestrictions": ev.get("altitudeRestrictions"),
                "closureScope": ev.get("closureScope"),
                "geometry": None,
                "sourceReferences": expanded, "relatedEvents": ev.get("relatedEvents", []),
                "verificationStatus": st, "verified": ev.get("verified", []), "notVerified": ev.get("notVerified", []),
                "confidenceNotes": ev.get("confidenceNotes"), "supersedesEventId": ev.get("supersedesEventId"),
            })
    # related events must exist (CZIB versions are written CZIB:<bulletin>/<revision>)
    ids = {e["eventId"] for e in events}
    for e in events:
        for r in e["relatedEvents"]:
            if not r["eventId"].startswith("CZIB:") and r["eventId"] not in ids:
                r["missing"] = True
    body = {"events": events, "rejected": rejected, "notCaptured": not_captured}
    version = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    return {"schemaVersion": SCHEMA_VERSION, "registryVersion": version, "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "eventTypes": EVENT_TYPES, "statuses": STATUSES,
            "note": "Facts as stated by the sources. Relations marked basis=temporal are only closeness in time. Nothing here is a cause of an observed change.",
            "czibHistory": "data/events/easa-czib-history.json (SAFETY_ADVISORY, EASA, Phase 9G)", **body}


def main() -> None:
    out = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    for e in out["events"]:
        print(e["eventType"], e["eventId"], e["verificationStatus"], len(e["sourceReferences"]))
    for r in out["rejected"]:
        print("REJECTED", r)
    print(len(out["events"]), "events,", len(out["rejected"]), "rejected, version", out["registryVersion"])


if __name__ == "__main__":
    main()
