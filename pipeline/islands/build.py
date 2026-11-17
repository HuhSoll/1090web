"""
Build the island lab files for the browser (Phase 9F).

  python pipeline/islands/fetch.py
  python pipeline/islands/build.py [--region okinawa-pilot]

Inputs: data/raw/islands/ (see fetch.py) and pipeline/islands/<region>.json.
Outputs: public/data/islands/<region>/
  meta.json      sources, assumptions, data quality, observed (ADS-B) vs official services
  network.json   gateways (airports, ports, port groups), services, road links between gateways
  meshes.json    inhabited 250 m meshes: population (2020), island, road access to each gateway
                 (with and without the bridges between islands)
  geo.json       simplified island outlines and roads for the map
Intermediate checks are printed; failures (an island point outside every polygon, a gateway
without road access, a population total that does not add up) stop the build.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import geo  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "islands"
HERE = Path(__file__).resolve().parent
SCHEMA_VERSION = 1
BUILD_VERSION = "9f.1"
POP_FIELD = "T001142001"  # 人口（総数）
GATEWAY_MAX_M = 3000      # airport reference points are runway centres


def load_config(region: str) -> dict:
    return json.loads((HERE / f"{region}.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- land polygons

def load_land(cfg: dict) -> tuple[list[geo.Polygon], list[dict]]:
    """N03 polygons of the municipalities of the region (each feature is one land polygon)."""
    munis = {i["municipality"] for i in cfg["islands"]}
    with zipfile.ZipFile(RAW / "ksj" / "N03-20260101_47_GML.zip") as z:
        name = next(n for n in z.namelist() if n.endswith(".geojson"))
        g = json.loads(z.read(name).decode("utf-8"))
    polys, props = [], []
    for f in g["features"]:
        p = f["properties"]
        if p.get("N03_007") not in munis:
            continue
        geom = f["geometry"]
        parts = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for part in parts:
            polys.append(geo.Polygon(part))
            props.append({"municipality": p["N03_007"], "name": p.get("N03_004")})
    return polys, props


def identify_islands(cfg: dict, polys: list[geo.Polygon]) -> dict[int, str]:
    out = {}
    for isl in cfg["islands"]:
        pt = np.array([[isl["rep"][1], isl["rep"][0]]])
        hits = [i for i, p in enumerate(polys) if p.contains(pt)[0]]
        if len(hits) != 1:
            raise SystemExit(f"island {isl['id']}: representative point is in {len(hits)} polygons")
        if hits[0] in out:
            raise SystemExit(f"islands {out[hits[0]]} and {isl['id']} share a polygon")
        out[hits[0]] = isl["id"]
    return out


def locate(points: np.ndarray, polys: list[geo.Polygon]) -> np.ndarray:
    """Index of the land polygon containing each point, -1 at sea."""
    res = np.full(len(points), -1, dtype=np.int64)
    for i, p in enumerate(polys):
        free = res < 0
        if not free.any():
            break
        hit = p.contains(points[free])
        idx = np.where(free)[0][hit]
        res[idx] = i
    return res


# ---------------------------------------------------------------- population

def load_population(cfg: dict, stats: str = "T001142") -> list[dict]:
    meshes = sorted({f.split("_")[1].split(".")[0] for f in (p.name for p in (RAW / "estat").glob(f"{stats}_*.zip"))})
    rows = []
    for m in meshes:
        with zipfile.ZipFile(RAW / "estat" / f"{stats}_{m}.zip") as z:
            text = z.read(z.namelist()[0]).decode("cp932")
        r = csv.reader(io.StringIO(text))
        header = next(r)
        next(r)  # Japanese labels
        ci = header.index(stats + "001")
        for rec in r:
            if not rec or not rec[0]:
                continue
            v = rec[ci]
            rows.append({"code": rec[0], "pop": int(v) if v.isdigit() else None, "raw": v,
                         "suppressed": rec[1] in ("1", "2"), "mergedInto": rec[2] or None})
    return rows


def assign_meshes(rows: list[dict], polys, poly_island: dict[int, str]) -> None:
    """Island of each mesh: the land polygon holding most of its 9 sample points (ties: a pilot island,
    then the polygon of the centre, then the lower index). A mesh with no sample on land is at sea.

    The majority rule (not the centre alone) keeps a mesh on its island when the centre happens to
    fall on a small separate polygon such as reclaimed land in a harbour (Sonai, Yonaguni)."""
    samples = np.concatenate([geo.mesh_samples(r["code"]) for r in rows])
    loc = locate(samples, polys).reshape(len(rows), 9)
    for r, l in zip(rows, loc):
        c = Counter(int(x) for x in l if x >= 0)
        if not c:
            pi, basis = -1, "sea"
        else:
            centre = int(l[4])
            # ties: a pilot island first (two polygons in one 250 m mesh are the same place, e.g. a
            # harbour), then the polygon of the centre, then the lower index
            pi = sorted(c.items(), key=lambda kv: (-kv[1], kv[0] not in poly_island, kv[0] != centre, kv[0]))[0][0]
            basis = "centre" if pi == centre and c[pi] == 9 else "majority"
        r["polygon"] = pi
        r["island"] = poly_island.get(pi) if pi >= 0 else None
        r["landPolygon"] = pi >= 0
        r["assignBasis"] = basis
        s, w, dlat, dlon = geo.mesh_bounds(r["code"])
        r["lat"], r["lon"] = s + dlat / 2, w + dlon / 2


# ---------------------------------------------------------------- roads

EXCLUDED_TYPES = {"2", "3", "4"}  # 庭園路, 徒歩道, 石段
EXCLUDED_STATE = {"5"}            # 建設中


def load_roads(cfg: dict) -> dict:
    speeds = {k: float(v) for k, v in cfg["assumptions"]["roadSpeedKmhByWidth"].items()}
    key_of: dict[tuple[int, int], int] = {}
    xs, ys = [], []
    es, et, el, ev, eb = [], [], [], [], []
    lines = []
    excluded = Counter()

    def node(lon, lat):
        k = (round(lon * 1e7), round(lat * 1e7))
        i = key_of.get(k)
        if i is None:
            i = key_of[k] = len(xs)
            xs.append(lon)
            ys.append(lat)
        return i

    for f in sorted((RAW / "ksj").glob("N13-24_*_GEOJSON.zip")):
        with zipfile.ZipFile(f) as z:
            name = next(n for n in z.namelist() if n.endswith(".geojson"))
            g = json.loads(z.read(name).decode("utf-8"))
        for feat in g["features"]:
            p = feat["properties"]
            if p["N13_002"] in EXCLUDED_TYPES or p["N13_004"] in EXCLUDED_STATE:
                excluded[(p["N13_002"], p["N13_004"])] += 1
                continue
            coords = feat["geometry"]["coordinates"]
            parts = coords if feat["geometry"]["type"] == "MultiLineString" else [coords]
            sp = speeds.get(p["N13_006"], speeds["6"])
            bridge = p["N13_004"] == "2"
            for part in parts:
                ids = [node(c[0], c[1]) for c in part]
                lines.append({"nodes": ids, "width": p["N13_006"], "bridge": bridge})
                for a, b in zip(ids[:-1], ids[1:]):
                    if a == b:
                        continue
                    es.append(a)
                    et.append(b)
                    ev.append(sp)
                    eb.append(bridge)
    x, y = np.array(xs), np.array(ys)
    s, t = np.array(es), np.array(et)
    length = geo.haversine_m(x[s], y[s], x[t], y[t])
    minutes = length / (np.array(ev) * 1000 / 60)
    return {"x": x, "y": y, "s": s, "t": t, "len": length, "min": minutes, "bridge": np.array(eb), "lines": lines,
            "excluded": {f"type{k[0]}-state{k[1]}": v for k, v in excluded.items()}}


def road_islands(roads: dict, polys, poly_island) -> tuple[np.ndarray, np.ndarray]:
    """Island of each road node and a mask of the edges that link two islands.

    A node's island is the pilot island it lies in, "_other" on other land (islets, some of them
    under bridges), None at sea (bridges, causeways, and a few coastal vertices just outside the
    outline). Links are found from the geometry, not from the
    bridge attribute (long bridges such as Irabu Ohashi are not coded as bridges along their whole
    length): every chain of edges that touches a sea node, and every edge whose two land ends are
    on different islands, is a link when its land ends belong to two or more islands. A sea chain
    that returns to the same island (a coastal road) is not a link.
    """
    n = len(roads["x"])
    pts = np.column_stack([roads["x"], roads["y"]])
    loc = locate(pts, polys)
    isl = np.array([poly_island.get(int(p), "_other") if p >= 0 else None for p in loc], dtype=object)
    s, t = roads["s"], roads["t"]
    # sea, and land outside the pilot islands (islets under a bridge), count as "between islands"
    sea = np.array([v is None or v == "_other" for v in isl])
    sea_edge = sea[s] | sea[t]
    link = np.zeros(len(s), dtype=bool)
    # direct edges between two islands
    both_land = ~sea_edge
    link[both_land] = isl[s[both_land]] != isl[t[both_land]]
    # chains through the sea
    es, et = s[sea_edge], t[sea_edge]
    _, comp = connected_components(coo_matrix((np.ones(len(es)), (es, et)), shape=(n, n)), directed=False)
    ends: dict[int, set] = defaultdict(set)
    for a, b in zip(es, et):
        for v in (a, b):
            if not sea[v]:
                ends[comp[v]].add(isl[v])
    linking = {c for c, e in ends.items() if len(e) >= 2}
    if linking:
        link[np.where(sea_edge)[0][np.isin(comp[es], list(linking))]] = True
    return isl, link


def road_graph(roads: dict, drop: np.ndarray | None = None):
    n = len(roads["x"])
    keep = np.ones(len(roads["s"]), dtype=bool) if drop is None else ~drop
    s, t, w = roads["s"][keep], roads["t"][keep], roads["min"][keep]
    return coo_matrix((np.concatenate([w, w]), (np.concatenate([s, t]), np.concatenate([t, s]))), shape=(n, n)).tocsr()


def snap(lon: float, lat: float, roads: dict, node_isl: np.ndarray, island: str | None, max_m: float):
    cand = np.where(node_isl == island)[0] if island is not None else np.arange(len(roads["x"]))
    if len(cand) == 0:
        return None, None
    d = geo.haversine_m(lon, lat, roads["x"][cand], roads["y"][cand])
    k = int(np.argmin(d))
    return (int(cand[k]), float(d[k])) if d[k] <= max_m else (None, float(d[k]))


# ---------------------------------------------------------------- observed (ADS-B) services

def observed_services(cfg: dict, month: str = "2026-03") -> dict[tuple[str, str], dict]:
    import duckdb
    f = ROOT / "data" / "research" / "observed-2026-v2" / "temporal" / f"flights_{month}.parquet"
    ids = [a["id"] for a in cfg["airports"]]
    q = f"""SELECT originAirport o, destinationAirport d, count(*) n FROM read_parquet('{f.as_posix()}')
            WHERE onMap AND originAirport IN ({",".join("'" + i + "'" for i in ids)})
              AND destinationAirport IN ({",".join("'" + i + "'" for i in ids)}) GROUP BY ALL"""
    days = int(month[5:]) and 31
    out = {}
    for o, d, n in duckdb.sql(q).fetchall():
        k = tuple(sorted((o, d)))
        e = out.setdefault(k, {"flights": 0, "byDirection": {}})
        e["flights"] += n
        e["byDirection"][f"{o}-{d}"] = n
    for e in out.values():
        e["roundTripsPerWeek"] = round(min(e["byDirection"].values()) / days * 7, 2) if len(e["byDirection"]) == 2 else 0.0
    return out


# ---------------------------------------------------------------- build

def build(region: str) -> dict:
    cfg = load_config(region)
    out_dir = ROOT / "public" / "data" / "islands" / region
    out_dir.mkdir(parents=True, exist_ok=True)
    A = cfg["assumptions"]

    polys, pprops = load_land(cfg)
    poly_island = identify_islands(cfg, polys)
    print(f"land polygons: {len(polys)}; pilot islands: {len(poly_island)}")

    rows = load_population(cfg)
    pop_total = sum(r["pop"] or 0 for r in rows)
    assign_meshes(rows, polys, poly_island)
    inhabited = [r for r in rows if (r["pop"] or 0) > 0]
    missing_values = [r for r in rows if r["pop"] is None]
    print(f"meshes: {len(rows)} ({len(inhabited)} inhabited, {len(missing_values)} without a total), population {pop_total}")

    roads = load_roads(cfg)
    node_isl, link = road_islands(roads, polys, poly_island)
    print(f"road nodes {len(roads['x'])}, edges {len(roads['s'])}, inter-island link edges {int(link.sum())}")

    # gateways
    island_ids = {i["id"] for i in cfg["islands"]}
    gateways = []
    for a in cfg["airports"]:
        gateways.append({"id": a["id"], "kind": "airport", "iata": a["iata"], "nameJa": a["nameJa"], "nameEn": a["nameEn"],
                         "island": a["island"], "lat": a["lat"], "lon": a["lon"]})
    for p in cfg["ports"]:
        gateways.append({"id": p["id"], "kind": "port", "nameJa": p["nameJa"], "nameEn": p["nameEn"], "island": p["island"],
                         "lat": p["lat"], "lon": p["lon"], "osm": p.get("osm"), "note": p.get("note")})
    for gid, members in cfg["portGroups"].items():
        ms = [next(g for g in gateways if g["id"] == m) for m in members]
        gateways.append({"id": gid, "kind": "portGroup", "members": members, "island": ms[0]["island"],
                         "nameJa": " / ".join(m["nameJa"] for m in ms), "nameEn": " / ".join(m["nameEn"] for m in ms),
                         "lat": float(np.mean([m["lat"] for m in ms])), "lon": float(np.mean([m["lon"] for m in ms]))})
    gidx = {g["id"]: i for i, g in enumerate(gateways)}

    # snap gateways on pilot islands to the road network
    gw_node = {}
    for g in gateways:
        if g["kind"] == "portGroup" or g["island"] not in island_ids:
            continue
        v, d = snap(g["lon"], g["lat"], roads, node_isl, g["island"], GATEWAY_MAX_M)
        if v is None:
            raise SystemExit(f"gateway {g['id']} has no road within {GATEWAY_MAX_M} m on {g['island']} (nearest {d})")
        gw_node[g["id"]] = (v, d)
        g["roadSnapM"] = round(d)
    conn_min = lambda m: m / (A["connectorKmh"] * 1000 / 60)  # noqa: E731

    variants = {"withBridges": road_graph(roads), "noBridges": road_graph(roads, link)}
    road_gw = [g for g in gateways if g["id"] in gw_node]
    times = {}
    for name, G in variants.items():
        src = [gw_node[g["id"]][0] for g in road_gw]
        D = dijkstra(G, directed=False, indices=src)
        times[name] = {g["id"]: D[i] + conn_min(gw_node[g["id"]][1]) for i, g in enumerate(road_gw)}

    def group_time(name: str, gid: str, at: np.ndarray | int):
        g = gateways[gidx[gid]]
        if g["kind"] != "portGroup":
            return times[name][gid][at] if gid in times[name] else np.inf
        vals = [times[name][m][at] for m in g["members"]]
        vals = [v for v in vals if np.isfinite(v)]
        return max(vals) if vals else np.inf  # farthest berth (portGroupRule)

    # road links between gateways (same road component)
    road_links = {}
    for name in variants:
        links = []
        ids_on_road = [g["id"] for g in gateways if g["island"] in island_ids]
        for i, a in enumerate(ids_on_road):
            for b in ids_on_road[i + 1:]:
                ga, gb = gateways[gidx[a]], gateways[gidx[b]]
                if ga["kind"] == "portGroup" and b in ga.get("members", []) or gb["kind"] == "portGroup" and a in gb.get("members", []):
                    continue
                nb = gw_node[b][0] if b in gw_node else None
                if nb is None:  # b is a group: time from a to the group's farthest member
                    t = max([times[name][m][gw_node[a][0]] + conn_min(gw_node[m][1]) for m in gb["members"]] if a in gw_node else [np.inf])
                    if ga["kind"] == "portGroup":
                        continue
                else:
                    t = group_time(name, a, nb) + conn_min(gw_node[b][1])
                if np.isfinite(t):
                    links.append([gidx[a], gidx[b], round(float(t), 2)])
        road_links[name] = links

    # meshes: road access to every gateway of the same road component
    mesh_rows = []
    quality = Counter()
    for r in inhabited:
        isl = r["island"]
        rec = {"code": r["code"], "lat": round(r["lat"], 6), "lon": round(r["lon"], 6), "pop": r["pop"], "island": isl,
               "basis": r["assignBasis"], "accessWith": [], "accessNo": [], "snapM": None}
        if isl is None:
            quality["unassigned-pop" if r["landPolygon"] else "sea-pop"] += r["pop"]
            rec["otherLand"] = pprops[r["polygon"]]["municipality"] if r["polygon"] >= 0 else None
            mesh_rows.append(rec)
            continue
        v, d = snap(r["lon"], r["lat"], roads, node_isl, isl, A["connectorMaxM"])
        if v is None:
            quality["no-road-pop"] += r["pop"]
            mesh_rows.append(rec)
            continue
        rec["snapM"] = round(d)
        for name, key in (("withBridges", "accessWith"), ("noBridges", "accessNo")):
            for g in gateways:
                if g["island"] not in island_ids:
                    continue
                t = group_time(name, g["id"], v)
                if np.isfinite(t):
                    rec[key].append([gidx[g["id"]], round(float(t + conn_min(d)), 2)])
        if not rec["accessWith"]:
            quality["no-gateway-pop"] += r["pop"]   # e.g. Funauki (Iriomote): no road to a port or airport
        mesh_rows.append(rec)

    # population checks
    assigned = sum(m["pop"] for m in mesh_rows if m["island"])
    by_island = Counter()
    for m in mesh_rows:
        by_island[m["island"] or "_other"] += m["pop"]
    if sum(by_island.values()) != sum(r["pop"] for r in inhabited):
        raise SystemExit("population does not add up after assignment")
    by_first = Counter()
    for r in rows:
        by_first[r["code"][:4]] += r["pop"] or 0
    print("population by island:", dict(by_island))

    # services: official (config) + observed OKA - mainland (ADS-B, no duration)
    obs = observed_services(cfg)
    services = []
    for s in cfg["services"]:
        services.append({**s, "status": s.get("status", "operating")})
    for dest in cfg["destinations"]:
        if dest["kind"] != "mainland":
            continue
        for node in dest["nodes"]:
            k = tuple(sorted(("ROAH", node)))
            o = obs.get(k)
            if o and o["roundTripsPerWeek"] >= 1:
                services.append({"id": f"A_OKA_{node}", "mode": "air", "a": "ROAH", "b": node, "durationMin": None,
                                 "roundTripsPerWeek": o["roundTripsPerWeek"], "frequencyText": f"観測 {o['flights']} 便／月（2026年3月、ADS-B）",
                                 "status": "operating", "source": "1090web-adsb",
                                 "note": "ADS-B で観測された便数。時刻表ではない。所要時間は確認できる資料がないため不明として扱う"})
    for s in services:
        for end in (s["a"], s["b"]):
            if end not in gidx:
                raise SystemExit(f"service {s['id']}: unknown gateway {end}")
    # official vs observed
    validation = []
    for s in cfg["services"]:
        if s["mode"] != "air":
            continue
        o = obs.get(tuple(sorted((s["a"], s["b"]))))
        validation.append({"service": s["id"], "official": s["roundTripsPerWeek"], "status": s.get("status", "operating"),
                           "observedFlights": o["flights"] if o else 0,
                           "observedRoundTripsPerWeek": o["roundTripsPerWeek"] if o else 0.0})

    # geometry for the map (simplified); only polygons of the pilot islands and land with population
    geo_islands = []
    for pi, iid in sorted(poly_island.items(), key=lambda kv: kv[1]):
        p = polys[pi]
        geo_islands.append({"island": iid, "areaKm2": round(p.area_km2(), 2),
                            "rings": [[[round(c[0], 5), round(c[1], 5)] for c in geo.simplify(r.tolist(), 0.0002)] for r in p.rings]})
    road_lines = []
    small = {i for i, v in by_island.items() if v < 5000}
    for ln in roads["lines"]:
        isl = node_isl[ln["nodes"][0]]
        if isl not in island_ids:
            continue
        # map display only: main roads (5.5 m and wider), plus 3-5.5 m roads on the small islands
        if not (ln["width"] in ("3", "4", "5") or (ln["width"] == "2" and isl in small)):
            continue
        pts = [[float(roads["x"][i]), float(roads["y"][i])] for i in ln["nodes"]]
        road_lines.append({"w": int(ln["width"]), "b": 1 if ln["bridge"] else 0,
                           "c": [[round(c[0], 4), round(c[1], 4)] for c in geo.simplify(pts, 0.00015)]})
    link_lines = []
    for e in np.where(link)[0]:
        a, b = roads["s"][e], roads["t"][e]
        link_lines.append([[round(float(roads["x"][a]), 5), round(float(roads["y"][a]), 5)], [round(float(roads["x"][b]), 5), round(float(roads["y"][b]), 5)]])

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lock = json.loads((HERE / "sources.lock.json").read_text(encoding="utf-8"))
    island_meta = []
    for isl in cfg["islands"]:
        island_meta.append({**{k: isl[k] for k in ("id", "nameJa", "nameEn", "municipality")},
                            "population2020": by_island.get(isl["id"], 0),
                            "airports": [g["id"] for g in gateways if g["kind"] == "airport" and g["island"] == isl["id"]],
                            "ports": [g["id"] for g in gateways if g["kind"] == "port" and g["island"] == isl["id"]]})
    meta = {
        "schemaVersion": SCHEMA_VERSION, "buildVersion": BUILD_VERSION, "region": region, "generatedAt": now,
        "nameJa": cfg["nameJa"], "nameEn": cfg["nameEn"], "note": cfg["note"],
        "islands": island_meta, "destinations": cfg["destinations"], "defaultDestination": cfg["defaultDestination"],
        "assumptions": A, "portGroupRule": cfg["portGroupRule"], "notModelled": cfg["notModelled"],
        "serviceSources": cfg["serviceSources"],
        "inputs": [{"file": k, "url": v["url"].split("?data=")[0], "licence": v["licence"], "retrieved": v["retrieved"],
                    "sha256": v["sha256"], "note": v["note"]} for k, v in lock["files"].items()],
        "quality": {
            "populationYear": 2020, "meshLevel": "250 m", "populationTotalInMeshFiles": pop_total,
            "populationByFirstLevelMesh": dict(sorted(by_first.items())),
            "meshesWithoutTotal": len(missing_values),
            "suppressedMeshes": sum(1 for r in inhabited if r["suppressed"]),
            "suppressionNote": "e-Stat の秘匿処理は年齢・性別などの内訳だけに適用され、人口総数は全メッシュで公表されている。総数の合計はメッシュ間で重複しない。",
            "assignedPopulation": assigned, "populationByIsland": dict(sorted(by_island.items())),
            "assignBasis": dict(Counter(m["basis"] for m in mesh_rows)),
            "unassignedPopulation": quality["unassigned-pop"], "seaPopulation": quality["sea-pop"],
            "noRoadPopulation": quality["no-road-pop"], "noGatewayPopulation": quality["no-gateway-pop"],
            "roads": {"nodes": int(len(roads["x"])), "edges": int(len(roads["s"])), "interIslandLinkEdges": int(link.sum()),
                      "excludedFeatures": roads["excluded"]},
            "airObservedVsOfficial": validation,
        },
    }
    network = {"schemaVersion": SCHEMA_VERSION, "region": region, "gateways": gateways, "services": services,
               "roadLinks": road_links, "destinations": cfg["destinations"], "assumptions": A}
    meshes = {"schemaVersion": SCHEMA_VERSION, "region": region,
              "columns": ["code", "lat", "lon", "pop", "island", "basis", "snapM", "accessWith", "accessNo"],
              "rows": [[m["code"], m["lat"], m["lon"], m["pop"], m["island"], m["basis"], m["snapM"], m["accessWith"], m["accessNo"]] for m in mesh_rows]}
    geoj = {"schemaVersion": SCHEMA_VERSION, "region": region, "islands": geo_islands, "roads": road_lines, "links": link_lines,
            "credit": "国土数値情報（行政区域 N03 2026年、道路 N13 2024年）CC BY 4.0 を加工"}
    for name, data in (("meta", meta), ("network", network), ("meshes", meshes), ("geo", geoj)):
        (out_dir / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    sizes = {p.name: p.stat().st_size for p in out_dir.glob("*.json")}
    print("written", sizes)
    return meta


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--region", default="okinawa-pilot")
    a = p.parse_args()
    build(a.region)


if __name__ == "__main__":
    main()
