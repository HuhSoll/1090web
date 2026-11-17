/**
 * Event Intelligence (Phase 9H): one model for every real event: EASA CZIB versions (Phase 9G
 * history, mapped here, unchanged on disk) and the events of public/data/events/events.json
 * (FAA notices, national restrictions and closures, security incidents, reopenings).
 *
 * Times keep their precision. A date-only time is a whole day (in the stated time zone when one
 * is given), never 00:00 UTC; an unknown time has no position at all.
 */
import { useEffect, useState } from 'react';
import { assetUrl } from '../data/loaders/fetchJson';
import { loadAdvisoryHistory, type AdvisoryVersion, type ValidatedHistory } from './model';

export type EventType = 'SAFETY_ADVISORY' | 'AIRSPACE_RESTRICTION' | 'AIRSPACE_CLOSURE' | 'AIRPORT_CLOSURE' | 'SECURITY_INCIDENT' | 'AIRSPACE_REOPENING' | 'OTHER_VERIFIED_EVENT';
export const EVENT_TYPES: EventType[] = ['SECURITY_INCIDENT', 'AIRSPACE_CLOSURE', 'AIRSPACE_RESTRICTION', 'AIRPORT_CLOSURE', 'AIRSPACE_REOPENING', 'SAFETY_ADVISORY', 'OTHER_VERIFIED_EVENT'];
export type VerificationStatus = 'Verified' | 'Partially Verified' | 'Disputed' | 'Incomplete' | 'Unverified';
export const STATUSES: VerificationStatus[] = ['Verified', 'Partially Verified', 'Disputed', 'Incomplete', 'Unverified'];
export type Precision = 'minute' | 'hour' | 'date' | 'month' | 'unknown';
/** Timeline layers: A security, B restrictions / closures / reopenings, C advisories */
export type Layer = 'A' | 'B' | 'C';

export interface TimeValue {
  /** UTC instant; null unless the source gives a time of day */
  utc: string | null;
  /** the time as the source states it */
  local: string | null;
  /** IANA zone or a +hh:mm offset when known */
  tz: string | null;
  precision: Precision;
  basis: string;
  sourceId: string;
}

export interface SourceRef {
  sourceId: string;
  publisher: string;
  sourceType: 'authority' | 'archive' | 'state-news-agency' | 'press';
  title: string;
  url: string;
  capturedAt: string | null;
  retrievedAt: string;
  sha256: string;
  supports: string[];
}

export interface RelatedEvent {
  eventId: string;
  relation: string;
  /** source = the relation is stated by a source; temporal = only close in time */
  basis: 'source' | 'temporal';
  missing?: boolean;
}

export interface UnifiedEvent {
  schemaVersion: number;
  eventId: string;
  eventType: EventType;
  title: string;
  titleJa: string | null;
  description: string | null;
  issuingAuthority: string | null;
  documentType: string | null;
  documentId: string | null;
  revisionId: string | null;
  occurrence: TimeValue[];
  publication: TimeValue[];
  effectiveFrom: TimeValue[];
  effectiveUntil: TimeValue[];
  firstVerifiedAt: string | null;
  coveredCountries: string[];
  coveredFIRs: string[];
  affectedAirports: string[];
  affectedOperators: { scope: 'all' | 'us-operators' | 'eu-operators' | 'specified'; text: string } | null;
  affectedAircraftTypes: string[];
  altitudeRestrictions: { lower: string; upper: string; text: string } | null;
  closureScope: 'full' | 'partial' | 'aircraft-types' | 'operators' | 'unknown' | null;
  geometry: null;
  sourceReferences: SourceRef[];
  relatedEvents: RelatedEvent[];
  verificationStatus: VerificationStatus;
  verified: string[];
  notVerified: string[];
  confidenceNotes: string | null;
  supersedesEventId: string | null;
  /** set for EASA CZIB versions (Phase 9G record) */
  czib?: { bulletinId: string; revisionId: string };
}

