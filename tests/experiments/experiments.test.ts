import { describe, expect, it } from 'vitest';
import fixture from './crosscheck.fixture.json';
import { evaluateCriticality, sampleSources } from '../../src/experiments/criticality';
import { applyMissingness, combine, rng, trialSeed } from '../../src/experiments/missingness';
import {
  checkImport, definitionHash, definitionProblems, estimateCost, newDefinition, runsOf, toBatchDefinition,
  type ExperimentDefinition,
} from '../../src/experiments/model';
import { competition, describe as describeStats, quantile, summarize, topkOverlap, type RawRun } from '../../src/experiments/summarize';
import { computeImpact } from '../../src/simulation/impact';
import { defaultConfig } from '../../src/research/model';
import type { ResearchMonth } from '../../src/research/data';

const i32 = (x: number[]) => Int32Array.from(x);

function randomGraph(n: number, m: number, seed: number) {
  const r = rng(seed);
  return { src: i32(Array.from({ length: m }, () => Math.floor(r() * n))), dst: i32(Array.from({ length: m }, () => Math.floor(r() * n))) };
}

describe('criticality: definitions', () => {
  it('matches the Phase 9C impact (one airport stopped) for every candidate', () => {
    for (const directed of [true, false]) {
      const n = 30;
      const e = randomGraph(n, 75, directed ? 4 : 5);
      const res = evaluateCriticality({ n, directed, ...e, candidates: i32([...Array(n).keys()]), sources: null });
      for (let v = 0; v < n; v++) {
        const keep = [...e.src.keys()].filter((i) => e.src[i] !== v && e.dst[i] !== v);
        const imp = computeImpact({ n, directed, before: e, after: { src: i32(keep.map((i) => e.src[i]!)), dst: i32(keep.map((i) => e.dst[i]!)) }, targets: i32([v]), excludedPairs: i32([]) });
        expect(res.systemicDrop[v]).toBeCloseTo(imp.total.before.efficiency - imp.total.after.efficiency, 12);
        expect(res.spilloverDrop[v]).toBeCloseTo(imp.spillover.before.efficiency - imp.spillover.after.efficiency, 12);
        expect(res.unreachablePairs[v]).toBeCloseTo(imp.hopChange.lost, 9);
      }
    }
  });

  it('star: the hub disconnects every leaf pair; an isolated airport has no impact', () => {
    const src = i32([0, 0, 0, 0, 1, 2, 3, 4]);
    const dst = i32([1, 2, 3, 4, 0, 0, 0, 0]);
    const r = evaluateCriticality({ n: 6, directed: true, src, dst, weight: new Float64Array(8).fill(2), candidates: i32([0, 1, 5]), sources: null });
    expect(r.unreachablePairs[0]).toBe(12);
    expect(r.directLost[0]).toBe(4);
    expect(r.flightsLost[0]).toBe(16);
    expect(r.spilloverDrop[1]).toBe(0);
    expect(r.systemicDrop[2]).toBe(0);
    expect(r.spilloverDrop[2]).toBe(0);
  });

  it('sampled with every airport as a source equals exact; same sources for every candidate', () => {
    const n = 40;
    const e = randomGraph(n, 120, 9);
    const c = i32([...Array(n).keys()]);
    const a = evaluateCriticality({ n, directed: true, ...e, candidates: c, sources: null });
    const b = evaluateCriticality({ n, directed: true, ...e, candidates: c, sources: i32([...Array(n).keys()]) });
    for (let i = 0; i < n; i++) expect(b.spilloverDrop[i]).toBeCloseTo(a.spilloverDrop[i]!, 14);
    expect(Array.from(sampleSources(n, 10, 5)!)).toEqual(Array.from(sampleSources(n, 10, 5)!));
    expect(sampleSources(n, null, 1)).toBeNull();
    expect(sampleSources(n, 99, 1)).toBeNull();
  });

  it('candidate order does not change any value', () => {
    const n = 25;
    const e = randomGraph(n, 60, 11);
    const sources = sampleSources(n, 8, 3);
    const a = evaluateCriticality({ n, directed: true, ...e, candidates: i32([...Array(n).keys()]), sources });
    const perm = [...Array(n).keys()].reverse();
    const b = evaluateCriticality({ n, directed: true, ...e, candidates: i32(perm), sources });
    perm.forEach((v, i) => expect(b.spilloverDrop[i]).toBe(a.spilloverDrop[v]));
  });
});

