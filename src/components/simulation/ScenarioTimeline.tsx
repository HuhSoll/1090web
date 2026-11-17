import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { useAppStore } from '../../state/store';
import { eventActiveAt } from '../../simulation/disruption';
import { isoDuration, isoMinute, parseIsoUtc, type SimulationEvent } from '../../simulation/model';
import { nextBoundary } from '../../simulation/series';
import { eventLabel } from '../../simulation/labels';
import { setEventTime, updateEvent } from '../../simulation/start';
import type { SimContext } from '../../simulation/useSimulation';
import { DAY_MS, formatUtc, HOUR_MS, type PlaybackSpeed, type WindowPreset } from '../../temporal/window';
import { Icon } from '../common/Icon';
import { useAdvisoryHistory, type Bulletin } from '../../events/model';

const ROW_H = 22;
const LABEL_W = 132;
const STEPS = [HOUR_MS, 6 * HOUR_MS, DAY_MS] as const;
const STEP_KEY: Record<number, MessageKey> = { [HOUR_MS]: 't.step.1h', [6 * HOUR_MS]: 't.step.6h', [DAY_MS]: 't.step.1d' };
const DYN_PRESETS: WindowPreset[] = ['day', 'rolling24h', 'rolling6h', 'rolling1h'];

type Drag = { id: string; mode: 'start' | 'end' | 'move'; x0: number; s0: number | null; e0: number | null; dt: number } | { id: null; mode: 'cursor' } | null;

/**
 * Scenario timeline (bottom, while the simulation is open): events as bars over time, the
 * simulation time as a cursor (the app's single clock: the temporal explorer's cursor and its
 * playback), and the light measures over time. Times are UTC; bars can be dragged (snapped to the
 * hour; Alt: 15 minutes) and every time can be typed exactly in the event editor.
 */
