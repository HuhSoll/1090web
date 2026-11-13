import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { defaultConfig } from '../../research/model';
import { useAppStore } from '../../state/store';
import { scenarioContext } from '../../simulation/disruption';
import { airportsCsv, areasCsv, lostPairsCsv, metricsCsv, resultJson, routesCsv } from '../../simulation/exports';
import {
  isoMinute,
  parseIsoUtc,
  parseScenario,
  scenarioHash,
  scenarioJson,
  type SimulationEvent,
  type SimulationScenario,
} from '../../simulation/model';
import { closeAirport, currentPeriod, reopenAirport, resumeRoute, suspendRoute } from '../../simulation/start';
import { useSimContext, useSimulation } from '../../simulation/useSimulation';
import { formatUtc, HOUR_MS } from '../../temporal/window';
import { Icon } from '../common/Icon';
import { downloadText } from '../research/format';
import { SimResults } from './SimResults';
import { issueText } from './issueText';

const toInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '');
const fromInput = (v: string) => (v ? parseIsoUtc(`${v}Z`) : null);

/** Simulation panel (right side, replaces the details panel while open). */
export function SimulationPanel() {
  const { t } = useI18n();
  const scenario = useAppStore((s) => s.simScenario);
  const setScenario = useAppStore((s) => s.setSimScenario);
  const setOpen = useAppStore((s) => s.setSimOpen);
  const ctx = useSimContext(scenario);
  useSimulation(scenario, ctx);
  const [advanced, setAdvanced] = useState(false);

  // the dataset version is known once the temporal index is loaded
  useEffect(() => {
    if (scenario && ctx.meta && scenario.datasetVersion !== ctx.meta.index.datasetVersion) {
      setScenario({ ...scenario, datasetVersion: ctx.meta.index.datasetVersion });
    }
  }, [scenario, ctx.meta, setScenario]);

  if (!scenario) return null;
  const patch = (p: Partial<SimulationScenario>) => setScenario({ ...scenario, ...p });

  return (
    <aside className="info panel sim-panel" aria-label={t('sim.title')}>
      <div className="info-body">
        <div className="info-head">
          <h2 className="section-title">{t('sim.title')}</h2>
          <span className="badge warn-badge">{t('sim.badge')}</span>
          <button type="button" className="icon-btn sim-close" onClick={() => setOpen(false)} aria-label={t('sim.close')} title={t('sim.close')}>
            <Icon name="close" />
          </button>
        </div>
        <p className="hint">{t('sim.intro')}</p>

        <Targets scenario={scenario} onChange={(events) => patch({ events })} advanced={advanced} />

        <section className="sim-section">
          <div className="sim-row">
            <span className="field-label">{t('sim.settings')}</span>
            <button type="button" className="link-btn" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              {advanced ? t('sim.advanced.hide') : t('sim.advanced.show')}
            </button>
          </div>
          <p className="hint">{settingsSummary(t, scenario, ctx.window)}</p>
          {advanced && <AdvancedSettings scenario={scenario} patch={patch} />}
        </section>

        <ViewToggle />
        <SimResults scenario={scenario} ctx={ctx} />
        <ExportBar scenario={scenario} />
        <Assumptions model={scenario.simulationModel} />
      </div>
    </aside>
  );

  function settingsSummary(tt: typeof t, s: SimulationScenario, w: { startMs: number; endMs: number } | null) {
    return [
      tt(`sim.model.${s.simulationModel}`),
      tt(`sim.baseline.${s.baselineMode}`),
      w ? `${formatUtc(w.startMs, false)} – ${formatUtc(w.endMs)}` : '—',
      s.filters.tiers === 'D' ? 'T1–T4' : s.filters.tiers === 'C' ? 'T1–T3' : s.filters.tiers === 'B' ? 'T1–T2' : 'T1',
      tt(s.analysisSettings.directed ? 'sim.directed' : 'sim.undirected'),
    ].join(' · ');
  }
}

function code(network: { airports: { id: string; iata: string | null }[] }, id: string) {
  const a = network.airports.find((x) => x.id === id);
  return a?.iata ?? id;
}

