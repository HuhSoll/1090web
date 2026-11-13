import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/research/analysis';
import { mergeMonth } from '../src/research/data';
import {
  canonicalConfig,
  changedFields,
  configFromParams,
  configHash,
  configToParams,
  defaultConfig,
  sanitizeConfig,
  type ResearchConfig,
} from '../src/research/model';
import { areaNetwork, buildResearchNetwork, edgeArrays, routeRows } from '../src/research/network';
import { airportsCsv, analysisDocument, importDocument, type AnalysisResult } from '../src/research/results';
import { compareConfig, configContext } from '../src/research/useResearch';
import { findValidation } from '../src/research/validation';
import { externalRows } from '../src/research/data';
import { periodOf, periodSlug, isShortWindow } from '../src/research/periods';
import { eventOverlaps, removesCapacity, type ScenarioEvent } from '../src/temporal/scenario';
import { gapMask, windowQuality, GAP_HOUR_MAX_FLIGHTS } from '../src/temporal/quality';
import type { DayIndexEntry, TemporalIndex } from '../src/temporal/model';
import { selectionFromParams, selectionToParams } from '../src/temporal/urlParams';
import { DAY_MS, defaultSelection, defaultStep, HOUR_MS, stepSelection, type TemporalSelection } from '../src/temporal/window';
import { useAppStore } from '../src/state/store';
import { april, aprilTiers, continentOf, meta, network, persistence, quality } from './research/fixtures';

const T = (s: string) => Date.parse(s);
const range = { startMs: T('2026-05-04T00:00Z'), endMs: T('2026-05-09T00:00Z') };

function day(d: string, hourly: number[], gap = false): DayIndexEntry {
  return {
    day: d, flights: hourly.reduce((a, b) => a + b, 0), file: `days/${d}.json`, hourly, regions: {},
    anomaly: gap ? { direction: 'low', scope: 'global', evidence: 'collection_gap', worldRatio: 0, gapHours: 24, gapShareOfShortfall: 1 } : null,
  };
}
const full = Array<number>(24).fill(3000);
// May 4 normal, May 5-6 gap, May 7 gap until 18:00, May 8 normal (the real pattern)
const index: TemporalIndex = {
  schemaVersion: 1, datasetId: 'x', datasetVersion: '1',
  days: [
    day('2026-05-04', full),
    day('2026-05-05', [5, ...Array<number>(23).fill(0)], true),
    day('2026-05-06', Array<number>(24).fill(0), true),
    day('2026-05-07', [...Array<number>(18).fill(0), 6712, 4852, 4080, 3586, 3357, 3467], true),
    day('2026-05-08', full),
  ],
};

