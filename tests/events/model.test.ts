import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { areaCountries, validateHistory, versionOn, type AdvisoryHistory, type AdvisoryVersion } from '../../src/events/model';
import { en, ja } from '../../src/i18n/messages';

const hist = JSON.parse(readFileSync(resolve(__dirname, '../../public/data/events/easa-czib-history.json'), 'utf-8')) as AdvisoryHistory;

describe('events: advisory records', () => {
  const v = validateHistory(hist);
  const b = v.history.bulletins.find((x) => x.bulletinId === '2026-03')!;

  it('keeps the published history, with every version separate', () => {
    expect(v.dropped).toEqual([]);
    expect(b.revisions.map((r) => r.revisionId)).toContain('R4');
    expect(b.missingRevisions).toContain('R11');
    expect(new Set(b.revisions.map((r) => `${r.bulletinId}/${r.revisionId}`)).size).toBe(b.revisions.length);
  });

  it('the version in force in March 2026 is a March version, never the latest one', () => {
    expect(versionOn(b, '2026-03-15')!.revisionId).toBe('R3');
    expect(versionOn(b, '2026-03-18')!.revisionId).toBe('R4');
    expect(versionOn(b, '2026-02-27')).toBeNull();
    expect(versionOn(b, '2026-10-01')).toBeNull(); // withdrawn: valid until 8 July
  });

  it('issue date, revision date, validity and first sighting are distinct; times are UTC', () => {
    const r4 = b.revisions.find((r) => r.revisionId === 'R4')!;
    expect([r4.issueDate, r4.revisionDate, r4.validUntil]).toEqual(['2026-02-28', '2026-03-18', '2026-03-27']);
    expect(r4.firstSeenAt).toMatch(/Z$/);
    expect(r4.publicationTimestamp).toBeNull();
  });

  it('records without a checkable source, or marked as a closure, are dropped', () => {
    const r0 = b.revisions[0]!;
    const bad = (patch: Partial<AdvisoryVersion>) => ({ ...hist, bulletins: [{ ...b, revisions: [{ ...r0, ...patch }] }] }) as AdvisoryHistory;
    expect(validateHistory(bad({ sourceUrl: '' })).dropped[0]!.reason).toBe('no source URL');
    expect(validateHistory(bad({ captures: [] })).dropped[0]!.reason).toBe('no verified capture');
    expect(validateHistory(bad({ isClosure: true as unknown as false })).dropped[0]!.reason).toBe('not an advisory record');
  });

  it('area countries come from the country list, else from the airspace text, and FIRs stay separate', () => {
    const r0 = b.revisions.find((r) => r.revisionId === 'R0')!;
    expect(areaCountries(r0).basis).toBe('airspaceText');
    const r14 = b.revisions.find((r) => r.revisionId === 'R14')!;
    expect(areaCountries(r14)).toEqual({ iso2: ['BH', 'IR', 'IQ', 'IL', 'JO', 'KW', 'LB', 'OM', 'QA', 'AE', 'SA'], basis: 'field' });
    expect(r14.firs).toContain('OEJD');
    // Venezuela: R0 names the country; R1 and later name only FIRs (Maiquetia, San Juan, Curacao,
    // Piarco west of 57W). No country is guessed from a FIR: the airport-based analysis has no area.
    const ve = v.history.bulletins.find((x) => x.bulletinId === '2026-01')!;
    expect(areaCountries(ve.revisions[0]!)).toEqual({ iso2: ['VE'], basis: 'airspaceText' });
    const last = ve.revisions.at(-1)!;
    expect(last.firs).toEqual(['SVZM', 'TJZS', 'TNCF', 'TTZP']);
    expect(areaCountries(last)).toEqual({ iso2: [], basis: 'none' });
  });
});

describe('events: advisories never stop anything', () => {
  it('no simulation or network code reads the advisory records', () => {
    for (const dir of ['../../src/simulation', '../../src/research', '../../src/temporal']) {
      for (const f of readdirSync(resolve(__dirname, dir))) {
        const s = readFileSync(resolve(__dirname, dir, f), 'utf-8');
        expect(s.includes('events/model'), `${dir}/${f}`).toBe(false);
      }
    }
  });
});

describe('events: messages', () => {
  it('Japanese and English have the same event keys', () => {
    const ek = Object.keys(en).filter((k) => k.startsWith('ev.')).sort();
    expect(Object.keys(ja).filter((k) => k.startsWith('ev.')).sort()).toEqual(ek);
    expect(ek.length).toBeGreaterThan(100);
  });
});
