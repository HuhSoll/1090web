/**
 * Research Mode data: the Explore month files (loaded through the existing DatasetLoader) plus
 * the small research-web files (tier split, persistence, quality). See pipeline/research_web.py.
 */
import type { MonthData, StaticNetwork } from '../data/model/network';
import { assetUrl, fetchJson } from '../data/loaders/fetchJson';
import type { TierSet } from './model';

export interface ResearchWebManifest {
  schemaVersion: number;
  datasetId: string;
  datasetVersion: string | null;
  months: string[];
  generatedAt: string;
  script: { name: string; version: string };
  files: Record<string, string>;
  inputs: Record<string, string>;
}

export interface PersistenceFile {
  months: string[];
  routeCount: number;
  minFlights: number;
  /** one digit per route id */
  tierSets: Record<TierSet, string>;
}

/** [routeId, direction, airline, tier (2|3), passenger, cargo, unknown] */
export type TierRecord = [number, 0 | 1, string, number, number, number, number];

export interface QualityMonth {
  month: string;
  calendarDays: number | null;
  observedDays: number;
  tiers: { T1: number; T2: number; T3: number; T4: number; X: number };
  gapDays: string[];
  anomalyDays: string[];
  normalisationWorld: {
    A_total: number | null;
    B_per_calendar_day: number | null;
    C2_per_good_day: number | null;
    good_days: number | null;
    excluded_days: string[];
  };
}

export interface QualityAnomaly {
  day: string;
  direction: 'low' | 'high';
  scope: string;
  evidence: string;
  world_ratio: number | null;
  gap_hours: number;
  gap_share_of_shortfall: number | null;
  low_regions: string[];
}

export interface ExternalRow {
  source: string;
  scope: string;
  months: string;
  reported: string;
  observed: string;
  tiers: string;
  direction: string;
  min_flights: number;
  share_reported_found: number | null;
  share_observed_confirmed: number | null;
  reported_routes_absent_in_observed: number | null;
  observed_routes_absent_in_reported: number | null;
  vol_n: number | null;
  vol_sum_observed: number | null;
  vol_sum_reported: number | null;
  vol_WAPE: number | null;
  vol_bias: number | null;
  vol_pearson: number | null;
  vol_spearman: number | null;
  vol_rel_error_median: number | null;
  vol_share_within_10pct: number | null;
}

export interface QualityFile {
  schemaVersion: number;
  dataset: {
    id: string;
    version: string | null;
    generatedAt: string;
    ruleset: string | null;
    commit: string | null;
    inputs: { file: string; sha256: string }[];
  };
  months: QualityMonth[];
  anomalies: QualityAnomaly[];
  gapRuns: { start: string; end: string; hours: number }[];
  regions: {
    scope_type: string;
    scope_id: string;
    month: string;
    flights_on_map: number;
    share_T1: number;
    share_T2: number;
    share_T3: number;
    share_T4: number;
    callsign_only_end_share: number;
  }[];
  continents: Record<string, string>;
  external: {
    available: boolean;
    rowFields?: string[];
    rows?: unknown[][];
    japan?: { month: string; tiers: string; observed_jp_domestic: number; reported_domestic_total: number; ratio: number }[];
    airportFields?: string[];
    airports?: [string, string, string, number, number][];
    btsMatchedAirlines?: string[];
    airportMinReported?: number;
    sources?: Record<string, { files: number; retrieved: string[]; urls: string[] }>;
  };
}

export interface ResearchMeta {
  manifest: ResearchWebManifest;
  quality: QualityFile;
  persistence: PersistenceFile;
  /** external rows as objects */
  externalRows: ExternalRow[];
}

export function externalRows(q: QualityFile): ExternalRow[] {
  const fields = q.external.rowFields ?? [];
  return (q.external.rows ?? []).map((values) => Object.fromEntries(fields.map((f, i) => [f, values[i] ?? null])) as unknown as ExternalRow);
}

export class ResearchLoader {
  private readonly root: string;
  private meta: Promise<ResearchMeta> | null = null;
  private readonly tierCache = new Map<string, Promise<TierRecord[]>>();

  constructor(baseUrl: string, datasetId: string) {
    this.root = assetUrl(baseUrl, `data/${datasetId}/research-web/`);
  }

  loadMeta(): Promise<ResearchMeta> {
    if (!this.meta) {
      this.meta = Promise.all([
        fetchJson<ResearchWebManifest>(`${this.root}manifest.json`),
        fetchJson<QualityFile>(`${this.root}quality.json`),
        fetchJson<PersistenceFile>(`${this.root}persistence.json`),
      ]).then(([manifest, quality, persistence]) => ({ manifest, quality, persistence, externalRows: externalRows(quality) }));
      this.meta.catch(() => {
        this.meta = null;
      });
    }
    return this.meta;
  }

