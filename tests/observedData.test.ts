import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAirports, validateManifest, validateMonth, validateRoutes } from '../src/data/loaders/validate';

for (const id of ['observed-2026', 'observed-2026-v2']) {
const root = join(__dirname, '..', 'public', 'data', id);
const read = (p: string): unknown => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe.skipIf(!existsSync(join(root, 'manifest.json')))(`${id} dataset`, () => {
  const manifest = validateManifest(read('manifest.json'));
  const airports = validateAirports(read('airports.json'));
  const routes = validateRoutes(read('routes.json'), new Set(airports.map((a) => a.id)));

  it('is marked as observed and credits its ODbL source', () => {
    expect(manifest.kind).toBe('observed');
    const src = manifest.sources.find((s) => s.id === 'mrairspace');
    expect(src?.license).toBe('ODbL-1.0');
    expect(manifest.quality).toBeDefined();
  });

  it('lists carriers busiest first', () => {
    const flights = manifest.carriers.map((c) => c.flights ?? 0);
    for (let i = 1; i < flights.length; i++) expect(flights[i]!).toBeLessThanOrEqual(flights[i - 1]!);
  });

  it('has valid month files with a basis column', () => {
    const carrierIds = new Set(manifest.carriers.map((c) => c.id));
    for (const entry of manifest.months) {
      const m = validateMonth(read(entry.file), routes.length);
      expect(m.records.length).toBe(entry.recordCount);
      expect(m.observedDays).toBeLessThanOrEqual(m.daysInMonth ?? 31);
      for (const r of m.records.slice(0, 2000)) {
        expect(r.length).toBe(7);
        expect(carrierIds.has(r[2])).toBe(true);
      }
    }
  });

  it('has no self-loop routes and only airports with coordinates', () => {
    for (const [, a, b] of routes.slice(0, 5000)) expect(a).not.toBe(b);
    expect(airports.every((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))).toBe(true);
  });
});
}
