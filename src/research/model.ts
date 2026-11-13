/**
 * Research Mode analysis conditions: types, defaults, validation, URL / JSON round-trips and
 * a stable hash. Everything that changes a result is part of ResearchConfig, so the same
 * config on the same dataset version reproduces the same numbers.
 */

export type TierSet = 'A' | 'B' | 'C' | 'D';
export type AircraftClass = 'passenger' | 'cargo' | 'unknown';
export type Relation = 'all' | 'domestic' | 'international';
export type PathMethod = 'auto' | 'exact' | 'sampled';

/** Tier numbers included in each set (1 = T1 ... 4 = T4). */
export const TIER_SETS: Record<TierSet, readonly number[]> = {
  A: [1],
  B: [1, 2],
  C: [1, 2, 3],
  D: [1, 2, 3, 4],
};
export const THRESHOLD_PRESETS = [1, 4, 10, 30] as const;
export const CLASSES: readonly AircraftClass[] = ['passenger', 'cargo', 'unknown'];
export const REGIONS = ['AF', 'AS', 'EU', 'NA', 'OC', 'SA'] as const;

/**
 * A UTC time window [startMs, endMs) analysed instead of the calendar month (Phase 9B), built
 * from the day files. `month` stays set (the month of the window start) for persistence and
 * labels. preset / stepMs record how the window was chosen in the temporal view.
 */
export interface ResearchWindow {
  startMs: number;
  endMs: number;
  /** 'start' = only flights whose reference time is the track start */
  basis: 'all' | 'start';
  preset: string;
  stepMs: number;
}

/**
 * A simulation scenario applied to the analysed network (Phase 9C). Only what changes the network
 * is kept here; the full scenario lives in src/simulation (JSON files carry both).
 */
export interface ResearchScenario {
  model: 'structural' | 'temporal';
  /** structural: events in effect at this instant (null = all enabled events) */
  evaluationTime: string | null;
  timeProxy: 'endpoint' | 'reference';
  events: SimulationEvent[];
  name: string;
}

export interface ResearchConfig {
  month: string;
  /** null = the observed network; otherwise the simulated network of this scenario */
  scenario: ResearchScenario | null;
  /** null = the calendar month (monthly files); otherwise a time window */
  window: ResearchWindow | null;
  /** ISO 3166-1 alpha-2, or null */
  country: string | null;
  /** continent code (AF, AS, EU, NA, OC, SA), or null; ignored when a country is set */
  region: string | null;
  /** ego network: only routes touching this airport id */
  airport: string | null;
  carrier: string | null;
  classes: AircraftClass[];
  /** a route (airport pair, both directions) needs at least this many flights in the month */
  minFlights: number;
  /** months of the data in which the route has >= 1 flight under the same tier set (0 = off) */
  minMonths: number;
  tiers: TierSet;
  directed: boolean;
  relation: Relation;
  pathMethod: PathMethod;
  /** sources for sampled betweenness / harmonic closeness */
  samples: number;
  seed: number;
}

export function defaultConfig(month: string): ResearchConfig {
  return {
    month,
    scenario: null,
    window: null,
    country: null,
    region: null,
    airport: null,
    carrier: null,
    classes: [...CLASSES],
    minFlights: 4,
    minMonths: 0,
    tiers: 'D',
    directed: false,
    relation: 'all',
    pathMethod: 'auto',
    samples: 256,
    seed: 1,
  };
}

/** Fields that change the network (everything except how path measures are computed). */
export const NETWORK_FIELDS = [
  'month', 'window', 'scenario', 'country', 'region', 'airport', 'carrier', 'classes', 'minFlights', 'minMonths', 'tiers', 'directed', 'relation',
] as const satisfies readonly (keyof ResearchConfig)[];

import type { StaticNetwork } from '../data/model/network';
import { eventsFromParam, eventsToParam, type SimulationEvent } from '../simulation/model';

export interface ConfigContext {
  months: readonly string[];
  airportIds: ReadonlySet<string>;
  carrierIds: ReadonlySet<string>;
  countries: ReadonlySet<string>;
}

/** Valid values of the loaded dataset (used to sanitise configs from URLs and files). */
export function configContext(network: StaticNetwork): ConfigContext {
  return {
    months: network.manifest.months.map((m) => m.month),
    airportIds: new Set(network.airports.map((a) => a.id)),
    carrierIds: new Set(network.carriers.map((c) => c.id)),
    countries: new Set(network.airports.map((a) => a.country)),
  };
}

