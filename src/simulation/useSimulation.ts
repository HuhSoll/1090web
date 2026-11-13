/**
 * Runs the open scenario: picks the baseline window (fixed: the scenario period; dynamic: the
 * window shown by the temporal explorer), aggregates it in the temporal worker (with the flight
 * records matched against the scenario in the temporal model), builds both networks, and runs the
 * connectivity analysis in its own worker. A newer scenario or window supersedes older work; a
 * result is only ever shown for the key it was computed for.
 */
import { useEffect, useMemo, useState } from 'react';
import { CancelledError } from '../research/metricsClient';
import { airportContinents, ResearchLoader, type ResearchMeta } from '../research/data';
import { resolveDatasetId } from '../app/config';
import { useAppStore } from '../state/store';
import { SupersededError } from '../temporal/client';
import { daysForWindow } from '../temporal/model';
import { getTemporalClient, loadTemporalMeta, windowDays, windowLabel, type TemporalMeta } from '../temporal/useTemporal';
import { clampWindow, DAY_MS, HOUR_MS } from '../temporal/window';
import { networkIndex, resolveDisruption, scenarioContext, toWire, type Disruption } from './disruption';
import { buildSimulation } from './engine';
import { ImpactClient } from './impactClient';
import { parseIsoUtc, scenarioHash, type SimulationScenario } from './model';

let researchMeta: Promise<ResearchMeta | null> | null = null;
/** Continents for the regional breakdown (Research Mode metadata); optional. */
function loadContinents(): Promise<ResearchMeta | null> {
  researchMeta ??= new ResearchLoader(import.meta.env.BASE_URL, resolveDatasetId()).loadMeta().catch(() => null);
  return researchMeta;
}

let impactClient: ImpactClient | null = null;
export function getImpactClient(): ImpactClient {
  impactClient ??= new ImpactClient();
  return impactClient;
}

export interface SimContext {
  meta: TemporalMeta | null;
  disruption: Disruption | null;
  window: { startMs: number; endMs: number } | null;
  /** why there is no window (dynamic baseline without the temporal view, period outside the data) */
  windowProblem: 'needsTemporal' | 'outside' | 'loading' | null;
  key: string | null;
}