describe('window quality states (A-E)', () => {
  it('A: data present, nothing observed', () => {
    const quiet: TemporalIndex = { ...index, days: [day('2026-05-04', [0, ...full.slice(1)])] };
    const q = windowQuality(quiet, { startMs: T('2026-05-04T00:00Z'), endMs: T('2026-05-04T01:00Z') }, { flights: 0 });
    expect(q.flags).toEqual(['zeroObserved']);
  });
  it('B: collection gap is flagged, with the hours inside the window only', () => {
    const q = windowQuality(index, { startMs: T('2026-05-05T00:00Z'), endMs: T('2026-05-08T00:00Z') }, { flights: 26059 });
    expect(q.flags).toEqual(['gap']);
    expect(q.gapHours).toBe(24 + 24 + 18);
    expect(q.gapDays).toEqual(['2026-05-05', '2026-05-06', '2026-05-07']);
    // the part of May 7 after collection resumed is not a gap
    expect(windowQuality(index, { startMs: T('2026-05-07T20:00Z'), endMs: T('2026-05-07T21:00Z') }, { flights: 4080 }).flags).toEqual([]);
    // an empty gap day is a gap, not "zero observed"
    expect(windowQuality(index, { startMs: T('2026-05-06T00:00Z'), endMs: T('2026-05-07T00:00Z') }, { flights: 0 }).flags).toEqual(['gap']);
  });
  it('C: a day without a file', () => {
    const q = windowQuality(index, { startMs: T('2026-05-08T12:00Z'), endMs: T('2026-05-09T12:00Z') }, { flights: 10 });
    expect(q.flags).toContain('missingFile');
    expect(q.missingDays).toEqual(['2026-05-09']);
    expect(windowQuality(index, { startMs: T('2026-05-04T00:00Z'), endMs: T('2026-05-05T00:00Z') }, { flights: 1, missingDays: ['2026-05-04'] }).flags).toEqual(['missingFile']);
  });
  it('D: load failure', () => {
    expect(windowQuality(index, { startMs: T('2026-05-04T00:00Z'), endMs: T('2026-05-04T06:00Z') }, { flights: null, failed: true }).flags).toEqual(['loadFailed']);
  });
  it('E: zero after filters is not zero observed', () => {
    const q = windowQuality(index, { startMs: T('2026-05-04T00:00Z'), endMs: T('2026-05-04T02:00Z') }, { flights: 0 });
    expect(q.flags).toEqual(['zeroFiltered']);
    expect(q.worldFlights).toBe(6000);
  });
  it('gap mask per series bin', () => {
    expect(gapMask(index, T('2026-05-07T16:00Z'), HOUR_MS, 4)).toEqual([true, true, false, false]);
    expect(gapMask(index, T('2026-05-04T00:00Z'), DAY_MS, 5)).toEqual([false, true, true, true, false]);
    expect(GAP_HOUR_MAX_FLIGHTS).toBeGreaterThan(5);
  });
});

describe('step selection', () => {
  const base: TemporalSelection = { ...defaultSelection(range) };
  it('fixed presets move the cursor; custom windows shift as a whole', () => {
    expect(stepSelection({ ...base, cursorMs: T('2026-05-05T00:00Z') }, 1, range)).toEqual({ cursorMs: T('2026-05-06T00:00Z') });
    const custom = { ...base, preset: 'custom' as const, customStartMs: T('2026-05-05T18:00Z'), customEndMs: T('2026-05-06T06:00Z'), stepMs: 6 * HOUR_MS };
    expect(stepSelection(custom, 1, range)).toEqual({ customStartMs: T('2026-05-06T00:00Z'), customEndMs: T('2026-05-06T12:00Z') });
    expect(stepSelection(custom, -1, range)).toEqual({ customStartMs: T('2026-05-05T12:00Z'), customEndMs: T('2026-05-06T00:00Z') });
  });
  it('stops at the end of the data unless looping', () => {
    const last = { ...base, preset: 'custom' as const, customStartMs: T('2026-05-08T00:00Z'), customEndMs: T('2026-05-09T00:00Z') };
    expect(stepSelection(last, 1, range)).toBeNull();
    expect(stepSelection({ ...last, loop: true }, 1, range)).toEqual({ customStartMs: range.startMs, customEndMs: range.startMs + DAY_MS });
  });
  it('default steps per preset', () => {
    expect(defaultStep('rolling1h')).toBe(HOUR_MS);
    expect(defaultStep('rolling6h')).toBe(HOUR_MS);
    expect(defaultStep('day')).toBe(DAY_MS);
    expect(defaultStep('rolling7d')).toBe(DAY_MS);
  });
});

