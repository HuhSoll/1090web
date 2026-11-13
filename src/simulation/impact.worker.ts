/// <reference lib="webworker" />
import { computeImpact, impactTransferables, type ImpactInput } from './impact';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<{ id: number; input: ImpactInput }>) => {
  const { id, input } = e.data;
  try {
    let last = 0;
    const result = computeImpact(input, (done, total) => {
      const now = Date.now();
      if (now - last > 120 || done === total) {
        last = now;
        self.postMessage({ id, type: 'progress', done, total });
      }
    });
    self.postMessage({ id, type: 'done', result }, impactTransferables(result));
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