  loadTiers(month: string): Promise<TierRecord[]> {
    const cached = this.tierCache.get(month);
    if (cached) return cached;
    const p = fetchJson<{ month: string; records: TierRecord[] }>(`${this.root}tiers/${month}.json`).then((f) => {
      if (f.month !== month) throw new Error(`tier file for ${month} contains ${f.month}`);
      return f.records;
    });
    p.catch(() => this.tierCache.delete(month));
    this.tierCache.set(month, p);
    return p;
  }
}

/** One month with every record split by tier (T1..T4) and class. Arrays are parallel. */
export interface ResearchMonth {
  month: string;
  observedDays: number;
  daysInMonth: number;
  size: number;
  route: Int32Array;
  dir: Uint8Array;
  /** index into carriers */
  carrier: Int32Array;
  carriers: string[];
  tier: Uint8Array;
  passenger: Float64Array;
  cargo: Float64Array;
  unknown: Float64Array;
  /** tier-file records that did not fit their Explore record (should be 0) */
  inconsistencies: number;
}

/**
 * Explore record [route, dir, airline, p, c, u, basis] + tier records -> per-tier rows.
 * basis 1 is T4; basis 0 is T1 + T2 + T3, with T2 and T3 given by the tier file, so
 * T1 = basis 0 minus T2 minus T3 (per class).
 */
export function mergeMonth(explore: MonthData, tierRecords: readonly TierRecord[], carriers: readonly string[]): ResearchMonth {
  const carrierIndex = new Map(carriers.map((c, i) => [c, i]));
  const table = [...carriers];
  const idx = (c: string) => {
    let i = carrierIndex.get(c);
    if (i === undefined) {
      i = table.length;
      table.push(c);
      carrierIndex.set(c, i);
    }
    return i;
  };
  const split = new Map<string, number[]>();
  for (const [rid, dir, al, tier, p, c, u] of tierRecords) {
    const k = `${rid}|${dir}|${al}`;
    const s = split.get(k) ?? [0, 0, 0, 0, 0, 0];
    const o = tier === 2 ? 0 : 3;
    s[o]! += p;
    s[o + 1]! += c;
    s[o + 2]! += u;
    split.set(k, s);
  }
  const rows: [number, number, number, number, number, number, number][] = [];
  let inconsistencies = 0;
  const used = new Set<string>();
  for (const r of explore.records) {
    const [rid, dir, al, p, c, u] = r;
    const basis = r[6] ?? 0;
    const ci = idx(al);
    if (basis === 1) {
      rows.push([rid, dir, ci, 4, p, c, u]);
      continue;
    }
    const k = `${rid}|${dir}|${al}`;
    const s = split.get(k);
    if (!s) {
      rows.push([rid, dir, ci, 1, p, c, u]);
      continue;
    }
    used.add(k);
    const t1 = [p - s[0]! - s[3]!, c - s[1]! - s[4]!, u - s[2]! - s[5]!];
    if (t1.some((x) => x < 0)) inconsistencies++;
    if (t1.some((x) => x > 0)) rows.push([rid, dir, ci, 1, Math.max(0, t1[0]!), Math.max(0, t1[1]!), Math.max(0, t1[2]!)]);
    if (s[0]! + s[1]! + s[2]! > 0) rows.push([rid, dir, ci, 2, s[0]!, s[1]!, s[2]!]);
    if (s[3]! + s[4]! + s[5]! > 0) rows.push([rid, dir, ci, 3, s[3]!, s[4]!, s[5]!]);
  }
  for (const k of split.keys()) if (!used.has(k)) inconsistencies++;
  const n = rows.length;
  const m: ResearchMonth = {
    month: explore.month,
    observedDays: explore.observedDays,
    daysInMonth: explore.daysInMonth ?? 30,
    size: n,
    route: new Int32Array(n),
    dir: new Uint8Array(n),
    carrier: new Int32Array(n),
    carriers: table,
    tier: new Uint8Array(n),
    passenger: new Float64Array(n),
    cargo: new Float64Array(n),
    unknown: new Float64Array(n),
    inconsistencies,
  };
  rows.forEach((r, i) => {
    m.route[i] = r[0];
    m.dir[i] = r[1];
    m.carrier[i] = r[2];
    m.tier[i] = r[3];
    m.passenger[i] = r[4];
    m.cargo[i] = r[5];
    m.unknown[i] = r[6];
  });
  return m;
}

/** Airport index -> continent code, from the quality file's country map. */
export function airportContinents(network: StaticNetwork, continents: Record<string, string>): string[] {
  return network.airports.map((a) => continents[a.country] ?? '');
}
