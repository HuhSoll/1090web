import { geoEquirectangular, geoPath } from 'd3-geo';
import { useEffect, useMemo, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { DAY } from '../../events/analysis';
import type { RouteChange } from '../../events/changes';
import { areaCountries, useAdvisoryHistory, versionKey, type AdvisoryVersion, type Bulletin, type ValidatedHistory } from '../../events/model';
import { defaultConditions, runStudy, routesCsv, seriesCsv, studyJson, type SeriesId, type StudyConditions, type StudyResult } from '../../events/study';
import { defaultConfig } from '../../research/model';
import { ImpactClient } from '../../simulation/impactClient';
import { useAppStore } from '../../state/store';
import { getTemporalClient, useTemporalMeta, type TemporalMeta } from '../../temporal/useTemporal';
import { SupersededError } from '../../temporal/client';
import type { StaticNetwork } from '../../data/model/network';
import { loadCountryShapes } from './countryShapes';
import { downloadText, useFormat } from './format';

let impactClient: ImpactClient | null = null;
const WINDOWS = [7, 14, 28, 30];

/** Research > Historical events (Phase 9G): EASA advisories and the observed network around them. */
export function EventsPanel() {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network);
  const hist = useAdvisoryHistory();
  const meta = useTemporalMeta(true);
  if (hist.state === 'error') return <div className="r-box r-warn"><h4 className="r-h4">{t('ev.loadError')}</h4><p className="small mono">{hist.message}</p></div>;
  if (meta.state === 'error') return <div className="r-box r-warn"><h4 className="r-h4">{t('ev.loadError')}</h4><p className="small mono">{meta.message}</p></div>;
  if (hist.state === 'loading' || meta.state === 'loading' || !network) return <p className="hint"><span className="spinner" aria-hidden="true" /> {t('ev.loading')}</p>;
  return <EventsLab hist={hist.data} meta={meta.meta} network={network} />;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function EventsLab({ hist, meta, network }: { hist: ValidatedHistory; meta: TemporalMeta; network: StaticNetwork }) {
  const { t } = useI18n();
  const focus = useAppStore((s) => s.eventFocus);
  const setFocus = useAppStore((s) => s.setEventFocus);
  const bulletins = hist.history.bulletins;
  const inData = (v: AdvisoryVersion) => !!v.effectiveDate && v.effectiveDate >= day(meta.range.startMs) && v.effectiveDate < day(meta.range.endMs);
  const [sel, setSel] = useState<{ b: string; r: string }>(() => {
    const st = useAppStore.getState().eventFocus;
    return st ? { b: st.bulletinId, r: st.revisionId } : { b: '2026-03', r: 'R0' };
  });
  useEffect(() => {
    if (focus) setFocus(null);
  }, [focus, setFocus]);
  const bulletin = bulletins.find((b) => b.bulletinId === sel.b) ?? bulletins[0]!;
  const version = bulletin.revisions.find((r) => r.revisionId === sel.r) ?? bulletin.revisions[0]!;
  const [cond, setCond] = useState<StudyConditions>(defaultConditions);
  const [state, setState] = useState<{ status: 'idle' } | { status: 'running'; step: string } | { status: 'done'; result: StudyResult } | { status: 'error'; message: string }>({ status: 'idle' });
  const [hover, setHover] = useState<number | null>(null);

  const run = () => {
    if (!inData(version)) return;
    setState({ status: 'running', step: 'series' });
    impactClient ??= new ImpactClient(8);
    const scope = { network, continentOf: network.airports.map(() => '?'), persistence: null };
    runStudy({ network, index: meta.index, range: meta.range, temporal: getTemporalClient(network), impact: impactClient, scope }, version, cond, (step) => setState({ status: 'running', step }))
      .then((result) => setState({ status: 'done', result }))
      .catch((e: unknown) => { if (!(e instanceof SupersededError)) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }); });
  };
  const result = state.status === 'done' && versionKey(state.result.version) === versionKey(version) ? state.result : null;
  const area = areaCountries(version);

  const toExperiments = (r: StudyResult) => {
    const st = useAppStore.getState();
    const months = network.manifest.months.map((m) => m.month);
    const month = day(r.windows.before.startMs).slice(0, 7);
    const airports = r.changes.airports.filter((a) => a.inArea && a.beforeDaily > 0).slice(0, 30).map((a) => network.airports[a.airport]!.id);
    st.setResearchConfig({
      ...defaultConfig(months.includes(month) ? month : months[months.length - 1]!),
      window: { startMs: r.windows.before.startMs, endMs: r.windows.before.endMs, basis: 'all', preset: 'custom', stepMs: DAY },
      tiers: r.conditions.tiers, minFlights: r.conditions.minFlights, directed: r.conditions.directed,
    });
    st.setExperiment(null);
    st.setExperimentHandoff({ scenarioName: `EASA CZIB ${r.version.czibNumber}`, airports, otherEvents: 0 });
    st.setResearchTab('experiments');
  };

  return (
    <div className="r-stack ev-lab">
      <section className="r-box">
        <h3 className="r-h4">{t('ev.title')}</h3>
        <p className="small x-dim">{t('ev.lead')}</p>
        <div className="i-setup">
          <label className="r-inline"><span className="small">{t('ev.bulletin')}</span>
            <select className="r-input" value={bulletin.bulletinId} onChange={(e) => { const b = bulletins.find((x) => x.bulletinId === e.target.value)!; setSel({ b: b.bulletinId, r: b.revisions[0]!.revisionId }); }}>
              {bulletins.map((b) => <option key={b.bulletinId} value={b.bulletinId}>CZIB {b.bulletinId} — {b.title}</option>)}
            </select>
          </label>
          <label className="r-inline"><span className="small">{t('ev.revision')}</span>
            <select className="r-input" value={version.revisionId} onChange={(e) => setSel({ b: bulletin.bulletinId, r: e.target.value })}>
              {revisionOptions(bulletin).map((o) => <option key={o.id} value={o.id} disabled={!o.version}>{o.version ? `${o.id} — ${o.version.effectiveDate}` : `${o.id} — ${t('ev.notCaptured')}`}</option>)}
            </select>
          </label>
        </div>
        <EventCard v={version} b={bulletin} area={area} inData={inData(version)} recordsVersion={hist.history.recordsVersion} />
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('ev.compare')}</h4>
        <div className="i-setup">
          <div className="segmented" role="group" aria-label={t('ev.window')}>
            {WINDOWS.map((n) => <button key={n} type="button" className={cond.windowDays === n ? 'is-active' : ''} onClick={() => setCond((c0) => ({ ...c0, windowDays: n }))}>{t('ev.days', { n })}</button>)}
          </div>
          <label className="r-inline"><span className="small">{t('ev.custom')}</span>
            <input className="r-input x-narrow" type="number" min={1} max={120} value={cond.windowDays} onChange={(e) => setCond((c0) => ({ ...c0, windowDays: Math.max(1, Math.min(120, Number(e.target.value) || 1)) }))} />
          </label>
          <div className="segmented" role="group" aria-label={t('ev.tiers')}>
            {(['D', 'C'] as const).map((x) => <button key={x} type="button" className={cond.tiers === x ? 'is-active' : ''} onClick={() => setCond((c0) => ({ ...c0, tiers: x }))}>{t(`ev.tiers.${x}`)}</button>)}
          </div>
          <button type="button" className="pill-btn i-run" disabled={!inData(version) || state.status === 'running'} onClick={run}>{t('ev.run')}</button>
        </div>
        {!inData(version) && <p className="hint warn">{t('ev.outOfData', { from: day(meta.range.startMs), to: day(meta.range.endMs - DAY) })}</p>}
        <details className="x-advanced">
          <summary className="small">{t('ev.advanced')}</summary>
          <div className="i-adv">
            <label className="r-inline"><span className="small">{t('ev.buffer')}</span>
              <input className="r-input x-narrow" type="number" min={0} max={7} value={cond.bufferDays} onChange={(e) => setCond((c0) => ({ ...c0, bufferDays: Math.max(0, Math.min(7, Number(e.target.value) || 0)) }))} />
            </label>
            <label className="r-inline"><span className="small">{t('ev.minFlights')}</span>
              <input className="r-input x-narrow" type="number" min={1} max={50} value={cond.minFlights} onChange={(e) => setCond((c0) => ({ ...c0, minFlights: Math.max(1, Number(e.target.value) || 1) }))} />
            </label>
            <label className="r-inline"><input type="checkbox" checked={cond.passengerOnly} onChange={(e) => setCond((c0) => ({ ...c0, passengerOnly: e.target.checked }))} />{t('ev.passengerOnly')}</label>
            <label className="r-inline"><input type="checkbox" checked={cond.excludeGaps} onChange={(e) => setCond((c0) => ({ ...c0, excludeGaps: e.target.checked }))} />{t('ev.excludeGaps')}</label>
            <label className="r-inline"><input type="checkbox" checked={!cond.directed} onChange={(e) => setCond((c0) => ({ ...c0, directed: !e.target.checked }))} />{t('ev.undirected')}</label>
          </div>
          <label className="r-inline ev-codes"><span className="small">{t('ev.neighbours')}</span>
            <input className="r-input" value={cond.neighbours.join(' ')} onChange={(e) => setCond((c0) => ({ ...c0, neighbours: codes(e.target.value) }))} />
          </label>
          <label className="r-inline ev-codes"><span className="small">{t('ev.comparison')}</span>
            <input className="r-input" value={cond.comparison.join(' ')} onChange={(e) => setCond((c0) => ({ ...c0, comparison: codes(e.target.value) }))} />
          </label>
          <p className="small x-dim">{t('ev.groupsNote')}</p>
        </details>
        {state.status === 'running' && <p className="hint"><span className="spinner" aria-hidden="true" /> {t(`ev.step.${state.step}` as MessageKey)}</p>}
        {state.status === 'error' && <p className="hint warn">{state.message}</p>}
        {!result && state.status !== 'running' && inData(version) && <p className="hint">{t('ev.pressRun')}</p>}
      </section>

      {result && (
        <>
          <Summary r={result} />
          <section className="r-box">
            <h4 className="r-h4">{t('ev.timeline')}</h4>
            <Timeline r={result} bulletin={bulletin} onPick={(rid) => setSel({ b: bulletin.bulletinId, r: rid })} />
          </section>
          <section className="r-box">
            <h4 className="r-h4">{t('ev.timing')}</h4>
            <Timing r={result} />
          </section>
          <section className="r-box">
            <h4 className="r-h4">{t('ev.map')}</h4>
            <EventMap r={result} network={network} hover={hover} />
          </section>
          <section className="r-box">
            <h4 className="r-h4">{t('ev.rankings')}</h4>
            <Rankings r={result} network={network} hover={hover} setHover={setHover} />
          </section>
          <section className="r-box">
            <h4 className="r-h4">{t('ev.counterfactual')}</h4>
            <Counterfactual r={result} />
          </section>
          <section className="r-box">
            <h4 className="r-h4">{t('ev.export')}</h4>
            <div className="r-buttons">
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${result.version.czibNumber}_study.json`, studyJson(result, hist.history.recordsVersion, { id: meta.index.datasetId, version: meta.index.datasetVersion }), 'application/json')}>{t('ev.json')}</button>
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${result.version.czibNumber}_daily.csv`, seriesCsv(result))}>{t('ev.csvSeries')}</button>
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${result.version.czibNumber}_routes.csv`, routesCsv(result, network))}>{t('ev.csvRoutes')}</button>
              <button type="button" className="pill-btn" onClick={() => toExperiments(result)}>{t('ev.toExperiments')}</button>
            </div>
            <p className="small x-dim">{t('ev.exportNote', { v: hist.history.recordsVersion })}</p>
          </section>
        </>
      )}

      <details className="r-box">
        <summary className="r-h4">{t('ev.sources')}</summary>
        <Sources hist={hist} />
      </details>
    </div>
  );
}

function codes(s: string): string[] {
  return [...new Set(s.toUpperCase().split(/[^A-Z]+/).filter((x) => x.length === 2))];
}

function revisionOptions(b: Bulletin): { id: string; version: AdvisoryVersion | null }[] {
  const max = Number(b.latestKnownRevision.slice(1));
  return Array.from({ length: max + 1 }, (_, i) => ({ id: `R${i}`, version: b.revisions.find((r) => r.revisionId === `R${i}`) ?? null }));
}

function EventCard({ v, b, area, inData, recordsVersion }: { v: AdvisoryVersion; b: Bulletin; area: ReturnType<typeof areaCountries>; inData: boolean; recordsVersion: string }) {
  const { t } = useI18n();
  return (
    <div className="ev-card">
      <div className="kv-row"><span>{t('ev.k.name')}</span><span><strong>{v.title}</strong> <span className="badge info-badge">CZIB {v.czibNumber}</span> <span className="badge">{t('ev.kind')}</span></span></div>
      <div className="kv-row"><span>{t('ev.k.dates')}</span><span className="mono small">{t('ev.dates', { issue: v.issueDate ?? '—', rev: v.revisionDate ?? '—', until: v.validUntil ?? '—', seen: v.firstSeenAt.replace('T', ' ').slice(0, 16) })}</span></div>
      <div className="kv-row"><span>{t('ev.k.area')}</span><span>{area.iso2.join(', ') || '—'} <span className="small x-dim">({t(`ev.areaBasis.${area.basis}`)})</span><br /><span className="small x-dim">{t('ev.firs')}: {v.firs.join(', ') || '—'}</span></span></div>
      <div className="kv-row"><span>{t('ev.k.type')}</span><span>{v.recommendationType.map((x) => t(`ev.rec.${x}` as MessageKey)).join('・')}</span></div>
      <div className="kv-row"><span>{t('ev.k.source')}</span><span><a href={v.sourceUrl} target="_blank" rel="noreferrer">{v.sourceUrl.replace('https://', '')}</a> <span className="small x-dim">{t(`ev.verify.${v.verificationStatus}` as MessageKey)}</span></span></div>
      {v.revisionDescription && <p className="small">{v.revisionDescription}</p>}
      <ul className="r-mini">
        <li>{t('ev.notClosure')}</li>
        {!b.historyComplete && <li className="r-warn-text">{t('ev.incomplete', { missing: b.missingRevisions.join(', ') })}</li>}
        {area.basis === 'airspaceText' && <li>{t('ev.areaFromText')}</li>}
        {!inData && <li className="r-warn-text">{t('ev.notInData')}</li>}
        <li className="x-dim">{t('ev.recordsVersion', { v: recordsVersion })}</li>
      </ul>
    </div>
  );
}

function pct(v: number | null, f: ReturnType<typeof useFormat>) {
  return v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${f.dec(v * 100, 1)}%`;
}

