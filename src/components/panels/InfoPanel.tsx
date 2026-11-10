import { useEffect, useMemo, useRef } from 'react';
import { computeRankings, computeRouteDetail, connectedRoutes, type NetworkView } from '../../domain/networkView';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { greatCircleKm } from '../../utils/geo';
import { Icon } from '../common/Icon';
import type { StaticNetwork } from '../../data/model/network';
import type { Comparison } from '../../domain/comparison';
import { CompareAirport, CompareRoute, CompareSummary } from './ComparePanels';
import { useActiveAdvisories } from '../../app/useAdvisories';
import { advisoriesForCountry } from '../../domain/advisories';

export function InfoPanel({ view, comparison }: { view: NetworkView | null; comparison: Comparison | null }) {
  const network = useAppStore((s) => s.network);
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const selectedRoute = useAppStore((s) => s.selectedRoute);
  const ref = useRef<HTMLElement>(null);
  useReportViewInsets(ref);
  if (!network || !view) return null;
  return (
    <aside ref={ref} className="info panel" aria-label="Details" aria-live="polite">
      {selectedRoute !== null ? (
        <RouteDetailView network={network} view={view} routeId={selectedRoute} comparison={comparison} />
      ) : selectedAirport !== null ? (
        <AirportDetail network={network} view={view} airportIndex={selectedAirport} comparison={comparison} />
      ) : comparison ? (
        <CompareSummary network={network} comparison={comparison} />
      ) : (
        <Summary network={network} view={view} />
      )}
    </aside>
  );
}

const MOBILE_QUERY = '(max-width: 860px)';
const MOBILE_TOP_INSET = 56;

/**
 * On small screens this panel is a bottom sheet over the map. Report how much of the screen it
 * covers so the renderer can keep its view centre (and fly-to targets) in the visible area.
 */
function useReportViewInsets(ref: React.RefObject<HTMLElement | null>) {
  const setViewInsets = useAppStore((s) => s.setViewInsets);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      const el = ref.current;
      if (!mq.matches || !el) {
        setViewInsets({ top: 0, bottom: 0 });
        return;
      }
      const bottom = Math.max(0, window.innerHeight - el.getBoundingClientRect().top);
      setViewInsets({ top: MOBILE_TOP_INSET, bottom: Math.round(bottom) });
    };
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', update);
    mq.addEventListener('change', update);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      mq.removeEventListener('change', update);
    };
  });
}

