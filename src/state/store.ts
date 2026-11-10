import { create } from 'zustand';
import type { MonthData, StaticNetwork } from '../data/model/network';
import { DEFAULT_FILTERS, type NetworkFilters } from '../domain/networkView';
import type { Locale } from '../i18n/messages';

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
  sourcesOpen: boolean;
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
  setSourcesOpen: (v: boolean) => void;
  setBasemapError: (v: boolean) => void;
  setStressRouteCount: (n: number | null) => void;
}

const LOCALE_KEY = 'aerograph.locale';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // storage unavailable (private mode etc.)
  }
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
  sourcesOpen: false,
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
  setSourcesOpen: (sourcesOpen) => set({ sourcesOpen }),
  setBasemapError: (basemapError) => set({ basemapError }),
  setStressRouteCount: (stressRouteCount) => set({ stressRouteCount }),
}));
