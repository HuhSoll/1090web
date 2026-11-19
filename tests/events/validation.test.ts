/**
 * Phase 9I: the event-study statistics of src/events/analysis.ts against an independent
 * computation (pipeline/research_validation/event_series.py: DuckDB over the per-flight research parquet,
 * scipy linregress for OLS, Newey-West written from its definition). The fixture holds the daily
 * series that script counted and the values it computed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beforeAfter, DAY, differenceInDifferences, neweyWestLag, placebo, preTrend, ratioPreTrend, trend, utcDayMs, windowPair, type DailySeries } from '../../src/events/analysis';

interface Case {
  days: string[];
  area: number[];
  comparison: number[];
  expected: {
    beforeMean: number; afterMean: number; logChange: number;
    preTrend: { tOls: number; tNeweyWest: number; lag: number; impliedChange: number };
    ratioPreTrend: { tOls: number; tNeweyWest: number };
    placebo: { tried: number; valid: number; asLarge: number };
    didLogDifference: number;
    didPlacebos: { valid: number; asLarge: number };
    eventDayValue: number;
  };
}
const fx = JSON.parse(readFileSync(resolve(__dirname, 'validation.fixture.json'), 'utf-8')) as { eventDay: string; windowDays: number; cases: Record<string, Case> };

describe('event study: independent check (Phase 9I)', () => {
  for (const [id, c] of Object.entries(fx.cases)) {
    it(id, () => {
      const start = utcDayMs(c.days[0]!);
      const end = start + c.days.length * DAY;
      const area: DailySeries = { startMs: start, values: c.area };
      const comp: DailySeries = { startMs: start, values: c.comparison };
      const w = windowPair(utcDayMs(fx.eventDay), fx.windowDays, start, end);
      const e = c.expected;
      const ba = beforeAfter(area, w);
      expect(ba.beforeMean).toBeCloseTo(e.beforeMean, 9);
      expect(ba.afterMean).toBeCloseTo(e.afterMean, 9);
      expect(ba.logChange).toBeCloseTo(e.logChange, 12);
      const pt = preTrend(area, w)!;
      expect(pt.lag).toBe(e.preTrend.lag);
      expect(pt.tOls).toBeCloseTo(e.preTrend.tOls, 9);
      expect(pt.t).toBeCloseTo(e.preTrend.tNeweyWest, 9);
      expect(pt.impliedChange).toBeCloseTo(e.preTrend.impliedChange, 9);
      const rt = ratioPreTrend(area, comp, w)!;
      expect(rt.tOls).toBeCloseTo(e.ratioPreTrend.tOls, 9);
      expect(rt.t).toBeCloseTo(e.ratioPreTrend.tNeweyWest, 9);
      const pl = placebo(area, w, start, end);
      expect(pl.tried).toBe(e.placebo.tried);
      expect(pl.placebos.length).toBe(e.placebo.valid);
      expect(pl.asLarge).toBe(e.placebo.asLarge);
      const did = differenceInDifferences(area, comp, w, start, end);
      expect(did.logDifference).toBeCloseTo(e.didLogDifference, 12);
      expect(did.placebos.length).toBe(e.didPlacebos.valid);
      expect(did.placebos.filter((p) => Math.abs(p) >= Math.abs(did.logDifference)).length).toBe(e.didPlacebos.asLarge);
      expect(did.interpretation).toBe('descriptive');
      // the event day itself belongs to neither window
      expect(c.area[Math.round((w.eventDayMs - start) / DAY)]).toBe(e.eventDayValue);
      expect(w.before.endMs).toBe(w.eventDayMs);
      expect(w.after.startMs).toBe(w.eventDayMs + DAY);
    });
  }
});

describe('trend: Newey-West standard error', () => {
  it('is smaller than the OLS error with negative and larger with positive autocorrelation', () => {
    expect(neweyWestLag(14)).toBe(2);
    expect(neweyWestLag(5)).toBe(2);
    expect(neweyWestLag(100)).toBe(4);
    // residuals that alternate in sign: negative autocorrelation, HAC smaller than OLS
    const alt = Array.from({ length: 14 }, (_, i) => i * 0.1 + (i % 2 ? 0.05 : -0.05));
    const a = trend(alt)!;
    expect(a.se).toBeLessThan(a.seOls);
    // a slow wave around the line: positively autocorrelated residuals, HAC larger than OLS
    const runs = Array.from({ length: 14 }, (_, i) => i * 0.1 + 0.2 * Math.sin((2 * Math.PI * i) / 20));
    const b = trend(runs)!;
    expect(b.se).toBeGreaterThan(b.seOls);
  });

  it('a hand-computable line has zero error', () => {
    const t = trend([0, 1, 2, 3, 4])!;
    expect(t.slope).toBe(1);
    expect(t.seOls).toBe(0);
    expect(t.t).toBe(Infinity);
  });
});

describe('placebo: the counts behind the share', () => {
  it('reports tried, overlapping and valid placebo days', () => {
    // 60 days of flat data with the event on day 50: placebos every 7 days back
    const start = Date.UTC(2026, 0, 1);
    const s: DailySeries = { startMs: start, values: Array.from({ length: 70 }, (_, i) => (i >= 51 ? 10 : 100)) };
    const w = windowPair(start + 50 * DAY, 14, start, start + 70 * DAY);
    const p = placebo(s, w, start, start + 70 * DAY);
    // k = 1, 2 reach the event (after window ends past day 50); k = 3..5 fit; k = 6 starts before the data
    expect(p.tried).toBe(5);
    expect(p.overlapping).toBe(2);
    expect(p.placebos.length).toBe(3);
    expect(p.asLarge).toBe(0);
    expect(p.shareAsLarge).toBe(0);
  });
});

describe('difference in differences: descriptive only', () => {
  it('keeps the comparison group change and the level difference', () => {
    const start = Date.UTC(2026, 0, 1);
    const n = 80;
    const target: DailySeries = { startMs: start, values: Array.from({ length: n }, (_, i) => (i > 60 ? 50 : 100)) };
    const comp: DailySeries = { startMs: start, values: Array.from({ length: n }, (_, i) => (i > 60 ? 900 : 1000)) };
    const w = windowPair(start + 60 * DAY, 14, start, start + n * DAY);
    const d = differenceInDifferences(target, comp, w, start, start + n * DAY);
    expect(d.interpretation).toBe('descriptive');
    expect(d.levelRatioBefore).toBeCloseTo(0.1, 9);
    expect(d.comparisonLogChange).toBeCloseTo(Math.log(901 / 1001), 9);
    expect(d.logDifference).toBeCloseTo(Math.log(51 / 101) - Math.log(901 / 1001), 9);
    // placebos are computed with the same estimator: flat periods give exactly 0
    expect(d.placebos.every((p) => Math.abs(p) < 1e-12)).toBe(true);
  });
});
