import { geoEquirectangular, geoPath } from 'd3-geo';
import { useEffect, useMemo, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { DAY } from '../../events/analysis';
import type { RouteChange } from '../../events/changes';
import { areaCountries, type AdvisoryVersion, type Bulletin, type ValidatedHistory } from '../../events/model';
import {
  endMs, EVENT_TYPES, eventsInWindow, filterEvents, layerOf, overlaps, spanOf, stackRows, startSpan, STATUSES, timeConflicts, useEvents,
  type EventFilter, type Layer, type Registry, type TimeValue, type UnifiedEvent,
} from '../../events/registry';
import { defaultConditions, runStudy, routesCsv, seriesCsv, studyJson, subjectOf, type SeriesId, type StudyConditions, type StudyResult } from '../../events/study';
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
/** results of finished studies, by subject and conditions (a study takes 5-15 s) */
const studyCache = new Map<string, StudyResult>();

/** Research > Historical events (Phases 9G, 9H): real events, their sources, and the observed network around them. */
export function EventsPanel() {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network);
  const ev = useEvents();
  const meta = useTemporalMeta(true);
  if (ev.state === 'error') return <div className="r-box r-warn"><h4 className="r-h4">{t('ev.loadError')}</h4><p className="small mono">{ev.message}</p></div>;
  if (meta.state === 'error') return <div className="r-box r-warn"><h4 className="r-h4">{t('ev.loadError')}</h4><p className="small mono">{meta.message}</p></div>;
  if (ev.state === 'loading' || meta.state === 'loading' || !network) return <p className="hint"><span className="spinner" aria-hidden="true" /> {t('ev.loading')}</p>;
  return <EventsLab data={ev} meta={meta.meta} network={network} />;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const D0 = Date.UTC(2026, 1, 20);
const D1 = Date.UTC(2026, 2, 21);

type Data = { registry: Registry; czib: ValidatedHistory; events: UnifiedEvent[] };

function EventsLab({ data, meta, network }: { data: Data; meta: TemporalMeta; network: StaticNetwork }) {
  const { t } = useI18n();
  const hist = data.czib;
  const all = data.events;
  const byId = useMemo(() => new Map(all.map((e) => [e.eventId, e])), [all]);
  const setFocus = useAppStore((s) => s.setEventFocus);
  // an event picked on the scenario timeline opens here (read once when the panel opens)
  const [selId, setSelId] = useState<string>(() => useAppStore.getState().eventFocus?.eventId ?? 'CZIB:2026-03/R0');
  useEffect(() => {
    if (useAppStore.getState().eventFocus) setFocus(null);
  }, [setFocus]);
  const [filter, setFilter] = useState<EventFilter>(() => {
    const e = byId.get(useAppStore.getState().eventFocus?.eventId ?? '');
    const s = e ? startSpan(e) : null;
    return { startMs: s ? s.startMs - 8 * DAY : D0, endMs: s ? s.startMs + 21 * DAY : D1, types: [...EVENT_TYPES], statuses: [...STATUSES], places: [], text: '' };
  });
  const listed = useMemo(() => filterEvents(all, filter), [all, filter]);
  const event = byId.get(selId) ?? listed[0] ?? all[0]!;
  const bulletin = event.czib ? hist.history.bulletins.find((b) => b.bulletinId === event.czib!.bulletinId) ?? null : null;
  const version = bulletin && event.czib ? bulletin.revisions.find((r) => r.revisionId === event.czib!.revisionId) ?? null : null;
  const subject = subjectOf(event, version);
  const inData = !!subject && subject.effectiveDate >= day(meta.range.startMs) && subject.effectiveDate < day(meta.range.endMs);
  const [cond, setCond] = useState<StudyConditions>(defaultConditions);
  const [state, setState] = useState<{ status: 'idle' } | { status: 'running'; step: string } | { status: 'done'; result: StudyResult } | { status: 'error'; message: string }>({ status: 'idle' });
  const [hover, setHover] = useState<number | null>(null);
  const select = (id: string) => setSelId(id);

  const run = () => {
    if (!subject || !inData) return;
    const key = `${subject.key}|${JSON.stringify(cond)}`;
    const hit = studyCache.get(key);
    if (hit) { setState({ status: 'done', result: hit }); return; }
    setState({ status: 'running', step: 'series' });
    impactClient ??= new ImpactClient(8);
    const scope = { network, continentOf: network.airports.map(() => '?'), persistence: null };
    runStudy({ network, index: meta.index, range: meta.range, temporal: getTemporalClient(network), impact: impactClient, scope }, subject, cond, (step) => setState({ status: 'running', step }))
      .then((result) => { studyCache.set(key, result); setState({ status: 'done', result }); })
      .catch((e: unknown) => { if (!(e instanceof SupersededError)) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }); });
  };
  const result = state.status === 'done' && subject && state.result.subject.key === subject.key ? state.result : null;
  const label = result?.version?.czibNumber ?? result?.subject.event.eventId.replace(/[^A-Za-z0-9-]/g, '_') ?? '';

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
    st.setExperimentHandoff({ scenarioName: r.subject.label, airports, otherEvents: 0 });
    st.setResearchTab('experiments');
  };

  return (
    <div className="r-stack ev-lab">
      <section className="r-box">
        <h3 className="r-h4">{t('ei.title')}</h3>
        <p className="small x-dim">{t('ei.lead')}</p>
        <Filters filter={filter} setFilter={setFilter} count={listed.length} total={all.length} />
        <UnifiedTimeline events={listed} period={{ startMs: filter.startMs, endMs: filter.endMs }} selectedId={event.eventId} onSelect={select} result={result} />
        <EventList events={listed} selectedId={event.eventId} onSelect={select} />
      </section>

      <section className="r-box">
        <EventDetail e={event} all={all} onSelect={select} />
        {bulletin && version && (
          <>
            <div className="i-setup">
              <label className="r-inline"><span className="small">{t('ev.revision')}</span>
                <select className="r-input" value={version.revisionId} onChange={(e) => select(`CZIB:${bulletin.bulletinId}/${e.target.value}`)}>
                  {revisionOptions(bulletin).map((o) => <option key={o.id} value={o.id} disabled={!o.version}>{o.version ? `${o.id} — ${o.version.effectiveDate}` : `${o.id} — ${t('ev.notCaptured')}`}</option>)}
                </select>
              </label>
            </div>
            <EventCard v={version} b={bulletin} area={areaCountries(version)} inData={inData} recordsVersion={hist.history.recordsVersion} />
          </>
        )}
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('ev.compare')}</h4>
        {subject ? <p className="small">{t('ei.comparing', { label: subject.label, day: subject.effectiveDate, area: subject.area.iso2.join(', ') || '—' })}{subject.dayBasis === 'date' ? ` ${t('ei.dayFromDate')}` : ` ${t('ei.dayFromInstant')}`}</p> : <p className="hint warn">{t('ei.noDate')}</p>}
        {subject && !subject.area.iso2.length && <p className="hint warn">{t('ei.noArea')}</p>}
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
          <button type="button" className="pill-btn i-run" disabled={!inData || !subject?.area.iso2.length || state.status === 'running'} onClick={run}>{t('ev.run')}</button>
        </div>
        {subject && !inData && <p className="hint warn">{t('ev.outOfData', { from: day(meta.range.startMs), to: day(meta.range.endMs - DAY) })}</p>}
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
        {!result && state.status !== 'running' && inData && <p className="hint">{t('ev.pressRun')}</p>}
      </section>

      {result && (
        <>
          <Summary r={result} />
          <WindowEvents r={result} all={all} onSelect={select} />
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
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${label}_study.json`, studyJson(result, `${hist.history.recordsVersion}+${data.registry.registryVersion}`, { id: meta.index.datasetId, version: meta.index.datasetVersion }), 'application/json')}>{t('ev.json')}</button>
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${label}_daily.csv`, seriesCsv(result))}>{t('ev.csvSeries')}</button>
              <button type="button" className="pill-btn" onClick={() => downloadText(`event_${label}_routes.csv`, routesCsv(result, network))}>{t('ev.csvRoutes')}</button>
              <button type="button" className="pill-btn" onClick={() => downloadText(`events_${day(filter.startMs)}_${day(filter.endMs)}.csv`, eventsCsv(listed))}>{t('ei.csvEvents')}</button>
              <button type="button" className="pill-btn" onClick={() => toExperiments(result)}>{t('ev.toExperiments')}</button>
            </div>
            <p className="small x-dim">{t('ev.exportNote', { v: `${hist.history.recordsVersion} / ${data.registry.registryVersion}` })}</p>
          </section>
        </>
      )}

      <details className="r-box">
        <summary className="r-h4">{t('ev.sources')}</summary>
        <Sources hist={hist} />
        <RegistrySources registry={data.registry} />
      </details>
    </div>
  );
}

