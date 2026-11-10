"""
Provenance for reproducible datasets: input hashes, the inputs lock file, git state and the
software environment. Everything here is recorded in the dataset's provenance.json and manifest.
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "pipeline" / "inputs.lock.json"


def sha256_file(path: Path, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


@dataclass
class InputFile:
    role: str
    path: Path

    def describe(self) -> dict:
        st = self.path.stat()
        return {
            "role": self.role,
            "file": self.path.name,
            "bytes": st.st_size,
            "sha256": sha256_file(self.path),
        }


class LockMismatch(RuntimeError):
    pass


def verify_against_lock(described: list[dict], lock_path: Path = LOCK_PATH) -> dict:
    """Checks every input against the lock file. Raises LockMismatch on any difference.

    Returns the lock entries used (so their source URLs / retrieval dates can be recorded).
    """
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    by_file = {e["file"]: e for e in lock["inputs"]}
    problems = []
    for d in described:
        e = by_file.get(d["file"])
        if e is None:
            problems.append(f"{d['file']}: not in lock file")
        elif e["sha256"] != d["sha256"] or e["bytes"] != d["bytes"]:
            problems.append(f"{d['file']}: sha256/size differs from lock ({e['sha256'][:12]}… vs {d['sha256'][:12]}…)")
    if problems:
        raise LockMismatch("input files do not match pipeline/inputs.lock.json:\n  " + "\n  ".join(problems))
    return {d["file"]: by_file[d["file"]] for d in described}


def git_state(root: Path = ROOT) -> dict:
    def run(*args: str) -> str:
        try:
            return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return ""

    commit = run("rev-parse", "HEAD")
    # Tracked files changed since the commit = the code that ran is not exactly the commit.
    # Untracked files (new helper scripts, outputs) do not affect a build and are listed apart.
    modified = run("status", "--porcelain", "--untracked-files=no", "--", "pipeline")
    untracked = run("ls-files", "--others", "--exclude-standard", "--", "pipeline")
    return {"commit": commit or None, "pipelineDirty": bool(modified),
            "pipelineUntracked": sorted(untracked.splitlines()) if untracked else []}


def environment() -> dict:
    import duckdb

    return {
        "python": sys.version.split()[0],
        "duckdb": duckdb.__version__,
        "platform": platform.platform(),
    }


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
