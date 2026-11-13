import { useMemo } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { useAppStore } from '../../state/store';
import type { SimulationOutput } from '../../simulation/engine';
import { alternativePaths, distancesFrom, graphOf, type ImpactResult, type ReachStats } from '../../simulation/impact';
import type { SimulationScenario } from '../../simulation/model';
import { cancelImpact, runImpact, type SimContext } from '../../simulation/useSimulation';
import { windowQuality } from '../../temporal/quality';
import { formatUtc } from '../../temporal/window';
import { Note } from '../research/common';
import { useFormat } from '../research/format';
import { issueText } from './issueText';

export function SimResults({ scenario, ctx }: { scenario: SimulationScenario; ctx: SimContext }) {
  const { t } = useI18n();
  const f = useFormat();
  const status = useAppStore((s) => s.simStatus);
  const impact = useAppStore((s) => s.simImpact);
  const out = status.state === 'ready' && status.output.key === ctx.key ? status.output : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;

  const issues = ctx.disruption?.issues ?? [];
  const quality = useMemo(() => (ctx.meta && ctx.window ? windowQuality(ctx.meta.index, ctx.window, { flights: null }) : null), [ctx.meta, ctx.window]);

  return (
    <section className="sim-section" aria-live="polite">
      <span className="field-label">{t('sim.results')}</span>
      {ctx.window && <p className="hint">{t('sim.period.label', { start: formatUtc(ctx.window.startMs, false), end: formatUtc(ctx.window.endMs) })}</p>}
      {issues.map((i, k) => <Note warn key={`i${k}`}>{issueText(t, i)}</Note>)}
      {quality && quality.gapHours > 0 && <Note warn>{t('sim.q.gap', { hours: quality.gapHours, days: quality.gapDays.join(', ') })}</Note>}
      {status.state === 'error' && (
        <Note warn>{status.message === 'needsTemporal' ? t('sim.err.needsTemporal') : status.message === 'outside' ? t('sim.err.outside') : t('sim.err.failed', { message: status.message })}</Note>
      )}
      {(status.state === 'loading' || (status.state === 'ready' && !out)) && (
        <div className="r-progress" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>{status.state === 'loading' ? t('sim.loading', { done: status.done, total: status.total }) : t('sim.updating')}</span>
        </div>
      )}
      {scenario.events.filter((e) => e.enabled).length === 0 && <p className="hint">{t('sim.noEvents')}</p>}
      {out && <Direct out={out} scenario={scenario} />}
      {out && <Connectivity out={out} imp={imp} />}
      {out && imp && <AirportTable out={out} imp={imp} />}
      {out && <SelectedAirport out={out} imp={imp} />}
      {!out && status.state !== 'error' && ctx.windowProblem === null && status.state !== 'loading' && <p className="hint">{f.int(null)}</p>}
    </section>
  );
}