function Summary({ r }: { r: StudyResult }) {
  const { t } = useI18n();
  const f = useFormat();
  const w = r.windows;
  const row = (id: SeriesId) => r.beforeAfter[id];
  const a = r.changes.classes.find((c) => c.cls === 'A')!;
  const b = r.changes.classes.find((c) => c.cls === 'B')!;
  return (
    <section className="r-box">
      <h4 className="r-h4">{t('ev.summary')}</h4>
      <p className="small mono">{t('ev.windowsLine', { b0: day(w.before.startMs), b1: day(w.before.endMs - DAY), e: day(w.eventDayMs), a0: day(w.after.startMs), a1: day(w.after.endMs - DAY), n: w.length })}</p>
      <div className="stats r-stats">
        {(['area', 'within', 'cross', 'neighbours', 'comparison', 'world'] as SeriesId[]).map((id) => (
          <div key={id} className="stat">
            <span className="stat-label">{t(`ev.s.${id}` as MessageKey)}</span>
            <span className="stat-value">{pct(row(id).change, f)}</span>
            <span className="small x-dim">{t('ev.perDay', { b: f.dec(row(id).beforeMean, 0), a: f.dec(row(id).afterMean, 0) })}</span>
          </div>
        ))}
        <div className="stat"><span className="stat-label">{t('ev.routesAB')}</span><span className="stat-value">{f.int(a.routesBefore + b.routesBefore)} → {f.int(a.routesAfter + b.routesAfter)}</span><span className="small x-dim">{t('ev.routesNote', { only: f.int(a.onlyAfter + b.onlyAfter), not: f.int(a.notAfter + b.notAfter) })}</span></div>
        <div className="stat"><span className="stat-label">{t('ev.airportsObs')}</span><span className="stat-value">{f.int(r.changes.airportsObserved.before)} → {f.int(r.changes.airportsObserved.after)}</span></div>
      </div>
      {r.warnings.length > 0 && (
        <ul className="r-mini r-warn-text">{r.warnings.map((x) => <li key={x}>{t(`ev.w.${x}` as MessageKey, { b: f.pct(r.t4Share.before, 0), a: f.pct(r.t4Share.after, 0) })}</li>)}</ul>
      )}
      <p className="small x-dim">{t('ev.observedNote')}</p>
    </section>
  );
}

