"""External validation (Phase 7) on small synthetic inputs - no official data is read."""

from __future__ import annotations

import csv
import io
import json
import math
import zipfile

import pytest

from validation import anac, bts, common, compare, japan
from validation.report import condition_grid

US = common.US_AND_TERRITORIES

# rec_id, canon, iata, local_code, icao, ident, gps_code, country
AIRPORTS = [
    ("1", "KBOS", "BOS", "BOS", "KBOS", "KBOS", "KBOS", "US"),
    ("2", "KJFK", "JFK", "JFK", "KJFK", "KJFK", "KJFK", "US"),
    ("3", "TJSJ", "SJU", "SJU", "TJSJ", "TJSJ", "TJSJ", "PR"),      # territory: T-100 says "US"
    ("4", "EGLL", "LHR", "", "EGLL", "EGLL", "EGLL", "GB"),
    ("5", "K1B1", "", "1B1", "", "K1B1", "K1B1", "US"),             # FAA LID only
    ("6", "YBOS", "BOS", "", "YBOS", "YBOS", "", "AU"),             # same IATA, other country
    ("7", "XXA1", "DUP", "", "XXA1", "XXA1", "", "BR"),             # duplicated IATA in one country
    ("8", "XXA2", "DUP", "", "XXA2", "XXA2", "", "BR"),
]


@pytest.fixture()
def resolver():
    cols = ["rec_id", "canon", "iata", "local_code", "icao", "ident", "gps_code", "country"]
    return common.AirportResolver.from_rows(dict(zip(cols, a)) for a in AIRPORTS)


# ---- airport codes ----------------------------------------------------------------------------

def test_airport_code_matching(resolver):
    assert resolver.resolve("BOS", US).canon == "KBOS"            # country decides between two BOS
    assert resolver.resolve("BOS", "AU").canon == "YBOS"
    assert resolver.resolve("SJU", US).canon == "TJSJ"            # territory reported as US
    assert resolver.resolve("1B1", US) == common.Resolution("K1B1", "faa_lid")
    assert resolver.resolve("EGLL").canon == "EGLL"               # ICAO
    assert resolver.resolve("LHR", US).canon is None              # a foreign IATA code is never used for "US"
    amb = resolver.resolve("DUP", "BR")
    assert amb.canon is None and amb.method == "ambiguous"        # two records: excluded, not guessed
    assert resolver.resolve("ZZZ", US).method == "unresolved"
    assert resolver.resolve("BOS").method == "ambiguous"          # no country: BOS is not unique


def ext(o, d, n, cls="F", ym=(2026, 1), carrier="AA", oc=US, dc=US):
    return common.ExternalCount(source="T", year=ym[0], month=ym[1], origin_airport=o, destination_airport=d,
                                service_class=cls, reported_flights=n, carrier=carrier,
                                origin_country=oc, destination_country=dc)


def test_resolution_exclusions_and_monthly_sums(resolver):
    recs = [ext("BOS", "JFK", 10), ext("BOS", "JFK", 5, ym=(2026, 1)), ext("BOS", "JFK", 7, ym=(2026, 2)),
            ext("JFK", "BOS", 3, cls="G"), ext("BOS", "ZZZ", 4), ext("BOS", "BOS", 2),
            ext("DUP", "BOS", 1, oc="BR")]
    counts, by_car, excl = compare.resolve_external(recs, resolver)
    assert counts == {("2026-01", "KBOS", "KJFK"): 15, ("2026-02", "KBOS", "KJFK"): 7, ("2026-01", "KJFK", "KBOS"): 3}
    assert excl["airport_unresolved"] == {"rows": 1, "flights": 4}
    assert excl["airport_ambiguous"] == {"rows": 1, "flights": 1}
    assert excl["same_airport_after_resolution"] == {"rows": 1, "flights": 2}
    # class and month filters are scope, not exclusions
    c2, _, ex2 = compare.resolve_external(recs, resolver, classes=("G",), months=["2026-01"])
    assert c2 == {("2026-01", "KJFK", "KBOS"): 3}
    assert by_car["AA"][("2026-01", "KBOS", "KJFK")] == 15


def test_directed_and_undirected_aggregation():
    rows = [("2026-01", "A", "B", "X1", "passenger", "T1_track", 5),
            ("2026-01", "B", "A", "X1", "passenger", "T4_callsign_only", 3),
            ("2026-01", "A", "A", "X1", "passenger", "T1_track", 9),     # self-loop ignored
            ("2026-02", "A", "B", "X2", "cargo", "T2_track_conflict", 2)]
    d = compare.observed_counts(rows)
    assert d == {("2026-01", "A", "B"): 5, ("2026-01", "B", "A"): 3, ("2026-02", "A", "B"): 2}
    assert compare.undirected(d) == {("2026-01", "A", "B"): 8, ("2026-02", "A", "B"): 2}
    assert compare.observed_counts(rows, tiers=compare.TIER_SETS["T1"]) == {("2026-01", "A", "B"): 5}
    assert compare.observed_counts(rows, airlines={"X2"}) == {("2026-02", "A", "B"): 2}
    assert compare.observed_counts(rows, months=["2026-02"], classes={"cargo"}) == {("2026-02", "A", "B"): 2}


