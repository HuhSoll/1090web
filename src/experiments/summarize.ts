/**
 * Raw impacts of every run -> the shared ExperimentResult (same computation as summarize() in
 * pipeline/experiments/run.py). Pure.
 *
 * Every run is laid on the fixed candidate list: a candidate absent from a run's graph has impact
 * 0 there (counted in `absent`); comparisons on the airports present in both runs are given too.
 * Statistics over trials are descriptive (mean, median, sd, quantiles, top-k frequency): they
 * describe the spread under the ASSUMED missingness, they are not confidence intervals.
 */
import { kendallTauB, spearman } from '../research/stats';
import { APP_BUILD } from '../app/build';
import { rankValue } from './criticality';
import {
  METHOD_VERSION, METRICS, RESULT_FORMAT, SCHEMA_VERSION,
  type AirportRow, type ExperimentDefinition, type ExperimentResult, type Metric, type RunRecord, type Stats,
} from './model';

export interface RawRun extends Omit<RunRecord, 'comparison' | 'absent'> {
  candidates: string[];
  values: Record<Metric, ArrayLike<number>>;
}

export interface AirportMeta {
  id: string;
  iata: string | null;
  name: string | null;
  country: string | null;
  continent: string;
  lat: number | null;
  lon: number | null;
}

/** "1224" ranks, largest first, on values rounded like the Python runner. */
export function competition(values: readonly number[]): number[] {
  const v = values.map(rankValue);
  const order = v.map((_, i) => i).sort((a, b) => v[b]! - v[a]! || a - b);
  const ranks = new Array<number>(v.length).fill(0);
  let prev: number | null = null;
  let rank = 0;
  order.forEach((i, pos) => {
    if (v[i] !== prev) {
      rank = pos + 1;
      prev = v[i]!;
    }
    ranks[i] = rank;
  });
  return ranks;
}

export function topkOverlap(a: readonly number[], b: readonly number[], k: number): [number, number] {
  const top = (x: readonly number[]) => new Set(x.map((_, i) => i).sort((i, j) => rankValue(x[j]!) - rankValue(x[i]!) || i - j).slice(0, k));
  const ta = top(a);
  const tb = top(b);
  const inter = [...ta].filter((i) => tb.has(i)).length;
  const union = new Set([...ta, ...tb]).size;
  return [inter / k, union ? inter / union : 1];
}

/** numpy's default (linear) quantile. */
export function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function describe(x: readonly number[]): Stats {
  if (!x.length) return { mean: null, median: null, sd: null, p05: null, p25: null, p75: null, p95: null, min: null, max: null };
  const s = [...x].sort((a, b) => a - b);
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = x.length > 1 ? Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - 1)) : 0;
  return { mean, median: quantile(s, 0.5), sd, p05: quantile(s, 0.05), p25: quantile(s, 0.25), p75: quantile(s, 0.75), p95: quantile(s, 0.95), min: s[0]!, max: s[s.length - 1]! };
}

const round = (x: number | null, nd: number) => (x === null || Number.isNaN(x) ? null : Math.round(x * 10 ** nd) / 10 ** nd);
const roundStats = (s: Stats, nd: number): Stats => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round(v, nd)])) as unknown as Stats;

