"""Research Mode browser files (pipeline/research_web.py) on a synthetic build."""

from __future__ import annotations

import json

import research_web
from analysis import reliability as rel
from build_dataset import BuildConfig, build
from synthetic import write_inputs


def test_research_web_files(tmp_path):
    inputs = write_inputs(tmp_path / "in")
    data_root = tmp_path / "public"
    ds = data_root / "ds"
    build(BuildConfig(flight_files=inputs["flights"], ourairports_csv=inputs["airports"], classes_csv=inputs["classes"],
                      out_dir=ds, dataset_id="ds", dataset_version="0.0.1", quality_path=tmp_path / "q.json",
                      lock_path=None, record_git=False, log=lambda *_: None))
    research_root = tmp_path / "research"
    rel.run(rel.Config(dataset_dir=ds, out_dir=research_root / "ds" / "phase6b", raw_flights=inputs["flights"],
                       focus_month="2026-03", lock_path=None, record_git=False, log=lambda *_: None))
    m = research_web.build("ds", data_root=data_root, research_root=research_root)
    out = ds / "research-web"
    assert m["datasetVersion"] == "0.0.1" and set(m["files"]) == {"tiers/2026-03.json", "tiers/2026-04.json",
                                                                  "persistence.json", "quality.json"}
    # every published file is listed with its hash
    for name, digest in m["files"].items():
        assert research_web.hashlib.sha256((out / name).read_bytes()).hexdigest() == digest

    # T2/T3 records never exceed the Explore basis-0 record they split
    explore = json.loads((ds / "months" / "2026-03.json").read_text(encoding="utf-8"))["records"]
    basis0 = {(r[0], r[1], r[2]): r[3:6] for r in explore if (r[6] if len(r) > 6 else 0) == 0}
    tiers = json.loads((out / "tiers" / "2026-03.json").read_text(encoding="utf-8"))["records"]
    assert tiers, "the synthetic data has T2 and T3 flights"
    for rid, d, al, tier, p, c, u in tiers:
        assert tier in (2, 3)
        b = basis0[(rid, d, al)]
        assert p <= b[0] and c <= b[1] and u <= b[2]

    pers = json.loads((out / "persistence.json").read_text(encoding="utf-8"))
    n_routes = len(json.loads((ds / "routes.json").read_text(encoding="utf-8")))
    assert all(len(v) == n_routes for v in pers["tierSets"].values())
    # nested tier sets: a route present under T1 is present under every larger set
    for i in range(n_routes):
        a, b, c, d = (int(pers["tierSets"][k][i]) for k in "ABCD")
        assert a <= b <= c <= d <= 2

    q = json.loads((out / "quality.json").read_text(encoding="utf-8"))
    assert q["dataset"]["version"] == "0.0.1"
    assert [x["month"] for x in q["months"]] == ["2026-03", "2026-04"]
    assert q["external"] == {"available": False}  # no Phase 7 outputs: nothing is filled in
