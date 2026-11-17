import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDatasetId } from '../../app/config';
import { airportContinents, continentRule, type ResearchMeta, type ResearchMonth } from '../../research/data';
import { REGIONS, type ResearchConfig } from '../../research/model';
import { loadConfigMonth } from '../../research/useResearch';
import { ExperimentClient, planExperiment, runExperiment, CancelledRun, type ExperimentDeps, type RunProgress } from '../../experiments/engine';
import {
  checkImport, definitionProblems, IMPORT_MAX_BYTES, newDefinition, SENSITIVITY_PRESETS, toBatchDefinition,
  type CombineRule, type Condition, type ExperimentDefinition, type ExperimentType, type MissingnessModel,
} from '../../experiments/model';
import { useI18n } from '../../i18n/useI18n';
import { useAppStore } from '../../state/store';
import { Note } from './common';
import { ExperimentResults } from './ExperimentResults';
import { downloadText, useFormat } from './format';

type PresetKey = keyof typeof SENSITIVITY_PRESETS;
const SOURCE_CHOICES = [256, 1024, 2048, null] as const;
const TOP_CHOICES = [10, 30, 50, 100] as const;
const COMBINE: CombineRule[] = ['max', 'either', 'both', 'origin', 'destination'];

/** Research Mode > Experiments: set up, run (or import) and read robustness experiments. */
export function ExperimentsPanel({ config, meta, onShowOnMap }: { config: ResearchConfig; meta: ResearchMeta; onShowOnMap: (airport: number | null) => void }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const experiment = useAppStore((s) => s.experiment);
  const setExperiment = useAppStore((s) => s.setExperiment);
  const handoff = useAppStore((s) => s.experimentHandoff);
  const setHandoff = useAppStore((s) => s.setExperimentHandoff);
  const datasetId = resolveDatasetId();

  if (experiment) {
    return (
      <ExperimentResults
        state={experiment}
        highlight={handoff?.airports ?? []}
        onShowOnMap={onShowOnMap}
        onClose={() => setExperiment(null)}
      />
    );
  }
  return (
    <ExperimentSetup
      key={`${datasetId}:${handoff?.scenarioName ?? ''}`}
      config={config}
      meta={meta}
      network={network}
      datasetId={datasetId}
      handoff={handoff}
      onClearHandoff={() => setHandoff(null)}
      t={t}
    />
  );
}

