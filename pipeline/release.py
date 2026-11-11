"""
Research data that is too large for Git (Parquet tables) is distributed as GitHub Release assets.
Git holds only a small manifest per dataset version (pipeline/releases/<dataset>.json) with each
file's size and SHA-256, so anyone can check that the files they have are the ones the results
were computed from.

  python pipeline/release.py manifest --dataset observed-2026-v2   # write/refresh the manifest
  python pipeline/release.py verify   --dataset observed-2026-v2   # check local files
  python pipeline/release.py fetch    --dataset observed-2026-v2   # download assets + verify

Uploading is not done here: `manifest` prints the `gh release` command to run once the release
has been approved.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import provenance  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = Path(__file__).resolve().parent / "releases"
REPO = "HuhSoll/1090web"


def research_files(dataset: str) -> list[Path]:
    """Large research files of a dataset that are not in Git."""
    files = sorted((ROOT / "public" / "data" / dataset / "research").glob("*.parquet"))
    files += sorted((ROOT / "data" / "research" / dataset).glob("*/*.parquet"))
    return files


def tag_for(dataset: str, version: str) -> str:
    return f"research-{dataset}-v{version}"


def asset_name(path: Path) -> str:
    """Release assets are a flat list: encode the folder in the name."""
    rel = path.resolve().relative_to(ROOT).as_posix()
    return rel.replace("public/data/", "").replace("data/research/", "").replace("/", "__")


def build_manifest(dataset: str) -> dict:
    ds_manifest = json.loads((ROOT / "public" / "data" / dataset / "manifest.json").read_text(encoding="utf-8"))
    version = ds_manifest.get("datasetVersion", "0")
    tag = tag_for(dataset, version)
    files = []
    for p in research_files(dataset):
        files.append({"path": p.resolve().relative_to(ROOT).as_posix(), "asset": asset_name(p),
                      "bytes": p.stat().st_size, "sha256": provenance.sha256_file(p),
                      "url": f"https://github.com/{REPO}/releases/download/{tag}/{asset_name(p)}"})
    return {"dataset": dataset, "datasetVersion": version, "tag": tag, "repository": REPO,
            "generatedAt": provenance.now_utc(), "files": files,
            "regenerate": ["python pipeline/build_dataset.py --dataset <id> --version <version>",
                           "python pipeline/analysis/reliability.py --dataset <id> ...",
                           "python pipeline/validation/report.py --dataset <id>"]}


def manifest_path(dataset: str) -> Path:
    return MANIFEST_DIR / f"{dataset}.json"


def verify(dataset: str, manifest: dict | None = None, root: Path = ROOT) -> list[str]:
    """Problems found (empty list = every listed file is present with the recorded hash)."""
    manifest = manifest or json.loads(manifest_path(dataset).read_text(encoding="utf-8"))
    problems = []
    for f in manifest["files"]:
        p = root / f["path"]
        if not p.exists():
            problems.append(f"missing: {f['path']}")
        elif p.stat().st_size != f["bytes"] or provenance.sha256_file(p) != f["sha256"]:
            problems.append(f"hash mismatch: {f['path']}")
    return problems


def fetch(dataset: str) -> list[str]:
    manifest = json.loads(manifest_path(dataset).read_text(encoding="utf-8"))
    for f in manifest["files"]:
        p = ROOT / f["path"]
        if p.exists() and provenance.sha256_file(p) == f["sha256"]:
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        with urllib.request.urlopen(f["url"], timeout=600) as r, tmp.open("wb") as fh:
            while chunk := r.read(1 << 20):
                fh.write(chunk)
        if provenance.sha256_file(tmp) != f["sha256"]:
            tmp.unlink()
            raise RuntimeError(f"downloaded {f['asset']} does not match the manifest hash")
        tmp.replace(p)
    return verify(dataset, manifest)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=["manifest", "verify", "fetch"])
    p.add_argument("--dataset", required=True)
    a = p.parse_args()
    if a.cmd == "manifest":
        m = build_manifest(a.dataset)
        MANIFEST_DIR.mkdir(exist_ok=True)
        manifest_path(a.dataset).write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {manifest_path(a.dataset).relative_to(ROOT)} ({len(m['files'])} files)")
        print("\nTo publish (after approval), upload the files under their asset names, e.g.:")
        print(f"  gh release create {m['tag']} --repo {REPO} --title \"Research data {a.dataset} v{m['datasetVersion']}\" "
              f"--notes-file docs/research-data-release.md")
        for f in m["files"]:
            print(f"  cp {f['path']} {f['asset']} && gh release upload {m['tag']} {f['asset']} --repo {REPO}")
    elif a.cmd == "verify":
        problems = verify(a.dataset)
        print("ok" if not problems else "\n".join(problems))
        sys.exit(1 if problems else 0)
    else:
        problems = fetch(a.dataset)
        print("ok" if not problems else "\n".join(problems))
        sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