export interface Registry {
  schemaVersion: number;
  registryVersion: string;
  generatedAt: string;
  events: UnifiedEvent[];
  rejected: { eventId: string; errors: string[] }[];
  notCaptured: { subject: string; reason: string }[];
}

export function layerOf(t: EventType): Layer {
  if (t === 'SECURITY_INCIDENT' || t === 'OTHER_VERIFIED_EVENT') return 'A';
  if (t === 'SAFETY_ADVISORY') return 'C';
  return 'B';
}

/** A CZIB version as a SAFETY_ADVISORY event (Phase 9G record unchanged). */
export function czibEvent(v: AdvisoryVersion, nextEffective: string | null): UnifiedEvent {
  const date = (d: string | null, basis: string): TimeValue[] => (d ? [{ utc: null, local: d, tz: 'Europe/Berlin', precision: 'date', basis, sourceId: 'easa' }] : []);
  // a version is in force until the next version or its own expiry, whichever comes first
  const until = [v.validUntil, nextEffective].filter((x): x is string => !!x).sort()[0] ?? null;
  return {
    schemaVersion: 1,
    eventId: `CZIB:${v.bulletinId}/${v.revisionId}`,
    eventType: 'SAFETY_ADVISORY',
    title: `EASA CZIB ${v.czibNumber}: ${v.title ?? ''}`,
    titleJa: null,
    description: v.revisionDescription,
    issuingAuthority: 'EASA',
    documentType: 'Conflict Zone Information Bulletin',
    documentId: v.bulletinId,
    revisionId: v.revisionId,
    occurrence: [],
    publication: date(v.effectiveDate, v.revisionId === 'R0' ? 'issue date (EASA, no time)' : 'revision date (EASA, no time)'),
    effectiveFrom: [],
    effectiveUntil: date(until, until === v.validUntil ? 'valid until (EASA)' : 'replaced by the next version'),
    firstVerifiedAt: v.firstSeenAt,
    coveredCountries: (v.coveredCountries.length ? v.coveredCountries : v.countriesNamedInAirspace).map((c) => c.iso2).filter((x): x is string => !!x),
    coveredFIRs: v.firs,
    affectedAirports: [],
    affectedOperators: { scope: 'eu-operators', text: v.affectedOperatorScope ?? 'EASA operators and third-country operators authorised by EASA' },
    affectedAircraftTypes: [],
    altitudeRestrictions: null,
    closureScope: null,
    geometry: null,
    sourceReferences: v.captures.map((c) => ({
      sourceId: 'easa', publisher: 'EASA', sourceType: c.source === 'easa-live' ? 'authority' : 'archive', title: `CZIB ${v.czibNumber}`,
      url: c.url, capturedAt: c.source === 'wayback' ? c.at : null, retrievedAt: c.at, sha256: c.sha256, supports: ['all'],
    })),
    relatedEvents: [],
    verificationStatus: 'Verified',
    verified: ['The EASA page of this version (live or archived) states its dates, area and recommendations.'],
    notVerified: ['The UTC time of publication is not known (EASA gives dates only).', ...(v.contentVariants > 1 ? ['Captures of this version differ in content.'] : [])],
    confidenceNotes: 'A recommendation to operators; not a closure.',
    supersedesEventId: v.revisionId === 'R0' ? null : `CZIB:${v.bulletinId}/R${Number(v.revisionId.slice(1)) - 1}`,
    czib: { bulletinId: v.bulletinId, revisionId: v.revisionId },
  };
}

export function czibEvents(h: ValidatedHistory): UnifiedEvent[] {
  return h.history.bulletins.flatMap((b) => b.revisions.map((v, i) => czibEvent(v, b.revisions[i + 1]?.effectiveDate ?? null)));
}

// ---- time -------------------------------------------------------------------------------------

const DAY = 86_400_000;