describe('temporal URL parameters', () => {
  it('round-trips a selection', () => {
    const s: TemporalSelection = {
      ...defaultSelection(range), preset: 'custom', cursorMs: T('2026-05-05T12:00Z'),
      customStartMs: T('2026-03-10T18:00Z'), customEndMs: T('2026-03-11T06:00Z'),
      stepMs: 6 * HOUR_MS, basis: 'start', compare: 'week', speed: 'fast', loop: true,
    };
    const p = new URLSearchParams();
    selectionToParams(s, p);
    expect(p.get('tcs')).toBe('2026-03-10T18:00Z');
    expect({ ...defaultSelection(range), ...selectionFromParams(p) }).toEqual(s);
  });
  it('ignores invalid values and non-UTC offsets', () => {
    const p = new URLSearchParams('tc=2026-03-10T12:00%2B09:00&tw=nope&ts=5m&tcmp=year');
    expect(selectionFromParams(p)).toEqual({});
    // a custom window needs a valid start < end
    expect(selectionFromParams(new URLSearchParams('tw=custom&tcs=2026-03-11T00:00Z&tce=2026-03-10T00:00Z')).preset).toBeUndefined();
  });
});

describe('Research Mode time windows', () => {
  const ctx = configContext(network);
  const win = { startMs: T('2026-04-10T12:00Z'), endMs: T('2026-04-10T18:00Z'), basis: 'all' as const, preset: 'custom', stepMs: HOUR_MS };

  it('monthly configs keep their Phase 8 hashes', () => {
    expect(canonicalConfig(defaultConfig('2026-04'))).not.toContain('window');
    expect(configHash(defaultConfig('2026-04'))).toBe('799814b3');
    expect(configHash({ ...defaultConfig('2026-03'), country: 'US', minFlights: 10 })).toBe('a1153fec');
  });
  it('a window changes the hash and round-trips through the URL and sanitising', () => {
    const c: ResearchConfig = { ...defaultConfig('2026-04'), window: win, minFlights: 1 };
    expect(configHash(c)).not.toBe(configHash({ ...c, window: null }));
    expect(configHash(c)).not.toBe(configHash({ ...c, window: { ...win, basis: 'start' } }));
    const p = new URLSearchParams();
    configToParams(c, p);
    expect(p.get('rws')).toBe('2026-04-10T12:00Z');
    expect(sanitizeConfig(configFromParams(p), ctx).config).toEqual(c);
  });
  it('rejects broken windows', () => {
    const bad = sanitizeConfig({ window: { ...win, endMs: win.startMs } }, ctx);
    expect(bad.dropped).toEqual(['window']);
    expect(bad.config.window).toBeNull();
    expect(sanitizeConfig({ window: { ...win, endMs: win.startMs + 500 * DAY_MS } }, ctx).dropped).toEqual(['window']);
  });
  it('comparison windows have the same length', () => {
    const c: ResearchConfig = { ...defaultConfig('2026-04'), window: win };
    const prev = compareConfig(c, { enabled: true, field: 'window', value: 'previous' })!;
    expect(prev.window).toMatchObject({ startMs: T('2026-04-10T06:00Z'), endMs: T('2026-04-10T12:00Z') });
    expect(compareConfig(c, { enabled: true, field: 'window', value: 'week' })!.window!.startMs).toBe(win.startMs - 7 * DAY_MS);
    expect(changedFields(c, prev)).toEqual(['window']);
    expect(compareConfig(defaultConfig('2026-04'), { enabled: true, field: 'window', value: 'previous' })).toBeNull();
  });
  it('period labels and file names', () => {
    const c: ResearchConfig = { ...defaultConfig('2026-04'), window: win };
    expect(periodOf(c)).toBe('2026-04-10 12:00 – 2026-04-10 18:00 UTC');
    expect(periodSlug(c)).toBe('2026-04-10T1200Z_2026-04-10T1800Z');
    expect(periodOf(defaultConfig('2026-04'))).toBe('2026-04');
    expect(isShortWindow(c)).toBe(true);
  });
  it('a window is never matched with a monthly external comparison', () => {
    const c: ResearchConfig = { ...defaultConfig('2026-04'), country: 'US', window: win };
    const m = findValidation(c, externalRows(quality), quality);
    expect(m?.row).toBeNull();
    expect(m?.differences).toContain('window');
  });

  function analyse(patch: Partial<ResearchConfig>): AnalysisResult {
    const config = { ...defaultConfig('2026-04'), minFlights: 1, ...patch };
    const month = mergeMonth(april, aprilTiers, network.carriers.map((c) => c.id));
    const net = buildResearchNetwork({ network, continentOf, persistence }, month, config);
    const metrics = computeMetrics(edgeArrays(net, config.directed), { pathMethod: config.pathMethod, samples: config.samples, seed: config.seed });
    return {
      config, hash: configHash(config), network: net, metrics, routes: routeRows(net, config.directed, null),
      countries: areaNetwork(net, (a) => network.airports[a]!.country, 'country', config.directed),
      regions: areaNetwork(net, (a) => continentOf[a]!, 'region', config.directed),
      previousMonth: null, computedAt: '2026-11-13T00:00:00Z',
    };
  }

  it('exports record the window; monthly exports are unchanged', () => {
    const r = analyse({ window: win });
    const m = meta();
    const doc = analysisDocument(r, m);
    expect(doc.temporal).toMatchObject({ startTimeUtc: '2026-04-10T12:00:00.000Z', endTimeUtc: '2026-04-10T18:00:00.000Z', timeBasisFilter: 'all', stepDuration: 'PT1H' });
    expect(doc.temporal).toMatchObject({ datasetId: m.manifest.datasetId, confidenceTiers: ['T1', 'T2', 'T3', 'T4'], minimumFlightCount: 1, directionMode: 'undirected', selectedAirports: [] });
    expect(doc.temporal!.analysisMetrics).toContain('betweenness');
    expect(airportsCsv(r, network, m).split('\n')[0]).toContain('window_start_utc,window_end_utc,time_basis_filter');
    const monthly = analyse({});
    expect(analysisDocument(monthly, m).temporal).toBeUndefined();
    expect(airportsCsv(monthly, network, m).split('\n')[0]).not.toContain('window_start_utc');
    // JSON restore brings the window back with the same hash
    const back = importDocument(JSON.stringify(doc), m, configContext(network));
    expect(back.warnings).toEqual([]);
    expect(back.config).toEqual(r.config);
  });
});

