import { useEffect, useMemo, useRef, useState } from 'react';
import { connectedRoutes, notableRoutes, type NetworkView } from '../../domain/networkView';
import { GlobeRenderer, WebGLUnavailableError, type PickHit } from '../../render/globe/GlobeRenderer';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { GlobeControls } from './GlobeControls';

interface Props {
  view: NetworkView | null;
}

const logNorm = (v: number, max: number) => (v > 0 && max > 0 ? Math.log1p(v) / Math.log1p(max) : 0);

/**
 * React bridge for the imperative GlobeRenderer. React owns state; the renderer only receives
 * typed arrays and selection descriptors, and reports picks back through callbacks.
 */
export function GlobeView({ view }: Props) {
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
      });
    } catch (err) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time capability check
      setWebglError(err instanceof WebGLUnavailableError ? 'webgl' : String(err));
      return;
    }
    rendererRef.current = renderer;
    if (import.meta.env.DEV) (window as unknown as { __aerograph?: GlobeRenderer }).__aerograph = renderer;
    renderer.loadBasemap().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('[AeroGraph] basemap failed to load', err);
      useAppStore.getState().setBasemapError(true);
    });
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

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
    const connectedIds = connected ? new Set(connected.map((c) => c.routeId)) : null;
    r.setWeights(rw, aw, connectedIds);
  }, [network, view, connected]);

  // 3b. Notable (highest-volume) routes get slightly thicker lines.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !network || !view) return;
    r.setNotableRoutes(
      notableRoutes(view).map((n) => ({ routeId: n.routeId, weight: logNorm(n.flights, view.maxRouteFlights) })),
    );
  }, [network, view]);

  // 4. Selection / hover.
  const hoveredAirport = hover?.kind === 'airport' ? hover.id : null;
  const hoveredRoute = hover?.kind === 'route' ? hover.id : null;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !view) return;
    const highlighted = (connected ?? []).map((c) => ({
      routeId: c.routeId,
      weight: logNorm(c.flights, view.maxRouteFlights),
    }));
    r.setSelection({
      selectedAirport,
      hoveredAirport,
      highlightedRoutes: highlighted,
      focusRoute: listHoverRoute ?? hoveredRoute ?? selectedRoute,
    });
  }, [view, connected, selectedAirport, hoveredAirport, hoveredRoute, listHoverRoute, selectedRoute]);

  // 5. Fly to newly selected airport.
  useEffect(() => {
    if (selectedAirport === null || !network) return;
    const a = network.airports[selectedAirport];
    if (a) rendererRef.current?.flyTo(a.lat, a.lon);
  }, [selectedAirport, network]);

  useEffect(() => {
    rendererRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

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
