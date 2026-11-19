import { useEffect, useMemo, useState } from 'react';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import countriesUrl from 'world-atlas/countries-110m.json?url';
import type { AirportRow, ExperimentResult } from '../../experiments/model';
import { useI18n } from '../../i18n/useI18n';
import { useAppStore, type ExperimentState } from '../../state/store';
import { Note, SortTable, Stat, type Column } from './common';
import { downloadText, useFormat } from './format';
import { rankingsCsv, stability, statsCsv } from '../../experiments/exports';

type View = 'overview' | 'ranking' | 'stability' | 'distribution' | 'geography' | 'details';
type Key = 'systemic' | 'spillover';
const VIEWS: View[] = ['overview', 'ranking', 'stability', 'distribution', 'geography', 'details'];

export function ExperimentResults({ state, highlight, onShowOnMap, onClose }: {
  state: ExperimentState;
  highlight: string[];
  onShowOnMap: (airport: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<View>('overview');
  const [key, setKey] = useState<Key>('spillover');
  const [run, setRun] = useState(Math.min(1, state.result.runs.length - 1));
  const [selected, setSelected] = useState<string | null>(highlight[0] ?? null);
  const r = state.result;
  const network = useAppStore((s) => s.network)!;
  const showSelected = () => {
    const i = selected ? network.airportIndexById.get(selected) : undefined;
    if (i !== undefined) onShowOnMap(i);
  };

  return (
    <div className="r-stack">
      <section className="r-box">
        <div className="r-detail-head">
          <h4 className="r-h4">{r.definition.name || r.definition.experimentId} <span className="small x-dim">· {t(`x.type.${r.definition.experimentType}`)}</span></h4>
          <button type="button" className="pill-btn" onClick={onClose}>{t('x.new')}</button>
        </div>
        <p className="small">
          {t('x.res.source', { origin: state.origin === 'browser' ? t('x.res.browser') : state.origin, dataset: `${r.dataset.id} v${r.dataset.version ?? '?'}`, hash: r.definitionHash })}
          {' · '}
          {r.computation.exact ? t('x.res.exact') : t('x.res.approx', { k: r.computation.sources.join('/') })}
        </p>
        {state.warnings.map((w) => <Note key={w} warn>{t(w as never)}</Note>)}
        <div className="r-toolbar">
          <div className="segmented" role="radiogroup" aria-label={t('x.metric')}>
            {(['spillover', 'systemic'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={key === k} className={key === k ? 'is-active' : ''} onClick={() => setKey(k)} title={t(`x.metric.${k}.desc`)}>{t(`x.metric.${k}`)}</button>
            ))}
          </div>
          {selected && (
            <>
              <span className="small">{t('x.selected', { id: label(r.airports.find((a) => a.id === selected)) })}</span>
              <button type="button" className="pill-btn" onClick={showSelected}>{t('x.showOnMap')}</button>
            </>
          )}
        </div>
      </section>
      <nav className="research-tabs x-views" role="tablist" aria-label={t('x.views')}>
        {VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'is-active' : ''} onClick={() => setView(v)}>{t(`x.view.${v}`)}</button>
        ))}
      </nav>
      {view === 'overview' && <Overview r={r} k={key} />}
      {view === 'ranking' && <Ranking r={r} k={key} run={run} setRun={setRun} selected={selected} onSelect={setSelected} highlight={highlight} />}
      {view === 'stability' && <Stability r={r} k={key} selected={selected} onSelect={setSelected} highlight={highlight} />}
      {view === 'distribution' && <Distribution r={r} k={key} selected={selected} onSelect={setSelected} highlight={highlight} />}
      {view === 'geography' && <Geography r={r} k={key} run={run} setRun={setRun} selected={selected} onSelect={setSelected} />}
      {view === 'details' && <Details r={r} k={key} selected={selected} />}
    </div>
  );
}

