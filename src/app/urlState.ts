import { useEffect, useRef } from 'react';
import type { StaticNetwork } from '../data/model/network';
import { DEFAULT_FILTERS, type NetworkFilters } from '../domain/networkView';
import { configContext, configFromParams, configToParams, sanitizeConfig, type ResearchConfig } from '../research/model';
import { useAppStore, type AppMode, type ExploreTime, type ResearchCompare } from '../state/store';
import { selectionFromParams, selectionToParams } from '../temporal/urlParams';
import { defaultSelection, type TemporalSelection } from '../temporal/window';

/**
 * Shareable URLs: the month, comparison, filters and selected airport live in the query string.
 *
 *   ?month=2026-08&compare=2026-01&airport=RJTT&country=JP&airline=JAL&traffic=passenger
 *    &airports=observed&min=30&view=globe
 *
 * Research Mode adds `mode=research` and its conditions (rm=month, rt=tier set, rmin=threshold, …;
 * see research/model.ts). `dataset` and `stress` are owned by the loader and passed through untouched.
 */
export interface UrlState {
  monthIndex?: number;
  compareBaseIndex?: number | null;
  airport?: number | null;
  filters?: Partial<NetworkFilters>;
  advisories?: boolean;
  appMode?: AppMode;
  research?: Partial<ResearchConfig>;
  researchCompare?: Pick<ResearchCompare, 'field' | 'value'>;
  exploreTime?: ExploreTime;
  temporal?: Partial<TemporalSelection>;
}

const PASSTHROUGH = ['dataset', 'stress'] as const;

export function parseUrlState(search: string, network: StaticNetwork): UrlState {
  const p = new URLSearchParams(search);
  const monthIdx = (ym: string | null) => {
    if (!ym) return undefined;
    const i = network.manifest.months.findIndex((m) => m.month === ym);
    return i >= 0 ? i : undefined;
  };
  const out: UrlState = {};
  const month = monthIdx(p.get('month'));
  if (month !== undefined) out.monthIndex = month;
  const compare = monthIdx(p.get('compare'));
  if (compare !== undefined) out.compareBaseIndex = compare;
  const airport = p.get('airport');
  if (airport) {
    const idx = network.airportIndexById.get(airport.toUpperCase());
    if (idx !== undefined) out.airport = idx;
  }
  const filters: Partial<NetworkFilters> = {};
  const country = p.get('country')?.toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country) && network.airports.some((a) => a.country === country)) filters.country = country;
  const airline = p.get('airline')?.toUpperCase();
  if (airline && network.carriers.some((c) => c.id === airline)) filters.carrierId = airline;
  if (p.get('traffic') === 'passenger') filters.mode = 'passenger';
  if (p.get('airports') === 'observed') filters.includeCallsign = false;
  const min = Number(p.get('min'));
  if (Number.isFinite(min) && min > 0 && min <= 100000) filters.minFlights = Math.round(min);
  if (Object.keys(filters).length > 0) out.filters = filters;
  if (p.get('advisories') === '1') out.advisories = true;
  if (p.get('time') === 'temporal') {
    out.exploreTime = 'temporal';
    out.temporal = selectionFromParams(p);
  }
  if (p.get('mode') === 'research') {
    out.appMode = 'research';
    out.research = configFromParams(p);
    // rcmp=<field>:<value>, e.g. minFlights:10, month:2026-04, tiers:C, area:C:JP
    const cmp = /^(month|minFlights|tiers|area):(.+)$/.exec(p.get('rcmp') ?? '');
    if (cmp) {
      const field = cmp[1] as ResearchCompare['field'];
      out.researchCompare = { field, value: field === 'minFlights' ? Number(cmp[2]) : cmp[2]! };
    }
  }
  return out;
}

