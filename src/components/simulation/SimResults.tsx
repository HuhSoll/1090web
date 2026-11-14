import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { ChangeKind } from '../../domain/comparison';
import { useAppStore, type SimAirportMetric } from '../../state/store';
import { eventActiveAt, networkIndex, scenarioContext } from '../../simulation/disruption';
import type { SimulationOutput } from '../../simulation/engine';
import { alternativePaths, distancesFrom, graphOf, type ImpactResult, type ReachStats } from '../../simulation/impact';
import type { SimulationScenario } from '../../simulation/model';
import { leaveOneOut, pairCause, type EventContribution, type PairCause } from '../../simulation/series';
import { cancelImpact, cancelSeries, runImpact, runSeries, runSeriesImpact, type SimContext } from '../../simulation/useSimulation';
import { windowQuality } from '../../temporal/quality';
import { formatUtc } from '../../temporal/window';
import { Note } from '../research/common';
import { useFormat } from '../research/format';
import { eventLabel } from '../../simulation/labels';
import { issueText } from './issueText';
import type { SectionId } from './SimulationPanel';

/** The current result and its connectivity analysis (only when computed for the shown key). */
function useCurrent() {
  const status = useAppStore((s) => s.simStatus);
  const impact = useAppStore((s) => s.simImpact);
  const out = status.state === 'ready' ? status.output : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;
  const running = out && impact.state === 'running' && impact.key === `${out.key}:impact` ? impact : null;
  return { status, out, imp, running, impact };
}

const code = (network: { airports: { iata: string | null; id: string }[] }, g: number) => network.airports[g]!.iata ?? network.airports[g]!.id;

/** Problems that change the reading of the result: always shown, before the numbers. */
export function Warnings({ scenario, ctx }: { scenario: SimulationScenario; ctx: SimContext }) {
  const { t } = useI18n();
  const { status, out } = useCurrent();
  const network = useAppStore((s) => s.network)!;
  const quality = useMemo(() => (ctx.meta && ctx.window ? windowQuality(ctx.meta.index, ctx.window, { flights: null }) : null), [ctx.meta, ctx.window]);
  const issues = ctx.disruption?.issues ?? [];
  const active = ctx.atMs !== null ? scenario.events.filter((e) => eventActiveAt(e, ctx.atMs!)).length : 0;
  const noneActive = scenario.simulationModel === 'structural' && scenario.events.some((e) => e.enabled) && active === 0;
  const tm = out?.temporal;
  return (
    <>
      {quality && quality.gapHours > 0 && <Note warn>{t('sim.q.gap', { hours: quality.gapHours, days: quality.gapDays.join(', ') })}</Note>}
      {issues.map((i, k) => <Note warn key={`i${k}`}>{issueText(t, i)}</Note>)}
      {status.state === 'error' && <Note warn>{status.message === 'outside' ? t('sim.err.outside') : t('sim.err.failed', { message: status.message })}</Note>}
      {noneActive && <Note>{t('sim.q.noneAtTime')}</Note>}
      {tm && tm.daysWithoutEndpoints.length > 0 && <Note warn>{t('sim.q.noEndpoints', { days: tm.daysWithoutEndpoints.join(', ') })}</Note>}
      {out && out.direct.targetsNotInBaseline.length > 0 && (
        <Note warn>{t('sim.q.notInBaseline', { codes: out.direct.targetsNotInBaseline.map((g) => code(network, g)).join(', ') })}</Note>
      )}
      {out && out.window.endMs - out.window.startMs < 86_400_000 && <Note>{t('t.shortWindowNote')}</Note>}
    </>
  );
}

/**
 * The four numbers shown first. Each card leads to the matching map view or detail:
 * lost connections -> only lost connections on the map; selected flights -> breakdown;
 * pairs without a path -> path comparison; most affected airport -> ranking + map focus.
 */
