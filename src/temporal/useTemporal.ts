import { useEffect, useState } from 'react';
import { resolveDatasetId } from '../app/config';
import type { StaticNetwork } from '../data/model/network';
import { assetUrl, fetchJson } from '../data/loaders/fetchJson';
import { useAppStore } from '../state/store';
import { toMonthData, type SeriesFilter } from './aggregate';
import { countryIndex, SupersededError, TemporalClient, type AggregateResponse } from './client';
import { TemporalLoader, type TemporalManifest } from './loader';
import { dayStartMs, daysForWindow, type TemporalIndex } from './model';
import {
  clampWindow,
  compareWindow,
  DAY_MS,
  defaultSelection,
  formatUtc,
  seriesBinMs,
  SPEED_MS,
  stepSelection,
  windowFor,
  windowLength,
  type DataRange,
  type TimeWindow,
} from './window';

// ---- shared instances (one per dataset) ---------------------------------------------------------

let client: TemporalClient | null = null;
export function getTemporalClient(network: StaticNetwork): TemporalClient {
  client ??= new TemporalClient(import.meta.env.BASE_URL, resolveDatasetId(), network);
  return client;
}

export interface TemporalQuality {
  timeQuality: {
    flights: Record<string, number>;
    start_missing_by_region: Record<string, [number, number]>;
    thresholds: Record<string, number>;
  };
  coverage: {
    available?: boolean;
    gapRuns?: { start: string; end: string; hours: number }[];
    thresholds: Record<string, number | string>;
    knownGap: { from: string; to: string; hours: number; evidence: string; interpretation: string };
  };
}

export interface TemporalMeta {
  index: TemporalIndex;
  manifest: TemporalManifest;
  quality: TemporalQuality;
  range: DataRange;
}

let metaPromise: Promise<TemporalMeta> | null = null;
export function loadTemporalMeta(): Promise<TemporalMeta> {
  if (!metaPromise) {
    const loader = new TemporalLoader(import.meta.env.BASE_URL, resolveDatasetId(), 0);
    const root = assetUrl(import.meta.env.BASE_URL, `data/${resolveDatasetId()}/temporal/`);
    metaPromise = Promise.all([loader.loadIndex(), loader.loadManifest(), fetchJson<TemporalQuality>(`${root}quality.json`)]).then(
      ([index, manifest, quality]) => {
        const first = index.days[0];
        const last = index.days[index.days.length - 1];
        if (!first || !last) throw new Error('temporal index is empty');
        return { index, manifest, quality, range: { startMs: dayStartMs(first.day), endMs: dayStartMs(last.day) + DAY_MS } };
      },
    );
    metaPromise.catch(() => {
      metaPromise = null;
    });
  }
  return metaPromise;
}

export type MetaState = { state: 'loading' } | { state: 'ready'; meta: TemporalMeta } | { state: 'error'; message: string };

