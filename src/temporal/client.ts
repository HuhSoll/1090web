/**
 * Main-thread side of the temporal worker: one worker per dataset, requests per channel (a newer
 * request on a channel supersedes the older one), and a small cache of finished aggregates keyed
 * by window, time basis, bin size and series filter.
 */
import type { StaticNetwork } from '../data/model/network';
import type { AggregateResult, RouteGeo, SeriesFilter } from './aggregate';
import type { TimeBasisFilter, TimeWindow } from './window';

export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

export interface AggregateRequest {
  window: TimeWindow;
  basis: TimeBasisFilter;
  binMs: number;
  filter: SeriesFilter | null;
}

export type AggregateResponse = AggregateResult & { elapsedMs: number; daysRead: number; fromCache: boolean };

type Pending = { id: number; resolve: (r: AggregateResponse) => void; reject: (e: Error) => void; onProgress?: (done: number, total: number) => void; key: string };

export function requestKey(r: AggregateRequest): string {
  return JSON.stringify([r.window.startMs, r.window.endMs, r.basis, r.binMs, r.filter]);
}

/** Country -> index, in order of first appearance among the airports. */
export function countryIndices(network: StaticNetwork): Map<string, number> {
  const countries = new Map<string, number>();
  for (const a of network.airports) if (!countries.has(a.country)) countries.set(a.country, countries.size);
  return countries;
}

export function routeGeo(network: StaticNetwork): RouteGeo {
  const countries = countryIndices(network);
  const airportCountry = Int32Array.from(network.airports, (a) => countries.get(a.country)!);
  return {
    a: Int32Array.from(network.routes, (r) => r.a),
    b: Int32Array.from(network.routes, (r) => r.b),
    airportCountry,
  };
}

/** Country index used by routeGeo (same iteration order). */
export function countryIndex(network: StaticNetwork, iso2: string | null): number | null {
  if (!iso2) return null;
  return countryIndices(network).get(iso2) ?? null;
}

export class TemporalClient {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly cache = new Map<string, AggregateResponse>();
  /** number of airline codes (the day files index into the dataset's carrier list) */
  private readonly carriers: number;

  constructor(baseUrl: string, datasetId: string, network: StaticNetwork, private readonly cacheSize = 8, maxDays = 14) {
    this.carriers = network.carriers.length;
    this.worker = new Worker(new URL('./temporal.worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'init', baseUrl, datasetId, geo: routeGeo(network), maxDays });
    this.worker.onmessage = (e: MessageEvent<{ type: string; id: number; done?: number; total?: number; result?: AggregateResult & { elapsedMs: number; daysRead: number }; message?: string }>) => {
      const m = e.data;
      const entry = [...this.pending.entries()].find(([, p]) => p.id === m.id);
      if (!entry) return;
      const [channel, p] = entry;
      if (m.type === 'progress') p.onProgress?.(m.done!, m.total!);
      else if (m.type === 'done') {
        this.pending.delete(channel);
        const r = { ...m.result!, fromCache: false };
        this.remember(p.key, r);
        p.resolve(r);
      } else if (m.type === 'error') {
        this.pending.delete(channel);
        p.reject(new Error(m.message));
      }
    };
  }

  private remember(key: string, r: AggregateResponse) {
    this.cache.set(key, r);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  /** Aggregates a window. A newer request on the same channel rejects this one with SupersededError. */
  aggregate(channel: string, req: AggregateRequest, onProgress?: (done: number, total: number) => void): Promise<AggregateResponse> {
    const key = requestKey(req);
    const old = this.pending.get(channel);
    if (old) {
      this.pending.delete(channel);
      old.reject(new SupersededError());
    }
    const hit = this.cache.get(key);
    if (hit) {
      this.worker.postMessage({ type: 'cancel', channel });
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve({ ...hit, fromCache: true });
    }
    const id = this.nextId++;
    return new Promise<AggregateResponse>((resolve, reject) => {
      this.pending.set(channel, { id, resolve, reject, onProgress, key });
      this.worker.postMessage({ type: 'aggregate', id, channel, ...req, carriers: this.carriers });
    });
  }

  cancel(channel: string): void {
    const p = this.pending.get(channel);
    if (p) {
      this.pending.delete(channel);
      p.reject(new SupersededError());
    }
    this.worker.postMessage({ type: 'cancel', channel });
  }

  prefetch(days: string[]): void {
    this.worker.postMessage({ type: 'prefetch', days });
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new SupersededError());
    this.pending.clear();
    this.cache.clear();
  }
}
