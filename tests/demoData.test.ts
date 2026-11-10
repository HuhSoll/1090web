import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAirports, validateManifest, validateMonth, validateRoutes } from '../src/data/loaders/validate';

const root = join(__dirname, '..', 'public', 'data', 'demo');
const read = (p: string): unknown => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('demo dataset', () => {
  const manifest = validateManifest(read('manifest.json'));
  const airports = validateAirports(read('airports.json'));
  const routes = validateRoutes(read('routes.json'), new Set(airports.map((a) => a.id)));

  it('is explicitly marked as demo data with a disclaimer', () => {
    expect(manifest.kind).toBe('demo');
    expect(manifest.disclaimer.toLowerCase()).toContain('synthetic');
  });

  it('uses only fictional carriers', () => {
    for (const c of manifest.carriers) {
      expect(c.id.startsWith('demo-')).toBe(true);
      expect(c.name.startsWith('Demo ')).toBe(true);
    }
  });

  it('has a month file for every manifest entry and they validate', () => {
    const files = readdirSync(join(root, 'months'));
    expect(files.length).toBe(manifest.months.length);
    const carrierIds = new Set(manifest.carriers.map((c) => c.id));
    for (const entry of manifest.months) {
      const m = validateMonth(read(entry.file), routes.length);
      expect(m.month).toBe(entry.month);
      expect(m.records.length).toBe(entry.recordCount);
      for (const r of m.records) expect(carrierIds.has(r[2])).toBe(true);
    }
  });

  it('every airport has at least one route', () => {
    const used = new Set(routes.flatMap((r) => [r[1], r[2]]));
    for (const a of airports) expect(used.has(a.id), a.id).toBe(true);
  });
});

describe('validators', () => {
  it('reject malformed data', () => {
    expect(() => validateManifest({ schemaVersion: 2 })).toThrow();
    expect(() => validateAirports([{ id: 'X', lat: 100, lon: 0 }])).toThrow();
    expect(() => validateRoutes([[1, 'A', 'B']], new Set(['A', 'B']))).toThrow();
    expect(() => validateMonth({ month: 'x', records: [[5, 0, 'c', 1, 0, 0]] }, 2)).toThrow();
  });
});
