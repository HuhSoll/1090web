/// <reference lib="webworker" />
import { evaluateCriticality, type CriticalityInput } from './criticality';

declare const self: DedicatedWorkerGlobalScope;

/** One run of an experiment: the impact of stopping each candidate on one graph. */
self.onmessage = (e: MessageEvent<{ id: number; input: CriticalityInput }>) => {
  const { id, input } = e.data;
  try {
    let last = 0;
    const r = evaluateCriticality(input, (done, total) => {
      const now = Date.now();
      if (now - last > 150 || done === total) {
        last = now;
        self.postMessage({ id, type: 'progress', done, total });
      }
    });
    self.postMessage({ id, type: 'done', result: r });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