const label = (a: AirportRow | undefined) => (a ? `${a.iata ?? a.id} ${a.name ?? ''}`.trim() : '—');
const isTrialRun = (r: ExperimentResult) => r.runs.map((x, i) => (x.kind === 'trial' ? i : -1)).filter((i) => i >= 0);

// ---- overview -------------------------------------------------------------------------------------

function Overview({ r, k }: { r: ExperimentResult; k: Key }) {
  const { t } = useI18n();
  const f = useFormat();
  const topK = r.definition.topK;
  const ref = r.runs[0]!;
  const stable = r.airports.filter((a) => (k === 'systemic' ? a.ref.rankSystemic : a.ref.rankSpillover) <= (topK[0] ?? 10));
  const nStable = stable.filter((a) => stability(a, k) === 'stable').length;
  return (
    <>
      <section className="r-box">
        <div className="stats r-stats">
          <Stat label={t('x.ov.runs')} value={f.int(r.runs.length)} />
          <Stat label={t('x.ov.candidates')} value={f.int(r.candidates.count)} />
          <Stat label={t('x.ov.nodes')} value={f.int(ref.nodes)} />
          <Stat label={t('x.ov.sysSpill')} value={f.dec(r.systemicVsSpillover.spearman, 3)} note={t('x.ov.sysSpill.note')} />
          <Stat label={t('x.ov.stableTop', { k: topK[0] ?? 10 })} value={r.runs.length >= 3 ? `${nStable} / ${stable.length}` : '—'} note={t('x.stab.rule')} />
        </div>
        <p className="small">{t('x.ov.reference', { label: ref.label })}</p>
        <Note>{t(`x.interp.${r.definition.experimentType}`)}</Note>
        {r.candidates.count < ref.nodes && <Note>{t('x.scope.subset', { c: f.int(r.candidates.count), n: f.int(ref.nodes) })}</Note>}
        {!r.computation.exact && <Note>{t('x.interp.approx')}</Note>}
        {r.definition.experimentType === 'sensitivity' && <Note>{t('x.t1.note')}</Note>}
      </section>
      <section className="r-box">
        <h4 className="r-h4">{t('x.ov.byRun')}</h4>
        <div className="r-table-wrap">
          <table className="r-table r-compact">
            <thead>
              <tr>
                <th>{t('x.col.run')}</th>
                <th className="num">{t('x.col.nodes')}</th>
                <th className="num">{t('x.col.absent')}</th>
                <th className="num" title={t('x.col.spearman.title')}>Spearman</th>
                <th className="num" title={t('x.col.common.title')}>{t('x.col.common')}</th>
                <th className="num">Kendall</th>
                {topK.map((kk) => <th key={kk} className="num" title={t('x.col.topk.title')}>Top-{kk}</th>)}
                {topK.slice(0, 1).map((kk) => <th key={kk} className="num">Jaccard {kk}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.runs.map((x) => {
                const c = x.comparison[k];
                return (
                  <tr key={x.runId}>
                    <td>{x.label}{x.complete ? '' : ' ⚠'}</td>
                    <td className="num">{f.int(x.nodes)}</td>
                    <td className="num">{f.int(x.absent)}</td>
                    <td className="num">{f.dec(c.spearman, 3)}</td>
                    <td className="num">{f.dec(c.spearmanCommon, 3)}</td>
                    <td className="num">{f.dec(c.kendall, 3)}</td>
                    {topK.map((kk) => <td key={kk} className="num">{f.pct(c[`top${kk}`], 0)}</td>)}
                    {topK.slice(0, 1).map((kk) => <td key={kk} className="num">{f.dec(c[`jaccard${kk}`], 2)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small x-dim">{t('x.ov.byRun.note')}</p>
      </section>
    </>
  );
}

// ---- ranking comparison ---------------------------------------------------------------------------------

function Ranking({ r, k, run, setRun, selected, onSelect, highlight }: { r: ExperimentResult; k: Key; run: number; setRun: (i: number) => void; selected: string | null; onSelect: (id: string) => void; highlight: string[] }) {
  const { t } = useI18n();
  const f = useFormat();
  const rk = k === 'systemic' ? 'rankSystemic' : 'rankSpillover';
  const c = r.runs[run]!.comparison[k];
  const cols: Column<AirportRow>[] = [
    { key: 'ap', label: t('x.col.airport'), value: (a) => a.iata ?? a.id, render: (a) => <span className={highlight.includes(a.id) ? 'x-hl' : undefined}>{label(a)}</span> },
    { key: 'r0', label: t('x.col.rankRef'), numeric: true, value: (a) => a.runs[rk][0]! },
    { key: 'r1', label: t('x.col.rankRun'), numeric: true, value: (a) => a.runs[rk][run]! },
    { key: 'd', label: t('x.col.rankDiff'), numeric: true, value: (a) => a.runs[rk][run]! - a.runs[rk][0]!, render: (a) => signed(a.runs[rk][run]! - a.runs[rk][0]!) },
    { key: 'v0', label: t('x.col.valueRef'), numeric: true, value: (a) => a.runs[k][0] ?? null, render: (a) => f.dec(a.runs[k][0], 6) },
    { key: 'v1', label: t('x.col.valueRun'), numeric: true, value: (a) => a.runs[k][run] ?? null, render: (a) => f.dec(a.runs[k][run], 6) },
  ];
  return (
    <section className="r-box">
      <label className="r-inline">
        <span className="small">{t('x.compareWith')}</span>
        <select className="r-input" value={run} onChange={(e) => setRun(Number(e.target.value))}>
          {r.runs.map((x, i) => <option key={x.runId} value={i}>{x.label}</option>)}
        </select>
      </label>
      <div className="stats r-stats">
        <Stat label="Spearman" value={f.dec(c.spearman, 3)} note={t('x.col.spearman.title')} />
        <Stat label={t('x.col.common')} value={f.dec(c.spearmanCommon, 3)} note={t('x.col.common.title')} />
        <Stat label="Kendall τb" value={f.dec(c.kendall, 3)} />
        {r.definition.topK.map((kk) => <Stat key={kk} label={`Top-${kk}`} value={f.pct(c[`top${kk}`], 0)} note={`Jaccard ${f.dec(c[`jaccard${kk}`], 2)}`} />)}
      </div>
      <p className="small x-dim">{t('x.rank.note')}</p>
      <SortTable columns={cols} rows={r.airports} rowKey={(a) => a.id} initialSort={{ key: 'r0', desc: false }} onRowClick={(a) => onSelect(a.id)} selectedKey={selected} />
    </section>
  );
}

const signed = (x: number) => (x > 0 ? `+${x}` : String(x));

// ---- stability ------------------------------------------------------------------------------------------

function Stability({ r, k, selected, onSelect, highlight }: { r: ExperimentResult; k: Key; selected: string | null; onSelect: (id: string) => void; highlight: string[] }) {
  const { t } = useI18n();
  const f = useFormat();
  const refRank = (a: AirportRow) => (k === 'systemic' ? a.ref.rankSystemic : a.ref.rankSpillover);
  const st = (a: AirportRow) => a[`${k}RankStats`] as AirportRow['systemicRankStats'];
  const k0 = r.definition.topK[0] ?? 10;
  const cols: Column<AirportRow>[] = [
    { key: 'ap', label: t('x.col.airport'), value: (a) => a.iata ?? a.id, render: (a) => <span className={highlight.includes(a.id) ? 'x-hl' : undefined}>{label(a)}</span> },
    { key: 'ref', label: t('x.col.rankRef'), numeric: true, value: refRank },
    { key: 'med', label: t('x.col.rankMedian'), numeric: true, value: (a) => st(a).median, render: (a) => f.dec(st(a).median, 1) },
    { key: 'range', label: t('x.col.rankRange'), numeric: true, value: (a) => (st(a).p95 ?? 0) - (st(a).p05 ?? 0), render: (a) => `${f.dec(st(a).p05, 0)}–${f.dec(st(a).p95, 0)}` },
    { key: 'sd', label: t('x.col.rankSd'), numeric: true, value: (a) => st(a).sd, render: (a) => f.dec(st(a).sd, 1) },
    { key: 'top', label: t('x.col.topShare', { k: k0 }), numeric: true, value: (a) => a[`${k}Top${k0}Share`] as number, render: (a) => f.pct(a[`${k}Top${k0}Share`] as number, 0) },
    { key: 'cls', label: t('x.col.class'), value: (a) => stability(a, k), render: (a) => t(`x.stab.${stability(a, k)}`) },
    { key: 'iso', label: t('x.col.isolated'), numeric: true, value: (a) => a.isolatedIn.length },
  ];
  return (
    <section className="r-box">
      <p className="small">{t(r.definition.experimentType === 'missingness' ? 'x.stab.overTrials' : 'x.stab.overConditions', { n: (isTrialRun(r).length || r.runs.length) })}</p>
      <p className="small x-dim">{t('x.stab.rule')} {t('x.notCI')}</p>
      <SortTable columns={cols} rows={r.airports} rowKey={(a) => a.id} initialSort={{ key: 'ref', desc: false }} onRowClick={(a) => onSelect(a.id)} selectedKey={selected} />
    </section>
  );
}

// ---- impact distribution ------------------------------------------------------------------------------------

function Distribution({ r, k, selected, onSelect, highlight }: { r: ExperimentResult; k: Key; selected: string | null; onSelect: (id: string) => void; highlight: string[] }) {
  const { t } = useI18n();
  const f = useFormat();
  const [n, setN] = useState(20);
  const rows = useMemo(() => {
    const byRef = [...r.airports].sort((a, b) => (k === 'systemic' ? a.ref.rankSystemic - b.ref.rankSystemic : a.ref.rankSpillover - b.ref.rankSpillover));
    const top = byRef.slice(0, n);
    for (const id of [...highlight, ...(selected ? [selected] : [])]) {
      const a = r.airports.find((x) => x.id === id);
      if (a && !top.includes(a)) top.push(a);
    }
    return top;
  }, [r, k, n, highlight, selected]);
  const st = (a: AirportRow) => a[`${k}Stats`] as AirportRow['systemicStats'];
  const max = Math.max(1e-12, ...rows.map((a) => Math.max(st(a).max ?? 0, a.runs[k][0] ?? 0)));
  const W = 640;
  const L = 150;
  const H = 18;
  const x = (v: number | null) => L + ((v ?? 0) / max) * (W - L - 16);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => q * max);
  return (
    <section className="r-box">
      <div className="r-toolbar">
        <span className="small">{t('x.dist.show')}</span>
        <select className="r-input x-narrow" value={n} onChange={(e) => setN(Number(e.target.value))}>
          {[10, 20, 50].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <p className="small x-dim">{t('x.dist.note')} {t('x.notCI')}</p>
      <svg className="x-dist" viewBox={`0 0 ${W} ${rows.length * H + 34}`} role="img" aria-label={t('x.view.distribution')}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={0} y2={rows.length * H + 4} className="x-grid" />
            <text x={x(v)} y={rows.length * H + 18} className="x-axis" textAnchor="middle">{f.dec(v, v < 0.001 ? 5 : 4)}</text>
          </g>
        ))}
        <text x={W - 16} y={rows.length * H + 32} className="x-axis" textAnchor="end">{t(`x.metric.${k}`)} ({t('x.dist.unit')})</text>
        {rows.map((a, i) => {
          const s = st(a);
          const y = i * H + H / 2;
          return (
            <g key={a.id} className={`x-row${selected === a.id ? ' is-selected' : ''}${highlight.includes(a.id) ? ' x-hl' : ''}`} onClick={() => onSelect(a.id)}>
              <text x={L - 8} y={y + 4} textAnchor="end" className="x-label">{a.iata ?? a.id}</text>
              <line x1={x(s.p05)} x2={x(s.p95)} y1={y} y2={y} className="x-whisker" />
              <rect x={x(s.p25)} y={y - 5} width={Math.max(1, x(s.p75) - x(s.p25))} height={10} className="x-box" />
              <line x1={x(s.median)} x2={x(s.median)} y1={y - 6} y2={y + 6} className="x-median" />
              <circle cx={x(a.runs[k][0] ?? 0)} cy={y} r={3} className="x-ref" />
              <title>{`${label(a)}\n${t('x.dist.tip', { p05: f.dec(s.p05, 6), med: f.dec(s.median, 6), p95: f.dec(s.p95, 6), ref: f.dec(a.runs[k][0], 6) })}`}</title>
            </g>
          );
        })}
      </svg>
      <p className="small x-dim">{t('x.dist.legend')}</p>
    </section>
  );
}

// ---- geographic comparison -----------------------------------------------------------------------------------

type Layer = 'value' | 'range' | 'top' | 'change';

function Geography({ r, k, run, setRun, selected, onSelect }: { r: ExperimentResult; k: Key; run: number; setRun: (i: number) => void; selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const [layer, setLayer] = useState<Layer>('range');
  const land = useLand(720, 360);
  const rk = k === 'systemic' ? 'rankSystemic' : 'rankSpillover';
  const k0 = r.definition.topK[0] ?? 10;
  const value = (a: AirportRow): number | null => {
    const s = a[`${k}RankStats`] as AirportRow['systemicRankStats'];
    if (layer === 'value') return a.runs[k][0] ?? null;
    if (layer === 'range') return s.p95 !== null && s.p05 !== null ? s.p95 - s.p05 : null;
    if (layer === 'top') return a[`${k}Top${k0}Share`] as number;
    return a.runs[rk][run]! - a.runs[rk][0]!;
  };
  const vals = r.airports.map(value).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const diverging = layer === 'change';
  // diverging: symmetric, clipped at the 95th percentile of |change|; otherwise a quantile scale
  // (a few extreme values would otherwise put every other airport in one colour)
  const absSorted = vals.map(Math.abs).sort((a, b) => a - b);
  const hi = diverging ? Math.max(1, absSorted[Math.floor(0.95 * (absSorted.length - 1))] ?? 1) : vals[vals.length - 1] ?? 1;
  const lo = diverging ? -hi : vals[0] ?? 0;
  const position = (v: number) => {
    if (diverging) return Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
    if (vals.length < 2) return 0.5;
    // share of airports with a smaller value (ties: the middle of the tie)
    let a = 0;
    let b = vals.length;
    while (a < b) { const m = (a + b) >> 1; if (vals[m]! < v) a = m + 1; else b = m; }
    let c = a;
    while (c < vals.length && vals[c] === v) c++;
    return ((a + c - 1) / 2) / (vals.length - 1);
  };
  const ramp = (q: number) =>
    // colours already used on the map: stable grey, accent, accent-warm, target red
    q < 1 / 3 ? mix('#73859e', '#7fd6ff', q * 3) : q < 2 / 3 ? mix('#7fd6ff', '#ffd27a', (q - 1 / 3) * 3) : mix('#ffd27a', '#ff6147', (q - 2 / 3) * 3);
  const color = (v: number | null) => (v === null ? 'var(--text-dim)' : ramp(position(v)));
  const W = 720;
  const H = 360;
  const px = (lon: number) => ((lon + 180) / 360) * W;
  const py = (lat: number) => ((90 - lat) / 180) * H;
  const order = [...r.airports].filter((a) => a.lat !== null && a.lon !== null).sort((a, b) => (value(a) ?? -Infinity) - (value(b) ?? -Infinity));
  // legend: colour at q, labelled with the value there (quantiles, or the linear scale when diverging)
  const qs = [0, 0.25, 0.5, 0.75, 1];
  const stops = qs.map((q) => (diverging ? lo + q * (hi - lo) : vals.length ? vals[Math.round(q * (vals.length - 1))]! : 0));
  const fmt = (v: number) => (layer === 'top' ? f.pct(v, 0) : layer === 'value' ? f.dec(v, 5) : diverging ? signed(Math.round(v)) : f.dec(v, 0));
  const byContinent = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const a of r.airports) {
      const v = value(a);
      if (v === null) continue;
      m.set(a.continent || '?', [...(m.get(a.continent || '?') ?? []), v]);
    }
    return [...m.entries()].map(([c, v]) => ({ c, n: v.length, mean: v.reduce((x, y) => x + y, 0) / v.length })).sort((x, y) => y.n - x.n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, k, layer, run]);
  return (
    <section className="r-box">
      <div className="r-toolbar">
        <select className="r-input x-narrow" value={layer} onChange={(e) => setLayer(e.target.value as Layer)} aria-label={t('x.geo.layer')}>
          {(['range', 'top', 'value', 'change'] as const).map((l) => <option key={l} value={l}>{t(`x.geo.${l}`, { k: k0 })}</option>)}
        </select>
        {layer === 'change' && (
          <select className="r-input x-narrow" value={run} onChange={(e) => setRun(Number(e.target.value))} aria-label={t('x.compareWith')}>
            {r.runs.map((x, i) => <option key={x.runId} value={i}>{x.label}</option>)}
          </select>
        )}
      </div>
      <svg className="x-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('x.view.geography')}>
        <rect x={0} y={0} width={W} height={H} className="x-map-bg" />
        {land && <path d={land} className="x-land" />}
        {[-120, -60, 0, 60, 120].map((l) => <line key={`m${l}`} x1={px(l)} x2={px(l)} y1={0} y2={H} className="x-grid" />)}
        {[-60, -30, 0, 30, 60].map((l) => <line key={`p${l}`} x1={0} x2={W} y1={py(l)} y2={py(l)} className="x-grid" />)}
        {order.map((a) => (
          <circle key={a.id} cx={px(a.lon!)} cy={py(a.lat!)} r={selected === a.id ? 5 : 3} fill={color(value(a))}
            className={selected === a.id ? 'x-dot is-selected' : 'x-dot'} onClick={() => onSelect(a.id)}>
            <title>{`${label(a)}: ${value(a) === null ? '—' : fmt(value(a)!)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="x-legend" aria-label={t('x.geo.legend')}>
        <span className="small">{t(`x.geo.${layer}`, { k: k0 })}</span>
        <span className="x-legend-bar" style={{ background: `linear-gradient(90deg, ${qs.map((q) => ramp(q)).join(', ')})` }} />
        <span className="x-legend-ticks">{stops.map((s, i) => <span key={i} className="small mono">{fmt(s)}</span>)}</span>
        <span className="x-legend-ticks small x-dim">{t(diverging ? 'x.geo.scale.linear' : 'x.geo.scale.quantile', { p: 95 })}</span>
      </div>
      <p className="small x-dim">{t(`x.geo.${layer}.desc`)} {t('x.geo.note')}</p>
      <table className="r-table r-compact">
        <thead><tr><th>{t('x.col.continent')}</th><th className="num">{t('x.col.airports')}</th><th className="num">{t('x.col.mean')}</th></tr></thead>
        <tbody>{byContinent.map((x) => <tr key={x.c}><td>{x.c}</td><td className="num">{f.int(x.n)}</td><td className="num">{fmt(x.mean)}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

let landCache: Promise<string> | null = null;

/** Country outlines (the basemap data of the globe) as one SVG path, equirectangular W x H. */
function useLand(W: number, H: number): string | null {
  const [d, setD] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    landCache ??= fetch(countriesUrl)
      .then((r) => r.json() as Promise<Topology>)
      .then((topo) => {
        const geo = feature(topo, topo.objects.countries as GeometryCollection);
        const proj = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]);
        return geoPath(proj)(geo) ?? '';
      });
    landCache.then((x) => alive && setD(x)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [W, H]);
  return d;
}

function mix(a: string, b: string, q: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * q)).join(',')})`;
}

// ---- details ------------------------------------------------------------------------------------------------

function Details({ r, k, selected }: { r: ExperimentResult; k: Key; selected: string | null }) {
  const { t } = useI18n();
  const f = useFormat();
  const a = selected ? r.airports.find((x) => x.id === selected) : undefined;
  const rk = k === 'systemic' ? 'rankSystemic' : 'rankSpillover';
  const base = `1090web_experiment_${r.definitionHash}`;
  return (
    <>
      <section className="r-box">
        <h4 className="r-h4">{t('x.det.runs')}</h4>
        <div className="r-table-wrap">
          <table className="r-table r-compact">
            <thead>
              <tr>
                <th>{t('x.col.run')}</th><th className="num">{t('x.col.nodes')}</th><th className="num">{t('x.col.arcs')}</th><th className="num">{t('x.col.flights')}</th>
                <th>{t('x.col.method')}</th><th className="num">{t('x.col.absent')}</th><th className="num">{t('x.col.isolated')}</th><th className="num">{t('x.col.seconds')}</th><th>{t('x.col.complete')}</th>
              </tr>
            </thead>
            <tbody>
              {r.runs.map((x) => (
                <tr key={x.runId}>
                  <td>{x.label}</td><td className="num">{f.int(x.nodes)}</td><td className="num">{f.int(x.arcs)}</td><td className="num">{f.int(x.flights)}</td>
                  <td>{x.exact ? t('x.res.exactShort') : t('x.sources.k', { k: x.sources })}</td>
                  <td className="num">{f.int(x.absent)}</td><td className="num">{f.int(x.isolated.length)}</td><td className="num">{f.dec(x.seconds, 1)}</td>
                  <td>{x.complete ? '✓' : '⚠'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary className="small">{t('x.det.definition')}</summary>
          <pre className="x-pre">{JSON.stringify(r.definition, (key, v) => (key === 'research' ? undefined : v), 1)}</pre>
        </details>
      </section>
      {a && (
        <section className="r-box">
          <h4 className="r-h4">{label(a)}</h4>
          <dl className="kv">
            <div className="kv-row"><dt>{t('x.metric.systemic')}</dt><dd className="mono">{f.dec(a.ref.systemicDrop, 6)}</dd></div>
            <div className="kv-row"><dt>{t('x.metric.spillover')}</dt><dd className="mono">{f.dec(a.ref.spilloverDrop, 6)}</dd></div>
            <div className="kv-row"><dt>{t('x.det.unreachable')}</dt><dd className="mono">{f.int(a.ref.unreachablePairs)}</dd></div>
            <div className="kv-row"><dt>{t('x.det.hops')}</dt><dd className="mono">{[a.ref.hop1Drop, a.ref.hop2Drop, a.ref.hop3Drop].map((v) => f.pct(v, 2)).join(' / ')}</dd></div>
            <div className="kv-row"><dt>{t('x.det.direct')}</dt><dd className="mono">{f.int(a.ref.directLost)}</dd></div>
            <div className="kv-row"><dt>{t('x.det.flights')}</dt><dd className="mono">{f.int(a.ref.flightsLost)}</dd></div>
          </dl>
          <p className="small x-dim">{t('x.det.refNote')}</p>
          <div className="r-table-wrap">
            <table className="r-table r-compact">
              <thead><tr><th>{t('x.col.run')}</th><th className="num">{t(`x.metric.${k}`)}</th><th className="num">{t('x.col.rank')}</th></tr></thead>
              <tbody>{r.runs.map((x, i) => <tr key={x.runId}><td>{x.label}</td><td className="num">{f.dec(a.runs[k][i], 6)}</td><td className="num">{a.runs[rk][i]}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      <section className="r-box">
        <h4 className="r-h4">{t('x.det.export')}</h4>
        <div className="r-buttons">
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_result.json`, JSON.stringify(r), 'application/json')}>{t('x.det.json')}</button>
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_rankings.csv`, rankingsCsv(r))}>{t('x.det.csv')}</button>
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_stats.csv`, statsCsv(r))}>{t('x.det.stats')}</button>
        </div>
      </section>
    </>
  );
}

