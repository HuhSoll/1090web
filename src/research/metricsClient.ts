/**
 * Runs metric jobs in a Web Worker. Starting a new job terminates a running one (a busy worker
 * cannot be interrupted any other way), results are cached by key (small LRU), and callers get
 * progress callbacks. Falls back to the main thread only where Worker is unavailable (tests).
 */
import { computeMetrics, type MetricsOptions, type MetricsResult } from './analysis';
import type { EdgeInput } from './graph';

type Pending = {
  id: number;
  resolve: (r: MetricsResult) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
};

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export class MetricsClient {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private readonly cache = new Map<string, MetricsResult>();

  constructor(private readonly cacheSize = 8) {}

  cached(key: string): MetricsResult | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private remember(key: string, r: MetricsResult) {
    this.cache.set(key, r);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./metrics.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; type: string; done?: number; total?: number; result?: MetricsResult; message?: string }>) => {
      const p = this.pending;
      if (!p || e.data.id !== p.id) return; // a cancelled job
      if (e.data.type === 'progress') p.onProgress?.(e.data.done!, e.data.total!);
      else if (e.data.type === 'done') {
        this.pending = null;
        p.resolve(e.data.result!);
      } else {
        this.pending = null;
        p.reject(new Error(e.data.message ?? 'worker error'));
      }
    };
    w.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      this.worker = null;
      p?.reject(new Error(e.message || 'worker error'));
    };
    return w;
  }

  /** Cancels the running job (if any). */
  cancel(): void {
    if (this.pending) {
      this.worker?.terminate();
      this.worker = null;
      const p = this.pending;
      this.pending = null;
      p.reject(new CancelledError());
    }
  }

  run(key: string, input: EdgeInput, options: MetricsOptions, onProgress?: (done: number, total: number) => void): Promise<MetricsResult> {
    const hit = this.cached(key);
    if (hit) return Promise.resolve(hit);
    this.cancel();
    if (typeof Worker === 'undefined') {
      const r = computeMetrics(input, options, onProgress);
      this.remember(key, r);
      return Promise.resolve(r);
    }
    if (!this.worker) this.worker = this.spawn();
    const id = this.nextId++;
    return new Promise<MetricsResult>((resolve, reject) => {
      this.pending = {
        id,
        resolve: (r) => {
          this.remember(key, r);
          resolve(r);
        },
        reject,
        onProgress,
      };
      // copy the arrays: the caller keeps its own
      this.worker!.postMessage({ id, input: { ...input, src: input.src.slice(), dst: input.dst.slice(), weight: input.weight.slice() }, options });
    });
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.cache.clear();
  }
}