// ---- Event Intelligence (Phase 9H) ------------------------------------------------------------

const TYPE_COLOR: Record<string, string> = {
  SECURITY_INCIDENT: '#ff6147', OTHER_VERIFIED_EVENT: '#c49cff', AIRSPACE_CLOSURE: '#ffd27a', AIRSPACE_RESTRICTION: '#f2b45a',
  AIRPORT_CLOSURE: '#ff9f6b', AIRSPACE_REOPENING: '#8fe3a8', SAFETY_ADVISORY: '#7fd6ff',
};

function Filters({ filter, setFilter, count, total }: { filter: EventFilter; setFilter: (f: EventFilter) => void; count: number; total: number }) {
  const { t } = useI18n();
  const toMs = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const toggle = <T,>(arr: T[], x: T) => (arr.includes(x) ? arr.filter((y) => y !== x) : [...arr, x]);
  return (
    <div className="ei-filters">
      <div className="i-setup">
        <label className="r-inline"><span className="small">{t('ei.from')}</span>
          <input className="r-input" type="date" value={day(filter.startMs)} onChange={(e) => { const v = toMs(e.target.value); if (Number.isFinite(v)) setFilter({ ...filter, startMs: v }); }} />
        </label>
        <label className="r-inline"><span className="small">{t('ei.to')}</span>
          <input className="r-input" type="date" value={day(filter.endMs - DAY)} onChange={(e) => { const v = toMs(e.target.value); if (Number.isFinite(v)) setFilter({ ...filter, endMs: v + DAY }); }} />
        </label>
        <label className="r-inline"><span className="small">{t('ei.place')}</span>
          <input className="r-input x-narrow" placeholder="QA OTDF OTHH" value={filter.places.join(' ')} onChange={(e) => setFilter({ ...filter, places: [...new Set(e.target.value.toUpperCase().split(/[^A-Z]+/).filter((x) => x.length === 2 || x.length === 4))] })} />
        </label>
        <label className="r-inline"><span className="small">{t('ei.search')}</span>
          <input className="r-input x-narrow" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
        </label>
        <span className="small x-dim">{t('ei.count', { n: count, total })}</span>
      </div>
      <div className="i-adv">
        {EVENT_TYPES.map((k) => (
          <label key={k} className="r-inline small"><input type="checkbox" checked={filter.types.includes(k)} onChange={() => setFilter({ ...filter, types: toggle(filter.types, k) })} />
            <span><span className="i-swatch" style={{ background: TYPE_COLOR[k] }} />{t(`ei.type.${k}` as MessageKey)}</span></label>
        ))}
      </div>
      <div className="i-adv">
        {STATUSES.map((k) => (
          <label key={k} className="r-inline small"><input type="checkbox" checked={filter.statuses.includes(k)} onChange={() => setFilter({ ...filter, statuses: toggle(filter.statuses, k) })} />{t(`ei.status.${k}` as MessageKey)}</label>
        ))}
      </div>
    </div>
  );
}