/** Scenario targets: the selected airport / route can be added; each event can be switched off or removed. */
function Targets({ scenario, onChange, advanced }: { scenario: SimulationScenario; onChange: (e: SimulationEvent[]) => void; advanced: boolean }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const selectedRoute = useAppStore((s) => s.selectedRoute);
  const ap = selectedAirport !== null ? network.airports[selectedAirport]! : null;
  const isTarget = ap ? scenario.events.some((e) => e.targetType === 'airport' && e.targetIds.includes(ap.id)) : false;
  const route = selectedRoute !== null ? network.routes[selectedRoute]! : null;
  const ra = route ? network.airports[route.a]!.id : null;
  const rb = route ? network.airports[route.b]!.id : null;
  const routeIsTarget = ra && rb ? scenario.events.some((e) => e.targetType === 'route' && e.targetIds.some((x) => x === `${ra}>${rb}` || x === `${rb}>${ra}`)) : false;
  const update = (id: string, p: Partial<SimulationEvent>) => onChange(scenario.events.map((e) => (e.eventId === id ? { ...e, ...p } : e)));

  return (
    <section className="sim-section">
      <span className="field-label">{t('sim.targets')}</span>
      {scenario.events.length === 0 && <p className="hint">{t('sim.targets.empty')}</p>}
      <ul className="sim-events">
        {scenario.events.map((e) => (
          <li key={e.eventId} className={e.enabled ? '' : 'is-off'}>
            <div className="sim-row">
              <label className="sim-check">
                <input type="checkbox" checked={e.enabled} onChange={(x) => update(e.eventId, { enabled: x.target.checked })} />
                <span className="sim-event-type">{t(`sim.event.${e.eventType}` as MessageKey)}</span>
              </label>
              <button type="button" className="icon-btn sim-remove" onClick={() => onChange(scenario.events.filter((x) => x.eventId !== e.eventId))} aria-label={t('sim.event.remove')} title={t('sim.event.remove')}>
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="sim-event-targets code">
              {e.targetIds.map((id) => (e.targetType === 'route' ? id.split('>').map((x) => code(network, x)).join(e.direction === 'directed' ? ' → ' : ' ⇄ ') : code(network, id))).join(', ')}
            </div>
            <div className="hint">
              {e.startTimeUtc || e.endTimeUtc
                ? `${e.startTimeUtc ? formatUtc(parseIsoUtc(e.startTimeUtc) ?? 0, false) : '…'} – ${e.endTimeUtc ? formatUtc(parseIsoUtc(e.endTimeUtc) ?? 0) : '…'}`
                : t('sim.event.always')}
              {e.targetType === 'airport' && e.direction !== 'both' ? ` · ${t(`sim.side.${e.direction}` as MessageKey)}` : ''}
            </div>
            {advanced && (
              <div className="sim-event-edit">
                <label className="t-field"><span className="muted small">{t('sim.event.start')}</span>
                  <input type="datetime-local" step={60} value={toInput(e.startTimeUtc)} onChange={(x) => { const ms = fromInput(x.target.value); update(e.eventId, { startTimeUtc: ms === null ? null : isoMinute(ms) }); }} />
                </label>
                <label className="t-field"><span className="muted small">{t('sim.event.end')}</span>
                  <input type="datetime-local" step={60} value={toInput(e.endTimeUtc)} onChange={(x) => { const ms = fromInput(x.target.value); update(e.eventId, { endTimeUtc: ms === null ? null : isoMinute(ms) }); }} />
                </label>
                {e.targetType === 'airport' ? (
                  <label className="t-field"><span className="muted small">{t('sim.side')}</span>
                    <select value={e.direction} onChange={(x) => update(e.eventId, { direction: x.target.value as SimulationEvent['direction'] })}>
                      {(['both', 'departures', 'arrivals'] as const).map((d) => <option key={d} value={d}>{t(`sim.side.${d}`)}</option>)}
                    </select>
                  </label>
                ) : (
                  <label className="t-field"><span className="muted small">{t('sim.direction')}</span>
                    <select value={e.direction} onChange={(x) => update(e.eventId, { direction: x.target.value as SimulationEvent['direction'] })}>
                      <option value="both">{t('sim.direction.both')}</option>
                      <option value="directed">{t('sim.direction.directed')}</option>
                    </select>
                  </label>
                )}
                <p className="hint">{t('sim.event.timeNote')}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      {ap && (
        <div className="sim-row sim-pick">
          <span className="code">{ap.iata ?? ap.id}</span>
          {isTarget
            ? <button type="button" className="pill-btn" onClick={() => reopenAirport(ap.id)}>{t('sim.reopenAirport')}</button>
            : <button type="button" className="pill-btn sim-primary" onClick={() => closeAirport(ap.id)}>{t('sim.closeAirport')}</button>}
        </div>
      )}
      {route && ra && rb && (
        <div className="sim-row sim-pick">
          <span className="code">{code(network, ra)} – {code(network, rb)}</span>
          {routeIsTarget ? (
            <button type="button" className="pill-btn" onClick={() => resumeRoute(ra, rb)}>{t('sim.resumeRoute')}</button>
          ) : (
            <>
              <button type="button" className="pill-btn sim-primary" onClick={() => suspendRoute(ra, rb, 'both')}>{t('sim.suspendRoute')}</button>
              <button type="button" className="pill-btn" onClick={() => suspendRoute(ra, rb, 'directed')}>{code(network, ra)} → {code(network, rb)}</button>
              <button type="button" className="pill-btn" onClick={() => suspendRoute(rb, ra, 'directed')}>{code(network, rb)} → {code(network, ra)}</button>
            </>
          )}
        </div>
      )}
      {!ap && !route && <p className="hint">{t('sim.pickHint')}</p>}
    </section>
  );
}

function AdvancedSettings({ scenario: s, patch }: { scenario: SimulationScenario; patch: (p: Partial<SimulationScenario>) => void }) {
  const { t } = useI18n();
  const exploreTime = useAppStore((st) => st.exploreTime);
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
  const evalMs = parseIsoUtc(s.evaluationTime);
  return (
    <div className="sim-advanced">
      {seg(t('sim.model'), s.simulationModel, ['structural', 'temporal'] as const, (v) => `sim.model.${v}`, (v) => patch({ simulationModel: v }))}
      <p className="hint">{t(`sim.model.${s.simulationModel}.note`)}</p>
      {seg(t('sim.baseline'), s.baselineMode, ['fixed', 'dynamic'] as const, (v) => `sim.baseline.${v}`, (v) => {
        patch({ baselineMode: v });
        if (v === 'dynamic' && exploreTime !== 'temporal') useAppStore.getState().setExploreTime('temporal');
      })}
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
      {s.baselineMode === 'fixed' && s.simulationModel === 'structural' && (
        <div className="field">
          <span className="field-label">{t('sim.evaluation')}</span>
          <label className="sim-check">
            <input type="checkbox" checked={s.evaluationTime !== null}
              onChange={(e) => patch({ evaluationTime: e.target.checked ? (s.events.find((x) => x.startTimeUtc)?.startTimeUtc ?? s.analysisStart) : null })} />
            <span className="small">{t('sim.evaluation.at')}</span>
          </label>
          {s.evaluationTime !== null && evalMs !== null && (
            <div className="sim-row">
              <button type="button" className="icon-btn" aria-label={t('sim.evaluation.prev')} onClick={() => patch({ evaluationTime: isoMinute(evalMs - HOUR_MS) })}><Icon name="prev" /></button>
              <input type="datetime-local" step={60} value={toInput(s.evaluationTime)} aria-label={t('sim.evaluation')}
                onChange={(e) => { const ms = fromInput(e.target.value); if (ms !== null) patch({ evaluationTime: isoMinute(ms) }); }} />
              <button type="button" className="icon-btn" aria-label={t('sim.evaluation.next')} onClick={() => patch({ evaluationTime: isoMinute(evalMs + HOUR_MS) })}><Icon name="next" /></button>
            </div>
          )}
          <p className="hint">{t(s.evaluationTime === null ? 'sim.evaluation.noneNote' : 'sim.evaluation.atNote')}</p>
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

function ViewToggle() {
  const { t } = useI18n();
  const view = useAppStore((s) => s.simView);
  const setView = useAppStore((s) => s.setSimView);
  return (
    <div className="field">
      <span className="field-label">{t('sim.view')}</span>
      <div className="segmented" role="radiogroup" aria-label={t('sim.view')}>
        {(['overlay', 'after', 'before'] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'is-active' : ''} onClick={() => setView(v)}>{t(`sim.view.${v}`)}</button>
        ))}
      </div>
    </div>
  );
}

function ExportBar({ scenario }: { scenario: SimulationScenario }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const status = useAppStore((s) => s.simStatus);
  const impact = useAppStore((s) => s.simImpact);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const out = status.state === 'ready' ? status.output : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;
  const base = out ? `1090web_sim_${scenarioHash(scenario, out.window)}` : '1090web_sim';
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
        // a dynamic baseline counts the events that overlap the window: the same as no evaluation time
        evaluationTime: scenario.baselineMode === 'fixed' && scenario.simulationModel === 'structural' ? scenario.evaluationTime : null,
        timeProxy: scenario.filters.timeProxy, events: scenario.events, name: scenario.name,
      },
    });
    st.setResearchCompare({ enabled: true, field: 'scenario', value: 'off' });
    st.setResearchTab('comparison');
    st.setAppMode('research');
  };
  const load = (file: File) => {
    void file.text().then((text) => {
      const st = useAppStore.getState();
      const range = { s: Date.UTC(2026, 0, 1), e: Date.UTC(2026, 9, 1) };
      const ctx = scenarioContext(network, scenario.datasetVersion, range.s, range.e);
      const r = parseScenario(text, ctx);
      if (!r.scenario) {
        setMsg({ ok: false, lines: r.issues.map((i) => issueText(t, i)) });
        return;
      }
      st.setSimScenario(r.scenario);
      if (r.scenario.baselineMode === 'dynamic' && st.exploreTime !== 'temporal') st.setExploreTime('temporal');
      setMsg({ ok: true, lines: [t('sim.load.ok', { hash: scenarioHash(r.scenario) }), ...r.issues.map((i) => issueText(t, i))] });
    });
  };
  return (
    <section className="sim-section">
      <span className="field-label">{t('sim.save')}</span>
      <div className="sim-actions">
        <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_scenario.json`, scenarioJson(scenario), 'application/json')}>{t('sim.save.scenario')}</button>
        <button type="button" className="pill-btn" onClick={() => fileRef.current?.click()}>{t('sim.load')}</button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="r-file" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) load(f);
          e.target.value = '';
        }} />
        <button type="button" className="pill-btn" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setMsg({ ok: true, lines: [t('sim.link.copied')] }); }}>{t('sim.link')}</button>
      </div>
      {out && (
        <div className="sim-actions">
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_result.json`, resultJson(scenario, out, imp), 'application/json')}>{t('sim.export.json')}</button>
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_metrics.csv`, metricsCsv(scenario, out, imp))}>{t('sim.export.metrics')}</button>
          <button type="button" className="pill-btn" disabled={!imp} onClick={() => imp && downloadText(`${base}_airports.csv`, airportsCsv(scenario, out, imp, network))}>{t('sim.export.airports')}</button>
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_routes.csv`, routesCsv(scenario, out, network))}>{t('sim.export.routes')}</button>
          <button type="button" className="pill-btn" disabled={!imp} onClick={() => imp && downloadText(`${base}_lost_pairs.csv`, lostPairsCsv(scenario, out, imp, network))}>{t('sim.export.paths')}</button>
          <button type="button" className="pill-btn" onClick={() => downloadText(`${base}_areas.csv`, areasCsv(scenario, out))}>{t('sim.export.areas')}</button>
        </div>
      )}
      {out && <button type="button" className="primary-btn sim-research" onClick={toResearch}>{t('sim.toResearch')}</button>}
      {msg && <ul className={msg.ok ? 'r-mini' : 'r-mini r-warn-text'}>{msg.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
    </section>
  );
}

function Assumptions({ model }: { model: SimulationScenario['simulationModel'] }) {
  const { t } = useI18n();
  return (
    <details className="sim-section sim-assumptions">
      <summary className="field-label">{t('sim.assumptions')}</summary>
      <p className="small">{t('sim.assumptions.sim')}</p>
      <ul className="r-mini">
        {(['complete', 'noReroute', 'hypothetical', 'graph', ...(model === 'temporal' ? ['proxy'] : [])] as const).map((k) => <li key={k}>{t(`sim.assume.${k}` as MessageKey)}</li>)}
      </ul>
      <p className="small">{t('sim.assumptions.obs')}</p>
      <ul className="r-mini">
        {(['missing', 'startMissing', 'tiers', 'regions', 'gap'] as const).map((k) => <li key={k}>{t(`sim.obs.${k}`)}</li>)}
      </ul>
    </details>
  );
}