function Direct({ out, scenario }: { out: SimulationOutput; scenario: SimulationScenario }) {
  const { t, countryName } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const d = out.direct;
  const temporal = out.model === 'temporal';
  const tm = out.temporal;
  const noneActive = out.structural && out.structural.dep.size + out.structural.arr.size + out.structural.ab.size + out.structural.ba.size === 0;
  const short = out.window.endMs - out.window.startMs < 86_400_000;
  return (
    <>
      {noneActive && scenario.events.some((e) => e.enabled) && <Note warn>{t(out.baselineMode === 'fixed' && scenario.evaluationTime ? 'sim.q.noneAtTime' : 'sim.q.noneInPeriod')}</Note>}
      {temporal && tm && tm.affected === 0 && scenario.events.some((e) => e.enabled) && <Note warn>{t('sim.q.noRecords')}</Note>}
      {temporal && tm && tm.daysWithoutEndpoints.length > 0 && <Note warn>{t('sim.q.noEndpoints', { days: tm.daysWithoutEndpoints.join(', ') })}</Note>}
      {d.targetsNotInBaseline.length > 0 && (
        <Note warn>{t('sim.q.notInBaseline', { codes: d.targetsNotInBaseline.map((i) => network.airports[i]!.iata ?? network.airports[i]!.id).join(', ') })}</Note>
      )}
      {short && <Note>{t('t.shortWindowNote')}</Note>}
      <h3 className="section-title">{t('sim.direct')}</h3>
      <div className="stats sim-stats">
        <div className="stat"><span className="stat-value">{f.int(d.targets.length)}</span><span className="stat-label">{t('sim.d.targets')}</span></div>
        <div className="stat"><span className="stat-value">{f.int(d.affectedAirports)}</span><span className="stat-label">{t('sim.d.affectedAirports')}</span></div>
        <div className="stat"><span className="stat-value">{f.int(d.lostConnections)}</span><span className="stat-label">{t('sim.d.lost')}</span></div>
        {temporal && <div className="stat"><span className="stat-value">{f.int(d.reducedConnections)}</span><span className="stat-label">{t('sim.d.reduced')}</span></div>}
        <div className="stat"><span className="stat-value">{f.int(d.flights)}</span><span className="stat-label">{t(temporal ? 'sim.d.flightsTemporal' : 'sim.d.flightsStructural')}</span></div>
      </div>
      <p className="hint">{t(temporal ? 'sim.d.flightsTemporal.note' : 'sim.d.flightsStructural.note', { share: f.pct(d.baselineFlights ? d.flights / d.baselineFlights : null), total: f.int(d.baselineFlights) })}</p>
      {temporal && tm && (
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
      {temporal && <p className="hint">{t('sim.tm.note')}</p>}
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

function Connectivity({ out, imp }: { out: SimulationOutput; imp: ImpactResult | null }) {
  const { t } = useI18n();
  const f = useFormat();
  const state = useAppStore((s) => s.simImpact);
  const auto = useAppStore((s) => s.simAutoImpact);
  const setAuto = useAppStore((s) => s.setSimAutoImpact);
  const running = state.state === 'running' && state.key === `${out.key}:impact` ? state : null;
  const rows: [MessageKey, (s: ReachStats) => number, 'int' | 'pct' | 'dec'][] = [
    ['sim.c.reachable', (s) => s.reachable / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop1', (s) => s.hop1 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop2', (s) => s.hop2 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.hop3', (s) => s.hop3 / Math.max(1, s.pairs), 'pct'],
    ['sim.c.efficiency', (s) => s.efficiency, 'dec'],
  ];
  const fmt = (v: number, k: 'int' | 'pct' | 'dec') => (k === 'pct' ? f.pct(v) : k === 'dec' ? f.dec(v, 4) : f.int(v));
  const pair = (b: number, a: number, k: 'int' | 'pct' | 'dec') => `${fmt(b, k)} → ${fmt(a, k)}`;
  return (
    <>
      <h3 className="section-title">{t('sim.connectivity')}</h3>
      {!imp && !running && (
        <div className="sim-row">
          <button type="button" className="pill-btn sim-primary" onClick={runImpact}>{t('sim.c.run')}</button>
          <label className="sim-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span className="small">{t('sim.c.auto')}</span></label>
        </div>
      )}
      {state.state === 'error' && state.key === `${out.key}:impact` && <Note warn>{state.message}</Note>}
      {running && (
        <div className="r-progress" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>{t('sim.c.running', { pct: Math.round((100 * running.done) / Math.max(1, running.total)) })}</span>
          <button type="button" className="link-btn" onClick={cancelImpact}>{t('sim.c.cancel')}</button>
        </div>
      )}
      {imp && (
        <>
          <table className="r-table r-compact sim-table">
            <thead><tr><th /><th className="num">{t('sim.c.total')}</th><th className="num">{t('sim.c.spillover')}</th></tr></thead>
            <tbody>
              {rows.map(([k, get, kind]) => (
                <tr key={k}>
                  <td>{t(k)}</td>
                  <td className="num">{pair(get(imp.total.before), get(imp.total.after), kind)}</td>
                  <td className="num">{pair(get(imp.spillover.before), get(imp.spillover.after), kind)}</td>
                </tr>
              ))}
              <tr><td>{t('sim.c.pairs')}</td><td className="num">{f.int(imp.total.before.pairs)}</td><td className="num">{f.int(imp.spillover.before.pairs)}</td></tr>
              <tr><td>{t('sim.c.components')}</td><td className="num">{pair(imp.components.before.count, imp.components.after.count, 'int')}</td><td className="num">—</td></tr>
              <tr><td>{t('sim.c.largest')}</td><td className="num">{pair(imp.components.before.largest, imp.components.after.largest, 'int')}</td><td className="num">—</td></tr>
              <tr><td>{t('sim.c.lostPairs')}</td><td className="num">—</td><td className="num">{f.int(imp.lostPairs.total)}</td></tr>
            </tbody>
          </table>
          <p className="hint">{t('sim.c.hopChange', { same: f.int(imp.hopChange.same), p1: f.int(imp.hopChange.plus1), p2: f.int(imp.hopChange.plus2), p3: f.int(imp.hopChange.plus3more), lost: f.int(imp.hopChange.lost) })}</p>
          <p className="hint">{t('sim.c.definition', { n: f.int(imp.n), spill: f.int(imp.spillover.nodes), ms: f.int(imp.elapsedMs) })}</p>
        </>
      )}
    </>
  );
}

function AirportTable({ out, imp }: { out: SimulationOutput; imp: ImpactResult }) {
  const { t, countryName } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const selectAirport = useAppStore((s) => s.selectAirport);
  const rows = useMemo(() => {
    const targets = new Set(out.targetAirports);
    const p = imp.perNode;
    return out.impactNodes
      .map((g, i) => ({ g, i, target: targets.has(g), lost: p.lost[i]!, hop2: p.hop2Before[i]! - p.hop2After[i]!, deg: p.degBefore[i]! - p.degAfter[i]!, longer: p.longer[i]! }))
      .filter((r) => !r.target && (r.lost > 0 || r.hop2 > 0 || r.deg > 0 || r.longer > 0))
      .sort((a, b) => b.lost - a.lost || b.hop2 - a.hop2 || b.deg - a.deg || b.longer - a.longer || a.g - b.g);
  }, [out, imp]);
  const p = imp.perNode;
  return (
    <>
      <h3 className="section-title">{t('sim.a.title')}</h3>
      <p className="hint">{t('sim.a.note', { n: f.int(rows.length) })}</p>
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
            {rows.slice(0, 15).map((r) => {
              const a = network.airports[r.g]!;
              return (
                <tr key={r.g} className="r-click" onClick={() => selectAirport(r.g)} title={`${a.name} · ${countryName(a.country)}`}>
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

/** The selected airport: its changes, partners it lost, and alternative paths to one of them. */
function SelectedAirport({ out, imp }: { out: SimulationOutput; imp: ImpactResult | null }) {
  const { t } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const selected = useAppStore((s) => s.selectedAirport);
  const pair = useAppStore((s) => s.simPair);
  const setPair = useAppStore((s) => s.setSimPair);
  const setPathRoutes = useAppStore((s) => s.setSimPathRoutes);
  const graphs = useMemo(() => {
    const inp = out.impactInput;
    return { before: graphOf(inp.n, inp.before, inp.directed), after: graphOf(inp.n, inp.after, inp.directed), local: new Map(out.impactNodes.map((g, i) => [g, i])) };
  }, [out]);
  const local = selected !== null ? graphs.local.get(selected) : undefined;
  const detail = useMemo(() => {
    if (local === undefined) return null;
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
  const routeOf = useMemo(() => {
    const m = new Map<string, number>();
    network.routes.forEach((r, i) => m.set(`${Math.min(r.a, r.b)}-${Math.max(r.a, r.b)}`, i));
    return (x: number, y: number) => m.get(`${Math.min(x, y)}-${Math.max(x, y)}`);
  }, [network]);
  const paths = useMemo(() => {
    if (!pair || local === undefined) return null;
    const s = graphs.local.get(pair[0]);
    const e = graphs.local.get(pair[1]);
    if (s === undefined || e === undefined) return null;
    return { before: alternativePaths(graphs.before, s, e, 3), after: alternativePaths(graphs.after, s, e, 3) };
  }, [pair, graphs, local]);
  if (selected === null) return null;
  const ap = network.airports[selected]!;
  const label = (i: number) => {
    const a = network.airports[out.impactNodes[i]!]!;
    return a.iata ?? a.id;
  };
  if (local === undefined) return <p className="hint">{t('sim.sel.notInNetwork', { code: ap.iata ?? ap.id })}</p>;
  const show = (s: number, e: number) => {
    setPair([out.impactNodes[s]!, out.impactNodes[e]!]);
    const p = alternativePaths(graphs.after, s, e, 1)[0] ?? alternativePaths(graphs.before, s, e, 1)[0] ?? [];
    setPathRoutes(p.slice(1).map((v, k) => routeOf(out.impactNodes[p[k]!]!, out.impactNodes[v]!)).filter((x): x is number => x !== undefined));
  };
  const pathText = (p: number[]) => p.map(label).join(' → ');
  const pi = imp?.perNode;
  return (
    <>
      <h3 className="section-title">{t('sim.sel.title', { code: ap.iata ?? ap.id })}</h3>
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
          <div className="sim-chips">{detail.lost.slice(0, 24).map((i) => <button key={i} type="button" className="pill-btn" onClick={() => show(local, i)}>{label(i)}</button>)}</div>
        </>
      )}
      {detail && detail.longer.length > 0 && (
        <>
          <p className="small">{t('sim.sel.longer', { n: f.int(detail.longer.length) })}</p>
          <div className="sim-chips">{detail.longer.slice(0, 24).map((x) => <button key={x.i} type="button" className="pill-btn" onClick={() => show(local, x.i)}>{label(x.i)} {x.b}→{x.a}</button>)}</div>
        </>
      )}
      {detail && detail.lost.length === 0 && detail.longer.length === 0 && <p className="hint">{t('sim.sel.unchanged')}</p>}
      {paths && pair && (
        <div className="sim-paths">
          <p className="small">{t('sim.path.title', { from: label(graphs.local.get(pair[0])!), to: label(graphs.local.get(pair[1])!) })}</p>
          <p className="hint">{t('sim.path.before')}: {paths.before.length ? paths.before.map(pathText).join(' / ') : t('sim.path.none')}</p>
          <p className="hint">{t('sim.path.after')}: {paths.after.length ? paths.after.map(pathText).join(' / ') : t('sim.path.none')}</p>
          <p className="hint">{t('sim.path.note')}</p>
          <button type="button" className="link-btn" onClick={() => { setPair(null); setPathRoutes([]); }}>{t('sim.path.clear')}</button>
        </div>
      )}
    </>
  );
}
