import { create } from 'zustand';
import type { MonthData, StaticNetwork } from '../data/model/network';
import { DEFAULT_FILTERS, type NetworkFilters } from '../domain/networkView';
import type { Locale } from '../i18n/messages';
import type { AdvisoryFile } from '../data/model/advisory';
import type { ResearchConfig } from '../research/model';

export type AppMode = 'explore' | 'research';
export type ResearchTab = 'overview' | 'rankings' | 'geography' | 'reliability' | 'comparison' | 'export';
/** What the comparison changes: exactly one condition at a time. */
export type CompareField = 'month' | 'minFlights' | 'tiers' | 'area';
export interface ResearchCompare {
  enabled: boolean;
  field: CompareField;
  /** month 'YYYY-MM', threshold number, tier set 'A'..'D', or area 'C:JP' / 'R:EU' */
  value: string | number | null;
}

export type ViewMode = 'flat' | 'globe';

export type LoadStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export interface HoverInfo {
  kind: 'airport' | 'route';
  id: number;
  x: number;
  y: number;
}

interface AppState {
  locale: Locale;
  status: LoadStatus;
  network: StaticNetwork | null;
  /** Month data currently displayed (may lag behind monthIndex while loading). */
  month: MonthData | null;
  monthIndex: number;
  monthLoading: boolean;
  playing: boolean;
  /** Month comparison: the current month (monthIndex) is compared against compareBaseIndex. */
  compareEnabled: boolean;
  compareBaseIndex: number;
  /** Change categories hidden via the compare legend (ChangeKind values). */
  compareHiddenKinds: readonly number[];
  /** Month data for compareBaseIndex (loaded only while comparing). */
  baseMonth: MonthData | null;
  filters: NetworkFilters;
  selectedAirport: number | null;
  selectedRoute: number | null;
  /** Route hovered in the side panel list. */
  listHoverRoute: number | null;
  hover: HoverInfo | null;
  autoRotate: boolean;
  viewMode: ViewMode;
  sourcesOpen: boolean;
  /** Safety-advisory overlay (off by default; data loaded on first use). */
  advisoriesEnabled: boolean;
  advisories: AdvisoryFile | null;
  advisoriesStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Mobile only: the filter drawer. */
  drawerOpen: boolean;
  /** Screen space (px) covered by UI at the top/bottom of the map on small screens. */
  viewInsets: { top: number; bottom: number };
  basemapError: boolean;
  /** Set when running the renderer stress test (?stress=N). */
  stressRouteCount: number | null;
  /** Explore (map) or Research (analysis) screen; Explore state is kept while in Research. */
  appMode: AppMode;
  researchConfig: ResearchConfig | null;
  researchTab: ResearchTab;
  researchCompare: ResearchCompare;
  /** Shown in Explore after "show on map": Research conditions Explore cannot express. */
  researchMapNote: string | null;

  setLocale: (l: Locale) => void;
  setStatus: (s: LoadStatus) => void;
  setNetwork: (n: StaticNetwork) => void;
  setMonth: (m: MonthData) => void;
  setMonthIndex: (i: number) => void;
  setMonthLoading: (v: boolean) => void;
  setPlaying: (p: boolean) => void;
  setCompareEnabled: (v: boolean) => void;
  setCompareBaseIndex: (i: number) => void;
  toggleCompareKind: (kind: number) => void;
  setBaseMonth: (m: MonthData | null) => void;
  setFilters: (f: Partial<NetworkFilters>) => void;
  resetFilters: () => void;
  selectAirport: (i: number | null) => void;
  selectRoute: (r: number | null) => void;
  setListHoverRoute: (r: number | null) => void;
  setHover: (h: HoverInfo | null) => void;
  setAutoRotate: (v: boolean) => void;
  setViewMode: (m: ViewMode) => void;
  setSourcesOpen: (v: boolean) => void;
  setAdvisoriesEnabled: (v: boolean) => void;
  setAdvisories: (f: AdvisoryFile | null, status: AppState['advisoriesStatus']) => void;
  setDrawerOpen: (v: boolean) => void;
  setViewInsets: (v: { top: number; bottom: number }) => void;
  setBasemapError: (v: boolean) => void;
  setStressRouteCount: (n: number | null) => void;
  setAppMode: (m: AppMode) => void;
  setResearchConfig: (c: ResearchConfig) => void;
  patchResearchConfig: (c: Partial<ResearchConfig>) => void;
  setResearchTab: (t: ResearchTab) => void;
  setResearchCompare: (c: Partial<ResearchCompare>) => void;
  setResearchMapNote: (n: string | null) => void;
}

const LOCALE_KEY = '1090web.locale';
const VIEW_KEY = '1090web.view';

