import { describe, expect, it } from 'vitest';
import { averageRanks, compareRankings, competitionRanks, kendallTauB, ranking, spearman } from '../../src/research/stats';

describe('ranking statistics', () => {
  it('handles ties: competition ranks and average ranks', () => {
    const s = new Map([['a', 5], ['b', 3], ['c', 3], ['d', 1]]);
    expect(ranking(s).map(([k]) => k)).toEqual(['a', 'b', 'c', 'd']);
    expect([...competitionRanks(s)]).toEqual([['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
    expect(averageRanks([5, 3, 3, 1])).toEqual([1, 2.5, 2.5, 4]);
  });
  it('rank correlations by hand', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2, 3], [1, 1, 2])).toBeCloseTo(1.5 / Math.sqrt(3));
    expect(kendallTauB([1, 2, 3], [1, 1, 2])).toBeCloseTo(2 / Math.sqrt(6));
    expect(spearman([1, 1], [1, 2])).toBeNull();
  });
  it('compares top-k rankings like the Python research code', () => {
    const ref = new Map([['A', 4], ['B', 3], ['C', 2], ['D', 1]]);
    const other = new Map([['A', 2], ['B', 3], ['C', 2], ['E', 5]]);
    const c = compareRankings(ref, other, 2);
    const a = c.rows.find((r) => r.key === 'A')!;
    expect(a).toEqual({ key: 'A', scoreRef: 4, scoreOther: 2, rankRef: 1, rankOther: 3, rankChange: 2, scoreChangePct: -50 });
    expect(c.spearman).toBeCloseTo(-1);
    expect(c.kendall).toBeCloseTo(-1);
    expect(c.jaccard).toBeCloseTo(1 / 3);
    expect(c.overlap).toBeCloseTo(0.5);
    expect(c.entered).toEqual(['E']);
    expect(c.left).toEqual(['A']);
  });
});
