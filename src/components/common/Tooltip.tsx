import type { NetworkView } from '../../domain/networkView';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';

export function Tooltip({ view }: { view: NetworkView | null }) {
  const { t, number, countryName } = useI18n();
  const hover = useAppStore((s) => s.hover);
  const network = useAppStore((s) => s.network);
  if (!hover || !network || !view) return null;

  let title: string;
  let sub: string;
  let flights: number;
  if (hover.kind === 'airport') {
    const a = network.airports[hover.id];
    if (!a) return null;
    title = `${a.iata ?? a.id} · ${a.name}`;
    sub = `${a.city}, ${countryName(a.country)}`;
    flights = view.airportFlights[hover.id] ?? 0;
  } else {
    const r = network.routes[hover.id];
    if (!r) return null;
    const a = network.airports[r.a]!;
    const b = network.airports[r.b]!;
    title = `${a.iata ?? a.id} ⇄ ${b.iata ?? b.id}`;
    sub = `${a.city} – ${b.city}`;
    flights = view.routeFlights[hover.id] ?? 0;
  }

  // Keep the tooltip inside the viewport.
  const x = Math.min(hover.x + 14, window.innerWidth - 260);
  const y = Math.min(hover.y + 14, window.innerHeight - 90);

  return (
    <div className="tooltip" style={{ transform: `translate(${x}px, ${y}px)` }} role="tooltip">
      <div className="tooltip-title">{title}</div>
      <div className="muted small">{sub}</div>
      <div className="tooltip-value">{t('unit.flights', { value: number(flights) })}</div>
      <div className="muted tiny">{t('tooltip.clickToSelect')}</div>
    </div>
  );
}
