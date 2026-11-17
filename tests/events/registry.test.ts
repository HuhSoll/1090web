import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateHistory, type AdvisoryHistory } from '../../src/events/model';
import {
  czibEvents, endMs, EVENT_TYPES, eventsInWindow, filterEvents, layerOf, overlaps, spanOf, stackRows, startSpan, STATUSES,
  timeConflicts, validEvent, type EventFilter, type Registry, type TimeValue, type UnifiedEvent,
} from '../../src/events/registry';
import { subjectOf } from '../../src/events/study';
import { en, ja } from '../../src/i18n/messages';

const root = resolve(__dirname, '../..');
const registry = JSON.parse(readFileSync(resolve(root, 'public/data/events/events.json'), 'utf-8')) as Registry;
const czib = validateHistory(JSON.parse(readFileSync(resolve(root, 'public/data/events/easa-czib-history.json'), 'utf-8')) as AdvisoryHistory);
const all: UnifiedEvent[] = [...czibEvents(czib), ...registry.events.filter(validEvent)];
const byId = (id: string) => all.find((e) => e.eventId === id)!;
const D = (s: string) => Date.parse(s);
const DAY = 86_400_000;

const tv = (p: Partial<TimeValue>): TimeValue => ({ utc: null, local: null, tz: null, precision: 'date', basis: 'test', sourceId: 's', ...p });
const ev = (p: Partial<UnifiedEvent>): UnifiedEvent => ({
  schemaVersion: 1, eventId: 'X', eventType: 'AIRSPACE_CLOSURE', title: 't', titleJa: null, description: null, issuingAuthority: null,
  documentType: null, documentId: null, revisionId: null, occurrence: [], publication: [], effectiveFrom: [], effectiveUntil: [],
  firstVerifiedAt: null, coveredCountries: [], coveredFIRs: [], affectedAirports: [], affectedOperators: null, affectedAircraftTypes: [],
  altitudeRestrictions: null, closureScope: null, geometry: null,
  sourceReferences: [{ sourceId: 's', publisher: 'p', sourceType: 'authority', title: 't', url: 'https://x', capturedAt: null, retrievedAt: '2026-01-01T00:00:00Z', sha256: 'ab', supports: [] }],
  relatedEvents: [], verificationStatus: 'Verified', verified: [], notVerified: [], confidenceNotes: null, supersedesEventId: null, ...p,
});

describe('event registry: records', () => {
  it('every published event passes the browser guard and has downloaded sources', () => {
    expect(registry.rejected).toEqual([]);
    expect(registry.events.length).toBeGreaterThan(0);
    for (const e of registry.events) {
      expect(validEvent(e), e.eventId).toBe(true);
      for (const s of e.sourceReferences) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(EVENT_TYPES).toContain(e.eventType);
      expect(STATUSES).toContain(e.verificationStatus);
    }
    expect(new Set(all.map((e) => e.eventId)).size).toBe(all.length);
  });

  it('press-only events are never Verified or Partially Verified', () => {
    for (const e of registry.events) {
      const types = new Set(e.sourceReferences.map((s) => s.sourceType));
      if (!types.has('authority') && !types.has('archive') && !types.has('state-news-agency')) expect(e.verificationStatus, e.eventId).toBe('Unverified');
    }
  });

  it('a date-only time carries no UTC instant', () => {
    for (const e of registry.events) for (const f of [e.occurrence, e.publication, e.effectiveFrom, e.effectiveUntil]) for (const t of f) {
      if (t.precision === 'date') expect(t.utc, e.eventId).toBeNull();
    }
  });

  it('FAA notices are scoped to U.S. operators and are not closures', () => {
    const faa = registry.events.filter((e) => e.issuingAuthority === 'FAA');
    expect(faa.length).toBeGreaterThanOrEqual(3);
    for (const e of faa) {
      expect(e.affectedOperators?.scope, e.eventId).toBe('us-operators');
      expect(e.eventType).not.toBe('AIRSPACE_CLOSURE');
    }
    expect(byId('RST-FAA-SFAR77-ORBB').altitudeRestrictions?.text).toMatch(/FL320/);
  });

  it('a reopening points to what it reopens', () => {
    const r = byId('REO-KW-2026-04-23');
    expect(r.eventType).toBe('AIRSPACE_REOPENING');
    expect(r.relatedEvents.some((x) => x.relation === 'reopens' && x.eventId === 'CLS-KW-2026-02-28')).toBe(true);
  });

  it('the browser guard rejects events that claim more than their sources', () => {
    const press = { ...ev({}).sourceReferences[0]!, sourceType: 'press' as const };
    expect(validEvent(ev({ sourceReferences: [press] }))).toBe(false);
    expect(validEvent(ev({ sourceReferences: [press], verificationStatus: 'Unverified' }))).toBe(true);
    expect(validEvent(ev({ sourceReferences: [] }))).toBe(false);
    expect(validEvent(ev({ publication: [tv({ utc: '2026-02-28T00:00:00Z', local: '2026-02-28', precision: 'date' })] }))).toBe(false);
  });
});

