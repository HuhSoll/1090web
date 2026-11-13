import { useMemo, useState } from 'react';
import { searchAirports } from '../../domain/search';
import { useI18n } from '../../i18n/useI18n';
import { CLASSES, defaultConfig, REGIONS, THRESHOLD_PRESETS, type ResearchConfig, type TierSet } from '../../research/model';
import { useAppStore } from '../../state/store';
import { Note } from './common';
import { formatUtc, parseUtc } from '../../temporal/window';

const TIER_KEYS: Record<TierSet, 'r.tiers.A' | 'r.tiers.B' | 'r.tiers.C' | 'r.tiers.D'> = {
  A: 'r.tiers.A',
  B: 'r.tiers.B',
  C: 'r.tiers.C',
  D: 'r.tiers.D',
};

/** UTC start / end of a time window. The inputs show UTC wall time; nothing is converted to local time. */
function WindowFields({ config }: { config: ResearchConfig }) {
  const { t } = useI18n();
  const patch = useAppStore((s) => s.patchResearchConfig);
  const w = config.window!;
  const toInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  const set = (k: 'startMs' | 'endMs', v: string) => {
    const ms = parseUtc(v);
    if (ms === null) return;
    const next = { ...w, [k]: ms, preset: 'custom' };
    if (next.endMs > next.startMs) patch({ window: next, month: new Date(next.startMs).toISOString().slice(0, 7) });
  };
  const hours = (w.endMs - w.startMs) / 3_600_000;
  return (
    <div className="field">
      <label className="field-label" htmlFor="r-ws">{t('r.set.windowStart')}</label>
      <input id="r-ws" className="r-input" type="datetime-local" value={toInput(w.startMs)} onChange={(e) => set('startMs', e.target.value)} />
      <label className="field-label" htmlFor="r-we">{t('r.set.windowEnd')}</label>
      <input id="r-we" className="r-input" type="datetime-local" value={toInput(w.endMs)} onChange={(e) => set('endMs', e.target.value)} />
      <p className="hint">{t('r.set.windowSummary', { start: formatUtc(w.startMs), end: formatUtc(w.endMs), hours: Math.round(hours * 10) / 10 })}</p>
      <label className="field-label" htmlFor="r-wb">{t('t.basis')}</label>
      <select id="r-wb" value={w.basis} onChange={(e) => patch({ window: { ...w, basis: e.target.value as 'all' | 'start' } })}>
        <option value="all">{t('t.basis.all')}</option>
        <option value="start">{t('t.basis.start')}</option>
      </select>
      <Note>{t('r.set.windowNote')}</Note>
      {hours < 24 && <Note warn>{t('t.shortWindowNote')}</Note>}
    </div>
  );
}

