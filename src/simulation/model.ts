/**
 * Simulation scenarios (Phase 9C): hypothetical disruptions applied to the OBSERVED network.
 *
 *   observed data -> baseline network -> scenario definition -> scenario application
 *     -> simulated network -> impact analysis -> visualisation / export
 *
 * A scenario is plain data, stored apart from the observed data, and never changes it. The same
 * scenario on the same dataset gives the same result. Results are structural statements about the
 * observed network; they are not forecasts of cancellations or airline operations.
 */
import type { AircraftClass, PathMethod, TierSet } from '../research/model';

// research/model.ts imports this module, so only types are imported from it (no value cycle)
const CLASSES: readonly AircraftClass[] = ['passenger', 'cargo', 'unknown'];

export const SIM_SCHEMA_VERSION = 1;
export const SIM_FORMAT = '1090web-simulation-scenario';

/** Event types that can be applied. */
export const IMPLEMENTED_EVENT_TYPES = ['AIRPORT_CLOSURE', 'MULTIPLE_AIRPORT_CLOSURE', 'ROUTE_SUSPENSION'] as const;
/**
 * Reserved for later phases: they are accepted in files but never applied (validation reports
 * them). A safety advisory is a warning, not a closure: it never removes an airport or a route.
 */
export const RESERVED_EVENT_TYPES = [
  'CAPACITY_REDUCTION', 'COUNTRY_DISRUPTION', 'AIRLINE_WITHDRAWAL', 'AIRSPACE_RESTRICTION', 'WEATHER_DISRUPTION', 'SAFETY_ADVISORY',
] as const;
export type ImplementedEventType = (typeof IMPLEMENTED_EVENT_TYPES)[number];
export type SimEventType = ImplementedEventType | (typeof RESERVED_EVENT_TYPES)[number];

/** Airport closures: which movements stop. Route suspensions: one direction or both. */
export type AirportSide = 'both' | 'departures' | 'arrivals';
export type RouteDirection = 'both' | 'directed';

export interface SimulationEvent {
  eventId: string;
  eventType: SimEventType;
  enabled: boolean;
  /** ISO 8601 UTC, minute precision ("2026-03-10T12:00Z"); null = from the start of the data */
  startTimeUtc: string | null;
  /** exclusive; null = open-ended */
  endTimeUtc: string | null;
  targetType: 'airport' | 'route';
  /** airport ids; routes as "AAAA>BBBB" (with direction 'both' the order does not matter) */
  targetIds: string[];
  direction: AirportSide | RouteDirection;
  /** reserved for later event types (e.g. a capacity factor); unused by the implemented ones */
  parameters: Record<string, number | string | boolean>;
  /** 'hypothetical' = made up for the analysis; 'reported' = based on a cited real event */
  sourceType: 'hypothetical' | 'reported';
  sourceReference: string | null;
}

export type BaselineMode = 'fixed' | 'dynamic';
export type SimulationModel = 'structural' | 'temporal';
/**
 * Which track time stands for a movement at an airport (temporal disruptions):
 *  endpoint  - departure side: track start; arrival side: track end (each may be unknown)
 *  reference - the Phase 9A reference time (track start, else track end) for both sides
 */
export type TimeProxy = 'endpoint' | 'reference';

export interface SimulationFilters {
  tiers: TierSet;
  classes: AircraftClass[];
  /** a route (airport pair, both directions) needs this many observed flights in the period */
  minFlights: number;
  basis: 'all' | 'start';
  timeProxy: TimeProxy;
}

export interface AnalysisSettings {
  directed: boolean;
  /** hop limits reported for short-hop reachability */
  maxHops: 3;
  /** connectivity: exact breadth-first search from every airport (no sampling) */
  reachability: 'bfs-exact';
  /** centrality in Research Mode */
  pathMethod: PathMethod;
  samples: number;
  seed: number;
}

