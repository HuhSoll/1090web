import { describe, expect, it } from 'vitest';
import { buildStaticNetwork } from '../src/data/loaders/datasetLoader';
import type { MonthData } from '../src/data/model/network';
import type { AirportRecord, DatasetManifest } from '../src/data/model/schema';
import { ChangeKind, classifyChange, computeComparison, relativeChange } from '../src/domain/comparison';
import { DEFAULT_FILTERS } from '../src/domain/networkView';

const manifest = {
  schemaVersion: 1,
  datasetId: 't',
  kind: 'observed',
  title: 't',
  generatedAt: '',
  months: [],
  carriers: [],
  sources: [],
  disclaimer: '',
} as unknown as DatasetManifest;

const ap = (id: string): AirportRecord => ({ id, iata: id, icao: null, name: id, city: id, country: 'XX', lat: 0, lon: 0 });
// 0: A-B  1: A-C  2: B-C  3: B-D
const network = buildStaticNetwork(manifest, [ap('A'), ap('B'), ap('C'), ap('D')], [
  [0, 'A', 'B'],
  [1, 'A', 'C'],
  [2, 'B', 'C'],
  [3, 'B', 'D'],
]);

describe('classifyChange', () => {
  it('distinguishes new, gone, up, down and stable', () => {
    expect(classifyChange(0, 0)).toBe(ChangeKind.Hidden);
    expect(classifyChange(0, 2 / 30)).toBe(ChangeKind.Hidden); // too rare to compare
    expect(classifyChange(0, 1)).toBe(ChangeKind.New);
    expect(classifyChange(1, 0)).toBe(ChangeKind.Gone);
    expect(classifyChange(10, 12)).toBe(ChangeKind.Up);
    expect(classifyChange(10, 8)).toBe(ChangeKind.Down);
    expect(classifyChange(10, 11)).toBe(ChangeKind.Stable); // +10% < 15%
  });

  it('ignores tiny absolute changes even when the ratio is large', () => {
    // 10 -> 13 flights a month is +30%, but only 0.1 flights per day.
    expect(classifyChange(10 / 30, 13 / 30)).toBe(ChangeKind.Stable);
  });
});

describe('computeComparison', () => {
  // Base month: 30 observed days. Target month: only 15 observed days (data gap).
  const base: MonthData = {
    month: '2026-01',
    observedDays: 30,
    records: [
      [0, 0, 'x', 300, 0, 0, 0], // 10/day
      [1, 0, 'x', 300, 0, 0, 0], // 10/day
      [2, 0, 'x', 90, 0, 0, 0], // 3/day
    ],
  };
  const target: MonthData = {
    month: '2026-02',
    observedDays: 15,
    records: [
      [0, 0, 'x', 150, 0, 0, 0], // 10/day -> stable despite half the monthly total
      [1, 0, 'x', 75, 0, 0, 0], // 5/day -> down
      [3, 0, 'x', 60, 0, 0, 0], // 4/day -> new
    ],
  };

  it('compares flights per observed day, not monthly totals', () => {
    const c = computeComparison(network, base, target, DEFAULT_FILTERS);
    expect(Array.from(c.kind)).toEqual([ChangeKind.Stable, ChangeKind.Down, ChangeKind.Gone, ChangeKind.New]);
    expect(c.counts).toEqual({ stable: 1, up: 0, down: 1, new: 1, gone: 1 });
    expect(c.perDay.base).toBeCloseTo(23);
    expect(c.perDay.target).toBeCloseTo(19);
  });

  it('lists the biggest gains and losses', () => {
    const c = computeComparison(network, base, target, DEFAULT_FILTERS);
    expect(c.topGainers.map((g) => g.routeId)).toEqual([3]);
    expect(c.topLosers.map((g) => g.routeId)).toEqual([1, 2]);
  });

  it('applies the monthly threshold to either month', () => {
    const c = computeComparison(network, base, target, { ...DEFAULT_FILTERS, minFlights: 100 });
    // route 2 (90 -> 0) and route 3 (0 -> 60) never reach 100 flights in a month
    expect(c.kind[2]).toBe(ChangeKind.Hidden);
    expect(c.kind[3]).toBe(ChangeKind.Hidden);
    expect(c.kind[0]).toBe(ChangeKind.Stable);
  });

  it('computes per-day airport movements for both months', () => {
    const c = computeComparison(network, base, target, DEFAULT_FILTERS);
    expect(c.airportBase[0]).toBeCloseTo(20); // A: routes 0 and 1
    expect(c.airportTarget[0]).toBeCloseTo(15);
  });
});

describe('relativeChange', () => {
  it('returns null when there is no base', () => {
    expect(relativeChange(0, 5)).toBeNull();
    expect(relativeChange(10, 12)).toBeCloseTo(0.2);
  });
});
