import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { defaultConfig } from '../../research/model';
import { useAppStore } from '../../state/store';
import { eventActiveAt, scenarioContext } from '../../simulation/disruption';
import { airportsCsv, areasCsv, eventsCsv, lostPairsCsv, metricsCsv, resultJson, routesCsv, seriesCsv } from '../../simulation/exports';
import { isoMinute, parseIsoUtc, parseScenario, scenarioHash, scenarioJson, type SimulationEvent, type SimulationScenario } from '../../simulation/model';
import {
  addAirportEvent,
  addRouteEvent,
  closeAirport,
  currentPeriod,
  duplicateEvent,
  editScenario,
  loadScenario,
  removeEvent,
  reopenAirport,
  resumeRoute,
  setEventTime,
  updateEvent,
} from '../../simulation/start';
import type { SimContext } from '../../simulation/useSimulation';
import { formatUtc } from '../../temporal/window';
import { Icon } from '../common/Icon';
import { downloadText } from '../research/format';
import { eventLabel } from '../../simulation/labels';
import { AirportTable, Breakdown, Connectivity, EventContributions, ImpactSummary, PairAnalysis, Warnings } from './SimResults';
import { issueText } from './issueText';

const toInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '');
const fromInput = (v: string) => (v ? parseIsoUtc(`${v}Z`) : null);

export type SectionId = 'airports' | 'paths' | 'detail' | 'conditions' | 'export' | 'limits';

/**
 * Simulation panel (right). Order of what is shown first: what is stopped, at what time, what was
 * lost, which airports are affected, how much the whole network changed. Everything else sits in
 * sections that open on demand (and from the summary cards).
 */
export function SimulationPanel({ ctx }: { ctx: SimContext }) {
  const { t } = useI18n();
  const scenario = useAppStore((s) => s.simScenario);
  const setScenario = useAppStore((s) => s.setSimScenario);
  const setOpen = useAppStore((s) => s.setSimOpen);
  const [open, setSectionOpen] = useState<Record<SectionId, boolean>>({ airports: false, paths: false, detail: false, conditions: false, export: false, limits: false });
  const bodyRef = useRef<HTMLDivElement>(null);

  // the dataset version is known once the temporal index is loaded
  useEffect(() => {
    if (scenario && ctx.meta && scenario.datasetVersion !== ctx.meta.index.datasetVersion) {
      setScenario({ ...scenario, datasetVersion: ctx.meta.index.datasetVersion });
    }
  }, [scenario, ctx.meta, setScenario]);

  if (!scenario) return null;
  const reveal = (id: SectionId) => {
    setSectionOpen((o) => ({ ...o, [id]: true }));
    requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const section = (id: SectionId, title: MessageKey, children: ReactNode) => (
    <details className="sim-section sim-fold" data-section={id} open={open[id]}
      onToggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; if (isOpen !== open[id]) setSectionOpen((o) => ({ ...o, [id]: isOpen })); }}>
      <summary className="field-label">{t(title)}</summary>
      {open[id] && children}
    </details>
  );

  return (
    <aside className="info panel sim-panel" aria-label={t('sim.title')}>
      <div className="info-body" ref={bodyRef}>
        <div className="info-head">
          <h2 className="section-title">{t('sim.title')}</h2>
          <span className="badge warn-badge">{t('sim.badge')}</span>
          <button type="button" className="icon-btn sim-close" onClick={() => setOpen(false)} aria-label={t('sim.close')} title={t('sim.close')}>
            <Icon name="close" />
          </button>
        </div>
        <ContextLine scenario={scenario} ctx={ctx} onConditions={() => reveal('conditions')} />
        <Warnings scenario={scenario} ctx={ctx} />
        <ImpactSummary scenario={scenario} ctx={ctx} onReveal={reveal} />
        <EventsSection scenario={scenario} atMs={ctx.atMs} />
        {section('airports', 'sim.sec.airports', <AirportTable onPick={() => reveal('paths')} />)}
        {section('paths', 'sim.sec.paths', <PairAnalysis ctx={ctx} />)}
        {section('detail', 'sim.sec.detail', <><Connectivity /><EventContributions ctx={ctx} /><Breakdown /></>)}
        {section('conditions', 'sim.sec.conditions', <AdvancedSettings scenario={scenario} />)}
        {section('export', 'sim.sec.export', <ExportBar scenario={scenario} ctx={ctx} />)}
        {section('limits', 'sim.sec.limits', <Assumptions model={scenario.simulationModel} />)}
      </div>
    </aside>
  );
}