/** The baseline window and the resolved disruption (cheap; recomputed on every change). */
export function useSimContext(scenario: SimulationScenario | null): SimContext {
  const network = useAppStore((s) => s.network);
  const exploreTime = useAppStore((s) => s.exploreTime);
  const temporalStatus = useAppStore((s) => s.temporalStatus);
  const [meta, setMeta] = useState<TemporalMeta | null>(null);
  useEffect(() => {
    let alive = true;
    loadTemporalMeta().then((m) => alive && setMeta(m)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const dynamicWindow = scenario?.baselineMode === 'dynamic' && exploreTime === 'temporal' && temporalStatus.state === 'ready' ? temporalStatus.result.window : null;
  const dynStart = dynamicWindow?.startMs ?? null;
  const dynEnd = dynamicWindow?.endMs ?? null;
  return useMemo(() => {
    if (!scenario || !network) return { meta, disruption: null, window: null, windowProblem: 'loading', key: null };
    if (!meta) return { meta, disruption: null, window: null, windowProblem: 'loading', key: null };
    const ctx = scenarioContext(network, meta.index.datasetVersion, meta.range.startMs, meta.range.endMs);
    const disruption = resolveDisruption(scenario.events, networkIndex(network), ctx);
    let window: { startMs: number; endMs: number } | null = null;
    let windowProblem: SimContext['windowProblem'] = null;
    if (scenario.baselineMode === 'dynamic') {
      if (dynStart === null || dynEnd === null) windowProblem = exploreTime === 'temporal' ? 'loading' : 'needsTemporal';
      else window = { startMs: dynStart, endMs: dynEnd };
    } else {
      const s = parseIsoUtc(scenario.analysisStart);
      const e = parseIsoUtc(scenario.analysisEnd);
      const c = s !== null && e !== null ? clampWindow({ startMs: s, endMs: e }, meta.range) : null;
      if (c) window = c.window;
      else windowProblem = 'outside';
    }
    return { meta, disruption, window, windowProblem, key: window ? scenarioHash(scenario, window) : null };
  }, [scenario, network, meta, dynStart, dynEnd, exploreTime]);
}

/** Runs the scenario and the connectivity analysis; results go to the store. */
export function useSimulation(scenario: SimulationScenario | null, ctx: SimContext): void {
  const network = useAppStore((s) => s.network);
  const playing = useAppStore((s) => s.temporalPlaying);
  const { key, window, disruption, meta } = ctx;

  useEffect(() => {
    const st = useAppStore.getState();
    if (!scenario || !network || !window || !disruption || !meta || !key) {
      if (ctx.windowProblem && ctx.windowProblem !== 'loading') st.setSimStatus({ state: 'error', message: ctx.windowProblem });
      return;
    }
    let alive = true;
    const client = getTemporalClient(network);
    const total = daysForWindow(window.startMs, window.endMs).length;
    const prev = st.simStatus.state === 'ready' ? st.simStatus.output : st.simStatus.state === 'loading' ? st.simStatus.previous : null;
    st.setSimStatus({ state: 'loading', done: 0, total, previous: prev });
    performance.mark('1090web:sim-request');
    const temporal = scenario.simulationModel === 'temporal';
    const binMs = window.endMs - window.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
    const req = {
      window, basis: scenario.filters.basis, binMs, filter: null,
      disruption: temporal ? { wire: toWire(disruption), proxy: scenario.filters.timeProxy, key } : null,
    };
    Promise.all([
      client.aggregate('sim', req, (done, n) => alive && useAppStore.getState().setSimStatus({ state: 'loading', done, total: n, previous: prev })),
      loadContinents(),
    ])
      .then(([r, rmeta]) => {
        if (!alive) return;
        const continentOf = rmeta ? airportContinents(network, rmeta.quality.continents) : network.airports.map(() => '?');
        const output = buildSimulation({
          network, scope: { network, continentOf, persistence: null }, scenario, disruption, window,
          label: windowLabel(window), days: windowDays(window), rows: r.rows, affected: r.affected ?? null, temporal: r.disruption ?? null, key,
        });
        performance.mark('1090web:sim-ready', { detail: { key, workerMs: r.elapsedMs, fromCache: r.fromCache, nodes: output.impactInput.n, model: scenario.simulationModel } });
        useAppStore.setState({ simStatus: { state: 'ready', output } });
      })
      .catch((err: unknown) => {
        if (!alive || err instanceof SupersededError) return;
        useAppStore.getState().setSimStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
    // the key covers the scenario and the window
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, network, meta, ctx.windowProblem]);

  // the connectivity analysis: on request, or automatically when not playing back
  const status = useAppStore((s) => s.simStatus);
  const auto = useAppStore((s) => s.simAutoImpact);
  useEffect(() => {
    if (status.state !== 'ready' || !auto || playing) return;
    runImpact();
  }, [status, auto, playing]);

  useEffect(() => () => {
    impactClient?.cancel();
    if (network) getTemporalClient(network).cancel('sim');
  }, [network]);
}

/** Starts (or reuses from the cache) the connectivity analysis of the current result. */
export function runImpact(): void {
  const st = useAppStore.getState();
  if (st.simStatus.state !== 'ready') return;
  const out = st.simStatus.output;
  const key = `${out.key}:impact`;
  if (st.simImpact.state !== 'idle' && st.simImpact.key === key && st.simImpact.state !== 'error') return;
  const client = getImpactClient();
  st.setSimImpact({ state: 'running', key, done: 0, total: out.impactInput.n });
  client
    .run(key, out.impactInput, (done, total) => {
      const cur = useAppStore.getState().simImpact;
      if (cur.state === 'running' && cur.key === key) useAppStore.getState().setSimImpact({ state: 'running', key, done, total });
    })
    .then((result) => {
      const cur = useAppStore.getState();
      performance.mark('1090web:impact-ready', { detail: { key, elapsedMs: result.elapsedMs, n: result.n, edges: result.edges.before } });
      if (cur.simStatus.state === 'ready' && `${cur.simStatus.output.key}:impact` === key) cur.setSimImpact({ state: 'ready', key, result });
    })
    .catch((err: unknown) => {
      if (err instanceof CancelledError) return;
      useAppStore.getState().setSimImpact({ state: 'error', key, message: err instanceof Error ? err.message : String(err) });
    });
}

export function cancelImpact(): void {
  impactClient?.cancel();
  useAppStore.getState().setSimImpact({ state: 'idle' });
}