// ---- timeline (daily series, advisory versions, windows, gaps) -------------------------------

function Timeline({ r, bulletin, onPick }: { r: StudyResult; bulletin: Bulletin; onPick: (rid: string) => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const [mode, setMode] = useState<'index' | 'abs'>('index');
  const W = 720;
  const H = 240;
  const n = r.series.flights.area.length;
  const x = (ms: number) => 40 + ((ms - r.series.startMs) / (n * DAY)) * (W - 50);
  const ids: SeriesId[] = ['area', 'neighbours', 'comparison'];
  const base = (id: SeriesId) => r.beforeAfter[id].beforeMean || 1;
  const val = (id: SeriesId, i: number) => (mode === 'index' ? (r.series.flights[id][i]! / base(id)) * 100 : r.series.flights[id][i]!);
  const max = Math.max(1, ...ids.flatMap((id) => r.series.flights[id].map((_, i) => val(id, i))));
  const y = (v: number) => H - 24 - (v / max) * (H - 40);
  const colors: Record<string, string> = { area: '#ff6147', neighbours: '#ffd27a', comparison: '#7fd6ff' };
  const gaps = new Set(r.gapDays);
  const end = r.series.startMs + n * DAY;
  return (
    <>
      <div className="segmented" role="group" aria-label={t('ev.timeline')}>
        {(['index', 'abs'] as const).map((m) => <button key={m} type="button" className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)}>{t(`ev.tl.${m}`)}</button>)}
      </div>
      <svg className="x-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('ev.timeline')}>
        <rect x={x(r.windows.before.startMs)} y={10} width={x(r.windows.before.endMs) - x(r.windows.before.startMs)} height={H - 34} className="ev-win ev-win-before" />
        <rect x={x(r.windows.after.startMs)} y={10} width={x(r.windows.after.endMs) - x(r.windows.after.startMs)} height={H - 34} className="ev-win ev-win-after" />
        {[...gaps].filter((g) => g >= r.series.startMs && g < end).map((g) => <rect key={g} x={x(g)} y={10} width={Math.max(2, x(g + DAY) - x(g))} height={H - 34} className="tl-gap ev-gap"><title>{t('ev.gapDay', { d: day(g) })}</title></rect>)}
        {bulletin.revisions.filter((v) => v.effectiveDate).map((v) => {
          const ms = Date.parse(`${v.effectiveDate}T00:00:00Z`);
          if (ms < r.series.startMs || ms >= end) return null;
          const on = v.revisionId === r.version.revisionId;
          return (
            <g key={v.revisionId} className={on ? 'ev-rev is-on' : 'ev-rev'} onClick={() => onPick(v.revisionId)}>
              <line x1={x(ms)} x2={x(ms)} y1={10} y2={H - 24} />
              <text x={x(ms) + 2} y={20} className="x-label">{v.revisionId}</text>
              <title>{`CZIB ${v.czibNumber} — ${v.effectiveDate}${v.validUntil ? ` → ${v.validUntil}` : ''}`}</title>
            </g>
          );
        })}
        {ids.map((id) => (
          <polyline key={id} fill="none" stroke={colors[id]} strokeWidth={id === 'area' ? 2 : 1.4}
            points={r.series.flights[id].map((_, i) => `${x(r.series.startMs + i * DAY + DAY / 2).toFixed(1)},${y(val(id, i)).toFixed(1)}`).join(' ')} />
        ))}
        <line x1={40} x2={W - 10} y1={H - 24} y2={H - 24} className="x-axis" />
        {Array.from({ length: Math.ceil(n / 14) }, (_, k) => r.series.startMs + k * 14 * DAY).map((ms) => <text key={ms} x={x(ms)} y={H - 8} className="x-label">{day(ms).slice(5)}</text>)}
        {[0, 0.5, 1].map((q) => <text key={q} x={36} y={y(max * q) + 4} textAnchor="end" className="x-label">{f.int(max * q)}</text>)}
      </svg>
      <div className="legend i-legend">
        {ids.map((id) => <span key={id} className="legend-item"><span className="i-swatch" style={{ background: colors[id] }} />{t(`ev.s.${id}` as MessageKey)}</span>)}
        <span className="legend-item"><span className="i-swatch ev-sw-before" />{t('ev.before')}</span>
        <span className="legend-item"><span className="i-swatch ev-sw-after" />{t('ev.after')}</span>
        <span className="legend-item"><span className="i-swatch ev-sw-gap" />{t('ev.gap')}</span>
        <span className="legend-item"><span className="i-swatch ev-sw-rev" />{t('ev.revLine')}</span>
      </div>
      <p className="small x-dim">{t(mode === 'index' ? 'ev.tl.indexNote' : 'ev.tl.absNote')} {t('ev.tl.utc')}</p>
    </>
  );
}