export function summarize(
  d: ExperimentDefinition,
  hash: string,
  dataset: { id: string; version: string | null; continentRule?: string },
  runs: RawRun[],
  candidates: string[],
  meta: (id: string) => AirportMeta,
  complete: boolean,
  source = 'browser (Research Mode > Experiments)',
): ExperimentResult {
  const idx = new Map(candidates.map((a, i) => [a, i]));
  const C = candidates.length;
  const full = runs.map((r) => {
    const m = Object.fromEntries(METRICS.map((k) => [k, new Float64Array(C)])) as Record<Metric, Float64Array>;
    r.candidates.forEach((a, j) => {
      const i = idx.get(a);
      if (i === undefined) return;
      for (const k of METRICS) m[k][i] = r.values[k][j]!;
    });
    return m;
  });
  const ranks = full.map((m) => ({ sys: competition(Array.from(m.systemicDrop)), spill: competition(Array.from(m.spilloverDrop)) }));
  const ref = full[0]!;
  const refPresent = new Set(runs[0]?.candidates.map((a) => idx.get(a)!) ?? []);
  const outRuns: RunRecord[] = runs.map((r, j) => {
    const present = r.candidates.map((a) => idx.get(a)!).filter((i) => i !== undefined);
    const both = present.filter((i) => refPresent.has(i));
    const cmp = (metric: Metric) => {
      // rank correlations on the values the ranks use (9e.2): impacts that are zero in exact
      // arithmetic come out as +-1e-17 and must tie, not be ordered by floating-point noise
      const x = Array.from(ref[metric], rankValue);
      const y = Array.from(full[j]![metric], rankValue);
      const entry: Record<string, number | null> = {
        spearman: round(spearman(x, y), 4),
        kendall: round(kendallTauB(x, y), 4),
        spearmanCommon: both.length > 2 ? round(spearman(both.map((i) => x[i]!), both.map((i) => y[i]!)), 4) : null,
      };
      for (const k of d.topK) {
        const [ov, jac] = topkOverlap(x, y, k);
        entry[`top${k}`] = round(ov, 4);
        entry[`jaccard${k}`] = round(jac, 4);
      }
      return entry as RunRecord['comparison']['systemic'];
    };
    const { candidates: _c, values: _v, ...rest } = r;
    void _c;
    void _v;
    return { ...rest, comparison: { systemic: cmp('systemicDrop'), spillover: cmp('spilloverDrop') }, absent: C - present.length };
  });
  const sx = Array.from(ref.systemicDrop, rankValue);
  const sp = Array.from(ref.spilloverDrop, rankValue);
  const sysSpill: Record<string, number | null> = { spearman: round(spearman(sx, sp), 4), kendall: round(kendallTauB(sx, sp), 4) };
  for (const k of d.topK) sysSpill[`top${k}`] = round(topkOverlap(sx, sp, k)[0], 4);
  const trials = runs.map((r, i) => (r.kind === 'trial' ? i : -1)).filter((i) => i >= 0);
  const sel = trials.length ? trials : runs.map((_, i) => i);
  const isolated = runs.map((r) => new Set(r.isolated));
  const airports: AirportRow[] = candidates.map((a) => {
    const i = idx.get(a)!;
    const m = meta(a);
    const row: AirportRow = {
      ...m,
      ref: { ...(Object.fromEntries(METRICS.map((k) => [k, round(ref[k][i]!, 9)])) as Record<Metric, number | null>), rankSystemic: ranks[0]!.sys[i]!, rankSpillover: ranks[0]!.spill[i]! },
      runs: {
        systemic: full.map((f) => round(f.systemicDrop[i]!, 9)),
        spillover: full.map((f) => round(f.spilloverDrop[i]!, 9)),
        rankSystemic: ranks.map((r) => r.sys[i]!),
        rankSpillover: ranks.map((r) => r.spill[i]!),
      },
      isolatedIn: runs.filter((_, j) => isolated[j]!.has(a)).map((r) => r.runId),
      systemicStats: describe([]),
      spilloverStats: describe([]),
      systemicRankStats: describe([]),
      spilloverRankStats: describe([]),
    };
    for (const [key, metric, rk] of [['systemic', 'systemicDrop', 'sys'], ['spillover', 'spilloverDrop', 'spill']] as const) {
      const vals = sel.map((j) => full[j]![metric][i]!);
      const rks = sel.map((j) => ranks[j]![rk][i]!);
      row[`${key}Stats`] = roundStats(describe(vals), 9);
      row[`${key}RankStats`] = roundStats(describe(rks), 3);
      for (const k of d.topK) row[`${key}Top${k}Share`] = round(rks.filter((x) => x <= k).length / rks.length, 4);
    }
    return row;
  });
  return {
    format: RESULT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    methodVersion: METHOD_VERSION,
    definitionHash: hash,
    definition: d,
    dataset,
    createdAt: new Date().toISOString(),
    source,
    environment: { runtime: 'browser', app: { version: APP_BUILD.version, commit: APP_BUILD.commit } },
    computation: {
      exact: runs.every((r) => r.exact),
      sources: [...new Set(runs.map((r) => r.sources))].sort((x, y) => x - y),
      sourceSeed: d.computation.sourceSeed,
      randomSeed: d.randomSeed,
      note: 'exact = every airport is a BFS source; otherwise efficiency and pair counts are estimates from the sampled sources (same sources for every candidate)',
    },
    candidates: { count: C, rule: d.candidates },
    complete,
    runs: outRuns,
    systemicVsSpillover: sysSpill,
    airports,
    interpretation: {
      sensitivity: 'rankings under other data-selection conditions; not an estimate of observation error',
      missingness: 'added, assumed missingness on observed flights; the distribution is not a confidence interval for the true network',
      approximation: 'sampling error of the BFS sources is separate from missingness variation',
    },
  };
}
