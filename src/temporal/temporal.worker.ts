/// <reference lib="webworker" />
/**
 * Loads day files and aggregates windows off the main thread. One queue, one shared day cache.
 * Each request belongs to a channel (e.g. 'explore', 'compare', 'research'); a newer request on
 * the same channel cancels the older one, which stops at the next day boundary.
 */
import { fromWire, type DisruptionWire } from '../simulation/disruption';
import { WindowAggregator, type RouteGeo, type SeriesFilter } from './aggregate';
import { TemporalLoader } from './loader';
import { daysForWindow } from './model';
import type { TimeBasisFilter, TimeWindow } from './window';

export type WorkerMessage =
  | { type: 'init'; baseUrl: string; datasetId: string; geo: RouteGeo; maxDays: number }
  | {
      type: 'aggregate'; id: number; channel: string; window: TimeWindow; basis: TimeBasisFilter; binMs: number; filter: SeriesFilter | null; carriers: number;
      disruption?: { wire: DisruptionWire; proxy: 'endpoint' | 'reference'; key: string } | null;
    }
  | { type: 'prefetch'; days: string[] }
  | { type: 'cancel'; channel: string };

declare const self: DedicatedWorkerGlobalScope;

let loader: TemporalLoader | null = null;
let geo: RouteGeo | null = null;
const latest = new Map<string, number>();
const queue: Extract<WorkerMessage, { type: 'aggregate' }>[] = [];
let running = false;

const current = (job: { id: number; channel: string }) => latest.get(job.channel) === job.id;

async function run(job: Extract<WorkerMessage, { type: 'aggregate' }>) {
  if (!loader) throw new Error('temporal worker not initialised');
  const t0 = performance.now();
  const idx = await loader.loadIndex();
  const available = new Set(idx.days.map((d) => d.day));
  const days = daysForWindow(job.window.startMs, job.window.endMs);
  const agg = new WindowAggregator(job.window, job.basis, job.carriers, job.binMs, geo, job.filter);
  const dis = job.disruption ? fromWire(job.disruption.wire) : null;
  if (dis) agg.setDisruption(dis, job.disruption!.proxy);
  // track ends are needed only for airport sides under the endpoint proxy
  const needEnds = dis !== null && job.disruption!.proxy === 'endpoint' && (dis.dep.size > 0 || dis.arr.size > 0);
  let done = 0;
  let bytesDays = 0;
  for (const d of days) {
    if (!current(job)) return; // superseded: stop between days
    if (available.has(d)) {
      const l = loader;
      const ev = needEnds ? await l.loadDayWithEndpoints(d).catch(() => l.loadDay(d)) : await l.loadDay(d);
      if (!current(job)) return;
      agg.addDay(ev);
      bytesDays++;
    }
    done++;
    self.postMessage({ type: 'progress', id: job.id, done, total: days.length });
  }
  const rows = agg.rows();
  const aff = dis ? agg.affectedRows() : null;
  const result = {
    affected: aff,
    disruption: agg.disruptionStats(),
    window: job.window, basis: job.basis, rows, trackStart: agg.trackStart, fallback: agg.fallback, flights: agg.flights,
    series: agg.series(), days, missingDays: days.filter((d) => !available.has(d)), elapsedMs: Math.round(performance.now() - t0),
    daysRead: bytesDays,
  };
  const buffers = (r: typeof rows) => [r.route.buffer, r.dir.buffer, r.carrier.buffer, r.tier.buffer, r.cls.buffer, r.count.buffer];
  self.postMessage({ type: 'done', id: job.id, result }, [...buffers(rows), ...(aff ? buffers(aff) : [])]);
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      if (!current(job)) continue;
      try {
        await run(job);
      } catch (err) {
        if (current(job)) self.postMessage({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    running = false;
  }
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const m = e.data;
  if (m.type === 'init') {
    loader = new TemporalLoader(m.baseUrl, m.datasetId, m.maxDays);
    geo = m.geo;
  } else if (m.type === 'aggregate') {
    latest.set(m.channel, m.id);
    queue.push(m);
    void pump();
  } else if (m.type === 'cancel') {
    latest.delete(m.channel);
  } else if (m.type === 'prefetch' && loader) {
    const l = loader;
    void l.loadIndex().then((idx) => {
      const have = new Set(idx.days.map((d) => d.day));
      for (const d of m.days) if (have.has(d)) l.loadDay(d).catch(() => undefined);
    });
  }
};