export interface SerializableState {
  monthIndex: number;
  compareEnabled: boolean;
  compareBaseIndex: number;
  selectedAirport: number | null;
  filters: NetworkFilters;
  viewMode: 'flat' | 'globe';
  advisoriesEnabled: boolean;
  appMode?: AppMode;
  researchConfig?: ResearchConfig | null;
  researchCompare?: ResearchCompare;
  exploreTime?: ExploreTime;
  temporalSel?: TemporalSelection | null;
}

export function serializeUrlState(state: SerializableState, network: StaticNetwork, currentSearch: string): string {
  const current = new URLSearchParams(currentSearch);
  const p = new URLSearchParams();
  for (const key of PASSTHROUGH) {
    const v = current.get(key);
    if (v !== null) p.set(key, v);
  }
  const months = network.manifest.months;
  const isLatest = state.monthIndex === months.length - 1;
  if (!isLatest && months[state.monthIndex]) p.set('month', months[state.monthIndex]!.month);
  if (state.compareEnabled && months[state.compareBaseIndex]) {
    if (isLatest && months[state.monthIndex]) p.set('month', months[state.monthIndex]!.month);
    p.set('compare', months[state.compareBaseIndex]!.month);
  }
  if (state.selectedAirport !== null) {
    const a = network.airports[state.selectedAirport];
    if (a) p.set('airport', a.id);
  }
  const f = state.filters;
  if (f.country) p.set('country', f.country);
  if (f.carrierId) p.set('airline', f.carrierId);
  if (f.mode !== DEFAULT_FILTERS.mode) p.set('traffic', f.mode);
  if (f.includeCallsign !== DEFAULT_FILTERS.includeCallsign) p.set('airports', 'observed');
  if (f.minFlights > 0) p.set('min', String(f.minFlights));
  if (state.viewMode === 'globe') p.set('view', 'globe');
  if (state.advisoriesEnabled) p.set('advisories', '1');
  if (state.exploreTime === 'temporal') {
    p.set('time', 'temporal');
    if (state.temporalSel) selectionToParams(state.temporalSel, p);
  }
  if (state.appMode === 'research') {
    p.set('mode', 'research');
    if (state.researchConfig) configToParams(state.researchConfig, p);
    const c = state.researchCompare;
    if (c?.enabled && c.value !== null) p.set('rcmp', `${c.field}:${c.value}`);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Applies the URL once the network has loaded, then mirrors state changes into the URL. */
export function useUrlState(): void {
  const network = useAppStore((s) => s.network);
  const applied = useRef(false);

  useEffect(() => {
    if (!network || applied.current || useAppStore.getState().stressRouteCount !== null) return;
    applied.current = true;
    const st = useAppStore.getState();
    const u = parseUrlState(window.location.search, network);
    if (u.monthIndex !== undefined) st.setMonthIndex(u.monthIndex);
    if (u.filters) st.setFilters(u.filters);
    if (u.compareBaseIndex !== undefined && u.compareBaseIndex !== null) {
      st.setCompareEnabled(true);
      st.setCompareBaseIndex(u.compareBaseIndex);
    }
    if (u.airport !== undefined && u.airport !== null) st.selectAirport(u.airport);
    if (u.advisories) st.setAdvisoriesEnabled(true);
    if (u.exploreTime === 'temporal') {
      if (u.temporal && u.temporal.cursorMs !== undefined) {
        st.setTemporalSel({ ...defaultSelection({ startMs: u.temporal.cursorMs, endMs: u.temporal.cursorMs + 1 }), ...u.temporal });
      }
      st.setExploreTime('temporal');
    }
    if (u.appMode === 'research') {
      st.setResearchConfig(sanitizeConfig(u.research ?? {}, configContext(network)).config);
      if (u.researchCompare) st.setResearchCompare({ enabled: true, ...u.researchCompare });
      st.setAppMode('research');
    }
  }, [network]);

  useEffect(
    () =>
      useAppStore.subscribe((s) => {
        if (!applied.current || !s.network || s.stressRouteCount !== null) return;
        const search = serializeUrlState(s, s.network, window.location.search);
        if (search !== window.location.search) {
          window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
        }
      }),
    [],
  );
}
