import { create } from 'zustand';
import type { MonthData, StaticNetwork } from '../data/model/network';
import { DEFAULT_FILTERS, type NetworkFilters } from '../domain/networkView';
import type { Locale } from '../i18n/messages';

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
  filters: NetworkFilters;
  selectedAirport: number | null;
  selectedRoute: number | null;
  /** Route hovered in the side panel list. */
  listHoverRoute: number | null;
  hover: HoverInfo | null;
  autoRotate: boolean;
  viewMode: ViewMode;
  sourcesOpen: boolean;
  /** Mobile only: the filter drawer. */
  drawerOpen: boolean;
  /** Screen space (px) covered by UI at the top/bottom of the map on small screens. */
  viewInsets: { top: number; bottom: number };
  basemapError: boolean;
  /** Set when running the renderer stress test (?stress=N). */
  stressRouteCount: number | null;

  setLocale: (l: Locale) => void;
  setStatus: (s: LoadStatus) => void;
  setNetwork: (n: StaticNetwork) => void;
  setMonth: (m: MonthData) => void;
  setMonthIndex: (i: number) => void;
  setMonthLoading: (v: boolean) => void;
  setPlaying: (p: boolean) => void;
  setFilters: (f: Partial<NetworkFilters>) => void;
  resetFilters: () => void;
  selectAirport: (i: number | null) => void;
  selectRoute: (r: number | null) => void;
  setListHoverRoute: (r: number | null) => void;
  setHover: (h: HoverInfo | null) => void;
  setAutoRotate: (v: boolean) => void;
  setViewMode: (m: ViewMode) => void;
  setSourcesOpen: (v: boolean) => void;
  setDrawerOpen: (v: boolean) => void;
  setViewInsets: (v: { top: number; bottom: number }) => void;
  setBasemapError: (v: boolean) => void;
  setStressRouteCount: (n: number | null) => void;
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
  filters: DEFAULT_FILTERS,
  selectedAirport: null,
  selectedRoute: null,
  listHoverRoute: null,
  hover: null,
  autoRotate: true,
  viewMode: initialViewMode(),
  sourcesOpen: false,
  drawerOpen: false,
  viewInsets: { top: 0, bottom: 0 },
  basemapError: false,
  stressRouteCount: null,

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
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setViewInsets: (v) =>
    set((s) => (s.viewInsets.top === v.top && s.viewInsets.bottom === v.bottom ? s : { viewInsets: v })),
  setBasemapError: (basemapError) => set({ basemapError }),
  setStressRouteCount: (stressRouteCount) => set({ stressRouteCount }),
}));