/** Reads a saved preference, falling back to the key used before the rename (AeroGraph). */
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace('1090web.', 'aerograph.'));
  } catch {
    return null; // storage unavailable (private mode etc.)
  }
}

function initialViewMode(): ViewMode {
  // A shared link (?view=globe) wins over the saved preference.
  if (typeof window !== 'undefined') {
    const fromUrl = new URLSearchParams(window.location.search).get('view');
    if (fromUrl === 'globe' || fromUrl === 'flat') return fromUrl;
  }
  const saved = readPref(VIEW_KEY);
  return saved === 'globe' ? 'globe' : 'flat';
}

function initialLocale(): Locale {
  const saved = readPref(LOCALE_KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ja')) return 'ja';
  return 'en';
}

export const useAppStore = create<AppState>((set) => ({
  locale: initialLocale(),
  status: { state: 'idle' },
  network: null,
  month: null,
  monthIndex: 0,
  monthLoading: false,
  playing: false,
  compareEnabled: false,
  compareBaseIndex: 0,
  compareHiddenKinds: [],
  baseMonth: null,
  filters: DEFAULT_FILTERS,
  selectedAirport: null,
  selectedRoute: null,
  listHoverRoute: null,
  hover: null,
  autoRotate: true,
  viewMode: initialViewMode(),
  sourcesOpen: false,
  advisoriesEnabled: false,
  advisories: null,
  advisoriesStatus: 'idle',
  drawerOpen: false,
  viewInsets: { top: 0, bottom: 0 },
  basemapError: false,
  stressRouteCount: null,
  appMode: 'explore',
  researchConfig: null,
  researchTab: 'overview',
  researchCompare: { enabled: false, field: 'month', value: null },
  researchMapNote: null,

  setLocale: (locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // ignore
    }
    document.documentElement.lang = locale;
    set({ locale });
  },
  setStatus: (status) => set({ status }),
  setNetwork: (network) => set({ network }),
  setMonth: (month) => set({ month }),
  setMonthIndex: (monthIndex) => set({ monthIndex }),
  setMonthLoading: (monthLoading) => set({ monthLoading }),
  setPlaying: (playing) => set({ playing }),
  setCompareEnabled: (compareEnabled) =>
    set((s) => ({
      compareEnabled,
      // Turning comparison on starts from the previous month.
      compareBaseIndex: compareEnabled ? Math.max(0, s.monthIndex - 1) : s.compareBaseIndex,
    })),
  setCompareBaseIndex: (compareBaseIndex) => set({ compareBaseIndex }),
  toggleCompareKind: (kind) =>
    set((s) => ({
      compareHiddenKinds: s.compareHiddenKinds.includes(kind)
        ? s.compareHiddenKinds.filter((k) => k !== kind)
        : [...s.compareHiddenKinds, kind],
    })),
  setBaseMonth: (baseMonth) => set({ baseMonth }),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  selectAirport: (selectedAirport) => set({ selectedAirport, selectedRoute: null, listHoverRoute: null }),
  selectRoute: (selectedRoute) => set({ selectedRoute }),
  setListHoverRoute: (listHoverRoute) => set({ listHoverRoute }),
  setHover: (hover) => set({ hover }),
  setAutoRotate: (autoRotate) => set({ autoRotate }),
  setViewMode: (viewMode) => {
    try {
      localStorage.setItem(VIEW_KEY, viewMode);
    } catch {
      // ignore
    }
    set({ viewMode });
  },
  setSourcesOpen: (sourcesOpen) => set({ sourcesOpen }),
  setAdvisoriesEnabled: (advisoriesEnabled) => set({ advisoriesEnabled }),
  setAdvisories: (advisories, advisoriesStatus) => set({ advisories, advisoriesStatus }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setViewInsets: (v) =>
    set((s) => (s.viewInsets.top === v.top && s.viewInsets.bottom === v.bottom ? s : { viewInsets: v })),
  setBasemapError: (basemapError) => set({ basemapError }),
  setStressRouteCount: (stressRouteCount) => set({ stressRouteCount }),
  setAppMode: (appMode) => set((s) => ({ appMode, hover: null, playing: false, researchMapNote: appMode === 'research' ? null : s.researchMapNote })),
  setResearchConfig: (researchConfig) => set({ researchConfig }),
  patchResearchConfig: (c) => set((s) => (s.researchConfig ? { researchConfig: { ...s.researchConfig, ...c } } : s)),
  setResearchTab: (researchTab) => set({ researchTab }),
  setResearchCompare: (c) => set((s) => ({ researchCompare: { ...s.researchCompare, ...c } })),
  setResearchMapNote: (researchMapNote) => set({ researchMapNote }),
}));
