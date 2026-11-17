/**
 * Event study: conditions, the async computation and the saved result (Phase 9G).
 * Event records, study conditions and results are kept apart; a saved result names the event
 * version and the version of the event records it used, so a later update of the records never
 * silently replaces the event a result was computed for.
 */
import type { StaticNetwork } from '../data/model/network';
import type { ResearchConfig } from '../research/model';
import type { ScopeContext } from '../research/network';
import type { ImpactResult } from '../simulation/impact';
import type { ImpactClient } from '../simulation/impactClient';
import type { AggregateResponse, TemporalClient } from '../temporal/client';
import { countryIndices } from '../temporal/client';
import type { GroupSpec } from '../temporal/aggregate';
import type { TemporalIndex } from '../temporal/model';
import { beforeAfter, DAY, differenceInDifferences, placebo, preTrend, ratioPreTrend, utcDayMs, windowPair, type BeforeAfter, type DailySeries, type DidResult, type PlaceboResult, type Trend, type WindowPair } from './analysis';
import { observedChanges, type ChangeOptions, type Changes } from './changes';
import { impactPair, windowNetwork } from './counterfactual';
import { areaCountries, type AdvisoryVersion } from './model';

export const STUDY_FORMAT = '1090web-event-study';
export const METHOD_VERSION = '9g.1';

export interface StudyConditions {
  windowDays: number;
  bufferDays: number;
  tiers: ResearchConfig['tiers'];
  passengerOnly: boolean;
  /** flights in a window for a route to count as observed */
  minFlights: number;
  directed: boolean;
  /** ISO2 of the neighbour group (C) */
  neighbours: string[];
  /** ISO2 of the comparison group (should not be touched by the advisory) */
  comparison: string[];
  /** leave collection-gap days out of the daily statistics */
  excludeGaps: boolean;
  /** days of daily series around the event */
  spanDays: number;
}

export const DEFAULT_NEIGHBOURS = ['TR', 'EG', 'CY', 'SY', 'YE', 'PK', 'AF', 'AZ', 'AM', 'GE', 'TM', 'SD'];
export const DEFAULT_COMPARISON = ['TH', 'MY', 'SG', 'ID', 'VN', 'PH'];

export function defaultConditions(): StudyConditions {
  return { windowDays: 14, bufferDays: 1, tiers: 'D', passengerOnly: false, minFlights: 1, directed: true, neighbours: DEFAULT_NEIGHBOURS, comparison: DEFAULT_COMPARISON, excludeGaps: true, spanDays: 60 };
}

export type SeriesId = 'area' | 'areaT13' | 'within' | 'cross' | 'neighbours' | 'comparison' | 'world';

export interface SeriesSet {
  startMs: number;
  /** flights per UTC day */
  flights: Record<SeriesId, number[]>;
  /** distinct routes per UTC day */
  routes: Record<SeriesId, number[]>;
}

export interface StudyResult {
  version: AdvisoryVersion;
  conditions: StudyConditions;
  area: { countries: string[]; basis: 'field' | 'airspaceText' | 'none'; firs: string[] };
  windows: WindowPair;
  dataRange: { startMs: number; endMs: number };
  gapDays: number[];
  series: SeriesSet;
  beforeAfter: Record<SeriesId, BeforeAfter>;
  preTrend: Record<'area' | 'comparison' | 'neighbours', Trend | null>;
  ratioPreTrend: Trend | null;
  placebo: PlaceboResult;
  did: DidResult;
  changes: Changes;
  impact: { observed: ImpactResult; observedArea: ImpactResult; hypothetical: ImpactResult; targets: number[]; nodes: number } | null;
  warnings: string[];
  t4Share: { before: number; after: number };
}

function seriesOf(r: AggregateResponse, startMs: number): SeriesSet {
  const flights = { world: r.series.flights } as Record<SeriesId, number[]>;
  const routes = { world: r.series.routes } as Record<SeriesId, number[]>;
  for (const g of r.groupSeries ?? []) {
    flights[g.id as SeriesId] = g.flights;
    routes[g.id as SeriesId] = g.routes;
  }
  return { startMs, flights, routes };
}

