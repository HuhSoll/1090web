import { describe, expect, it } from 'vitest';
import { mergeMonth } from '../src/research/data';
import { defaultConfig } from '../src/research/model';
import { buildResearchNetwork } from '../src/research/network';
import {
  dayStartMs,
  daysForWindow,
  decodeDay,
  hourlyCounts,
  routeCounts,
  selectWindow,
  windowAsResearchMonth,
  type DayFile,
} from '../src/temporal/model';
import { continentOf, network, persistence } from './research/fixtures';

const code = (dir: number, cls: number, tier: number, basis = 0) => dir + 2 * cls + 6 * (tier - 1) + 24 * basis;
/** Builds a day file in the published layout from (minute, route, carrier, code) rows. */
function dayFile(day: string, rows: [number, number, number, number][]): DayFile {
  const sorted = [...rows].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2] || a[3] - b[3]);
  const f: DayFile = { schemaVersion: 1, day, n: rows.length, r: [], k: [], t: [], c: [], x: [] };
  let prevRoute = -1;
  let prevMin = 0;
  for (const [m, rid, c, x] of sorted) {
    if (rid !== prevRoute) {
      f.r.push(prevRoute < 0 ? rid : rid - prevRoute);
      f.k.push(0);
      prevRoute = rid;
      prevMin = 0;
    }
    f.k[f.k.length - 1]!++;
    f.t.push(m - prevMin);
    prevMin = m;
    f.c.push(c);
    f.x.push(x);
  }
  return f;
}
// 2026-03-10: 00:00, 12:00 (x2), 17:59, 18:00, 23:59
const day10 = dayFile('2026-03-10', [
  [0, 0, 0, code(0, 0, 1)],
  [720, 0, 0, code(0, 0, 1)],
  [720, 0, 0, code(1, 2, 2)],
  [1079, 1, 1, code(0, 0, 4, 1)],
  [1080, 2, 0, code(0, 1, 3)],
  [1439, 2, 0, code(1, 0, 1)],
]);
const day11 = dayFile('2026-03-11', [[0, 0, 0, code(1, 0, 1)]]);
const H = 3_600_000;
const t0 = dayStartMs('2026-03-10');
const days = new Map([decodeDay(day10), decodeDay(day11)].map((d) => [d.day, d]));

describe('decoding day files', () => {
  it('restores UTC times and the packed fields', () => {
    const d = days.get('2026-03-10')!;
    expect(Array.from(d.timeMs, (t) => new Date(t).toISOString())).toEqual([
      '2026-03-10T00:00:00.000Z', '2026-03-10T12:00:00.000Z', '2026-03-10T12:00:00.000Z',
      '2026-03-10T17:59:00.000Z', '2026-03-10T18:00:00.000Z', '2026-03-10T23:59:00.000Z',
    ]);
    expect(Array.from(d.route)).toEqual([0, 0, 0, 1, 2, 2]);
    expect(Array.from(d.tier)).toEqual([1, 1, 2, 4, 3, 1]);
    expect(Array.from(d.aircraftClass)).toEqual([0, 0, 2, 0, 1, 0]);
    expect(Array.from(d.direction)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(d.basis)).toEqual([0, 0, 0, 1, 0, 0]); // the T4 flight's time is its track end
  });
  it('rejects malformed files', () => {
    expect(() => decodeDay({ ...day10, n: 7 })).toThrow();
    expect(() => decodeDay({ ...day10, schemaVersion: 2 })).toThrow();
    expect(() => decodeDay({ ...day11, t: [1440] })).toThrow();
    expect(() => decodeDay({ ...day10, k: [3, 1, 1] })).toThrow();
  });
});

describe('half-open windows [start, end)', () => {
  it('includes the start and excludes the end', () => {
    const w = selectWindow(days, t0 + 12 * H, t0 + 18 * H);
    expect(w.flights).toBe(3); // 12:00 x2 and 17:59; 18:00 belongs to the next window
    expect(selectWindow(days, t0 + 18 * H, t0 + 19 * H).flights).toBe(1);
    expect(selectWindow(days, t0 + 12 * H, t0 + 12 * H).flights).toBe(0);
  });
  it('one hour, six hours, a day and a window across midnight', () => {
    expect(selectWindow(days, t0, t0 + H).flights).toBe(1);
    expect(selectWindow(days, t0 + 12 * H, t0 + 18 * H).flights).toBe(3);
    expect(selectWindow(days, t0, t0 + 24 * H).flights).toBe(6);
    const night = selectWindow(days, t0 + 23 * H, t0 + 25 * H);
    expect(night.flights).toBe(2);
    expect(night.ranges.map((r) => r.events.day)).toEqual(['2026-03-10', '2026-03-11']);
  });
  it('reports days the data does not have', () => {
    const w = selectWindow(days, t0 - 24 * H, t0 + H);
    expect(w.missingDays).toEqual(['2026-03-09']);
    expect(daysForWindow(t0, t0 + 24 * H)).toEqual(['2026-03-10']);
    expect(daysForWindow(t0 + 1, t0 + 24 * H + 1)).toEqual(['2026-03-10', '2026-03-11']);
  });
});

describe('aggregation', () => {
  it('directed and undirected counts each flight once', () => {
    const w = selectWindow(days, t0, t0 + 24 * H);
    const und = routeCounts(w, false);
    const dir = routeCounts(w, true);
    expect([...und.values()].reduce((a, b) => a + b, 0)).toBe(6);
    expect([...dir.values()].reduce((a, b) => a + b, 0)).toBe(6);
    expect(und.get(0)).toBe(3);
    expect([dir.get(0), dir.get(1)]).toEqual([2, 1]);
    expect(hourlyCounts(selectWindow(days, t0 + 12 * H, t0 + 18 * H))).toEqual([2, 0, 0, 0, 0, 1]);
  });
  it('a window feeds Research Mode network building unchanged', () => {
    const w = selectWindow(days, t0, t0 + 24 * H);
    const m = windowAsResearchMonth(w, ['AAA', 'BBB'], '2026-03-10');
    expect(m.size).toBe(6);
    const same = mergeMonth({ month: 'x', observedDays: 1, records: [] }, [], ['AAA', 'BBB']);
    expect(same.carriers).toEqual(m.carriers);
    const cfg = { ...defaultConfig('2026-03'), minFlights: 1 };
    const net = buildResearchNetwork({ network, continentOf, persistence }, m, cfg);
    expect(net.flights).toBe(6);
    expect(net.tierFlights).toEqual([3, 1, 1, 1]);
    const t1 = buildResearchNetwork({ network, continentOf, persistence }, m, { ...cfg, tiers: 'A' });
    expect(t1.flights).toBe(3);
    const cargo = buildResearchNetwork({ network, continentOf, persistence }, m, { ...cfg, classes: ['cargo'] });
    expect(cargo.flights).toBe(1);
  });
});
