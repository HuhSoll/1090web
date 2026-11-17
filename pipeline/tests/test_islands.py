"""Island dependency lab (Phase 9F): geometry, road links, population, access model."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from islands import access as X
from islands import build as B
from islands import geo as G

ROOT = Path(__file__).resolve().parents[2]
PUB = ROOT / "public" / "data" / "islands" / "okinawa-pilot"


# ------------------------------------------------------------------ meshes and polygons

def test_mesh_codes_decode_to_the_standard_grid():
    s, w, dlat, dlon = G.mesh_bounds("37250159")      # 3rd level (1 km)
    assert (round(s, 6), round(w, 6)) == (round(37 / 1.5 + 0 * 5 / 60 + 5 * 30 / 3600, 6), round(125 + 1 * 7.5 / 60 + 9 * 45 / 3600, 6))
    assert (dlat, dlon) == (30 / 3600, 45 / 3600)
    s4, w4, d4, e4 = G.mesh_bounds("372501594")       # 4th level NE quadrant
    assert (s4, w4) == (s + 15 / 3600, w + 22.5 / 3600) and (d4, e4) == (15 / 3600, 22.5 / 3600)
    s5, w5, d5, e5 = G.mesh_bounds("3725015942")      # 5th level SE of the NE quadrant
    assert (s5, w5) == (s4, w4 + 11.25 / 3600) and d5 == 7.5 / 3600
    with pytest.raises(ValueError):
        G.mesh_bounds("372501595")


def _square(x0, y0, x1, y1):
    return G.Polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]])


def test_polygon_contains_with_hole_and_area():
    p = G.Polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]])
    got = p.contains(np.array([[0.1, 0.1], [0.5, 0.5], [1.5, 0.5]]))
    assert got.tolist() == [True, False, False]
    assert _square(125.0, 24.0, 125.01, 24.01).area_km2() == pytest.approx(1.01 * 1.11, rel=0.02)


def _mesh_row(code, pop):
    return {"code": code, "pop": pop, "suppressed": False}


def test_mesh_assignment_land_coast_and_sea():
    # island covering the west 60 % of mesh 3725015944 (250 m); another island far away
    s, w, dlat, dlon = G.mesh_bounds("3725015944")
    isl = _square(w - 0.01, s - 0.01, w + 0.6 * dlon, s + dlat + 0.01)
    other = _square(w + 1, s + 1, w + 1.1, s + 1.1)
    rows = [_mesh_row("3725015944", 10),            # centre inside? 0.5 < 0.6 -> centre on land
            _mesh_row("3725015943", 7)]             # the NW neighbour: inside too
    s2, w2, _, _ = G.mesh_bounds("3725015942")      # SE: west part only partly on land
    rows.append(_mesh_row("3725015942", 5))
    rows.append(_mesh_row("3725115944", 4))         # 9 km north, at sea
    B.assign_meshes(rows, [isl, other], {0: "a"})
    by = {r["code"]: r for r in rows}
    assert by["3725015944"]["island"] == "a"
    assert by["3725115944"]["island"] is None and by["3725115944"]["assignBasis"] == "sea"
    # no population is duplicated or dropped by the assignment
    assert sum(r["pop"] for r in rows) == 26
    assert all(r["island"] in ("a", None) for r in rows)


def test_mesh_centre_on_a_small_harbour_polygon_stays_on_the_island():
    s, w, dlat, dlon = G.mesh_bounds("3725015944")
    island = _square(w - 0.01, s - 0.01, w + dlon + 0.01, s + dlat + 0.01)
    # reclaimed land: a small separate polygon around the centre only (N03 keeps it apart)
    pier = _square(w + 0.45 * dlon, s + 0.45 * dlat, w + 0.55 * dlon, s + 0.55 * dlat)
    rows = [_mesh_row("3725015944", 13)]
    B.assign_meshes(rows, [pier, island], {1: "a"})   # the pier comes first and contains the centre
    # the point-in-polygon search gives each sample the first polygon containing it: the centre
    # lands on the pier, the 8 other samples on the island -> majority = island
    assert rows[0]["island"] == "a" and rows[0]["assignBasis"] == "majority"
    # a tie (as at Sonai, Yonaguni: 2 samples on the island, 2 on reclaimed land, 5 at sea) goes to
    # the pilot island, not to the polygon of the centre
    s2, w2, _, _ = G.mesh_bounds("3725015944")
    pier2 = _square(w2 + 0.05 * dlon, s2 + 0.3 * dlat, w2 + 0.6 * dlon, s2 + 0.6 * dlat)  # centre + 1 sample = 2
    isl2 = _square(w2 + 0.8 * dlon, s2 - 0.01, w2 + dlon + 0.01, s2 + 0.6 * dlat)          # 2 samples
    rows2 = [_mesh_row("3725015944", 13)]
    B.assign_meshes(rows2, [pier2, isl2], {1: "a"})
    assert rows2[0]["island"] == "a"


def test_mesh_on_coast_assigned_by_samples():
    s, w, dlat, dlon = G.mesh_bounds("3725015944")
    # land covers only the west 30 % of the mesh: the centre is at sea, samples decide
    isl = _square(w - 0.01, s - 0.01, w + 0.3 * dlon, s + dlat + 0.01)
    rows = [_mesh_row("3725015944", 3)]
    B.assign_meshes(rows, [isl], {0: "a"})
    assert rows[0]["island"] == "a" and rows[0]["assignBasis"] == "majority"


# ------------------------------------------------------------------ roads and bridges

def _roads(segments):
    """segments: list of (lon1, lat1, lon2, lat2); returns the dict load_roads would build."""
    key, xs, ys, s, t = {}, [], [], [], []

    def node(x, y):
        k = (round(x * 1e7), round(y * 1e7))
        if k not in key:
            key[k] = len(xs)
            xs.append(x)
            ys.append(y)
        return key[k]

    for x1, y1, x2, y2 in segments:
        s.append(node(x1, y1))
        t.append(node(x2, y2))
    x, y = np.array(xs), np.array(ys)
    s, t = np.array(s), np.array(t)
    length = G.haversine_m(x[s], y[s], x[t], y[t])
    return {"x": x, "y": y, "s": s, "t": t, "len": length, "min": length / (40 * 1000 / 60),
            "bridge": np.zeros(len(s), dtype=bool), "lines": [], "excluded": {}}


def test_bridge_between_islands_is_a_link_and_roads_do_not_cross_the_sea():
    a = _square(125.0, 24.0, 125.1, 24.1)
    b = _square(125.2, 24.0, 125.3, 24.1)
    islet = _square(125.14, 24.04, 125.16, 24.06)     # an islet under the bridge (not a pilot island)
    c = _square(125.5, 24.0, 125.6, 24.1)             # third island, no bridge
    roads = _roads([
        (125.02, 24.05, 125.09, 24.05),                # road on a
        (125.09, 24.05, 125.15, 24.05),                # bridge: a -> islet (crosses the sea)
        (125.15, 24.05, 125.21, 24.05),                # bridge: islet -> b
        (125.21, 24.05, 125.28, 24.05),                # road on b
        (125.52, 24.05, 125.58, 24.05),                # road on c
        (125.58, 24.05, 125.59, 24.12),                # coastal road leaving c and returning to c
        (125.59, 24.12, 125.58, 24.09),
    ])
    isl, link = B.road_islands(roads, [a, b, islet, c], {0: "a", 1: "b", 3: "c"})
    assert isl[0] == "a" and isl[3] == "b" and isl[5] == "c"
    assert link.tolist() == [False, True, True, False, False, False, False]
    from scipy.sparse.csgraph import connected_components
    _, comp_all = connected_components(B.road_graph(roads), directed=False)
    _, comp_cut = connected_components(B.road_graph(roads, link), directed=False)
    assert comp_all[0] == comp_all[3] != comp_all[5]      # the bridge joins a and b, never c
    assert comp_cut[0] != comp_cut[3]                    # without bridges a and b are apart


def test_snap_only_to_roads_of_the_same_island():
    roads = _roads([(125.0, 24.0, 125.001, 24.0), (125.01, 24.0, 125.011, 24.0)])
    isl = np.array(["a", "a", "b", "b"], dtype=object)
    v, d = B.snap(125.0095, 24.0, roads, isl, "a", 2000)
    assert v == 1                                         # the nearer node is on b: not used
    v2, _ = B.snap(125.0095, 24.0, roads, isl, "a", 50)
    assert v2 is None


# ------------------------------------------------------------------ access model (toy network)

def toy():
    """Islands: H (hub: destination), A (airport + port), B (airport only), C (port only, ferry to A),
    D (airport + bridge to A), E (no service at all). Durations in minutes."""
    gw = ["H", "AP_A", "PT_A", "AP_B", "PT_C", "AP_D", "AP_X"]
    g = [{"id": i, "kind": "airport" if i.startswith("AP") or i == "H" else "port", "island": None} for i in gw]
    services = [
        {"id": "A_HA", "mode": "air", "a": "H", "b": "AP_A", "durationMin": [60, 60], "roundTripsPerWeek": 14},
        {"id": "A_HB", "mode": "air", "a": "H", "b": "AP_B", "durationMin": [50, 70], "roundTripsPerWeek": 7},
        {"id": "S_AC", "mode": "sea", "a": "PT_A", "b": "PT_C", "durationMin": [30, 30], "roundTripsPerWeek": 21},
        {"id": "S_HC", "mode": "sea", "a": "H", "b": "PT_C", "durationMin": None, "roundTripsPerWeek": 1},
        {"id": "A_HD", "mode": "air", "a": "H", "b": "AP_D", "durationMin": [40, 40], "roundTripsPerWeek": 2},
        {"id": "A_HX", "mode": "air", "a": "H", "b": "AP_X", "durationMin": [10, 10], "roundTripsPerWeek": 7, "status": "suspended"},
        {"id": "A_SEAS", "mode": "air", "a": "H", "b": "AP_B", "durationMin": [5, 5], "roundTripsPerWeek": 7, "status": "seasonal"},
    ]
    i = {x: k for k, x in enumerate(gw)}
    road = {"withBridges": [[i["AP_A"], i["PT_A"], 10], [i["AP_A"], i["AP_D"], 20], [i["PT_A"], i["AP_D"], 25]],
            "noBridges": [[i["AP_A"], i["PT_A"], 10]]}
    net = {"gateways": g, "services": services, "roadLinks": road,
           "destinations": [{"id": "hub", "nodes": ["H"]}, {"id": "nowhere", "nodes": ["AP_X"]}],
           "assumptions": {"terminalMin": {"air": 30, "sea": 15},
                           "transferMin": {"air-air": 40, "air-sea": 60, "sea-air": 60, "sea-sea": 30}}}
    cols = ["code", "lat", "lon", "pop", "island", "basis", "snapM", "accessWith", "accessNo"]
    rows = [
        ["m_a", 0, 0, 100, "A", "centre", 10, [[i["AP_A"], 5], [i["PT_A"], 8], [i["AP_D"], 25]], [[i["AP_A"], 5], [i["PT_A"], 8]]],
        ["m_b", 0, 0, 50, "B", "centre", 10, [[i["AP_B"], 4]], [[i["AP_B"], 4]]],
        ["m_c", 0, 0, 30, "C", "centre", 10, [[i["PT_C"], 3]], [[i["PT_C"], 3]]],
        ["m_d", 0, 0, 20, "D", "centre", 10, [[i["AP_D"], 2], [i["AP_A"], 22]], [[i["AP_D"], 2]]],
        ["m_e", 0, 0, 7, "E", "centre", None, [], []],
        ["m_sea", 0, 0, 9, None, "sea", None, [], []],
    ]
    return net, {"columns": cols, "rows": rows}


def ev(sc=None, **kw):
    net, me = toy()
    res = X.evaluate(net, me, X.Scenario(**kw) if sc is None else sc)
    return {r[0]: e for r, e in zip(me["rows"], res)}


def test_base_access_statuses_and_times():
    e = ev(destination="hub")
    assert e["m_a"]["status"] == "ok" and e["m_a"]["time"] == 5 + 30 + 60
    assert e["m_b"]["time"] == 4 + 30 + 60 and e["m_b"]["path"] == ["A_HB"]   # seasonal excluded by default
    # C: the direct ferry has no duration -> the time route is ferry to A, road to D's airport, air
    # (2/week); it has more legs than the direct ferry, so its time is only a bound: time-unknown
    assert e["m_c"]["status"] == "time-unknown" and e["m_c"]["bound"] == 3 + 15 + 30 + 25 + 60 + 40
    assert e["m_d"]["time"] == 2 + 30 + 40
    assert e["m_e"]["status"] == "no-access"          # no road connection: cannot be computed
    assert e["m_sea"]["status"] == "unassigned"


def test_seasonal_and_suspended_services():
    e = ev(destination="hub", include_seasonal=True)
    assert e["m_b"]["time"] == 4 + 30 + 5
    assert ev(destination="nowhere")["m_a"]["status"] == "unreachable"      # suspended route


def test_service_level_daily_removes_rare_services():
    e = ev(destination="hub", service_level="daily")
    assert e["m_d"]["status"] == "ok" and e["m_d"]["board"] == "AP_A"       # 2/week flight dropped, bridge to A
    assert e["m_c"]["status"] == "ok"                                         # 1/week direct ferry dropped -> via A
    e2 = ev(destination="hub", service_level="daily", bridges=False)
    assert e2["m_d"]["status"] == "unreachable"


def test_single_multiple_and_no_airport_islands_when_the_airport_stops():
    net, me = toy()
    r = X.compare(net, me, X.Scenario(destination="hub"), X.Scenario(destination="hub", stopped_airports=["AP_A"]))
    by = {x[0]: x[5] for x in r["rows"]}
    assert by["m_a"] == "fewer-services" # A: same time over the bridge to D's airport, but 2/week instead of 14
    assert by["m_b"] == "same"
    assert by["m_c"] == "same"           # C reaches the hub through the bridge to D, not through A's airport
    assert by["m_d"] == "same"           # D keeps its own airport
    r2 = X.compare(net, me, X.Scenario(destination="hub", service_level="daily"),
                   X.Scenario(destination="hub", service_level="daily", stopped_airports=["AP_A"]))
    by2 = {x[0]: x[5] for x in r2["rows"]}
    assert by2["m_a"] == "lost" and by2["m_c"] == "lost"   # no daily alternative left
    assert by2["m_d"] == "lost"                          # D's own flight is 2/week (not daily)
    t = r2["totals"]["_all"]
    assert t["pop"] == 207 and t["lost"] == 150 and t["exposed"] == 150 and t["noAccess"] == 7


def test_airport_with_road_alternative_is_slower_not_lost():
    net, me = toy()
    r = X.compare(net, me, X.Scenario(destination="hub"), X.Scenario(destination="hub", stopped_airports=["AP_D"]))
    by = {x[0]: (x[3], x[4], x[5]) for x in r["rows"]}
    b, a, ch = by["m_d"]
    assert ch == "slower" and a["board"] == "AP_A" and a["time"] - b["time"] == (22 + 30 + 60) - (2 + 30 + 40)
    t = r["totals"]["D"]
    assert t["slower"] == 20 and t["personMinutes"] == 20 * 40 and t["meanDeltaMin"] == 40
    # the same population is compared before and after
    assert r["totals"]["_all"]["pop"] == 207


def test_mode_and_destination_sensitivity():
    assert ev(destination="hub", air=False)["m_a"]["status"] == "time-unknown"   # by sea via C, direct ferry unknown
    assert ev(destination="hub", air=False)["m_b"]["status"] == "unreachable"
    assert ev(destination="hub", sea=False)["m_c"]["status"] == "unreachable"
    assert ev(destination="nowhere")["m_b"]["status"] == "unreachable"


def test_change_categories():
    ok = lambda t, legs=1, f=7: {"status": "ok", "time": t, "legs": legs, "minFreq": f, "path": ["x"]}  # noqa: E731
    assert X.change(ok(10), {"status": "unreachable"}) == "lost"
    assert X.change(ok(10), ok(20)) == "slower"
    assert X.change(ok(10), ok(10, 2)) == "fewer-services"
    assert X.change(ok(10), ok(10, 1, 2)) == "fewer-services"
    assert X.change(ok(10), {"status": "time-unknown", "legs": 2, "minFreq": 1, "path": ["y"]}) == "undetermined"
    assert X.change({"status": "no-access"}, ok(1)) == "n/a"
    assert X.change({"status": "unreachable"}, {"status": "unreachable"}) == "same"


# ------------------------------------------------------------------ published data (real)

pub = pytest.mark.skipif(not (PUB / "meshes.json").exists(), reason="island data not built")


@pub
def test_published_population_is_complete_and_not_at_sea():
    meta = json.loads((PUB / "meta.json").read_text(encoding="utf-8"))
    me = json.loads((PUB / "meshes.json").read_text(encoding="utf-8"))
    c = {k: i for i, k in enumerate(me["columns"])}
    q = meta["quality"]
    assert sum(r[c["pop"]] for r in me["rows"]) == q["populationTotalInMeshFiles"]
    assert q["seaPopulation"] == 0
    assert q["populationByFirstLevelMesh"]["3725"] == 52931          # 宮古島市, 2020 census
    by = q["populationByIsland"]
    assert by["ishigaki"] == 47637                                    # 石垣市, 2020 census (one island)
    assert by["minamidaito"] == 1285 and by["yonaguni"] == 1676                # 与那国町, 2020 census
    assert len({r[c["code"]] for r in me["rows"]}) == len(me["rows"])  # no mesh twice


@pub
def test_published_bridges_join_only_the_bridged_islands():
    me = json.loads((PUB / "meshes.json").read_text(encoding="utf-8"))
    net = json.loads((PUB / "network.json").read_text(encoding="utf-8"))
    c = {k: i for i, k in enumerate(me["columns"])}
    gid = {g["id"]: i for i, g in enumerate(net["gateways"])}

    def gws(island, key):
        out = set()
        for r in me["rows"]:
            if r[c["island"]] == island:
                out |= {g for g, _ in r[c[key]]}
        return out

    assert gid["ROMY"] in gws("irabu", "accessWith") and gid["RORS"] in gws("miyako", "accessWith")
    assert not gws("irabu", "accessNo")                 # Irabu has no gateway of its own
    assert gid["ROMY"] not in gws("ishigaki", "accessWith")
    assert gws("tarama", "accessWith") == gws("tarama", "accessNo")
    assert gid["ROIG"] not in gws("iriomote", "accessWith")


@pub
def test_published_scenarios_match_the_known_structure():
    net = json.loads((PUB / "network.json").read_text(encoding="utf-8"))
    me = json.loads((PUB / "meshes.json").read_text(encoding="utf-8"))
    base, stop = X.Scenario(service_level="daily"), X.Scenario(service_level="daily", stopped_airports=["ROYN"])
    t = X.compare(net, me, base, stop)["totals"]
    assert t["yonaguni"]["lost"] == t["yonaguni"]["pop"] - t["yonaguni"]["noAccess"]   # ferry 2/week only
    assert t["ishigaki"]["exposed"] == 0
    t2 = X.compare(net, me, X.Scenario(), X.Scenario(stopped_airports=["RORS"]))["totals"]
    assert t2["irabu"]["slower"] == t2["irabu"]["pop"] and t2["irabu"]["lost"] == 0      # Miyako airport by bridge
    t3 = X.compare(net, me, X.Scenario(bridges=False), X.Scenario(bridges=False, stopped_airports=["RORS"]))["totals"]
    assert t3["shimoji"]["lost"] == t3["shimoji"]["pop"]                                  # without bridges: no alternative


@pub
def test_global_importance_matches_phase9e_baseline():
    g = PUB / "global.json"
    if not g.exists():
        pytest.skip("global.json not built")
    d = json.loads(g.read_text(encoding="utf-8"))
    by = {x["airport"]: x for x in d["airports"]}
    assert by["ROYN"]["observed"] is None                 # not in the ADS-B network
    assert by["ROIG"]["observed"]["of"] == 3883
    assert by["ROYN"]["augmented"]["spilloverDrop"] == pytest.approx(0, abs=1e-12)
