"""Batch research runner (Phase 9E).

  python -m experiments.run <definition.json> --out <dir> [--workers N] [--resume]

Runs every condition (sensitivity) or every missingness trial of an experiment definition,
evaluates the impact of stopping each candidate airport (experiments.impact), saves each chunk of
candidates as soon as it is done (so an interrupted run resumes where it stopped), and writes the
statistics and a browser bundle (result.json) that Research Mode > Experiments can import.

The definition format is shared with the browser (src/experiments/model.ts):
{
  "format": "1090web-experiment", "schemaVersion": 1, "experimentId": "...", "name": "...",
  "datasetId": "observed-2026-v2",
  "experimentType": "sensitivity" | "missingness",
  "baseline": {"start": "...Z", "end": "...Z", "tiers": "D", "minFlights": 1, "directed": true,
               "classes": [...], "basis": "all", "region": null},
  "conditions": [{"id": "...", ...overrides of baseline}],          (sensitivity)
  "missingness": {"model": "uniform" | "regional" | "route", ...},  (missingness)
  "candidates": "all" | ["OMDB", ...],
  "computation": {"sources": null | 256, "sourceSeed": 1},
  "randomSeed": 1, "repetitions": 20, "topK": [10, 20]
}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing as mp
import platform
import sys
import time
import traceback
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis.network import kendall_tau_b, spearman  # noqa: E402
from experiments import data as D  # noqa: E402
from experiments import impact as I  # noqa: E402

FORMAT = "1090web-experiment"
RESULT_FORMAT = "1090web-experiment-result"
SCHEMA_VERSION = 1
# 9e.2 (Phase 9I): Spearman / Kendall on values rounded like the ranks (ties as ties)
METHOD_VERSION = "9e.2"
CHUNK = 48
METRICS = ("systemicDrop", "spilloverDrop", "spilloverBefore", "unreachablePairs", "hop1Drop", "hop2Drop", "hop3Drop", "directLost", "flightsLost")


# ---- definition ------------------------------------------------------------------------------------

DEFAULT_BASELINE = {"tiers": "D", "minFlights": 1, "directed": True, "classes": list(D.CLASSES), "basis": "all", "region": None}


def load_definition(path: Path) -> dict:
    d = json.loads(path.read_text(encoding="utf-8"))
    return validate(d)


def validate(d: dict) -> dict:
    if d.get("format") != FORMAT:
        raise ValueError("not a 1090web experiment definition")
    if int(d.get("schemaVersion", 0)) > SCHEMA_VERSION:
        raise ValueError(f"definition schema {d.get('schemaVersion')} is newer than this runner ({SCHEMA_VERSION})")
    if d.get("experimentType") not in ("sensitivity", "missingness"):
        raise ValueError("experimentType must be 'sensitivity' or 'missingness'")
    base = {**DEFAULT_BASELINE, **d.get("baseline", {})}
    for k in ("start", "end"):
        if not isinstance(base.get(k), str):
            raise ValueError(f"baseline.{k} is required (ISO UTC)")
    if base["tiers"] not in D.TIER_SETS:
        raise ValueError("tiers must be A, B, C or D")
    d["baseline"] = base
    d.setdefault("candidates", "all")
    d.setdefault("computation", {"sources": None, "sourceSeed": 1})
    d.setdefault("randomSeed", 1)
    d.setdefault("repetitions", 10)
    d.setdefault("topK", [10, 20])
    if d["experimentType"] == "sensitivity" and not d.get("conditions"):
        raise ValueError("a sensitivity experiment needs conditions")
    if d["experimentType"] == "missingness":
        m = d.get("missingness") or {}
        if m.get("model") not in ("uniform", "regional", "route"):
            raise ValueError("missingness.model must be uniform, regional or route")
        for r in [m.get("rate", 0), *m.get("regionRates", {}).values(), m.get("otherRate", 0), *(m.get("lowFrequency", {}) or {}).values()]:
            if isinstance(r, (int, float)) and not isinstance(r, bool) and not (0 <= r <= 1) and r != m.get("lowFrequency", {}).get("threshold"):
                raise ValueError(f"missingness rate {r} is outside [0, 1]")
    return d


def definition_hash(d: dict) -> str:
    keep = {k: d[k] for k in sorted(d) if k not in ("name", "experimentId", "description")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def runs_of(d: dict) -> list[dict]:
    """Every run of the experiment: conditions (sensitivity) or trial 0 + trials 1..R (missingness)."""
    base = d["baseline"]
    if d["experimentType"] == "sensitivity":
        return [{"runId": f"c{i:02d}", "label": c.get("id", f"condition {i}"), "kind": "condition", "trial": 0,
                 "conditions": {**base, **{k: v for k, v in c.items() if k != "id"}}} for i, c in enumerate(d["conditions"])]
    reps = int(d["repetitions"])
    return [{"runId": "t0000", "label": "reference (no added missingness)", "kind": "reference", "trial": 0, "conditions": base}] + [
        {"runId": f"t{t:04d}", "label": f"trial {t}", "kind": "trial", "trial": t, "conditions": base} for t in range(1, reps + 1)]


# ---- workers ---------------------------------------------------------------------------------------

_PREP: I.Prepared | None = None


def _init(n, src, dst, weight, directed, sources):
    global _PREP
    _PREP = I.prepare(n, src, dst, weight, directed, sources)


def _chunk(cands: np.ndarray) -> dict:
    t0 = time.time()
    r = I.evaluate(_PREP, cands)
    return {"candidates": cands.tolist(), **{k: v.tolist() for k, v in r.items()}, "seconds": round(time.time() - t0, 3)}


# ---- running -----------------------------------------------------------------------------------------

def run(def_path: Path, out: Path, workers: int, resume: bool, log=print) -> dict:
    d = load_definition(def_path)
    out.mkdir(parents=True, exist_ok=True)
    h = definition_hash(d)
    state_file = out / "definition.json"
    if state_file.exists():
        prev = json.loads(state_file.read_text(encoding="utf-8"))
        if prev.get("hash") != h and resume:
            raise ValueError("the output folder holds another experiment; use a new --out or drop --resume")
    state_file.write_text(json.dumps({"hash": h, "definition": d}, indent=1), encoding="utf-8")
    ds = D.load_dataset(d["datasetId"])
    nA = len(ds.airport_ids)
    base = d["baseline"]
    fl = D.load_flights(ds, base["start"], base["end"])
    log(f"[data] {len(fl):,} flights {base['start']} .. {base['end']}")

    def network_for(c: dict, keep: np.ndarray | None) -> D.Network:
        f = fl if (c["start"], c["end"]) == (base["start"], base["end"]) else D.load_flights(ds, c["start"], c["end"])
        m = D.select(f, keep if f is fl else None, c["tiers"], c["classes"], c["basis"])
        if c.get("region"):
            cont = np.array(ds.continents)
            m &= (cont[f.org] == c["region"]) | (cont[f.dst] == c["region"])
        return D.build_network(f, m, int(c["minFlights"]), bool(c["directed"]), nA)

    runs = runs_of(d)
    # the reference network fixes the candidates (and, for missingness, the node set)
    ref_net = network_for(runs[0]["conditions"], None)
    if d["candidates"] == "all":
        cand_global = ref_net.nodes.copy()
    else:
        pos = {a: i for i, a in enumerate(ds.airport_ids)}
        cand_global = np.array(sorted(pos[a] for a in d["candidates"] if a in pos), dtype=np.int64)
    ref_mask = D.select(fl, None, base["tiers"], base["classes"], base["basis"])
    ref_pairs = D.pair_flights(fl, ref_mask, nA)
    comp = d["computation"]
    seed = int(d["randomSeed"])
    started = time.time()
    for ri, r in enumerate(runs):
        run_file = out / "runs" / f"{r['runId']}.json"
        if resume and run_file.exists():
            log(f"[{ri + 1}/{len(runs)}] {r['label']}: already done")
            continue
        t_run = time.time()
        keep = D.missingness_keep(fl, d.get("missingness"), seed, r["trial"], ds, ref_pairs, nA) if d["experimentType"] == "missingness" else None
        net = network_for(r["conditions"], keep)
        if d["experimentType"] == "missingness":
            nodes = ref_net.nodes
            src, dst, w = D.on_nodes(net, nodes)
        else:
            nodes, src, dst, w = net.nodes, net.src, net.dst, net.weight
        n = len(nodes)
        local = {int(g): i for i, g in enumerate(nodes)}
        present = [g for g in cand_global.tolist() if g in local]
        cand_local = np.array([local[g] for g in present], dtype=np.int64)
        sources = I.sample_sources(n, comp.get("sources"), int(comp.get("sourceSeed", 1)))
        chunk_dir = out / "chunks" / r["runId"]
        chunk_dir.mkdir(parents=True, exist_ok=True)
        chunks = [cand_local[i:i + CHUNK] for i in range(0, len(cand_local), CHUNK)]
        todo = [(i, c) for i, c in enumerate(chunks) if not (resume and (chunk_dir / f"{i:04d}.json").exists())]
        errors = []
        if todo:
            with mp.get_context("spawn").Pool(workers, initializer=_init, initargs=(n, src, dst, w, bool(r["conditions"]["directed"]), sources)) as pool:
                pending = {i: pool.apply_async(_chunk, (c,)) for i, c in todo}
                done = len(chunks) - len(todo)
                for i, res in pending.items():
                    try:
                        (chunk_dir / f"{i:04d}.json").write_text(json.dumps(res.get()), encoding="utf-8")
                    except Exception:  # noqa: BLE001 - recorded, the run is marked incomplete
                        errors.append({"chunk": i, "error": traceback.format_exc(limit=3)})
                    done += 1
                    log(f"[{ri + 1}/{len(runs)}] {r['label']}: {min(done * CHUNK, len(cand_local))}/{len(cand_local)} candidates "
                        f"({'exact' if sources is None else f'{len(sources)} sources'}) {time.time() - t_run:.0f}s")
        vals = {k: np.zeros(len(cand_local)) for k in METRICS}
        complete = not errors
        for i, c in enumerate(chunks):
            f = chunk_dir / f"{i:04d}.json"
            if not f.exists():
                complete = False
                continue
            res = json.loads(f.read_text(encoding="utf-8"))
            for k in METRICS:
                vals[k][i * CHUNK:i * CHUNK + len(c)] = res[k]
        degree0 = np.zeros(n, dtype=bool)
        np.logical_or.at(degree0, src, True)
        np.logical_or.at(degree0, dst, True)
        rec = {
            **r, "nodes": n, "arcs": int(len(src)), "flights": int(net.flights), "pairs": int(net.pairs),
            "exact": sources is None, "sources": n if sources is None else int(len(sources)), "sourceSeed": comp.get("sourceSeed", 1),
            "randomSeed": seed, "complete": complete, "errors": errors, "seconds": round(time.time() - t_run, 1),
            "candidates": [ds.airport_ids[g] for g in present],
            "isolated": [ds.airport_ids[g] for g in present if not degree0[local[g]]],
            "values": {k: [float(x) for x in vals[k]] for k in METRICS},
        }
        run_file.parent.mkdir(parents=True, exist_ok=True)
        run_file.write_text(json.dumps(rec), encoding="utf-8")
        log(f"[{ri + 1}/{len(runs)}] {r['label']}: done in {rec['seconds']}s ({n} airports, {rec['arcs']} arcs){'' if complete else ' INCOMPLETE'}")
    result = summarize(d, h, ds, out, [ds.airport_ids[g] for g in cand_global.tolist()])
    (out / "result.json").write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    write_csv(result, out / "rankings.csv")
    log(f"[done] {len(runs)} runs in {time.time() - started:.0f}s -> {out / 'result.json'}")
    return result


# ---- statistics --------------------------------------------------------------------------------------

def competition(values: list[float]) -> list[int]:
    """'1224' ranks, largest first (ties: same best rank) on values rounded like the browser."""
    v = [I.rank_value(x) for x in values]
    order = sorted(range(len(v)), key=lambda i: (-v[i], i))
    ranks = [0] * len(v)
    prev, rank = None, 0
    for pos, i in enumerate(order):
        if v[i] != prev:
            rank, prev = pos + 1, v[i]
        ranks[i] = rank
    return ranks


def topk_overlap(a: list[float], b: list[float], k: int) -> tuple[float, float]:
    ta = set(sorted(range(len(a)), key=lambda i: (-I.rank_value(a[i]), i))[:k])
    tb = set(sorted(range(len(b)), key=lambda i: (-I.rank_value(b[i]), i))[:k])
    return len(ta & tb) / k, len(ta & tb) / len(ta | tb) if ta | tb else 1.0


def quantiles(x: np.ndarray) -> dict:
    return {"mean": float(x.mean()), "median": float(np.median(x)), "sd": float(x.std(ddof=1)) if len(x) > 1 else 0.0,
            "p05": float(np.quantile(x, 0.05)), "p25": float(np.quantile(x, 0.25)), "p75": float(np.quantile(x, 0.75)),
            "p95": float(np.quantile(x, 0.95)), "min": float(x.min()), "max": float(x.max())}


def summarize(d: dict, h: str, ds: D.Dataset, out: Path, candidates: list[str]) -> dict:
    runs = [json.loads((out / "runs" / f"{r['runId']}.json").read_text(encoding="utf-8")) for r in runs_of(d) if (out / "runs" / f"{r['runId']}.json").exists()]
    idx = {a: i for i, a in enumerate(candidates)}
    C = len(candidates)
    # every run on the fixed candidate list: absent from a run's graph -> impact 0 (recorded)
    full = []
    for r in runs:
        m = {k: np.zeros(C) for k in METRICS}
        for j, a in enumerate(r["candidates"]):
            for k in METRICS:
                m[k][idx[a]] = r["values"][k][j]
        full.append(m)
    ranks = [{"sys": competition(m["systemicDrop"].tolist()), "spill": competition(m["spilloverDrop"].tolist())} for m in full]
    ref = full[0]
    ks = d["topK"]
    ref_present = {idx[a] for a in runs[0]["candidates"]} if runs else set()
    for r, m in zip(runs, full):
        present = [idx[a] for a in r["candidates"]]
        cmp = {}
        for key, metric in (("systemic", "systemicDrop"), ("spillover", "spilloverDrop")):
            # rank correlations on the same rounded values as the ranks (9e.2): exact zeros computed
            # as tiny +-1e-17 differences must tie, not be ordered by floating-point noise
            x, y = [I.rank_value(v) for v in ref[metric].tolist()], [I.rank_value(v) for v in m[metric].tolist()]
            both = [i for i in present if i in ref_present]
            entry = {
                "spearman": _r(spearman(x, y)), "kendall": _r(kendall_tau_b(x, y)),
                "spearmanCommon": _r(spearman([x[i] for i in both], [y[i] for i in both])) if len(both) > 2 else None,
            }
            for k in ks:
                ov, jac = topk_overlap(x, y, k)
                entry[f"top{k}"], entry[f"jaccard{k}"] = round(ov, 4), round(jac, 4)
            cmp[key] = entry
        r["comparison"] = cmp
        r["absent"] = C - len(present)
        del r["values"]
        del r["candidates"]
    # Systemic vs Spillover agreement in the reference run
    rs = [I.rank_value(v) for v in ref["systemicDrop"].tolist()]
    rp = [I.rank_value(v) for v in ref["spilloverDrop"].tolist()]
    sys_spill = {"spearman": _r(spearman(rs, rp)), "kendall": _r(kendall_tau_b(rs, rp))}
    for k in ks:
        sys_spill[f"top{k}"] = round(topk_overlap(ref["systemicDrop"].tolist(), ref["spilloverDrop"].tolist(), k)[0], 4)
    airports_json = json.loads((D.ROOT / "public" / "data" / ds.dataset_id / "airports.json").read_text(encoding="utf-8"))
    meta = {a["id"]: a for a in airports_json}
    trials = [i for i, r in enumerate(runs) if r["kind"] == "trial"]
    present_by_run = [set(r.get("isolated", [])) for r in runs]
    airports = []
    for a in candidates:
        i = idx[a]
        row = {
            "id": a, "iata": meta[a].get("iata"), "name": meta[a].get("name"), "country": meta[a].get("country"),
            "continent": ds.continents[ds.airport_ids.index(a)], "lat": meta[a].get("lat"), "lon": meta[a].get("lon"),
            "ref": {k: _r(float(ref[k][i]), 9) for k in METRICS} | {"rankSystemic": ranks[0]["sys"][i], "rankSpillover": ranks[0]["spill"][i]},
            "runs": {
                "systemic": [_r(float(m["systemicDrop"][i]), 9) for m in full],
                "spillover": [_r(float(m["spilloverDrop"][i]), 9) for m in full],
                "rankSystemic": [rk["sys"][i] for rk in ranks],
                "rankSpillover": [rk["spill"][i] for rk in ranks],
            },
            "isolatedIn": [runs[j]["runId"] for j in range(len(runs)) if a in present_by_run[j]],
        }
        sel = trials or list(range(len(runs)))
        for key, metric, rk in (("systemic", "systemicDrop", "sys"), ("spillover", "spilloverDrop", "spill")):
            vals = np.array([full[j][metric][i] for j in sel])
            rks = np.array([ranks[j][rk][i] for j in sel], dtype=float)
            row[f"{key}Stats"] = {k: _r(v, 9) for k, v in quantiles(vals).items()}
            row[f"{key}RankStats"] = {k: _r(v, 3) for k, v in quantiles(rks).items()}
            for k in ks:
                row[f"{key}Top{k}Share"] = round(float((rks <= k).mean()), 4)
        airports.append(row)
    return {
        "format": RESULT_FORMAT, "schemaVersion": SCHEMA_VERSION, "methodVersion": METHOD_VERSION,
        "definitionHash": h, "definition": d,
        "dataset": {"id": ds.dataset_id, "version": ds.version, "continentRule": ds.continent_rule},
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "python batch (pipeline/experiments)",
        "environment": {"runtime": "python", "python": platform.python_version(), "numpy": np.__version__, "platform": platform.system()},
        "computation": {
            "exact": all(r["exact"] for r in runs), "sources": sorted({r["sources"] for r in runs}),
            "sourceSeed": d["computation"].get("sourceSeed", 1), "randomSeed": d["randomSeed"],
            "note": "exact = every airport is a BFS source; otherwise efficiency and pair counts are estimates from the sampled sources (same sources for every candidate)",
        },
        "candidates": {"count": C, "rule": d["candidates"] if d["candidates"] != "all" else "all airports of the reference network"},
        "complete": all(r["complete"] for r in runs) and len(runs) == len(runs_of(d)),
        "runs": runs,
        "systemicVsSpillover": sys_spill,
        "airports": airports,
        "interpretation": {
            "sensitivity": "rankings under other data-selection conditions; not an estimate of observation error",
            "missingness": "added, assumed missingness on observed flights; the distribution is not a confidence interval for the true network",
            "approximation": "sampling error of the BFS sources is separate from missingness variation",
        },
    }


def _r(x, nd=4):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(x, nd)


def write_csv(result: dict, path: Path) -> None:
    lines = ["definition_hash,run_id,run_label,airport_id,iata,systemic_drop,spillover_drop,rank_systemic,rank_spillover,exact,sources"]
    for j, r in enumerate(result["runs"]):
        for a in result["airports"]:
            lines.append(",".join(str(x) for x in [result["definitionHash"], r["runId"], f"\"{r['label']}\"", a["id"], a["iata"] or "",
                                                     a["runs"]["systemic"][j], a["runs"]["spillover"][j], a["runs"]["rankSystemic"][j],
                                                     a["runs"]["rankSpillover"][j], r["exact"], r["sources"]]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="1090web batch research experiments (Phase 9E)")
    ap.add_argument("definition", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=max(1, (mp.cpu_count() or 2) - 1))
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    run(a.definition, a.out, a.workers, a.resume)


if __name__ == "__main__":
    main()
