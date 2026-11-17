"""Regression tests for the per-airport continent rule (Phase 9F; bug found in Phase 9E)."""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

import research_web as W
from experiments import data as D

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ["id", "ourairports_id", "ident", "icao", "iata", "name", "city", "country", "continent", "type", "lat", "lon"]


def _csv(tmp_path: Path, rows: list[tuple[str, str, str]]) -> Path:
    p = tmp_path / "airports.csv"
    with p.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, FIELDS)
        w.writeheader()
        for i, (aid, country, cont) in enumerate(rows):
            w.writerow({"id": aid, "ourairports_id": i, "ident": aid, "country": country, "continent": cont})
    return p


def test_first_airport_does_not_decide_the_country(tmp_path):
    # Canary Islands first, as in OurAirports order: the old rule put all of Spain in Africa.
    p = _csv(tmp_path, [("GCLP", "ES", "AF"), ("GCXO", "ES", "AF"), ("LEMD", "ES", "EU"), ("LEBL", "ES", "EU"),
                        ("LEPA", "ES", "EU"), ("UUEE", "RU", "EU"), ("UHWW", "RU", "AS"), ("UNNT", "RU", "AS")])
    majority, exceptions, multi = W.continent_maps(p)
    assert majority == {"ES": "EU", "RU": "AS"}
    assert exceptions == {"GCLP": "AF", "GCXO": "AF", "UUEE": "EU"}
    assert multi == {"ES": {"AF": 2, "EU": 3}, "RU": {"AS": 2, "EU": 1}}


def test_majority_does_not_depend_on_row_order(tmp_path):
    rows = [("A1", "XX", "EU"), ("A2", "XX", "AS"), ("B1", "YY", "SA")]
    m1 = W.continent_maps(_csv(tmp_path, rows))
    m2 = W.continent_maps(_csv(tmp_path, list(reversed(rows))))
    assert m1 == m2
    assert m1[0]["XX"] == "AS"  # tie -> alphabetically first


def test_airport_continents_prefers_own_then_country_then_old_files():
    airports = [{"id": "GCLP", "country": "ES"}, {"id": "LEMD", "country": "ES"}, {"id": "ZZZZ", "country": "QQ"}]
    new = {"continents": {"ES": "EU"}, "airportContinents": {"GCLP": "AF"}, "continentRule": "airport-v1"}
    assert D.airport_continents(airports, new) == ["AF", "EU", ""]
    old = {"continents": {"ES": "AF"}}  # a pre-9F quality file: used as is
    assert D.airport_continents(airports, old) == ["AF", "AF", ""]


@pytest.mark.skipif(not (ROOT / "public/data/observed-2026-v2/research-web/quality.json").exists(), reason="dataset not present")
def test_published_quality_file_uses_airport_rule():
    q = json.loads((ROOT / "public/data/observed-2026-v2/research-web/quality.json").read_text(encoding="utf-8"))
    assert q["continentRule"] == W.CONTINENT_RULE
    assert q["continents"]["ES"] == "EU" and q["continents"]["RU"] == "AS"
    ds = D.load_dataset("observed-2026-v2")
    cont = dict(zip(ds.airport_ids, ds.continents))
    country = dict(zip(ds.airport_ids, ds.countries))
    # Canary Islands stay in Africa; mainland Spain is Europe; Russia keeps both
    assert cont.get("GCLP") == "AF" and cont.get("LEMD") == "EU" and cont.get("LEBL") == "EU"
    assert cont.get("UUEE") == "EU" and cont.get("UHWW") == "AS"
    assert all(cont[a] for a in ds.airport_ids if country[a])
    assert ds.continent_rule == "airport-v1"
