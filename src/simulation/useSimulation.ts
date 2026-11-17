/**
 * Runs the open scenario at the simulation time (the temporal explorer's cursor: one clock for
 * the whole app). The baseline window is the scenario period (fixed) or the explorer's window
 * (dynamic). The window is aggregated in the temporal worker (records matched against the
 * scenario in the temporal model), both networks are built, and the connectivity analysis runs
 * in its own worker.
 *
 * Results are keyed by what changes them: in the structural model the set of events in effect at
 * the simulation time (not the time itself), so moving the cursor between two event boundaries
 * reuses one result. A result is only ever shown for the key it was computed for.
 */
import { useEffect, useMemo, useState } from 'react';
import { CancelledError } from '../research/metricsClient';
import { airportContinents, ResearchLoader, type ResearchMeta } from '../research/data';
import { resolveDatasetId } from '../app/config';
import type { StaticNetwork } from '../data/model/network';
import { useAppStore } from '../state/store';
import { SupersededError } from '../temporal/client';
import { daysForWindow } from '../temporal/model';
import { getTemporalClient, loadTemporalMeta, windowDays, windowLabel, type TemporalMeta } from '../temporal/useTemporal';
import { clampWindow, DAY_MS, HOUR_MS, windowFor, type TemporalSelection } from '../temporal/window';
import { activeSignature, boundaries, networkIndex, resolveDisruption, scenarioContext, toWire, type Disruption } from './disruption';
import { buildSimulation, type SimulationOutput } from './engine';
import type { DirectImpact } from './engine';
import { ImpactClient } from './impactClient';
import { baseHash, canonicalScenario, hashString, parseIsoUtc, type SimulationScenario } from './model';
import { activeEventIds, seriesTimes, stepOf, structuralSeries, timelineRange, type SeriesPoint } from './series';

let researchMeta: Promise<ResearchMeta | null> | null = null;
/** Continents for the regional breakdown (Research Mode metadata); optional. */
function loadContinents(): Promise<ResearchMeta | null> {
  researchMeta ??= new ResearchLoader(import.meta.env.BASE_URL, resolveDatasetId()).loadMeta().catch(() => null);
  return researchMeta;
}

let impactClient: ImpactClient | null = null;
export function getImpactClient(): ImpactClient {
  impactClient ??= new ImpactClient(12);
  return impactClient;
}

/** Finished outputs by key (small LRU): same key = same result (see the module doc). */
const outputs = new Map<string, SimulationOutput>();
function remember(o: SimulationOutput) {
  outputs.delete(o.key);
  outputs.set(o.key, o);
  while (outputs.size > 16) outputs.delete(outputs.keys().next().value!);
}
/** Connectivity summaries by output key, for the time series. */
const impactSummaries = new Map<string, { unreachable: number; efficiency: number }>();
/** Structural direct impact by base key and active set (series memo). */
const seriesMemo = new Map<string, Map<string, DirectImpact>>();

export interface SimContext {
  meta: TemporalMeta | null;
  disruption: Disruption | null;
  window: { startMs: number; endMs: number } | null;
  /** why there is no window (period outside the data, data not loaded yet) */
  windowProblem: 'outside' | 'loading' | null;
  /** result key (scenario without time + window + active set in the structural model) */
  key: string | null;
  baseKey: string | null;
  /** simulation time (UTC ms) */
  atMs: number | null;
  /** shown timeline range */
  range: { startMs: number; endMs: number } | null;
}

/** The dynamic baseline window for a selection (same rule as the temporal explorer). */
export function dynamicWindow(sel: TemporalSelection, data: { startMs: number; endMs: number }) {
  return clampWindow(windowFor(sel), data)?.window ?? null;
}

