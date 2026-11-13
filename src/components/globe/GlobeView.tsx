import { useEffect, useMemo, useRef, useState } from 'react';
import { ChangeKind, comparisonAsView, standoutChanges, type Comparison } from '../../domain/comparison';
import { connectedRoutes, notableRoutes, type NetworkView } from '../../domain/networkView';
import { GlobeRenderer, WebGLUnavailableError, type PickHit } from '../../render/globe/GlobeRenderer';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { GlobeControls } from './GlobeControls';
import { useActiveAdvisories } from '../../app/useAdvisories';
import { advisoryCountryCodes } from '../../domain/advisories';

interface Props {
  view: NetworkView | null;
  /** When comparing months, routes are weighted by the larger month and coloured by change. */
  comparison: Comparison | null;
  /** Simulation: scenario targets, directly suspended routes, an alternative path to highlight. */
  marks?: SimMarks | null;
}

export interface SimMarks {
  airports: readonly number[];
  suspendedRoutes: readonly number[];
  pathRoutes: readonly number[];
}

/** Directly suspended routes (scenario targets): warm amber, solid. Lost connections stay dashed orange. */
const SUSPENDED_COLOR = '#ffd27a';

/** Thick-line colours for new / no-longer-seen routes; match the route shader's compare branch. */
const NEW_COLOR = '#ccffe6';
const GONE_COLOR = '#ff7338';

const logNorm = (v: number, max: number) => (v > 0 && max > 0 ? Math.log1p(v) / Math.log1p(max) : 0);

/**
 * React bridge for the imperative GlobeRenderer. React owns state; the renderer only receives
 * typed arrays and selection descriptors, and reports picks back through callbacks.
 */
