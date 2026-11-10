"""Network metrics checked against hand calculations on tiny graphs."""

from __future__ import annotations

import math

import pytest

from analysis import network as net

#   A - B - C      D - E      (and a self-loop F-F that must be ignored)
DIRECTED = {("A", "B"): 5, ("B", "A"): 3, ("B", "C"): 1, ("D", "E"): 4, ("F", "F"): 9}


def test_undirected_sums_both_directions_and_drops_self_loops():
    assert net.undirected(DIRECTED) == {("A", "B"): 8, ("B", "C"): 1, ("D", "E"): 4}


def test_threshold_and_restrict():
    und = net.undirected(DIRECTED)
    assert net.threshold(und, 4) == {("A", "B"): 8, ("D", "E"): 4}
    assert net.threshold(und, 10) == {}
    assert net.restrict(und, [("B", "C")]) == {("B", "C"): 1}


def test_degree_strength_and_directed_degree():
    und = net.undirected(DIRECTED)
    assert net.degree(und) == {"A": 1, "B": 2, "C": 1, "D": 1, "E": 1}
    # directed edge list: A<->B counts once for the undirected degree
    assert net.degree(DIRECTED) == {"A": 1, "B": 2, "C": 1, "D": 1, "E": 1}
    out_d, in_d = net.out_in_degree(DIRECTED)
    assert out_d == {"A": 1, "B": 2, "D": 1}
    assert in_d == {"B": 1, "A": 1, "C": 1, "E": 1}
    assert net.strength(und) == {"A": 8, "B": 9, "C": 1, "D": 4, "E": 4}


def test_components_of_small_networks():
    assert net.components(net.undirected(DIRECTED)) == [3, 2]
    assert net.components([]) == []
    # a ring plus a bridge joins everything
    ring = [("A", "B"), ("B", "C"), ("C", "A"), ("C", "D"), ("X", "Y")]
    assert net.components(ring) == [4, 2]


def test_summarize_by_hand():
    s = net.summarize(net.undirected(DIRECTED))
    assert s["routes"] == 3 and s["airports"] == 5 and s["flights"] == 13
    assert s["mean_degree"] == 1.2          # 2 * 3 edges / 5 nodes
    assert s["median_degree"] == 1 and s["max_degree"] == 2
    assert s["components"] == 2 and s["largest_component"] == 3
    assert s["largest_component_share"] == 0.6
    assert s["airports_outside_largest"] == 2 and s["components_size_le_2"] == 1


def test_ranks_with_ties():
    scores = {"a": 5, "b": 3, "c": 3, "d": 1}
    assert net.ranking(scores) == [("a", 5), ("b", 3), ("c", 3), ("d", 1)]
    assert net.competition_ranks(scores) == {"a": 1, "b": 2, "c": 2, "d": 4}
    assert net.average_ranks([5, 3, 3, 1]) == [1, 2.5, 2.5, 4]


def test_rank_correlations_by_hand():
    assert net.spearman([1, 2, 3, 4], [1, 2, 3, 4]) == pytest.approx(1)
    assert net.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1)
    # ties: ranks x = [3, 2, 1], y = [2.5, 2.5, 1] -> 1.5 / sqrt(2 * 1.5)
    assert net.spearman([1, 2, 3], [1, 1, 2]) == pytest.approx(1.5 / math.sqrt(3))
    # tau-b: 2 concordant, 0 discordant, 1 pair tied in y only -> 2 / sqrt(2 * 3)
    assert net.kendall_tau_b([1, 2, 3], [1, 1, 2]) == pytest.approx(2 / math.sqrt(6))
    assert net.kendall_tau_b([1, 2, 3], [3, 2, 1]) == pytest.approx(-1)
    assert net.spearman([1, 1], [1, 2]) is None  # no variance


def test_compare_rankings_by_hand():
    ref = {"A": 4, "B": 3, "C": 2, "D": 1}
    other = {"A": 2, "B": 3, "C": 2, "E": 5}
    c = net.compare_rankings(ref, other, k=2)
    rows = {r["airport"]: r for r in c["rows"]}
    # other ranking: E 5 (1), B 3 (2), A 2 (3), C 2 (3)
    assert rows["A"] == {"airport": "A", "score_ref": 4, "score_other": 2, "rank_ref": 1, "rank_other": 3,
                         "rank_change": 2, "score_change_pct": -50.0}
    assert rows["B"]["rank_change"] == 0 and rows["B"]["score_change_pct"] == 0.0
    # union {A, B, E}: x = [4, 3, 0], y = [2, 3, 5] -> perfectly reversed ranks
    assert c["spearman_union_topk"] == -1.0
    assert c["kendall_tau_b_union_topk"] == -1.0
    assert c["jaccard_topk"] == round(1 / 3, 4)
    assert c["entered"] == ["E"] and c["left"] == ["A"]


def test_compare_rankings_missing_airport():
    c = net.compare_rankings({"A": 2, "B": 1}, {"B": 1}, k=2)
    a = next(r for r in c["rows"] if r["airport"] == "A")
    assert a["rank_other"] is None and a["rank_change"] is None and a["score_change_pct"] == -100.0


def test_months_present_counts_only_months_in_the_data():
    monthly = {
        "2026-01": {("A", "B"): 5, ("A", "C"): 1},
        "2026-02": {("A", "B"): 2},
        "2026-04": {("A", "B"): 7, ("A", "C"): 3},   # March is not in the data: not counted as a gap
    }
    assert net.months_present(monthly) == {("A", "B"): 3, ("A", "C"): 2}
    assert net.months_present(monthly, min_flights=3) == {("A", "B"): 2, ("A", "C"): 1}