describe('event registry: time precision', () => {
  it('a date is a whole day, never 00:00 UTC', () => {
    const s = spanOf(tv({ local: '2026-02-28', tz: 'Asia/Dubai' }))!;
    expect(s.kind).toBe('day');
    expect(new Date(s.startMs).toISOString()).toBe('2026-02-27T20:00:00.000Z');
    expect(s.endMs - s.startMs).toBe(DAY);
    expect(s.zoneUncertain).toBe(false);
  });

  it('a date in an unknown or daylight-saving zone is flagged uncertain', () => {
    expect(spanOf(tv({ local: '2026-02-28', tz: null }))!.zoneUncertain).toBe(true);
    expect(spanOf(tv({ local: '2026-02-28', tz: 'Europe/Berlin' }))!.zoneUncertain).toBe(true);
  });

  it('a minute is an instant; an unknown time has no position', () => {
    const s = spanOf(tv({ utc: '2026-02-28T09:21:00Z', precision: 'minute' }))!;
    expect(s.kind).toBe('exact');
    expect(s.startMs).toBe(D('2026-02-28T09:21:00Z'));
    expect(spanOf(tv({ precision: 'unknown' }))).toBeNull();
    expect(startSpan(ev({}))).toBeNull();
  });

  it('times of different sources are kept, and a disagreement is reported', () => {
    const e = ev({ publication: [tv({ local: '2026-02-28', tz: 'UTC', sourceId: 'a' }), tv({ local: '2026-03-05', tz: 'UTC', sourceId: 'b' })] });
    expect(e.publication).toHaveLength(2);
    expect(timeConflicts(e)).toEqual(['publication']);
    expect(timeConflicts(ev({ publication: [tv({ local: '2026-02-28', tz: 'UTC' }), tv({ utc: '2026-02-28T09:00:00Z', precision: 'minute' })] }))).toEqual([]);
  });

  it('occurrence comes before effective-from and publication for the start', () => {
    const e = ev({ occurrence: [tv({ local: '2026-02-27', tz: 'UTC' })], publication: [tv({ local: '2026-02-20', tz: 'UTC' })] });
    expect(startSpan(e)!.startMs).toBe(D('2026-02-27T00:00:00Z'));
  });
});

describe('event registry: CZIB compatibility', () => {
  it('each CZIB version is one safety advisory, keyed as before', () => {
    const r0 = byId('CZIB:2026-03/R0');
    expect(r0.eventType).toBe('SAFETY_ADVISORY');
    expect(r0.czib).toEqual({ bulletinId: '2026-03', revisionId: 'R0' });
    expect(r0.publication[0]!.utc).toBeNull();
    expect(r0.publication[0]!.local).toBe('2026-02-28');
    expect(r0.affectedOperators?.scope).toBe('eu-operators');
    expect(r0.closureScope).toBeNull();
    // a version is in force until the next one
    expect(endMs(r0)).toBe(spanOf(tv({ local: '2026-03-02', tz: 'Europe/Berlin' }))!.endMs);
    expect(byId('CZIB:2026-03/R1').supersedesEventId).toBe('CZIB:2026-03/R0');
  });

  it('a study subject keeps the Phase 9G event day', () => {
    const b = czib.history.bulletins.find((x) => x.bulletinId === '2026-03')!;
    const v = b.revisions.find((r) => r.revisionId === 'R0')!;
    const s = subjectOf(byId('CZIB:2026-03/R0'), v)!;
    expect(s.effectiveDate).toBe(v.effectiveDate);
    expect(s.version).toBe(v);
    expect(s.label).toBe(`EASA CZIB ${v.czibNumber}`);
  });

  it('a non-CZIB subject uses the local day of a date, or the UTC day of an instant', () => {
    const uae = subjectOf(byId('RST-AE-2026-02-28-PARTIAL'))!;
    expect(uae.effectiveDate).toBe('2026-02-28');
    expect(uae.dayBasis).toBe('date');
    expect(uae.area.iso2).toEqual(['AE']);
    const qa = subjectOf(byId('CLS-QA-2026-02-28'))!;
    expect(qa.effectiveDate).toBe('2026-02-28');
    expect(qa.dayBasis).toBe('utc-instant');
    expect(subjectOf(ev({}))).toBeNull();
  });
});