export interface SimulationScenario {
  format: typeof SIM_FORMAT;
  scenarioId: string;
  schemaVersion: number;
  name: string;
  description: string;
  datasetId: string;
  datasetVersion: string | null;
  baselineMode: BaselineMode;
  simulationModel: SimulationModel;
  /** fixed baseline period [start, end), ISO UTC; with a dynamic baseline the Explore window is used */
  analysisStart: string;
  analysisEnd: string;
  /**
   * Structural model with a fixed baseline: events in effect at this instant are applied.
   * null = every enabled event that overlaps the period is applied.
   */
  evaluationTime: string | null;
  events: SimulationEvent[];
  filters: SimulationFilters;
  analysisSettings: AnalysisSettings;
  createdAt: string;
}

export const DEFAULT_FILTERS: SimulationFilters = { tiers: 'D', classes: [...CLASSES], minFlights: 1, basis: 'all', timeProxy: 'endpoint' };
export const DEFAULT_SETTINGS: AnalysisSettings = { directed: false, maxHops: 3, reachability: 'bfs-exact', pathMethod: 'auto', samples: 256, seed: 1 };

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-03-10T12:00Z" (minute precision; seconds are never shown as exact) */
export function isoMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** Parses an ISO UTC time; anything with another offset, or seconds other than :00, is rejected. */
export function parseIsoUtc(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(00)(?:\.0+)?)?Z$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return ms;
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function newScenario(datasetId: string, datasetVersion: string | null, startMs: number, endMs: number): SimulationScenario {
  return {
    format: SIM_FORMAT,
    scenarioId: newId('scn'),
    schemaVersion: SIM_SCHEMA_VERSION,
    name: '',
    description: '',
    datasetId,
    datasetVersion,
    baselineMode: 'fixed',
    simulationModel: 'structural',
    analysisStart: isoMinute(startMs),
    analysisEnd: isoMinute(endMs),
    evaluationTime: null,
    events: [],
    filters: { ...DEFAULT_FILTERS, classes: [...DEFAULT_FILTERS.classes] },
    analysisSettings: { ...DEFAULT_SETTINGS },
    createdAt: new Date().toISOString(),
  };
}

export function airportClosure(ids: string[], startMs: number | null = null, endMs: number | null = null, side: AirportSide = 'both'): SimulationEvent {
  return {
    eventId: newId('evt'),
    eventType: ids.length > 1 ? 'MULTIPLE_AIRPORT_CLOSURE' : 'AIRPORT_CLOSURE',
    enabled: true,
    startTimeUtc: startMs === null ? null : isoMinute(startMs),
    endTimeUtc: endMs === null ? null : isoMinute(endMs),
    targetType: 'airport',
    targetIds: [...ids],
    direction: side,
    parameters: {},
    sourceType: 'hypothetical',
    sourceReference: null,
  };
}

export function routeSuspension(a: string, b: string, direction: RouteDirection, startMs: number | null = null, endMs: number | null = null): SimulationEvent {
  return {
    eventId: newId('evt'),
    eventType: 'ROUTE_SUSPENSION',
    enabled: true,
    startTimeUtc: startMs === null ? null : isoMinute(startMs),
    endTimeUtc: endMs === null ? null : isoMinute(endMs),
    targetType: 'route',
    targetIds: [`${a}>${b}`],
    direction,
    parameters: {},
    sourceType: 'hypothetical',
    sourceReference: null,
  };
}

// ---- hashing --------------------------------------------------------------------------------------

/**
 * Everything that changes a result, in a fixed order. Event ids, names, descriptions and the
 * creation time are left out; events are sorted, so their order does not change the key.
 */
