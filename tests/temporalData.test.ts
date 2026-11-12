import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
