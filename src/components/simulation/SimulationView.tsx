import { useEffect, useMemo, useRef, useState } from 'react';
import { airportImpact } from '../../app/useSimMap';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { ChangeKind, type Comparison } from '../../domain/comparison';
import { useAppStore, type SimView } from '../../state/store';
import { useSimContext, useSimulation } from '../../simulation/useSimulation';
import { ScenarioTimeline } from './ScenarioTimeline';
import { SimulationPanel } from './SimulationPanel';

/** Simulation mode: right panel, bottom scenario timeline, map controls. Loaded only when opened. */
export function SimulationView({ comparison, temporal }: { comparison: Comparison | null; temporal: boolean }) {
  const scenario = useAppStore((s) => s.simScenario);
  const ctx = useSimContext(scenario);
  useSimulation(scenario, ctx);
  useShortcuts();
  return (
    <>
      <SimulationPanel ctx={ctx} />
      <ScenarioTimeline ctx={ctx} />
      <MapControls comparison={comparison} temporal={temporal} />
    </>
  );
}

/** Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y): undo / redo scenario edits. Hold B: show the observed network. */
function useShortcuts() {
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.closest?.('input, select, textarea') != null;
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const st = useAppStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redoSim();
        else st.undoSim();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redoSim();
      } else if (e.key.toLowerCase() === 'b' && !e.repeat && !e.ctrlKey && !e.metaKey) {
        st.setSimPeek(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b') useAppStore.getState().setSimPeek(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => useAppStore.getState().setSimPeek(false));
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}

const MODES: SimView[] = ['focus', 'overlay', 'after', 'airports'];

/**
 * On the map: what is drawn (mode), "show before" (hold to peek, click to keep), and the legend.
 * Swatches match the route shader's compare branch and the airport shader's marked state.
 */
function MapControls({ comparison, temporal }: { comparison: Comparison | null; temporal: boolean }) {
  const { t, number } = useI18n();
  const view = useAppStore((s) => s.simView);
  const setView = useAppStore((s) => s.setSimView);
  const peek = useAppStore((s) => s.simPeek);
  const setPeek = useAppStore((s) => s.setSimPeek);
  const hidden = useAppStore((s) => s.compareHiddenKinds);
  const toggle = useAppStore((s) => s.toggleCompareKind);
  const down = useRef<number | null>(null);
  const before = view === 'before';
  const [lastView, setLastView] = useState<SimView>('focus');
  const items = (temporal ? ['gone', 'down', 'stable'] : ['gone', 'stable']) as ('gone' | 'down' | 'stable')[];
  const KIND = { gone: ChangeKind.Gone, down: ChangeKind.Down, stable: ChangeKind.Stable } as const;
  const SWATCH = {
    gone: { background: 'repeating-linear-gradient(90deg, #ff7338 0 5px, transparent 5px 9px)', height: 4 },
    down: { background: '#ff944d' },
    stable: { background: '#73859e' },
  } as const;
  return (
    <div className="compare-legend panel sim-mapbar" aria-label={t('sim.legend')}>
      <div className="segmented sim-modes" role="radiogroup" aria-label={t('sim.view')}>
        {MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={view === m && !peek} className={view === m && !peek ? 'is-active' : ''}
            onClick={() => setView(m)} title={t(`sim.view.${m}.hint` as MessageKey)}>{t(`sim.view.${m}` as MessageKey)}</button>
        ))}
      </div>
      <button type="button" className={`pill-btn sim-peek ${peek || before ? 'is-active' : ''}`} aria-pressed={peek || before}
        title={t('sim.peek.hint')}
        onPointerDown={() => {
          down.current = performance.now();
          setPeek(true);
        }}
        onPointerUp={() => {
          const short = down.current !== null && performance.now() - down.current < 250;
          down.current = null;
          setPeek(false);
          // a short click keeps the observed network on (or returns from it)
          if (short) {
            if (before) setView(lastView);
            else {
              setLastView(view);
              setView('before');
            }
          }
        }}
        onPointerLeave={() => {
          if (down.current !== null) {
            down.current = null;
            setPeek(false);
          }
        }}>
        {t(before ? 'sim.peek.back' : 'sim.peek')}
      </button>
      <ul>
        <li><span className="legend-item"><span className="swatch swatch-dot" style={{ background: '#ff6147' }} /><span>{t('sim.legend.target')}</span></span></li>
        {view === 'airports' && <li><span className="legend-item"><span className="swatch swatch-dot" style={{ background: '#e0faff' }} /><span>{t('sim.legend.impacted')}</span></span></li>}
        {view === 'airports' && !peek && <AirportsLegend />}
        <li><span className="legend-item"><span className="swatch" style={{ background: '#ffd27a', height: 4 }} /><span>{t('sim.legend.suspended')}</span></span></li>
        {comparison && items.map((k) => {
          if (k === 'stable' && (view === 'focus' || view === 'airports')) return null;
          const shown = !hidden.includes(KIND[k]);
          return (
            <li key={k}>
              <button type="button" className={`legend-item ${shown ? '' : 'is-off'}`} aria-pressed={shown} onClick={() => toggle(KIND[k])}>
                <span className="swatch" style={SWATCH[k]} />
                <span>{t(`sim.legend.${k}${temporal && k === 'gone' ? 'Temporal' : ''}` as MessageKey)}</span>
                <span className="muted small">{number(comparison.counts[k])}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="muted tiny">{t(peek || before ? 'sim.legend.before' : temporal ? 'sim.legend.hintTemporal' : 'sim.legend.hintStructural')}</span>
    </div>
  );
}

/** Numeric legend of the 'airports' view (Phase 9E): what the dot size counts, and its range. */
function AirportsLegend() {
  const { t, number } = useI18n();
  const status = useAppStore((s) => s.simStatus);
  const impact = useAppStore((s) => s.simImpact);
  const metric = useAppStore((s) => s.simAirportMetric);
  const network = useAppStore((s) => s.network);
  const out = status.state === 'ready' ? status.output : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;
  const stats = useMemo(() => {
    if (!out || !imp || !network) return null;
    const { weights, impacted } = airportImpact(out, imp, metric, network.airports.length);
    const v = impacted.map((g) => weights[g]!).sort((a, b) => a - b);
    return v.length ? { n: v.length, min: v[0]!, med: v[Math.floor(v.length / 2)]!, max: v[v.length - 1]! } : { n: 0, min: 0, med: 0, max: 0 };
  }, [out, imp, metric, network]);
  if (!stats) return null;
  return (
    <li className="sim-num-legend">
      <span className="small">{t(`sim.metric.${metric}` as MessageKey)}</span>
      {stats.n > 0 ? (
        <span className="sim-num-scale" aria-label={t('sim.legend.scale')}>
          {[stats.min, stats.med, stats.max].map((v, i) => (
            <span key={i} className="legend-item">
              <span className="swatch swatch-dot" style={{ background: '#e0faff', width: 5 + 3 * i, height: 5 + 3 * i }} />
              <span className="mono small">{number(v)}</span>
            </span>
          ))}
          <span className="muted tiny">{t('sim.legend.scaleNote', { n: number(stats.n) })}</span>
        </span>
      ) : <span className="muted tiny">{t('sim.legend.noneImpacted')}</span>}
    </li>
  );
}
