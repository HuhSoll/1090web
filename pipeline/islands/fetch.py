"""
Download the raw inputs of the island dependency lab (Phase 9F) into data/raw/islands/.

Every file is recorded in pipeline/islands/sources.lock.json with its URL, retrieval time, size,
SHA-256 and licence, so a later build can tell whether an input changed. Nothing here is
published as is; pipeline/islands/build.py writes the derived files for the browser.

  python pipeline/islands/fetch.py            # download what is missing
  python pipeline/islands/fetch.py --refresh  # download everything again

Sources (see docs/island-data-sources.md for licences and caveats):
  e-Stat 2020 census mesh population (250 m: T001142, 500 m: T001141), per 1st-level mesh
  MLIT National Land Numerical Information: roads N13 (2024, per 1st-level mesh), administrative
    areas N03 (2026-01-01, Okinawa)
  Okinawa Prefecture, 離島関係資料 (令和8年版) chapter 3 (air and sea routes)
  OpenStreetMap ferry terminals and piers (Overpass API)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import provenance  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "islands"
LOCK = Path(__file__).resolve().parent / "sources.lock.json"
UA = "1090web-research-pipeline/1.0 (data download)"

# 1st-level (80 km) meshes covering the pilot islands: Yonaguni (3622, 3623), Iriomote (3623), Ishigaki and
# Tarama (3624; north of Tarama in 3724)
# Miyako (3725), Minami/Kita Daito (3831).
MESHES = ["3622", "3623", "3624", "3724", "3725", "3831"]
# Overpass bounding box (S, W, N, E) of the Sakishima and Daito islands
OSM_BBOX = (24.0, 122.9, 26.1, 131.4)

ESTAT = "https://www.e-stat.go.jp/gis/statmap-search/data?statsId={stats}&code={mesh}&downloadType=2"
N13 = "https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24/N13-24_{mesh}_GEOJSON.zip"
N03 = "https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_47_GML.zip"
PREF = "https://www.pref.okinawa.jp/_res/projects/default_project/_page_/001/038/825/03.chapter3.r8.pdf"
OVERPASS = "https://overpass-api.de/api/interpreter"

ESTAT_LICENCE = "政府統計の総合窓口(e-Stat) 利用規約（政府標準利用規約 第2.0版準拠、CC BY 4.0 互換）"
KSJ_LICENCE = "国土数値情報 オープンデータ（CC BY 4.0）"


def sources() -> list[dict]:
    out = []
    for m in MESHES:
        out.append({"file": f"estat/T001142_{m}.zip", "url": ESTAT.format(stats="T001142", mesh=m), "licence": ESTAT_LICENCE,
                    "note": f"2020 census, 250 m mesh (5th level) population and households, 1st-level mesh {m}"})
        out.append({"file": f"estat/T001141_{m}.zip", "url": ESTAT.format(stats="T001141", mesh=m), "licence": ESTAT_LICENCE,
                    "note": f"2020 census, 500 m mesh (4th level) population and households, 1st-level mesh {m}"})
        out.append({"file": f"ksj/N13-24_{m}_GEOJSON.zip", "url": N13.format(mesh=m), "licence": KSJ_LICENCE,
                    "note": f"roads (centre lines) 2024, 1st-level mesh {m}"})
    out.append({"file": "ksj/N03-20260101_47_GML.zip", "url": N03, "licence": KSJ_LICENCE,
                "note": "administrative areas of Okinawa as of 2026-01-01"})
    out.append({"file": "okinawa/03.chapter3.r8.pdf", "url": PREF,
                "licence": "沖縄県ホームページの利用規約による（出典を明記して利用。PDF 自体は再配布しない）",
                "note": "Okinawa Prefecture 離島関係資料 令和8年版 第3章 交通: air routes as of end Nov 2025 (p.65), sea routes as of 2025-10-01 (p.72-75)"})
    q = ("[out:json][timeout:60];("
         f"nwr[\"amenity\"=\"ferry_terminal\"]({OSM_BBOX[0]},{OSM_BBOX[1]},{OSM_BBOX[2]},{OSM_BBOX[3]});"
         f"nwr[\"route\"=\"ferry\"]({OSM_BBOX[0]},{OSM_BBOX[1]},{OSM_BBOX[2]},{OSM_BBOX[3]});"
         ");out center tags;")
    q2 = ("[out:json][timeout:60];("
          "nwr[\"name\"~\"港\"](25.80,131.18,26.00,131.36);"   # Minami / Kita Daito
          "nwr[\"name\"~\"泊\"](26.20,127.66,26.24,127.70);"    # Naha Tomari
          "nwr[\"name\"~\"港\"](24.60,124.68,24.72,124.75);"    # Tarama
          ");out center tags;")
    out.append({"file": "osm/ports.json", "url": OVERPASS + "?data=" + urllib.parse.quote(q2),
                "licence": "© OpenStreetMap contributors, ODbL 1.0", "note": "named harbours of the Daito islands, Tarama and Naha Tomari"})
    out.append({"file": "osm/ferry.json", "url": OVERPASS + "?data=" + urllib.parse.quote(q),
                "licence": "© OpenStreetMap contributors, ODbL 1.0", "note": "ferry terminals and ferry routes (tags and centre points)"})
    return out


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    if not data:
        raise RuntimeError(f"empty response: {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    a = p.parse_args()
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {"files": {}}
    for s in sources():
        dest = RAW / s["file"]
        if dest.exists() and not a.refresh and s["file"] in lock["files"]:
            continue
        print("download", s["file"], flush=True)
        fetch(s["url"], dest)
        lock["files"][s["file"]] = {**s, "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                    "bytes": dest.stat().st_size, "sha256": provenance.sha256_file(dest)}
        time.sleep(1.0)  # be gentle with the public servers
    lock["files"] = dict(sorted(lock["files"].items()))
    LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(len(lock["files"]), "files recorded in", LOCK.relative_to(ROOT))


if __name__ == "__main__":
    main()
