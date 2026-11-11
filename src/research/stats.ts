/**
 * Ranking statistics for Research Mode (pure). The definitions match the Python research code
 * (pipeline/analysis/network.py) so browser and pipeline results can be compared.
 */

/** Sorted by score descending, ties by key ascending (deterministic). */
export function ranking<K extends string | number>(scores: ReadonlyMap<K, number>): [K, number][] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** "1224" ranking: tied scores share the best rank. */
export function competitionRanks<K extends string | number>(scores: ReadonlyMap<K, number>): Map<K, number> {
  const out = new Map<K, number>();
  let prev: number | null = null;
  let rank = 0;
  ranking(scores).forEach(([k, v], i) => {
    if (v !== prev) {
      rank = i + 1;
      prev = v;
    }
    out.set(k, rank);
  });
  return out;
}

/** Ranks 1..n (1 = largest), ties get the mean of their positions. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = r;
    i = j + 1;
  }
  return ranks;
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export function spearman(x: readonly number[], y: readonly number[]): number | null {
  return pearson(averageRanks(x), averageRanks(y));
}

/** Kendall's tau-b (tie-corrected), O(n^2): for top-k lists. */
export function kendallTauB(x: readonly number[], y: readonly number[]): number | null {
  let conc = 0;
  let disc = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = x[i]! - x[j]!;
      const dy = y[i]! - y[j]!;
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tx++;
      else if (dy === 0) ty++;
      else if (dx > 0 === dy > 0) conc++;
      else disc++;
    }
  }
  const d = Math.sqrt((conc + disc + tx) * (conc + disc + ty));
  return d ? (conc - disc) / d : null;
}

export interface RankingRow<K> {
  key: K;
  scoreRef: number;
  scoreOther: number;
  rankRef: number | null;
  rankOther: number | null;
  rankChange: number | null;
  scoreChangePct: number | null;
}

export interface RankingComparison<K> {
  k: number;
  rows: RankingRow<K>[];
  /** on the union of both top-k sets, using full scores (absent = 0) */
  spearman: number | null;
  kendall: number | null;
  /** |top-k(ref) ∩ top-k(other)| / |union| */
  jaccard: number | null;
  /** |top-k(ref) ∩ top-k(other)| / k */
  overlap: number | null;
  entered: K[];
  left: K[];
}

export function compareRankings<K extends string | number>(
  ref: ReadonlyMap<K, number>,
  other: ReadonlyMap<K, number>,
  k = 20,
): RankingComparison<K> {
  const rr = competitionRanks(ref);
  const ro = competitionRanks(other);
  const topRef = ranking(ref).slice(0, k).map(([key]) => key);
  const topOther = ranking(other).slice(0, k).map(([key]) => key);
  const setRef = new Set(topRef);
  const setOther = new Set(topOther);
  const rows = topRef.map((key) => {
    const r0 = rr.get(key) ?? null;
    const r1 = ro.get(key) ?? null;
    const s0 = ref.get(key) ?? 0;
    const s1 = other.get(key) ?? 0;
    return {
      key,
      scoreRef: s0,
      scoreOther: s1,
      rankRef: r0,
      rankOther: r1,
      rankChange: r0 !== null && r1 !== null ? r1 - r0 : null,
      scoreChangePct: s0 ? (100 * (s1 - s0)) / s0 : null,
    };
  });
  const union = [...new Set([...topRef, ...topOther])].sort();
  const x = union.map((key) => ref.get(key) ?? 0);
  const y = union.map((key) => other.get(key) ?? 0);
  const inter = topRef.filter((key) => setOther.has(key)).length;
  return {
    k,
    rows,
    spearman: union.length >= 3 ? spearman(x, y) : null,
    kendall: union.length >= 3 ? kendallTauB(x, y) : null,
    jaccard: union.length ? inter / union.length : null,
    overlap: topRef.length ? inter / Math.min(k, topRef.length) : null,
    entered: topOther.filter((key) => !setRef.has(key)),
    left: topRef.filter((key) => !setOther.has(key)),
  };
}
