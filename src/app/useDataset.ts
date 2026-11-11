import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DatasetLoader } from '../data/loaders/datasetLoader';
import { buildStressNetwork } from '../data/demo/stressNetwork';
import { computeComparison, type Comparison } from '../domain/comparison';
import { computeNetworkView, type NetworkView } from '../domain/networkView';
import { useAppStore } from '../state/store';
import { PLAYBACK_INTERVAL_MS, resolveDatasetId } from './config';

/** The active loader, shared with Research Mode so month files are fetched and cached once. */
let activeLoader: DatasetLoader | null = null;
export function getDatasetLoader(): DatasetLoader | null {
  return activeLoader;
}

function readStressParam(): number | null {
  const raw = new URLSearchParams(window.location.search).get('stress');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Loads the static network once, then the selected month on demand; drives month playback. */
export function useDataset(): { retry: () => void } {
  const loaderRef = useRef<DatasetLoader | null>(null);
  const [monthReloadKey, setMonthReloadKey] = useState(0);
  const status = useAppStore((s) => s.status);
  const network = useAppStore((s) => s.network);
  const monthIndex = useAppStore((s) => s.monthIndex);
  const playing = useAppStore((s) => s.playing);
  const month = useAppStore((s) => s.month);
  const monthLoading = useAppStore((s) => s.monthLoading);
  const stressRouteCount = useAppStore((s) => s.stressRouteCount);
  const compareEnabled = useAppStore((s) => s.compareEnabled);
  const compareBaseIndex = useAppStore((s) => s.compareBaseIndex);

  const loadStatic = useCallback(() => {
    const st = useAppStore.getState();
    const controller = new AbortController();
    const loader = new DatasetLoader(import.meta.env.BASE_URL, resolveDatasetId());
    loaderRef.current = loader;
    activeLoader = loader;
    st.setStatus({ state: 'loading' });
    loader
      .loadStatic(controller.signal)
      .then((net) => {
        const stress = readStressParam();
        if (stress) {
          const { network: sn, month: sm } = buildStressNetwork(stress, net.manifest);
          st.setStressRouteCount(sn.routes.length);
          st.setNetwork(sn);
          st.setMonth(sm);
        } else {
          st.setNetwork(net);
          st.setMonthIndex(Math.max(0, net.manifest.months.length - 1));
        }
        st.setStatus({ state: 'ready' });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        st.setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => loadStatic(), [loadStatic]);

  // Month loading (skipped in stress mode, which has a single in-memory snapshot).
  useEffect(() => {
    if (!network || stressRouteCount !== null) return;
    const entry = network.manifest.months[monthIndex];
    const loader = loaderRef.current;
    if (!entry || !loader) return;
    let cancelled = false;
    const st = useAppStore.getState();
    st.setMonthLoading(true);
    loader
      .loadMonth(entry.month)
      .then((m) => {
        if (cancelled) return;
        st.setMonth(m);
        st.setMonthLoading(false);
        // Prefetch the next month so playback does not stall.
        const next = network.manifest.months[(monthIndex + 1) % network.manifest.months.length];
        if (next) loader.loadMonth(next.month).catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        st.setMonthLoading(false);
        st.setPlaying(false);
        st.setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [network, monthIndex, stressRouteCount, monthReloadKey]);

  // Comparison base month (loaded only while comparing; cached by the loader).
  useEffect(() => {
    const st = useAppStore.getState();
    if (!compareEnabled || !network || stressRouteCount !== null) {
      if (st.baseMonth) st.setBaseMonth(null);
      return;
    }
    const entry = network.manifest.months[compareBaseIndex];
    const loader = loaderRef.current;
    if (!entry || !loader) return;
    let cancelled = false;
    loader
      .loadMonth(entry.month)
      .then((m) => {
        if (!cancelled) useAppStore.getState().setBaseMonth(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        useAppStore.getState().setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [network, compareEnabled, compareBaseIndex, stressRouteCount, monthReloadKey]);

  // Playback: advance after the current month has been displayed for a while.
  useEffect(() => {
    if (!playing || !network || monthLoading || !month) return;
    const n = network.manifest.months.length;
    if (n < 2) return;
    const id = window.setTimeout(() => {
      const st = useAppStore.getState();
      st.setMonthIndex((st.monthIndex + 1) % n);
    }, PLAYBACK_INTERVAL_MS);
    return () => window.clearTimeout(id);
  }, [playing, network, month, monthLoading]);

  const retry = useCallback(() => {
    if (status.state === 'error') {
      if (useAppStore.getState().network) {
        // Static data is fine; retry the month by re-triggering the effect.
        useAppStore.getState().setStatus({ state: 'ready' });
        setMonthReloadKey((k) => k + 1);
      } else {
        loadStatic();
      }
    }
  }, [status, loadStatic]);

  return { retry };
}

/** Comparison between the base month and the current month, or null when not comparing. */
export function useComparison(): Comparison | null {
  const network = useAppStore((s) => s.network);
  const month = useAppStore((s) => s.month);
  const baseMonth = useAppStore((s) => s.baseMonth);
  const enabled = useAppStore((s) => s.compareEnabled);
  const filters = useAppStore((s) => s.filters);
  return useMemo(
    () => (enabled && network && month && baseMonth ? computeComparison(network, baseMonth, month, filters) : null),
    [enabled, network, month, baseMonth, filters],
  );
}

export function useNetworkView(): NetworkView | null {
  const network = useAppStore((s) => s.network);
  const month = useAppStore((s) => s.month);
  const filters = useAppStore((s) => s.filters);
  return useMemo(
    () => (network && month ? computeNetworkView(network, month, filters) : null),
    [network, month, filters],
  );
}
