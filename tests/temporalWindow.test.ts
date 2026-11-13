import { describe, expect, it } from 'vitest';
import { toMonthData, toResearchMonth, WindowAggregator } from '../src/temporal/aggregate';
import { dayStartMs, decodeDay, type DayFile } from '../src/temporal/model';
import {
  clampCursor,
  clampWindow,
  compareWindow,
  DAY_MS,
  defaultSelection,
  formatUtc,
  HOUR_MS,
  parseUtc,
  seriesBinMs,
  stepCursor,
  toIsoMinute,
  windowFor,
  type TemporalSelection,
} from '../src/temporal/window';

const range = { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 9, 1) };
const sel = (p: Partial<TemporalSelection>): TemporalSelection => ({ ...defaultSelection(range), ...p });
const T = (s: string) => parseUtc(s)!;

describe('UTC parsing and formatting', () => {
  it('parses as UTC regardless of the browser time zone', () => {
    expect(T('2026-03-10')).toBe(Date.UTC(2026, 2, 10));
    expect(T('2026-03-10T12:00')).toBe(Date.UTC(2026, 2, 10, 12));
    expect(T('2026-03-10T12:00Z')).toBe(Date.UTC(2026, 2, 10, 12));
    expect(T('2026-03-10 23:59:59')).toBe(Date.UTC(2026, 2, 10, 23, 59, 59));
    expect(parseUtc('2026-02-30')).toBeNull();
    expect(parseUtc('2026-03-10T12:00+09:00')).toBeNull(); // offsets are rejected, not converted
    expect(parseUtc('2026-03-10T24:00')).toBeNull();
    expect(formatUtc(Date.UTC(2026, 2, 10, 6, 5))).toBe('2026-03-10 06:05 UTC');
    expect(toIsoMinute(Date.UTC(2026, 2, 10, 6, 5))).toBe('2026-03-10T06:05Z');
  });
});

describe('window presets', () => {
  const c = T('2026-03-10T12:00');
  it('day, month and rolling windows', () => {
    expect(windowFor(sel({ cursorMs: c, preset: 'day' }))).toEqual({ startMs: T('2026-03-10'), endMs: T('2026-03-11') });
    expect(windowFor(sel({ cursorMs: c, preset: 'month' }))).toEqual({ startMs: T('2026-03-01'), endMs: T('2026-04-01') });
    expect(windowFor(sel({ cursorMs: c, preset: 'rolling24h' }))).toEqual({ startMs: T('2026-03-09T12:00'), endMs: c });
    expect(windowFor(sel({ cursorMs: c, preset: 'rolling6h' }))).toEqual({ startMs: T('2026-03-10T06:00'), endMs: c });
    expect(windowFor(sel({ cursorMs: c, preset: 'rolling1h' }))).toEqual({ startMs: T('2026-03-10T11:00'), endMs: c });
    expect(windowFor(sel({ cursorMs: c, preset: 'rolling7d' }))).toEqual({ startMs: T('2026-03-03T12:00'), endMs: c });
    expect(windowFor(sel({ preset: 'custom', customStartMs: T('2026-03-10T18:00'), customEndMs: T('2026-03-11T06:00') })))
      .toEqual({ startMs: T('2026-03-10T18:00'), endMs: T('2026-03-11T06:00') });
  });
  it('clamps to the data and reports clipping', () => {
    expect(clampWindow({ startMs: T('2025-12-31'), endMs: T('2026-01-02') }, range)).toEqual({ window: { startMs: T('2026-01-01'), endMs: T('2026-01-02') }, clipped: true });
    expect(clampWindow({ startMs: T('2026-10-01'), endMs: T('2026-10-02') }, range)).toBeNull();
    expect(clampCursor(T('2025-06-01'), 'rolling6h', range)).toBe(range.startMs + HOUR_MS);
    expect(clampCursor(T('2027-01-01'), 'day', range)).toBe(range.endMs - HOUR_MS);
  });
  it('steps are independent of the window and stop (or loop) at the edges', () => {
    const s = sel({ cursorMs: c, preset: 'rolling24h', stepMs: HOUR_MS });
    expect(stepCursor(s, 1, range)).toBe(c + HOUR_MS);
    expect(stepCursor({ ...s, stepMs: 7 * DAY_MS }, -1, range)).toBe(c - 7 * DAY_MS);
    expect(stepCursor({ ...s, cursorMs: range.endMs }, 1, range)).toBeNull();
    expect(stepCursor({ ...s, cursorMs: range.endMs, loop: true }, 1, range)).toBe(range.startMs + HOUR_MS);
    expect(stepCursor(sel({ cursorMs: T('2026-01-15'), preset: 'month' }), 1, range)).toBe(T('2026-02-01'));
  });
  it('comparison windows have the same length', () => {
    const w = { startMs: T('2026-03-10T12:00'), endMs: T('2026-03-10T18:00') };
    expect(compareWindow(w, 'previous')).toEqual({ startMs: T('2026-03-10T06:00'), endMs: T('2026-03-10T12:00') });
    expect(compareWindow(w, 'week')).toEqual({ startMs: T('2026-03-03T12:00'), endMs: T('2026-03-03T18:00') });
    expect(compareWindow(w, 'off')).toBeNull();
    expect(seriesBinMs(w)).toBe(HOUR_MS);
    expect(seriesBinMs({ startMs: T('2026-03-01'), endMs: T('2026-03-31') })).toBe(DAY_MS);
  });
});

