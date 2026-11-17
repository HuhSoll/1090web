import { describe, expect, it } from 'vitest';
import { beforeAfter, DAY, differenceInDifferences, placebo, preTrend, ratioPreTrend, utcDayMs, windowPair, type DailySeries } from '../../src/events/analysis';
import { observedChanges } from '../../src/events/changes';
import { WindowAggregator, type GroupSpec, type RouteGeo } from '../../src/temporal/aggregate';
import type { DayEvents } from '../../src/temporal/model';
import type { StaticNetwork } from '../../src/data/model/network';
import type { AggregateRows } from '../../src/temporal/aggregate';

const START = utcDayMs('2026-01-01');
const END = utcDayMs('2026-04-01');
const EVENT = utcDayMs('2026-02-28');
const N = Math.round((END - START) / DAY);
// weekly pattern so the series are not constant (the trend's standard error is defined)
const week = [1.0, 1.05, 0.95, 1.1, 0.9, 1.02, 0.98];
const series = (f: (dayMs: number, i: number) => number): DailySeries => ({
  startMs: START, values: Array.from({ length: N }, (_, i) => Math.round(f(START + i * DAY, i) * week[new Date(START + i * DAY).getUTCDay()]!)),
});
const stepDown = series((d) => (d < EVENT ? 200 : 100));
const flat = series(() => 300);

describe('events: windows', () => {
  it('UTC days, event day as a buffer, weekday composition', () => {
    expect(utcDayMs('2026-02-28')).toBe(Date.UTC(2026, 1, 28));
    for (const n of [7, 14, 28]) {
      const w = windowPair(EVENT, n, START, END);
      expect(w.before.endMs).toBe(EVENT);
      expect(w.after.startMs).toBe(EVENT + DAY);
      expect(w.before.days).toBe(n);
      expect(w.after.days).toBe(n);
      expect(w.sameWeekdays).toBe(true);
    }
    expect(windowPair(EVENT, 30, START, END).sameWeekdays).toBe(false);
  });

  it('windows are shortened at the data edges, never filled in', () => {
    const w = windowPair(utcDayMs('2026-01-16'), 30, START, END);
    expect(w.before.truncated).toBe(true);
    expect(w.before.days).toBe(15);
    expect(w.before.startMs).toBe(START);
  });
});

describe('events: before / after on a known step', () => {
  it('reproduces a -50 % change for 7, 14 and 28 days', () => {
    for (const n of [7, 14, 28]) {
      const r = beforeAfter(stepDown, windowPair(EVENT, n, START, END));
      expect(r.change!).toBeGreaterThan(-0.52);
      expect(r.change!).toBeLessThan(-0.48);
    }
  });

  it('excluded days (collection gaps) are left out, not counted as zero', () => {
    const s = series(() => 100);
    s.values[Math.round((EVENT + 3 * DAY - START) / DAY)] = 0; // a gap day after the event
    const w = windowPair(EVENT, 7, START, END);
    const withGap = beforeAfter(s, w);
    const without = beforeAfter(s, w, new Set([EVENT + 3 * DAY]));
    expect(withGap.afterMean).toBeLessThan(without.afterMean);
    expect(without.afterDays).toBe(6);
    expect(Math.abs(without.change!)).toBeLessThan(0.05);
  });
});