const LAYERS: Layer[] = ['A', 'B', 'C'];

/** Layers A-C (real events), D (observed flights, once a comparison has run), E (scenario of the simulation). */
function UnifiedTimeline({ events, period, selectedId, onSelect, result }: {
  events: UnifiedEvent[]; period: { startMs: number; endMs: number }; selectedId: string; onSelect: (id: string) => void; result: StudyResult | null;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const scenario = useAppStore((s) => s.simScenario);
  const [on, setOn] = useState<Record<Layer | 'D' | 'E', boolean>>({ A: true, B: true, C: true, D: true, E: true });
  const W = 760;
  const L = 110;
  const ROW = 13;
  const span = Math.max(DAY, period.endMs - period.startMs);
  const x = (ms: number) => L + ((Math.min(Math.max(ms, period.startMs), period.endMs) - period.startMs) / span) * (W - L - 10);
  // items per layer, stacked so that overlapping events never share a row
  const items = events.map((e) => {
    const s = startSpan(e);
    if (!s) return null;
    const end = endMs(e);
    const point = e.eventType === 'SECURITY_INCIDENT' || e.eventType === 'OTHER_VERIFIED_EVENT' || e.eventType === 'AIRSPACE_REOPENING';
    return { e, s, endMs: end ?? (point ? s.endMs : period.endMs), open: end === null && !point };
  }).filter((v): v is NonNullable<typeof v> => !!v);
  const layers = LAYERS.filter((l) => on[l]).map((l) => {
    const its = items.filter((i) => layerOf(i.e.eventType) === l);
    const rows = stackRows(its.map((i) => ({ id: i.e.eventId, startMs: i.s.startMs, endMs: Math.max(i.endMs, i.s.startMs + span / 120) })));
    return { l, its, rows, n: Math.max(1, ...[...rows.values()].map((r) => r + 1)) };
  });
  // days on which two or more listed events are in force (overlap strip)
  const pairs = overlaps(events);
  const series = result && on.D ? result.series : null;
  const seriesH = series ? 70 : 0;
  const scen = on.E && scenario ? scenario.events.filter((ev) => ev.enabled) : [];
  let y = 22;
  const blocks: { l: string; y: number; h: number }[] = [];
  for (const ly of layers) { blocks.push({ l: ly.l, y, h: ly.n * ROW + 6 }); y += ly.n * ROW + 6; }
  const scenY = y;
  if (scen.length) y += Math.min(6, scen.length) * ROW + 6;
  const serY = y;
  const H = y + seriesH + 22;
  const ticks = Array.from({ length: Math.floor(span / DAY / 7) + 1 }, (_, k) => period.startMs + k * 7 * DAY);
  return (
    <>
      <div className="i-adv" role="group" aria-label={t('ei.layers')}>
        {(['A', 'B', 'C', 'D', 'E'] as const).map((k) => <label key={k} className="r-inline small"><input type="checkbox" checked={on[k]} onChange={() => setOn({ ...on, [k]: !on[k] })} />{t(`ei.layer.${k}` as MessageKey)}</label>)}
      </div>
      <svg className="x-map ei-timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('ei.timeline')}>
        <defs>
          <pattern id="ei-day" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="currentColor" /></pattern>
        </defs>
        {pairs.map((p, i) => <rect key={i} x={x(p.startMs)} y={14} width={Math.max(1, x(p.endMs) - x(p.startMs))} height={4} className="ei-overlap"><title>{t('ei.overlapTitle')}</title></rect>)}
        {ticks.map((ms) => <g key={ms}><line x1={x(ms)} x2={x(ms)} y1={20} y2={H - 18} className="x-grid" /><text x={x(ms)} y={H - 6} className="x-label" textAnchor="middle">{day(ms).slice(5)}</text></g>)}
        {blocks.map((b) => <text key={b.l} x={4} y={b.y + 10} className="x-label">{t(`ei.layer.${b.l}` as MessageKey)}</text>)}
        {layers.map((ly, li) => ly.its.map((i) => {
          const yy = blocks[li]!.y + ly.rows.get(i.e.eventId)! * ROW;
          const x0 = x(i.s.startMs);
          const x1 = Math.max(x0 + 3, x(i.endMs));
          const sel = i.e.eventId === selectedId;
          const col = TYPE_COLOR[i.e.eventType]!;
          const cls = `ei-bar ${i.s.kind === 'day' ? 'is-day' : 'is-exact'} ${i.e.verificationStatus === 'Unverified' ? 'is-unverified' : ''} ${sel ? 'is-selected' : ''}`;
          return (
            <g key={i.e.eventId} className={cls} style={{ color: col }} onClick={() => onSelect(i.e.eventId)}>
              <rect x={x0} y={yy} width={x1 - x0} height={ROW - 3} fill={i.s.kind === 'day' && x1 - x0 < 14 ? 'url(#ei-day)' : col} fillOpacity={i.s.kind === 'day' ? 0.55 : 0.75} stroke={col} />
              {i.open && <text x={x1 + 2} y={yy + 9} className="x-label">…</text>}
              <title>{`${i.e.title} — ${t(`ei.status.${i.e.verificationStatus}` as MessageKey)} — ${timeText(i.e)}`}</title>
            </g>
          );
        }))}
        {scen.slice(0, 6).map((ev, k) => {
          const s = ev.startTimeUtc ? Date.parse(ev.startTimeUtc) : period.startMs;
          const e = ev.endTimeUtc ? Date.parse(ev.endTimeUtc) : period.endMs;
          return <rect key={ev.eventId} x={x(s)} y={scenY + k * ROW} width={Math.max(3, x(e) - x(s))} height={ROW - 3} className="ei-hypo"><title>{t('ei.hypoTitle')}</title></rect>;
        })}
        {scen.length > 0 && <text x={4} y={scenY + 10} className="x-label">{t('ei.layer.E')}</text>}
        {series && (() => {
          const vals = series.flights.area;
          const max = Math.max(1, ...vals);
          const pts = vals.map((v, i) => [series.startMs + i * DAY + DAY / 2, v] as const).filter(([ms]) => ms >= period.startMs && ms < period.endMs);
          return (
            <g>
              <text x={4} y={serY + 10} className="x-label">{t('ei.layer.D')}</text>
              {result && <rect x={x(result.windows.before.startMs)} y={serY} width={x(result.windows.before.endMs) - x(result.windows.before.startMs)} height={seriesH} className="ev-win ev-win-before" />}
              {result && <rect x={x(result.windows.after.startMs)} y={serY} width={x(result.windows.after.endMs) - x(result.windows.after.startMs)} height={seriesH} className="ev-win ev-win-after" />}
              {result?.gapDays.filter((g) => g >= period.startMs && g < period.endMs).map((g) => <rect key={g} x={x(g)} y={serY} width={Math.max(2, x(g + DAY) - x(g))} height={seriesH} className="ev-gap" />)}
              <polyline fill="none" stroke="#ff6147" strokeWidth={1.6} points={pts.map(([ms, v]) => `${x(ms).toFixed(1)},${(serY + seriesH - (v / max) * (seriesH - 8)).toFixed(1)}`).join(' ')} />
              <text x={W - 12} y={serY + 10} textAnchor="end" className="x-label">{f.int(max)}</text>
            </g>
          );
        })()}
      </svg>
      <div className="legend i-legend">
        <span className="legend-item"><span className="i-swatch ei-sw-exact" />{t('ei.lg.exact')}</span>
        <span className="legend-item"><span className="i-swatch ei-sw-day" />{t('ei.lg.day')}</span>
        <span className="legend-item"><span className="i-swatch ei-sw-unverified" />{t('ei.lg.unverified')}</span>
        <span className="legend-item"><span className="i-swatch ei-sw-overlap" />{t('ei.lg.overlap')}</span>
        <span className="legend-item"><span className="i-swatch ei-sw-hypo" />{t('ei.lg.hypo')}</span>
      </div>
      <p className="small x-dim">{t('ei.timelineNote')}{!result ? ` ${t('ei.seriesHint')}` : ''}</p>
    </>
  );
}

function timeLabel(t: TimeValue): string {
  return t.precision === 'minute' || t.precision === 'hour' ? `${t.utc!.slice(0, 16).replace('T', ' ')} UTC` : t.local ?? '?';
}

function timeText(e: UnifiedEvent): string {
  const first = [...e.occurrence, ...e.effectiveFrom, ...e.publication].find((v) => spanOf(v));
  return first ? `${timeLabel(first)} (${first.precision})` : '?';
}

function EventList({ events, selectedId, onSelect }: { events: UnifiedEvent[]; selectedId: string; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n();
  const sorted = [...events].sort((a, b) => (startSpan(a)?.startMs ?? 0) - (startSpan(b)?.startMs ?? 0));
  return (
    <div className="r-table-wrap ei-list">
      <table className="r-table r-compact">
        <thead><tr><th>{t('ei.col.when')}</th><th>{t('ei.col.type')}</th><th>{t('ei.col.title')}</th><th>{t('ei.col.area')}</th><th>{t('ei.col.status')}</th></tr></thead>
        <tbody>{sorted.map((e) => (
          <tr key={e.eventId} className={e.eventId === selectedId ? 'is-selected' : ''} onClick={() => onSelect(e.eventId)} style={{ cursor: 'pointer' }}>
            <td className="mono small">{timeText(e)}</td>
            <td><span className="i-swatch" style={{ background: TYPE_COLOR[e.eventType] }} />{t(`ei.type.${e.eventType}` as MessageKey)}</td>
            <td>{locale === 'ja' && e.titleJa ? e.titleJa : e.title}</td>
            <td className="small">{[...e.coveredCountries, ...(e.coveredCountries.length ? [] : e.coveredFIRs), ...e.affectedAirports].join(' ') || '—'}</td>
            <td className="small">{t(`ei.status.${e.verificationStatus}` as MessageKey)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const FIELD_KEYS = ['occurrence', 'publication', 'effectiveFrom', 'effectiveUntil'] as const;

function EventDetail({ e, all, onSelect }: { e: UnifiedEvent; all: UnifiedEvent[]; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n();
  const s = startSpan(e);
  // events of the same days (only closeness in time unless a source states a relation)
  const around = s ? eventsInWindow(all, s.startMs - 3 * DAY, s.endMs + 3 * DAY).filter((x) => x.eventId !== e.eventId && !(x.czib && e.czib && x.czib.bulletinId === e.czib.bulletinId)) : [];
  // events that started within ±3 days, and older ones still in force at that time (listed apart)
  const startedNear = (x: UnifiedEvent) => { const xs = startSpan(x); return !!xs && !!s && xs.startMs >= s.startMs - 3 * DAY; };
  const near = [...around.filter(startedNear), ...around.filter((x) => !startedNear(x))];
  const stated = new Map(e.relatedEvents.map((r) => [r.eventId, r]));
  const conflicts = timeConflicts(e);
  return (
    <div className="ev-card">
      <h4 className="r-h4">{locale === 'ja' && e.titleJa ? e.titleJa : e.title}</h4>
      <div className="kv-row"><span>{t('ei.k.type')}</span><span><span className="i-swatch" style={{ background: TYPE_COLOR[e.eventType] }} />{t(`ei.type.${e.eventType}` as MessageKey)}{e.closureScope ? ` · ${t(`ei.scope.${e.closureScope}` as MessageKey)}` : ''} <span className="badge">{t(`ei.status.${e.verificationStatus}` as MessageKey)}</span></span></div>
      <div className="kv-row"><span>{t('ei.k.authority')}</span><span>{e.issuingAuthority ?? '—'}{e.documentType ? ` · ${e.documentType}` : ''}{e.documentId ? ` · ${e.documentId}` : ''}{e.revisionId ? ` (${e.revisionId})` : ''}</span></div>
      <div className="kv-row"><span>{t('ei.k.area')}</span><span>{t('ei.countries')}: {e.coveredCountries.join(', ') || '—'} · FIR: {e.coveredFIRs.join(', ') || '—'} · {t('ei.airports')}: {e.affectedAirports.join(', ') || '—'}</span></div>
      {(e.affectedOperators || e.altitudeRestrictions || e.affectedAircraftTypes.length > 0) && (
        <div className="kv-row"><span>{t('ei.k.scope')}</span><span>{e.affectedOperators ? `${t(`ei.ops.${e.affectedOperators.scope}` as MessageKey)}: ${e.affectedOperators.text}` : ''}{e.altitudeRestrictions ? ` · ${t('ei.altitude')}: ${e.altitudeRestrictions.text}` : ''}{e.affectedAircraftTypes.length ? ` · ${t('ei.aircraft')}: ${e.affectedAircraftTypes.join(', ')}` : ''}</span></div>
      )}
      <table className="r-table r-compact">
        <thead><tr><th>{t('ei.col.timeKind')}</th><th>{t('ei.col.value')}</th><th>{t('ei.col.precision')}</th><th>{t('ei.col.basis')}</th></tr></thead>
        <tbody>
          {FIELD_KEYS.flatMap((k) => (e[k].length ? e[k].map((v, i) => (
            <tr key={`${k}${i}`}><td>{t(`ei.time.${k}` as MessageKey)}</td><td className="mono small">{timeLabel(v)}{v.tz && v.precision === 'date' ? ` (${v.tz})` : ''}</td><td className="small">{t(`ei.prec.${v.precision}` as MessageKey)}</td><td className="small">{v.basis} — {v.sourceId}</td></tr>
          )) : [<tr key={k}><td>{t(`ei.time.${k}` as MessageKey)}</td><td colSpan={3} className="small x-dim">{t('ei.unknown')}</td></tr>]))}
          <tr><td>{t('ei.time.firstVerified')}</td><td className="mono small">{e.firstVerifiedAt?.replace('T', ' ').slice(0, 16) ?? '—'} UTC</td><td className="small" colSpan={2}>{t('ei.firstVerifiedNote')}</td></tr>
        </tbody>
      </table>
      {conflicts.length > 0 && <p className="small r-warn-text">{t('ei.conflict', { f: conflicts.join(', ') })}</p>}
      <div className="ei-verify">
        <div><h4 className="small">{t('ei.verified')}</h4><ul className="r-mini">{e.verified.length ? e.verified.map((x) => <li key={x}>{x}</li>) : <li className="x-dim">{t('ei.none')}</li>}</ul></div>
        <div><h4 className="small">{t('ei.notVerified')}</h4><ul className="r-mini">{e.notVerified.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      {e.confidenceNotes && <p className="small x-dim">{e.confidenceNotes}</p>}
      <h4 className="small">{t('ei.sources')}</h4>
      <ul className="r-mini">
        {e.sourceReferences.slice(0, 6).map((r, i) => <li key={i}><span className="badge">{t(`ei.src.${r.sourceType}` as MessageKey)}</span> {r.publisher}: <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> <span className="small x-dim mono">{(r.capturedAt ?? r.retrievedAt).slice(0, 10)} · {r.sha256.slice(0, 10)}</span></li>)}
        {e.sourceReferences.length > 6 && <li className="x-dim">{t('ei.moreSources', { n: e.sourceReferences.length - 6 })}</li>}
      </ul>
      <h4 className="small">{t('ei.near')}</h4>
      {near.length ? (
        <ul className="r-mini">{near.map((x) => {
          const r = stated.get(x.eventId);
          return <li key={x.eventId}><button type="button" className="link-btn" onClick={() => onSelect(x.eventId)}>{locale === 'ja' && x.titleJa ? x.titleJa : x.title}</button> <span className="small x-dim">({t(`ei.type.${x.eventType}` as MessageKey)}, {timeText(x)}{startedNear(x) ? '' : ` · ${t('ei.inForce')}`}) — {r ? t('ei.relStated', { rel: r.relation }) : t('ei.relTemporal')}</span></li>;
        })}</ul>
      ) : <p className="small x-dim">{t('ei.none')}</p>}
      <p className="small x-dim">{t('ei.nearNote')}</p>
    </div>
  );
}

/** Real events in force during the comparison windows (they are shown, not modelled). */
function WindowEvents({ r, all, onSelect }: { r: StudyResult; all: UnifiedEvent[]; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n();
  const w = r.windows;
  const rows = [
    { k: 'before', list: eventsInWindow(all, w.before.startMs, w.before.endMs), s: w.before.startMs, e: w.before.endMs },
    { k: 'event', list: eventsInWindow(all, w.eventDayMs, w.eventDayMs + DAY), s: w.eventDayMs, e: w.eventDayMs + DAY },
    { k: 'after', list: eventsInWindow(all, w.after.startMs, w.after.endMs), s: w.after.startMs, e: w.after.endMs },
  ];
  // a date-only local day can reach a few hours into a UTC window it does not belong to
  const edgeOnly = (e: UnifiedEvent, ws: number, we: number) => {
    const sp = startSpan(e);
    if (!sp || sp.kind !== 'day') return false;
    const end = endMs(e) ?? Infinity;
    return Math.min(end, we) - Math.max(sp.startMs, ws) < DAY && (sp.startMs >= we - DAY || end <= ws + DAY);
  };
  const relevant = (e: UnifiedEvent) => !r.area.countries.length || e.coveredCountries.some((c) => r.area.countries.includes(c)) || e.coveredFIRs.some((x) => r.area.firs.includes(x));
  return (
    <section className="r-box">
      <h4 className="r-h4">{t('ei.windowEvents')}</h4>
      <table className="r-table r-compact">
        <thead><tr><th>{t('ei.col.window')}</th><th>{t('ei.col.events')}</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.k}><td>{t(`ei.win.${row.k}` as MessageKey)}</td>
            <td>{row.list.filter(relevant).map((e) => <span key={e.eventId} className="ei-chip"><button type="button" className="link-btn" onClick={() => onSelect(e.eventId)} style={{ color: TYPE_COLOR[e.eventType] }}>{locale === 'ja' && e.titleJa ? e.titleJa : e.title}</button><span className="small x-dim"> ({t(`ei.status.${e.verificationStatus}` as MessageKey)}{edgeOnly(e, row.s, row.e) ? ` · ${t('ei.edgeOnly')}` : ''})</span></span>)}</td></tr>
        ))}</tbody>
      </table>
      <p className="small x-dim">{t('ei.windowEventsNote')}</p>
    </section>
  );
}

function eventsCsv(events: UnifiedEvent[]): string {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const tv = (vals: TimeValue[]) => vals.map((v) => `${v.utc ?? v.local ?? ''}[${v.precision}]`).join(' | ');
  const lines = ['event_id,event_type,title,authority,document,revision,occurrence,publication,effective_from,effective_until,first_verified_utc,countries,firs,airports,operators,status,sources'];
  for (const e of events) {
    lines.push([e.eventId, e.eventType, e.title, e.issuingAuthority, e.documentId, e.revisionId, tv(e.occurrence), tv(e.publication), tv(e.effectiveFrom), tv(e.effectiveUntil),
      e.firstVerifiedAt, e.coveredCountries.join(' '), e.coveredFIRs.join(' '), e.affectedAirports.join(' '), e.affectedOperators?.scope ?? '', e.verificationStatus,
      e.sourceReferences.map((s) => s.url).join(' ')].map(cell).join(','));
  }
  return lines.join('\n');
}

function RegistrySources({ registry }: { registry: Registry }) {
  const { t } = useI18n();
  return (
    <>
      <h4 className="small">{t('ei.registry', { v: registry.registryVersion, n: registry.events.length })}</h4>
      <ul className="r-mini">{registry.notCaptured.map((x) => <li key={x.subject}><strong>{x.subject}</strong>: {x.reason}</li>)}</ul>
      {registry.rejected.length > 0 && <p className="small r-warn-text">{t('ei.rejected', { n: registry.rejected.length })}</p>}
    </>
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
            {/* under one flight a day before, a percentage says nothing */}
            <span className="stat-value">{row(id).beforeMean < 1 ? '—' : pct(row(id).change, f)}</span>
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

function Timing({ r }: { r: StudyResult }) {
  const { t } = useI18n();
  const f = useFormat();
  const tr = (x: StudyResult['ratioPreTrend']) => (x ? t('ev.trendCellHac', { c: pct(x.impliedChange, f), tv: f.dec(x.t, 2), to: f.dec(x.tOls, 2) }) : t('ev.tooFew'));
  const pl = r.placebo;
  const w = r.windows;
  const at = (ms: number) => { const v = r.series.flights.area[Math.round((ms - r.series.startMs) / DAY)]; return v === undefined ? '—' : f.int(v); };
  const largest = pl.placebos.reduce<number | null>((m, p) => (m === null || Math.abs(p.logChange) > Math.abs(m) ? p.logChange : m), null);
  const did = r.did;
  const didLarge = did.placebos.filter((x) => Math.abs(x) >= Math.abs(did.logDifference)).length;
  return (
    <>
      <h4 className="small">{t('ev.phases')}</h4>
      <table className="r-table r-compact">
        <tbody>
          <tr><td>{t('ev.phase.before', { s: day(w.before.startMs), e: day(w.before.endMs - DAY) })}</td><td className="num">{f.dec(r.beforeAfter.area.beforeMean, 0)}</td><td className="small">{r.preTrend.area ? t('ev.phase.trend', { c: pct(r.preTrend.area.impliedChange, f) }) : ''}</td></tr>
          <tr><td>{t('ev.phase.lastBefore', { d: day(w.eventDayMs - DAY) })}</td><td className="num">{at(w.eventDayMs - DAY)}</td><td /></tr>
          <tr><td>{t('ev.phase.event', { d: day(w.eventDayMs) })}</td><td className="num">{at(w.eventDayMs)}</td><td className="small">{t('ev.phase.eventNote')}</td></tr>
          <tr><td>{t('ev.phase.firstAfter', { d: day(w.after.startMs) })}</td><td className="num">{at(w.after.startMs)}</td><td /></tr>
          <tr><td>{t('ev.phase.after', { s: day(w.after.startMs), e: day(w.after.endMs - DAY) })}</td><td className="num">{f.dec(r.beforeAfter.area.afterMean, 0)}</td><td /></tr>
        </tbody>
      </table>
      <p className="small x-dim">{t('ev.phaseNote')}</p>
      <h4 className="small">{t('ev.timing')}</h4>
      <table className="r-table r-compact">
        <thead><tr><th>{t('ev.col.series')}</th><th className="num">{t('ev.col.preTrend')}</th><th className="num">{t('ev.col.change')}</th></tr></thead>
        <tbody>
          {(['area', 'neighbours', 'comparison'] as const).map((id) => <tr key={id}><td>{t(`ev.s.${id}`)}</td><td className="num">{tr(r.preTrend[id])}</td><td className="num">{pct(r.beforeAfter[id].change, f)}</td></tr>)}
          <tr><td>{t('ev.ratio')}</td><td className="num">{tr(r.ratioPreTrend)}</td><td className="num">—</td></tr>
        </tbody>
      </table>
      <p className="small x-dim">{t('ev.preTrendNote')}</p>
      <h4 className="small">{t('ev.placebo')}</h4>
      <p className="small">{pl.placebos.length
        ? t('ev.placeboCount', { k: pl.asLarge, n: pl.placebos.length, tried: pl.tried, o: pl.overlapping, a: pct(Math.exp(pl.actual) - 1, f), max: largest === null ? '—' : pct(Math.exp(largest) - 1, f) })
        : t('ev.placeboNone')}</p>
      <p className="small x-dim">{pl.placebos.map((p) => `${day(p.dayMs)} ${pct(Math.exp(p.logChange) - 1, f)}`).join(' · ')}</p>
      {pl.placebos.length > 0 && <p className="small x-dim">{t('ev.placeboNote', { n: pl.placebos.length, min: f.pct(1 / (pl.placebos.length + 1), 0) })}</p>}
      <h4 className="small">{t('ev.didDesc')}</h4>
      <p className="small">{t('ev.didDescValue', { v: pct(Math.exp(did.logDifference) - 1, f), c: pct(Math.exp(did.comparisonLogChange) - 1, f), lvl: did.levelRatioBefore === null ? '—' : f.dec(did.levelRatioBefore, 2) })}</p>
      <p className="small x-dim">{t('ev.didPlacebo', { k: didLarge, n: did.placebos.length })}</p>
      <h4 className="small">{t('ev.checksTitle')}</h4>
      <ul className="r-mini">{did.conditions.map((c) => <li key={c.id} className={c.ok ? '' : 'r-warn-text'}>{c.ok ? '✓' : '×'} {t(`ev.cond.${c.id}` as MessageKey)}: {c.detail}</li>)}</ul>
      <h4 className="small">{t('ev.unchecked')}</h4>
      <ul className="r-mini">
        <li>{t('ev.unchecked.comparison', { c: pct(Math.exp(did.comparisonLogChange) - 1, f) })}</li>
        <li>{t('ev.unchecked.season')}</li>
        <li>{t('ev.unchecked.concurrent')}</li>
        <li>{t('ev.unchecked.coverage')}</li>
        <li>{t('ev.unchecked.power')}</li>
      </ul>
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
