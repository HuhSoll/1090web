import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkImport, METHOD_VERSION as EXPERIMENTS_METHOD } from '../../src/experiments/model';
import { en, ja } from '../../src/i18n/messages';
import { findingProblems, FINDINGS_FORMAT, goTo, openFinding, VALIDATION_STATUSES, type Finding, type FindingsFile } from '../../src/research/findings';
import { useAppStore } from '../../src/state/store';

const root = resolve(__dirname, '../..');
const file = JSON.parse(readFileSync(resolve(root, 'public/data/findings/findings.json'), 'utf-8')) as FindingsFile;
const registry = JSON.parse(readFileSync(resolve(root, 'public/data/events/events.json'), 'utf-8')) as { events: { eventId: string }[] };
const czib = JSON.parse(readFileSync(resolve(root, 'public/data/events/easa-czib-history.json'), 'utf-8')) as { bulletins: { bulletinId: string; revisions: { revisionId: string }[] }[] };
const islands = JSON.parse(readFileSync(resolve(root, 'public/data/islands/okinawa-pilot/network.json'), 'utf-8')) as { gateways: { id: string }[] };
const eventIds = new Set([...registry.events.map((e) => e.eventId), ...czib.bulletins.flatMap((b) => b.revisions.map((r) => `CZIB:${b.bulletinId}/${r.revisionId}`))]);

describe('findings: records', () => {
  it('every finding has every field and a known status', () => {
    expect(file.format).toBe(FINDINGS_FORMAT);
    for (const f of file.findings) expect(findingProblems(f), f.findingId).toEqual([]);
    expect(new Set(file.findings.map((f) => f.findingId)).size).toBe(file.findings.length);
  });

  it('the audit did not mark everything as validated', () => {
    const statuses = new Set(file.findings.map((f) => f.validationStatus));
    expect(statuses.size).toBeGreaterThanOrEqual(3);
    expect(statuses.has('Not Supported')).toBe(true);
    for (const s of statuses) expect(VALIDATION_STATUSES).toContain(s);
  });

  it('covers the candidate findings of the Phase 9I brief', () => {
    for (const id of ['F-9E-TIERS', 'F-9E-LOWFREQ', 'F-9E-SYS-SPILL', 'F-9F-ISG', 'F-9G-DROP', 'F-9G-PRETREND', 'F-9G-CONNECTIVITY']) {
      expect(file.findings.some((f) => f.findingId === id), id).toBe(true);
    }
  });

  it('the DiD of Phase 9H is recorded as not supported as an effect', () => {
    const d = file.findings.find((f) => f.findingId === 'F-9H-DID')!;
    expect(d.validationStatus).toBe('Not Supported');
    expect(d.statement.en).toMatch(/not supported/i);
  });

  it('links point to things that exist', () => {
    const configs = resolve(root, 'pipeline/experiments/configs');
    for (const f of file.findings) {
      const l = f.link;
      if (l.tab === 'events') expect(eventIds.has(l.eventId), `${f.findingId} ${l.eventId}`).toBe(true);
      if (l.tab === 'islands') for (const a of l.airports) expect(islands.gateways.some((g) => g.id === a), a).toBe(true);
      if (l.tab === 'temporal') expect(l.start < l.end).toBe(true);
      for (const x of f.relatedExperiments) expect(existsSync(resolve(configs, `${x}.json`)), `${f.findingId}: ${x}`).toBe(true);
      for (const r of f.sourceReferences) if (r.path) expect(existsSync(resolve(root, r.path)), r.path).toBe(true);
      expect(f.dataset.id).toMatch(/observed-2026-v2/);
    }
  });

  it('an incomplete finding is left out, not shown with guesses', () => {
    const ok = file.findings.find((f) => f.validationStatus === 'Preliminary')!;
    const broken: Finding = { ...ok, limitations: [] };
    expect(findingProblems(broken)).toContain('limitations');
    expect(findingProblems({ ...ok, validationStatus: 'Likely' as Finding['validationStatus'] })).toContain('validationStatus');
    expect(findingProblems({ ...ok, period: { start: '2026-03-31', end: '2026-03-01' } })).toContain('period');
    expect(findingProblems({ ...ok, evidence: [] })).toContain('evidence');
  });
});

