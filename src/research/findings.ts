/**
 * Research findings (Phase 9I): the claims of Phases 9A-9H with their evidence, scope and
 * validation status, loaded on demand from public/data/findings/findings.json.
 *
 * A status is about the stated data, conditions and scope. 'Validated' means that the statement
 * was checked (independent computation or a full re-check) for exactly that scope; it does not
 * make the statement true of the real world.
 */
import { useEffect, useState } from 'react';
import { assetUrl } from '../data/loaders/fetchJson';
import type { ResearchTab } from '../state/store';
import { useAppStore } from '../state/store';
import { openSimulation } from '../simulation/start';
import { defaultSelection } from '../temporal/window';

export const FINDINGS_FORMAT = '1090web-findings';
export type ValidationStatus = 'Validated' | 'Conditionally Supported' | 'Preliminary' | 'Needs Review' | 'Not Supported';
export const VALIDATION_STATUSES: ValidationStatus[] = ['Validated', 'Conditionally Supported', 'Preliminary', 'Needs Review', 'Not Supported'];

export interface Text { ja: string; en: string }

/** Where a finding was made: a Research tab (with what to open in it), or the temporal explorer. */
export type FindingLink =
  | { tab: 'events'; eventId: string }
  | { tab: 'islands'; airports: string[] }
  | { tab: 'experiments' | 'rankings' | 'overview' | 'reliability' }
  | { tab: 'temporal'; start: string; end: string };

export interface Finding {
  findingId: string;
  title: Text;
  researchQuestion: Text;
  statement: Text;
  dataset: { id: string; version: string };
  period: { start: string; end: string };
  method: Text;
  conditions: Record<string, string>;
  evidence: Text[];
  validationStatus: ValidationStatus;
  validation: Text;
  limitations: Text[];
  relatedExperiments: string[];
  sourceReferences: { label: string; path?: string; url?: string }[];
  calculationVersion: string;
  lastVerifiedAt: string;
  link: FindingLink;
  reproduce: { command: string };
}

export interface FindingsFile {
  format: string;
  schemaVersion: number;
  updatedAt: string;
  note: string;
  findings: Finding[];
}

const isText = (x: unknown): x is Text => !!x && typeof (x as Text).ja === 'string' && typeof (x as Text).en === 'string' && (x as Text).ja.length > 0 && (x as Text).en.length > 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reasons a finding cannot be shown (empty = valid). Incomplete findings are left out, not guessed. */
export function findingProblems(f: Finding): string[] {
  const p: string[] = [];
  if (!/^F-[0-9A-Z-]+$/.test(f.findingId ?? '')) p.push('findingId');
  for (const k of ['title', 'researchQuestion', 'statement', 'method', 'validation'] as const) if (!isText(f[k])) p.push(k);
  if (!f.dataset?.id || !f.dataset.version) p.push('dataset');
  if (!DATE.test(f.period?.start ?? '') || !DATE.test(f.period?.end ?? '') || f.period.start > f.period.end) p.push('period');
  if (!Array.isArray(f.evidence) || !f.evidence.length || !f.evidence.every(isText)) p.push('evidence');
  if (!VALIDATION_STATUSES.includes(f.validationStatus)) p.push('validationStatus');
  if (!Array.isArray(f.limitations) || !f.limitations.every(isText)) p.push('limitations');
  // anything short of fully validated must say what limits it
  if (f.validationStatus !== 'Validated' && f.validationStatus !== 'Not Supported' && !f.limitations?.length) p.push('limitations');
  if (!Array.isArray(f.sourceReferences) || !f.sourceReferences.length) p.push('sourceReferences');
  if (!f.calculationVersion) p.push('calculationVersion');
  if (!DATE.test(f.lastVerifiedAt ?? '')) p.push('lastVerifiedAt');
  if (!f.link?.tab) p.push('link');
  if (!f.reproduce?.command) p.push('reproduce');
  return p;
}

let cache: Promise<{ file: FindingsFile; findings: Finding[]; dropped: string[] }> | null = null;

export function loadFindings(baseUrl: string) {
  cache ??= fetch(assetUrl(baseUrl, 'data/findings/findings.json'))
    .then((r) => { if (!r.ok) throw new Error(`findings.json: HTTP ${r.status}`); return r.json() as Promise<FindingsFile>; })
    .then((file) => {
      if (file.format !== FINDINGS_FORMAT) throw new Error('findings.json: unknown format');
      const ok = file.findings.filter((f) => findingProblems(f).length === 0);
      return { file, findings: ok, dropped: file.findings.filter((f) => !ok.includes(f)).map((f) => f.findingId) };
    });
  cache.catch(() => { cache = null; });
  return cache;
}

export type FindingsState = { state: 'loading' } | { state: 'ready'; file: FindingsFile; findings: Finding[]; dropped: string[] } | { state: 'error'; message: string };

export function useFindings(): FindingsState {
  const [s, setS] = useState<FindingsState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadFindings(import.meta.env.BASE_URL).then(
      (r) => { if (live) setS({ state: 'ready', ...r }); },
      (e: unknown) => { if (live) setS({ state: 'error', message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  }, []);
  return s;
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Open the analysis a finding comes from. The map, period and conditions of other views are kept. */
export function openFinding(link: FindingLink, label: string): void {
  const st = useAppStore.getState();
  switch (link.tab) {
    case 'events':
      st.setEventFocus({ eventId: link.eventId });
      st.setResearchTab('events');
      st.setAppMode('research');
      return;
    case 'islands':
      st.setIslandHandoff({ scenarioName: label, airports: link.airports, from: 'finding' });
      st.setResearchTab('islands');
      st.setAppMode('research');
      return;
    case 'temporal': {
      const s = dayMs(link.start);
      const e = dayMs(link.end);
      const base = st.temporalSel ?? defaultSelection({ startMs: s, endMs: e });
      st.setExploreTime('temporal');
      st.setTemporalSel({ ...base, preset: 'custom', customStartMs: s, customEndMs: e, cursorMs: s, stepMs: 3_600_000, compare: 'off' });
      st.setAppMode('explore');
      return;
    }
    default:
      st.setResearchTab(link.tab as ResearchTab);
      st.setAppMode('research');
  }
}

export type Target = ResearchTab | 'simulation';

/** Go to a research view from Research Home. The simulation opens on the Explore map, which keeps its month and period. */
export function goTo(target: Target): void {
  const st = useAppStore.getState();
  if (target === 'simulation') {
    st.setAppMode('explore');
    if (!st.simOpen) openSimulation();
    return;
  }
  st.setResearchTab(target);
}
