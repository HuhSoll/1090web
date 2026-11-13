import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { ResearchMeta } from '../../research/data';
import { changedFields, REGIONS, THRESHOLD_PRESETS, type ResearchConfig } from '../../research/model';
import { AIRPORT_METRICS, airportScores, type AirportMetricKey, type AnalysisResult } from '../../research/results';
import { compareRankings } from '../../research/stats';
import type { AnalysisState } from '../../research/useResearch';
import { useAppStore, type CompareField } from '../../state/store';
import { gapDaysIn } from '../../research/periods';
import { windowLabel } from '../../temporal/useTemporal';
import { Note, SortTable, type Column } from './common';
import { useFormat } from './format';

export function ComparisonPanel({ result, other, otherConfig, meta }: {
  result: AnalysisResult;
  other: AnalysisState;
  otherConfig: ResearchConfig | null;
  meta: ResearchMeta;
}) {
  const { t, monthLabel, countryName } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const cmp = useAppStore((s) => s.researchCompare);
  const setCmp = useAppStore((s) => s.setResearchCompare);
  const config = result.config;

  const options: Record<CompareField, { value: string | number; label: string }[]> = {
    month: network.manifest.months.map((m) => ({ value: m.month, label: monthLabel(m.month) })).filter((o) => o.value !== config.month),
    minFlights: [...THRESHOLD_PRESETS].filter((v) => v !== config.minFlights).map((v) => ({ value: v, label: `≥ ${v}` })),
    tiers: (['D', 'C', 'B', 'A'] as const).filter((v) => v !== config.tiers).map((v) => ({ value: v, label: t(`r.tiersShort.${v}`) })),
    window: config.window ? (['previous', 'day', 'week'] as const).map((v) => ({ value: v, label: t(`r.cmp.window.${v}`) })) : [],
    area: [
      ...REGIONS.map((r) => ({ value: `R:${r}`, label: t(`r.region.${r}`) })),
      ...[...new Set(network.airports.map((a) => a.country))].map((c) => ({ value: `C:${c}`, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label)),
    ],
  };
  const choose = (field: CompareField) => setCmp({ enabled: true, field, value: options[field][0]?.value ?? null });

  return (
    <div className="r-stack">
      <section className="r-box">
        <h4 className="r-h4">{t('r.cmp.setup')}</h4>
        <div className="r-toolbar">
          <label className="field-label" htmlFor="r-cmp-field">{t('r.cmp.change')}</label>
          <select id="r-cmp-field" value={cmp.enabled ? cmp.field : ''} onChange={(e) => (e.target.value ? choose(e.target.value as CompareField) : setCmp({ enabled: false }))}>
            <option value="">{t('r.cmp.off')}</option>
            {config.window ? <option value="window">{t('r.cmp.field.window')}</option> : <option value="month">{t('r.cmp.field.month')}</option>}
            <option value="minFlights">{t('r.cmp.field.minFlights')}</option>
            <option value="tiers">{t('r.cmp.field.tiers')}</option>
            <option value="area">{t('r.cmp.field.area')}</option>
          </select>
          {cmp.enabled && (
            <select aria-label={t('r.cmp.value')} value={String(cmp.value ?? '')} onChange={(e) => setCmp({ value: cmp.field === 'minFlights' ? Number(e.target.value) : e.target.value })}>
              {options[cmp.field].map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
            </select>
          )}
        </div>
        <Note>{t('r.cmp.oneAtATime')}</Note>
      </section>
      {cmp.enabled && otherConfig && <ComparisonResult a={result} other={other} b={otherConfig} meta={meta} />}
      {cmp.enabled && !otherConfig && <p className="hint">{t('r.cmp.same')}</p>}
    </div>
  );
}

function ComparisonResult({ a, other, b, meta }: { a: AnalysisResult; other: AnalysisState; b: ResearchConfig; meta: ResearchMeta }) {
  const { t, monthLabel } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const [metric, setMetric] = useState<AirportMetricKey>('degree');
  const changed = changedFields(a.config, b);
  const unchanged = (['month', 'window', 'country', 'region', 'airport', 'carrier', 'classes', 'minFlights', 'minMonths', 'tiers', 'directed', 'relation'] as const).filter((k) => !changed.includes(k));
  const r = other.state === 'ready' && !other.stale ? other.result : null;
  const gapMonths = a.config.window || b.window
    ? [a.config.window, b.window].filter((w) => w && gapDaysIn(meta, w.startMs, w.endMs).length > 0).map((w) => windowLabel(w!))
    : [a.config.month, b.month].filter((m) => (meta.quality.months.find((q) => q.month === m)?.gapDays.length ?? 0) > 0);

  const cmp = useMemo(() => (r ? compareRankings(airportScores(a, metric), airportScores(r, metric), 20) : null), [a, r, metric]);
  const label = (i: number) => network.airports[i]!.iata ?? network.airports[i]!.id;

  const summary = r
    ? [
        ['r.ov.airports', a.network.airports.length, r.network.airports.length],
        ['r.ov.routes', a.network.routes.length, r.network.routes.length],
        ['r.ov.routesDirected', a.network.directedRoutes, r.network.directedRoutes],
        ['r.ov.flights', a.network.flights, r.network.flights],
        ['r.ov.density', a.metrics.summary.density, r.metrics.summary.density],
        ['r.ov.components', a.metrics.summary.components, r.metrics.summary.components],
        ['r.ov.largest', a.metrics.summary.largestComponent, r.metrics.summary.largestComponent],
        ['r.ov.clustering', a.metrics.summary.averageClustering, r.metrics.summary.averageClustering],
      ] as const
    : [];

  const rowCols: Column<NonNullable<typeof cmp>['rows'][number]>[] = [
    { key: 'airport', label: t('r.col.airport'), value: (x) => label(x.key), render: (x) => <span className="code">{label(x.key)}</span> },
    { key: 'rankRef', label: t('r.cmp.rankA'), numeric: true, value: (x) => x.rankRef },
    { key: 'rankOther', label: t('r.cmp.rankB'), numeric: true, value: (x) => x.rankOther },
    { key: 'change', label: t('r.cmp.rankChange'), numeric: true, value: (x) => x.rankChange, render: (x) => (x.rankChange === null ? '—' : x.rankChange > 0 ? `+${x.rankChange}` : String(x.rankChange)) },
    { key: 'scoreChange', label: t('r.cmp.valueChange'), numeric: true, value: (x) => x.scoreChangePct, render: (x) => (x.scoreChangePct === null ? '—' : f.signedPct(x.scoreChangePct / 100)) },
  ];

  return (
    <>
      <section className="r-box">
        <h4 className="r-h4">{t('r.cmp.conditions')}</h4>
        <dl className="kv">
          {changed.map((k) => (
            <div className="kv-row r-changed" key={k}>
              <dt>{t(`r.field.${k}`)}</dt>
              <dd>A: {k === 'window' ? (a.config.window ? windowLabel(a.config.window) : '—') : String(a.config[k] ?? '—')} → B: {k === 'window' ? (b.window ? windowLabel(b.window) : '—') : String(b[k] ?? '—')}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">{t('r.cmp.unchanged')} {unchanged.map((k) => t(`r.field.${k}`)).join(', ')}</p>
        {gapMonths.length > 0 && <Note warn>{t('r.cmp.gapWarning', { months: gapMonths.map((m) => monthLabel(m)).join(', ') })}</Note>}
        {changed.includes('month') && <Note>{t('r.cmp.monthNote')}</Note>}
      </section>

      {!r && (other.state === 'error' ? <p className="hint warn">{other.message}</p> : <Progress state={other} />)}
      {r && (
        <>
          <section className="r-box">
            <h4 className="r-h4">{t('r.cmp.summary')}</h4>
            <table className="r-table r-compact">
              <thead><tr><th />{['A', 'B', 'Δ'].map((h) => <th key={h} className="num">{h}</th>)}</tr></thead>
              <tbody>
                {summary.map(([key, x, y]) => (
                  <tr key={key}>
                    <td>{t(key)}</td>
                    <td className="num">{Number.isInteger(x) ? f.int(x) : f.dec(x, 4)}</td>
                    <td className="num">{Number.isInteger(y) ? f.int(y) : f.dec(y, 4)}</td>
                    <td className="num">{x ? f.signedPct((y - x) / x) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="r-box">
            <div className="r-toolbar">
              <h4 className="r-h4">{t('r.cmp.ranking')}</h4>
              <select aria-label={t('r.rank.metric')} value={metric} onChange={(e) => setMetric(e.target.value as AirportMetricKey)}>
                {AIRPORT_METRICS.filter((k) => a.config.directed || (k !== 'inDegree' && k !== 'outDegree')).map((k) => <option key={k} value={k}>{t(`r.metric.${k}`)}</option>)}
              </select>
            </div>
            {cmp && (
              <>
                <div className="stats r-stats">
                  <div className="stat"><span className="stat-value">{f.pct(cmp.overlap, 0)}</span><span className="stat-label">{t('r.cmp.overlap')}</span></div>
                  <div className="stat"><span className="stat-value">{f.dec(cmp.jaccard, 2)}</span><span className="stat-label">Jaccard</span></div>
                  <div className="stat"><span className="stat-value">{f.dec(cmp.spearman, 3)}</span><span className="stat-label">Spearman</span></div>
                  <div className="stat"><span className="stat-value">{f.dec(cmp.kendall, 3)}</span><span className="stat-label">Kendall τb</span></div>
                </div>
                <p className="hint">{t('r.cmp.rankDef')}</p>
                {cmp.left.length > 0 && <p className="small">{t('r.cmp.left')} {cmp.left.map(label).join(', ')}</p>}
                {cmp.entered.length > 0 && <p className="small">{t('r.cmp.entered')} {cmp.entered.map(label).join(', ')}</p>}
                <SortTable columns={rowCols} rows={cmp.rows} rowKey={(x) => String(x.key)} initialSort={{ key: 'rankRef', desc: false }} limit={20} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function Progress({ state }: { state: AnalysisState }) {
  const { t } = useI18n();
  if (state.state === 'computing') {
    const pct = state.total ? Math.round((100 * state.done) / state.total) : 0;
    return (
      <div className="r-progress" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>{t('r.status.computing', { pct })}</span>
        <div className="r-progress-bar"><span style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  return (
    <div className="r-progress" role="status">
      <div className="spinner" aria-hidden="true" />
      <span>{t('r.status.loading')}</span>
    </div>
  );
}