export function gapDaysOf(index: TemporalIndex): number[] {
  return index.days.filter((d) => d.anomaly?.evidence === 'collection_gap').map((d) => utcDayMs(d.day));
}

export interface StudyDeps {
  network: StaticNetwork;
  index: TemporalIndex;
  range: { startMs: number; endMs: number };
  temporal: TemporalClient;
  impact: ImpactClient;
  scope: ScopeContext;
}

export async function runStudy(deps: StudyDeps, version: AdvisoryVersion, c: StudyConditions, progress: (step: string) => void): Promise<StudyResult> {
  const { network, range } = deps;
  const area = areaCountries(version);
  const countries = countryIndices(network);
  const idx = (iso: readonly string[]) => iso.map((x) => countries.get(x)).filter((x): x is number => x !== undefined);
  const areaIdx = idx(area.iso2);
  const eventDay = utcDayMs(version.effectiveDate!);
  const w = windowPair(eventDay, c.windowDays, range.startMs, range.endMs, c.bufferDays);
  const gapDays = gapDaysOf(deps.index);
  const gaps = new Set(c.excludeGaps ? gapDays : []);
  const t4 = c.tiers === 'D';
  const base = { carrier: null, passengerOnly: c.passengerOnly };
  const groups: GroupSpec[] = [
    { id: 'area', countries: areaIdx, mode: 'touch', includeT4: t4, ...base },
    { id: 'areaT13', countries: areaIdx, mode: 'touch', includeT4: false, ...base },
    { id: 'within', countries: areaIdx, mode: 'within', includeT4: t4, ...base },
    { id: 'cross', countries: areaIdx, mode: 'cross', includeT4: t4, ...base },
    // C and the comparison group never include a flight to or from the area (no contamination)
    { id: 'neighbours', countries: idx(c.neighbours.filter((x) => !area.iso2.includes(x))), mode: 'touch', excludeCountries: areaIdx, includeT4: t4, ...base },
    { id: 'comparison', countries: idx(c.comparison.filter((x) => !area.iso2.includes(x))), mode: 'touch', excludeCountries: [...areaIdx, ...idx(c.neighbours)], includeT4: t4, ...base },
  ];
  const sStart = Math.max(range.startMs, eventDay - c.spanDays * DAY);
  const sEnd = Math.min(range.endMs, eventDay + (c.spanDays + 1) * DAY);
  progress('series');
  const filter = { country: null, carrier: null, passengerOnly: c.passengerOnly, includeT4: t4, airport: null };
  const sr = await deps.temporal.aggregate('events-series', { window: { startMs: sStart, endMs: sEnd }, basis: 'all', binMs: DAY, filter, groups });
  const series = seriesOf(sr, sStart);
  progress('windows');
  const rb = await deps.temporal.aggregate('events-before', { window: { startMs: w.before.startMs, endMs: w.before.endMs }, basis: 'all', binMs: DAY, filter: null });
  const ra = await deps.temporal.aggregate('events-after', { window: { startMs: w.after.startMs, endMs: w.after.endMs }, basis: 'all', binMs: DAY, filter: null });
  const opts: ChangeOptions = { includeT4: t4, passengerOnly: c.passengerOnly, minFlights: c.minFlights, ratio: 1.5, minDelta: 0.5 };
  const changes = observedChanges(network, rb.rows, ra.rows, w.before.days, w.after.days, area.iso2, c.neighbours, opts);
  const ds = (id: SeriesId): DailySeries => ({ startMs: series.startMs, values: series.flights[id] });
  const ids: SeriesId[] = ['area', 'areaT13', 'within', 'cross', 'neighbours', 'comparison', 'world'];
  const ba = Object.fromEntries(ids.map((id) => [id, beforeAfter(ds(id), w, gaps)])) as Record<SeriesId, BeforeAfter>;
  const did = differenceInDifferences(ds('area'), ds('comparison'), w, sStart, sEnd, new Set(gapDays));
  // T4 share of the flights touching the area (inferred airports)
  const t4Of = (rows: AggregateResponse['rows']) => {
    let all = 0;
    let t4n = 0;
    const inArea = new Set(areaIdx);
    const ac = network.airports.map((a) => countries.get(a.country)!);
    for (let i = 0; i < rows.size; i++) {
      const r = network.routes[rows.route[i]!]!;
      if (!inArea.has(ac[r.a]!) && !inArea.has(ac[r.b]!)) continue;
      all += rows.count[i]!;
      if (rows.tier[i] === 4) t4n += rows.count[i]!;
    }
    return all ? t4n / all : 0;
  };
  const warnings: string[] = [];
  if (w.before.truncated || w.after.truncated) warnings.push('truncated');
  if (!w.sameWeekdays) warnings.push('weekdays');
  const gapIn = gapDays.some((g) => (g >= w.before.startMs && g < w.before.endMs) || (g >= w.after.startMs && g < w.after.endMs));
  if (gapIn) warnings.push(c.excludeGaps ? 'gapExcluded' : 'gapIncluded');
  if (area.basis === 'airspaceText') warnings.push('areaFromText');
  if (area.basis === 'none') warnings.push('noArea');
  if (version.verificationStatus === 'archived-capture') warnings.push('archived');
  if (version.contentVariants > 1) warnings.push('variants');
  const t4Share = { before: t4Of(rb.rows), after: t4Of(ra.rows) };
  if (t4Share.before > 0.5 || t4Share.after > 0.5) warnings.push('t4');
  let impact: StudyResult['impact'] = null;
  if (areaIdx.length) {
    progress('impact');
    const cond = { tiers: c.tiers, minFlights: c.minFlights, directed: c.directed };
    const nb = windowNetwork(deps.scope, rb.rows, w.before.days, 'before', cond);
    const na = windowNetwork(deps.scope, ra.rows, w.after.days, 'after', cond);
    const areaAirports = new Set(network.airports.map((a, i) => (area.iso2.includes(a.country) ? i : -1)).filter((i) => i >= 0));
    const pair = impactPair(nb, na, areaAirports, c.directed);
    const key = `${version.bulletinId}/${version.revisionId}/${JSON.stringify(c)}`;
    const observed = await deps.impact.run(`ev-obs:${key}`, pair.observed.input);
    const observedArea = await deps.impact.run(`ev-obsA:${key}`, pair.observedArea.input);
    const hypothetical = await deps.impact.run(`ev-hyp:${key}`, pair.hypothetical.input);
    impact = { observed, observedArea, hypothetical, targets: pair.targets, nodes: pair.observed.nodes.length };
  }
  return {
    version, conditions: c, area: { countries: area.iso2, basis: area.basis, firs: version.firs },
    windows: w, dataRange: range, gapDays, series, beforeAfter: ba,
    preTrend: { area: preTrend(ds('area'), w, gaps), comparison: preTrend(ds('comparison'), w, gaps), neighbours: preTrend(ds('neighbours'), w, gaps) },
    ratioPreTrend: ratioPreTrend(ds('area'), ds('comparison'), w, gaps),
    placebo: placebo(ds('area'), w, sStart, sEnd, 7, gaps),
    did, changes, impact, warnings, t4Share,
  };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Everything needed to read (and redo) a result: event version, records version, conditions, method. */
export function studyJson(r: StudyResult, recordsVersion: string, dataset: { id: string; version: string | null }): string {
  return JSON.stringify({
    format: STUDY_FORMAT, schemaVersion: 1, methodVersion: METHOD_VERSION,
    event: {
      bulletinId: r.version.bulletinId, revisionId: r.version.revisionId, czibNumber: r.version.czibNumber, title: r.version.title,
      effectiveDate: r.version.effectiveDate, issueDate: r.version.issueDate, revisionDate: r.version.revisionDate, validUntil: r.version.validUntil,
      sourceUrl: r.version.sourceUrl, verificationStatus: r.version.verificationStatus, firstSeenAt: r.version.firstSeenAt,
      captures: r.version.captures, recordsVersion, kind: 'safety-advisory (not a closure)',
    },
    dataset,
    conditions: r.conditions,
    area: { ...r.area, note: 'Airport countries of the advisory area. FIRs and flight levels are listed but not used to select flights: 1090web has no flight paths.' },
    windows: {
      eventDayUtc: iso(r.windows.eventDayMs), bufferDays: r.windows.bufferDays,
      before: { start: iso(r.windows.before.startMs), endExclusive: iso(r.windows.before.endMs), days: r.windows.before.days, truncated: r.windows.before.truncated, weekdays: r.windows.before.weekdays },
      after: { start: iso(r.windows.after.startMs), endExclusive: iso(r.windows.after.endMs), days: r.windows.after.days, truncated: r.windows.after.truncated, weekdays: r.windows.after.weekdays },
      sameWeekdays: r.windows.sameWeekdays,
    },
    method: {
      counting: 'flights whose reference time (track start, else track end) falls in the UTC day (Phase 9A)',
      beforeAfter: 'mean daily flights, gap days left out when conditions.excludeGaps',
      preTrend: 'OLS of log(flights + 1) on the day in the before window',
      placebo: 'the same comparison on earlier days, every 7 days, with no day after the event',
      did: 'log difference of the area minus the comparison group, reported only when every condition holds; not a causal effect',
      impact: 'Phase 9C impact computation; observed = before vs after network, hypothetical = before network without the area airports',
    },
    results: {
      beforeAfter: r.beforeAfter, preTrend: r.preTrend, ratioPreTrend: r.ratioPreTrend, placebo: r.placebo, did: r.did,
      classes: r.changes.classes, airportsObserved: r.changes.airportsObserved, t4Share: r.t4Share,
      impact: r.impact ? {
        observed: { total: r.impact.observed.total, spillover: r.impact.observed.spillover, edges: r.impact.observed.edges, lostPairs: r.impact.observed.lostPairs.total },
        observedAreaRoutesOnly: { total: r.impact.observedArea.total, spillover: r.impact.observedArea.spillover, edges: r.impact.observedArea.edges, lostPairs: r.impact.observedArea.lostPairs.total },
        hypothetical: { total: r.impact.hypothetical.total, spillover: r.impact.hypothetical.spillover, edges: r.impact.hypothetical.edges, lostPairs: r.impact.hypothetical.lostPairs.total },
        targets: r.impact.targets.length, nodes: r.impact.nodes,
      } : null,
    },
    warnings: r.warnings,
    note: 'Observed ADS-B flights, not schedules. A route observed only after is not a new service; a route no longer observed is not a discontinued one. Nothing here shows that the advisory caused a change.',
  }, null, 1);
}

export function seriesCsv(r: StudyResult): string {
  const ids: SeriesId[] = ['area', 'areaT13', 'within', 'cross', 'neighbours', 'comparison', 'world'];
  const gaps = new Set(r.gapDays);
  const lines = [['day_utc', ...ids.map((i) => `flights_${i}`), ...ids.map((i) => `routes_${i}`), 'collection_gap', 'window'].join(',')];
  const n = r.series.flights.area.length;
  for (let i = 0; i < n; i++) {
    const d = r.series.startMs + i * DAY;
    const win = d >= r.windows.before.startMs && d < r.windows.before.endMs ? 'before' : d >= r.windows.after.startMs && d < r.windows.after.endMs ? 'after' : d === r.windows.eventDayMs ? 'event' : '';
    lines.push([iso(d), ...ids.map((id) => r.series.flights[id][i] ?? ''), ...ids.map((id) => r.series.routes[id][i] ?? ''), gaps.has(d) ? 1 : 0, win].join(','));
  }
  return lines.join('\n');
}

export function routesCsv(r: StudyResult, network: StaticNetwork): string {
  const code = (i: number) => network.airports[i]!.iata || network.airports[i]!.id;
  const lines = ['route,a,b,area_class,flights_before,flights_after,per_day_before,per_day_after,observed_change'];
  for (const x of r.changes.routes) lines.push([x.route, code(x.a), code(x.b), x.cls, x.before, x.after, x.beforeDaily.toFixed(3), x.afterDaily.toFixed(3), x.change].join(','));
  return lines.join('\n');
}