describe('event registry: filters, windows and overlaps', () => {
  const f: EventFilter = { startMs: D('2026-02-20T00:00:00Z'), endMs: D('2026-03-20T00:00:00Z'), types: [...EVENT_TYPES], statuses: [...STATUSES], places: [], text: '' };

  it('the Middle East case period holds the national, FAA and EASA events', () => {
    const ids = filterEvents(all, f).map((e) => e.eventId);
    for (const id of ['CZIB:2026-03/R0', 'RST-AE-2026-02-28-PARTIAL', 'CLS-QA-2026-02-28', 'RST-FAA-SFAR117-OIIX', 'SEC-2026-02-28-STRIKES-IRAN']) expect(ids).toContain(id);
    expect(ids).not.toContain('REO-KW-2026-04-23');
  });

  it('filters by type, status, place and text', () => {
    expect(filterEvents(all, { ...f, types: ['AIRPORT_CLOSURE'] }).map((e) => e.eventId)).toEqual(['APT-QA-OTHH-2026-02-28']);
    expect(filterEvents(all, { ...f, statuses: ['Unverified'] }).every((e) => e.verificationStatus === 'Unverified')).toBe(true);
    expect(filterEvents(all, { ...f, places: ['OTHH'] }).map((e) => e.eventId)).toContain('APT-QA-OTHH-2026-02-28');
    expect(filterEvents(all, { ...f, places: ['QA'] }).every((e) => e.coveredCountries.includes('QA'))).toBe(true);
    expect(filterEvents(all, { ...f, text: 'sfar 77' }).map((e) => e.eventId)).toEqual(['RST-FAA-SFAR77-ORBB']);
  });

  it('a security incident without an end lasts its day; a restriction without an end stays in force', () => {
    const sec = byId('SEC-2026-02-28-STRIKES-IRAN');
    expect(eventsInWindow([sec], D('2026-03-05T00:00:00Z'), D('2026-03-06T00:00:00Z'))).toEqual([]);
    const uae = byId('RST-AE-2026-02-28-PARTIAL');
    expect(eventsInWindow([uae], D('2026-03-05T00:00:00Z'), D('2026-03-06T00:00:00Z'))).toEqual([uae]);
  });

  it('a window ending before an event does not list it', () => {
    const qa = byId('CLS-QA-2026-02-28');
    expect(eventsInWindow([qa], D('2026-02-14T00:00:00Z'), D('2026-02-28T00:00:00Z'))).toEqual([]);
  });

  it('overlaps report the shared span; stacked rows never share overlapping bars', () => {
    const a = ev({ eventId: 'a', effectiveFrom: [tv({ local: '2026-03-01', tz: 'UTC' })], effectiveUntil: [tv({ local: '2026-03-05', tz: 'UTC' })] });
    const b = ev({ eventId: 'b', effectiveFrom: [tv({ local: '2026-03-04', tz: 'UTC' })], effectiveUntil: [tv({ local: '2026-03-08', tz: 'UTC' })] });
    const c = ev({ eventId: 'c', effectiveFrom: [tv({ local: '2026-03-10', tz: 'UTC' })], effectiveUntil: [tv({ local: '2026-03-11', tz: 'UTC' })] });
    expect(overlaps([a, b, c])).toEqual([{ a: 'a', b: 'b', startMs: D('2026-03-04T00:00:00Z'), endMs: D('2026-03-06T00:00:00Z') }]);
    const rows = stackRows([{ id: 'a', startMs: 0, endMs: 10 }, { id: 'b', startMs: 5, endMs: 15 }, { id: 'c', startMs: 10, endMs: 12 }]);
    expect(rows.get('a')).toBe(0);
    expect(rows.get('b')).toBe(1);
    expect(rows.get('c')).toBe(0);
  });

  it('layers: A security, B restrictions and closures, C advisories', () => {
    expect(layerOf('SECURITY_INCIDENT')).toBe('A');
    expect(layerOf('AIRSPACE_CLOSURE')).toBe('B');
    expect(layerOf('AIRSPACE_REOPENING')).toBe('B');
    expect(layerOf('SAFETY_ADVISORY')).toBe('C');
  });
});

describe('event registry: no automatic stops', () => {
  it('the simulation and network code never read the event registry', () => {
    const dirs = ['src/simulation', 'src/islands', 'src/experiments', 'src/domain', 'src/temporal'];
    for (const d of dirs) {
      const files = readdirSync(resolve(root, d), { recursive: true }) as string[];
      expect(files.length, d).toBeGreaterThan(0);
      for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
        const s = readFileSync(resolve(root, d, f), 'utf-8');
        expect(s, `${d}/${f}`).not.toMatch(/events\/registry|events\.json/);
      }
    }
  });
});

describe('event registry: messages', () => {
  it('every ei.* key exists in both languages', () => {
    const k = (m: Record<string, string>) => Object.keys(m).filter((x) => x.startsWith('ei.')).sort();
    expect(k(en)).toEqual(k(ja));
    for (const t of EVENT_TYPES) expect(en[`ei.type.${t}` as keyof typeof en]).toBeTruthy();
    for (const s of STATUSES) expect(ja[`ei.status.${s}` as keyof typeof ja]).toBeTruthy();
  });
});
