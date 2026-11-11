import { useEffect, useMemo, useState } from 'react';
import { getDatasetLoader } from '../app/useDataset';
import { resolveDatasetId } from '../app/config';
import type { StaticNetwork } from '../data/model/network';
import { useAppStore, type ResearchCompare } from '../state/store';
import { airportContinents, mergeMonth, ResearchLoader, type ResearchMeta, type ResearchMonth } from './data';
import { CancelledError, MetricsClient } from './metricsClient';
import { canonicalConfig, configHash, type ResearchConfig } from './model';
export { configContext } from './model';
import { areaNetwork, buildResearchNetwork, edgeArrays, routeRows, type ScopeContext } from './network';
import type { AnalysisResult } from './results';

// ---- shared loaders (one per dataset) --------------------------------------------------------------

let researchLoader: ResearchLoader | null = null;
function getResearchLoader(): ResearchLoader {
  if (!researchLoader) researchLoader = new ResearchLoader(import.meta.env.BASE_URL, resolveDatasetId());
  return researchLoader;
}

const monthCache = new Map<string, Promise<ResearchMonth>>();
function loadResearchMonth(network: StaticNetwork, month: string): Promise<ResearchMonth> {
  const hit = monthCache.get(month);
  if (hit) return hit;
  const loader = getDatasetLoader();
  if (!loader) return Promise.reject(new Error('dataset loader not ready'));
  const carriers = network.carriers.map((c) => c.id);
  const p = Promise.all([loader.loadMonth(month), getResearchLoader().loadTiers(month)]).then(([m, t]) => mergeMonth(m, t, carriers));
  p.catch(() => monthCache.delete(month));
  monthCache.set(month, p);
  // keep at most 4 merged months in memory
  while (monthCache.size > 4) monthCache.delete(monthCache.keys().next().value!);
  return p;
}

export type MetaState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; meta: ResearchMeta };

export function useResearchMeta(): MetaState {
  const [st, setSt] = useState<MetaState>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    getResearchLoader()
      .loadMeta()
      .then((meta) => alive && setSt({ state: 'ready', meta }))
      .catch((err: unknown) => alive && setSt({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      alive = false;
    };
  }, []);
  return st;
}

// ---- analysis --------------------------------------------------------------------------------------

export type AnalysisState =
  | { state: 'idle' }
  | { state: 'loading'; hash: string }
  | { state: 'computing'; hash: string; done: number; total: number }
  | { state: 'ready'; hash: string; result: AnalysisResult; stale: boolean }
  | { state: 'error'; hash: string; message: string };

/**
 * Runs the analysis for `config`. A newer config cancels the running computation; results of
 * an older config are never shown as the current one (they are kept, marked stale, only while
 * the new one is computing).
 */
export function useAnalysis(config: ResearchConfig | null, meta: ResearchMeta | null, client: MetricsClient): AnalysisState {
  const network = useAppStore((s) => s.network);
  const [state, setState] = useState<AnalysisState>({ state: 'idle' });
  const key = config ? canonicalConfig(config) : '';
  const hash = config ? configHash(config) : null;

  useEffect(() => {
    if (!config || !meta || !network) return;
    let alive = true;
    const hash = configHash(config);
    const months = network.manifest.months.map((m) => m.month);
    const i = months.indexOf(config.month);
    const previousMonth = i > 0 ? months[i - 1]! : null;
    const ctx: ScopeContext = {
      network,
      continentOf: airportContinents(network, meta.quality.continents),
      persistence: meta.persistence,
    };
    Promise.all([loadResearchMonth(network, config.month), previousMonth ? loadResearchMonth(network, previousMonth) : Promise.resolve(null)])
      .then(([month, prev]) => {
        if (!alive) return null;
        const net = buildResearchNetwork(ctx, month, config);
        const prevNet = prev ? buildResearchNetwork(ctx, prev, { ...config, month: prev.month }) : null;
        const edges = edgeArrays(net, config.directed);
        return client
          .run(key, edges, { pathMethod: config.pathMethod, samples: config.samples, seed: config.seed }, (done, total) => {
            if (alive) setState({ state: 'computing', hash, done, total });
          })
          .then((metrics) => {
            if (!alive) return null;
            const result: AnalysisResult = {
              config,
              hash,
              network: net,
              metrics,
              routes: routeRows(net, config.directed, prevNet),
              countries: areaNetwork(net, (a) => network.airports[a]!.country, 'country', config.directed),
              regions: areaNetwork(net, (a) => ctx.continentOf[a]!, 'region', config.directed),
              previousMonth,
              computedAt: new Date().toISOString(),
            };
            setState({ state: 'ready', hash, result, stale: false });
            return null;
          });
      })
      .catch((err: unknown) => {
        if (!alive || err instanceof CancelledError) return;
        setState({ state: 'error', hash, message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
    // `key` covers every field of config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, meta, network, client]);

  // Derived at render: a result for another config is never presented as the current one.
  if (!hash) return { state: 'idle' };
  if (state.state === 'idle' || ('hash' in state && state.hash !== hash)) {
    return state.state === 'ready' ? { ...state, stale: true } : { state: 'loading', hash };
  }
  return state;
}

/** The comparison config: the main config with exactly one field changed. */
export function compareConfig(base: ResearchConfig | null, cmp: ResearchCompare): ResearchConfig | null {
  if (!base || !cmp.enabled || cmp.value === null) return null;
  switch (cmp.field) {
    case 'month':
      return typeof cmp.value === 'string' && cmp.value !== base.month ? { ...base, month: cmp.value } : null;
    case 'minFlights':
      return typeof cmp.value === 'number' && cmp.value !== base.minFlights ? { ...base, minFlights: cmp.value } : null;
    case 'tiers':
      return cmp.value !== base.tiers && ['A', 'B', 'C', 'D'].includes(String(cmp.value)) ? { ...base, tiers: cmp.value as ResearchConfig['tiers'] } : null;
    case 'area': {
      const v = String(cmp.value);
      const next = v.startsWith('C:') ? { ...base, country: v.slice(2), region: null } : v.startsWith('R:') ? { ...base, country: null, region: v.slice(2) } : null;
      return next && (next.country !== base.country || next.region !== base.region) ? next : null;
    }
  }
}

export function useMetricsClients(): { main: MetricsClient; compare: MetricsClient } {
  const clients = useMemo(() => ({ main: new MetricsClient(), compare: new MetricsClient() }), []);
  useEffect(() => () => {
    clients.main.dispose();
    clients.compare.dispose();
  }, [clients]);
  return clients;
}