describe('criticality: Python cross-check (pipeline/experiments/impact.py)', () => {
  const keys = ['systemicDrop', 'spilloverDrop', 'spilloverBefore', 'unreachablePairs', 'hop1Drop', 'hop2Drop', 'hop3Drop', 'directLost', 'flightsLost'] as const;
  for (const [i, f] of (fixture as { n: number; directed: boolean; src: number[]; dst: number[]; weight: number[]; k: number | null; sourceSeed: number; sources: number[] | null; result: Record<string, number[]> }[]).entries()) {
    it(`case ${i}: n=${f.n} ${f.directed ? 'directed' : 'undirected'} ${f.k === null ? 'exact' : `${f.k} sources`}`, () => {
      const sources = sampleSources(f.n, f.k, f.sourceSeed);
      expect(sources === null ? null : Array.from(sources)).toEqual(f.sources);
      const r = evaluateCriticality({ n: f.n, directed: f.directed, src: i32(f.src), dst: i32(f.dst), weight: Float64Array.from(f.weight), candidates: i32([...Array(f.n).keys()]), sources });
      for (const k of keys) for (let v = 0; v < f.n; v++) expect(r[k][v]).toBeCloseTo(f.result[k]![v]!, 10);
    });
  }
});

// ---- missingness -----------------------------------------------------------------------------------

function month(rows: number, flights: number): ResearchMonth {
  const r = rng(1);
  return {
    month: '2026-03', observedDays: 31, daysInMonth: 31, size: rows,
    route: i32(Array.from({ length: rows }, (_, i) => i % 50)), dir: Uint8Array.from({ length: rows }, (_, i) => i % 2),
    carrier: new Int32Array(rows), carriers: ['X'], tier: new Uint8Array(rows).fill(1),
    passenger: Float64Array.from({ length: rows }, () => 1 + Math.floor(r() * flights)), cargo: new Float64Array(rows), unknown: new Float64Array(rows).fill(1),
    inconsistencies: 0,
  };
}
const ctx = {
  ends: (rid: number) => [rid % 10, 10 + (rid % 7)] as const,
  continentOf: Array.from({ length: 20 }, (_, i) => (i < 10 ? 'EU' : 'AS')),
  routeFlights: new Map(Array.from({ length: 50 }, (_, i) => [i, i < 25 ? 2 : 40])),
};
const total = (m: ResearchMonth) => [...m.passenger, ...m.cargo, ...m.unknown].reduce((a, b) => a + b, 0);

describe('missingness', () => {
  const m = month(400, 30);
  it('0% keeps everything, 100% removes everything, trial 0 is the reference', () => {
    expect(total(applyMissingness(m, { model: 'uniform', rate: 0 }, 1, 2, ctx))).toBe(total(m));
    expect(total(applyMissingness(m, { model: 'uniform', rate: 1 }, 1, 2, ctx))).toBe(0);
    expect(applyMissingness(m, { model: 'uniform', rate: 0.5 }, 1, 0, ctx)).toBe(m);
  });

  it('is seeded, differs between trials and removes about the given share', () => {
    const a = applyMissingness(m, { model: 'uniform', rate: 0.2 }, 7, 3, ctx);
    const b = applyMissingness(m, { model: 'uniform', rate: 0.2 }, 7, 3, ctx);
    const c = applyMissingness(m, { model: 'uniform', rate: 0.2 }, 7, 4, ctx);
    expect(Array.from(a.passenger)).toEqual(Array.from(b.passenger));
    expect(Array.from(a.passenger)).not.toEqual(Array.from(c.passenger));
    expect(1 - total(a) / total(m)).toBeGreaterThan(0.17);
    expect(1 - total(a) / total(m)).toBeLessThan(0.23);
    expect(trialSeed(1, 2)).not.toBe(trialSeed(2, 1));
  });

  it('regional combine rules', () => {
    expect(combine.max(0.1, 0.3)).toBe(0.3);
    expect(combine.either(0.5, 0.5)).toBe(0.75);
    expect(combine.both(0.5, 0.5)).toBe(0.25);
    expect(combine.origin(0.1, 0.9)).toBe(0.1);
    // EU 100% with 'both' and AS 0%: nothing removed (every route is EU-AS)
    expect(total(applyMissingness(m, { model: 'regional', regionRates: { EU: 1 }, otherRate: 0, combine: 'both' }, 1, 1, ctx))).toBe(total(m));
    expect(total(applyMissingness(m, { model: 'regional', regionRates: { EU: 1 }, otherRate: 0, combine: 'max' }, 1, 1, ctx))).toBe(0);
  });

  it('route model: whole low-frequency routes go together; frequent routes kept', () => {
    const x = applyMissingness(m, { model: 'route', lowFrequency: { threshold: 4, rateLow: 0.5, rateOther: 0, unit: 'route' } }, 1, 1, ctx);
    const byRoute = new Map<number, Set<boolean>>();
    for (let i = 0; i < m.size; i++) {
      const rid = m.route[i]!;
      const kept = x.passenger[i]! > 0;
      if (rid >= 25) expect(x.passenger[i]).toBe(m.passenger[i]);
      else byRoute.set(rid, (byRoute.get(rid) ?? new Set()).add(kept));
    }
    for (const s of byRoute.values()) expect(s.size).toBe(1);
    const gone = [...byRoute.values()].filter((s) => s.has(false)).length;
    expect(gone).toBeGreaterThan(3);
    expect(gone).toBeLessThan(22);
  });
});