# ---- service classes and files ---------------------------------------------------------------------

def bts_zip(path, rows, year=2026, month=1):
    buf = io.StringIO()
    cols = ["YEAR", "MONTH", "ORIGIN", "DEST", "ORIGIN_COUNTRY", "DEST_COUNTRY", "UNIQUE_CARRIER", "CLASS",
            "DEPARTURES_PERFORMED", "AIRCRAFT_CONFIG", "DATA_SOURCE", "CARRIER_GROUP_NEW"]
    w = csv.DictWriter(buf, cols)
    w.writeheader()
    for r in rows:
        w.writerow({"YEAR": year, "MONTH": month, "ORIGIN_COUNTRY": "US", "DEST_COUNTRY": "US", "UNIQUE_CARRIER": "AA",
                    "AIRCRAFT_CONFIG": "1", "DATA_SOURCE": "DU", "CARRIER_GROUP_NEW": "3", **r})
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("T_T100_SEGMENT_ALL_CARRIER.csv", buf.getvalue())
        z.writestr("Documentation.csv", "x")
    return path


def test_service_classes_and_zero_departures(tmp_path, resolver):
    p = bts_zip(tmp_path / "t.zip", [
        {"ORIGIN": "BOS", "DEST": "JFK", "CLASS": "F", "DEPARTURES_PERFORMED": "10.00"},
        {"ORIGIN": "BOS", "DEST": "JFK", "CLASS": "G", "DEPARTURES_PERFORMED": "2.00"},
        {"ORIGIN": "BOS", "DEST": "JFK", "CLASS": "L", "DEPARTURES_PERFORMED": "1.00"},
        {"ORIGIN": "JFK", "DEST": "BOS", "CLASS": "F", "DEPARTURES_PERFORMED": "0.00"},   # scheduled, not flown
        {"ORIGIN": "BOS", "DEST": "JFK", "CLASS": "Z", "DEPARTURES_PERFORMED": "13.00"},  # aggregate class
    ])
    recs = bts.read_zip(p)
    assert sorted(r.service_class for r in recs) == ["F", "F", "G", "L"]       # Z never mixed in
    sched, _, _ = compare.resolve_external(recs, resolver, bts.CLASS_SETS["scheduled"])
    allr, _, _ = compare.resolve_external(recs, resolver, bts.CLASS_SETS["all_reported"])
    assert sched[("2026-01", "KBOS", "KJFK")] == 12 and allr[("2026-01", "KBOS", "KJFK")] == 13
    # a route with 0 departures performed is not a reported route at threshold 1
    c = compare.compare_routes({("2026-01", "KJFK", "KBOS"): 4}, allr, 1)
    assert c["only_observed"] == 1 and c["only_reported"] == 1 and c["both"] == 0


def test_zip_with_other_periods_is_refused(tmp_path):
    p = bts_zip(tmp_path / "t.zip", [{"ORIGIN": "BOS", "DEST": "JFK", "CLASS": "F", "DEPARTURES_PERFORMED": "1"}],
                month=2)
    with pytest.raises(ValueError, match="expected"):
        bts.check_zip(p, 2026, 1)          # a February file can never be used as January
    bts.check_zip(p, 2026, 2)


# ---- metrics -------------------------------------------------------------------------------------

def test_error_metrics_by_hand():
    pairs = [(12, 10), (8, 10), (0, 5), (30, 20)]
    m = common.error_metrics(pairs, min_base=10)
    assert m["n"] == 4 and m["sum_observed"] == 50 and m["sum_reported"] == 45
    assert m["MAE"] == (2 + 2 + 5 + 10) / 4
    assert m["RMSE"] == round(math.sqrt((4 + 4 + 25 + 100) / 4), 4)
    assert m["WAPE"] == round(19 / 45, 4) and m["bias"] == round(50 / 45 - 1, 4)
    assert m["rel_error_n"] == 3                      # the pair with b = 5 is below min_base
    assert m["rel_error_median"] == 0.2               # [-0.2, 0.2, 0.5]
    assert m["share_within_25pct"] == round(2 / 3, 4)


def test_metrics_zero_and_small_samples():
    assert common.rel_error(5, 0) is None and common.rel_error(5, 3) is None
    assert common.error_metrics([]) == {"n": 0}
    m = common.error_metrics([(1, 0), (0, 0)])
    assert m["WAPE"] is None and m["bias"] is None and m["pearson"] is None
    assert common.error_metrics([(1, 1), (2, 2)])["spearman"] is None   # fewer than 3 items


