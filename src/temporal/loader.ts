/**
 * Loads the time-resolved data lazily: the small index first, then only the UTC day files a
 * window needs. Decoded days are kept in a small LRU cache to bound memory.
 */
import { assetUrl, fetchJson } from '../data/loaders/fetchJson';
import { attachEndpoints, daysForWindow, decodeDay, selectWindow, type DayEvents, type DayFile, type EndpointFile, type TemporalIndex, type WindowSelection } from './model';

export interface TemporalManifest {
  schemaVersion: number;
  datasetId: string;
  datasetVersion: string | null;
  generatedAt: string;
  days: { from: string; to: string; count: number };
  format: Record<string, string>;
  timeDefinitions: Record<string, unknown>;
  files: Record<string, { bytes: number; gzip: number; sha256: string }>;
  totalBytes: number;
  totalGzipBytes: number;
  license: string;
  privacy: string;
}

export class TemporalLoader {
  private readonly root: string;
  private index: Promise<TemporalIndex> | null = null;
  private manifest: Promise<TemporalManifest> | null = null;
  private readonly cache = new Map<string, Promise<DayEvents>>();
  private readonly epCache = new Map<string, Promise<DayEvents>>();

  /** maxDays: decoded days kept in memory (a day is about 2-3 MB decoded) */
  constructor(baseUrl: string, datasetId: string, private readonly maxDays = 10) {
    this.root = assetUrl(baseUrl, `data/${datasetId}/temporal/`);
  }

  loadManifest(): Promise<TemporalManifest> {
    this.manifest ??= fetchJson<TemporalManifest>(`${this.root}manifest.json`);
    return this.manifest;
  }

  loadIndex(): Promise<TemporalIndex> {
    this.index ??= fetchJson<TemporalIndex>(`${this.root}index.json`);
    return this.index;
  }

  loadDay(day: string): Promise<DayEvents> {
    const hit = this.cache.get(day);
    if (hit) {
      this.cache.delete(day);
      this.cache.set(day, hit);
      return hit;
    }
    const p = this.loadIndex().then((idx) => {
      const entry = idx.days.find((d) => d.day === day);
      if (!entry) throw new Error(`no temporal data for ${day}`);
      return fetchJson<DayFile>(`${this.root}${entry.file}`).then(decodeDay);
    });
    p.catch(() => this.cache.delete(day));
    this.cache.set(day, p);
    while (this.cache.size > this.maxDays) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /**
   * The day with track ends attached (Phase 9C). Kept in its own small cache; the plain day stays
   * in the day cache. Fails when the endpoint file is missing (callers fall back to reference time).
   */
  loadDayWithEndpoints(day: string): Promise<DayEvents> {
    const hit = this.epCache.get(day);
    if (hit) {
      this.epCache.delete(day);
      this.epCache.set(day, hit);
      return hit;
    }
    const p = Promise.all([this.loadDay(day), fetchJson<EndpointFile>(`${this.root}endpoints/${day}.json`)]).then(([ev, f]) => attachEndpoints(ev, f));
    p.catch(() => this.epCache.delete(day));
    this.epCache.set(day, p);
    while (this.epCache.size > Math.max(2, Math.floor(this.maxDays / 2))) this.epCache.delete(this.epCache.keys().next().value!);
    return p;
  }

  /** Loads the days a window needs (only those in the data) and selects [start, end). */
  async window(startMs: number, endMs: number): Promise<WindowSelection> {
    const idx = await this.loadIndex();
    const available = new Set(idx.days.map((d) => d.day));
    const need = daysForWindow(startMs, endMs);
    if (need.length > this.maxDays) throw new Error(`window spans ${need.length} days; at most ${this.maxDays} are loaded at once`);
    const loaded = await Promise.all(need.filter((d) => available.has(d)).map((d) => this.loadDay(d)));
    return selectWindow(new Map(loaded.map((e) => [e.day, e])), startMs, endMs);
  }
}