describe('scenario events (types only, nothing shipped)', () => {
  const e: ScenarioEvent = {
    eventId: 'x', eventType: 'airspace_advisory', startTime: '2026-05-01T00:00:00Z', endTime: '2026-05-02T00:00:00Z',
    affectedAirports: [], affectedRoutes: [], source: 'test', sourceUrl: null, isHypothetical: true,
  };
  it('overlap uses half-open windows', () => {
    expect(eventOverlaps(e, T('2026-05-01T23:00Z'), T('2026-05-02T01:00Z'))).toBe(true);
    expect(eventOverlaps(e, T('2026-05-02T00:00Z'), T('2026-05-02T01:00Z'))).toBe(false);
    expect(eventOverlaps({ ...e, endTime: null }, T('2027-01-01T00:00Z'), T('2027-01-02T00:00Z'))).toBe(true);
  });
  it('an advisory is not a closure', () => {
    expect(removesCapacity(e)).toBe(false);
    expect(removesCapacity({ ...e, eventType: 'airspace_closure' })).toBe(true);
  });
});

describe('Explore time mode in the store', () => {
  it('switching resets playback, comparison and the shown month', () => {
    const st = useAppStore.getState();
    st.setTemporalPlaying(true);
    st.setExploreTime('temporal');
    let s = useAppStore.getState();
    expect([s.exploreTime, s.temporalPlaying, s.compareEnabled, s.month, s.temporalStatus.state]).toEqual(['temporal', false, false, null, 'idle']);
    s.setTemporalPlaying(true);
    s.setExploreTime('monthly');
    s = useAppStore.getState();
    expect([s.exploreTime, s.temporalPlaying]).toEqual(['monthly', false]);
  });
});