export function ScenarioTimeline({ ctx }: { ctx: SimContext }) {
  const { t, number } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const scenario = useAppStore((s) => s.simScenario);
  const sel = useAppStore((s) => s.temporalSel);
  const playing = useAppStore((s) => s.temporalPlaying);
  const setPlaying = useAppStore((s) => s.setTemporalPlaying);
  const patchSel = useAppStore((s) => s.patchTemporalSel);
  const selected = useAppStore((s) => s.simSelectedEvent);
  const setSelected = useAppStore((s) => s.setSimSelectedEvent);
  const series = useAppStore((s) => s.simSeries);
  const past = useAppStore((s) => s.simPast.length);
  const future = useAppStore((s) => s.simFuture.length);
  const undo = useAppStore((s) => s.undoSim);
  const redo = useAppStore((s) => s.redoSim);
  const status = useAppStore((s) => s.simStatus);
  const laneRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  // zoomed span (null = the scenario's range, following its events)
  const [zoomed, setZoomed] = useState<{ startMs: number; endMs: number } | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [showChart, setShowChart] = useState(true);
  // Phase 9G: real EASA advisories as their own rows (never part of the scenario)
  const showAdv = useAppStore((s) => s.showAdvisoriesOnTimeline);
  const setShowAdv = useAppStore((s) => s.setShowAdvisoriesOnTimeline);
  const hist = useAdvisoryHistory();

  // the lanes exist only once the scenario, clock and range are known
  const ready = scenario !== null && sel !== null && ctx.range !== null;
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(120, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  const range = ctx.range;
  const view = zoomed ?? range;

  // playback runs over the scenario timeline: it stops at its end (or starts again with loop)
  const cursor = sel?.cursorMs ?? null;
  useEffect(() => {
    if (!playing || !range || cursor === null) return;
    if (cursor >= range.endMs) {
      if (sel?.loop) patchSel({ cursorMs: range.startMs });
      else setPlaying(false);
    }
  }, [playing, cursor, range, sel?.loop, patchSel, setPlaying]);

  const code = useMemo(() => {
    const m = new Map(network.airports.map((a) => [a.id, a.iata ?? a.id]));
    return (id: string) => m.get(id) ?? id;
  }, [network]);

  if (!scenario || !sel || !range || !view) {
    return <div className="timeline panel sim-timeline" role="status"><div className="spinner" aria-hidden="true" /></div>;
  }
  const at = sel.cursorMs;
  const span = view.endMs - view.startMs;
  const x = (ms: number) => ((ms - view.startMs) / span) * width;
  const msAt = (px: number) => view.startMs + (px / width) * span;
  const snap = (ms: number, alt: boolean) => Math.round(ms / (alt ? 15 * 60_000 : HOUR_MS)) * (alt ? 15 * 60_000 : HOUR_MS);
  // the cursor can go anywhere in the data; the shown span follows it when it leaves the view
  const data = ctx.meta?.range ?? range;
  const setCursor = (ms: number) => {
    setPlaying(false);
    const c = Math.min(data.endMs - 60_000, Math.max(data.startMs, ms));
    patchSel({ cursorMs: c });
    if (c < view.startMs || c >= view.endMs) setZoomed({ startMs: c - span / 2, endMs: c + span / 2 });
  };
  const jump = (dir: 1 | -1) => {
    if (!ctx.disruption) return;
    const b = nextBoundary(ctx.disruption, at, dir);
    if (b !== null) setCursor(b);
  };
  const zoom = (f: number) => {
    const c = Math.min(view.endMs, Math.max(view.startMs, at));
    const half = Math.max(2 * HOUR_MS, Math.min(400 * DAY_MS, (span * f) / 2));
    setZoomed({ startMs: Math.round(c - half), endMs: Math.round(c + half) });
  };

  const lanePointer = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.tl-bar')) return;
    const rect = laneRef.current!.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: null, mode: 'cursor' });
    setCursor(snap(msAt(e.clientX - rect.left), e.altKey));
  };
  const barPointer = (e: RPointerEvent<HTMLElement>, ev: SimulationEvent, mode: 'start' | 'end' | 'move') => {
    e.stopPropagation();
    setSelected(ev.eventId);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: ev.eventId, mode, x0: e.clientX, s0: parseIsoUtc(ev.startTimeUtc), e0: parseIsoUtc(ev.endTimeUtc), dt: 0 });
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return;
    if (drag.mode === 'cursor') {
      const rect = laneRef.current!.getBoundingClientRect();
      setCursor(snap(msAt(e.clientX - rect.left), e.altKey));
    } else {
      const dt = snap(((e.clientX - drag.x0) / width) * span, e.altKey);
      if (dt !== drag.dt) setDrag({ ...drag, dt });
    }
  };
  const up = () => {
    if (drag && drag.mode !== 'cursor' && drag.id && drag.dt !== 0) {
      const { id, mode, s0, e0, dt } = drag;
      if (mode === 'move') {
        updateEvent(id, { startTimeUtc: s0 === null ? null : isoMinute(s0 + dt), endTimeUtc: e0 === null ? null : isoMinute(e0 + dt) });
      } else if (mode === 'start' && s0 !== null) setEventTime(id, 'start', s0 + dt);
      else if (mode === 'end' && e0 !== null) setEventTime(id, 'end', e0 + dt);
    }
    setDrag(null);
  };

  const events = scenario.events;
  const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const advSpan = (b: Bulletin) => {
    const first = b.revisions[0]!.effectiveDate;
    const last = b.revisions[b.revisions.length - 1]!;
    return { s: first ? dayMs(first) : NaN, e: last.validUntil ? dayMs(last.validUntil) + DAY_MS : NaN };
  };
  const advisories = showAdv && hist.state === 'ready'
    ? hist.data.history.bulletins.filter((b) => { const sp = advSpan(b); return sp.s < view.endMs && (Number.isNaN(sp.e) || sp.e > view.startMs); })
    : [];
  const openEvent = (b: Bulletin, revisionId: string) => {
    const st = useAppStore.getState();
    st.setEventFocus({ bulletinId: b.bulletinId, revisionId });
    st.setResearchTab('events');
    st.setAppMode('research');
  };
  const activeCount = events.filter((e) => eventActiveAt(e, at)).length;
  const ticks = axisTicks(view, width);
  const gap = ctx.meta?.quality.coverage.knownGap;
  const gapS = gap ? Date.parse(gap.from) : NaN;
  const gapE = gap ? Date.parse(gap.to) : NaN;
  const period = scenario.baselineMode === 'fixed' ? { s: parseIsoUtc(scenario.analysisStart)!, e: parseIsoUtc(scenario.analysisEnd)! } : null;
  const stepMs = STEPS.includes(sel.stepMs as (typeof STEPS)[number]) ? sel.stepMs : HOUR_MS;
  const computing = status.state === 'loading';

  return (
    <div className="timeline panel sim-timeline" role="group" aria-label={t('sim.tl.label')}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('input, select, textarea')) return;
        if (e.key === 'ArrowRight') setCursor(at + stepMs);
        else if (e.key === 'ArrowLeft') setCursor(at - stepMs);
        else if (e.key === 'PageDown') jump(1);
        else if (e.key === 'PageUp') jump(-1);
        else return;
        e.preventDefault();
      }}>
      <div className="tl-head">
        <div className="timeline-buttons">
          <button type="button" className="icon-btn" onClick={() => jump(-1)} aria-label={t('sim.tl.prevBoundary')} title={t('sim.tl.prevBoundary')}><Icon name="first" /></button>
          <button type="button" className="icon-btn" onClick={() => setCursor(at - stepMs)} aria-label={t('t.prev')} title={t('t.prev')}><Icon name="prev" /></button>
          <button type="button" className={`icon-btn play ${playing ? 'is-active' : ''}`} onClick={() => setPlaying(!playing)}
            aria-label={playing ? t('t.pause') : t('t.play')} title={playing ? t('t.pause') : t('t.play')}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button type="button" className="icon-btn" onClick={() => setCursor(at + stepMs)} aria-label={t('t.next')} title={t('t.next')}><Icon name="next" /></button>
          <button type="button" className="icon-btn tl-flip" onClick={() => jump(1)} aria-label={t('sim.tl.nextBoundary')} title={t('sim.tl.nextBoundary')}><Icon name="first" /></button>
        </div>
        <label className="tl-now">
          <span className="muted small">{t('sim.tl.now')}</span>
          <input type="datetime-local" step={60} value={new Date(at).toISOString().slice(0, 16)} aria-label={t('sim.tl.now')}
            onChange={(e) => { const ms = parseIsoUtc(`${e.target.value}Z`); if (ms !== null) setCursor(ms); }} />
          <span className="muted small">UTC</span>
        </label>
        <span className="small tl-active" role="status">
          {computing ? t('sim.updating') : t('sim.tl.activeCount', { n: activeCount })}
        </span>
        <label className="t-field" title={t('sim.tl.advisoriesTitle')}>
          <input type="checkbox" checked={showAdv} onChange={(e) => setShowAdv(e.target.checked)} />
          <span className="muted small">{t('sim.tl.advisories')}</span>
        </label>
        <span className="tl-spacer" />
        <label className="t-field">
          <span className="muted small">{t('t.step')}</span>
          <select value={stepMs} onChange={(e) => {
            const v = Number(e.target.value);
            patchSel({ stepMs: v });
            useAppStore.getState().setSimScenario({ ...scenario, timeline: { ...scenario.timeline, step: isoDuration(v) } });
          }}>
            {STEPS.map((s) => <option key={s} value={s}>{t(STEP_KEY[s]!)}</option>)}
          </select>
        </label>
        <label className="t-field">
          <span className="muted small">{t('t.speed')}</span>
          <select value={sel.speed} onChange={(e) => patchSel({ speed: e.target.value as PlaybackSpeed })}>
            {(['slow', 'normal', 'fast'] as const).map((s) => <option key={s} value={s}>{t(`t.speed.${s}`)}</option>)}
          </select>
        </label>
        {scenario.baselineMode === 'dynamic' && (
          <label className="t-field">
            <span className="muted small">{t('sim.tl.window')}</span>
            <select value={DYN_PRESETS.includes(sel.preset) ? sel.preset : 'day'} onChange={(e) => patchSel({ preset: e.target.value as WindowPreset })}>
              {DYN_PRESETS.map((p) => <option key={p} value={p}>{t(`t.preset.${p}`)}</option>)}
            </select>
          </label>
        )}
        <div className="tl-zoom" role="group" aria-label={t('sim.tl.zoom')}>
          <button type="button" className="icon-btn" onClick={() => zoom(2)} aria-label={t('sim.tl.zoomOut')} title={t('sim.tl.zoomOut')}><Icon name="minus" /></button>
          <button type="button" className="icon-btn" onClick={() => zoom(0.5)} aria-label={t('sim.tl.zoomIn')} title={t('sim.tl.zoomIn')}><Icon name="plus" /></button>
          <button type="button" className="pill-btn" onClick={() => setZoomed(null)}>{t('sim.tl.fit')}</button>
        </div>
        <div className="tl-zoom" role="group" aria-label={t('sim.tl.history')}>
          <button type="button" className="pill-btn" disabled={!past} onClick={undo} title="Ctrl+Z">{t('sim.tl.undo')}</button>
          <button type="button" className="pill-btn" disabled={!future} onClick={redo} title="Ctrl+Shift+Z">{t('sim.tl.redo')}</button>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-labels" style={{ width: LABEL_W }}>
          <div className="tl-axis-label muted small">UTC</div>
          {events.map((e) => (
            <button key={e.eventId} type="button" className={`tl-label ${selected === e.eventId ? 'is-selected' : ''} ${e.enabled ? '' : 'is-off'}`}
              style={{ height: ROW_H }} onClick={() => setSelected(selected === e.eventId ? null : e.eventId)}
              title={`${t(`sim.event.${e.eventType}` as MessageKey)} · ${t(e.sourceType === 'reported' ? 'sim.ev.reported' : 'sim.ev.hypothetical')}`}>
              <span className={`tl-kind tl-kind-${e.targetType}`} aria-hidden="true" />
              <span className="tl-name">{eventLabel(e, code)}</span>
              {e.sourceType === 'reported' && <span className="tl-src">{t('sim.ev.reportedShort')}</span>}
            </button>
          ))}
          {events.length === 0 && <div className="hint tl-empty">{t('sim.tl.empty')}</div>}
          {advisories.map((b) => (
            <button key={`adv-${b.bulletinId}`} type="button" className="tl-label tl-label-advisory" style={{ height: ROW_H }}
              onClick={() => openEvent(b, b.revisions[0]!.revisionId)} title={`${b.title} — ${t('sim.tl.advisoryOpen')}`}>
              <span className="tl-name">{t('sim.tl.advisoryRow', { id: b.bulletinId })}</span>
            </button>
          ))}
        </div>
        <div className="tl-lanes" ref={laneRef} onPointerDown={lanePointer} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          role="slider" tabIndex={0} aria-label={t('sim.tl.now')} aria-valuemin={range.startMs} aria-valuemax={range.endMs} aria-valuenow={at} aria-valuetext={formatUtc(at)}>
          <div className="tl-axis">
            {ticks.map((tk) => <span key={tk.ms} className={`tl-tick ${tk.major ? 'is-major' : ''}`} style={{ left: x(tk.ms) }}>{tk.label}</span>)}
          </div>
          {period && <div className="tl-period" style={{ left: Math.max(0, x(period.s)), width: Math.max(0, Math.min(width, x(period.e)) - Math.max(0, x(period.s))) }} title={t('sim.tl.period')} />}
          {Number.isFinite(gapS) && x(gapE) > 0 && x(gapS) < width && (
            <div className="tl-gap" style={{ left: Math.max(0, x(gapS)), width: Math.min(width, x(gapE)) - Math.max(0, x(gapS)) }} title={t('t.gapMarker')} />
          )}
          {events.map((e, i) => {
            const d = drag && drag.mode !== 'cursor' && drag.id === e.eventId ? drag : null;
            let s = parseIsoUtc(e.startTimeUtc);
            let en = parseIsoUtc(e.endTimeUtc);
            if (d && d.mode !== 'end' && s !== null) s += d.dt;
            if (d && d.mode !== 'start' && en !== null) en += d.dt;
            const left = s === null ? 0 : Math.max(0, x(s));
            const right = en === null ? width : Math.min(width, x(en));
            const active = eventActiveAt(e, at);
            return (
              <div key={e.eventId} className="tl-row" style={{ top: 18 + i * ROW_H, height: ROW_H }}>
                {right > left && (
                  <div className={`tl-bar tl-bar-${e.targetType} ${active ? 'is-active' : ''} ${e.enabled ? '' : 'is-off'} ${selected === e.eventId ? 'is-selected' : ''} ${s === null ? 'open-start' : ''} ${en === null ? 'open-end' : ''}`}
                    style={{ left, width: Math.max(3, right - left) }}
                    onPointerDown={(ev) => barPointer(ev, e, 'move')} onPointerMove={(ev) => { ev.stopPropagation(); move(ev); }} onPointerUp={(ev) => { ev.stopPropagation(); up(); }} onPointerCancel={(ev) => { ev.stopPropagation(); up(); }}
                    title={`${eventLabel(e, code)}: ${s === null ? '…' : formatUtc(s, false)} – ${en === null ? '…' : formatUtc(en)}`}>
                    {s !== null && <span className="tl-handle tl-handle-s" onPointerDown={(ev) => barPointer(ev, e, 'start')} />}
                    {en !== null && <span className="tl-handle tl-handle-e" onPointerDown={(ev) => barPointer(ev, e, 'end')} />}
                    {d && <span className="tl-drag-time">{formatUtc(d.mode === 'end' ? en! : s ?? en!, false)}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {advisories.map((b, j) => {
            const sp = advSpan(b);
            const left = Math.max(0, x(sp.s));
            const right = Number.isNaN(sp.e) ? width : Math.min(width, x(sp.e));
            return (
              <div key={`adv-${b.bulletinId}`} className="tl-row" style={{ top: 18 + (events.length + j) * ROW_H, height: ROW_H }}>
                {right > left && <div className="tl-bar-advisory" style={{ left, width: Math.max(3, right - left) }} title={`${t('sim.tl.advisories')}: ${b.title}`}
                  onPointerDown={(ev) => ev.stopPropagation()} onClick={() => openEvent(b, b.revisions[0]!.revisionId)} />}
                {b.revisions.map((v) => {
                  if (!v.effectiveDate) return null;
                  const px = x(dayMs(v.effectiveDate));
                  if (px < 0 || px > width) return null;
                  return <span key={v.revisionId} className="tl-adv-tick" style={{ left: px }} title={`CZIB ${v.czibNumber} — ${v.effectiveDate}${v.validUntil ? ` → ${v.validUntil}` : ''}`}
                    onPointerDown={(ev) => ev.stopPropagation()} onClick={() => openEvent(b, v.revisionId)} />;
                })}
              </div>
            );
          })}
          <div className="tl-rows-spacer" style={{ height: 18 + Math.max(1, events.length + advisories.length) * ROW_H }} />
          <div className="tl-cursor" style={{ left: x(at) }} aria-hidden="true" />
        </div>
      </div>
      {showChart && (
        <div className="tl-chart-row">
          <div className="tl-chart-label muted small" style={{ width: LABEL_W }}>{t('sim.tl.chart')}</div>
          <div className="tl-chart-lane">
            <SeriesChart points={series?.points ?? []} stepMs={series?.stepMs ?? stepMs} x={x} width={width} at={at} onPick={setCursor} />
            <div className="tl-cursor" style={{ left: x(at) }} aria-hidden="true" />
          </div>
        </div>
      )}
      <div className="tl-foot">
        <button type="button" className="link-btn" onClick={() => setShowChart(!showChart)}>{showChart ? t('sim.tl.hideChart') : t('sim.tl.showChart')}</button>
        {series && showChart && (
          <span className="muted small">
            {t('sim.tl.chartNote', { done: number(series.done), total: number(series.total) })}
          </span>
        )}
      </div>
    </div>
  );
}

function axisTicks(view: { startMs: number; endMs: number }, width: number): { ms: number; label: string; major: boolean }[] {
  const span = view.endMs - view.startMs;
  const target = Math.max(2, Math.floor(width / 70));
  const steps = [HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS];
  const step = steps.find((s) => span / s <= target) ?? 60 * DAY_MS;
  const out: { ms: number; label: string; major: boolean }[] = [];
  for (let ms = Math.ceil(view.startMs / step) * step; ms < view.endMs; ms += step) {
    const d = new Date(ms);
    const midnight = d.getUTCHours() === 0;
    out.push({ ms, major: midnight, label: midnight ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00` });
  }
  return out;
}

/** Lost connections (line) and selected flights (bars) per step; unreachable pairs where computed (dots). */
function SeriesChart({ points, stepMs, x, width, at, onPick }: {
  points: { t: number; lostConnections: number | null; flights: number | null; unreachable: number | null }[];
  stepMs: number; x: (ms: number) => number; width: number; at: number; onPick: (ms: number) => void;
}) {
  const { t, number } = useI18n();
  const H = 44;
  const maxLost = Math.max(1, ...points.map((p) => p.lostConnections ?? 0));
  const maxF = Math.max(1, ...points.map((p) => p.flights ?? 0));
  const maxU = Math.max(1, ...points.map((p) => p.unreachable ?? 0));
  const y = (v: number, max: number) => H - 3 - (v / max) * (H - 8);
  const cur = [...points].reverse().find((p) => p.t <= at) ?? null;
  const lostPath = points
    .filter((p) => p.lostConnections !== null)
    .map((p, i, arr) => {
      const x0 = x(p.t);
      const x1 = i + 1 < arr.length ? x(arr[i + 1]!.t) : x(p.t + stepMs);
      return `${i === 0 ? 'M' : 'L'}${x0.toFixed(1)},${y(p.lostConnections!, maxLost).toFixed(1)} L${x1.toFixed(1)},${y(p.lostConnections!, maxLost).toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="tl-chart" style={{ height: H }}>
      <svg width={width} height={H} role="img" aria-label={t('sim.tl.chart')}
        onPointerDown={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const xs = e.clientX - r.left;
          const p = points.reduce<{ t: number; d: number } | null>((best, q) => {
            const d = Math.abs(x(q.t) - xs);
            return !best || d < best.d ? { t: q.t, d } : best;
          }, null);
          if (p) onPick(p.t);
        }}>
        {points.map((p) => (p.flights ? (
          <rect key={`f${p.t}`} className="tl-flights" x={x(p.t)} y={y(p.flights, maxF)} width={Math.max(1, x(p.t + stepMs) - x(p.t) - 1)} height={H - 3 - y(p.flights, maxF)} />
        ) : null))}
        {lostPath && <path className="tl-lost" d={lostPath} />}
        {points.map((p) => (p.unreachable !== null ? <circle key={`u${p.t}`} className="tl-unreach" cx={x(p.t)} cy={y(p.unreachable, maxU)} r={2.5} /> : null))}
      </svg>
      <div className="tl-chart-legend small">
        <span className="tl-key tl-key-lost">{t('sim.tl.lost')}{cur?.lostConnections !== null && cur ? ` ${number(cur.lostConnections!)}` : ''}</span>
        <span className="tl-key tl-key-flights">{t('sim.tl.flights')}{cur?.flights !== null && cur ? ` ${number(cur.flights!)}` : ''}</span>
        <span className="tl-key tl-key-unreach">{t('sim.tl.unreachable')}{cur?.unreachable !== null && cur ? ` ${number(cur.unreachable!)}` : ''}</span>
      </div>
    </div>
  );
}