// ---- definitions, statistics, import ---------------------------------------------------------------------

describe('definitions and statistics', () => {
  const d = newDefinition(defaultConfig('2026-03'), 'observed-2026-v2', 'missingness');
  it('runs, problems, hash, batch export', () => {
    expect(runsOf({ ...d, repetitions: 2 }).map((r) => r.runId)).toEqual(['t0000', 't0001', 't0002']);
    expect(definitionProblems(d)).toEqual([]);
    expect(definitionProblems({ ...d, missingness: { model: 'uniform', rate: 2 } })).toContain('x.err.rate');
    expect(definitionHash(d)).toBe(definitionHash({ ...d, name: 'other' }));
    expect(definitionHash(d)).not.toBe(definitionHash({ ...d, randomSeed: 2 }));
    const b = toBatchDefinition(d);
    expect(b.ok && b.definition.baseline.start).toBe('2026-03-01T00:00:00Z');
    expect(b.ok && b.definition.baseline.end).toBe('2026-04-01T00:00:00Z');
    expect(toBatchDefinition({ ...d, baseline: { ...d.baseline, research: { ...d.baseline.research!, carrier: 'X' } } }).ok).toBe(false);
    expect(estimateCost(11, 30, 256, 1).bfs).toBe(11 * 256 * 31);
  });

  it('ranks, top-k and quantiles match the Python runner', () => {
    expect(competition([0.3, 0.1, 0.3, 0.2])).toEqual([1, 4, 1, 3]);
    expect(topkOverlap([3, 2, 1, 0], [3, 2, 0, 1], 2)).toEqual([1, 1]);
    expect(topkOverlap([3, 2, 1, 0], [0, 1, 2, 3], 2)).toEqual([0, 0]);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75); // numpy linear
    const s = describeStats([1, 2, 3, 4]);
    expect(s.sd).toBeCloseTo(Math.sqrt(5 / 3)); // ddof = 1
  });

  it('summarize: fixed candidate list, absent = 0, stats over trials only', () => {
    const run = (runId: string, kind: RawRun['kind'], cands: string[], sys: number[]): RawRun => ({
      runId, label: runId, kind, trial: 0, conditions: {}, nodes: 3, arcs: 2, flights: 2, pairs: 1, exact: true, sources: 3, sourceSeed: 1, randomSeed: 1,
      complete: true, errors: [], seconds: 0, isolated: [], candidates: cands,
      values: { systemicDrop: sys, spilloverDrop: sys, spilloverBefore: sys, unreachablePairs: sys, hop1Drop: sys, hop2Drop: sys, hop3Drop: sys, directLost: sys, flightsLost: sys },
    });
    const def: ExperimentDefinition = { ...d, topK: [1] };
    const r = summarize(def, 'h', { id: 'x', version: '1' }, [run('t0000', 'reference', ['A', 'B'], [0.2, 0.1]), run('t0001', 'trial', ['A'], [0.05]), run('t0002', 'trial', ['A', 'B'], [0.1, 0.3])],
      ['A', 'B'], (id) => ({ id, iata: null, name: null, country: null, continent: '', lat: null, lon: null }), true);
    const b = r.airports.find((a) => a.id === 'B')!;
    expect(b.runs.systemic).toEqual([0.1, 0, 0.3]);
    expect(r.runs[1]!.absent).toBe(1);
    expect(b.systemicStats.mean).toBeCloseTo(0.15); // trials only: 0 and 0.3
    expect(b.systemicTop1Share).toBe(0.5);
    const ok = checkImport(JSON.parse(JSON.stringify(r)), 'x', '1');
    expect(ok.ok).toBe(true);
    expect(checkImport({ ...r, format: 'nope' }, 'x', '1')).toEqual({ ok: false, error: 'x.import.format' });
    const other = checkImport({ ...r, complete: false }, 'x', '2');
    expect(other.ok && other.warnings).toEqual(['x.import.otherVersion', 'x.import.incomplete']);
    const broken = JSON.parse(JSON.stringify(r));
    broken.airports[0].runs.systemic.pop();
    expect(checkImport(broken, 'x', '1').ok).toBe(false);
  });
});
