"""
Download the documents behind the non-EASA events (Phase 9H) into data/raw/events/sources/.

Each file is recorded in pipeline/events/sources-documents.lock.json with URL, retrieval time,
size, SHA-256 and HTTP status. A failed download is recorded as failed (the event that needs it
then cannot be verified); nothing is filled in.

  python pipeline/events/fetch_sources.py [--refresh]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import provenance  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "events" / "sources"
HERE = Path(__file__).resolve().parent
LOCK = HERE / "sources-documents.lock.json"
UA = "Mozilla/5.0 (1090web research data client)"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--refresh", action="store_true")
    a = p.parse_args()
    cfg = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {"files": {}}
    for s in cfg["sources"]:
        old = lock["files"].get(s["id"])
        if old and old.get("status") == "ok" and not a.refresh:
            continue
        ext = ".pdf" if s["url"].lower().split("?")[0].endswith(".pdf") else ".html"
        dest = RAW / f"{s['id']}{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        entry = {"id": s["id"], "url": s["url"], "retrievedAt": now(), "publisher": s["publisher"], "sourceType": s["sourceType"]}
        try:
            req = urllib.request.Request(s["url"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
                entry["finalUrl"] = r.geturl()
                entry["httpStatus"] = r.status
            if not data:
                raise RuntimeError("empty response")
            dest.write_bytes(data)
            entry.update(status="ok", file=dest.relative_to(ROOT).as_posix(), bytes=len(data), sha256=provenance.sha256_file(dest))
        except (urllib.error.URLError, RuntimeError, TimeoutError) as e:
            entry.update(status="failed", error=str(e)[:200])
        lock["files"][s["id"]] = entry
        print(s["id"], entry["status"], entry.get("bytes", entry.get("error")))
        time.sleep(1.0)
    lock["files"] = dict(sorted(lock["files"].items()))
    LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