function DemoTag() {
  const { t } = useI18n();
  const kind = useAppStore((s) => s.network?.manifest.kind);
  const stress = useAppStore((s) => s.stressRouteCount);
  if (stress !== null) return <span className="badge warn-badge">{t('stress.badge')}</span>;
  if (kind === 'observed') return <span className="badge info-badge">{t('observed.badge')}</span>;
  if (kind !== 'demo') return null;
  return <span className="badge warn-badge">{t('demo.badge')}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Summary({ network, view }: { network: StaticNetwork; view: NetworkView }) {
  const { t, number } = useI18n();
  const rankings = useMemo(() => computeRankings(view, 5), [view]);
  const selectAirport = useAppStore((s) => s.selectAirport);
  const selectRoute = useAppStore((s) => s.selectRoute);
  const setListHoverRoute = useAppStore((s) => s.setListHoverRoute);
  const setFilters = useAppStore((s) => s.setFilters);
  const carrierFilter = useAppStore((s) => s.filters.carrierId);
  const code = (i: number) => {
    const a = network.airports[i]!;
    return a.iata ?? a.id;
  };
  const share = view.totalFlights > 0 ? view.callsignFlights / view.totalFlights : 0;
  return (
    <div className="info-body">
      <div className="info-head">
        <h2 className="section-title">{t('summary.title')}</h2>
        <DemoTag />
      </div>
      <div className="stats">
        <Stat label={t('summary.routes')} value={number(view.visibleRouteCount)} />
        <Stat label={t('summary.airports')} value={number(view.visibleAirportCount)} />
        <Stat label={t('summary.flights')} value={number(view.totalFlights)} />
      </div>
      {share > 0 && (
        <p className="hint">{t('summary.callsignShare', { share: `${Math.round(share * 100)}%` })}</p>
      )}
      <p className="hint">{t('summary.hint')}</p>

      <h3 className="section-title">{t('rank.airports')}</h3>
      <ol className="rank-list">
        {rankings.airports.map((a) => (
          <li key={a.index}>
            <button type="button" onClick={() => selectAirport(a.index)}>
              <span className="code">{code(a.index)}</span>
              <span className="route-name">{network.airports[a.index]!.city || network.airports[a.index]!.name}</span>
              <span className="route-value">{number(a.flights)}</span>
            </button>
          </li>
        ))}
      </ol>

      <h3 className="section-title">{t('rank.routes')}</h3>
      <ol className="rank-list" onMouseLeave={() => setListHoverRoute(null)}>
        {rankings.routes.map((r) => {
          const route = network.routes[r.routeId]!;
          return (
            <li key={r.routeId}>
              <button
                type="button"
                onMouseEnter={() => setListHoverRoute(r.routeId)}
                onClick={() => {
                  setListHoverRoute(null);
                  selectRoute(r.routeId);
                }}
              >
                <span className="code">{code(route.a)}</span>
                <span className="code">{code(route.b)}</span>
                <span className="route-value">{number(r.flights)}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {!carrierFilter && rankings.carriers.length > 1 && (
        <>
          <h3 className="section-title">{t('rank.carriers')}</h3>
          <ol className="rank-list">
            {rankings.carriers.map((c) => (
              <li key={c.carrierId}>
                <button type="button" onClick={() => setFilters({ carrierId: c.carrierId })}>
                  <span className="code">{c.carrierId}</span>
                  <span className="route-name" />
                  <span className="route-value">{number(c.flights)}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function AirportDetail({
  network,
  view,
  airportIndex,
  comparison,
}: {
  network: StaticNetwork;
  view: NetworkView;
  airportIndex: number;
  comparison: Comparison | null;
}) {
  const { t, number, countryName } = useI18n();
  const selectAirport = useAppStore((s) => s.selectAirport);
  const selectRoute = useAppStore((s) => s.selectRoute);
  const setListHoverRoute = useAppStore((s) => s.setListHoverRoute);
  const airport = network.airports[airportIndex];
  const routes = useMemo(() => connectedRoutes(network, view, airportIndex), [network, view, airportIndex]);
  const advisories = useActiveAdvisories();
  if (!airport) return null;
  const flights = view.airportFlights[airportIndex] ?? 0;
  const maxFlights = routes[0]?.flights ?? 1;

  return (
    <div className="info-body">
      <div className="info-head">
        <span className="eyebrow">{t('airport.title')}</span>
        <DemoTag />
        <button type="button" className="icon-btn small push" aria-label={t('airport.close')} title={t('airport.close')} onClick={() => selectAirport(null)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <h2 className="entity-title">
        <span className="code big">{airport.iata ?? airport.icao ?? airport.id}</span>
        <span>{airport.name}</span>
      </h2>
      <p className="muted">
        {airport.city} · {countryName(airport.country)}
        {airport.icao && airport.iata ? ` · ${airport.icao}` : ''}
      </p>
      {advisoriesForCountry(advisories, airport.country).length > 0 && (
        <p className="hint advisory-notice">{t('advisory.airportNotice', { country: countryName(airport.country) })}</p>
      )}
      {comparison && <CompareAirport network={network} comparison={comparison} airportIndex={airportIndex} />}
      {!comparison && (
      <div className="stats">
        <Stat label={t('airport.flights')} value={number(flights)} />
        <Stat label={t('airport.routes')} value={number(routes.length)} />
      </div>
      )}
      <p className="muted small">
        {t('airport.coords')}: {airport.lat.toFixed(3)}, {airport.lon.toFixed(3)}
      </p>

      {!comparison && <h3 className="section-title">{t('airport.routeList')}</h3>}
      {comparison ? null : routes.length === 0 ? (
        <p className="hint">{flights > 0 ? t('airport.noRoutes') : t('airport.hidden')}</p>
      ) : (
        <ul className="route-list" onMouseLeave={() => setListHoverRoute(null)}>
          {routes.map((r) => {
            const other = network.airports[r.other];
            if (!other) return null;
            return (
              <li key={r.routeId}>
                <button
                  type="button"
                  onMouseEnter={() => setListHoverRoute(r.routeId)}
                  onFocus={() => setListHoverRoute(r.routeId)}
                  onBlur={() => setListHoverRoute(null)}
                  onClick={() => {
                    setListHoverRoute(null);
                    selectRoute(r.routeId);
                  }}
                >
                  <span className="code">{other.iata ?? other.id}</span>
                  <span className="route-name">{other.city}</span>
                  <span className="route-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, (r.flights / maxFlights) * 100)}%` }} />
                  </span>
                  <span className="route-value">{number(r.flights)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RouteDetailView({
  network,
  view,
  routeId,
  comparison,
}: {
  network: StaticNetwork;
  view: NetworkView;
  routeId: number;
  comparison: Comparison | null;
}) {
  const { t, number } = useI18n();
  const month = useAppStore((s) => s.month);
  const filters = useAppStore((s) => s.filters);
  const selectRoute = useAppStore((s) => s.selectRoute);
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const route = network.routes[routeId];
  const detail = useMemo(
    () => (month ? computeRouteDetail(network, month, filters, routeId) : null),
    [network, month, filters, routeId],
  );
  if (!route || !detail) return null;
  const a = network.airports[route.a]!;
  const b = network.airports[route.b]!;
  const visible = (view.routeFlights[routeId] ?? 0) > 0;
  const total = detail.forward + detail.backward;
  const km = greatCircleKm(a.lat, a.lon, b.lat, b.lon);
  const carrierName = (id: string) => network.carriers.find((c) => c.id === id)?.name ?? id;
  const code = (x: typeof a) => x.iata ?? x.id;

  return (
    <div className="info-body">
      <div className="info-head">
        <button
          type="button"
          className="icon-btn small"
          aria-label={selectedAirport !== null ? t('route.back') : t('airport.close')}
          title={selectedAirport !== null ? t('route.back') : t('airport.close')}
          onClick={() => selectRoute(null)}
        >
          <Icon name={selectedAirport !== null ? 'back' : 'close'} size={14} />
        </button>
        <span className="eyebrow">{t('route.title')}</span>
        <DemoTag />
      </div>
      <h2 className="entity-title">
        <span className="code big">{code(a)}</span>
        <span className="route-arrow">⇄</span>
        <span className="code big">{code(b)}</span>
      </h2>
      <p className="muted">
        {a.city} – {b.city}
      </p>
      {comparison && <CompareRoute comparison={comparison} routeId={routeId} />}
      {!visible && !comparison && <p className="hint warn">{t('route.hidden')}</p>}
      <div className="stats">
        <Stat label={t('route.flights')} value={number(total)} />
        <Stat label={t('route.distance')} value={t('unit.km', { value: number(km) })} />
      </div>

      <h3 className="section-title">{t('route.direction')}</h3>
      <dl className="kv">
        <dt>
          {code(a)} → {code(b)}
        </dt>
        <dd>{number(detail.forward)}</dd>
        <dt>
          {code(b)} → {code(a)}
        </dt>
        <dd>{number(detail.backward)}</dd>
      </dl>

      <h3 className="section-title">{t('route.breakdown')}</h3>
      <dl className="kv">
        <dt>{t('route.passenger')}</dt>
        <dd>{number(detail.passenger)}</dd>
        {filters.mode === 'all' && (
          <>
            <dt>{t('route.cargo')}</dt>
            <dd>{number(detail.cargo)}</dd>
            <dt>{t('route.unknown')}</dt>
            <dd>{number(detail.unknown)}</dd>
          </>
        )}
      </dl>

      {detail.callsign > 0 && (
        <>
          <h3 className="section-title">{t('route.basis')}</h3>
          <dl className="kv">
            <dt>{t('route.observed')}</dt>
            <dd>{number(detail.observed)}</dd>
            <dt>{t('route.callsign')}</dt>
            <dd>{number(detail.callsign)}</dd>
          </dl>
        </>
      )}

      {detail.carriers.length > 0 && (
        <>
          <h3 className="section-title">{t('route.carriers')}</h3>
          <dl className="kv">
            {detail.carriers.map((c) => (
              <div key={c.carrierId} className="kv-row">
                <dt>{carrierName(c.carrierId)}</dt>
                <dd>{number(c.flights)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
