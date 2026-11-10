import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAdvisories } from '../src/data/loaders/advisoryLoader';
import type { Advisory } from '../src/data/model/advisory';
import { advisoriesForCountry, advisoriesInMonth, advisoryCountryCodes, monthBounds } from '../src/domain/advisories';

const a = (id: string, issued: string | null, end: string | null, iso2 = 'IR', num = '364'): Advisory => ({
  id,
  kind: 'safety-warning',
  title: id,
  status: 'withdrawn',
  issued,
  end,
  endIsApproximate: false,
  validUntilNote: '',
  countries: [{ iso2, isoNumeric: num, name: iso2 }],
  partialArea: false,
});

describe('advisories', () => {
  it('computes month bounds, including February', () => {
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('nope')).toBeNull();
  });

  it('selects advisories that overlap the month', () => {
    const items = [
      a('before', '2025-01-01', '2026-01-31'),
      a('starts-late', '2026-02-28', '2026-07-08'),
      a('open-ended', '2017-03-31', null, 'SY', '760'),
      a('after', '2026-03-01', '2026-05-01'),
    ];
    expect(advisoriesInMonth(items, '2026-02').map((x) => x.id)).toEqual(['starts-late', 'open-ended']);
    expect(advisoriesInMonth(items, '2026-01').map((x) => x.id)).toEqual(['before', 'open-ended']);
  });

  it('lists affected countries without duplicates', () => {
    const items = [a('x', null, null), a('y', null, null), a('z', null, null, 'SY', '760')];
    expect(advisoryCountryCodes(items).sort()).toEqual(['364', '760']);
    expect(advisoriesForCountry(items, 'SY').map((x) => x.id)).toEqual(['z']);
  });

  it('the published EASA file validates and is credited', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', 'advisories', 'easa-czib.json'), 'utf8'));
    const f = validateAdvisories(raw);
    expect(f.source.license).toContain('source is acknowledged');
    expect(f.items.every((i) => i.kind === 'safety-warning')).toBe(true);
    expect(f.items.every((i) => !i.issued || !i.end || i.end >= i.issued)).toBe(true);
  });
});
