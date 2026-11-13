import { useMemo } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { defaultConfig } from '../../research/model';
import { useAppStore } from '../../state/store';
import { anomalyDays, windowQuality } from '../../temporal/quality';
import { windowLabel, type MetaState } from '../../temporal/useTemporal';
import {
  clampCursor,
  clampWindow,
  cursorBounds,
  DAY_MS,
  defaultStep,
  formatUtc,
  HOUR_MS,
  parseUtc,
  stepSelection,
  STEPS_MS,
  utcDate,
  windowFor,
  WINDOW_PRESETS,
  type PlaybackSpeed,
  type TemporalCompare,
  type TemporalSelection,
  type TimeBasisFilter,
  type WindowPreset,
} from '../../temporal/window';
import { Icon } from '../common/Icon';

const STEP_CODE: Record<number, '1h' | '6h' | '1d' | '7d'> = { [HOUR_MS]: '1h', [6 * HOUR_MS]: '6h', [DAY_MS]: '1d', [7 * DAY_MS]: '7d' };

/** Monthly / Temporal switch shown in both timelines. */
export function TimeModeToggle() {
  const { t } = useI18n();
  const exploreTime = useAppStore((s) => s.exploreTime);
  const setExploreTime = useAppStore((s) => s.setExploreTime);
  const stress = useAppStore((s) => s.stressRouteCount);
  const kind = useAppStore((s) => s.network?.manifest.kind);
  if (kind !== 'observed') return null;
  const switchTo = (m: 'monthly' | 'temporal') => {
    if (m === exploreTime) return;
    const st = useAppStore.getState();
    const sel = st.temporalSel;
    setExploreTime(m);
    // the monthly view opens on the month the temporal cursor is in
    if (m === 'monthly' && sel && st.network) {
      const month = utcDate(windowFor(sel).startMs).slice(0, 7);
      const i = st.network.manifest.months.findIndex((x) => x.month === month);
      if (i >= 0) st.setMonthIndex(i);
    }
    // and the temporal view follows a month changed in the monthly view
    if (m === 'temporal' && sel && sel.preset !== 'custom' && st.network) {
      const month = st.network.manifest.months[st.monthIndex]?.month;
      if (month && utcDate(sel.cursorMs).slice(0, 7) !== month) {
        st.patchTemporalSel({ cursorMs: Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1) + (sel.preset.startsWith('rolling') ? DAY_MS : 0) });
      }
    }
  };
  return (
    <div className="segmented time-toggle" role="radiogroup" aria-label={t('t.mode.label')}>
      {(['monthly', 'temporal'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={exploreTime === m} className={exploreTime === m ? 'is-active' : ''}
          disabled={stress !== null} onClick={() => switchTo(m)}>
          {t(`t.mode.${m}`)}
        </button>
      ))}
    </div>
  );
}

function lengthText(t: ReturnType<typeof useI18n>['t'], ms: number): string {
  const h = ms / HOUR_MS;
  return h < 48 ? t('t.length.hours', { hours: Math.round(h * 10) / 10 }) : t('t.length.days', { days: Math.round((h / 24) * 10) / 10 });
}

const toInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);

