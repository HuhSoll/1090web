/**
 * Historical safety advisories (Phase 9G): the EASA CZIB history written by
 * pipeline/events/build_events.py. One record per bulletin revision that could be verified from
 * a captured EASA page; nothing is inferred.
 *
 * An advisory is a recommendation to operators. It is never an airspace closure or an airport
 * closure, and nothing in 1090web stops airports or routes because of it.
 */
import { useEffect, useState } from 'react';
import { assetUrl } from '../data/loaders/fetchJson';

export interface Capture {
  source: 'easa-live' | 'wayback';
  at: string;
  url: string;
  sha256: string;
}

export interface CountryRef {
  name: string;
  iso2: string | null;
}

export interface AdvisoryVersion {
  bulletinId: string;
  revisionId: string;
  czibNumber: string;
  title: string | null;
  status: string | null;
  issueDate: string | null;
  revisionDate: string | null;
  revisionDescription: string | null;
  validUntil: string | null;
  validUntilText: string | null;
  coveredCountries: CountryRef[];
  countriesNamedInAirspace: CountryRef[];
  coveredAirspace: string | null;
  firs: string[];
  recommendationType: string[];
  recommendationTextSummary: string | null;
  affectedOperatorScope: string | null;
  issuingAuthority: string;
  kind: 'safety-advisory';
  isClosure: false;
  effectiveDate: string | null;
  validFrom: string | null;
  validFromNote: string;
  publicationTimestamp: string | null;
  firstSeenAt: string;
  firstSeenSource: string;
  sourceUrl: string;
  captures: Capture[];
  contentVariants: number;
  verificationStatus: 'official-live' | 'official-live+archived' | 'archived-capture';
}

export interface Bulletin {
  bulletinId: string;
  nid: number | null;
  issuingAuthority: string;
  title: string | null;
  issueDate: string | null;
  latestKnownRevision: string;
  missingRevisions: string[];
  historyComplete: boolean;
  revisions: AdvisoryVersion[];
}

export interface AdvisoryHistory {
  schemaVersion: number;
  recordsVersion: string;
  generatedAt: string;
  source: { id: string; name: string; url: string; licence: string; archive: string };
  meaning: string;
  bulletins: Bulletin[];
  exports: { at: string; source: string; url: string; rows: { nid: number; title: string; status: string; issued: string | null; validUntil: string | null; updatedAt: string | null }[] }[];
  rejected: { file: string; reason: string }[];
}

export interface ValidatedHistory {
  history: AdvisoryHistory;
  /** versions dropped because their source cannot be checked */
  dropped: { id: string; reason: string }[];
}

/** Keeps only versions with a source URL, at least one capture with a checksum and a date. */
export function validateHistory(h: AdvisoryHistory): ValidatedHistory {
  const dropped: { id: string; reason: string }[] = [];
  const bulletins = h.bulletins.map((b) => ({
    ...b,
    revisions: b.revisions.filter((r) => {
      const id = `${r.bulletinId} ${r.revisionId}`;
      if (!r.sourceUrl) { dropped.push({ id, reason: 'no source URL' }); return false; }
      if (!r.captures?.length || r.captures.some((c) => !c.sha256 || !c.url)) { dropped.push({ id, reason: 'no verified capture' }); return false; }
      if (!r.effectiveDate) { dropped.push({ id, reason: 'no publication date' }); return false; }
      if (r.isClosure !== false || r.kind !== 'safety-advisory') { dropped.push({ id, reason: 'not an advisory record' }); return false; }
      return true;
    }),
  })).filter((b) => b.revisions.length);
  return { history: { ...h, bulletins }, dropped };
}

/** Countries of the advisory area used for airport-based analysis, and where they come from. */
export function areaCountries(v: AdvisoryVersion): { iso2: string[]; basis: 'field' | 'airspaceText' | 'none' } {
  const f = v.coveredCountries.map((c) => c.iso2).filter((x): x is string => !!x);
  if (f.length) return { iso2: f, basis: 'field' };
  const t = v.countriesNamedInAirspace.map((c) => c.iso2).filter((x): x is string => !!x);
  return t.length ? { iso2: t, basis: 'airspaceText' } : { iso2: [], basis: 'none' };
}

/** The version in force on a day (the latest version published on or before it), or null. */
export function versionOn(b: Bulletin, isoDay: string): AdvisoryVersion | null {
  let cur: AdvisoryVersion | null = null;
  for (const r of b.revisions) if (r.effectiveDate && r.effectiveDate <= isoDay) cur = r;
  if (!cur) return null;
  return cur.validUntil && cur.validUntil < isoDay ? null : cur;
}

export function versionKey(v: Pick<AdvisoryVersion, 'bulletinId' | 'revisionId'>): string {
  return `${v.bulletinId}/${v.revisionId}`;
}

let cache: Promise<ValidatedHistory> | null = null;

export function loadAdvisoryHistory(baseUrl: string): Promise<ValidatedHistory> {
  if (!cache) {
    cache = fetch(assetUrl(baseUrl, 'data/events/easa-czib-history.json'))
      .then((r) => {
        if (!r.ok) throw new Error(`easa-czib-history.json: HTTP ${r.status}`);
        return r.json() as Promise<AdvisoryHistory>;
      })
      .then(validateHistory);
    cache.catch(() => { cache = null; });
  }
  return cache;
}

export type HistoryState = { state: 'loading' } | { state: 'ready'; data: ValidatedHistory } | { state: 'error'; message: string };

export function useAdvisoryHistory(): HistoryState {
  const [s, setS] = useState<HistoryState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadAdvisoryHistory(import.meta.env.BASE_URL)
      .then((data) => live && setS({ state: 'ready', data }))
      .catch((e: unknown) => live && setS({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, []);
  return s;
}
