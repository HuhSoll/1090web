import { useMemo, useState } from 'react';
import { periodOf } from '../../research/periods';
import { useI18n } from '../../i18n/useI18n';
import { AIRPORT_METRICS, type AirportMetricKey, type AnalysisResult } from '../../research/results';
import type { RouteRow } from '../../research/network';
import { useAppStore } from '../../state/store';
import { Note, SortTable, type Column } from './common';
import { useFormat } from './format';

interface AirportRow {
  airport: number;
  node: number;
  id: string;
  code: string;
  name: string;
  country: string;
  values: Record<AirportMetricKey, number>;
}

export function RankingsPanel({ result, focus, onFocus, onShowOnMap }: {
  result: AnalysisResult;
  focus: number | null;
  onFocus: (airport: number | null) => void;
  onShowOnMap: (airport: number | null) => void;
}) {
  const { t, countryName, monthLabel } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const setCompare = useAppStore((s) => s.setResearchCompare);
  const setTab = useAppStore((s) => s.setResearchTab);
  const [metric, setMetric] = useState<AirportMetricKey>('degree');
  const [query, setQuery] = useState('');
  const { metrics, config } = result;
  const metricKeys = AIRPORT_METRICS.filter((k) => config.directed || (k !== 'inDegree' && k !== 'outDegree'));

  const rows = useMemo<AirportRow[]>(() => result.network.airports.map((a, node) => {
    const ap = network.airports[a]!;
    const values = Object.fromEntries(AIRPORT_METRICS.map((k) => [k, metrics[k][node]!])) as Record<AirportMetricKey, number>;
    return { airport: a, node, id: ap.id, code: ap.iata ?? ap.id, name: ap.name, country: ap.country, values };
  }), [result, network, metrics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.code.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  }, [rows, query]);

  // competition rank by the chosen metric over the whole network (not only the filtered rows)
  const rankOf = useMemo(() => {
    const sorted = [...rows].sort((x, y) => y.values[metric] - x.values[metric] || x.id.localeCompare(y.id));
    const m = new Map<number, number>();
    let rank = 0;
    let prev: number | null = null;
    sorted.forEach((r, i) => {
      if (r.values[metric] !== prev) {
        rank = i + 1;
        prev = r.values[metric];
      }
      m.set(r.airport, rank);
    });
    return m;
  }, [rows, metric]);

  const digits = (k: AirportMetricKey) => (k === 'degree' || k === 'inDegree' || k === 'outDegree' || k === 'strength' ? 0 : k === 'pagerank' ? 5 : 4);
  const metricCol = (k: AirportMetricKey): Column<AirportRow> => ({
    key: k,
    label: t(`r.metric.${k}`),
    title: t(`r.metricDef.${k}`),
    numeric: true,
    value: (r) => r.values[k],
    render: (r) => (digits(k) === 0 ? f.int(r.values[k]) : f.dec(r.values[k], digits(k))),
  });
  const columns: Column<AirportRow>[] = [
    { key: 'rank', label: t('r.col.rank'), numeric: true, value: (r) => -(rankOf.get(r.airport) ?? 0), render: (r) => rankOf.get(r.airport) },
    { key: 'code', label: t('r.col.airport'), value: (r) => r.code, render: (r) => <span className="code">{r.code}</span> },
    { key: 'name', label: t('r.col.name'), value: (r) => r.name },
    { key: 'country', label: t('r.col.country'), value: (r) => r.country, render: (r) => countryName(r.country) },
    metricCol(metric),
    ...metricKeys.filter((k) => k !== metric && ['degree', 'strength', 'betweenness', 'pagerank'].includes(k)).map(metricCol),
  ];

  const focusRow = focus !== null ? rows.find((r) => r.airport === focus) ?? null : null;

  return (
    <div className="r-stack">
      <section>
        <h3 className="r-h">{t('r.rank.airportsTitle', { metric: t(`r.metric.${metric}`), month: monthLabel(periodOf(config)) })}</h3>
        <p className="hint">{t('r.rank.definition', {
          tiers: t(`r.tiersShort.${config.tiers}`), min: config.minFlights,
          graph: t(config.directed ? 'r.graph.directed' : 'r.graph.undirected'), n: rows.length,
        })}</p>
        <div className="r-toolbar">
          <label className="field-label" htmlFor="r-metric">{t('r.rank.metric')}</label>
          <select id="r-metric" value={metric} onChange={(e) => setMetric(e.target.value as AirportMetricKey)}>
            {metricKeys.map((k) => <option key={k} value={k}>{t(`r.metric.${k}`)}</option>)}
          </select>
          <input className="r-input" type="search" placeholder={t('r.rank.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Note>{t(`r.metricDef.${metric}`)}</Note>
        {(metric === 'degree' || metric === 'degreeCentrality') && (
          <Note warn>
            {t('r.rank.lowFreqWarning')}{' '}
            <button type="button" className="link-btn" onClick={() => {
              setCompare({ enabled: true, field: 'minFlights', value: config.minFlights >= 10 ? 1 : 10 });
              setTab('comparison');
            }}>{t('r.rank.compareThreshold')}</button>
          </Note>
        )}
        <SortTable
          key={metric}
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          initialSort={{ key: metric, desc: true }}
          selectedKey={focusRow?.id ?? null}
          onRowClick={(r) => onFocus(r.airport === focus ? null : r.airport)}
        />
      </section>

      {focusRow && <AirportDetail row={focusRow} result={result} onShowOnMap={() => onShowOnMap(focusRow.airport)} />}

      <RouteTable result={result} />
    </div>
  );
}

function AirportDetail({ row, result, onShowOnMap }: { row: AirportRow; result: AnalysisResult; onShowOnMap: () => void }) {
  const { t, countryName } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const routes = useMemo(() => result.routes.filter((r) => r.origin === row.airport || r.destination === row.airport).slice(0, 15), [result, row]);
  return (
    <section className="r-box">
      <div className="r-detail-head">
        <h4 className="r-h4"><span className="code">{row.code}</span> {row.name} · {countryName(row.country)}</h4>
        <button type="button" className="primary-btn" onClick={onShowOnMap}>{t('r.map.show')}</button>
      </div>
      <dl className="kv">
        {AIRPORT_METRICS.filter((k) => result.config.directed || (k !== 'inDegree' && k !== 'outDegree')).map((k) => (
          <div className="kv-row" key={k}>
            <dt title={t(`r.metricDef.${k}`)}>{t(`r.metric.${k}`)}</dt>
            <dd>{k === 'degree' || k === 'strength' || k === 'inDegree' || k === 'outDegree' ? f.int(row.values[k]) : f.dec(row.values[k], k === 'pagerank' ? 5 : 4)}</dd>
          </div>
        ))}
      </dl>
      <h5 className="r-h5">{t('r.rank.topRoutes')}</h5>
      <ul className="r-mini">
        {routes.map((r) => {
          const other = r.origin === row.airport ? r.destination : r.origin;
          const ap = network.airports[other]!;
          return (
            <li key={`${r.origin}-${r.destination}`}>
              <span>{r.directed ? (r.origin === row.airport ? '→' : '←') : '↔'} <span className="code">{ap.iata ?? ap.id}</span> {ap.name}</span>
              <span className="num">{f.int(r.flights)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RouteTable({ result }: { result: AnalysisResult }) {
  const { t, monthLabel } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const total = network.manifest.months.length;
  const label = (i: number) => {
    const a = network.airports[i]!;
    return a.iata ?? a.id;
  };
  const columns: Column<RouteRow>[] = [
    { key: 'from', label: result.config.directed ? t('r.col.origin') : t('r.col.endA'), value: (r) => label(r.origin), render: (r) => <span className="code">{label(r.origin)}</span> },
    { key: 'to', label: result.config.directed ? t('r.col.destination') : t('r.col.endB'), value: (r) => label(r.destination), render: (r) => <span className="code">{label(r.destination)}</span> },
    { key: 'flights', label: t('r.col.flights'), numeric: true, value: (r) => r.flights, render: (r) => f.int(r.flights) },
    {
      key: 'mom', label: t('r.col.mom'), numeric: true,
      title: result.previousMonth ? t('r.col.momTitle', { month: monthLabel(result.previousMonth) }) : undefined,
      value: (r) => (r.previous ? (r.flights - r.previous) / r.previous : null),
      render: (r) => (r.previous === null ? '—' : r.previous === 0 ? t('r.col.momNew') : f.signedPct((r.flights - r.previous) / r.previous)),
    },
    ...([0, 1, 2, 3] as const).map((i): Column<RouteRow> => ({
      key: `t${i + 1}`, label: `T${i + 1}`, numeric: true, value: (r) => r.tiers[i], render: (r) => f.int(r.tiers[i]),
    })),
    { key: 'months', label: t('r.col.months'), numeric: true, title: t('r.col.monthsTitle'), value: (r) => r.monthsPresent, render: (r) => (r.monthsPresent === null ? '—' : `${r.monthsPresent}/${total}`) },
  ];
  return (
    <section>
      <h3 className="r-h">{t('r.rank.routesTitle', { month: monthLabel(periodOf(result.config)) })}</h3>
      <p className="hint">{t('r.rank.routesDefinition', { min: result.config.minFlights, tiers: t(`r.tiersShort.${result.config.tiers}`) })}</p>
      <SortTable columns={columns} rows={result.routes} rowKey={(r) => `${r.origin}-${r.destination}`} initialSort={{ key: 'flights', desc: true }} />
      <Note>{t('r.rank.routesNote')}</Note>
    </section>
  );
}