/** One line: how the result is computed (model, baseline, period, conditions) and its meaning. */
function ContextLine({ scenario: s, ctx, onConditions }: { scenario: SimulationScenario; ctx: SimContext; onConditions: () => void }) {
  const { t } = useI18n();
  const w = ctx.window;
  const tiers = s.filters.tiers === 'D' ? 'T1–T4' : s.filters.tiers === 'C' ? 'T1–T3' : s.filters.tiers === 'B' ? 'T1–T2' : 'T1';
  return (
    <div className="sim-context">
      <div className="sim-row">
        <span className="sim-chip">{t(`sim.model.${s.simulationModel}`)}</span>
        <span className="sim-chip">{t(`sim.baseline.${s.baselineMode}`)}</span>
        <span className="small muted">{w ? `${formatUtc(w.startMs, false)} – ${formatUtc(w.endMs)}` : '—'} · {tiers} · {t(s.analysisSettings.directed ? 'sim.directed' : 'sim.undirected')}</span>
        <button type="button" className="link-btn" onClick={onConditions}>{t('sim.sec.conditions')}</button>
      </div>
      <p className="hint">
        {s.simulationModel === 'structural'
          ? t('sim.meaning.structural', { time: ctx.atMs !== null ? formatUtc(ctx.atMs) : '—' })
          : t('sim.meaning.temporal')}
      </p>
    </div>
  );
}