describe('findings: navigation', () => {
  beforeEach(() => {
    useAppStore.setState({ appMode: 'research', researchTab: 'findings', eventFocus: null, islandHandoff: null });
  });

  it('opens an event in Event investigation', () => {
    openFinding({ tab: 'events', eventId: 'CZIB:2026-03/R0' }, 'x');
    const s = useAppStore.getState();
    expect(s.researchTab).toBe('events');
    expect(s.eventFocus).toEqual({ eventId: 'CZIB:2026-03/R0' });
    expect(s.appMode).toBe('research');
  });

  it('opens the island lab with the stopped airport', () => {
    openFinding({ tab: 'islands', airports: ['ROIG'] }, 'New Ishigaki');
    const s = useAppStore.getState();
    expect(s.researchTab).toBe('islands');
    expect(s.islandHandoff).toEqual({ scenarioName: 'New Ishigaki', airports: ['ROIG'], from: 'finding' });
  });

  it('shows a period on the map as an exact custom window', () => {
    openFinding({ tab: 'temporal', start: '2026-05-04', end: '2026-05-09' }, 'gap');
    const s = useAppStore.getState();
    expect(s.appMode).toBe('explore');
    expect(s.exploreTime).toBe('temporal');
    expect(s.temporalSel!.preset).toBe('custom');
    expect(s.temporalSel!.customStartMs).toBe(Date.UTC(2026, 4, 4));
    expect(s.temporalSel!.customEndMs).toBe(Date.UTC(2026, 4, 9));
  });

  it('Research Home goes to each research tab', () => {
    for (const tab of ['rankings', 'experiments', 'reliability', 'islands', 'events', 'findings'] as const) {
      goTo(tab);
      expect(useAppStore.getState().researchTab).toBe(tab);
    }
  });
});

describe('findings: messages and compatibility', () => {
  it('Home and Findings have every message in both languages', () => {
    const keys = (m: Record<string, string>) => Object.keys(m).filter((k) => k.startsWith('rh.') || k.startsWith('rf.')).sort();
    expect(keys(en)).toEqual(keys(ja));
    for (const s of VALIDATION_STATUSES) {
      expect(en[`rf.s.${s}` as keyof typeof en]).toBeTruthy();
      expect(ja[`rf.s.${s}.def` as keyof typeof ja]).toBeTruthy();
    }
    for (const f of file.findings) expect(en[`rf.open.${f.link.tab}` as keyof typeof en], f.link.tab).toBeTruthy();
  });

  it('experiment results of an older method are flagged when imported', () => {
    expect(EXPERIMENTS_METHOD).toBe('9e.2');
    // a minimal result in the current format, then the same with the 9E method version
    const r = { format: '1090web-experiment-result', schemaVersion: 1, methodVersion: '9e.1', definitionHash: 'h', definition: {}, dataset: { id: 'x', version: '1', continentRule: 'airport-v1' }, createdAt: '', source: '', computation: { exact: true, sources: [1], sourceSeed: 1, randomSeed: 1, note: '' }, candidates: { count: 0, rule: null }, complete: true, runs: [], airports: [], systemicVsSpillover: {} };
    const c = checkImport(r, 'x', '1');
    expect(c.ok && c.warnings).toContain('x.import.method');
  });

  it('no message presents an observed change as an effect of an event', () => {
    // every sentence that mentions an effect / causation must deny it
    const scope = (k: string) => k.startsWith('ev.') || k.startsWith('ei.') || k.startsWith('rf.') || k.startsWith('rh.');
    for (const [k, v] of Object.entries(en)) {
      if (!scope(k)) continue;
      for (const sentence of String(v).split(/(?<=[.;])\s+/)) {
        if (/\b(effect|caused?|causal)\b/i.test(sentence)) expect(/\b(not|no|none|never|cannot|nothing)\b/i.test(sentence), `${k}: ${sentence}`).toBe(true);
      }
    }
  });
});