function ExperimentSetup({ config, meta, network, datasetId, handoff, onClearHandoff, t }: {
  config: ResearchConfig;
  meta: ResearchMeta;
  network: NonNullable<ReturnType<typeof useAppStore.getState>['network']>;
  datasetId: string;
  handoff: ReturnType<typeof useAppStore.getState>['experimentHandoff'];
  onClearHandoff: () => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const f = useFormat();
  const setExperiment = useAppStore((s) => s.setExperiment);
  const [advanced, setAdvanced] = useState(false);
  const [preset, setPreset] = useState<PresetKey>('tiersThresholds');
  const [def, setDef] = useState<ExperimentDefinition>(() => withPreset(newDefinition(config, datasetId, 'sensitivity'), 'tiersThresholds', handoff?.airports));
  const [month, setMonth] = useState<{ key: string; month: ResearchMonth } | { key: string; error: string } | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const client = useMemo(() => new ExperimentClient(), []);
  useEffect(() => () => client.dispose(), [client]);
  const fileRef = useRef<HTMLInputElement>(null);

  // the baseline follows the conditions on the left (month / window / scope / scenario)
  const baseKey = JSON.stringify([config.month, config.window, config.scenario?.name, config.scenario?.events.length, config.scenario?.evaluationTime]);
  useEffect(() => {
    let alive = true;
    loadConfigMonth(network, config, 'experiments:baseline')
      .then((m) => alive && setMonth({ key: baseKey, month: m }))
      .catch((e: unknown) => alive && setMonth({ key: baseKey, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, network]);

  const fullDef = useMemo<ExperimentDefinition>(() => ({
    ...def,
    baseline: { ...def.baseline, research: { ...config, directed: def.baseline.directed ?? true } },
  }), [def, config]);
  const deps = useMemo<ExperimentDeps | null>(() => {
    if (!month || month.key !== baseKey || !('month' in month)) return null;
    return {
      network,
      scope: { network, continentOf: airportContinents(network, meta.quality), persistence: meta.persistence },
      month: month.month,
      datasetId,
      datasetVersion: meta.manifest.datasetVersion,
      continentRule: continentRule(meta.quality),
    };
  }, [month, baseKey, network, meta, datasetId]);
  const problems = definitionProblems(fullDef);
  const plan = useMemo(() => (deps && !problems.length ? planExperiment(fullDef, deps) : null), [deps, fullDef, problems.length]);
  const batch = toBatchDefinition(fullDef);

  const set = (patch: Partial<ExperimentDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const setType = (type: ExperimentType) => setDef((d) => (type === 'sensitivity'
    ? withPreset({ ...d, experimentType: type, missingness: undefined, repetitions: undefined }, preset, handoff?.airports)
    : { ...d, experimentType: type, conditions: undefined, missingness: d.missingness ?? { model: 'uniform', rate: 0.1 }, repetitions: d.repetitions ?? 10 }));
  const setModel = (m: MissingnessModel) => set({ missingness: m });

  const run = () => {
    if (!plan || !deps) return;
    setRunError(null);
    setProgress({ run: 0, runs: plan.runs.length, label: '', done: 0, total: plan.candidates.length, elapsedMs: 0 });
    const ap = (id: string) => {
      const i = network.airportIndexById.get(id)!;
      const a = network.airports[i]!;
      return { id, iata: a.iata, name: a.name, country: a.country, continent: deps.scope.continentOf[i] ?? '', lat: a.lat, lon: a.lon };
    };
    runExperiment(fullDef, plan, deps, client, setProgress, ap)
      .then((result) => {
        setProgress(null);
        setExperiment({ result, origin: 'browser', warnings: result.complete ? [] : ['x.import.incomplete'] });
      })
      .catch((e: unknown) => {
        setProgress(null);
        if (!(e instanceof CancelledRun)) setRunError(e instanceof Error ? e.message : String(e));
      });
  };

  const importFile = (file: File) => {
    setImportMsg(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setImportMsg(t('x.import.tooLarge', { mb: Math.round(IMPORT_MAX_BYTES / 1e6) }));
      return;
    }
    void file.text().then((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        setImportMsg(t('x.import.notJson'));
        return;
      }
      const r = checkImport(raw, datasetId, meta.manifest.datasetVersion, continentRule(meta.quality));
      if (!r.ok) setImportMsg(t(r.error as never));
      else setExperiment({ result: r.result, origin: file.name, warnings: r.warnings });
    });
  };

  const m = fullDef.missingness;
  const running = progress !== null;
  return (
    <div className="r-stack">
      <section className="r-box">
        <h4 className="r-h4">{t('x.title')}</h4>
        <p className="small">{t('x.intro')}</p>
        {handoff && (
          <Note>
            {t('x.handoff', { name: handoff.scenarioName || '—', airports: handoff.airports.join(', ') || '—' })}
            {handoff.otherEvents > 0 && ` ${t('x.handoff.other', { n: handoff.otherEvents })}`}
            {' '}<button type="button" className="link-btn" onClick={onClearHandoff}>{t('x.handoff.clear')}</button>
          </Note>
        )}
        <p className="small"><strong>{t('x.baseline')}</strong> {t('x.baseline.note')}</p>
        {config.scenario && <Note warn>{t('x.baseline.scenario', { name: config.scenario.name })}</Note>}
      </section>

      <section className="r-box">
        <div className="r-toolbar">
          <div className="segmented" role="radiogroup" aria-label={t('x.type')}>
            {(['sensitivity', 'missingness'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={def.experimentType === k} className={def.experimentType === k ? 'is-active' : ''} disabled={running} onClick={() => setType(k)}>{t(`x.type.${k}`)}</button>
            ))}
          </div>
          <div className="segmented" role="radiogroup" aria-label={t('x.mode')}>
            {([false, true] as const).map((a) => (
              <button key={String(a)} type="button" role="radio" aria-checked={advanced === a} className={advanced === a ? 'is-active' : ''} onClick={() => setAdvanced(a)}>{t(a ? 'x.mode.advanced' : 'x.mode.quick')}</button>
            ))}
          </div>
        </div>
        <p className="small">{t(`x.type.${def.experimentType}.desc`)}</p>

        {def.experimentType === 'sensitivity' && (
          <label className="r-inline">
            <span className="small">{t('x.preset')}</span>
            <select className="r-input" value={preset} disabled={running} onChange={(e) => {
              const p = e.target.value as PresetKey;
              setPreset(p);
              setDef((d) => withPreset(d, p, handoff?.airports));
            }}>
              {(Object.keys(SENSITIVITY_PRESETS) as PresetKey[]).map((k) => <option key={k} value={k}>{t(`x.preset.${k}`)}</option>)}
            </select>
          </label>
        )}
        {def.experimentType === 'sensitivity' && <p className="small x-dim">{(fullDef.conditions ?? []).map((c) => c.id).join(' · ')}</p>}
        {def.experimentType === 'sensitivity' && <Note>{t('x.t1.note')}</Note>}

        {def.experimentType === 'missingness' && m && (
          <div className="r-stack x-model">
            <label className="r-inline">
              <span className="small">{t('x.model')}</span>
              <select className="r-input" value={m.model} disabled={running} onChange={(e) => setModel(defaultModel(e.target.value as MissingnessModel['model']))}>
                {(['uniform', 'regional', 'route'] as const).map((k) => <option key={k} value={k}>{t(`x.model.${k}`)}</option>)}
              </select>
            </label>
            <p className="small">{t(`x.model.${m.model}.desc`)}</p>
            {m.model === 'uniform' && <RateInput label={t('x.rate')} value={m.rate} onChange={(rate) => setModel({ ...m, rate })} disabled={running} />}
            {m.model === 'regional' && (
              <>
                {REGIONS.map((r) => (
                  <RateInput key={r} label={t(`r.region.${r}` as never)} value={m.regionRates[r] ?? m.otherRate} disabled={running}
                    onChange={(v) => setModel({ ...m, regionRates: { ...m.regionRates, [r]: v } })} />
                ))}
                <RateInput label={t('x.rate.other')} value={m.otherRate} onChange={(otherRate) => setModel({ ...m, otherRate })} disabled={running} />
                <label className="r-inline">
                  <span className="small">{t('x.combine')}</span>
                  <select className="r-input" value={m.combine} disabled={running} onChange={(e) => setModel({ ...m, combine: e.target.value as CombineRule })}>
                    {COMBINE.map((c) => <option key={c} value={c}>{t(`x.combine.${c}`)}</option>)}
                  </select>
                </label>
              </>
            )}
            {m.model === 'route' && (
              <>
                <label className="r-inline">
                  <span className="small">{t('x.route.threshold')}</span>
                  <input className="r-input" type="number" min={1} step={1} value={m.lowFrequency.threshold} disabled={running}
                    onChange={(e) => setModel({ ...m, lowFrequency: { ...m.lowFrequency, threshold: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} />
                </label>
                <RateInput label={t('x.route.rateLow')} value={m.lowFrequency.rateLow} onChange={(rateLow) => setModel({ ...m, lowFrequency: { ...m.lowFrequency, rateLow } })} disabled={running} />
                <RateInput label={t('x.route.rateOther')} value={m.lowFrequency.rateOther} onChange={(rateOther) => setModel({ ...m, lowFrequency: { ...m.lowFrequency, rateOther } })} disabled={running} />
                <label className="r-inline">
                  <span className="small">{t('x.route.unit')}</span>
                  <select className="r-input" value={m.lowFrequency.unit} disabled={running} onChange={(e) => setModel({ ...m, lowFrequency: { ...m.lowFrequency, unit: e.target.value as 'flight' | 'route' } })}>
                    <option value="flight">{t('x.route.unit.flight')}</option>
                    <option value="route">{t('x.route.unit.route')}</option>
                  </select>
                </label>
                <p className="small x-dim">{t('x.route.period')}</p>
              </>
            )}
            <label className="r-inline">
              <span className="small">{t('x.repetitions')}</span>
              <select className="r-input" value={def.repetitions} disabled={running} onChange={(e) => set({ repetitions: Number(e.target.value) })}>
                {[10, 30].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <p className="small x-dim">{t('x.repetitions.batch')}</p>
          </div>
        )}

        {advanced && (
          <div className="x-advanced">
            <label className="r-inline">
              <span className="small">{t('x.candidates')}</span>
              <select className="r-input" disabled={running}
                value={def.candidates === 'all' ? 'all' : Array.isArray(def.candidates) ? 'list' : String(def.candidates.top)}
                onChange={(e) => set({ candidates: e.target.value === 'all' ? 'all' : { top: Number(e.target.value), by: 'degree' } })}>
                {TOP_CHOICES.map((n) => <option key={n} value={n}>{t('x.candidates.top', { n })}</option>)}
                <option value="all">{t('x.candidates.all')}</option>
                {Array.isArray(def.candidates) && <option value="list">{t('x.candidates.list')}</option>}
              </select>
            </label>
            <label className="r-inline">
              <span className="small">{t('x.sources')}</span>
              <select className="r-input" disabled={running} value={String(def.computation.sources)}
                onChange={(e) => set({ computation: { ...def.computation, sources: e.target.value === 'null' ? null : Number(e.target.value) } })}>
                {SOURCE_CHOICES.map((k) => <option key={String(k)} value={String(k)}>{k === null ? t('x.sources.exact') : t('x.sources.k', { k })}</option>)}
              </select>
            </label>
            <label className="r-inline">
              <span className="small">{t('x.direction')}</span>
              <select className="r-input" disabled={running} value={String(def.baseline.directed ?? true)} onChange={(e) => set({ baseline: { ...def.baseline, directed: e.target.value === 'true' } })}>
                <option value="true">{t('x.directed')}</option>
                <option value="false">{t('x.undirected')}</option>
              </select>
            </label>
            <label className="r-inline">
              <span className="small">{t('x.seed')}</span>
              <input className="r-input" type="number" step={1} value={def.randomSeed} disabled={running} onChange={(e) => set({ randomSeed: Math.round(Number(e.target.value) || 0) })} />
            </label>
            <label className="r-inline">
              <span className="small">{t('x.sourceSeed')}</span>
              <input className="r-input" type="number" step={1} value={def.computation.sourceSeed} disabled={running}
                onChange={(e) => set({ computation: { ...def.computation, sourceSeed: Math.round(Number(e.target.value) || 0) } })} />
            </label>
            <p className="small x-dim">{t('x.seed.note')}</p>
          </div>
        )}
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('x.cost')}</h4>
        {month && 'error' in month && <p className="hint warn">{month.error}</p>}
        {!plan && !problems.length && !(month && 'error' in month) && <p className="small x-dim">{t('x.cost.loading')}</p>}
        {problems.map((p) => <p key={p} className="hint warn">{t(p as never)}</p>)}
        {plan && (
          <>
            <p className="small">
              {t('x.cost.summary', {
                runs: plan.runs.length, candidates: f.int(plan.candidates.length), nodes: f.int(plan.reference.airports.length),
                bfs: f.int(plan.cost.bfs), time: duration(plan.cost.seconds, t),
              })}
            </p>
            {plan.cost.level !== 'ok' && <Note warn>{t(plan.cost.level === 'slow' ? 'x.cost.slow' : 'x.cost.batch')}</Note>}
            {def.computation.sources !== null && <p className="small x-dim">{t('x.cost.sampled', { k: def.computation.sources })}</p>}
          </>
        )}
        <div className="r-buttons">
          {!running && <button type="button" className="primary-btn" disabled={!plan} onClick={run}>{t('x.run')}</button>}
          {running && <button type="button" className="pill-btn" onClick={() => client.cancel()}>{t('x.cancel')}</button>}
          <button type="button" className="pill-btn" disabled={!batch.ok} title={batch.ok ? t('x.batch.title') : t(batch.reason as never)}
            onClick={() => batch.ok && downloadText(`1090web_experiment_${fullDef.experimentId}.json`, JSON.stringify(batch.definition, null, 1), 'application/json')}>
            {t('x.batch.export')}
          </button>
          <button type="button" className="pill-btn" disabled={running} onClick={() => fileRef.current?.click()}>{t('x.import')}</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="r-file" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importFile(file);
            e.target.value = '';
          }} />
        </div>
        {!batch.ok && <p className="small x-dim">{t(batch.reason as never)}</p>}
        <p className="small x-dim">{t('x.import.note')}</p>
        {importMsg && <p className="hint warn">{importMsg}</p>}
        {runError && <p className="hint warn">{runError}</p>}
        {progress && <RunStatus p={progress} t={t} />}
      </section>
    </div>
  );
}

function RunStatus({ p, t }: { p: RunProgress; t: ReturnType<typeof useI18n>['t'] }) {
  const share = p.runs ? (Math.max(0, p.run - 1) + (p.total ? p.done / p.total : 0)) / p.runs : 0;
  const pct = Math.round(100 * share);
  const left = share > 0.02 ? (p.elapsedMs / share - p.elapsedMs) / 1000 : null;
  return (
    <div className="r-progress" role="status">
      <div className="spinner" aria-hidden="true" />
      <span>{t('x.progress', { run: Math.max(1, p.run), runs: p.runs, label: p.label, done: p.done, total: p.total, pct })}{left !== null ? ` · ${t('x.progress.left', { time: duration(left, t) })}` : ''}</span>
      <div className="r-progress-bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function RateInput({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="r-inline">
      <span className="small">{label}</span>
      <span className="x-rate">
        <input className="r-input" type="number" min={0} max={100} step={1} value={Math.round(value * 1000) / 10} disabled={disabled}
          onChange={(e) => onChange(Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)))} />
        <span className="small">%</span>
      </span>
    </label>
  );
}

function withPreset(d: ExperimentDefinition, p: PresetKey, include?: string[]): ExperimentDefinition {
  const base: Condition[] = SENSITIVITY_PRESETS[p];
  return { ...d, conditions: base.map((c) => ({ ...c })), include: include?.length ? include : undefined };
}

function defaultModel(kind: MissingnessModel['model']): MissingnessModel {
  if (kind === 'uniform') return { model: 'uniform', rate: 0.1 };
  if (kind === 'regional') return { model: 'regional', regionRates: { AF: 0.3, SA: 0.2, AS: 0.15, OC: 0.15 }, otherRate: 0.05, combine: 'max' };
  return { model: 'route', lowFrequency: { threshold: 4, rateLow: 0.3, rateOther: 0, unit: 'flight' }, thresholdPeriod: 'baseline network (both directions)' };
}

function duration(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  if (seconds < 1) return t('x.time.lt1s');
  if (seconds < 90) return t('x.time.s', { n: Math.round(seconds) });
  if (seconds < 5400) return t('x.time.min', { n: Math.round(seconds / 60) });
  return t('x.time.h', { n: Math.round(seconds / 360) / 10 });
}

