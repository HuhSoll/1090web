import { useEffect, useMemo } from 'react';
import { loadAdvisories } from '../data/loaders/advisoryLoader';
import type { Advisory } from '../data/model/advisory';
import { advisoriesInMonth } from '../domain/advisories';
import { useAppStore } from '../state/store';

/** Loads the advisory file the first time the overlay is turned on. */
export function useAdvisoryLoader(): void {
  const enabled = useAppStore((s) => s.advisoriesEnabled);
  const status = useAppStore((s) => s.advisoriesStatus);
  useEffect(() => {
    if (!enabled || status === 'loading' || status === 'ready') return;
    const st = useAppStore.getState();
    st.setAdvisories(null, 'loading');
    loadAdvisories(import.meta.env.BASE_URL)
      .then((f) => useAppStore.getState().setAdvisories(f, 'ready'))
      .catch((err: unknown) => {
        console.warn('[1090web] advisories failed to load', err);
        useAppStore.getState().setAdvisories(null, 'error');
      });
    // Retrying after an error happens when the user toggles the overlay off and on again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

/** Advisories in effect during the month currently shown (empty when the overlay is off). */
export function useActiveAdvisories(): Advisory[] {
  const enabled = useAppStore((s) => s.advisoriesEnabled);
  const file = useAppStore((s) => s.advisories);
  const month = useAppStore((s) => s.month?.month);
  return useMemo(
    () => (enabled && file && month ? advisoriesInMonth(file.items, month) : []),
    [enabled, file, month],
  );
}
