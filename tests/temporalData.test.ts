import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toMonthData, WindowAggregator } from '../src/temporal/aggregate';
import { dayStartMs, decodeDay, hourlyCounts, routeCounts, selectWindow, type DayFile, type TemporalIndex } from '../src/temporal/model';

const root = join(__dirname, '..', 'public', 'data', 'observed-2026-v2', 'temporal');
const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const H = 3_600_000;

describe.skipIf(!existsSync(join(root, 'index.json')))('observed-2026-v2 temporal data', () => {
  const index = read<TemporalIndex>('index.json');
  const manifest = read<{ files: Record<string, { bytes: number }>; license: string; privacy: string; days: { count: number } }>('manifest.json');

  it('covers every calendar day of January to September 2026', () => {
    expect(index.days.length).toBe(273);
    expect(index.days[0]!.day).toBe('2026-01-01');
    expect(index.days.at(-1)!.day).toBe('2026-09-30');
    expect(manifest.days.count).toBe(273);
    expect(manifest.license).toContain('ODbL-1.0');
  });

  it('keeps every file small enough for GitHub Pages', () => {
    for (const f of Object.values(manifest.files)) expect(f.bytes).toBeLessThan(5_000_000);
  });

  it('marks the May 2026 collection gap', () => {
    const may6 = index.days.find((d) => d.day === '2026-05-06')!;
    expect(may6.flights).toBe(0);
    expect(may6.anomaly?.evidence).toBe('collection_gap');
  });

  it('decodes a day consistently with the index and selects windows fast', () => {
    const entry = index.days.find((d) => d.day === '2026-03-10')!;
    const t0 = performance.now();
    const ev = decodeDay(read<DayFile>(entry.file));
    const decodeMs = performance.now() - t0;
    expect(ev.size).toBe(entry.flights);
    const start = dayStartMs('2026-03-10');
    const days = new Map([[ev.day, ev]]);
    const t1 = performance.now();
    const six = selectWindow(days, start + 12 * H, start + 18 * H);
    const und = routeCounts(six, false);
    const selectMs = performance.now() - t1;
    expect(hourlyCounts(selectWindow(days, start, start + 24 * H))).toEqual(entry.hourly);
    expect(six.flights).toBe(entry.hourly.slice(12, 18).reduce((a, b) => a + b, 0));
    expect([...und.values()].reduce((a, b) => a + b, 0)).toBe(six.flights);
    // generous bounds: these run in well under a second on a laptop
    expect(decodeMs).toBeLessThan(2000);
    expect(selectMs).toBeLessThan(500);
  });
});

describe.skipIf(!existsSync(join(root, 'index.json')))('incremental aggregation on the real data', () => {
  const index = read<TemporalIndex>('index.json');
  const monthDir = join(__dirname, '..', 'public', 'data', 'observed-2026-v2');
  const carriers = (JSON.parse(readFileSync(join(monthDir, 'manifest.json'), 'utf8')) as { carriers: { id: string }[] }).carriers.map((c) => c.id);

  it('a calendar month aggregated day by day equals the monthly file (31 days, beyond the old 10-day limit)', () => {
    const w = { startMs: Date.UTC(2026, 2, 1), endMs: Date.UTC(2026, 3, 1) };
    const agg = new WindowAggregator(w, 'all', carriers.length, 86_400_000);
    for (const d of index.days.filter((x) => x.day.startsWith('2026-03'))) agg.addDay(decodeDay(read<DayFile>(d.file)));
    const fromDays = toMonthData(agg.rows(), carriers, '2026-03', 31);
    const monthly = JSON.parse(readFileSync(join(monthDir, 'months', '2026-03.json'), 'utf8')) as { records: (string | number)[][] };
    const key = (r: (string | number)[]) => `${r[0]}|${r[1]}|${r[2]}|${r[6] ?? 0}`;
    const a = new Map(fromDays.records.map((r) => [key(r), `${r[3]},${r[4]},${r[5]}`]));
    const b = new Map(monthly.records.map((r) => [key(r), `${r[3]},${r[4]},${r[5]}`]));
    expect(a.size).toBe(b.size);
    let differing = 0;
    for (const [k, v] of b) if (a.get(k) !== v) differing++;
    expect(differing).toBe(0);
    expect(agg.series().flights.reduce((x, y) => x + y, 0)).toBe(agg.flights);
    expect(agg.trackStart + agg.fallback).toBe(agg.flights);
  }, 60_000);

  it('track-start-only keeps exactly the TRACK_START flights', () => {
    const w = { startMs: Date.UTC(2026, 2, 10), endMs: Date.UTC(2026, 2, 11) };
    const ev = decodeDay(read<DayFile>(index.days.find((d) => d.day === '2026-03-10')!.file));
    const all = new WindowAggregator(w, 'all', carriers.length, 3_600_000);
    const start = new WindowAggregator(w, 'start', carriers.length, 3_600_000);
    all.addDay(ev);
    start.addDay(ev);
    expect(start.flights).toBe(all.trackStart);
    expect(all.flights - start.flights).toBe(all.fallback);
    expect(all.fallback).toBeGreaterThan(0);
  });
});