/** Returns a valid config (unknown values replaced by defaults) and the list of what was dropped. */
export function sanitizeConfig(raw: Partial<ResearchConfig>, ctx: ConfigContext): { config: ResearchConfig; dropped: string[] } {
  const latest = ctx.months[ctx.months.length - 1] ?? '';
  const d = defaultConfig(latest);
  const dropped: string[] = [];
  const pick = <K extends keyof ResearchConfig>(key: K, ok: (v: unknown) => boolean): ResearchConfig[K] => {
    const v = raw[key];
    if (v === undefined) return d[key];
    if (ok(v)) return v as ResearchConfig[K];
    dropped.push(String(key));
    return d[key];
  };
  const intIn = (lo: number, hi: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const config: ResearchConfig = {
    month: pick('month', (v) => typeof v === 'string' && ctx.months.includes(v)),
    window: pick('window', (v) => v === null || isWindow(v)),
    scenario: pick('scenario', (v) => v === null || isScenario(v)),
    country: pick('country', (v) => v === null || (typeof v === 'string' && ctx.countries.has(v))),
    region: pick('region', (v) => v === null || (REGIONS as readonly unknown[]).includes(v)),
    airport: pick('airport', (v) => v === null || (typeof v === 'string' && ctx.airportIds.has(v))),
    carrier: pick('carrier', (v) => v === null || (typeof v === 'string' && ctx.carrierIds.has(v))),
    classes: pick('classes', (v) => Array.isArray(v) && v.length > 0 && v.every((c) => CLASSES.includes(c as AircraftClass))),
    minFlights: pick('minFlights', intIn(1, 100000)),
    minMonths: pick('minMonths', intIn(0, Math.max(0, ctx.months.length))),
    tiers: pick('tiers', (v) => v === 'A' || v === 'B' || v === 'C' || v === 'D'),
    directed: pick('directed', (v) => typeof v === 'boolean'),
    relation: pick('relation', (v) => v === 'all' || v === 'domestic' || v === 'international'),
    pathMethod: pick('pathMethod', (v) => v === 'auto' || v === 'exact' || v === 'sampled'),
    samples: pick('samples', intIn(8, 100000)),
    seed: pick('seed', intIn(0, 2 ** 31 - 1)),
  };
  config.classes = CLASSES.filter((c) => config.classes.includes(c));
  return { config, dropped };
}

function isScenario(v: unknown): v is ResearchScenario {
  const x = v as ResearchScenario;
  return typeof x === 'object' && x !== null && (x.model === 'structural' || x.model === 'temporal')
    && (x.timeProxy === 'endpoint' || x.timeProxy === 'reference') && Array.isArray(x.events) && x.events.length <= 500
    && x.events.every((e) => e && typeof e === 'object' && typeof e.eventType === 'string' && Array.isArray(e.targetIds))
    && (x.evaluationTime === null || typeof x.evaluationTime === 'string') && typeof x.name === 'string';
}

function isWindow(v: unknown): v is ResearchWindow {
  const w = v as ResearchWindow;
  return typeof w === 'object' && w !== null && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs
    && w.endMs - w.startMs <= 400 * 86_400_000 && (w.basis === 'all' || w.basis === 'start')
    && typeof w.preset === 'string' && Number.isFinite(w.stepMs);
}

/**
 * Stable JSON (fixed key order) used for hashing and caching. `window` is left out when null so
 * monthly configs keep the hashes they had before time windows existed (Phase 8 exports).
 */
export function canonicalConfig(c: ResearchConfig): string {
  const keys = (Object.keys(defaultConfig('')) as (keyof ResearchConfig)[])
    .filter((k) => (k !== 'window' || c.window !== null) && (k !== 'scenario' || c.scenario !== null)).sort();
  return JSON.stringify(keys.map((k) => [k, k === 'scenario' && c.scenario ? scenarioKey(c.scenario) : c[k]]));
}

/** Result-relevant part of a scenario: enabled events, sorted (ids and names left out). */
function scenarioKey(x: ResearchScenario) {
  return [x.model, x.model === 'structural' ? x.evaluationTime : null, x.model === 'temporal' ? x.timeProxy : null,
    x.events.filter((e) => e.enabled).map((e) => JSON.stringify([e.eventType === 'MULTIPLE_AIRPORT_CLOSURE' ? 'AIRPORT_CLOSURE' : e.eventType,
      e.startTimeUtc, e.endTimeUtc, e.targetType, [...e.targetIds].sort(), e.direction])).sort()];
}

/** FNV-1a 32-bit hash of the canonical config (identifier, not a security measure). */
export function configHash(c: ResearchConfig): string {
  const s = canonicalConfig(c);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Network-only key: configs that differ only in path settings share the network. */
export function networkKey(c: ResearchConfig): string {
  return JSON.stringify(NETWORK_FIELDS.map((k) => c[k]));
}

/** Fields whose values differ between two configs. */
export function changedFields(a: ResearchConfig, b: ResearchConfig): (keyof ResearchConfig)[] {
  return (Object.keys(a) as (keyof ResearchConfig)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// ---- URL ------------------------------------------------------------------------------------------

const URL_KEYS: Record<string, keyof ResearchConfig> = {
  rm: 'month', rc: 'country', rr: 'region', ra: 'airport', rl: 'carrier', rk: 'classes', rmin: 'minFlights',
  rp: 'minMonths', rt: 'tiers', rd: 'directed', rrel: 'relation', rb: 'pathMethod', rs: 'samples', rseed: 'seed',
};

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const parseIso = (s: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/.exec(s ?? '');
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : null;
};

export function configToParams(c: ResearchConfig, p: URLSearchParams): void {
  if (c.scenario) {
    const ev = eventsToParam(c.scenario.events);
    if (ev !== null) {
      p.set('rsm', c.scenario.model);
      p.set('rse', ev);
      if (c.scenario.evaluationTime) p.set('rst', c.scenario.evaluationTime);
      if (c.scenario.timeProxy !== 'endpoint') p.set('rsp', c.scenario.timeProxy);
    }
  }
  if (c.window) {
    p.set('rws', iso(c.window.startMs));
    p.set('rwe', iso(c.window.endMs));
    if (c.window.basis !== 'all') p.set('rwb', c.window.basis);
    p.set('rwp', c.window.preset);
    p.set('rwst', String(c.window.stepMs));
  }
  const d = defaultConfig(c.month);
  for (const [param, key] of Object.entries(URL_KEYS)) {
    const v = c[key];
    if (key !== 'month' && JSON.stringify(v) === JSON.stringify(d[key])) continue;
    if (v === null) continue;
    if (key === 'classes') p.set(param, (v as AircraftClass[]).map((x) => x[0]).join(''));
    else if (key === 'directed') p.set(param, v ? 'd' : 'u');
    else p.set(param, String(v));
  }
}

export function configFromParams(p: URLSearchParams): Partial<ResearchConfig> {
  const out: Partial<ResearchConfig> = {};
  const set = <K extends keyof ResearchConfig>(k: K, v: ResearchConfig[K]) => {
    out[k] = v;
  };
  const sm = p.get('rsm');
  const se = p.get('rse');
  if ((sm === 'structural' || sm === 'temporal') && se) {
    out.scenario = { model: sm, events: eventsFromParam(se), evaluationTime: p.get('rst'), timeProxy: p.get('rsp') === 'reference' ? 'reference' : 'endpoint', name: '' };
  }
  const ws = parseIso(p.get('rws'));
  const we = parseIso(p.get('rwe'));
  if (ws !== null && we !== null) {
    out.window = { startMs: ws, endMs: we, basis: p.get('rwb') === 'start' ? 'start' : 'all', preset: p.get('rwp') ?? 'custom', stepMs: Number(p.get('rwst') ?? 86_400_000) };
  }
  for (const [param, key] of Object.entries(URL_KEYS)) {
    const raw = p.get(param);
    if (raw === null) continue;
    if (key === 'classes') set('classes', CLASSES.filter((c) => raw.includes(c[0]!)));
    else if (key === 'directed') set('directed', raw === 'd');
    else if (['minFlights', 'minMonths', 'samples', 'seed'].includes(key)) set(key as 'minFlights', Number(raw));
    else if (key === 'month' || key === 'relation' || key === 'pathMethod') set(key as 'month', raw);
    else set(key as 'country', raw.toUpperCase()); // codes: country, region, airport, airline, tier set
  }
  return out;
}
