"""Event registry (Phase 9H): validation of curated events against their downloaded sources."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from events import build_registry as R

ROOT = Path(__file__).resolve().parents[2]

SOURCES = {"sources": [
    {"id": "auth", "url": "https://authority.example/doc", "publisher": "Authority", "sourceType": "authority", "title": "Notice"},
    {"id": "sna", "url": "https://agency.example/a", "publisher": "Agency", "sourceType": "state-news-agency", "title": "Report"},
    {"id": "press", "url": "https://press.example/a", "publisher": "Paper", "sourceType": "press", "title": "Article"},
    {"id": "failed", "url": "https://blocked.example/a", "publisher": "Blocked", "sourceType": "authority", "title": "Blocked"},
]}
LOCK = {"files": {
    "auth": {"status": "ok", "sha256": "a" * 64, "retrievedAt": "2026-11-17T10:00:00Z"},
    "sna": {"status": "ok", "sha256": "b" * 64, "retrievedAt": "2026-11-17T10:00:00Z"},
    "press": {"status": "ok", "sha256": "c" * 64, "retrievedAt": "2026-11-17T10:00:00Z"},
    "failed": {"status": "error", "error": "HTTP 403"},
}}


def ev(**kw) -> dict:
    base = {
        "eventId": "RST-XX-1", "eventType": "AIRSPACE_RESTRICTION", "title": "t", "issuingAuthority": "Authority",
        "documentId": "N1", "revisionId": None,
        "publication": [{"utc": None, "local": "2026-02-28", "tz": "Asia/Dubai", "precision": "date", "basis": "doc date", "sourceId": "auth"}],
        "coveredCountries": ["AE"], "sourceReferences": [{"sourceId": "auth"}], "verificationStatus": "Verified",
    }
    base.update(kw)
    return base


def build(tmp_path: Path, monkeypatch, events: list[dict]) -> dict:
    (tmp_path / "curated").mkdir()
    (tmp_path / "sources.json").write_text(json.dumps(SOURCES), encoding="utf-8")
    (tmp_path / "sources-documents.lock.json").write_text(json.dumps(LOCK), encoding="utf-8")
    (tmp_path / "curated" / "case.json").write_text(json.dumps({"events": events, "notCaptured": [{"subject": "x", "reason": "y"}]}), encoding="utf-8")
    monkeypatch.setattr(R, "HERE", tmp_path)
    return R.build()


def errors_of(out: dict) -> list[str]:
    return [e for r in out["rejected"] for e in r["errors"]]


def test_valid_event_is_kept_with_its_source_hash(tmp_path, monkeypatch):
    out = build(tmp_path, monkeypatch, [ev()])
    assert out["rejected"] == []
    (e,) = out["events"]
    assert e["sourceReferences"][0]["sha256"] == "a" * 64
    assert e["firstVerifiedAt"] == "2026-11-17T10:00:00Z"
    assert out["notCaptured"][0]["subject"] == "x"


def test_date_only_time_must_not_become_midnight_utc(tmp_path, monkeypatch):
    bad = ev(publication=[{"utc": "2026-02-28T00:00:00Z", "local": "2026-02-28", "tz": None, "precision": "date", "basis": "b", "sourceId": "auth"}])
    out = build(tmp_path, monkeypatch, [bad])
    assert out["events"] == []
    assert any("must not carry a UTC instant" in x for x in errors_of(out))


def test_utc_must_match_the_stated_local_time(tmp_path, monkeypatch):
    good = ev(eventId="A", documentId="A", publication=[{"utc": "2026-02-28T05:42:00Z", "local": "2026-02-28T09:42+04:00", "tz": "Asia/Dubai", "precision": "minute", "basis": "b", "sourceId": "auth"}])
    bad = ev(eventId="B", documentId="B", publication=[{"utc": "2026-02-28T09:42:00Z", "local": "2026-02-28T09:42+04:00", "tz": "Asia/Dubai", "precision": "minute", "basis": "b", "sourceId": "auth"}])
    out = build(tmp_path, monkeypatch, [good, bad])
    assert [e["eventId"] for e in out["events"]] == ["A"]
    assert any("does not match local" in x for x in errors_of(out))


def test_time_must_come_from_a_source_of_the_event(tmp_path, monkeypatch):
    bad = ev(publication=[{"utc": None, "local": "2026-02-28", "tz": None, "precision": "date", "basis": "b", "sourceId": "press"}])
    out = build(tmp_path, monkeypatch, [bad])
    assert any("not a source of the event" in x for x in errors_of(out))


@pytest.mark.parametrize("status,src,ok", [
    ("Verified", "auth", True), ("Verified", "sna", False), ("Verified", "press", False),
    ("Partially Verified", "sna", True), ("Partially Verified", "press", False), ("Unverified", "press", True),
])
def test_status_is_limited_by_source_types(tmp_path, monkeypatch, status, src, ok):
    e = ev(verificationStatus=status, sourceReferences=[{"sourceId": src}],
           publication=[{"utc": None, "local": "2026-02-28", "tz": None, "precision": "date", "basis": "b", "sourceId": src}])
    out = build(tmp_path, monkeypatch, [e])
    assert bool(out["events"]) is ok


def test_source_that_was_not_downloaded_is_rejected(tmp_path, monkeypatch):
    out = build(tmp_path, monkeypatch, [ev(sourceReferences=[{"sourceId": "auth"}, {"sourceId": "failed"}])])
    assert any("was not downloaded" in x for x in errors_of(out))


def test_duplicates_and_unknown_values_are_rejected(tmp_path, monkeypatch):
    out = build(tmp_path, monkeypatch, [
        ev(), ev(documentId="N2"), ev(eventId="RST-XX-2"),  # same id; same document
        ev(eventId="T", documentId="T", eventType="CLOSURE"), ev(eventId="S", documentId="S", verificationStatus="Likely"),
        ev(eventId="C", documentId="C", closureScope="most"),
    ])
    errs = errors_of(out)
    assert [e["eventId"] for e in out["events"]] == ["RST-XX-1"]
    for needle in ["duplicate eventId", "duplicate document", "unknown event type", "unknown status", "unknown closure scope"]:
        assert any(needle in x for x in errs), needle


def test_reopening_needs_the_event_it_reopens(tmp_path, monkeypatch):
    out = build(tmp_path, monkeypatch, [
        ev(eventId="REO-1", documentId="R1", eventType="AIRSPACE_REOPENING"),
        ev(eventId="REO-2", documentId="R2", eventType="AIRSPACE_REOPENING", relatedEvents=[{"eventId": "RST-NONE", "relation": "reopens", "basis": "source"}]),
    ])
    assert [e["eventId"] for e in out["events"]] == ["REO-2"]
    assert out["events"][0]["relatedEvents"][0]["missing"] is True  # kept, but marked as not in the registry


def test_operator_and_altitude_scope_are_kept_as_given(tmp_path, monkeypatch):
    e = ev(affectedOperators={"scope": "us-operators", "text": "U.S. operators"},
           altitudeRestrictions={"lower": "SFC", "upper": "FL320", "text": "below FL320"}, closureScope="operators")
    (out,) = build(tmp_path, monkeypatch, [e])["events"]
    assert out["affectedOperators"]["scope"] == "us-operators"
    assert out["altitudeRestrictions"]["upper"] == "FL320"
    assert out["closureScope"] == "operators"


def test_registry_version_changes_with_content(tmp_path, monkeypatch):
    a = build(tmp_path, monkeypatch, [ev()])["registryVersion"]
    tmp2 = tmp_path / "b"
    tmp2.mkdir()
    b = build(tmp2, monkeypatch, [ev(title="other")])["registryVersion"]
    assert a != b


def test_published_registry_matches_the_rules():
    out = json.loads((ROOT / "public" / "data" / "events" / "events.json").read_text(encoding="utf-8"))
    assert out["rejected"] == []
    ids = [e["eventId"] for e in out["events"]]
    assert len(ids) == len(set(ids))
    for e in out["events"]:
        for f in R.TIME_FIELDS:
            for t in e[f]:
                if t["precision"] == "date":
                    assert t["utc"] is None, e["eventId"]
        if e["issuingAuthority"] == "FAA":
            assert e["affectedOperators"]["scope"] == "us-operators"
        types = {s["sourceType"] for s in e["sourceReferences"]}
        if e["verificationStatus"] == "Verified":
            assert types & {"authority", "archive"}
    curated = copy.deepcopy(json.loads((ROOT / "pipeline" / "events" / "curated" / "middle-east-2026.json").read_text(encoding="utf-8")))
    assert len(curated["events"]) == len(out["events"])
