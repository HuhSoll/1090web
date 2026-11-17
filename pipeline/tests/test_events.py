"""EASA advisory history (Phase 9G): parsing, versions, dates, rejection."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from events import build_events as B

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "events" / "easa"


def page(number: str, issue="28/02/2026", rev="18/03/2026", until="<p>27/03/2026, unless reviewed earlier.</p>",
         airspace="<p>All altitudes in the airspace of: Bahrain (Bahrain FIR – OBBB) and Saudi Arabia (FIR Jeddah - OEJD).</p>",
         countries=("Bahrain", "Saudi Arabia")) -> str:
    def f(name, label, body):
        return (f'<div class="field-wrapper field field-node--{name} field-name-{name} field-type-string field-label-inline clearfix">\n'
                f'<div class="field-label">{label}</div>\n<div class="field-items"><div class="field-item">{body}</div></div>\n</div>\n')
    cs = "".join(f'<div class="field-wrapper field field-node--field-easa-country field-name-field-easa-country"><a href="#">{c}</a></div>' for c in countries)
    return ("<html><h1>Airspace of the Middle East</h1>" + f("field-easa-cz-status", "Status", "Active") + f("field-easa-czib-number", "CZIB number", number)
            + f("field-easa-conflict-zone-up-date", "Issue date", issue) + (f("field-easa-conflict-zone-revdate", "Revision date", rev) if rev else "")
            + f("field-easa-valid-until-descr", "Valid until", until) + f("field-easa-cz-aff-air", "Affected Airspace", airspace)
            + '<div class="field-wrapper field field-node--field-easa-related-country field-name-field-easa-related-country field-type-entity-reference">'
            + '<div class="field-label">Affected Countries</div>' + cs + "</div>"
            + f("field-easa-cz-applicability", "Applicability", "Applies to operators")
            + f("field-easa-cz-recommendations", "Recommendations", "<p>Operators should not operate in the affected airspace at any flight level.</p>") + "</html>")


def test_bulletin_and_revision_ids():
    assert B.split_number("2026-03-R14") == ("2026-03", "R14")
    assert B.split_number("2025-01 R3") == ("2025-01", "R3")
    assert B.split_number("2026-03") == ("2026-03", "R0")
    assert B.split_number("CZIB-2026-07 R4") == ("2026-07", "R4")
    with pytest.raises(ValueError):
        B.split_number("R4")


def test_page_fields_keep_dates_apart(tmp_path):
    p = tmp_path / "x.html"
    p.write_text(page("2026-03-R4"), encoding="utf-8")
    r = B.parse(p)
    assert (r["bulletinId"], r["revisionId"]) == ("2026-03", "R4")
    assert r["issueDate"] == "2026-02-28" and r["revisionDate"] == "2026-03-18" and r["validUntil"] == "2026-03-27"
    assert [c["iso2"] for c in r["coveredCountries"]] == ["BH", "SA"]
    assert r["firs"] == ["OBBB", "OEJD"]
    assert "do-not-operate" in r["recommendationType"] and "altitude-specific" in r["recommendationType"]


def test_first_version_has_no_revision_date_and_gzip_captures_are_read(tmp_path):
    import gzip
    p = tmp_path / "x.html"
    p.write_bytes(gzip.compress(page("2026-03", rev=None).encode("utf-8")))
    r = B.parse(p)
    assert r["revisionId"] == "R0" and r["revisionDate"] is None and r["issueDate"] == "2026-02-28"


def test_countries_named_only_in_the_airspace_text():
    assert [c["iso2"] for c in B.named_countries("airspace of: Bahrain (Bahrain FIR), Iran (Tehran FIR - OIIX)")] == ["BH", "IR"]
    assert B.firs("FIR Maiquetia – SVZM and San Juan FIR (TJZS)") == ["SVZM", "TJZS"]


def test_a_page_without_a_czib_number_is_not_an_event(tmp_path):
    p = tmp_path / "x.html"
    p.write_text("<html><h1>Page not found</h1></html>", encoding="utf-8")
    assert B.parse(p) is None


history = pytest.mark.skipif(not (ROOT / "pipeline/events/sources.lock.json").exists() or not RAW.exists(), reason="raw EASA files not downloaded")


@history
def test_history_keeps_each_version_and_never_applies_a_later_one():
    out = B.build()
    b = next(x for x in out["bulletins"] if x["bulletinId"] == "2026-03")
    by = {r["revisionId"]: r for r in b["revisions"]}
    # the version in force in mid-March is R3 (valid until 18 March), not the latest R14
    assert by["R0"]["effectiveDate"] == "2026-02-28" and by["R0"]["validUntil"] == "2026-03-02"
    assert by["R4"]["effectiveDate"] == "2026-03-18" and by["R4"]["validUntil"] == "2026-03-27"
    assert by["R14"]["validUntil"] == "2026-07-08"
    assert all(r["issueDate"] == "2026-02-28" for r in b["revisions"])
    assert "R11" in b["missingRevisions"] and not b["historyComplete"]      # not reconstructed
    for r in b["revisions"]:
        assert r["sourceUrl"].startswith("https://www.easa.europa.eu/")
        assert r["captures"] and all(c["sha256"] and c["url"] for c in r["captures"])
        assert r["isClosure"] is False and r["kind"] == "safety-advisory"
        assert r["publicationTimestamp"] is None and r["validFrom"] is None   # unknown, not guessed
        assert r["firstSeenAt"].endswith("Z")
    assert out["rejected"] == []
    # the published file is the same build (records version)
    pub = json.loads((ROOT / "public/data/events/easa-czib-history.json").read_text(encoding="utf-8"))
    assert pub["recordsVersion"] == out["recordsVersion"]