function Timing({ r }: { r: StudyResult }) {
  const { t } = useI18n();
  const f = useFormat();
  const tr = (x: StudyResult['ratioPreTrend']) => (x ? t('ev.trendCell', { c: pct(x.impliedChange, f), tv: f.dec(x.t, 2) }) : t('ev.tooFew'));
  const pl = r.placebo;
  return (
    <>
      <table className="r-table r-compact">
        <thead><tr><th>{t('ev.col.series')}</th><th className="num">{t('ev.col.preTrend')}</th><th className="num">{t('ev.col.change')}</th></tr></thead>
        <tbody>
          {(['area', 'neighbours', 'comparison'] as const).map((id) => <tr key={id}><td>{t(`ev.s.${id}`)}</td><td className="num">{tr(r.preTrend[id])}</td><td className="num">{pct(r.beforeAfter[id].change, f)}</td></tr>)}
          <tr><td>{t('ev.ratio')}</td><td className="num">{tr(r.ratioPreTrend)}</td><td className="num">—</td></tr>
        </tbody>
      </table>
      <p className="small x-dim">{t('ev.preTrendNote')}</p>
      <h4 className="small">{t('ev.placebo')}</h4>
      <p className="small">{pl.placebos.length ? t('ev.placeboLine', { n: pl.placebos.length, share: f.pct(pl.shareAsLarge ?? 0, 0), a: pct(Math.exp(pl.actual) - 1, f), max: pct(Math.exp(Math.max(...pl.placebos.map((p) => Math.abs(p.logChange)))) - 1, f) }) : t('ev.placeboNone')}</p>
      <p className="small x-dim">{pl.placebos.map((p) => `${day(p.dayMs)} ${pct(Math.exp(p.logChange) - 1, f)}`).join(' · ')}</p>
      <h4 className="small">{t('ev.did')}</h4>
      {r.did.estimate !== null
        ? <p className="small">{t('ev.didValue', { v: pct(Math.exp(r.did.estimate) - 1, f) })}</p>
        : <p className="small">{t('ev.didNone', { v: pct(Math.exp(r.did.logDifference) - 1, f) })}</p>}
      <ul className="r-mini">{r.did.conditions.map((c) => <li key={c.id} className={c.ok ? '' : 'r-warn-text'}>{c.ok ? '✓' : '×'} {t(`ev.cond.${c.id}` as MessageKey)}: {c.detail}</li>)}</ul>
      <p className="small x-dim">{t('ev.causalNote')}</p>
    </>
  );
}