function offsetMinutes(tz: string | null): number | null {
  if (!tz) return null;
  const m = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const fixed: Record<string, number> = { 'Asia/Dubai': 240, 'Asia/Kuwait': 180, 'Asia/Qatar': 180, 'Asia/Riyadh': 180, 'Asia/Tehran': 210, 'UTC': 0 };
  return fixed[tz] ?? null; // zones with daylight saving (Europe/Berlin, America/New_York) are not guessed
}

export interface Span {
  startMs: number;
  endMs: number;
  /** exact = an instant (minute or hour); day = a whole local day (UTC span known only roughly) */
  kind: 'exact' | 'day';
  /** the day's UTC span is uncertain by the zone offset (zone unknown or with daylight saving) */
  zoneUncertain: boolean;
}

/** The UTC span a time stands for, or null when unknown. A date is a whole day, never its 00:00. */
export function spanOf(t: TimeValue): Span | null {
  if (t.utc && (t.precision === 'minute' || t.precision === 'hour')) {
    const ms = Date.parse(t.utc);
    return { startMs: ms, endMs: ms + (t.precision === 'hour' ? 3_600_000 : 60_000), kind: 'exact', zoneUncertain: false };
  }
  if (t.precision === 'date' && t.local) {
    const m = t.local.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const off = offsetMinutes(t.tz);
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const s = off === null ? day : day - off * 60_000;
    return { startMs: s, endMs: s + DAY, kind: 'day', zoneUncertain: off === null };
  }
  return null;
}

/** First known span of the event (occurrence, then effective from, then publication). */
export function startSpan(e: UnifiedEvent): Span | null {
  for (const f of [e.occurrence, e.effectiveFrom, e.publication]) {
    const s = f.map(spanOf).filter((x): x is Span => !!x).sort((a, b) => a.startMs - b.startMs)[0];
    if (s) return s;
  }
  return null;
}

/** End of the event's effect when known (null = unknown or open). */
export function endMs(e: UnifiedEvent): number | null {
  const s = e.effectiveUntil.map(spanOf).filter((x): x is Span => !!x).sort((a, b) => b.endMs - a.endMs)[0];
  return s ? s.endMs : null;
}

/** Do the sources disagree on a time (two values of the same field more than a day apart)? */
export function timeConflicts(e: UnifiedEvent): string[] {
  const out: string[] = [];
  for (const [k, vals] of Object.entries({ occurrence: e.occurrence, publication: e.publication, effectiveFrom: e.effectiveFrom, effectiveUntil: e.effectiveUntil })) {
    const spans = vals.map(spanOf).filter((x): x is Span => !!x);
    if (spans.length > 1 && Math.max(...spans.map((s) => s.startMs)) - Math.min(...spans.map((s) => s.endMs)) > DAY) out.push(k);
  }
  return out;
}

// ---- filters and overlaps -----------------------------------------------------------------------

export interface EventFilter {
  startMs: number;
  endMs: number;
  types: EventType[];
  statuses: VerificationStatus[];
  /** ISO2 countries or ICAO FIR codes; empty = anywhere */
  places: string[];
  text: string;
}

/** Does the event's known period touch [startMs, endMs)? Events with no known time are kept apart. */
export function inPeriod(e: UnifiedEvent, startMs: number, endMs: number): boolean {
  const s = startSpan(e);
  if (!s) return false;
  const end = endMs_(e, s);
  return s.startMs < endMs && end > startMs;
}

function endMs_(e: UnifiedEvent, s: Span): number {
  return endMs(e) ?? (e.eventType === 'SECURITY_INCIDENT' || e.eventType === 'OTHER_VERIFIED_EVENT' || e.eventType === 'AIRSPACE_REOPENING' ? s.endMs : Infinity);
}

