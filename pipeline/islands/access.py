"""
Access model of the island lab (Phase 9F), model A ("network availability").

Same algorithm as src/islands/access.ts (checked against each other in the tests). It reads the
published files (network.json, meshes.json) so the browser and the report use the same data.

For every inhabited mesh and a destination it finds
  - whether the destination can be reached with the allowed services (reachability), and
  - the shortest travel time over legs whose duration is verified (road access with assumed
    speeds + assumed terminal / transfer times + scheduled in-vehicle time). Waiting for a
    departure is NOT included: there is no verified timetable, only the number of services.

Statuses of a mesh:
  ok              reachable, time computed
  time-unknown    reachable, but the time cannot be computed: every route uses a leg whose duration
                  is not verified, or a route with fewer legs exists whose duration is not verified
                  (then the time of the verified route is only an upper bound, kept as `bound`)
  unreachable     no route with the allowed services
  no-access       the mesh has no road connection to any gateway (cannot be computed)
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

LEVEL_MIN_PER_WEEK = {"any": 1e-9, "weekly": 1.0, "daily": 7.0}
MODES = ("air", "sea")


@dataclass
class Scenario:
    destination: str = "naha"
    air: bool = True
    sea: bool = True
    service_level: str = "any"          # any | weekly | daily
    bridges: bool = True
    include_seasonal: bool = False
    stopped_airports: list[str] = field(default_factory=list)
    stopped_services: list[str] = field(default_factory=list)
    time_budget_min: float | None = None

    @staticmethod
    def of(d: dict) -> "Scenario":
        return Scenario(**{k: v for k, v in d.items() if k in Scenario.__dataclass_fields__})


def usable_services(net: dict, sc: Scenario) -> list[dict]:
    out = []
    stopped = set(sc.stopped_airports)
    for s in net["services"]:
        if s.get("status") == "suspended":
            continue
        if s.get("status") == "seasonal" and not sc.include_seasonal:
            continue
        if not (sc.air if s["mode"] == "air" else sc.sea):
            continue
        if s["roundTripsPerWeek"] < LEVEL_MIN_PER_WEEK[sc.service_level]:
            continue
        if s["a"] in stopped or s["b"] in stopped or s["id"] in sc.stopped_services:
            continue
        out.append(s)
    return out


def _mid(d) -> float | None:
    return None if d is None else (d[0] + d[1]) / 2


def gateway_results(net: dict, sc: Scenario) -> dict[str, dict]:
    """Best route from every gateway to the destination."""
    ids = [g["id"] for g in net["gateways"]]
    idx = {g: i for i, g in enumerate(ids)}
    dest = next(d for d in net["destinations"] if d["id"] == sc.destination)
    targets = {idx[n] for n in dest["nodes"] if n in idx}
    adj: list[list[tuple]] = [[] for _ in ids]   # (to, kind, mode, minutes|None, freq, service id)
    for s in usable_services(net, sc):
        a, b = idx[s["a"]], idx[s["b"]]
        m = _mid(s.get("durationMin"))
        adj[a].append((b, "service", s["mode"], m, s["roundTripsPerWeek"], s["id"]))
        adj[b].append((a, "service", s["mode"], m, s["roundTripsPerWeek"], s["id"]))
    for i, j, t in net["roadLinks"]["withBridges" if sc.bridges else "noBridges"]:
        adj[i].append((j, "road", "road", t, float("inf"), None))
        adj[j].append((i, "road", "road", t, float("inf"), None))
    term = net["assumptions"]["terminalMin"]
    trans = net["assumptions"]["transferMin"]

    out = {}
    for g in range(len(ids)):
        # reachability and fewest service legs (BFS over all usable edges, durations ignored)
        best_legs = {g: 0}
        dq = [(0, g)]
        reach_legs = None
        reach_path = None
        prev_r = {g: None}
        while dq:
            legs, u = heapq.heappop(dq)
            if legs > best_legs.get(u, 1e9):
                continue
            if u in targets:
                reach_legs = legs
                reach_path = u
                break
            for v, kind, mode, minutes, freq, sid in adj[u]:
                nl = legs + (1 if kind == "service" else 0)
                if nl < best_legs.get(v, 1e9):
                    best_legs[v] = nl
                    prev_r[v] = (u, sid, freq, mode)
                    heapq.heappush(dq, (nl, v))
        r = {"reachable": reach_legs is not None, "time": None, "legs": reach_legs, "fewestLegs": reach_legs, "minFreq": None,
             "path": [], "firstMode": None, "board": None}
        if reach_legs is not None:
            path, f = [], float("inf")
            x = reach_path
            while prev_r[x] is not None:
                u, sid, freq, mode = prev_r[x]
                if sid:
                    path.append(sid)
                    f = min(f, freq)
                    r["firstMode"] = mode
                    r["board"] = ids[u]
                x = u
            r["path"] = path[::-1]
            r["minFreq"] = None if f == float("inf") else f
        # shortest known time (state: node, mode of the last service leg)
        if r["reachable"]:
            start = (g, "none")
            dist = {start: (0.0, 0)}
            prev = {start: None}
            pq = [(0.0, 0, g, "none")]
            found = None
            while pq:
                t, legs, u, last = heapq.heappop(pq)
                if (t, legs) > dist.get((u, last), (1e18, 0)):
                    continue
                if u in targets:
                    found = (u, last)
                    break
                for v, kind, mode, minutes, freq, sid in adj[u]:
                    if minutes is None:
                        continue
                    if kind == "road":
                        nt, nlast, nl = t + minutes, last, legs
                    else:
                        extra = term[mode] if last == "none" else trans[f"{last}-{mode}"]
                        nt, nlast, nl = t + extra + minutes, mode, legs + 1
                    key = (v, nlast)
                    if (nt, nl) < dist.get(key, (1e18, 0)):
                        dist[key] = (nt, nl)
                        prev[key] = ((u, last), sid, freq, mode)
                        heapq.heappush(pq, (nt, nl, v, nlast))
            if found is not None:
                t, legs = dist[found]
                path, f, first, board = [], float("inf"), None, None
                x = found
                while prev[x] is not None:
                    px, sid, freq, mode = prev[x]
                    if sid:
                        path.append(sid)
                        f = min(f, freq)
                        first, board = mode, ids[px[0]]
                    x = px
                r.update(time=round(t, 3), legs=legs, path=path[::-1], minFreq=None if f == float("inf") else f, firstMode=first,
                         board=board)
        out[ids[g]] = r
    return out


def evaluate(net: dict, meshes: dict, sc: Scenario) -> list[dict]:
    """Per mesh: status, time (min), legs, minFreq (round trips / week of the scarcest leg), the gateway
    reached by road (`gateway`), and where the first service is boarded (`board`)."""
    gw = gateway_results(net, sc)
    ids = [g["id"] for g in net["gateways"]]
    col = {c: i for i, c in enumerate(meshes["columns"])}
    acc_key = "accessWith" if sc.bridges else "accessNo"
    out = []
    for row in meshes["rows"]:
        if row[col["island"]] is None:
            out.append({"status": "unassigned"})
            continue
        acc = row[col[acc_key]]
        if not acc:
            out.append({"status": "no-access"})
            continue
        best, best_reach, fewest = None, None, None
        for gi, a in acc:
            r = gw[ids[gi]]
            if not r["reachable"]:
                continue
            cand_r = (r["legs"], -(r["minFreq"] or 0), a)
            if best_reach is None or cand_r < best_reach[0]:
                best_reach = (cand_r, gi, r)
            f = r["fewestLegs"]
            fewest = f if fewest is None else min(fewest, f)
            if r["time"] is not None:
                tot = a + r["time"]
                key = (round(tot, 6), r["legs"])
                if best is None or key < best[0]:
                    best = (key, gi, r, tot)
        if best is not None and best[2]["legs"] > fewest:
            # a route with fewer legs exists but its duration is unknown: the time is only a bound
            _, gi, r, tot = best
            out.append({"status": "time-unknown", "time": None, "bound": round(tot, 3), "legs": r["legs"], "minFreq": r["minFreq"],
                        "gateway": ids[gi], "board": r["board"], "firstMode": r["firstMode"], "path": r["path"]})
        elif best is not None:
            _, gi, r, tot = best
            out.append({"status": "ok", "time": round(tot, 3), "legs": r["legs"], "minFreq": r["minFreq"],
                        "gateway": ids[gi], "board": r["board"], "firstMode": r["firstMode"], "path": r["path"]})
        elif best_reach is not None:
            _, gi, r = best_reach
            out.append({"status": "time-unknown", "time": None, "legs": r["legs"], "minFreq": r["minFreq"],
                        "gateway": ids[gi], "board": r["board"], "firstMode": r["firstMode"], "path": r["path"]})
        else:
            out.append({"status": "unreachable"})
    return out


RANK = {"ok": 3, "time-unknown": 2, "unreachable": 1}


def change(b: dict, a: dict) -> str:
    """How the access of one mesh changed.

    lost            reachable before, unreachable after
    slower          time computed before and after, and longer after
    fewer-services  the best route has more legs or a scarcer service (fewer round trips per week)
    undetermined    reachable before and after, but a time is missing (cannot be compared)
    better / same   no worsening
    n/a             the mesh cannot be computed (no island or no road access)
    """
    if b["status"] in ("unassigned", "no-access") or a["status"] in ("unassigned", "no-access"):
        return "n/a"
    if b["status"] != "unreachable" and a["status"] == "unreachable":
        return "lost"
    if b["status"] == "unreachable":
        return "same" if a["status"] == "unreachable" else "better"
    if b["status"] == "ok" and a["status"] == "ok":
        if a["time"] > b["time"] + 0.5:
            return "slower"
        if a["time"] < b["time"] - 0.5:
            return "better"
    worse_service = (a.get("minFreq") or 0) < (b.get("minFreq") or 0) - 1e-9 or (a.get("legs") or 0) > (b.get("legs") or 0)
    if b["status"] == "ok" and a["status"] == "ok":
        return "fewer-services" if worse_service else "same"
    if b == a or (b.get("path") == a.get("path") and b["status"] == a["status"]):
        return "same"
    return "undetermined"


def compare(net: dict, meshes: dict, base: Scenario, after: Scenario) -> dict:
    """Population-weighted comparison of two scenarios (same meshes, same population)."""
    col = {c: i for i, c in enumerate(meshes["columns"])}
    eb, ea = evaluate(net, meshes, base), evaluate(net, meshes, after)
    budget = after.time_budget_min
    tot: dict[str, dict] = {}
    rows = []
    for row, b, a in zip(meshes["rows"], eb, ea):
        isl = row[col["island"]]
        pop = row[col["pop"]]
        if isl is None:
            continue
        ch = change(b, a)
        rows.append((row[col["code"]], isl, pop, b, a, ch))
        for key in (isl, "_all"):
            t = tot.setdefault(key, {"pop": 0, "exposed": 0, "lost": 0, "slower": 0, "undetermined": 0, "fewerServices": 0,
                                     "noAccess": 0, "unreachableBefore": 0, "unreachableAfter": 0, "personMinutes": 0.0,
                                     "deltaPop": 0, "deltaMax": 0.0, "lostWithinBudget": 0, "withinBudgetBefore": 0,
                                     "withinBudgetAfter": 0, "computablePop": 0})
            t["pop"] += pop
            if ch == "n/a":
                t["noAccess"] += pop
                continue
            if b["status"] == "unreachable":
                t["unreachableBefore"] += pop
            if a["status"] == "unreachable":
                t["unreachableAfter"] += pop
            if ch in ("lost", "slower", "fewer-services"):
                t["exposed"] += pop
            if ch == "lost":
                t["lost"] += pop
            elif ch == "slower":
                t["slower"] += pop
            elif ch == "undetermined":
                t["undetermined"] += pop
            elif ch == "fewer-services":
                t["fewerServices"] += pop
            if b["status"] == "ok" and a["status"] == "ok":
                d = a["time"] - b["time"]
                t["computablePop"] += pop
                if d > 0.5:
                    t["personMinutes"] += pop * d
                    t["deltaPop"] += pop
                    t["deltaMax"] = max(t["deltaMax"], d)
            if budget is not None:
                wb = b["status"] == "ok" and b["time"] <= budget
                wa = a["status"] == "ok" and a["time"] <= budget
                t["withinBudgetBefore"] += pop if wb else 0
                t["withinBudgetAfter"] += pop if wa else 0
                t["lostWithinBudget"] += pop if (wb and not wa) else 0
    for t in tot.values():
        t["meanDeltaMin"] = round(t["personMinutes"] / t["deltaPop"], 2) if t["deltaPop"] else None
        t["personMinutes"] = round(t["personMinutes"], 1)
        t["deltaMax"] = round(t["deltaMax"], 2)
    return {"totals": tot, "rows": rows}