// ---- map --------------------------------------------------------------------------------------

const CHANGE_COLOR: Record<RouteChange | 'hypo', string> = { down: '#ffd27a', up: '#7fd6ff', notAfter: '#ff6147', onlyAfter: '#b8ecff', stable: 'rgba(129,147,168,0.4)', hypo: '#f2b45a' };

function EventMap({ r, network, hover }: { r: StudyResult; network: StaticNetwork; hover: number | null }) {
  const { t } = useI18n();
  const f = useFormat();
  const [shapes, setShapes] = useState<FeatureCollection | null>(null);
  const [layer, setLayer] = useState<'observed' | 'hypothetical'>('observed');
  useEffect(() => { let a = true; loadCountryShapes().then((s) => a && setShapes(s)).catch(() => undefined); return () => { a = false; }; }, []);
  const W = 720;
  const H = 400;
  const areaSet = new Set(r.area.countries);
  const areaAps = network.airports.map((a, i) => (areaSet.has(a.country) ? i : -1)).filter((i) => i >= 0);
  // Impact focus: only routes that changed (or, for the scenario, that would be lost), the largest first
  const shown = r.changes.routes.filter((x) => (layer === 'observed' ? x.change !== 'stable' : x.cls === 'A' || x.cls === 'B') && x.beforeDaily + x.afterDaily > 0).slice(0, 250);
  const proj = useMemo(() => {
    const pts = (shown.length ? shown.flatMap((x) => [network.airports[x.a]!, network.airports[x.b]!]) : areaAps.map((i) => network.airports[i]!));
    const lon = pts.map((p) => p.lon);
    const lat = pts.map((p) => p.lat);
    const box: FeatureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[Math.min(...lon) - 3, Math.min(...lat) - 3], [Math.max(...lon) + 3, Math.max(...lat) + 3]] } }] };
    return geoEquirectangular().fitExtent([[10, 10], [W - 10, H - 10]], box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, layer]);
  const path = useMemo(() => (shapes ? geoPath(proj)(shapes) ?? '' : ''), [shapes, proj]);
  const xy = (i: number) => proj([network.airports[i]!.lon, network.airports[i]!.lat]) ?? [0, 0];
  const counts = new Map<string, number>();
  for (const x of shown) counts.set(layer === 'observed' ? x.change : 'hypo', (counts.get(layer === 'observed' ? x.change : 'hypo') ?? 0) + 1);
  return (
    <>
      <div className="segmented" role="group" aria-label={t('ev.map')}>
        {(['observed', 'hypothetical'] as const).map((l) => <button key={l} type="button" className={layer === l ? 'is-active' : ''} onClick={() => setLayer(l)}>{t(`ev.map.${l}`)}</button>)}
      </div>
      <svg className="x-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('ev.map')}>
        <rect x={0} y={0} width={W} height={H} className="x-map-bg" />
        {path && <path d={path} className="x-land" />}
        {shown.map((x) => {
          const [x1, y1] = xy(x.a);
          const [x2, y2] = xy(x.b);
          const c = layer === 'observed' ? CHANGE_COLOR[x.change] : CHANGE_COLOR.hypo;
          const hl = hover === x.a || hover === x.b;
          return <line key={x.route} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={hl ? 2.4 : 1 + Math.min(2, Math.max(x.beforeDaily, x.afterDaily) / 10)} strokeOpacity={hover !== null && !hl ? 0.2 : 0.8} strokeDasharray={layer === 'hypothetical' || x.change === 'notAfter' ? '4 3' : undefined}><title>{`${code(network, x.a)}–${code(network, x.b)}: ${f.dec(x.beforeDaily, 1)} → ${f.dec(x.afterDaily, 1)} / ${t('ev.day')}`}</title></line>;
        })}
        {areaAps.map((i) => { const [px, py] = xy(i); return <circle key={i} cx={px} cy={py} r={hover === i ? 4.5 : 2.6} className="ev-ap-area"><title>{code(network, i)}</title></circle>; })}
      </svg>
      <div className="legend i-legend">
        <span className="legend-item"><span className="i-swatch ev-sw-area" />{t('ev.lg.area', { n: f.int(areaAps.length) })}</span>
        {layer === 'observed'
          ? (['down', 'notAfter', 'up', 'onlyAfter'] as const).map((k) => <span key={k} className="legend-item"><span className="i-swatch" style={{ background: CHANGE_COLOR[k] }} />{t(`ev.ch.${k}`)} ({f.int(counts.get(k) ?? 0)})</span>)
          : <span className="legend-item"><span className="i-swatch" style={{ background: CHANGE_COLOR.hypo }} />{t('ev.ch.hypo')} ({f.int(counts.get('hypo') ?? 0)})</span>}
      </div>
      <p className="small x-dim">{t('ev.mapNote', { n: shown.length })}</p>
    </>
  );
}