export function useTemporalMeta(enabled: boolean): MetaState {
  const [st, setSt] = useState<MetaState>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadTemporalMeta()
      .then((meta) => alive && setSt({ state: 'ready', meta }))
      .catch((err: unknown) => alive && setSt({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return st;
}

export function windowLabel(w: TimeWindow): string {
  return `${formatUtc(w.startMs, false)} – ${formatUtc(w.endMs)}`;
}

/** Days (fractional) of a window, used where the monthly code expects "observed days". */
export const windowDays = (w: TimeWindow) => windowLength(w).days;

// ---- the Explore temporal view --------------------------------------------------------------------

/**
 * Keeps Explore's `month` (and `baseMonth` when comparing) in sync with the temporal selection.
 * The map, panels and comparisons then work unchanged. Results always carry the window they
 * belong to; a newer selection supersedes older requests, so an earlier window is never shown
 * for a later one.
 */
export function useTemporal(): MetaState {
  const exploreTime = useAppStore((s) => s.exploreTime);
  const network = useAppStore((s) => s.network);
  const sel = useAppStore((s) => s.temporalSel);
  const filters = useAppStore((s) => s.filters);
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const playing = useAppStore((s) => s.temporalPlaying);
  const status = useAppStore((s) => s.temporalStatus);
  const enabled = exploreTime === 'temporal' && network !== null;
  const meta = useTemporalMeta(enabled);
  const range = meta.state === 'ready' ? meta.meta.range : null;

  // first use: start at the month shown in the monthly view
  useEffect(() => {
    if (!enabled || !range || sel || !network) return;
    const st = useAppStore.getState();
    const m = network.manifest.months[st.monthIndex]?.month;
    const start = m ? Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1) : range.startMs;
    st.setTemporalSel({ ...defaultSelection(range), cursorMs: Math.min(Math.max(start, range.startMs), range.endMs - DAY_MS) });
  }, [enabled, range, sel, network]);

  const win = sel && range ? clampWindow(windowFor(sel), range) : null;
  const key = JSON.stringify([win?.window, sel?.basis, sel?.compare, filters, selectedAirport]);

  useEffect(() => {
    if (!enabled || !sel || !range || !network) return;
    const st = useAppStore.getState();
    if (!win) {
      st.setTemporalStatus({ state: 'error', window: windowFor(sel), message: 'outside' });
      useAppStore.setState({ month: null, baseMonth: null, compareEnabled: false });
      return;
    }
    let alive = true;
    const c = getTemporalClient(network);
    const w = win.window;
    const filter: SeriesFilter = {
      country: countryIndex(network, filters.country),
      carrier: filters.carrierId ? network.carriers.findIndex((x) => x.id === filters.carrierId) : null,
      passengerOnly: filters.mode === 'passenger',
      includeT4: filters.includeCallsign,
      airport: selectedAirport,
    };
    st.setTemporalStatus({ state: 'loading', window: w, done: 0, total: daysForWindow(w.startMs, w.endMs).length });
    // User Timing marks (DevTools / performance measurements): request -> window on screen
    performance.mark('1090web:temporal-request');
    const cw = compareWindow(w, sel.compare);
    const cwc = cw ? clampWindow(cw, range) : null;
    const binMs = seriesBinMs(w);
    const main = c.aggregate('explore', { window: w, basis: sel.basis, binMs, filter }, (done, total) => {
      if (alive) useAppStore.getState().setTemporalStatus({ state: 'loading', window: w, done, total });
    });
    const base: Promise<AggregateResponse | null> = cwc ? c.aggregate('compare', { window: cwc.window, basis: sel.basis, binMs, filter: null }) : Promise.resolve(null);
    if (!cwc) c.cancel('compare');
    Promise.all([main, base])
      .then(([r, b]) => {
        if (!alive) return;
        const carriers = network.carriers.map((x) => x.id);
        const month = toMonthData(r.rows, carriers, windowLabel(w), windowDays(w));
        const baseMonth = b ? toMonthData(b.rows, carriers, windowLabel(b.window), windowDays(b.window)) : null;
        // one update: the map never shows a window with another window's comparison
        useAppStore.setState({
          month,
          baseMonth,
          compareEnabled: baseMonth !== null,
          monthLoading: false,
          temporalStatus: {
            state: 'ready',
            result: {
              window: w, clipped: win.clipped, basis: r.basis, flights: r.flights, trackStart: r.trackStart, fallback: r.fallback,
              series: r.series, days: r.days, missingDays: r.missingDays, elapsedMs: r.elapsedMs, fromCache: r.fromCache,
              base: b ? { window: b.window, flights: b.flights } : null,
            },
          },
        });
        performance.mark('1090web:temporal-ready', { detail: { startMs: w.startMs, endMs: w.endMs, workerMs: r.elapsedMs, fromCache: r.fromCache, days: r.days.length } });
        // warm the cache for the next step
        const next = stepSelection(sel, 1, range);
        if (next !== null) {
          const nw = clampWindow(windowFor({ ...sel, ...next }), range);
          if (nw) c.prefetch(daysForWindow(nw.window.startMs, nw.window.endMs).slice(-2));
        }
      })
      .catch((err: unknown) => {
        if (!alive || err instanceof SupersededError) return;
        useAppStore.getState().setTemporalStatus({ state: 'error', window: w, message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
    // `key` covers the window, basis, comparison, filters and selected airport
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, network]);

  // playback: the next step starts only after the current window is on screen
  useEffect(() => {
    if (!enabled || !playing || !sel || !range || status.state !== 'ready') return;
    const id = window.setTimeout(() => {
      const st = useAppStore.getState();
      const cur = st.temporalSel;
      if (!cur) return;
      const next = stepSelection(cur, 1, range);
      if (next === null) st.setTemporalPlaying(false);
      else st.patchTemporalSel(next);
    }, SPEED_MS[sel.speed]);
    return () => window.clearTimeout(id);
  }, [enabled, playing, sel, range, status]);

  // leaving the temporal view stops its requests
  useEffect(() => {
    if (exploreTime === 'temporal' || !network || !client) return;
    client.cancel('explore');
    client.cancel('compare');
  }, [exploreTime, network]);

  return meta;
}
