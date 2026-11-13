import { useCallback } from 'react';
import { useAppStore } from '../state/store';
import type { MessageKey } from './messages';

type PeriodBase = 'filters.threshold' | 'summary.flights' | 'airport.flights' | 'airport.routeList' | 'route.flights';

/** Monthly labels ("monthly flights") become period labels ("flights in the window") in the temporal view. */
export function usePeriodKey(): (k: PeriodBase) => MessageKey {
  const temporal = useAppStore((s) => s.exploreTime === 'temporal');
  return useCallback((k: PeriodBase) => (temporal ? (`${k}.period` as MessageKey) : k), [temporal]);
}