const code = (network: StaticNetwork, i: number) => network.airports[i]!.iata || network.airports[i]!.id;

function Rankings({ r, network, hover, setHover }: { r: StudyResult; network: StaticNetwork; hover: number | null; setHover: (i: number | null) => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const [tab, setTab] = useState<'airports' | 'routes' | 'carriers'>('airports');
  return (
    <>
      <div className="segmented" role="group" aria-label={t('ev.rankings')}>
        {(['airports', 'routes', 'carriers'] as const).map((k) => <button key={k} type="button" className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{t(`ev.rk.${k}`)}</button>)}
      </div>
      <div className="r-table-wrap">
        {tab === 'airports' && (
          <table className="r-table r-compact">
            <thead><tr><th>{t('ev.col.airport')}</th><th>{t('ev.col.group')}</th><th className="num">{t('ev.col.before')}</th><th className="num">{t('ev.col.after')}</th><th className="num">{t('ev.col.change')}</th><th className="num">{t('ev.col.partners')}</th></tr></thead>
            <tbody>{r.changes.airports.slice(0, 40).map((a) => (
              <tr key={a.airport} className={hover === a.airport ? 'is-selected' : ''} onMouseEnter={() => setHover(a.airport)} onMouseLeave={() => setHover(null)}>
                <td>{code(network, a.airport)} <span className="small x-dim">{network.airports[a.airport]!.country}</span></td>
                <td>{t(a.inArea ? 'ev.g.area' : 'ev.g.neighbour')}</td>
                <td className="num">{f.dec(a.beforeDaily, 1)}</td><td className="num">{f.dec(a.afterDaily, 1)}</td>
                <td className="num">{pct(a.beforeDaily ? a.afterDaily / a.beforeDaily - 1 : null, f)}</td>
                <td className="num">{f.int(a.partnersBefore)} → {f.int(a.partnersAfter)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {tab === 'routes' && (
          <table className="r-table r-compact">
            <thead><tr><th>{t('ev.col.route')}</th><th>{t('ev.col.class')}</th><th className="num">{t('ev.col.before')}</th><th className="num">{t('ev.col.after')}</th><th>{t('ev.col.observed')}</th></tr></thead>
            <tbody>{r.changes.routes.slice(0, 40).map((x) => (
              <tr key={x.route} onMouseEnter={() => setHover(x.a)} onMouseLeave={() => setHover(null)}>
                <td>{code(network, x.a)}–{code(network, x.b)}</td><td>{t(`ev.cls.${x.cls}` as MessageKey)}</td>
                <td className="num">{f.dec(x.beforeDaily, 1)}</td><td className="num">{f.dec(x.afterDaily, 1)}</td><td>{t(`ev.ch.${x.change}`)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {tab === 'carriers' && (
          <table className="r-table r-compact">
            <thead><tr><th>{t('ev.col.carrier')}</th><th className="num">{t('ev.col.before')}</th><th className="num">{t('ev.col.after')}</th><th className="num">{t('ev.col.change')}</th></tr></thead>
            <tbody>{r.changes.carriers.slice(0, 30).map((c) => (
              <tr key={c.carrier}><td className="mono">{network.carriers[c.carrier]?.id ?? c.carrier}</td><td className="num">{f.dec(c.beforeDaily, 1)}</td><td className="num">{f.dec(c.afterDaily, 1)}</td><td className="num">{pct(c.beforeDaily ? c.afterDaily / c.beforeDaily - 1 : null, f)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="small x-dim">{t('ev.rankNote')}</p>
    </>
  );
}

function Counterfactual({ r }: { r: StudyResult }) {
  const { t } = useI18n();
  const f = useFormat();
  if (!r.impact) return <p className="small x-dim">{t('ev.cf.none')}</p>;
  const { observed: o, observedArea: oa, hypothetical: h } = r.impact;
  const rows: [MessageKey, number, number, number, number, (v: number) => string][] = [
    ['ev.cf.edges', o.edges.before, o.edges.after, oa.edges.after, h.edges.after, f.int],
    ['ev.cf.nodes', o.connectedNodes.before, o.connectedNodes.after, oa.connectedNodes.after, h.connectedNodes.after, f.int],
    ['ev.cf.eff', o.total.before.efficiency, o.total.after.efficiency, oa.total.after.efficiency, h.total.after.efficiency, (v) => f.dec(v, 4)],
    ['ev.cf.spillEff', o.spillover.before.efficiency, o.spillover.after.efficiency, oa.spillover.after.efficiency, h.spillover.after.efficiency, (v) => f.dec(v, 4)],
    ['ev.cf.reach', o.spillover.before.reachable, o.spillover.after.reachable, oa.spillover.after.reachable, h.spillover.after.reachable, f.int],
  ];
  return (
    <>
      <table className="r-table r-compact">
        <thead><tr><th>{t('ev.cf.metric')}</th><th className="num">{t('ev.cf.obsBefore')}</th><th className="num">{t('ev.cf.obsAfter')}</th><th className="num">{t('ev.cf.obsArea')}</th><th className="num">{t('ev.cf.hypAfter')}</th></tr></thead>
        <tbody>{rows.map(([k, b0, a1, a2, a3, fmt]) => <tr key={k}><td>{t(k)}</td><td className="num">{fmt(b0)}</td><td className="num">{fmt(a1)}</td><td className="num">{fmt(a2)}</td><td className="num">{fmt(a3)}</td></tr>)}
          <tr><td>{t('ev.cf.lost')}</td><td className="num">—</td><td className="num">{f.int(o.lostPairs.total)}</td><td className="num">{f.int(oa.lostPairs.total)}</td><td className="num">{f.int(h.lostPairs.total)}</td></tr>
        </tbody>
      </table>
      <p className="small x-dim">{t('ev.cf.note', { n: f.int(r.impact.targets.length), nodes: f.int(r.impact.nodes) })}</p>
    </>
  );
}

function Sources({ hist }: { hist: ValidatedHistory }) {
  const { t } = useI18n();
  const h = hist.history;
  return (
    <>
      <p className="small">{h.meaning}</p>
      <p className="small">{t('ev.src.line', { name: h.source.name, v: h.recordsVersion, at: h.generatedAt.slice(0, 10) })} <a href={h.source.url} target="_blank" rel="noreferrer">{h.source.url.replace('https://', '')}</a> — {h.source.licence}</p>
      <p className="small x-dim">{h.source.archive}</p>
      <table className="r-table r-compact">
        <thead><tr><th>CZIB</th><th>{t('ev.src.title')}</th><th>{t('ev.src.revisions')}</th><th>{t('ev.src.missing')}</th></tr></thead>
        <tbody>{h.bulletins.map((b) => <tr key={b.bulletinId}><td className="mono">{b.bulletinId}</td><td>{b.title}</td><td className="small">{b.revisions.map((r) => `${r.revisionId} (${r.effectiveDate})`).join(', ')}</td><td className="small">{b.missingRevisions.join(', ') || '—'}</td></tr>)}</tbody>
      </table>
      {hist.dropped.length > 0 && <p className="small r-warn-text">{t('ev.src.dropped', { n: hist.dropped.length })}</p>}
      <ul className="r-mini">
        <li>{t('ev.lim.firs')}</li>
        <li>{t('ev.lim.paths')}</li>
        <li>{t('ev.lim.dates')}</li>
        <li>{t('ev.lim.external')}</li>
      </ul>
    </>
  );
}
