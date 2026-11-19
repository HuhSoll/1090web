"""Phase 9I: the independent check scripts on hand-computable inputs."""
from __future__ import annotations

import math

import numpy as np
from scipy.sparse import csr_matrix

from research_validation import event_series as E
from research_validation import island_access as IA
from research_validation import network_impact as N


def test_newey_west_lag_and_zero_autocorrelation():
    assert E.nw_lag(14) == 2
    assert E.nw_lag(100) == 4
    # a perfect line has zero residuals: the OLS slope is exact
    slope, _ = E.ols_t(np.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.1]))
    assert math.isclose(slope, 1.0 + 0.1 * (5 - 2.5) / 17.5, rel_tol=1e-12)


def test_newey_west_against_ols_on_white_noise_scale():
    # with lag 0 the HAC variance equals the White variance; on residuals of equal size it is near OLS
    y = np.array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1], float) * 0.1 + np.arange(10) * 0.5
    t0 = E.newey_west_t(y, 0)
    _, t_ols = E.ols_t(y)
    assert t0 > 0 and t_ols > 0
    assert abs(t0 / t_ols - 1) < 0.5


def test_efficiency_on_a_path_graph():
    # 0 - 1 - 2 directed both ways: distances 1, 2, 1 / 2, 1 ... efficiency = (1 + 1/2 + 1 + 1 + 1/2 + 1) / 6
    g = csr_matrix((np.ones(4), ([0, 1, 1, 2], [1, 0, 2, 1])), shape=(3, 3))
    inv = N.inv_dist(g)
    assert math.isclose(inv.sum() / 6, 5 / 6)
    # stopping the middle airport: no pair is reachable; Systemic = 5/6 on the same 6 pairs
    after = N.inv_dist(N.without(g, 1))
    assert after.sum() == 0
    # Spillover of the middle airport: pairs of {0, 2}: before 1/2 each way, after 0
    mask = np.array([True, False, True])
    m = 2 * 1
    assert math.isclose(inv[np.ix_(mask, mask)].sum() / m, 0.5)


def test_island_reachability_follows_frequency():
    net = {
        "gateways": [{"id": "A"}, {"id": "B"}, {"id": "P"}, {"id": "D"}],
        "services": [
            {"id": "s1", "a": "A", "b": "D", "roundTripsPerWeek": 14, "status": "operating"},
            {"id": "s2", "a": "P", "b": "D", "roundTripsPerWeek": 2, "status": "operating"},
            {"id": "s3", "a": "B", "b": "D", "roundTripsPerWeek": 7, "status": "suspended"},
        ],
        "roadLinks": {"withBridges": [[0, 2, 10]], "noBridges": []},
        "destinations": [{"id": "dest", "nodes": ["D"]}],
    }
    assert IA.reachable(net, set(), "daily", "dest") >= {0, 2, 3}
    # airport A stopped: daily services no longer reach D, a twice-weekly ship from the port P does
    assert 0 not in IA.reachable(net, {"A"}, "daily", "dest")
    assert 0 in IA.reachable(net, {"A"}, "weekly", "dest")
    # a suspended service never counts
    assert 1 not in IA.reachable(net, set(), "any", "dest")
