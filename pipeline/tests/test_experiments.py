"""Phase 9E: airport criticality, missingness models and the batch runner."""
from __future__ import annotations

import json
from collections import deque

import numpy as np
import pytest

from experiments import data as D
from experiments import impact as I
from experiments import run as R


# ---- brute force reference (plain BFS, straight from the definitions) ------------------------------

def _adj(n, src, dst, directed, removed=None):
    a = [set() for _ in range(n)]
    for s, t in zip(src, dst):
        if s == t or s == removed or t == removed:
            continue
        a[s].add(t)
        if not directed:
            a[t].add(s)
    return a


def _dist(adj, s):
    d = {s: 0}
    q = deque([s])
    while q:
        u = q.popleft()
        for w in adj[u]:
            if w not in d:
                d[w] = d[u] + 1
                q.append(w)
    return d


def _eff(adj, nodes):
    tot, pairs = 0.0, 0
    for s in nodes:
        d = _dist(adj, s)
        for t in nodes:
            if t != s:
                pairs += 1
                tot += 1 / d[t] if t in d else 0
    return tot / pairs


def brute(n, src, dst, directed, v):
    full = _adj(n, src, dst, directed)
    cut = _adj(n, src, dst, directed, removed=v)
    V = list(range(n))
    rest = [x for x in V if x != v]
    systemic = _eff(full, V) - _eff(cut, V)
    spill = _eff(full, rest) - _eff(cut, rest)
    unreach = 0
    for s in rest:
        a, b = _dist(full, s), _dist(cut, s)
        unreach += sum(1 for t in rest if t != s and t in a and t not in b)
    return systemic, spill, unreach


def random_graph(n, m, seed):
    rng = np.random.default_rng(seed)
    return rng.integers(0, n, m), rng.integers(0, n, m)


@pytest.mark.parametrize("directed", [True, False])
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_exact_matches_brute_force(directed, seed):
    n = 30
    src, dst = random_graph(n, 70, seed)
    p = I.prepare(n, src, dst, None, directed, None)
    cands = np.arange(n)
    r = I.evaluate(p, cands)
    for v in range(n):
        sy, sp, un = brute(n, src.tolist(), dst.tolist(), directed, v)
        assert r["systemicDrop"][v] == pytest.approx(sy, abs=1e-12)
        assert r["spilloverDrop"][v] == pytest.approx(sp, abs=1e-12)
        assert r["unreachablePairs"][v] == pytest.approx(un, abs=1e-9)


def test_star_hub_and_isolated():
    # hub 0 connected to 1..5; airport 6 isolated
    src = np.array([0, 0, 0, 0, 0, 1, 2, 3, 4, 5])
    dst = np.array([1, 2, 3, 4, 5, 0, 0, 0, 0, 0])
    p = I.prepare(7, src, dst, np.ones(10), True, None)
    r = I.evaluate(p, np.array([0, 1, 6]))
    assert r["unreachablePairs"][0] == 20  # 5*4 leaf pairs lose their only path
    assert r["spilloverDrop"][0] > 0 and r["spilloverDrop"][1] == 0
    assert r["systemicDrop"][2] == 0 and r["spilloverDrop"][2] == 0 and r["directLost"][2] == 0
    assert r["directLost"][0] == 5 and r["flightsLost"][0] == 10


def test_sampled_with_all_sources_equals_exact_and_same_sources_for_every_candidate():
    n = 40
    src, dst = random_graph(n, 120, 7)
    exact = I.evaluate(I.prepare(n, src, dst, None, True, None), np.arange(n))
    allsrc = I.evaluate(I.prepare(n, src, dst, None, True, np.arange(n)), np.arange(n))
    np.testing.assert_allclose(exact["spilloverDrop"], allsrc["spilloverDrop"], atol=1e-14)
    s1, s2 = I.sample_sources(n, 10, 5), I.sample_sources(n, 10, 5)
    assert s1.tolist() == s2.tolist() and len(set(s1.tolist())) == 10
    assert I.sample_sources(n, None, 1) is None and I.sample_sources(n, 99, 1) is None