export function GlobeView({ view: monthView, comparison, marks = null }: Props) {
  const hiddenKinds = useAppStore((s) => s.compareHiddenKinds);
  const view = useMemo(
    () => (comparison ? comparisonAsView(comparison, hiddenKinds) : monthView),
    [comparison, monthView, hiddenKinds],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const { t } = useI18n();

  const network = useAppStore((s) => s.network);
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const selectedRoute = useAppStore((s) => s.selectedRoute);
  const listHoverRoute = useAppStore((s) => s.listHoverRoute);
  const hover = useAppStore((s) => s.hover);
  const autoRotate = useAppStore((s) => s.autoRotate);
  const viewMode = useAppStore((s) => s.viewMode);
  const viewInsets = useAppStore((s) => s.viewInsets);
  const appMode = useAppStore((s) => s.appMode);

  // 1. Create / dispose the renderer.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: GlobeRenderer;
    try {
      renderer = new GlobeRenderer(container, {
        onHover: (hit: PickHit | null, x: number, y: number) => {
          const st = useAppStore.getState();
          if (!hit) {
            if (st.hover) st.setHover(null);
            return;
          }
          const id = hit.kind === 'airport' ? hit.index : hit.routeId;
          st.setHover({ kind: hit.kind, id, x, y });
        },
        onClick: (hit) => {
          const st = useAppStore.getState();
          if (!hit) {
            st.selectAirport(null);
          } else if (hit.kind === 'airport') {
            st.selectAirport(hit.index);
          } else {
            st.selectRoute(hit.routeId);
          }
        },
      }, useAppStore.getState().viewMode);
    } catch (err) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time capability check
      setWebglError(err instanceof WebGLUnavailableError ? 'webgl' : String(err));
      return;
    }
    rendererRef.current = renderer;
    if (import.meta.env.DEV) (window as unknown as { __map?: GlobeRenderer }).__map = renderer;
    renderer.loadBasemap().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('[1090web] basemap failed to load', err);
      useAppStore.getState().setBasemapError(true);
    });
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // The map is covered by Research Mode: stop drawing until it is visible again.
  useEffect(() => {
    rendererRef.current?.setPaused(appMode === 'research');
  }, [appMode]);

  // 2. Static geometry: once per dataset.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !network) return;
    const latLon = new Float32Array(network.airports.length * 2);
    network.airports.forEach((a, i) => {
      latLon[i * 2] = a.lat;
      latLon[i * 2 + 1] = a.lon;
    });
    const endpoints = new Uint32Array(network.routes.length * 2);
    network.routes.forEach((route, i) => {
      endpoints[i * 2] = route.a;
      endpoints[i * 2 + 1] = route.b;
    });
    r.setNetwork({ airportLatLon: latLon, routeEndpoints: endpoints });
  }, [network]);

  // Routes connected to the selected airport (for highlighting).
  const connected = useMemo(() => {
    if (!network || !view || selectedAirport === null) return null;
    return connectedRoutes(network, view, selectedAirport);
  }, [network, view, selectedAirport]);

  // 3. Weights: on month / filter change. Only textures/attributes are updated.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !network || !view) return;
    const rw = new Float32Array(view.routeFlights.length);
    for (let i = 0; i < rw.length; i++) rw[i] = logNorm(view.routeFlights[i]!, view.maxRouteFlights);
    const aw = new Float32Array(view.airportFlights.length);
    for (let i = 0; i < aw.length; i++) aw[i] = logNorm(view.airportFlights[i]!, view.maxAirportFlights);
    // scenario targets stay visible even when they have no flights left
    for (const i of marks?.airports ?? []) aw[i] = Math.max(aw[i]!, 0.35);
    const connectedIds = connected ? new Set(connected.map((c) => c.routeId)) : null;
    r.setWeights(rw, aw, connectedIds, comparison ? comparison.kind : null);
  }, [network, view, connected, comparison, marks]);

  // 3b. Notable (highest-volume) routes get slightly thicker lines.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !network || !view) return;
    // In compare mode the thick lines go to the busiest new / no-longer-seen routes, which are
    // otherwise easy to miss among thousands of thin lines.
    const suspended = (marks?.suspendedRoutes ?? []).map((routeId) => ({ routeId, weight: 0.8, color: SUSPENDED_COLOR }));
    r.setNotableRoutes(
      suspended.length || marks
        ? [...suspended, ...(comparison ? standoutChanges(comparison, hiddenKinds).filter((c) => !marks?.suspendedRoutes.includes(c.routeId)).map(({ routeId }) => ({
            routeId, weight: logNorm(comparison.weight[routeId]!, comparison.maxWeight), color: GONE_COLOR, dashed: true,
          })) : [])]
        : comparison
        ? standoutChanges(comparison, hiddenKinds).map(({ routeId, kind }) => ({
            routeId,
            weight: logNorm(comparison.weight[routeId]!, comparison.maxWeight),
            color: kind === ChangeKind.New ? NEW_COLOR : GONE_COLOR,
            dashed: kind === ChangeKind.Gone,
          }))
        : notableRoutes(view).map((n) => ({ routeId: n.routeId, weight: logNorm(n.flights, view.maxRouteFlights) })),
    );
  }, [network, view, comparison, hiddenKinds, marks]);

  // 4. Selection / hover.
  const hoveredAirport = hover?.kind === 'airport' ? hover.id : null;
  const hoveredRoute = hover?.kind === 'route' ? hover.id : null;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !view) return;
    const path = marks?.pathRoutes ?? [];
    const highlighted = path.length
      ? path.map((routeId) => ({ routeId, weight: 1 }))
      : (connected ?? []).map((c) => ({ routeId: c.routeId, weight: logNorm(c.flights, view.maxRouteFlights) }));
    r.setSelection({
      selectedAirport,
      hoveredAirport,
      highlightedRoutes: highlighted,
      focusRoute: listHoverRoute ?? hoveredRoute ?? selectedRoute,
      markedAirports: marks?.airports ?? [],
    });
  }, [view, connected, selectedAirport, hoveredAirport, hoveredRoute, listHoverRoute, selectedRoute, marks]);

  // Safety-advisory overlay: tint countries with an advisory in effect this month.
  const activeAdvisories = useActiveAdvisories();
  useEffect(() => {
    rendererRef.current?.setAdvisoryCountries(advisoryCountryCodes(activeAdvisories));
  }, [activeAdvisories]);

  // 5. Fly to newly selected airport.
  useEffect(() => {
    if (selectedAirport === null || !network) return;
    const a = network.airports[selectedAirport];
    if (a) rendererRef.current?.flyTo(a.lat, a.lon);
  }, [selectedAirport, network]);

  useEffect(() => {
    rendererRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  useEffect(() => {
    rendererRef.current?.setViewMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    rendererRef.current?.setViewInsets(viewInsets.top, viewInsets.bottom);
  }, [viewInsets]);

  if (webglError) {
    return (
      <div className="globe-fallback" role="alert">
        <h2>{t('app.webgl.title')}</h2>
        <p>{webglError === 'webgl' ? t('app.webgl.body') : webglError}</p>
      </div>
    );
  }

  return (
    <>
      <div ref={containerRef} className="globe-container" />
      <GlobeControls rendererRef={rendererRef} />
    </>
  );
}