def test_route_comparison_thresholds_and_missing_routes():
    obs = {("m", "A", "B"): 40, ("m", "A", "C"): 3, ("m", "A", "D"): 12}
    rep = {("m", "A", "B"): 50, ("m", "A", "C"): 20, ("m", "A", "E"): 15}
    c1 = compare.compare_routes(obs, rep, 1)
    assert (c1["both"], c1["only_observed"], c1["only_reported"]) == (2, 1, 1)
    c10 = compare.compare_routes(obs, rep, 10)
    # A-C: reported 20, observed 3 -> in the reported set only, but NOT 'absent' (observed > 0)
    assert c10["only_reported"] == 2 and c10["reported_routes_absent_in_observed"] == 1
    assert c10["observed_routes_absent_in_reported"] == 1                # A-D
    assert c10["volume"]["n"] == 3 and c10["volume"]["sum_observed"] == 43
    assert common.set_overlap({1, 2}, {2, 3}) == {"both": 1, "only_observed": 1, "only_reported": 1, "jaccard": 0.3333,
                                                  "share_reported_found": 0.5, "share_observed_confirmed": 0.5}


def test_support_rate_and_airport_movements():
    obs = {("m", "A", "B"): 6, ("m", "A", "C"): 4}
    rep = {("m", "A", "B"): 1}
    assert compare.route_support_rate(obs, rep) == {"observed_flights": 10, "on_reported_routes": 6, "support_rate": 0.6}
    assert compare.airport_movements(obs) == {("m", "A"): 10, ("m", "B"): 6, ("m", "C"): 4}


def test_carrier_crosswalk():
    k = lambda o, d: ("2026-01", o, d)  # noqa: E731
    observed = {"ABC": {k("A", "B"): 100, k("B", "C"): 100, k("C", "D"): 50},
                "BIZ": {k("A", "X"): 150, k("Y", "Z"): 150},           # operator that does not report
                "TINY": {k("A", "B"): 5}}
    reported = {"AB": {k("A", "B"): 95, k("B", "C"): 105, k("C", "D"): 45}, "CD": {k("A", "B"): 10}}
    cw = {x["airline"]: x for x in compare.carrier_crosswalk(observed, reported, min_flights=100)}
    assert cw["ABC"]["status"] == "matched" and cw["ABC"]["carrier"] == "AB"
    assert cw["BIZ"]["status"] == "unmatched" and cw["BIZ"]["carrier"] == ""
    assert "TINY" not in cw                                             # below min_flights: not assessed
    assert compare.carrier_crosswalk(observed, reported, min_flights=100) == list(cw.values())  # deterministic


# ---- registry / hashes -----------------------------------------------------------------------------

def test_registry_hash_verification(tmp_path):
    reg = tmp_path / "lock.json"
    f = tmp_path / "data.csv"
    f.write_text("a,b\n1,2\n", encoding="utf-8")
    e = common.register(f, source="S", url="https://example.org/x", retrieved="2026-11-11T00:00:00Z", registry_path=reg)
    assert e["sha256"] == common.sha256_file(f) and e["bytes"] == f.stat().st_size
    assert common.verify(f, reg)["url"] == "https://example.org/x"
    f.write_text("a,b\n1,3\n", encoding="utf-8")
    with pytest.raises(common.HashMismatch):
        common.verify(f, reg)
    other = tmp_path / "other.csv"
    other.write_text("x", encoding="utf-8")
    with pytest.raises(common.HashMismatch, match="not registered"):
        common.verify(other, reg)


# ---- conditions and reproducibility ----------------------------------------------------------------

def test_condition_grid_records_conditions_and_is_reproducible():
    obs = {t: {("2026-01", "A", "B"): 10, ("2026-02", "A", "B"): 12} for t in compare.TIER_SETS}
    rep = {"x_carrier_matched": {("2026-01", "A", "B"): 11, ("2026-02", "A", "B"): 12}}
    g1 = condition_grid(None, source="S", months=["2026-01", "2026-02"], reported_sets=rep,
                        observed_sets={"carrier_matched": obs}, scope_name="test")
    g2 = condition_grid(None, source="S", months=["2026-01", "2026-02"], reported_sets=rep,
                        observed_sets={"carrier_matched": obs}, scope_name="test")
    assert g1 == g2
    # 3 month sets (2 months + all) x 4 tier sets x 2 directions x 4 thresholds
    assert len(g1) == 3 * 4 * 2 * 4
    row = next(r for r in g1 if r["months"] == "all" and r["min_flights"] == 1 and r["direction"] == "directed"
               and r["tiers"] == "T1")
    for key in ("source", "scope", "months", "reported", "observed", "tiers", "direction", "min_flights", "vol_n"):
        assert key in row
    assert row["vol_sum_observed"] == 22 and row["vol_sum_reported"] == 23
    # mismatched scopes are never paired
    g3 = condition_grid(None, source="S", months=["2026-01"], reported_sets={"x": rep["x_carrier_matched"]},
                        observed_sets={"carrier_matched": obs}, scope_name="test")
    assert g3 == []


