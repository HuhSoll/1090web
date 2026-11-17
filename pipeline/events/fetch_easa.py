"""
Download EASA Conflict Zone Information Bulletins (CZIB) and their archived versions (Phase 9G).

EASA publishes only the current revision of each bulletin: older revision URLs redirect to the
latest one. Earlier revisions are therefore taken from captures of the EASA pages in the Internet
Archive (Wayback Machine), each with its capture time. Nothing is inferred: a revision with no
capture is not reconstructed.

  python pipeline/events/fetch_easa.py            # download what is missing
  python pipeline/events/fetch_easa.py --refresh  # download the live pages again (new dated copies)

Files go to data/raw/events/ (not published); every file is recorded in
pipeline/events/sources.lock.json with URL, capture / retrieval time, size and SHA-256.
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
RAW = ROOT / "data" / "raw" / "events" / "easa"
HERE = Path(__file__).resolve().parent
LOCK = HERE / "sources.lock.json"
CONFIG = HERE / "easa-bulletins.json"
UA = "1090web-research-pipeline/1.0 (data download)"
EASA = "https://www.easa.europa.eu"
CZIB_PATH = "/en/domains/air-operations/czibs/"
EXPORT = EASA + CZIB_PATH + "export-json?page&_format=json"
CDX = "http://web.archive.org/cdx/search/cdx"
LICENCE_EASA = "© European Union Aviation Safety Agency; reproduction authorised provided the source is acknowledged"
LICENCE_WAYBACK = "Capture of the EASA page by the Internet Archive Wayback Machine (content © EASA, as above)"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get(url: str, timeout: int = 120) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.geturl()


def save(rel: str, data: bytes, entry: dict, lock: dict) -> None:
    dest = RAW / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    lock["files"][rel] = {**entry, "bytes": len(data), "sha256": provenance.sha256_file(dest)}


def cdx(prefix: str) -> list[dict]:
    """Archived captures (HTTP 200, one per distinct content) of URLs starting with prefix."""
    q = urllib.parse.urlencode({"url": prefix + "*", "output": "json", "from": "2025",
                                "fl": "timestamp,original,statuscode,digest", "filter": "statuscode:200", "collapse": "digest"})
    data, _ = get(f"{CDX}?{q}", timeout=180)
    rows = json.loads(data or b"[]")
    return [dict(zip(rows[0], r)) for r in rows[1:]] if rows else []


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    a = p.parse_args()
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {"files": {}}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")

    # live: the export and the current page of every configured bulletin (dated copies are kept)
    live_done = any(k.startswith(f"live/{stamp}/") for k in lock["files"])
    if a.refresh or not live_done:
        data, _ = get(EXPORT)
        save(f"live/{stamp}/export.json", data, {"kind": "live-export", "url": EXPORT, "retrievedAt": now(), "licence": LICENCE_EASA}, lock)
        for b in cfg["bulletins"]:
            url = f"{EASA}/en/node/{b['nid']}"
            data, final = get(url)
            save(f"live/{stamp}/node-{b['nid']}.html", data,
                 {"kind": "live-page", "url": final, "requested": url, "retrievedAt": now(), "licence": LICENCE_EASA, "nid": b["nid"]}, lock)
            time.sleep(1.0)

    # archived captures of each bulletin's pages and of the export
    prefixes = [("page", "www.easa.europa.eu" + CZIB_PATH + pre, b["nid"]) for b in cfg["bulletins"] for pre in b["slugPrefixes"]]
    prefixes.append(("export", "www.easa.europa.eu" + CZIB_PATH + "export-json", None))
    for kind, prefix, nid in prefixes:
        try:
            caps = cdx(prefix)
        except Exception as e:  # the archive is sometimes slow: report and keep what we have
            print("  ! CDX failed for", prefix, e)
            continue
        time.sleep(1.5)
        for c in caps:
            slug = c["original"].split("/czibs/")[-1].split("?")[0] or "list"
            rel = f"wayback/{slug}/{c['timestamp']}.{'json' if kind == 'export' else 'html'}"
            if rel in lock["files"]:
                continue
            url = f"https://web.archive.org/web/{c['timestamp']}id_/{c['original']}"
            try:
                data, _ = get(url)
            except Exception as e:
                print("  ! capture failed", url, e)
                continue
            cap = datetime.strptime(c["timestamp"], "%Y%m%d%H%M%S").strftime("%Y-%m-%dT%H:%M:%SZ")
            save(rel, data, {"kind": f"wayback-{kind}", "url": url, "original": c["original"], "capturedAt": cap,
                             "retrievedAt": now(), "licence": LICENCE_WAYBACK, "nid": nid, "digest": c["digest"]}, lock)
            print("  capture", rel)
            time.sleep(1.5)

    lock["files"] = dict(sorted(lock["files"].items()))
    LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(len(lock["files"]), "files recorded in", LOCK.relative_to(ROOT))


if __name__ == "__main__":
    main()