export function filterEvents(events: readonly UnifiedEvent[], f: EventFilter): UnifiedEvent[] {
  const q = f.text.trim().toLowerCase();
  return events.filter((e) =>
    f.types.includes(e.eventType) && f.statuses.includes(e.verificationStatus) && inPeriod(e, f.startMs, f.endMs) &&
    (!f.places.length || f.places.some((p) => e.coveredCountries.includes(p) || e.coveredFIRs.includes(p) || e.affectedAirports.includes(p))) &&
    (!q || `${e.title} ${e.titleJa ?? ''} ${e.description ?? ''} ${e.documentId ?? ''}`.toLowerCase().includes(q)));
}

/** Events in force or happening on any day of [startMs, endMs) (for a comparison window). */
export function eventsInWindow(events: readonly UnifiedEvent[], startMs: number, endMs: number): UnifiedEvent[] {
  return events.filter((e) => inPeriod(e, startMs, endMs));
}

/** Pairs of events whose periods overlap, and the shared span. */
export function overlaps(events: readonly UnifiedEvent[]): { a: string; b: string; startMs: number; endMs: number }[] {
  const out: { a: string; b: string; startMs: number; endMs: number }[] = [];
  const spans = events.map((e) => { const s = startSpan(e); return s ? { id: e.eventId, s: s.startMs, e: endMs_(e, s) } : null; }).filter((x): x is { id: string; s: number; e: number } => !!x);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const s = Math.max(spans[i]!.s, spans[j]!.s);
      const e = Math.min(spans[i]!.e, spans[j]!.e);
      if (s < e) out.push({ a: spans[i]!.id, b: spans[j]!.id, startMs: s, endMs: e });
    }
  }
  return out;
}

/** Rows within a layer so that overlapping bars never share a row. */
export function stackRows(items: readonly { id: string; startMs: number; endMs: number }[]): Map<string, number> {
  const rows: number[] = [];
  const out = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.startMs - b.startMs)) {
    let r = rows.findIndex((end) => end <= it.startMs);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = it.endMs;
    out.set(it.id, r);
  }
  return out;
}

// ---- loading ------------------------------------------------------------------------------------

let cache: Promise<{ registry: Registry; czib: ValidatedHistory; events: UnifiedEvent[] }> | null = null;

export function loadEvents(baseUrl: string) {
  cache ??= Promise.all([
    fetch(assetUrl(baseUrl, 'data/events/events.json')).then((r) => { if (!r.ok) throw new Error(`events.json: HTTP ${r.status}`); return r.json() as Promise<Registry>; }),
    loadAdvisoryHistory(baseUrl),
  ]).then(([registry, czib]) => ({ registry, czib, events: [...czibEvents(czib), ...registry.events.filter(validEvent)] }));
  cache.catch(() => { cache = null; });
  return cache;
}

/** Browser-side guard: an event without a checkable source, or claiming more than its sources, is not shown. */
export function validEvent(e: UnifiedEvent): boolean {
  if (!e.sourceReferences.length || e.sourceReferences.some((s) => !s.sha256 || !s.url)) return false;
  const types = new Set(e.sourceReferences.map((s) => s.sourceType));
  if (e.verificationStatus === 'Verified' && !types.has('authority') && !types.has('archive')) return false;
  if (e.verificationStatus === 'Partially Verified' && !types.has('authority') && !types.has('archive') && !types.has('state-news-agency')) return false;
  for (const f of [e.occurrence, e.publication, e.effectiveFrom, e.effectiveUntil]) {
    for (const t of f) if (t.utc && (t.precision === 'date' || t.precision === 'unknown' || t.precision === 'month')) return false;
  }
  return true;
}

export type EventsState = { state: 'loading' } | { state: 'ready'; registry: Registry; czib: ValidatedHistory; events: UnifiedEvent[] } | { state: 'error'; message: string };

export function useEvents(): EventsState {
  const [s, setS] = useState<EventsState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadEvents(import.meta.env.BASE_URL)
      .then((d) => live && setS({ state: 'ready', ...d }))
      .catch((e: unknown) => live && setS({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, []);
  return s;
}