const code = (dir: number, cls: number, tier: number, basis = 0) => dir + 2 * cls + 6 * (tier - 1) + 24 * basis;
function day(d: string, rows: [number, number, number, number][]): DayFile {
  const sorted = [...rows].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const f: DayFile = { schemaVersion: 1, day: d, n: rows.length, r: [], k: [], t: [], c: [], x: [] };
  let pr = -1;
  let pm = 0;
  for (const [m, rid, c, x] of sorted) {
    if (rid !== pr) {
      f.r.push(pr < 0 ? rid : rid - pr);
      f.k.push(0);
      pr = rid;
      pm = 0;
    }
    f.k[f.k.length - 1]!++;
    f.t.push(m - pm);
    pm = m;
    f.c.push(c);
    f.x.push(x);
  }
  return f;
}

describe('incremental aggregation', () => {
  // three days; route 0 a->b, route 1; carriers 0/1
  const days = [
    decodeDay(day('2026-03-10', [[60, 0, 0, code(0, 0, 1)], [600, 0, 0, code(0, 0, 4, 1)], [1380, 1, 1, code(1, 1, 2)]])),
    decodeDay(day('2026-03-11', [[0, 0, 0, code(0, 0, 1)], [720, 1, 0, code(0, 2, 3)]])),
    decodeDay(day('2026-03-12', [[30, 0, 1, code(1, 0, 1)]])),
  ];
  const all = { startMs: dayStartMs('2026-03-10'), endMs: dayStartMs('2026-03-13') };

  it('adds days one at a time and keeps route, direction, airline, tier and class', () => {
    const agg = new WindowAggregator(all, 'all', 2, DAY_MS);
    days.forEach((d) => agg.addDay(d));
    expect(agg.flights).toBe(6);
    expect([agg.trackStart, agg.fallback]).toEqual([5, 1]);
    const r = agg.rows();
    const rows = Array.from({ length: r.size }, (_, i) => [r.route[i], r.dir[i], r.carrier[i], r.tier[i], r.cls[i], r.count[i]]);
    expect(rows).toEqual([[0, 0, 0, 1, 0, 2], [0, 0, 0, 4, 0, 1], [0, 1, 1, 1, 0, 1], [1, 0, 0, 3, 2, 1], [1, 1, 1, 2, 1, 1]]);
    expect(agg.series().flights).toEqual([3, 2, 1]);
    expect(agg.series().routes).toEqual([2, 2, 1]);
  });
  it('half-open windows across a day boundary', () => {
    const agg = new WindowAggregator({ startMs: dayStartMs('2026-03-10') + 18 * HOUR_MS, endMs: dayStartMs('2026-03-11') + 12 * HOUR_MS }, 'all', 2, HOUR_MS);
    days.forEach((d) => agg.addDay(d));
    expect(agg.flights).toBe(2); // 23:00 on the 10th and 00:00 on the 11th; 12:00 on the 11th is the end
  });
  it('track-start-only filter drops fallback times and still counts both kinds', () => {
    const agg = new WindowAggregator(all, 'start', 2, DAY_MS);
    days.forEach((d) => agg.addDay(d));
    expect(agg.flights).toBe(5);
    expect([agg.trackStart, agg.fallback]).toEqual([5, 1]);
  });
  it('series filter (airline, passenger only, observed only, airport partners) leaves the aggregate unfiltered', () => {
    const geo = { a: Int32Array.from([0, 0]), b: Int32Array.from([1, 2]), airportCountry: Int32Array.from([0, 1, 2]) };
    const agg = new WindowAggregator(all, 'all', 2, DAY_MS, geo, { country: null, carrier: 0, passengerOnly: true, includeT4: false, airport: 0 });
    days.forEach((d) => agg.addDay(d));
    expect(agg.series().flights).toEqual([1, 1, 0]);
    expect(agg.series().partners).toEqual([1, 1, 0]);
    expect(agg.flights).toBe(6);
    const byCountry = new WindowAggregator(all, 'all', 2, DAY_MS, geo, { country: 2, carrier: null, passengerOnly: false, includeT4: true, airport: null });
    days.forEach((d) => byCountry.addDay(d));
    expect(byCountry.series().flights).toEqual([1, 1, 0]); // only route 1 touches country 2
  });
  it('converts to Explore records and Research rows without losing flights', () => {
    const agg = new WindowAggregator(all, 'all', 2, DAY_MS);
    days.forEach((d) => agg.addDay(d));
    const m = toMonthData(agg.rows(), ['AAA', 'BBB'], 'w', 3);
    expect(m.records).toEqual([[0, 0, 'AAA', 2, 0, 0, 0], [0, 0, 'AAA', 1, 0, 0, 1], [0, 1, 'BBB', 1, 0, 0, 0], [1, 0, 'AAA', 0, 0, 1, 0], [1, 1, 'BBB', 0, 1, 0, 0]]);
    expect(m.observedDays).toBe(3);
    const rm = toResearchMonth(agg.rows(), ['AAA', 'BBB'], 'w', 3);
    const total = Array.from({ length: rm.size }, (_, i) => rm.passenger[i]! + rm.cargo[i]! + rm.unknown[i]!).reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });
});