export function ImpactSummary({ scenario, ctx, onReveal }: { scenario: SimulationScenario; ctx: SimContext; onReveal: (id: SectionId) => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const { status, out, imp, running } = useCurrent();
  const hidden = useAppStore((s) => s.compareHiddenKinds);
  const metric = useAppStore((s) => s.simAirportMetric);
  if (!out) {
    return (
      <div className="r-progress" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>{status.state === 'loading' ? t('sim.loading', { done: status.done, total: status.total }) : t('sim.updating')}</span>
      </div>
    );
  }
  const d = out.direct;
  const temporal = out.model === 'temporal';
  const before = out.before.net.routes.length;
  const lostOnly = hidden.includes(ChangeKind.Stable) && hidden.includes(ChangeKind.Down);
  const showLost = () => {
    const st = useAppStore.getState();
    st.setSimView('focus');
    // toggle: only lost connections <-> all changes
    for (const k of [ChangeKind.Stable, ChangeKind.Down]) if (lostOnly === st.compareHiddenKinds.includes(k)) st.toggleCompareKind(k);
  };
  const top = imp ? topAirport(out, imp, metric) : null;
  const firstLost = imp && imp.lostPairs.list.length >= 2 ? [out.impactNodes[imp.lostPairs.list[0]!]!, out.impactNodes[imp.lostPairs.list[1]!]!] as [number, number] : null;
  const targetsNow = ctx.atMs !== null ? scenario.events.filter((e) => eventActiveAt(e, ctx.atMs!)) : [];
  return (
    <section className="sim-summary" aria-live="polite">
      <div className="sim-row">
        <span className="field-label">{t('sim.sum.title')}</span>
        {status.state === 'loading' && <span className="small muted">{t('sim.updating')}</span>}
      </div>
      <p className="small">
        {t('sim.sum.stopped')}{' '}
        <span className="code">{targetsNow.length ? targetsNow.map((e) => eventLabel(e, (id) => network.airports.find((a) => a.id === id)?.iata ?? id)).join(', ') : t('sim.sum.none')}</span>
      </p>
      <div className="sim-cards">
        <button type="button" className={`sim-card ${lostOnly ? 'is-active' : ''}`} onClick={showLost} title={t('sim.sum.lostHint')}>
          <span className="sim-card-label">{t('sim.d.lost')}</span>
          <span className="sim-card-value">{f.int(d.lostConnections)} <span className="small">{t('sim.unit.connections')}</span></span>
          <span className="sim-card-sub">{f.int(before)} → {f.int(before - d.lostConnections)}{temporal && d.reducedConnections ? ` · ${t('sim.sum.reduced', { n: f.int(d.reducedConnections) })}` : ''}</span>
        </button>
        <button type="button" className="sim-card" onClick={() => onReveal('detail')}>
          <span className="sim-card-label">{t(temporal ? 'sim.d.flightsTemporal' : 'sim.d.flightsStructural')}</span>
          <span className="sim-card-value">{f.int(d.flights)} <span className="small">{t('sim.unit.flights')}</span></span>
          <span className="sim-card-sub">{t('sim.sum.ofBaseline', { share: f.pct(d.baselineFlights ? d.flights / d.baselineFlights : null), total: f.int(d.baselineFlights) })}</span>
        </button>
        <button type="button" className="sim-card" disabled={!imp && !running}
          onClick={() => {
            if (!firstLost) return onReveal('detail');
            useAppStore.getState().setSimPair(firstLost);
            useAppStore.getState().selectAirport(firstLost[0]);
            onReveal('paths');
          }}>
          <span className="sim-card-label">{t('sim.sum.unreachable')}</span>
          <span className="sim-card-value">{imp ? f.int(imp.lostPairs.total) : running ? '…' : '—'} <span className="small">{t('sim.unit.pairs')}</span></span>
          <span className="sim-card-sub">{imp ? t('sim.sum.spillover') : running ? t('sim.c.running', { pct: Math.round((100 * running.done) / Math.max(1, running.total)) }) : t('sim.sum.notComputed')}</span>
        </button>
        <button type="button" className="sim-card" disabled={!top}
          onClick={() => {
            if (!top) return;
            const st = useAppStore.getState();
            st.setSimView('airports');
            st.selectAirport(top.g);
            onReveal('airports');
          }}>
          <span className="sim-card-label">{t('sim.sum.topAirport')}</span>
          <span className="sim-card-value code">{top ? code(network, top.g) : imp ? t('sim.sum.none') : '…'}</span>
          <span className="sim-card-sub">{top ? t(`sim.metric.${metric}.value` as MessageKey, { n: f.int(top.v) }) : t('sim.sum.notTarget')}</span>
        </button>
      </div>
      {imp && (
        <p className="hint">
          {t('sim.sum.network', {
            total: `${f.dec(imp.total.before.efficiency, 4)} → ${f.dec(imp.total.after.efficiency, 4)}`,
            spill: `${f.dec(imp.spillover.before.efficiency, 4)} → ${f.dec(imp.spillover.after.efficiency, 4)}`,
          })}
        </p>
      )}
      {!imp && !running && <button type="button" className="link-btn" onClick={runImpact}>{t('sim.c.run')}</button>}
      {running && <button type="button" className="link-btn" onClick={cancelImpact}>{t('sim.c.cancel')}</button>}
    </section>
  );
}

function metricValue(imp: ImpactResult, i: number, m: SimAirportMetric): number {
  const p = imp.perNode;
  return m === 'lost' ? p.lost[i]! : m === 'hop2' ? p.hop2Before[i]! - p.hop2After[i]! : p.degBefore[i]! - p.degAfter[i]!;
}

function topAirport(out: SimulationOutput, imp: ImpactResult, m: SimAirportMetric): { g: number; v: number } | null {
  const targets = new Set(out.targetAirports);
  let best: { g: number; v: number } | null = null;
  out.impactNodes.forEach((g, i) => {
    if (targets.has(g)) return;
    const v = metricValue(imp, i, m);
    if (v > 0 && (!best || v > best.v || (v === best.v && g < best.g))) best = { g, v };
  });
  return best;
}

/** Airports other than the stopped ones, ranked by the chosen measure; a click focuses the map. */
export function AirportTable({ onPick }: { onPick?: () => void }) {
  const { t, countryName } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const metric = useAppStore((s) => s.simAirportMetric);
  const setMetric = useAppStore((s) => s.setSimAirportMetric);
  const selected = useAppStore((s) => s.selectedAirport);
  const { out, imp, running } = useCurrent();
  const rows = useMemo(() => {
    if (!out || !imp) return [];
    const targets = new Set(out.targetAirports);
    return out.impactNodes
      .map((g, i) => ({ g, i, v: metricValue(imp, i, metric), lost: imp.perNode.lost[i]!, hop2: imp.perNode.hop2Before[i]! - imp.perNode.hop2After[i]!, deg: imp.perNode.degBefore[i]! - imp.perNode.degAfter[i]! }))
      .filter((r) => !targets.has(r.g) && r.v > 0)
      .sort((a, b) => b.v - a.v || b.lost - a.lost || b.hop2 - a.hop2 || a.g - b.g);
  }, [out, imp, metric]);
  if (!out) return null;
  if (!imp) return <p className="hint">{running ? t('sim.c.running', { pct: Math.round((100 * running.done) / Math.max(1, running.total)) }) : t('sim.sum.notComputed')}</p>;
  const p = imp.perNode;
  return (
    <>
      <div className="sim-row">
        <label className="t-field"><span className="muted small">{t('sim.metric')}</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as SimAirportMetric)}>
            {(['lost', 'hop2', 'degree'] as const).map((m) => <option key={m} value={m}>{t(`sim.metric.${m}`)}</option>)}
          </select>
        </label>
        <button type="button" className="link-btn" onClick={() => useAppStore.getState().setSimView('airports')}>{t('sim.metric.showOnMap')}</button>
      </div>
      <p className="hint">{t('sim.a.note', { n: f.int(rows.length) })} {t(`sim.metric.${metric}.note` as MessageKey)}</p>
      <div className="sim-table-wrap">
        <table className="r-table r-compact sim-table">
          <thead>
            <tr>
              <th>{t('sim.a.airport')}</th>
              <th className="num" title={t('sim.a.degTitle')}>{t('sim.a.deg')}</th>
              <th className="num" title={t('sim.a.reachTitle')}>{t('sim.a.reach')}</th>
              <th className="num" title={t('sim.a.hop2Title')}>{t('sim.a.hop2')}</th>
              <th className="num" title={t('sim.a.lostTitle')}>{t('sim.a.lost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((r) => {
              const a = network.airports[r.g]!;
              return (
                <tr key={r.g} className={`r-click ${selected === r.g ? 'is-selected' : ''}`} title={`${a.name} · ${countryName(a.country)}`}
                  onClick={() => {
                    useAppStore.getState().selectAirport(r.g);
                    onPick?.();
                  }}>
                  <td><span className="code">{a.iata ?? a.id}</span> <span className="muted small">{a.country}</span></td>
                  <td className="num">{p.degBefore[r.i]} → {p.degAfter[r.i]}</td>
                  <td className="num">{p.reachBefore[r.i]} → {p.reachAfter[r.i]}</td>
                  <td className="num">{p.hop2Before[r.i]} → {p.hop2After[r.i]}</td>
                  <td className="num">{f.int(r.lost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The selected airport's changes and one pair's paths: the path before, the path after, the
 * stopped airports and lost legs on the original path, and (structural) whether leaving out one
 * event alone restores it. With overlapping events, no single event is named the cause.
 */
export function PairAnalysis({ ctx }: { ctx: SimContext }) {
  const { t } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const scenario = useAppStore((s) => s.simScenario)!;
  const selected = useAppStore((s) => s.selectedAirport);
  const pair = useAppStore((s) => s.simPair);
  const setPair = useAppStore((s) => s.setSimPair);
  const setPathRoutes = useAppStore((s) => s.setSimPathRoutes);
  const { out, imp } = useCurrent();
  const [loo, setLoo] = useState<{ key: string; cause: PairCause } | null>(null);
  const graphs = useMemo(() => {
    if (!out) return null;
    const inp = out.impactInput;
    return { before: graphOf(inp.n, inp.before, inp.directed), after: graphOf(inp.n, inp.after, inp.directed), nodes: out.impactNodes, local: new Map(out.impactNodes.map((g, i) => [g, i])) };
  }, [out]);
  const routeOf = useMemo(() => {
    const m = new Map<string, number>();
    network.routes.forEach((r, i) => m.set(`${Math.min(r.a, r.b)}-${Math.max(r.a, r.b)}`, i));
    return (x: number, y: number) => m.get(`${Math.min(x, y)}-${Math.max(x, y)}`);
  }, [network]);
  const src = pair ? pair[0] : selected;
  const local = src !== null && graphs ? graphs.local.get(src) : undefined;
  const detail = useMemo(() => {
    if (local === undefined || !graphs || !out) return null;
    const dB = distancesFrom(graphs.before, local);
    const dA = distancesFrom(graphs.after, local);
    const targets = new Set(out.targetAirports);
    const lost: number[] = [];
    const longer: { i: number; b: number; a: number }[] = [];
    for (let i = 0; i < dB.length; i++) {
      if (i === local || targets.has(out.impactNodes[i]!)) continue;
      if (dB[i]! > 0 && dA[i]! < 0) lost.push(i);
      else if (dB[i]! > 0 && dA[i]! > dB[i]!) longer.push({ i, b: dB[i]!, a: dA[i]! });
    }
    longer.sort((x, y) => y.a - y.b - (x.a - x.b));
    return { lost, longer };
  }, [graphs, local, out]);
  const cause = useMemo(() => {
    if (!pair || !graphs || !out || ctx.atMs === null) return null;
    const base = { network, scope: { network, continentOf: network.airports.map(() => '?'), persistence: null }, scenario, beforeR: out.before.research, beforeNet: out.before.net };
    const sctx = scenarioContext(network, scenario.datasetVersion, ctx.meta?.range.startMs ?? 0, ctx.meta?.range.endMs ?? Infinity);
    return pairCause(base, sctx, ctx.atMs, pair[0], pair[1], graphs, out.targetAirports, false);
  }, [pair, graphs, out, ctx.atMs, ctx.meta, network, scenario]);
  // the compared pair's path on the map: the path after the disruption, else the original one
  useEffect(() => {
    if (!cause) return;
    const p = cause.after.length ? cause.after : cause.before;
    setPathRoutes(p.slice(1).map((v, k) => routeOf(p[k]!, v)).filter((x): x is number => x !== undefined));
  }, [cause, routeOf, setPathRoutes]);
  if (!out || !graphs) return null;
  if (src === null) return <p className="hint">{t('sim.sel.pick')}</p>;
  const label = (g: number) => code(network, g);
  if (local === undefined) return <p className="hint">{t('sim.sel.notInNetwork', { code: label(src) })}</p>;
  const show = (i: number) => {
    const s = out.impactNodes[local]!;
    const e = out.impactNodes[i]!;
    setPair([s, e]);
    const p = alternativePaths(graphs.after, local, i, 1)[0] ?? alternativePaths(graphs.before, local, i, 1)[0] ?? [];
    setPathRoutes(p.slice(1).map((v, k) => routeOf(out.impactNodes[p[k]!]!, out.impactNodes[v]!)).filter((x): x is number => x !== undefined));
  };
  const pathText = (p: number[]) => (p.length ? p.map(label).join(' → ') : t('sim.path.none'));
  const pi = imp?.perNode;
  const pairKey = pair ? `${out.key}:${pair[0]}-${pair[1]}:${ctx.atMs}` : '';
  const looCause = loo && loo.key === pairKey ? loo.cause : null;
  return (
    <>
      <h3 className="section-title">{t('sim.sel.title', { code: label(src) })}</h3>
      {pi && (
        <dl className="kv">
          <div className="kv-row"><dt>{t('sim.a.deg')}</dt><dd>{pi.degBefore[local]} → {pi.degAfter[local]}</dd></div>
          <div className="kv-row"><dt>{t('sim.a.reach')}</dt><dd>{pi.reachBefore[local]} → {pi.reachAfter[local]}</dd></div>
          <div className="kv-row"><dt>{t('sim.a.hop2')}</dt><dd>{pi.hop2Before[local]} → {pi.hop2After[local]}</dd></div>
          <div className="kv-row"><dt>{t('sim.a.hop3')}</dt><dd>{pi.hop3Before[local]} → {pi.hop3After[local]}</dd></div>
          <div className="kv-row"><dt>{t('sim.a.longer')}</dt><dd>{f.int(pi.longer[local]!)} ({t('sim.a.addedHops', { n: pi.addedHops[local]! })})</dd></div>
        </dl>
      )}
      {detail && detail.lost.length > 0 && (
        <>
          <p className="small">{t('sim.sel.lost', { n: f.int(detail.lost.length) })}</p>
          <div className="sim-chips">{detail.lost.slice(0, 24).map((i) => <button key={i} type="button" className="pill-btn" onClick={() => show(i)}>{label(out.impactNodes[i]!)}</button>)}</div>
        </>
      )}
      {detail && detail.longer.length > 0 && (
        <>
          <p className="small">{t('sim.sel.longer', { n: f.int(detail.longer.length) })}</p>
          <div className="sim-chips">{detail.longer.slice(0, 24).map((x) => <button key={x.i} type="button" className="pill-btn" onClick={() => show(x.i)}>{label(out.impactNodes[x.i]!)} {x.b}→{x.a}</button>)}</div>
        </>
      )}
      {detail && detail.lost.length === 0 && detail.longer.length === 0 && <p className="hint">{t('sim.sel.unchanged')}</p>}
      {pair && cause && (
        <div className="sim-paths">
          <p className="small">{t('sim.path.title', { from: label(pair[0]), to: label(pair[1]) })}</p>
          <p className="hint">{t('sim.path.before')}: {pathText(cause.before)}{cause.before.length ? ` (${t('sim.path.hops', { n: cause.before.length - 1 })})` : ''}</p>
          <p className="hint">{t('sim.path.after')}: {pathText(cause.after)}{cause.after.length ? ` (${t('sim.path.hops', { n: cause.after.length - 1 })})` : ''}</p>
          {cause.targetsOnPath.length > 0 && <p className="hint">{t('sim.path.targetsOnPath', { codes: cause.targetsOnPath.map(label).join(', ') })}</p>}
          {cause.lostLegs.length > 0 && <p className="hint">{t('sim.path.lostLegs', { legs: cause.lostLegs.map(([a, b]) => `${label(a)}–${label(b)}`).join(', ') })}</p>}
          {scenario.simulationModel === 'structural' && (
            looCause ? (
              <ul className="r-mini">
                {looCause.withoutEvent.map((w) => {
                  const e = scenario.events.find((x) => x.eventId === w.eventId)!;
                  return <li key={w.eventId}>{t('sim.path.without', { event: eventLabel(e, (id) => network.airports.find((a) => a.id === id)?.iata ?? id), result: w.hops > 0 ? t('sim.path.hops', { n: w.hops }) : t('sim.path.none') })}</li>;
                })}
              </ul>
            ) : (
              <button type="button" className="link-btn" onClick={() => {
                const base = { network, scope: { network, continentOf: network.airports.map(() => '?'), persistence: null }, scenario, beforeR: out.before.research, beforeNet: out.before.net };
                const sctx = scenarioContext(network, scenario.datasetVersion, ctx.meta?.range.startMs ?? 0, ctx.meta?.range.endMs ?? Infinity);
                const c = pairCause(base, sctx, ctx.atMs!, pair[0], pair[1], graphs, out.targetAirports, true);
                if (c) setLoo({ key: pairKey, cause: c });
              }}>{t('sim.path.checkEvents')}</button>
            )
          )}
          <p className="hint">{t('sim.path.note')} {t('sim.path.causeNote')}</p>
          <button type="button" className="link-btn" onClick={() => { setPair(null); setPathRoutes([]); }}>{t('sim.path.clear')}</button>
        </div>
      )}
    </>
  );
}

/** Whole-system / spillover table (secondary detail), and the heavy series computations. */
export function Connectivity() {
  const { t } = useI18n();
  const f = useFormat();
  const scenario = useAppStore((s) => s.simScenario)!;
  const series = useAppStore((s) => s.simSeries);
  const auto = useAppStore((s) => s.simAutoImpact);
  const setAuto = useAppStore((s) => s.setSimAutoImpact);
  const { out, imp, running, impact } = useCurrent();
  if (!out) return null;
  const rows: [MessageKey, (s: ReachStats) => number, 'pct' | 'dec'][] = [
    ['sim.c.reachable', (s) => s.reachable / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop1', (s) => s.hop1 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop2', (s) => s.hop2 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop3', (s) => s.hop3 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.efficiency', (s) => s.efficiency, 'dec'],
  ];
  const fmt = (v: number, k: 'pct' | 'dec') => (k === 'pct' ? f.pct(v) : f.dec(v, 4));
  const fixedStructural = scenario.simulationModel === 'structural' && scenario.baselineMode === 'fixed';
  return (
    <>
      <h3 className="section-title">{t('sim.connectivity')}</h3>
      <label className="sim-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span className="small">{t('sim.c.auto')}</span></label>
      {impact.state === 'error' && <Note warn>{impact.message}</Note>}
      {running && <p className="hint">{t('sim.c.running', { pct: Math.round((100 * running.done) / Math.max(1, running.total)) })}</p>}
      {imp && (
        <>
          <table className="r-table r-compact sim-table">
            <thead><tr><th /><th className="num">{t('sim.c.total')}</th><th className="num">{t('sim.c.spillover')}</th></tr></thead>
            <tbody>
              {rows.map(([k, get, kind]) => (
                <tr key={k}>
                  <td>{t(k)}</td>
                  <td className="num">{fmt(get(imp.total.before), kind)} → {fmt(get(imp.total.after), kind)}</td>
                  <td className="num">{fmt(get(imp.spillover.before), kind)} → {fmt(get(imp.spillover.after), kind)}</td>
                </tr>
              ))}
              <tr><td>{t('sim.c.pairs')}</td><td className="num">{f.int(imp.total.before.pairs)}</td><td className="num">{f.int(imp.spillover.before.pairs)}</td></tr>
              <tr><td>{t('sim.c.components')}</td><td className="num">{imp.components.before.count} → {imp.components.after.count}</td><td className="num">—</td></tr>
              <tr><td>{t('sim.c.largest')}</td><td className="num">{f.int(imp.components.before.largest)} → {f.int(imp.components.after.largest)}</td><td className="num">—</td></tr>
              <tr><td>{t('sim.c.lostPairs')}</td><td className="num">—</td><td className="num">{f.int(imp.lostPairs.total)}</td></tr>
            </tbody>
          </table>
          <p className="hint">{t('sim.c.hopChange', { same: f.int(imp.hopChange.same), p1: f.int(imp.hopChange.plus1), p2: f.int(imp.hopChange.plus2), p3: f.int(imp.hopChange.plus3more), lost: f.int(imp.hopChange.lost) })}</p>
          <p className="hint">{t('sim.c.definition', { n: f.int(imp.n), spill: f.int(imp.spillover.nodes), ms: f.int(imp.elapsedMs) })}</p>
        </>
      )}
      <h3 className="section-title">{t('sim.series.title')}</h3>
      <p className="hint">{series ? series.method : '—'}</p>
      {fixedStructural ? (
        <button type="button" className="pill-btn" onClick={() => void runSeriesImpact()}>{t('sim.series.impact')}</button>
      ) : scenario.baselineMode === 'dynamic' ? (
        <div className="sim-actions">
          <button type="button" className="pill-btn" onClick={() => void runSeries()}>{t('sim.series.run')}</button>
          <button type="button" className="link-btn" onClick={cancelSeries}>{t('sim.c.cancel')}</button>
        </div>
      ) : null}
      {series && <p className="hint">{t('sim.tl.chartNote', { done: f.int(series.done), total: f.int(series.total) })}</p>}
    </>
  );
}

/** Leave-one-out at the simulation time (structural): what changes when one event is left out. */
export function EventContributions({ ctx }: { ctx: SimContext }) {
  const { t } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const scenario = useAppStore((s) => s.simScenario)!;
  const { out } = useCurrent();
  const [res, setRes] = useState<{ key: string; rows: EventContribution[] } | null>(null);
  if (!out || scenario.simulationModel !== 'structural' || ctx.atMs === null) return null;
  const key = `${out.key}:${ctx.atMs}`;
  const rows = res && res.key === key ? res.rows : null;
  const codeOf = (id: string) => network.airports.find((a) => a.id === id)?.iata ?? id;
  return (
    <>
      <h3 className="section-title">{t('sim.loo.title')}</h3>
      {!rows ? (
        <button type="button" className="pill-btn" onClick={() => {
          const sctx = scenarioContext(network, scenario.datasetVersion, ctx.meta?.range.startMs ?? 0, ctx.meta?.range.endMs ?? Infinity);
          void networkIndex;
          setRes({ key, rows: leaveOneOut({ network, scope: { network, continentOf: network.airports.map(() => '?'), persistence: null }, scenario, beforeR: out.before.research, beforeNet: out.before.net }, sctx, ctx.atMs!) });
        }}>{t('sim.loo.run', { time: formatUtc(ctx.atMs) })}</button>
      ) : (
        <table className="r-table r-compact sim-table">
          <thead><tr><th>{t('sim.loo.event')}</th><th className="num">{t('sim.loo.with')}</th><th className="num">{t('sim.loo.without')}</th><th className="num">{t('sim.loo.diff')}</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const e = scenario.events.find((x) => x.eventId === r.eventId)!;
              return (
                <tr key={r.eventId}>
                  <td className="code">{eventLabel(e, codeOf)}</td>
                  <td className="num">{f.int(r.lostWith)}</td>
                  <td className="num">{f.int(r.lostWithout)}</td>
                  <td className="num">{f.int(r.lostWith - r.lostWithout)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hint">{t('sim.loo.note')}</p>
    </>
  );
}

/** Breakdowns of the selected flights (time proxy, airline code, region). */
export function Breakdown() {
  const { t, countryName } = useI18n();
  const f = useFormat();
  const { out } = useCurrent();
  if (!out) return null;
  const d = out.direct;
  const tm = out.temporal;
  return (
    <>
      <h3 className="section-title">{t('sim.direct')}</h3>
      <p className="hint">{t(out.model === 'temporal' ? 'sim.d.flightsTemporal.note' : 'sim.d.flightsStructural.note', { share: f.pct(d.baselineFlights ? d.flights / d.baselineFlights : null), total: f.int(d.baselineFlights) })}</p>
      <dl className="kv">
        <div className="kv-row"><dt>{t('sim.d.affectedAirports')}</dt><dd>{f.int(d.affectedAirports)}</dd></div>
        <div className="kv-row"><dt>{t('sim.d.lostDirected')}</dt><dd>{f.int(d.lostDirected)}</dd></div>
        <div className="kv-row"><dt>{t('sim.d.reduced')}</dt><dd>{f.int(d.reducedConnections)}</dd></div>
      </dl>
      {tm && (
        <dl className="kv">
          <div className="kv-row"><dt>{t('sim.tm.dep')}</dt><dd>{f.int(tm.dep)}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.arr')}</dt><dd>{f.int(tm.arr)}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.route')}</dt><dd>{f.int(tm.route)}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.basisStart')}</dt><dd>{f.int(tm.byBasis[0])}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.basisFallback')}</dt><dd>{f.int(tm.byBasis[1])}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.undetermined')}</dt><dd>{f.int(tm.undetermined)}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.byReference')}</dt><dd>{f.int(tm.affectedReference)}</dd></div>
          <div className="kv-row"><dt>{t('sim.tm.byEndpoint')}</dt><dd>{tm.affectedEndpoint === null ? '—' : f.int(tm.affectedEndpoint)}</dd></div>
        </dl>
      )}
      {tm && <p className="hint">{t('sim.tm.note')}</p>}
      {d.byCarrier.length > 0 && (
        <details className="sim-details">
          <summary className="small">{t('sim.d.byCarrier')}</summary>
          <dl className="kv">{d.byCarrier.slice(0, 10).map((c) => <div className="kv-row" key={c.carrier}><dt className="code">{c.carrier}</dt><dd>{f.int(c.flights)}</dd></div>)}</dl>
          <p className="hint">{t('sim.d.carrierNote')}</p>
        </details>
      )}
      {d.byRegion.length > 0 && (
        <details className="sim-details">
          <summary className="small">{t('sim.d.byRegion')}</summary>
          <dl className="kv">{d.byRegion.map((c) => <div className="kv-row" key={c.region}><dt>{c.region === '?' ? '—' : t(`r.region.${c.region}` as MessageKey)}</dt><dd>{f.int(c.flights)}</dd></div>)}</dl>
          <dl className="kv">{d.byCountry.slice(0, 8).map((c) => <div className="kv-row" key={c.country}><dt>{countryName(c.country)}</dt><dd>{f.int(c.flights)}</dd></div>)}</dl>
          <p className="hint">{t('sim.d.regionNote')}</p>
        </details>
      )}
    </>
  );
}