export function SettingsPanel({ config }: { config: ResearchConfig }) {
  const { t, monthLabel, countryName, number } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const patch = useAppStore((s) => s.patchResearchConfig);
  const setConfig = useAppStore((s) => s.setResearchConfig);
  const [airportQuery, setAirportQuery] = useState('');
  const [carrierQuery, setCarrierQuery] = useState('');

  const countries = useMemo(() => {
    const set = new Set(network.airports.map((a) => a.country));
    return [...set].map((c) => ({ c, name: countryName(c) })).sort((x, y) => x.name.localeCompare(y.name));
  }, [network, countryName]);
  const airportHits = useMemo(() => searchAirports(network.airports, airportQuery, 6), [network, airportQuery]);
  const carrierHits = useMemo(() => {
    const q = carrierQuery.trim().toUpperCase();
    if (!q) return [];
    return network.carriers.filter((c) => c.id.startsWith(q)).slice(0, 6);
  }, [network, carrierQuery]);
  const area = config.country ? `C:${config.country}` : config.region ? `R:${config.region}` : '';
  const months = network.manifest.months;

  return (
    <div className="r-settings-body">
      <div className="field">
        <span className="field-label">{t('r.set.period')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('r.set.period')}>
          <button type="button" role="radio" aria-checked={!config.window} className={!config.window ? 'is-active' : ''} onClick={() => {
            patch({ window: null });
            if (useAppStore.getState().researchCompare.field === 'window') useAppStore.getState().setResearchCompare({ enabled: false });
          }}>
            {t('r.set.periodMonth')}
          </button>
          <button type="button" role="radio" aria-checked={!!config.window} className={config.window ? 'is-active' : ''}
            onClick={() => {
              if (config.window) return;
              if (useAppStore.getState().researchCompare.field === 'month') useAppStore.getState().setResearchCompare({ enabled: false });
              const start = Date.UTC(Number(config.month.slice(0, 4)), Number(config.month.slice(5, 7)) - 1, 1);
              patch({ window: { startMs: start, endMs: start + 86_400_000, basis: 'all', preset: 'day', stepMs: 86_400_000 }, minFlights: 1 });
            }}>
            {t('r.set.periodWindow')}
          </button>
        </div>
      </div>
      {!config.window ? (
        <div className="field">
          <label className="field-label" htmlFor="r-month">{t('r.set.month')}</label>
          <select id="r-month" value={config.month} onChange={(e) => patch({ month: e.target.value })}>
            {months.map((m) => (
              <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>
            ))}
          </select>
        </div>
      ) : (
        <WindowFields config={config} />
      )}

      <div className="field">
        <label className="field-label" htmlFor="r-area">{t('r.set.area')}</label>
        <select
          id="r-area"
          value={area}
          onChange={(e) => {
            const v = e.target.value;
            patch({ country: v.startsWith('C:') ? v.slice(2) : null, region: v.startsWith('R:') ? v.slice(2) : null });
          }}
        >
          <option value="">{t('r.set.areaWorld')}</option>
          <optgroup label={t('r.set.regions')}>
            {REGIONS.map((r) => (
              <option key={r} value={`R:${r}`}>{t(`r.region.${r}`)}</option>
            ))}
          </optgroup>
          <optgroup label={t('r.set.countries')}>
            {countries.map(({ c, name }) => (
              <option key={c} value={`C:${c}`}>{name}</option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.relation')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('r.set.relation')}>
          {(['all', 'domestic', 'international'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={config.relation === v} className={config.relation === v ? 'is-active' : ''} onClick={() => patch({ relation: v })}>
              {t(`r.relation.${v}`)}
            </button>
          ))}
        </div>
        <Note>{config.country || config.region ? t('r.relation.noteArea') : t('r.relation.noteWorld')}</Note>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.airport')}</span>
        {config.airport ? (
          <div className="r-chip">
            <span className="code">{config.airport}</span>
            <span className="muted small">{network.airports[network.airportIndexById.get(config.airport) ?? -1]?.name}</span>
            <button type="button" className="link-btn" onClick={() => patch({ airport: null })}>{t('r.set.clear')}</button>
          </div>
        ) : (
          <>
            <input className="r-input" type="search" value={airportQuery} placeholder={t('search.placeholder')} onChange={(e) => setAirportQuery(e.target.value)} />
            {airportHits.length > 0 && (
              <ul className="r-pick">
                {airportHits.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => { patch({ airport: a.id }); setAirportQuery(''); }}>
                      <span className="code">{a.iata ?? a.id}</span> {a.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <Note>{t('r.set.airportNote')}</Note>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.carrier')}</span>
        {config.carrier ? (
          <div className="r-chip">
            <span className="code">{config.carrier}</span>
            <button type="button" className="link-btn" onClick={() => patch({ carrier: null })}>{t('r.set.clear')}</button>
          </div>
        ) : (
          <>
            <input className="r-input" type="search" value={carrierQuery} placeholder={t('filters.carrierSearch')} onChange={(e) => setCarrierQuery(e.target.value)} />
            {carrierHits.length > 0 && (
              <ul className="r-pick">
                {carrierHits.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => { patch({ carrier: c.id }); setCarrierQuery(''); }}>
                      <span className="code">{c.id}</span> {c.flights !== undefined ? number(c.flights) : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <Note>{t('r.set.carrierNote')}</Note>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.classes')}</span>
        <div className="r-checks">
          {CLASSES.map((c) => (
            <label key={c} className="toggle-row">
              <input
                type="checkbox"
                checked={config.classes.includes(c)}
                disabled={config.classes.length === 1 && config.classes.includes(c)}
                onChange={(e) => patch({ classes: e.target.checked ? CLASSES.filter((x) => x === c || config.classes.includes(x)) : config.classes.filter((x) => x !== c) })}
              />
              <span>{t(`r.class.${c}`)}</span>
            </label>
          ))}
        </div>
        <Note>{t('r.set.classesNote')}</Note>
      </div>

      <div className="field">
        <div className="field-row">
          <label className="field-label" htmlFor="r-min">{t(config.window ? 'r.set.minFlightsWindow' : 'r.set.minFlights')}</label>
          <span className="field-value">≥ {config.minFlights}</span>
        </div>
        <div className="segmented">
          {THRESHOLD_PRESETS.map((v) => (
            <button key={v} type="button" className={config.minFlights === v ? 'is-active' : ''} onClick={() => patch({ minFlights: v })}>{v}</button>
          ))}
        </div>
        <input
          id="r-min"
          className="r-input"
          type="number"
          min={1}
          max={100000}
          value={config.minFlights}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (Number.isFinite(v) && v >= 1 && v <= 100000) patch({ minFlights: v });
          }}
        />
        <Note>{t(config.window ? 'r.set.minFlightsWindowNote' : 'r.set.minFlightsNote')}</Note>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="r-months">{t('r.set.minMonths')}</label>
        <select id="r-months" value={config.minMonths} onChange={(e) => patch({ minMonths: Number(e.target.value) })}>
          <option value={0}>{t('r.set.minMonthsOff')}</option>
          {months.map((_, i) => (
            <option key={i + 1} value={i + 1}>{t('r.set.minMonthsValue', { n: i + 1, total: months.length })}</option>
          ))}
        </select>
        <Note>{t('r.set.minMonthsNote')}</Note>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.tiers')}</span>
        <div className="r-radios" role="radiogroup" aria-label={t('r.set.tiers')}>
          {(['D', 'C', 'B', 'A'] as const).map((v) => (
            <label key={v} className="toggle-row">
              <input type="radio" name="r-tiers" checked={config.tiers === v} onChange={() => patch({ tiers: v })} />
              <span>{t(TIER_KEYS[v])}</span>
            </label>
          ))}
        </div>
        <Note warn={config.tiers !== 'D'}>{t('r.set.tiersNote')}</Note>
      </div>

      <div className="field">
        <span className="field-label">{t('r.set.graph')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('r.set.graph')}>
          {[false, true].map((v) => (
            <button key={String(v)} type="button" role="radio" aria-checked={config.directed === v} className={config.directed === v ? 'is-active' : ''} onClick={() => patch({ directed: v })}>
              {t(v ? 'r.graph.directed' : 'r.graph.undirected')}
            </button>
          ))}
        </div>
      </div>

      <details className="r-advanced">
        <summary>{t('r.set.advanced')}</summary>
        <div className="field">
          <label className="field-label" htmlFor="r-path">{t('r.set.pathMethod')}</label>
          <select id="r-path" value={config.pathMethod} onChange={(e) => patch({ pathMethod: e.target.value as ResearchConfig['pathMethod'] })}>
            <option value="auto">{t('r.path.auto')}</option>
            <option value="exact">{t('r.path.exact')}</option>
            <option value="sampled">{t('r.path.sampled')}</option>
          </select>
          <div className="r-inline">
            <label className="field-label" htmlFor="r-samples">{t('r.set.samples')}</label>
            <input id="r-samples" className="r-input" type="number" min={8} max={100000} value={config.samples}
              onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v >= 8 && v <= 100000) patch({ samples: v }); }} />
            <label className="field-label" htmlFor="r-seed">{t('r.set.seed')}</label>
            <input id="r-seed" className="r-input" type="number" min={0} value={config.seed}
              onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v >= 0 && v < 2 ** 31) patch({ seed: v }); }} />
          </div>
          <Note>{t('r.set.pathNote')}</Note>
        </div>
      </details>

      <button type="button" className="link-btn" onClick={() => setConfig(defaultConfig(config.month))}>{t('r.set.reset')}</button>
    </div>
  );
}