export function canonicalScenario(s: SimulationScenario, windowOverride?: { startMs: number; endMs: number }): string {
  const events = s.events
    .filter((e) => e.enabled)
    .map((e) => [e.eventType === 'MULTIPLE_AIRPORT_CLOSURE' ? 'AIRPORT_CLOSURE' : e.eventType, e.startTimeUtc, e.endTimeUtc, e.targetType,
      [...e.targetIds].sort(), e.direction, Object.entries(e.parameters).sort()])
    .map((x) => JSON.stringify(x))
    .sort();
  return JSON.stringify([
    s.datasetId, s.datasetVersion, s.baselineMode, s.simulationModel,
    // the period as UTC ms, so the hash is the same with or without an explicit window
    windowOverride ? [windowOverride.startMs, windowOverride.endMs] : [parseIsoUtc(s.analysisStart), parseIsoUtc(s.analysisEnd)],
    s.simulationModel === 'structural' && s.baselineMode === 'fixed' ? s.evaluationTime : null,
    events, s.filters.tiers, [...s.filters.classes].sort(), s.filters.minFlights, s.filters.basis,
    s.simulationModel === 'temporal' ? s.filters.timeProxy : null, s.analysisSettings.directed,
  ]);
}

export function hashString(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const scenarioHash = (s: SimulationScenario, w?: { startMs: number; endMs: number }) => hashString(canonicalScenario(s, w));

// ---- validation (files, URLs) -----------------------------------------------------------------------

export interface ScenarioContext {
  datasetId: string;
  datasetVersion: string | null;
  airportIds: ReadonlySet<string>;
  /** "A|B" with A < B for every route of the dataset */
  routeKeys: ReadonlySet<string>;
  dataStartMs: number;
  dataEndMs: number;
}

export type ScenarioIssue =
  | { code: 'not_a_scenario' | 'invalid_json' }
  | { code: 'newer_schema' | 'older_schema'; version: number }
  | { code: 'dataset_id_differs' | 'dataset_version_differs'; value: string | null }
  | { code: 'invalid_period' | 'period_outside_data' }
  | { code: 'invalid_event_period' | 'no_targets' | 'event_not_implemented' | 'advisory_not_applied'; eventId: string }
  | { code: 'unknown_airport' | 'unknown_route'; eventId: string; id: string }
  | { code: 'dropped_field'; field: string };

export const routeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function isImplemented(t: string): t is ImplementedEventType {
  return (IMPLEMENTED_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * Checks an event against the dataset. Returns the problems; an event with problems is still
 * kept in the scenario (so nothing the user wrote is lost) but problematic parts are not applied.
 */
export function eventIssues(e: SimulationEvent, ctx: ScenarioContext): ScenarioIssue[] {
  const out: ScenarioIssue[] = [];
  if (!isImplemented(e.eventType)) {
    out.push({ code: e.eventType === 'SAFETY_ADVISORY' ? 'advisory_not_applied' : 'event_not_implemented', eventId: e.eventId });
    return out;
  }
  const s = e.startTimeUtc === null ? -Infinity : parseIsoUtc(e.startTimeUtc);
  const t = e.endTimeUtc === null ? Infinity : parseIsoUtc(e.endTimeUtc);
  if (s === null || t === null || !(t > s)) out.push({ code: 'invalid_event_period', eventId: e.eventId });
  if (e.targetIds.length === 0) out.push({ code: 'no_targets', eventId: e.eventId });
  for (const id of e.targetIds) {
    if (e.targetType === 'airport') {
      if (!ctx.airportIds.has(id)) out.push({ code: 'unknown_airport', eventId: e.eventId, id });
    } else {
      const [a, b] = id.split('>');
      if (!a || !b || !ctx.airportIds.has(a) || !ctx.airportIds.has(b)) out.push({ code: 'unknown_airport', eventId: e.eventId, id });
      else if (!ctx.routeKeys.has(routeKey(a, b))) out.push({ code: 'unknown_route', eventId: e.eventId, id });
    }
  }
  return out;
}

const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' && parseIsoUtc(v) !== null ? isoMinute(parseIsoUtc(v)!) : '');

/** Reads a scenario from JSON: invalid parts are replaced or reported, never silently applied. */
export function parseScenario(text: string, ctx: ScenarioContext): { scenario: SimulationScenario | null; issues: ScenarioIssue[] } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { scenario: null, issues: [{ code: 'invalid_json' }] };
  }
  if (!raw || typeof raw !== 'object' || raw.format !== SIM_FORMAT || !Array.isArray(raw.events)) {
    return { scenario: null, issues: [{ code: 'not_a_scenario' }] };
  }
  return sanitizeScenario(raw, ctx);
}

export function sanitizeScenario(raw: Record<string, unknown>, ctx: ScenarioContext): { scenario: SimulationScenario; issues: ScenarioIssue[] } {
  const issues: ScenarioIssue[] = [];
  const version = Number(raw.schemaVersion);
  if (version > SIM_SCHEMA_VERSION) issues.push({ code: 'newer_schema', version });
  else if (!(version >= 1)) issues.push({ code: 'older_schema', version: Number.isFinite(version) ? version : 0 });
  if (raw.datasetId !== ctx.datasetId) issues.push({ code: 'dataset_id_differs', value: typeof raw.datasetId === 'string' ? raw.datasetId : null });
  else if ((raw.datasetVersion ?? null) !== ctx.datasetVersion) issues.push({ code: 'dataset_version_differs', value: typeof raw.datasetVersion === 'string' ? raw.datasetVersion : null });

  let start = parseIsoUtc(str(raw.analysisStart, ''));
  let end = parseIsoUtc(str(raw.analysisEnd, ''));
  if (start === null || end === null || !(end > start) || end - start > 400 * 86_400_000) {
    issues.push({ code: 'invalid_period' });
    start = ctx.dataStartMs;
    end = ctx.dataStartMs + 86_400_000;
  } else if (end <= ctx.dataStartMs || start >= ctx.dataEndMs) {
    issues.push({ code: 'period_outside_data' });
  }
  const s = newScenario(ctx.datasetId, ctx.datasetVersion, start, end);
  s.scenarioId = str(raw.scenarioId, s.scenarioId);
  s.name = str(raw.name, '').slice(0, 200);
  s.description = str(raw.description, '').slice(0, 2000);
  s.createdAt = str(raw.createdAt, s.createdAt);
  if (raw.baselineMode === 'fixed' || raw.baselineMode === 'dynamic') s.baselineMode = raw.baselineMode;
  else if (raw.baselineMode !== undefined) issues.push({ code: 'dropped_field', field: 'baselineMode' });
  if (raw.simulationModel === 'structural' || raw.simulationModel === 'temporal') s.simulationModel = raw.simulationModel;
  else if (raw.simulationModel !== undefined) issues.push({ code: 'dropped_field', field: 'simulationModel' });
  const ev = isoOrNull(raw.evaluationTime);
  if (ev === '') issues.push({ code: 'dropped_field', field: 'evaluationTime' });
  else s.evaluationTime = ev;

  const f = (raw.filters ?? {}) as Partial<SimulationFilters>;
  if (['A', 'B', 'C', 'D'].includes(String(f.tiers))) s.filters.tiers = f.tiers as TierSet;
  if (Array.isArray(f.classes) && f.classes.length > 0 && f.classes.every((c) => CLASSES.includes(c))) s.filters.classes = CLASSES.filter((c) => f.classes!.includes(c));
  if (Number.isInteger(f.minFlights) && f.minFlights! >= 1 && f.minFlights! <= 100000) s.filters.minFlights = f.minFlights!;
  if (f.basis === 'all' || f.basis === 'start') s.filters.basis = f.basis;
  if (f.timeProxy === 'endpoint' || f.timeProxy === 'reference') s.filters.timeProxy = f.timeProxy;
  const a = (raw.analysisSettings ?? {}) as Partial<AnalysisSettings>;
  if (typeof a.directed === 'boolean') s.analysisSettings.directed = a.directed;
  if (a.pathMethod === 'auto' || a.pathMethod === 'exact' || a.pathMethod === 'sampled') s.analysisSettings.pathMethod = a.pathMethod;
  if (Number.isInteger(a.samples) && a.samples! >= 8) s.analysisSettings.samples = a.samples!;
  if (Number.isInteger(a.seed) && a.seed! >= 0) s.analysisSettings.seed = a.seed!;

  for (const r of raw.events as unknown[]) {
    const e = r as Partial<SimulationEvent>;
    if (!e || typeof e !== 'object' || typeof e.eventType !== 'string') continue;
    const st = isoOrNull(e.startTimeUtc);
    const en = isoOrNull(e.endTimeUtc);
    const event: SimulationEvent = {
      eventId: str(e.eventId, newId('evt')),
      eventType: e.eventType as SimEventType,
      enabled: e.enabled !== false,
      startTimeUtc: st === '' ? 'invalid' : st,
      endTimeUtc: en === '' ? 'invalid' : en,
      targetType: e.targetType === 'route' ? 'route' : 'airport',
      targetIds: Array.isArray(e.targetIds) ? e.targetIds.filter((x): x is string => typeof x === 'string').map((x) => x.toUpperCase()).slice(0, 500) : [],
      direction: (['both', 'departures', 'arrivals', 'directed'] as const).includes(e.direction as never) ? e.direction! : 'both',
      parameters: e.parameters && typeof e.parameters === 'object' ? e.parameters : {},
      sourceType: e.sourceType === 'reported' ? 'reported' : 'hypothetical',
      sourceReference: typeof e.sourceReference === 'string' ? e.sourceReference.slice(0, 500) : null,
    };
    // a direction that does not fit the target type falls back to 'both'
    if (event.targetType === 'airport' && event.direction === 'directed') event.direction = 'both';
    if (event.targetType === 'route' && (event.direction === 'departures' || event.direction === 'arrivals')) event.direction = 'both';
    issues.push(...eventIssues(event, ctx));
    s.events.push(event);
  }
  return { scenario: s, issues };
}

export function scenarioJson(s: SimulationScenario): string {
  return `${JSON.stringify(s, null, 1)}\n`;
}

// ---- URL --------------------------------------------------------------------------------------------

/** Above this length the events are not put into the URL (use the JSON file instead). */
export const URL_EVENTS_MAX = 1500;

const TYPE_CODE: Record<ImplementedEventType, string> = { AIRPORT_CLOSURE: 'A', MULTIPLE_AIRPORT_CLOSURE: 'M', ROUTE_SUSPENSION: 'R' };
const DIR_CODE: Record<string, string> = { both: 'b', departures: 'd', arrivals: 'a', directed: 'o' };

/** sev=A~OMDB,OTHH~b~2026-03-10T12:00Z~2026-03-10T18:00Z~1;R~OMDB>EGLL~o~~~1 */
export function eventsToParam(events: readonly SimulationEvent[]): string | null {
  const parts = events.filter((e) => isImplemented(e.eventType)).map((e) =>
    [TYPE_CODE[e.eventType as ImplementedEventType], e.targetIds.join(','), DIR_CODE[e.direction] ?? 'b', e.startTimeUtc ?? '', e.endTimeUtc ?? '', e.enabled ? '1' : '0'].join('~'));
  const out = parts.join(';');
  return out.length > URL_EVENTS_MAX ? null : out;
}

export function eventsFromParam(p: string): SimulationEvent[] {
  const byCode = Object.fromEntries(Object.entries(TYPE_CODE).map(([k, v]) => [v, k])) as Record<string, ImplementedEventType>;
  const byDir = Object.fromEntries(Object.entries(DIR_CODE).map(([k, v]) => [v, k]));
  const out: SimulationEvent[] = [];
  for (const part of p.split(';')) {
    const [t, ids, d, s, e, en] = part.split('~');
    const type = byCode[t ?? ''];
    if (!type || !ids) continue;
    const st = s ? parseIsoUtc(s) : null;
    const end = e ? parseIsoUtc(e) : null;
    if ((s && st === null) || (e && end === null)) continue;
    const targets = ids.split(',').filter(Boolean).map((x) => x.toUpperCase());
    const ev: SimulationEvent = type === 'ROUTE_SUSPENSION'
      ? routeSuspension(...(targets[0]!.split('>') as [string, string]), byDir[d ?? 'b'] === 'directed' ? 'directed' : 'both', st, end)
      : airportClosure(targets, st, end, (byDir[d ?? 'b'] as AirportSide) ?? 'both');
    ev.eventType = type;
    ev.enabled = en !== '0';
    out.push(ev);
  }
  return out;
}
