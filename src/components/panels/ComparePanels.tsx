import { useMemo } from 'react';
import type { StaticNetwork } from '../../data/model/network';
import { ChangeKind, relativeChange, type Comparison, type RouteChange } from '../../domain/comparison';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';

/** Swatch colours; must match the compare branch of render/shaders/routeShaders.ts. */
const CHANGE_COLORS = {
  up: '#4db3ff',
  down: '#ff944d',
  new: '#8ce0ff',
  gone: '#ff6b33',
  stable: '#73859e',
} as const;

const ORDER = ['up', 'down', 'new', 'gone', 'stable'] as const;

function useMonthPair(c: Comparison) {
  const { monthLabel } = useI18n();
  return { base: monthLabel(c.base.month), target: monthLabel(c.target.month) };
}

function Delta({ base, target }: { base: number; target: number }) {
  const { number } = useI18n();
  const rel = relativeChange(base, target);
  const cls = target > base ? 'delta-up' : target < base ? 'delta-down' : 'muted';
  const sign = target > base ? '+' : '';
  return (
    <span className={cls}>
      {rel === null ? '+∞' : `${sign}${Math.round(rel * 100)}%`}
      <span className="muted small"> ({sign}{number(Math.round((target - base) * 10) / 10)})</span>
    </span>
  );
}

const perDay = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

export function CompareLegend({ comparison }: { comparison: Comparison }) {
  const { t, number } = useI18n();
  return (
    <div className="compare-legend panel" aria-label={t('compare.legend')}>
      <span className="section-title">{t('compare.legend')}</span>
      <ul>
        {ORDER.map((k) => (
          <li key={k}>
            <span className="swatch" style={{ background: CHANGE_COLORS[k] }} />
            <span>{t(`compare.${k}`)}</span>
            <span className="muted small">{number(comparison.counts[k])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RouteChangeList({ network, items }: { network: StaticNetwork; items: RouteChange[] }) {
  const selectRoute = useAppStore((s) => s.selectRoute);
  const setListHoverRoute = useAppStore((s) => s.setListHoverRoute);
  const { number } = useI18n();
  return (
    <ul className="route-list" onMouseLeave={() => setListHoverRoute(null)}>
      {items.map((c) => {
        const r = network.routes[c.routeId]!;
        const a = network.airports[r.a]!;
        const b = network.airports[r.b]!;
        return (
          <li key={c.routeId}>
            <button
              type="button"
              className="change-row"
              onMouseEnter={() => setListHoverRoute(c.routeId)}
              onClick={() => {
                setListHoverRoute(null);
                selectRoute(c.routeId);
              }}
            >
              <span className="code">{a.iata ?? a.id}</span>
              <span className="code">{b.iata ?? b.id}</span>
              <span className="route-value">
                {number(perDay(c.base))} → {number(perDay(c.target))}
              </span>
              <Delta base={c.base} target={c.target} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function CompareSummary({ network, comparison }: { network: StaticNetwork; comparison: Comparison }) {
  const { t, number } = useI18n();
  const months = useMonthPair(comparison);
  const same = comparison.base.month === comparison.target.month;
  return (
    <div className="info-body">
      <div className="info-head">
        <h2 className="section-title">{t('compare.title', months)}</h2>
      </div>
      {same ? (
        <p className="hint warn">{t('compare.sameMonth')}</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="stat-value">
                {number(perDay(comparison.perDay.base))} → {number(perDay(comparison.perDay.target))}
              </span>
              <span className="stat-label">
                {t('compare.perDay')} · <Delta base={comparison.perDay.base} target={comparison.perDay.target} />
              </span>
            </div>
          </div>
          <p className="hint">{t('compare.note')}</p>
          <p className="hint warn">{t('compare.caveat')}</p>
          {comparison.topGainers.length > 0 && (
            <>
              <h3 className="section-title">{t('compare.gainers')}</h3>
              <RouteChangeList network={network} items={comparison.topGainers} />
            </>
          )}
          {comparison.topLosers.length > 0 && (
            <>
              <h3 className="section-title">{t('compare.losers')}</h3>
              <RouteChangeList network={network} items={comparison.topLosers} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Airport block in compare mode: movements per day and its routes sorted by change. */
export function CompareAirport({
  network,
  comparison,
  airportIndex,
}: {
  network: StaticNetwork;
  comparison: Comparison;
  airportIndex: number;
}) {
  const { t } = useI18n();
  const changes = useMemo(() => {
    const out: RouteChange[] = [];
    const baseView = comparison.base.routeFlights;
    const targetView = comparison.target.routeFlights;
    for (const id of network.routesByAirport[airportIndex] ?? []) {
      if (comparison.kind[id] === ChangeKind.Hidden) continue;
      out.push({ routeId: id, base: baseView[id]! / comparison.baseDays, target: targetView[id]! / comparison.targetDays });
    }
    return out.sort((x, y) => Math.abs(y.target - y.base) - Math.abs(x.target - x.base)).slice(0, 25);
  }, [network, comparison, airportIndex]);
  const b = comparison.airportBase[airportIndex] ?? 0;
  const tt = comparison.airportTarget[airportIndex] ?? 0;
  const { number } = useI18n();
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-value">
            {number(perDay(b))} → {number(perDay(tt))}
          </span>
          <span className="stat-label">
            {t('compare.movementsPerDay')} · <Delta base={b} target={tt} />
          </span>
        </div>
      </div>
      <h3 className="section-title">{t('compare.routeChanges')}</h3>
      <RouteChangeList network={network} items={changes} />
    </>
  );
}

/** Route block in compare mode. */
export function CompareRoute({ comparison, routeId }: { comparison: Comparison; routeId: number }) {
  const { t, number } = useI18n();
  const months = useMonthPair(comparison);
  const b = (comparison.base.routeFlights[routeId] ?? 0) / comparison.baseDays;
  const tt = (comparison.target.routeFlights[routeId] ?? 0) / comparison.targetDays;
  return (
    <div className="stats">
      <div className="stat">
        <span className="stat-value">
          {number(perDay(b))} → {number(perDay(tt))}
        </span>
        <span className="stat-label">
          {t('compare.perDay')} ({t('compare.title', months)}) · <Delta base={b} target={tt} />
        </span>
      </div>
    </div>
  );
}