# ---- ANAC and MLIT parsers ----------------------------------------------------------------------------

def test_anac_parsers(tmp_path):
    vra = tmp_path / "VRA_20261.csv"
    vra.write_text(
        "﻿Atualizado em: 2026-10-28\n"
        '"ICAO Empresa Aérea";"Número Voo";"Código Autorização (DI)";"Código Tipo Linha";"ICAO Aeródromo Origem";'
        '"ICAO Aeródromo Destino";"Partida Prevista";"Partida Real";"Chegada Prevista";"Chegada Real";"Situação Voo";'
        '"Código Justificativa"\n'
        '"GLO";"1";"0";"N";"SBGL";"SBSV";"2026-01-04 16:15:00";"2026-01-04 16:18:00";"";"";"REALIZADO";"N/A"\n'
        '"GLO";"1";"0";"N";"SBGL";"SBSV";"2026-01-05 16:15:00";"";"";"";"CANCELADO";"XX"\n'
        '"GLO";"1";"0";"N";"SBGL";"SBSV";"2026-01-31 23:50:00";"2026-02-01 00:10:00";"";"";"REALIZADO";"N/A"\n',
        encoding="utf-8")
    recs = anac.read_vra(vra)
    assert [(r.ym, r.reported_flights) for r in recs] == [("2026-01", 1), ("2026-02", 1)]  # cancelled not counted
    stats = tmp_path / "s.csv"
    stats.write_text(
        "﻿Atualizado em: 2026-11-10\n"
        '"EMPRESA_SIGLA";"ANO";"MES";"AEROPORTO_DE_ORIGEM_SIGLA";"AEROPORTO_DE_DESTINO_SIGLA";"NATUREZA";'
        '"GRUPO_DE_VOO";"DECOLAGENS";"EMPRESA_NACIONALIDADE"\n'
        '"GLO";"2026";"1";"SBGL";"SBSV";"DOMÉSTICA";"REGULAR";"30";"BRASILEIRA"\n'
        '"GLO";"2026";"1";"SBGL";"SBSV";"DOMÉSTICA";"IMPRODUTIVO";"2";"BRASILEIRA"\n'
        '"GLO";"2025";"1";"SBGL";"SBSV";"DOMÉSTICA";"REGULAR";"99";"BRASILEIRA"\n', encoding="utf-8")
    s = anac.read_stats(stats, 2026)
    assert sorted((r.service_class, r.reported_flights) for r in s) == [("DOMÉSTICA/IMPRODUTIVO", 2), ("DOMÉSTICA/REGULAR", 30)]
    assert all(r.source_version.endswith("2026-11-10") for r in s)


def test_mlit_flash_reader(tmp_path):
    p = tmp_path / "f.xlsx"
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    strings = ["運航回数", "回"]
    cells = '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' + "".join(
        f'<c r="{c}1"><v>{v}</v></c>' for c, v in zip("CDEFG", [73905, 19954, 53951, 154, 11929]))
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'
                                      f'<sheet name="３－１" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                   'relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{ns}">' + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{ns}"><sheetData><row r="1">{cells}</row>'
                                               "</sheetData></worksheet>")
    assert japan.national_flights(p) == {"domestic_scheduled": 73905, "domestic_scheduled_trunk": 19954,
                                         "domestic_scheduled_local": 53951, "domestic_other": 154, "international": 11929}
    assert json.dumps(japan.read_xlsx(p), ensure_ascii=False)


# ---- research data release manifest -------------------------------------------------------------

def test_release_manifest_verification(tmp_path):
    import release
    f = tmp_path / "public" / "data" / "ds" / "research" / "routes_monthly.parquet"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"PAR1 synthetic")
    m = {"files": [{"path": "public/data/ds/research/routes_monthly.parquet", "bytes": f.stat().st_size,
                    "sha256": common.sha256_file(f)}]}
    assert release.verify("ds", m, root=tmp_path) == []
    f.write_bytes(b"PAR1 changed!!")
    assert release.verify("ds", m, root=tmp_path) == ["hash mismatch: public/data/ds/research/routes_monthly.parquet"]
    f.unlink()
    assert release.verify("ds", m, root=tmp_path) == ["missing: public/data/ds/research/routes_monthly.parquet"]
    assert release.tag_for("observed-2026-v2", "2.0.0") == "research-observed-2026-v2-v2.0.0"