describe('events: pre-trend, comparison, placebo, DiD', () => {
  it('flat before the event: no pre-trend; a decline that starts early is detected', () => {
    const w = windowPair(EVENT, 28, START, END);
    expect(Math.abs(preTrend(stepDown, w)!.t)).toBeLessThan(2);
    const early = series((d) => (d < EVENT - 14 * DAY ? 200 : d < EVENT ? 200 - ((d - (EVENT - 14 * DAY)) / DAY) * 6 : 100));
    const t = preTrend(early, w)!;
    expect(t.slope).toBeLessThan(0);
    expect(Math.abs(t.t)).toBeGreaterThan(2);
  });

  it('placebo days without an event show no change as large as the real one', () => {
    const p = placebo(stepDown, windowPair(EVENT, 7, START, END), START, END);
    expect(p.placebos.length).toBeGreaterThanOrEqual(3);
    expect(p.shareAsLarge).toBe(0);
    for (const q of p.placebos) expect(q.dayMs + 8 * DAY).toBeLessThanOrEqual(EVENT); // no day after the event
  });

  it('DiD is given only when its conditions hold', () => {
    const w = windowPair(EVENT, 14, START, END);
    const ok = differenceInDifferences(stepDown, flat, w, START, END);
    expect(ok.conditions.every((c) => c.ok)).toBe(true);
    expect(ok.estimate!).toBeCloseTo(Math.log(101 / 201), 1);
    expect(Math.abs(ratioPreTrend(stepDown, flat, w)!.t)).toBeLessThan(2);
    // the comparison group falls too before the event: the pre-trend condition fails
    const compDown = series((d) => (d < EVENT - 14 * DAY ? 300 : 300 - ((d - (EVENT - 14 * DAY)) / DAY) * 8));
    expect(differenceInDifferences(stepDown, compDown, w, START, END).estimate).toBeNull();
    // 30 days: different weekdays -> no estimate
    expect(differenceInDifferences(stepDown, flat, windowPair(EVENT, 30, START, END), START, END).estimate).toBeNull();
    // a collection gap inside a window -> no estimate
    expect(differenceInDifferences(stepDown, flat, w, START, END, new Set([EVENT + 2 * DAY])).estimate).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
// small network: airports 0,1 in area X; 2 neighbour Y; 3,4 elsewhere Z

const net = {
  airports: [{ country: 'X' }, { country: 'X' }, { country: 'Y' }, { country: 'Z' }, { country: 'Z' }],
  routes: [{ id: 0, a: 0, b: 1 }, { id: 1, a: 0, b: 3 }, { id: 2, a: 2, b: 3 }, { id: 3, a: 3, b: 4 }, { id: 4, a: 1, b: 4 }],
  carriers: [{ id: 'AAA' }, { id: 'BBB' }],
} as unknown as StaticNetwork;

function rows(entries: [route: number, carrier: number, tier: number, count: number][]): AggregateRows {
  const n = entries.length;
  return {
    size: n, route: Int32Array.from(entries.map((e) => e[0])), dir: new Uint8Array(n), carrier: Int32Array.from(entries.map((e) => e[1])),
    tier: Uint8Array.from(entries.map((e) => e[2])), cls: new Uint8Array(n), count: Int32Array.from(entries.map((e) => e[3])),
  };
}

describe('events: observed changes by area class', () => {
  const before = rows([[0, 0, 1, 70], [1, 0, 4, 70], [2, 1, 1, 14], [3, 1, 1, 70], [4, 0, 1, 7]]);
  const after = rows([[0, 0, 1, 7], [2, 1, 1, 70], [3, 1, 1, 70], [1, 1, 1, 7]]);
  const c = observedChanges(net, before, after, 7, 7, ['X'], ['Y']);

  it('classes A (inside), B (inside-outside), C (neighbour)', () => {
    const by = Object.fromEntries(c.routes.map((r) => [r.route, r]));
    expect(by[0]!.cls).toBe('A');
    expect(by[1]!.cls).toBe('B');
    expect(by[2]!.cls).toBe('C');
    expect(by[3]).toBeUndefined(); // other: only in the totals
    expect(by[0]!.change).toBe('down');
    expect(by[2]!.change).toBe('up');
    expect(by[4]!.change).toBe('notAfter');
    expect(by[1]!.change).toBe('down');
    const a = c.classes.find((x) => x.cls === 'A')!;
    expect(a.beforeDaily).toBe(10);
    expect(a.afterDaily).toBe(1);
  });

  it('airlines: only flights touching the area; tiers can be dropped', () => {
    const aaa = c.carriers.find((x) => x.carrier === 0)!;
    expect(aaa.beforeDaily).toBe(21);
    expect(aaa.afterDaily).toBe(1);
    const t13 = observedChanges(net, before, after, 7, 7, ['X'], ['Y'], { includeT4: false, passengerOnly: false, minFlights: 1, ratio: 1.5, minDelta: 0.5 });
    expect(t13.routes.find((r) => r.route === 1)!.change).toBe('onlyAfter'); // T4 before is dropped
  });

  it('airports observed', () => {
    expect(c.airportsObserved.before).toBe(5);
    expect(c.airportsObserved.after).toBe(5);
  });
});

describe('temporal aggregator: group series (Phase 9G)', () => {
  const geo: RouteGeo = { a: Int32Array.from([0, 0, 2, 3, 1]), b: Int32Array.from([1, 3, 3, 4, 4]), airportCountry: Int32Array.from([0, 0, 1, 2, 2]) };
  const day = (d: string, flights: [route: number, minute: number, tier: number][]): DayEvents => {
    const t0 = utcDayMs(d);
    const n = flights.length;
    return {
      day: d, size: n, timeMs: Float64Array.from(flights.map((f) => t0 + f[1] * 60_000)), route: Int32Array.from(flights.map((f) => f[0])),
      carrier: new Int32Array(n), direction: new Uint8Array(n), aircraftClass: new Uint8Array(n), tier: Uint8Array.from(flights.map((f) => f[2])), basis: new Uint8Array(n),
    };
  };
  const groups: GroupSpec[] = [
    { id: 'touch', countries: [0], mode: 'touch', carrier: null, includeT4: true, passengerOnly: false },
    { id: 'within', countries: [0], mode: 'within', carrier: null, includeT4: true, passengerOnly: false },
    { id: 'cross', countries: [0], mode: 'cross', carrier: null, includeT4: true, passengerOnly: false },
    { id: 'crossT13', countries: [0], mode: 'cross', carrier: null, includeT4: false, passengerOnly: false },
    { id: 'neigh', countries: [1], mode: 'touch', carrier: null, includeT4: true, passengerOnly: false },
    // a comparison group of country 2 that must not count flights touching the area (country 0)
    { id: 'compClean', countries: [2], mode: 'touch', excludeCountries: [0], carrier: null, includeT4: true, passengerOnly: false },
  ];
  it('counts each group per day bin', () => {
    const w = { startMs: utcDayMs('2026-02-27'), endMs: utcDayMs('2026-03-01') };
    const agg = new WindowAggregator(w, 'all', 1, DAY, geo, null, groups);
    agg.addDay(day('2026-02-27', [[0, 10, 1], [1, 20, 4], [2, 30, 1], [3, 40, 1], [4, 50, 1]]));
    agg.addDay(day('2026-02-28', [[0, 10, 1], [3, 40, 1]]));
    const g = Object.fromEntries(agg.groupSeries().map((x) => [x.id, x.flights]));
    expect(g.touch).toEqual([3, 1]);
    expect(g.within).toEqual([1, 1]);
    expect(g.cross).toEqual([2, 0]);
    expect(g.crossT13).toEqual([1, 0]);
    expect(g.neigh).toEqual([1, 0]);
    expect(g.compClean).toEqual([2, 1]); // routes 2 (Y-Z) and 3 (Z-Z) only; routes 1 and 4 touch the area
  });
});