def test_sample_sources_matches_typescript():
    # values printed by src/experiments/criticality.ts sampleSources(100, 8, 42)
    assert I.sample_sources(100, 8, 42).tolist() == TS_SAMPLE_100_8_42


TS_SAMPLE_100_8_42 = [20, 31, 45, 55, 60, 65, 67, 85]


def test_candidate_order_does_not_change_values():
    n = 25
    src, dst = random_graph(n, 60, 11)
    p = I.prepare(n, src, dst, None, True, I.sample_sources(n, 8, 3))
    a = I.evaluate(p, np.arange(n))
    perm = np.random.default_rng(0).permutation(n)
    b = I.evaluate(p, perm)
    np.testing.assert_allclose(a["spilloverDrop"][perm], b["spilloverDrop"])


# ---- missingness ------------------------------------------------------------------------------------

def _flights(n=2000, airports=20, seed=0):
    rng = np.random.default_rng(seed)
    o = rng.integers(0, airports, n)
    d = (o + rng.integers(1, airports, n)) % airports
    return D.Flights(o, d, np.ones(n, np.int8), np.zeros(n, np.int8), np.zeros(n, np.int8))


def _ds(airports=20):
    ids = [f"A{i:02d}" for i in range(airports)]
    return D.Dataset("t", "1", ids, ["X"] * airports, ["Europe" if i < 10 else "Asia" for i in range(airports)])


def test_missingness_zero_and_full():
    fl, ds = _flights(), _ds()
    assert D.missingness_keep(fl, {"model": "uniform", "rate": 0.0}, 1, 3, ds, None, 20).all()
    assert not D.missingness_keep(fl, {"model": "uniform", "rate": 1.0}, 1, 3, ds, None, 20).any()
    assert D.missingness_keep(fl, {"model": "uniform", "rate": 0.5}, 1, 0, ds, None, 20).all()  # trial 0 = reference


def test_missingness_seeded_and_trial_independent():
    fl, ds = _flights(), _ds()
    m = {"model": "uniform", "rate": 0.3}
    a = D.missingness_keep(fl, m, 7, 5, ds, None, 20)
    b = D.missingness_keep(fl, m, 7, 5, ds, None, 20)
    c = D.missingness_keep(fl, m, 7, 6, ds, None, 20)
    assert (a == b).all() and (a != c).any()
    assert abs(1 - a.mean() - 0.3) < 0.05


def test_regional_combine_rules():
    fl, ds = _flights(20000), _ds()
    eu = np.array(ds.continents)[fl.org] == "Europe"
    eu_d = np.array(ds.continents)[fl.dst] == "Europe"
    for rule, expect in (("origin", 0.4), ("either", 0.4), ("both", 0.0)):
        keep = D.missingness_keep(fl, {"model": "regional", "regionRates": {"Europe": 0.4}, "otherRate": 0.0, "combine": rule}, 1, 1, ds, None, 20)
        sel = eu & ~eu_d
        assert abs(1 - keep[sel].mean() - expect) < 0.03, rule
    keep = D.missingness_keep(fl, {"model": "regional", "regionRates": {"Europe": 0.4}, "otherRate": 0.0, "combine": "max"}, 1, 1, ds, None, 20)
    assert keep[~eu & ~eu_d].all()


