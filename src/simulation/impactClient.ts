/**
 * Runs connectivity-impact jobs in a Web Worker. A new job terminates the running one (a busy
 * worker cannot be interrupted otherwise), results are cached by key (every condition that
 * changes the result is in the key), and progress is reported. Main thread only without Worker.
 */
import { CancelledError } from '../research/metricsClient';
import { computeImpact, type ImpactInput, type ImpactResult } from './impact';

type Pending = { id: number; resolve: (r: ImpactResult) => void; reject: (e: Error) => void; onProgress?: (done: number, total: number) => void };

export class ImpactClient {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private readonly cache = new Map<string, ImpactResult>();

  constructor(private readonly cacheSize = 6) {}

  cached(key: string): ImpactResult | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private remember(key: string, r: ImpactResult) {
    this.cache.set(key, r);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./impact.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; type: string; done?: number; total?: number; result?: ImpactResult; message?: string }>) => {
      const p = this.pending;
      if (!p || e.data.id !== p.id) return;
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

  cancel(): void {
    if (this.pending) {
      this.worker?.terminate();
      this.worker = null;
      const p = this.pending;
      this.pending = null;
      p.reject(new CancelledError());
    }
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  run(key: string, input: ImpactInput, onProgress?: (done: number, total: number) => void): Promise<ImpactResult> {
    const hit = this.cached(key);
    if (hit) return Promise.resolve(hit);
    this.cancel();
    if (typeof Worker === 'undefined') {
      const r = computeImpact(input, onProgress);
      this.remember(key, r);
      return Promise.resolve(r);
    }
    if (!this.worker) this.worker = this.spawn();
    const id = this.nextId++;
    return new Promise<ImpactResult>((resolve, reject) => {
      this.pending = { id, resolve: (r) => { this.remember(key, r); resolve(r); }, reject, onProgress };
      this.worker!.postMessage({ id, input });
    });
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.cache.clear();
  }
}