/** Baseline window, disruption and keys (cheap; recomputed on every change). */
export function useSimContext(scenario: SimulationScenario | null): SimContext {
  const network = useAppStore((s) => s.network);
  const sel = useAppStore((s) => s.temporalSel);
  const [meta, setMeta] = useState<TemporalMeta | null>(null);
  useEffect(() => {
    let alive = true;
    loadTemporalMeta().then((m) => alive && setMeta(m)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return useMemo(() => {
    const none = { meta, disruption: null, window: null, windowProblem: 'loading' as const, key: null, baseKey: null, atMs: null, range: null };
    if (!scenario || !network || !meta) return none;
    const ctx = scenarioContext(network, meta.index.datasetVersion, meta.range.startMs, meta.range.endMs);
    const disruption = resolveDisruption(scenario.events, networkIndex(network), ctx);
    const atMs = sel?.cursorMs ?? parseIsoUtc(scenario.evaluationTime) ?? parseIsoUtc(scenario.analysisStart);
    let window: { startMs: number; endMs: number } | null = null;
    let windowProblem: SimContext['windowProblem'] = null;
    if (scenario.baselineMode === 'dynamic') {
      window = sel ? dynamicWindow(sel, meta.range) : null;
      if (!window) windowProblem = sel ? 'outside' : 'loading';
    } else {
      const s = parseIsoUtc(scenario.analysisStart);
      const e = parseIsoUtc(scenario.analysisEnd);
      const c = s !== null && e !== null ? clampWindow({ startMs: s, endMs: e }, meta.range) : null;
      if (c) window = c.window;
      else windowProblem = 'outside';
    }
    const range = timelineRange(scenario, scenario.events, meta.range);
    if (!window || atMs === null) return { meta, disruption, window, windowProblem, key: null, baseKey: null, atMs, range };
    const baseKey = baseHash(scenario, window);
    const key = scenario.simulationModel === 'structural' ? `${baseKey}:${activeSignature(disruption, atMs)}` : baseKey;
    return { meta, disruption, window, windowProblem, key, baseKey, atMs, range };
  }, [scenario, network, meta, sel]);
}

/** Runs the scenario, the connectivity analysis and the series; results go to the store. */
export function useSimulation(scenario: SimulationScenario | null, ctx: SimContext): void {
  const network = useAppStore((s) => s.network);
  const playing = useAppStore((s) => s.temporalPlaying);
  const { key, window, disruption, meta, atMs } = ctx;

  // 1. the result for the current key (reused when the key is unchanged)
  useEffect(() => {
    const st = useAppStore.getState();
    if (!scenario || !network || !window || !disruption || !meta || !key) {
      if (ctx.windowProblem === 'outside') st.setSimStatus({ state: 'error', message: 'outside' });
      return;
    }
    const hit = outputs.get(key);
    if (hit) {
      st.setSimStatus({ state: 'ready', output: hit, atMs });
      return;
    }
    let alive = true;
    const total = daysForWindow(window.startMs, window.endMs).length;
    const prev = st.simStatus.state === 'ready' ? st.simStatus.output : st.simStatus.state === 'loading' ? st.simStatus.previous : null;
    st.setSimStatus({ state: 'loading', done: 0, total, previous: prev });
    performance.mark('1090web:sim-request');
    computeOutput(network, scenario, disruption, window, atMs, key, (done, n) => alive && useAppStore.getState().setSimStatus({ state: 'loading', done, total: n, previous: prev }))
      .then((output) => {
        if (!alive) return;
        remember(output);
        performance.mark('1090web:sim-ready', { detail: { key, nodes: output.impactInput.n, model: scenario.simulationModel } });
        useAppStore.setState({ simStatus: { state: 'ready', output, atMs } });
      })
      .catch((err: unknown) => {
        if (!alive || err instanceof SupersededError) return;
        useAppStore.getState().setSimStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
    // key covers the scenario, the window and (structural) the active set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, network, meta, ctx.windowProblem]);

  // the same result shown for another instant with the same active set
  useEffect(() => {
    const st = useAppStore.getState();
    if (st.simStatus.state === 'ready' && st.simStatus.output.key === key && st.simStatus.atMs !== atMs) st.setSimStatus({ ...st.simStatus, atMs });
  }, [key, atMs]);

  // 2. connectivity: after the time has settled (not during playback or dragging)
  const status = useAppStore((s) => s.simStatus);
  const auto = useAppStore((s) => s.simAutoImpact);
  useEffect(() => {
    if (status.state !== 'ready' || !auto || playing) return;
    const id = window_.setTimeout(runImpact, 350);
    return () => window_.clearTimeout(id);
  }, [status, auto, playing]);

  // 3. the time series of the light measures
  const sel = useAppStore((s) => s.temporalSel);
  useEffect(() => {
    if (!scenario || !network || !meta || !ctx.range || status.state !== 'ready') return;
    const out = status.output;
    const { times, stepMs } = seriesTimes(ctx.range, stepOf(scenario));
    const seriesKey = seriesKeyOf(scenario, ctx.range, stepMs, sel?.preset ?? '');
    if (scenario.simulationModel === 'structural' && scenario.baselineMode === 'fixed' && ctx.disruption && ctx.baseKey) {
      let memo = seriesMemo.get(ctx.baseKey);
      if (!memo) {
        memo = new Map();
        seriesMemo.set(ctx.baseKey, memo);
        while (seriesMemo.size > 6) seriesMemo.delete(seriesMemo.keys().next().value!);
      }
      // the state only changes at event boundaries: sampling them too makes the step chart exact
      const exact = [...new Set([...times, ...boundaries(ctx.disruption).filter((b) => b >= ctx.range!.startMs && b < ctx.range!.endMs)])].sort((x, y) => x - y);
      const t0 = performance.now();
      const points = structuralSeries({ network, scope: scopeOf(network), scenario, beforeR: out.before.research, beforeNet: out.before.net }, ctx.disruption, exact, memo)
        .map((p) => withImpact(p, `${ctx.baseKey}:${p.sig}`));
      performance.mark('1090web:series-ready', { detail: { points: points.length, states: memo.size, ms: Math.round(performance.now() - t0) } });
      useAppStore.getState().setSimSeries({ key: seriesKey, stepMs, points, done: exact.length, total: exact.length, method: 'structural-fixed: one evaluation per set of events in effect, at every step and event boundary' });
      return;
    }
    if (scenario.simulationModel === 'temporal' && scenario.baselineMode === 'fixed' && out.temporal) {
      const bin = out.temporal.series.length ? (out.window.endMs - out.window.startMs) / out.temporal.series.length : stepMs;
      const binMs = Math.max(HOUR_MS, Math.round(bin / HOUR_MS) * HOUR_MS);
      const points: SeriesPoint[] = out.temporal.series.map((n, i) => {
        const t = out.window.startMs + i * binMs;
        return { t, active: activeEventIds(scenario.events, t), sig: null, lostConnections: null, reducedConnections: null, flights: n, affectedAirports: null, unreachable: null, efficiency: null };
      });
      useAppStore.getState().setSimSeries({ key: seriesKey, stepMs: binMs, points, done: points.length, total: points.length, method: 'temporal-fixed: records of the baseline period by time bin' });
      return;
    }
    // dynamic baseline: points are filled as windows are computed (playback, or runSeries)
    const cur = useAppStore.getState().simSeries;
    const keep = cur && cur.key === seriesKey ? cur.points.filter((p) => p.t !== atMs) : [];
    const d = out.direct;
    const point: SeriesPoint = {
      t: atMs ?? out.window.startMs, active: activeEventIds(scenario.events, atMs ?? out.window.startMs),
      sig: scenario.simulationModel === 'structural' && ctx.disruption && atMs !== null ? activeSignature(ctx.disruption, atMs) : null,
      lostConnections: d.lostConnections, reducedConnections: d.reducedConnections, flights: d.flights, affectedAirports: d.affectedAirports, unreachable: null, efficiency: null,
    };
    const points = [...keep, withImpact(point, out.key)].sort((a, b) => a.t - b.t);
    useAppStore.getState().setSimSeries({ key: seriesKey, stepMs, points, done: points.length, total: times.length, method: 'dynamic: each point is the window ending or starting at that time, against its own observed window' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ctx.range, ctx.baseKey, scenario?.timeline.step]);

  useEffect(() => () => {
    impactClient?.cancel();
    seriesRun.cancelled = true;
    if (network) {
      getTemporalClient(network).cancel('sim');
      getTemporalClient(network).cancel('sim-series');
    }
  }, [network]);
}

const window_ = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

function scopeOf(network: StaticNetwork) {
  const continents = cachedContinents;
  return { network, continentOf: continents ?? network.airports.map(() => '?'), persistence: null };
}
let cachedContinents: string[] | null = null;

function withImpact(p: SeriesPoint, key: string): SeriesPoint {
  const s = impactSummaries.get(key);
  return s ? { ...p, unreachable: s.unreachable, efficiency: s.efficiency } : p;
}

function seriesKeyOf(s: SimulationScenario, range: { startMs: number; endMs: number }, stepMs: number, preset: string): string {
  return hashString(`${canonicalScenario(s, { startMs: 0, endMs: 0 }, { withoutTime: true })}|${s.analysisStart}|${s.analysisEnd}|${range.startMs}|${range.endMs}|${stepMs}|${preset}`);
}

/** Aggregates the window (scenario matched in the temporal model) and builds both networks. */
function computeOutput(
  network: StaticNetwork, scenario: SimulationScenario, disruption: Disruption, window: { startMs: number; endMs: number },
  atMs: number | null, key: string, onProgress?: (done: number, total: number) => void, channel = 'sim',
): Promise<SimulationOutput> {
  const client = getTemporalClient(network);
  const temporal = scenario.simulationModel === 'temporal';
  const binMs = window.endMs - window.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
  const req = {
    window, basis: scenario.filters.basis, binMs, filter: null,
    disruption: temporal ? { wire: toWire(disruption), proxy: scenario.filters.timeProxy, key: baseHash(scenario, window) } : null,
  };
  return Promise.all([client.aggregate(channel, req, onProgress), loadContinents()]).then(([r, rmeta]) => {
    const continentOf = rmeta ? airportContinents(network, rmeta.quality) : network.airports.map(() => '?');
    cachedContinents = continentOf;
    return buildSimulation({
      network, scope: { network, continentOf, persistence: null }, scenario, disruption, window,
      label: windowLabel(window), days: windowDays(window), rows: r.rows, affected: r.affected ?? null, temporal: r.disruption ?? null, key, atMs,
    });
  });
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
      impactSummaries.set(out.key, { unreachable: result.lostPairs.total, efficiency: result.total.after.efficiency });
      if (cur.simStatus.state === 'ready' && `${cur.simStatus.output.key}:impact` === key) cur.setSimImpact({ state: 'ready', key, result });
      // fill the series point(s) of this result
      const ser = cur.simSeries;
      if (ser) {
        const sig = out.key.includes(':') ? out.key.slice(out.key.indexOf(':') + 1) : null;
        const pts = ser.points.map((p) => ((sig !== null && p.sig === sig) || (sig === null && cur.simStatus.state === 'ready' && p.t === cur.simStatus.atMs)
          ? { ...p, unreachable: result.lostPairs.total, efficiency: result.total.after.efficiency } : p));
        cur.setSimSeries({ ...ser, points: pts });
      }
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

const seriesRun = { cancelled: false, id: 0 };

/**
 * Computes the series for every step of the timeline (dynamic baseline: one window per step,
 * each against its own observed window). Sequential, cancellable; the cursor does not move.
 */
export async function runSeries(): Promise<void> {
  const st = useAppStore.getState();
  const s = st.simScenario;
  const sel = st.temporalSel;
  const network = st.network;
  if (!s || !sel || !network || s.baselineMode !== 'dynamic') return;
  const meta = await loadTemporalMeta();
  const ctx = scenarioContext(network, meta.index.datasetVersion, meta.range.startMs, meta.range.endMs);
  const d = resolveDisruption(s.events, networkIndex(network), ctx);
  const range = timelineRange(s, s.events, meta.range);
  const { times, stepMs } = seriesTimes(range, stepOf(s), 240);
  const seriesKey = seriesKeyOf(s, range, stepMs, sel.preset);
  const id = ++seriesRun.id;
  seriesRun.cancelled = false;
  const have = new Map((st.simSeries?.key === seriesKey ? st.simSeries.points : []).map((p) => [p.t, p]));
  const method = 'dynamic: each point is the window ending or starting at that time, against its own observed window';
  for (let i = 0; i < times.length; i++) {
    if (seriesRun.cancelled || seriesRun.id !== id) return;
    const t = times[i]!;
    if (!have.has(t)) {
      const w = dynamicWindow({ ...sel, cursorMs: t }, meta.range);
      if (w) {
        const key = s.simulationModel === 'structural' ? `${baseHash(s, w)}:${activeSignature(d, t)}` : baseHash(s, w);
        try {
          const out = outputs.get(key) ?? (await computeOutput(network, s, d, w, t, key, undefined, 'sim-series'));
          remember(out);
          have.set(t, withImpact({
            t, active: activeEventIds(s.events, t), sig: s.simulationModel === 'structural' ? activeSignature(d, t) : null,
            lostConnections: out.direct.lostConnections, reducedConnections: out.direct.reducedConnections, flights: out.direct.flights,
            affectedAirports: out.direct.affectedAirports, unreachable: null, efficiency: null,
          }, out.key));
        } catch (err) {
          if (err instanceof SupersededError) return;
          throw err;
        }
      }
    }
    if (seriesRun.id !== id) return;
    useAppStore.getState().setSimSeries({ key: seriesKey, stepMs, points: [...have.values()].sort((a, b) => a.t - b.t), done: i + 1, total: times.length, method });
  }
}

export function cancelSeries(): void {
  seriesRun.cancelled = true;
  const n = useAppStore.getState().network;
  if (n) getTemporalClient(n).cancel('sim-series');
}

/**
 * Connectivity for every distinct set of events in effect (structural, fixed baseline): one exact
 * analysis per set, sequential and cancellable. Fills `unreachable` / `efficiency` of the series.
 */
export async function runSeriesImpact(): Promise<void> {
  const st = useAppStore.getState();
  const ser = st.simSeries;
  const s = st.simScenario;
  if (!ser || !s || s.simulationModel !== 'structural' || s.baselineMode !== 'fixed' || st.simStatus.state !== 'ready') return;
  const base = st.simStatus.output.key.split(':')[0]!;
  const sigs = [...new Set(ser.points.map((p) => p.sig).filter((x): x is string => x !== null))];
  const id = ++seriesRun.id;
  seriesRun.cancelled = false;
  const network = st.network!;
  const meta = await loadTemporalMeta();
  const ctx = scenarioContext(network, meta.index.datasetVersion, meta.range.startMs, meta.range.endMs);
  const d = resolveDisruption(s.events, networkIndex(network), ctx);
  const window = st.simStatus.output.window;
  for (let i = 0; i < sigs.length; i++) {
    if (seriesRun.cancelled || seriesRun.id !== id) return;
    const sig = sigs[i]!;
    const key = `${base}:${sig}`;
    if (!impactSummaries.has(key)) {
      const t = ser.points.find((p) => p.sig === sig)!.t;
      const out = outputs.get(key) ?? (await computeOutput(network, s, d, window, t, key, undefined, 'sim-series'));
      remember(out);
      try {
        const r = await getImpactClient().run(`${key}:impact`, out.impactInput);
        impactSummaries.set(key, { unreachable: r.lostPairs.total, efficiency: r.total.after.efficiency });
      } catch (err) {
        if (err instanceof CancelledError) return;
        throw err;
      }
    }
    const cur = useAppStore.getState().simSeries;
    if (cur) useAppStore.getState().setSimSeries({ ...cur, points: cur.points.map((p) => (p.sig ? withImpact(p, `${base}:${p.sig}`) : p)), done: i + 1, total: sigs.length });
  }
}