export function TemporalTimeline({ meta }: { meta: MetaState }) {
  const { t, number } = useI18n();
  const sel = useAppStore((s) => s.temporalSel);
  const status = useAppStore((s) => s.temporalStatus);
  const playing = useAppStore((s) => s.temporalPlaying);
  const setPlaying = useAppStore((s) => s.setTemporalPlaying);
  const patch = useAppStore((s) => s.patchTemporalSel);
  const ready = meta.state === 'ready' ? meta.meta : null;
  const range = ready?.range ?? null;
  const markers = useMemo(() => (ready ? anomalyDays(ready.index) : []), [ready]);

  const result = status.state === 'ready' ? status.result : null;
  const quality = useMemo(() => {
    if (!ready) return null;
    if (status.state === 'ready') return windowQuality(ready.index, status.result.window, { flights: status.result.series.flights.reduce((a, b) => a + b, 0), missingDays: status.result.missingDays });
    if (status.state === 'error' && status.message !== 'outside') return windowQuality(ready.index, status.window, { flights: null, failed: true });
    return null;
  }, [ready, status]);

  if (meta.state === 'error') {
    return (
      <div className="timeline panel is-temporal" role="group" aria-label={t('t.timeline.label')}>
        <TimeModeToggle />
        <p className="hint warn">{t('t.metaError', { message: meta.message })}</p>
      </div>
    );
  }
  if (!range || !sel) {
    return (
      <div className="timeline panel is-temporal" role="status" aria-label={t('t.timeline.label')}>
        <TimeModeToggle />
        <div className="spinner" aria-hidden="true" />
        <span className="muted small">{t('t.metaLoading')}</span>
      </div>
    );
  }

  const w = windowFor(sel);
  // a result is shown only for the window currently selected (never an older one beside a newer label)
  const shownWindow = clampWindow(w, range)?.window ?? null;
  const fresh = result !== null && shownWindow !== null && result.window.startMs === shownWindow.startMs && result.window.endMs === shownWindow.endMs;
  const bounds = cursorBounds(sel.preset, range);
  const custom = sel.preset === 'custom';
  const coarse = sel.preset === 'day' || sel.preset === 'month';
  const sliderStep = coarse ? DAY_MS : HOUR_MS;
  const span = range.endMs - range.startMs;
  const pos = (ms: number) => `${(100 * (ms - range.startMs)) / span}%`;

  const set = (p: Partial<TemporalSelection>) => {
    setPlaying(false);
    patch(p);
  };
  const step = (n: number) => {
    const p = stepSelection(sel, n, range);
    if (p) set(p);
  };
  const toStart = () =>
    set(custom
      ? { customStartMs: range.startMs, customEndMs: range.startMs + (sel.customEndMs - sel.customStartMs) }
      : { cursorMs: clampCursor(range.startMs, sel.preset, range) });
  const setPreset = (preset: WindowPreset) => {
    if (preset === 'custom') {
      const cur = windowFor(sel);
      set({ preset, customStartMs: Math.max(cur.startMs, range.startMs), customEndMs: Math.min(cur.endMs, range.endMs) });
    } else {
      set({ preset, stepMs: defaultStep(preset), cursorMs: clampCursor(sel.cursorMs, preset, range) });
    }
  };
  const setDate = (v: string) => {
    const d = parseUtc(v);
    if (d === null) return;
    set({ cursorMs: clampCursor(d + (sel.cursorMs - Math.floor(sel.cursorMs / DAY_MS) * DAY_MS), sel.preset, range) });
  };
  const setHour = (h: number) => set({ cursorMs: clampCursor(Math.floor(sel.cursorMs / DAY_MS) * DAY_MS + h * HOUR_MS, sel.preset, range) });
  const setCustom = (k: 'customStartMs' | 'customEndMs', v: string) => {
    const ms = parseUtc(v);
    if (ms !== null) set({ [k]: Math.floor(ms / HOUR_MS) * HOUR_MS });
  };
  const toResearch = () => {
    const st = useAppStore.getState();
    const shown = result?.window ?? w;
    const month = utcDate(shown.startMs).slice(0, 7);
    const months = st.network?.manifest.months.map((m) => m.month) ?? [];
    const base = st.researchConfig ?? defaultConfig(months.includes(month) ? month : months[months.length - 1] ?? month);
    st.setTemporalPlaying(false);
    st.setResearchConfig({
      ...base,
      month: months.includes(month) ? month : base.month,
      window: { startMs: shown.startMs, endMs: shown.endMs, basis: sel.basis, preset: sel.preset, stepMs: sel.stepMs },
      minFlights: 1,
    });
    st.setAppMode('research');
  };

  const cursorHour = new Date(sel.cursorMs).getUTCHours();
  const fallbackShare = result && result.trackStart + result.fallback > 0 ? result.fallback / (result.trackStart + result.fallback) : 0;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const qualityText = quality?.flags.map((f) =>
    f === 'gap' ? t('t.q.gap', { hours: quality.gapHours, days: quality.gapDays.join(', ') })
      : f === 'missingFile' ? t('t.q.missingFile', { days: quality.missingDays.join(', ') })
        : f === 'zeroFiltered' ? t('t.q.zeroFiltered', { world: number(quality.worldFlights) })
          : t(`t.q.${f}`),
  ) ?? [];

  return (
    <div className="timeline panel is-temporal" role="group" aria-label={t('t.timeline.label')}>
      <div className="t-row">
        <TimeModeToggle />
        <div className="timeline-buttons">
          <button type="button" className="icon-btn" onClick={toStart} aria-label={t('t.start')} title={t('t.start')}><Icon name="first" /></button>
          <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label={t('t.prev')} title={t('t.prev')}><Icon name="prev" /></button>
          <button type="button" className={`icon-btn play ${playing ? 'is-active' : ''}`} onClick={() => setPlaying(!playing)}
            aria-label={playing ? t('t.pause') : t('t.play')} title={playing ? t('t.pause') : t('t.play')}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button type="button" className="icon-btn" onClick={() => step(1)} aria-label={t('t.next')} title={t('t.next')}><Icon name="next" /></button>
        </div>
        <div className="timeline-track">
          <div className="timeline-current">
            <strong className="mono-num">{windowLabel(w)}</strong>
            <span className="muted small" role="status">
              {status.state === 'loading'
                ? t('t.status.loading', { done: status.done, total: status.total })
                : status.state === 'error'
                  ? status.message === 'outside'
                    ? t('t.status.outside', { start: formatUtc(range.startMs), end: formatUtc(range.endMs) })
                    : t('t.status.error', { message: status.message })
                  : result && fresh
                    ? [
                        lengthText(t, result.window.endMs - result.window.startMs),
                        t('t.status.flights', { flights: number(result.flights) }),
                        t('t.status.fallback', { share: pct(fallbackShare) }),
                        result.clipped ? t('t.status.clipped') : null,
                        result.fromCache ? t('t.status.cached') : t('t.status.elapsed', { ms: result.elapsedMs }),
                      ].filter(Boolean).join(' · ')
                    : '…'}
            </span>
          </div>
          {custom ? (
            <div className="t-strip" aria-hidden="true">
              <span className="t-window" style={{ left: pos(Math.max(w.startMs, range.startMs)), width: `${(100 * Math.max(0, Math.min(w.endMs, range.endMs) - Math.max(w.startMs, range.startMs))) / span}%` }} />
              {markers.map((m) => <span key={m.day} className={`t-marker ${m.evidence === 'collection_gap' ? 'is-gap' : ''}`} style={{ left: pos(m.startMs), width: `${(100 * DAY_MS) / span}%` }} />)}
            </div>
          ) : (
            <div className="t-slider">
              <input type="range" className="timeline-range" min={bounds.min} max={bounds.max} step={sliderStep}
                value={Math.min(bounds.max, Math.max(bounds.min, sel.cursorMs))}
                aria-label={t('t.timeline.label')} aria-valuetext={windowLabel(w)}
                onChange={(e) => set({ cursorMs: clampCursor(Number(e.target.value), sel.preset, range) })} />
              <div className="t-strip" aria-hidden="true">
                <span className="t-window" style={{ left: pos(Math.max(w.startMs, range.startMs)), width: `${(100 * Math.max(0, Math.min(w.endMs, range.endMs) - Math.max(w.startMs, range.startMs))) / span}%` }} />
                {markers.map((m) => (
                  <span key={m.day} className={`t-marker ${m.evidence === 'collection_gap' ? 'is-gap' : ''}`} style={{ left: pos(m.startMs), width: `${(100 * DAY_MS) / span}%` }}
                    title={`${m.day}: ${m.evidence === 'collection_gap' ? t('t.gapMarker') : t('t.anomalyMarker')}`} />
                ))}
              </div>
            </div>
          )}
          {status.state === 'loading' && (
            <div className="r-progress-bar t-progress"><span style={{ width: `${status.total ? (100 * status.done) / status.total : 0}%` }} /></div>
          )}
        </div>
        <button type="button" className="pill-btn t-research" onClick={toResearch} disabled={!result}>{t('t.toResearch')}</button>
      </div>

      <div className="t-row t-controls">
        <label className="t-field">
          <span className="muted small">{t('t.preset')}</span>
          <select value={sel.preset} onChange={(e) => setPreset(e.target.value as WindowPreset)}>
            {WINDOW_PRESETS.map((p) => <option key={p} value={p}>{t(`t.preset.${p}`)}</option>)}
          </select>
        </label>
        {custom ? (
          <>
            <label className="t-field">
              <span className="muted small">{t('t.customStart')}</span>
              <input type="datetime-local" step={3600} min={toInput(range.startMs)} max={toInput(range.endMs)} value={toInput(sel.customStartMs)} onChange={(e) => setCustom('customStartMs', e.target.value)} />
            </label>
            <label className="t-field">
              <span className="muted small">{t('t.customEnd')}</span>
              <input type="datetime-local" step={3600} min={toInput(range.startMs)} max={toInput(range.endMs)} value={toInput(sel.customEndMs)} onChange={(e) => setCustom('customEndMs', e.target.value)} />
            </label>
            {sel.customEndMs <= sel.customStartMs && <span className="hint warn">{t('t.customInvalid')}</span>}
          </>
        ) : (
          <>
            <label className="t-field">
              <span className="muted small">{t('t.date')}</span>
              <input type="date" min={utcDate(range.startMs)} max={utcDate(range.endMs - 1)} value={utcDate(sel.cursorMs)} onChange={(e) => setDate(e.target.value)} />
            </label>
            {!coarse && (
              <label className="t-field">
                <span className="muted small">{t('t.hour')}</span>
                <select value={cursorHour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <label className="t-field">
          <span className="muted small">{t('t.step')}</span>
          {sel.preset === 'month' ? (
            <select value="month" disabled><option value="month">{t('t.step.month')}</option></select>
          ) : (
            <select value={sel.stepMs} onChange={(e) => set({ stepMs: Number(e.target.value) })}>
              {STEPS_MS.map((s) => <option key={s} value={s}>{t(`t.step.${STEP_CODE[s]!}`)}</option>)}
            </select>
          )}
        </label>
        <label className="t-field">
          <span className="muted small">{t('t.speed')}</span>
          <select value={sel.speed} onChange={(e) => patch({ speed: e.target.value as PlaybackSpeed })}>
            {(['slow', 'normal', 'fast'] as const).map((s) => <option key={s} value={s}>{t(`t.speed.${s}`)}</option>)}
          </select>
        </label>
        <label className="t-field t-check">
          <input type="checkbox" checked={sel.loop} onChange={(e) => patch({ loop: e.target.checked })} />
          <span className="small">{t('t.loop')}</span>
        </label>
        <label className="t-field">
          <span className="muted small">{t('t.basis')}</span>
          <select value={sel.basis} onChange={(e) => set({ basis: e.target.value as TimeBasisFilter })}>
            <option value="all">{t('t.basis.all')}</option>
            <option value="start">{t('t.basis.start')}</option>
          </select>
        </label>
        <label className="t-field">
          <span className="muted small">{t('t.compare')}</span>
          <select value={sel.compare} onChange={(e) => set({ compare: e.target.value as TemporalCompare })}>
            {(['off', 'previous', 'day', 'week'] as const).map((c) => <option key={c} value={c}>{t(`t.compare.${c}`)}</option>)}
          </select>
        </label>
      </div>

      {(qualityText.length > 0 || (sel.basis === 'start' && result)) && (
        <div className="t-row t-notes">
          {sel.basis === 'start' && result && (
            <span className="hint">{t('t.basisWarning', { excluded: number(result.fallback), share: pct(fallbackShare) })}</span>
          )}
          {qualityText.map((q) => <span key={q} className="hint warn">{q}</span>)}
        </div>
      )}
    </div>
  );
}