def test_route_model_units():
    fl, ds = _flights(3000), _ds()
    pf = D.pair_flights(fl, np.ones(len(fl), bool), 20)
    thr = sorted(pf.values())[len(pf) // 2]
    m = {"model": "route", "lowFrequency": {"threshold": thr, "rateLow": 1.0, "rateOther": 0.0, "unit": "route"}}
    keep = D.missingness_keep(fl, m, 1, 1, ds, pf, 20)
    pair = np.minimum(fl.org, fl.dst) * 20 + np.maximum(fl.org, fl.dst)
    low = np.array([pf[int(x)] < thr for x in pair])
    assert not keep[low].any() and keep[~low].all()
    m["lowFrequency"]["rateLow"] = 0.5
    keep = D.missingness_keep(fl, m, 1, 1, ds, pf, 20)
    for x in set(pair[low].tolist()):  # whole routes go together
        assert len(set(keep[pair == x].tolist())) == 1


def test_build_network_min_flights_and_direction():
    o = np.array([0, 0, 1, 2, 2, 3])
    d = np.array([1, 1, 0, 3, 3, 3])  # last one is a self-loop
    fl = D.Flights(o, d, np.ones(6, np.int8), np.zeros(6, np.int8), np.zeros(6, np.int8))
    net = D.build_network(fl, np.ones(6, bool), 3, True, 5)
    assert net.nodes.tolist() == [0, 1] and sorted(zip(net.src.tolist(), net.dst.tolist())) == [(0, 1), (1, 0)]
    und = D.build_network(fl, np.ones(6, bool), 1, False, 5)
    assert und.pairs == 2 and len(und.src) == 2


# ---- runner ------------------------------------------------------------------------------------------

def test_definition_validation():
    with pytest.raises(ValueError):
        R.validate({"format": "x"})
    with pytest.raises(ValueError):
        R.validate({"format": R.FORMAT, "schemaVersion": 1, "experimentType": "missingness", "baseline": {"start": "a", "end": "b"},
                    "missingness": {"model": "uniform", "rate": 1.5}})
    d = R.validate({"format": R.FORMAT, "schemaVersion": 1, "experimentType": "missingness", "baseline": {"start": "a", "end": "b"},
                    "missingness": {"model": "uniform", "rate": 0.1}, "repetitions": 3})
    assert [r["runId"] for r in R.runs_of(d)] == ["t0000", "t0001", "t0002", "t0003"]
    assert R.definition_hash(d) == R.definition_hash({**d, "name": "other"})


def test_competition_ranks_and_topk():
    assert R.competition([0.3, 0.1, 0.3, 0.2]) == [1, 4, 1, 3]
    assert R.topk_overlap([3, 2, 1, 0], [3, 2, 0, 1], 2) == (1.0, 1.0)
    assert R.topk_overlap([3, 2, 1, 0], [0, 1, 2, 3], 2) == (0.0, 0.0)


@pytest.mark.skipif(not (D.ROOT / "data" / "research" / "observed-2026-v2" / "temporal" / "flights_2026-03.parquet").exists(), reason="research data not present")
def test_runner_small_missingness_run_and_resume(tmp_path):
    d = {"format": R.FORMAT, "schemaVersion": 1, "experimentId": "t", "name": "t", "datasetId": "observed-2026-v2",
         "experimentType": "missingness",
         "baseline": {"start": "2026-03-01T00:00:00Z", "end": "2026-03-02T00:00:00Z"},
         "missingness": {"model": "uniform", "rate": 0.2}, "candidates": ["EGLL", "KATL", "RJTT"],
         "computation": {"sources": 32, "sourceSeed": 1}, "randomSeed": 3, "repetitions": 2, "topK": [2]}
    f = tmp_path / "d.json"
    f.write_text(json.dumps(d))
    r1 = R.run(f, tmp_path / "o", 1, False, log=lambda *_: None)
    assert r1["complete"] and len(r1["runs"]) == 3 and r1["airports"][0]["systemicStats"]["mean"] is not None
    # all trials on the reference node set
    assert len({x["nodes"] for x in r1["runs"]}) == 1
    (tmp_path / "o" / "runs" / "t0002.json").unlink()
    r2 = R.run(f, tmp_path / "o", 1, True, log=lambda *_: None)
    assert [a["runs"]["spillover"] for a in r1["airports"]] == [a["runs"]["spillover"] for a in r2["airports"]]