/** What is stopped: the event list (click = select, highlighted on the timeline and the map) or the editor. */
function EventsSection({ scenario, atMs }: { scenario: SimulationScenario; atMs: number | null }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const selectedRoute = useAppStore((s) => s.selectedRoute);
  const selectedEvent = useAppStore((s) => s.simSelectedEvent);
  const setSelected = useAppStore((s) => s.setSimSelectedEvent);
  const code = (id: string) => network.airports.find((a) => a.id === id)?.iata ?? id;
  const ap = selectedAirport !== null ? network.airports[selectedAirport]! : null;
  const route = selectedRoute !== null ? network.routes[selectedRoute]! : null;
  const ra = route ? network.airports[route.a]!.id : null;
  const rb = route ? network.airports[route.b]!.id : null;
  const apIsTarget = ap ? scenario.events.some((e) => e.targetType === 'airport' && e.targetIds.includes(ap.id)) : false;
  const routeIsTarget = ra && rb ? scenario.events.some((e) => e.targetType === 'route' && e.targetIds.some((x) => x === `${ra}>${rb}` || x === `${rb}>${ra}`)) : false;
  const ev = scenario.events.find((e) => e.eventId === selectedEvent) ?? null;
  const at = atMs ?? parseIsoUtc(scenario.analysisStart)!;

  return (
    <section className="sim-section">
      <div className="sim-row">
        <span className="field-label">{t('sim.targets')}</span>
        <span className="small muted">{atMs !== null ? t('sim.tl.at', { time: formatUtc(atMs) }) : ''}</span>
      </div>
      {ev ? (
        <EventEditor ev={ev} code={code} onClose={() => setSelected(null)} />
      ) : (
        <>
          {scenario.events.length === 0 && <p className="hint">{t('sim.targets.empty')}</p>}
          <ul className="sim-events">
            {scenario.events.map((e) => {
              const active = eventActiveAt(e, at);
              return (
                <li key={e.eventId} className={`${e.enabled ? '' : 'is-off'} ${active ? 'is-active' : ''}`}>
                  <div className="sim-row">
                    <input type="checkbox" checked={e.enabled} aria-label={t('sim.ev.enabled')} onChange={(x) => updateEvent(e.eventId, { enabled: x.target.checked })} />
                    <button type="button" className="sim-event-name" onClick={() => setSelected(e.eventId)} title={t('sim.ev.edit')}>
                      <span className="code">{eventLabel(e, code)}</span>
                    </button>
                    <span className={`sim-state ${active ? 'is-on' : ''}`}>{t(active ? 'sim.ev.activeNow' : 'sim.ev.inactiveNow')}</span>
                    <button type="button" className="icon-btn sim-remove" onClick={() => removeEvent(e.eventId)} aria-label={t('sim.event.remove')} title={t('sim.event.remove')}>
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  <div className="hint">
                    {t(`sim.event.${e.eventType}` as MessageKey)} · {timeText(e, t)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {ap && !ev && (
        <div className="sim-pick">
          <span className="code">{ap.iata ?? ap.id}</span>
          {apIsTarget && <button type="button" className="pill-btn" onClick={() => reopenAirport(ap.id)}>{t('sim.reopenAirport')}</button>}
          <button type="button" className="pill-btn sim-primary" onClick={() => addAirportEvent(ap.id, at, at + 6 * 3_600_000)}>{t('sim.ev.addTimed')}</button>
          {!apIsTarget && <button type="button" className="pill-btn" onClick={() => closeAirport(ap.id)}>{t('sim.ev.addAlways')}</button>}
        </div>
      )}
      {route && ra && rb && !ev && (
        <div className="sim-pick">
          <span className="code">{code(ra)} – {code(rb)}</span>
          {routeIsTarget && <button type="button" className="pill-btn" onClick={() => resumeRoute(ra, rb)}>{t('sim.resumeRoute')}</button>}
          <button type="button" className="pill-btn sim-primary" onClick={() => addRouteEvent(ra, rb, 'both', at, at + 6 * 3_600_000)}>{t('sim.ev.addRoute')}</button>
          <button type="button" className="pill-btn" onClick={() => addRouteEvent(ra, rb, 'directed', at, at + 6 * 3_600_000)}>{code(ra)} → {code(rb)}</button>
          <button type="button" className="pill-btn" onClick={() => addRouteEvent(rb, ra, 'directed', at, at + 6 * 3_600_000)}>{code(rb)} → {code(ra)}</button>
        </div>
      )}
      {!ap && !route && !ev && scenario.events.length === 0 && <p className="hint">{t('sim.pickHint')}</p>}
    </section>
  );
}

function timeText(e: SimulationEvent, t: ReturnType<typeof useI18n>['t']): string {
  if (!e.startTimeUtc && !e.endTimeUtc) return t('sim.event.always');
  const s = parseIsoUtc(e.startTimeUtc);
  const en = parseIsoUtc(e.endTimeUtc);
  return `${s === null ? '…' : formatUtc(s, false)} – ${en === null ? '…' : formatUtc(en)}`;
}

/** Exact editing of one event (times typed in UTC; the timeline drag snaps to the hour). */
function EventEditor({ ev, code, onClose }: { ev: SimulationEvent; code: (id: string) => string; onClose: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState(false);
  const setTime = (which: 'start' | 'end', v: string) => {
    const ms = v ? fromInput(v) : null;
    if (v && ms === null) return;
    setError(!setEventTime(ev.eventId, which, ms));
  };
  return (
    <div className="sim-editor">
      <div className="sim-row">
        <span className="sim-event-type">{t(`sim.event.${ev.eventType}` as MessageKey)}</span>
        <span className="code">{eventLabel({ ...ev, label: '' }, code)}</span>
        <button type="button" className="link-btn" onClick={onClose}>{t('sim.ev.done')}</button>
      </div>
      <label className="t-field"><span className="muted small">{t('sim.ev.label')}</span>
        <input className="r-input" type="text" maxLength={120} value={ev.label} placeholder={eventLabel({ ...ev, label: '' }, code)} onChange={(e) => updateEvent(ev.eventId, { label: e.target.value })} />
      </label>
      <label className="t-field"><span className="muted small">{t('sim.event.start')}</span>
        <input type="datetime-local" step={60} value={toInput(ev.startTimeUtc)} onChange={(e) => setTime('start', e.target.value)} />
      </label>
      <label className="t-field"><span className="muted small">{t('sim.event.end')}</span>
        <input type="datetime-local" step={60} value={toInput(ev.endTimeUtc)} onChange={(e) => setTime('end', e.target.value)} />
      </label>
      {error && <p className="hint warn">{t('sim.ev.badTime')}</p>}
      <p className="hint">{t('sim.event.timeNote')}</p>
      {ev.targetType === 'airport' ? (
        <label className="t-field"><span className="muted small">{t('sim.side')}</span>
          <select value={ev.direction} onChange={(x) => updateEvent(ev.eventId, { direction: x.target.value as SimulationEvent['direction'] })}>
            {(['both', 'departures', 'arrivals'] as const).map((d) => <option key={d} value={d}>{t(`sim.side.${d}`)}</option>)}
          </select>
        </label>
      ) : (
        <label className="t-field"><span className="muted small">{t('sim.direction')}</span>
          <select value={ev.direction} onChange={(x) => updateEvent(ev.eventId, { direction: x.target.value as SimulationEvent['direction'] })}>
            <option value="both">{t('sim.direction.both')}</option>
            <option value="directed">{t('sim.direction.directed')}</option>
          </select>
        </label>
      )}
      <label className="t-field"><span className="muted small">{t('sim.ev.source')}</span>
        <select value={ev.sourceType} onChange={(x) => updateEvent(ev.eventId, { sourceType: x.target.value as SimulationEvent['sourceType'] })}>
          <option value="hypothetical">{t('sim.ev.hypothetical')}</option>
          <option value="reported">{t('sim.ev.reported')}</option>
        </select>
      </label>
      {ev.sourceType === 'reported' && (
        <>
          <label className="t-field"><span className="muted small">{t('sim.ev.sourceRef')}</span>
            <input className="r-input" type="text" maxLength={500} value={ev.sourceReference ?? ''} onChange={(e) => updateEvent(ev.eventId, { sourceReference: e.target.value || null })} />
          </label>
          {!ev.sourceReference && <p className="hint warn">{t('sim.ev.needSource')}</p>}
        </>
      )}
      <div className="sim-actions">
        <label className="sim-check"><input type="checkbox" checked={ev.enabled} onChange={(x) => updateEvent(ev.eventId, { enabled: x.target.checked })} /><span className="small">{t('sim.ev.enabled')}</span></label>
        <button type="button" className="pill-btn" onClick={() => duplicateEvent(ev.eventId)}>{t('sim.ev.duplicate')}</button>
        <button type="button" className="pill-btn" onClick={() => removeEvent(ev.eventId)}>{t('sim.event.remove')}</button>
      </div>
    </div>
  );
}

function AdvancedSettings({ scenario: s }: { scenario: SimulationScenario }) {
  const { t } = useI18n();
  const patch = (p: Partial<SimulationScenario>) => editScenario(p);
  const seg = <T extends string>(label: string, value: T, options: readonly T[], key: (v: T) => MessageKey, set: (v: T) => void) => (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'is-active' : ''} onClick={() => set(o)}>{t(key(o))}</button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="sim-advanced">
      {seg(t('sim.model'), s.simulationModel, ['structural', 'temporal'] as const, (v) => `sim.model.${v}`, (v) => patch({ simulationModel: v }))}
      <p className="hint">{t(`sim.model.${s.simulationModel}.note`)}</p>
      {seg(t('sim.baseline'), s.baselineMode, ['fixed', 'dynamic'] as const, (v) => `sim.baseline.${v}`, (v) => patch({ baselineMode: v }))}
      <p className="hint">{t(`sim.baseline.${s.baselineMode}.note`)}</p>
      {s.baselineMode === 'fixed' && (
        <div className="field">
          <span className="field-label">{t('sim.period')}</span>
          <div className="sim-row">
            <input type="datetime-local" step={3600} value={toInput(s.analysisStart)} aria-label={t('sim.period.start')}
              onChange={(e) => { const ms = fromInput(e.target.value); if (ms !== null) patch({ analysisStart: isoMinute(ms) }); }} />
            <input type="datetime-local" step={3600} value={toInput(s.analysisEnd)} aria-label={t('sim.period.end')}
              onChange={(e) => { const ms = fromInput(e.target.value); if (ms !== null) patch({ analysisEnd: isoMinute(ms) }); }} />
          </div>
          <button type="button" className="link-btn" onClick={() => { const p = currentPeriod(); if (p) patch({ analysisStart: isoMinute(p.startMs), analysisEnd: isoMinute(p.endMs) }); }}>
            {t('sim.period.useShown')}
          </button>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor="sim-tiers">{t('sim.tiers')}</label>
        <select id="sim-tiers" value={s.filters.tiers} onChange={(e) => patch({ filters: { ...s.filters, tiers: e.target.value as SimulationScenario['filters']['tiers'] } })}>
          {(['D', 'C', 'B', 'A'] as const).map((v) => <option key={v} value={v}>{t(`r.tiers.${v}` as MessageKey)}</option>)}
        </select>
        <p className="hint">{t('sim.tiers.note')}</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sim-min">{t('sim.minFlights')}</label>
        <input id="sim-min" className="r-input" type="number" min={1} step={1} value={s.filters.minFlights}
          onChange={(e) => { const v = Math.max(1, Math.floor(Number(e.target.value))); if (Number.isFinite(v)) patch({ filters: { ...s.filters, minFlights: v } }); }} />
      </div>
      {seg(t('sim.graph'), s.analysisSettings.directed ? 'directed' : 'undirected', ['undirected', 'directed'] as const, (v) => `sim.${v}`,
        (v) => patch({ analysisSettings: { ...s.analysisSettings, directed: v === 'directed' } }))}
      {seg(t('t.basis'), s.filters.basis, ['all', 'start'] as const, (v) => `t.basis.${v}`, (v) => patch({ filters: { ...s.filters, basis: v } }))}
      {s.simulationModel === 'temporal' && (
        <>
          {seg(t('sim.proxy'), s.filters.timeProxy, ['endpoint', 'reference'] as const, (v) => `sim.proxy.${v}`, (v) => patch({ filters: { ...s.filters, timeProxy: v } }))}
          <p className="hint">{t(`sim.proxy.${s.filters.timeProxy}.note`)}</p>
        </>
      )}
    </div>
  );
}

function ExportBar({ scenario, ctx }: { scenario: SimulationScenario; ctx: SimContext }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const status = useAppStore((s) => s.simStatus);
  const impact = useAppStore((s) => s.simImpact);
  const series = useAppStore((s) => s.simSeries);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const out = status.state === 'ready' ? status.output : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;
  // the saved scenario carries the simulation time shown now
  const saved = { ...scenario, evaluationTime: ctx.atMs !== null ? isoMinute(ctx.atMs) : scenario.evaluationTime };
  const base = `1090web_sim_${scenarioHash(saved, out?.window)}`;
  const toResearch = () => {
    if (!out) return;
    const st = useAppStore.getState();
    const month = new Date(out.window.startMs).toISOString().slice(0, 7);
    const months = network.manifest.months.map((m) => m.month);
    st.setResearchConfig({
      ...defaultConfig(months.includes(month) ? month : months[months.length - 1]!),
      window: { startMs: out.window.startMs, endMs: out.window.endMs, basis: scenario.filters.basis, preset: 'custom', stepMs: 86_400_000 },
      tiers: scenario.filters.tiers, classes: [...scenario.filters.classes], minFlights: scenario.filters.minFlights,
      directed: scenario.analysisSettings.directed, pathMethod: scenario.analysisSettings.pathMethod,
      samples: scenario.analysisSettings.samples, seed: scenario.analysisSettings.seed,
      scenario: {
        model: scenario.simulationModel,
        // the structural state at the simulation time (Phase 9D); temporal: the records in the window
        evaluationTime: scenario.simulationModel === 'structural' && ctx.atMs !== null ? isoMinute(ctx.atMs) : null,
        timeProxy: scenario.filters.timeProxy, events: scenario.events, name: scenario.name,
      },
    });
    st.setResearchCompare({ enabled: true, field: 'scenario', value: 'off' });
    st.setResearchTab('comparison');
    st.setAppMode('research');
  };
  // Phase 9E: the observed network of the same period, the stopped airports as candidates
  const toExperiments = () => {
    if (!out) return;
    const st = useAppStore.getState();
    const month = new Date(out.window.startMs).toISOString().slice(0, 7);
    const months = network.manifest.months.map((m) => m.month);
    const on = scenario.events.filter((e) => e.enabled);
    const airports = [...new Set(on.filter((e) => e.targetType === 'airport' && (e.eventType === 'AIRPORT_CLOSURE' || e.eventType === 'MULTIPLE_AIRPORT_CLOSURE')).flatMap((e) => e.targetIds))];
    st.setResearchConfig({
      ...defaultConfig(months.includes(month) ? month : months[months.length - 1]!),
      window: { startMs: out.window.startMs, endMs: out.window.endMs, basis: scenario.filters.basis, preset: 'custom', stepMs: 86_400_000 },
      tiers: scenario.filters.tiers, classes: [...scenario.filters.classes], minFlights: scenario.filters.minFlights,
      directed: scenario.analysisSettings.directed,
    });
    st.setExperiment(null);
    st.setExperimentHandoff({ scenarioName: scenario.name, airports, otherEvents: on.length - on.filter((e) => e.targetType === 'airport').length });
    st.setResearchTab('experiments');
    st.setAppMode('research');
  };
  const load = (file: File) => {
    void file.text().then((text) => {
      const range = ctx.meta?.range ?? { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 9, 1) };
      const sctx = scenarioContext(network, scenario.datasetVersion, range.startMs, range.endMs);
      const r = parseScenario(text, sctx);
      if (!r.scenario) {
        setMsg({ ok: false, lines: r.issues.map((i) => issueText(t, i)) });
        return;
      }
      loadScenario(r.scenario);
      setMsg({ ok: true, lines: [t('sim.load.ok', { hash: scenarioHash(r.scenario) }), ...r.issues.map((i) => issueText(t, i))] });
    });
  };
  return (
    <div className="sim-export">
      <div className="sim-actions">
        <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_scenario.json`, scenarioJson(saved), 'application/json')}>{t('sim.save.scenario')}</button>
        <button type="button" className="pill-btn" onClick={() => fileRef.current?.click()}>{t('sim.load')}</button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="r-file" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) load(f);
          e.target.value = '';
        }} />
        <button type="button" className="pill-btn" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setMsg({ ok: true, lines: [t('sim.link.copied')] }); }}>{t('sim.link')}</button>
      </div>
      <div className="sim-actions">
        <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_events.csv`, eventsCsv(saved))}>{t('sim.export.events')}</button>
        {series && <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_timeseries.csv`, seriesCsv(saved, series.points, series.stepMs, series.method))}>{t('sim.export.series')}</button>}
        {out && <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_result.json`, resultJson(saved, out, imp, series, ctx.atMs), 'application/json')}>{t('sim.export.json')}</button>}
        {out && <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_metrics.csv`, metricsCsv(saved, out, imp))}>{t('sim.export.metrics')}</button>}
        {out && <button type="button" className="pill-btn" disabled={!imp} onClick={() => imp && downloadText(`${base}_airports.csv`, airportsCsv(saved, out, imp, network))}>{t('sim.export.airports')}</button>}
        {out && <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_routes.csv`, routesCsv(saved, out, network))}>{t('sim.export.routes')}</button>}
        {out && <button type="button" className="pill-btn" disabled={!imp} onClick={() => imp && downloadText(`${base}_lost_pairs.csv`, lostPairsCsv(saved, out, imp, network))}>{t('sim.export.paths')}</button>}
        {out && <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_areas.csv`, areasCsv(saved, out))}>{t('sim.export.areas')}</button>}
      </div>
      {out && <button type="button" className="primary-btn sim-research" onClick={toResearch}>{t('sim.toResearchAt', { time: ctx.atMs !== null ? formatUtc(ctx.atMs) : '' })}</button>}
      {out && <button type="button" className="pill-btn sim-research" onClick={toExperiments} title={t('sim.robustness.title')}>{t('sim.robustness')}</button>}
      {msg && <ul className={msg.ok ? 'r-mini' : 'r-mini r-warn-text'}>{msg.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
    </div>
  );
}

function Assumptions({ model }: { model: SimulationScenario['simulationModel'] }) {
  const { t } = useI18n();
  return (
    <div>
      <p className="small">{t('sim.assumptions.sim')}</p>
      <ul className="r-mini">
        {(['complete', 'noReroute', 'hypothetical', 'graph', 'recovery', ...(model === 'temporal' ? ['proxy'] : [])] as const).map((k) => <li key={k}>{t(`sim.assume.${k}` as MessageKey)}</li>)}
      </ul>
      <p className="small">{t('sim.assumptions.obs')}</p>
      <ul className="r-mini">
        {(['missing', 'startMissing', 'tiers', 'regions', 'gap'] as const).map((k) => <li key={k}>{t(`sim.obs.${k}`)}</li>)}
      </ul>
    </div>
  );
}
