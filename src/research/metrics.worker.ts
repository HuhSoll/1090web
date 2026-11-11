/// <reference lib="webworker" />
import { computeMetrics, transferables, type MetricsOptions } from './analysis';
import type { EdgeInput } from './graph';

export interface WorkerRequest {
  id: number;
  input: EdgeInput;
  options: MetricsOptions;
}

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, input, options } = e.data;
  try {
    let last = 0;
    const result = computeMetrics(input, options, (done, total) => {
      const now = Date.now();
      if (now - last > 120 || done === total) {
        last = now;
        self.postMessage({ id, type: 'progress', done, total });
      }
    });
    self.postMessage({ id, type: 'done', result }, transferables(result));
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
