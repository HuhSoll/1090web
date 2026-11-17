import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { compare } from '../../islands/access';
import { alternatives } from '../../islands/alternatives';
import { useIslandData, type IslandData } from '../../islands/data';
import { comparisonCsv, islandResultJson } from '../../islands/exports';
import { baseScenario, PILOT_AIRPORTS, type Change, type Comparison, type Gateway, type IslandScenario, type MeshAccess, type Service, type ServiceLevel } from '../../islands/model';
import { useAppStore } from '../../state/store';
import { downloadText, useFormat } from './format';

const LEVELS: ServiceLevel[] = ['daily', 'weekly', 'any'];

/** Research > Island dependency (Phase 9F): what an island airport stop means for the residents. */
export function IslandsPanel() {
  const { t } = useI18n();
  const s = useIslandData();
  if (s.state === 'loading') return <p className="hint"><span className="spinner" aria-hidden="true" /> {t('i.loading')}</p>;
  if (s.state === 'error') return <div className="r-box r-warn"><h4 className="r-h4">{t('i.loadError')}</h4><p className="small mono">{s.message}</p></div>;
  return <IslandsLab data={s.data} />;
}

function IslandsLab({ data }: { data: IslandData }) {
  const { t, locale } = useI18n();
  const f = useFormat();
  const { meta, network, meshes } = data;
  const setHandoff = useAppStore((s) => s.setIslandHandoff);
  const nm = (x: { nameJa: string; nameEn: string }) => (locale === 'ja' ? x.nameJa : x.nameEn);
  const gw = useMemo(() => new Map(network.gateways.map((g) => [g.id, g])), [network]);
  const svc = useMemo(() => new Map(network.services.map((s) => [s.id, s])), [network]);

  // Simulation -> "check the impact on residents": the stopped island airports are read once, when
  // the panel opens, and the result is computed right away.
  const [start] = useState(() => {
    const h = useAppStore.getState().islandHandoff;
    const aps = h ? h.airports.filter((a) => PILOT_AIRPORTS.includes(a)) : [];
    const cond0: IslandScenario = { ...baseScenario(meta.defaultDestination), serviceLevel: 'daily' };
    if (!aps.length) return { island: 'ishigaki', stopped: ['ROIG'], cond: cond0, ran: null as IslandScenario | null, fromSim: null as string | null };
    const isl = network.gateways.find((g) => g.id === aps[0])?.island ?? 'ishigaki';
    const name = h!.scenarioName || aps.map((a) => network.gateways.find((g) => g.id === a)?.iata ?? a).join(', ');
    return { island: isl, stopped: aps, cond: cond0, ran: { ...cond0, stoppedAirports: aps }, fromSim: name };
  });
  useEffect(() => {
    if (useAppStore.getState().islandHandoff) setHandoff(null);
  }, [setHandoff]);

  const [island, setIsland] = useState(start.island);
  const [stopped, setStopped] = useState<string[]>(start.stopped);
  const [cond, setCond] = useState<IslandScenario>(start.cond);
  const [ran, setRan] = useState<IslandScenario | null>(start.ran);
  const [view, setView] = useState<'change' | 'before' | 'after'>('change');
  const fromSim = start.fromSim;

  const islandInfo = meta.islands.find((i) => i.id === island)!;
  const airportsOnIsland = network.gateways.filter((g) => g.kind === 'airport' && g.island === island);
  const pilotAirports = PILOT_AIRPORTS.map((a) => gw.get(a)!).filter(Boolean);

  const chooseIsland = (id: string) => {
    setIsland(id);
    const own = network.gateways.filter((g) => g.kind === 'airport' && g.island === id).map((g) => g.id);
    setStopped(own.length ? [own[0]!] : usedAirport(id) ? [usedAirport(id)!] : []);
    setRan(null);
  };
  // airport the residents of an island without an airport use first (by the base route)
  const usedAirport = (id: string): string | null => {
    const r = compare(network, meshes, baseScenario(cond.destination), baseScenario(cond.destination));
    const c = new Map<string, number>();
    for (const [, isl, pop, b] of r.rows) {
      if (isl !== id || !b.path?.length) continue;
      for (const sid of b.path) {
        const s = svc.get(sid);
        if (s?.mode === 'air') {
          for (const end of [s.a, s.b]) if (gw.get(end)?.island) c.set(end, (c.get(end) ?? 0) + pop);
          break;
        }
      }
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  const scenario = (extra: Partial<IslandScenario> = {}): [IslandScenario, IslandScenario] => {
    const base: IslandScenario = { ...cond, stoppedAirports: [], stoppedServices: [], ...extra };
    const after: IslandScenario = { ...cond, stoppedAirports: stopped, ...extra };
    return [base, after];
  };
  const run = () => setRan({ ...cond, stoppedAirports: stopped });
  const current = ran ? scenario() : null;
  const result = useMemo(() => (current ? compare(network, meshes, current[0], current[1]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ran, cond, stopped, network, meshes]);
  // the headline under both service conditions (a rare ferry is an alternative only under "any")
  const both = useMemo(() => {
    if (!ran) return null;
    const out: Record<'daily' | 'any', Comparison> = {} as Record<'daily' | 'any', Comparison>;
    for (const lv of ['daily', 'any'] as const) {
      const [b, a] = scenario({ serviceLevel: lv });
      out[lv] = compare(network, meshes, b, a);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ran, cond, stopped, network, meshes]);

  const freqLabel = useFreq();
  const freqOf = (s: Service) => (locale === 'ja' ? `（${freqLabel(s)}）` : `(${freqLabel(s)})`);
  const svcLabel = (s: Service) => `${gwName(gw.get(s.a))} – ${gwName(gw.get(s.b))}`;
  const gwName = (g: Gateway | undefined) => (g ? (g.kind === 'airport' ? `${nm(g)}${g.iata ? ` (${g.iata})` : ''}` : nm(g)) : '?');
  const dest = meta.destinations.find((d) => d.id === cond.destination)!;
  const tot = result?.totals[island];
  const all = result?.totals._all;
  const base = `islands_${stopped.join('-') || 'none'}_${cond.destination}_${cond.serviceLevel}`;

  return (
    <div className="r-stack i-lab">
      <section className="r-box">
        <h3 className="r-h4">{t('i.title')}</h3>
        <p className="small x-dim">{t('i.lead')}</p>
        {fromSim && <p className="hint">{t('i.fromSim', { name: fromSim })}</p>}
        <div className="i-setup">
          <label className="r-inline"><span className="small">{t('i.island')}</span>
            <select className="r-input" value={island} onChange={(e) => chooseIsland(e.target.value)}>
              {meta.islands.map((i) => <option key={i.id} value={i.id}>{nm(i)}（{f.int(i.population2020)}{t('i.persons')}）</option>)}
            </select>
          </label>
          <fieldset className="i-airports">
            <legend className="small">{t('i.stopAirports')}</legend>
            {pilotAirports.map((g) => (
              <label key={g.id} className={`r-inline${g.island === island ? '' : ' x-dim'}`}>
                <input type="checkbox" checked={stopped.includes(g.id)} onChange={(e) => setStopped(e.target.checked ? [...stopped, g.id] : stopped.filter((x) => x !== g.id))} />
                {gwName(g)}
              </label>
            ))}
          </fieldset>
          <label className="r-inline"><span className="small">{t('i.destination')}</span>
            <select className="r-input" value={cond.destination} onChange={(e) => setCond({ ...cond, destination: e.target.value })}>
              {meta.destinations.map((d) => <option key={d.id} value={d.id}>{nm(d)} — {t(`i.destKind.${d.kind}` as MessageKey)}</option>)}
            </select>
          </label>
          <div className="segmented" role="group" aria-label={t('i.level')}>
            {LEVELS.map((lv) => <button key={lv} type="button" className={cond.serviceLevel === lv ? 'is-active' : ''} onClick={() => setCond({ ...cond, serviceLevel: lv })}>{t(`i.level.${lv}`)}</button>)}
          </div>
          <button type="button" className="pill-btn i-run" disabled={!stopped.length} onClick={run}>{t('i.run')}</button>
        </div>
        {!airportsOnIsland.length && <p className="small x-dim">{t('i.noAirport', { island: nm(islandInfo) })}</p>}
        <details className="x-advanced">
          <summary className="small">{t('i.advanced')}</summary>
          <div className="i-adv">
            <label className="r-inline"><input type="checkbox" checked={cond.air} onChange={(e) => setCond({ ...cond, air: e.target.checked })} />{t('i.mode.air')}</label>
            <label className="r-inline"><input type="checkbox" checked={cond.sea} onChange={(e) => setCond({ ...cond, sea: e.target.checked })} />{t('i.mode.sea')}</label>
            <label className="r-inline"><input type="checkbox" checked={cond.bridges} onChange={(e) => setCond({ ...cond, bridges: e.target.checked })} />{t('i.bridges')}</label>
            <label className="r-inline"><input type="checkbox" checked={cond.includeSeasonal} onChange={(e) => setCond({ ...cond, includeSeasonal: e.target.checked })} />{t('i.seasonal')}</label>
            <label className="r-inline"><span className="small">{t('i.budget')}</span>
              <input className="r-input x-narrow" type="number" min={0} step={0.5} value={cond.timeBudgetMin === null ? '' : cond.timeBudgetMin / 60}
                onChange={(e) => setCond({ ...cond, timeBudgetMin: e.target.value === '' ? null : Number(e.target.value) * 60 })} />
            </label>
          </div>
          <p className="small">{t('i.stopServices')}</p>
          <div className="i-services">
            {network.services.filter((s) => s.mode === 'sea').map((s) => (
              <label key={s.id} className="r-inline small">
                <input type="checkbox" checked={cond.stoppedServices.includes(s.id)}
                  onChange={(e) => setCond({ ...cond, stoppedServices: e.target.checked ? [...cond.stoppedServices, s.id] : cond.stoppedServices.filter((x) => x !== s.id) })} />
                {svcLabel(s)} {freqOf(s)}
              </label>
            ))}
          </div>
          <p className="small x-dim">{t('i.stopServices.note')}</p>
          <p className="small x-dim">{t('i.assumptions', { air: meta.assumptions.terminalMin.air, sea: meta.assumptions.terminalMin.sea, conn: meta.assumptions.connectorKmh })}</p>
        </details>
      </section>

      {!result && <p className="hint">{t('i.pressRun')}</p>}

      {result && both && tot && all && (
        <>
          <section className="r-box">
            <h3 className="r-h4">{t('i.summary', { airports: stopped.map((a) => gwName(gw.get(a))).join('、'), dest: nm(dest) })}</h3>
            <div className="stats r-stats">
              <Stat label={t('i.stat.target')} value={`${f.int(tot.pop)}`} sub={t('i.stat.targetSub', { island: nm(islandInfo) })} />
              <Stat label={t('i.stat.lostDaily')} value={f.int(both.daily.totals[island]?.lost ?? 0)} sub={t('i.stat.lostDailySub')} warn={(both.daily.totals[island]?.lost ?? 0) > 0} />
              <Stat label={t('i.stat.lostAny')} value={f.int(both.any.totals[island]?.lost ?? 0)} sub={t('i.stat.lostAnySub')} warn={(both.any.totals[island]?.lost ?? 0) > 0} />
              <Stat label={t('i.stat.exposed')} value={f.int(tot.exposed)} sub={t(`i.level.${cond.serviceLevel}`)} />
              <Stat label={t('i.stat.delta')} value={tot.meanDeltaMin === null ? '—' : `+${f.dec(tot.meanDeltaMin, 0)} ${t('i.min')}`} sub={tot.deltaPop ? t('i.stat.deltaSub', { n: f.int(tot.deltaPop), max: f.dec(tot.deltaMax, 0) }) : t('i.stat.deltaNone')} />
              <Stat label={t('i.stat.undetermined')} value={f.int(tot.undetermined)} sub={t('i.stat.undeterminedSub')} />
            </div>
            <Alternatives daily={both.daily} any={both.any} island={island} level={cond.serviceLevel} svc={svc} gw={gw} gwName={gwName} />
            <p className="small x-dim">{t('i.readAs', { level: t(`i.level.${cond.serviceLevel}`), dest: nm(dest) })}</p>
            <Quality data={data} />
          </section>

          <section className="r-box">
            <div className="r-toolbar">
              <h4 className="r-h4">{t('i.map')}</h4>
              <div className="segmented" role="group" aria-label={t('i.map')}>
                {(['change', 'before', 'after'] as const).map((v) => <button key={v} type="button" className={view === v ? 'is-active' : ''} onClick={() => setView(v)}>{t(`i.view.${v}`)}</button>)}
              </div>
            </div>
            <IslandMap data={data} island={island} r={result} view={view} stopped={stopped} />
          </section>

          <section className="r-box">
            <h4 className="r-h4">{t('i.byIsland')}</h4>
            <div className="r-table-wrap">
              <table className="r-table r-compact">
                <thead><tr>
                  <th>{t('i.col.island')}</th><th className="num">{t('i.col.pop')}</th><th className="num">{t('i.col.exposed')}</th><th className="num">{t('i.col.lost')}</th>
                  <th className="num">{t('i.col.slower')}</th><th className="num">{t('i.col.mean')}</th><th className="num">{t('i.col.undetermined')}</th><th className="num">{t('i.col.noAccess')}</th>
                </tr></thead>
                <tbody>
                  {meta.islands.map((i) => {
                    const x = result.totals[i.id];
                    if (!x) return null;
                    return (
                      <tr key={i.id} className={i.id === island ? 'is-selected' : ''}>
                        <td>{nm(i)}</td><td className="num">{f.int(x.pop)}</td><td className="num">{f.int(x.exposed)}</td><td className="num">{f.int(x.lost)}</td>
                        <td className="num">{f.int(x.slower)}</td><td className="num">{x.meanDeltaMin === null ? '—' : `+${f.dec(x.meanDeltaMin, 0)}`}</td>
                        <td className="num">{f.int(x.undetermined)}</td><td className="num">{f.int(x.noAccess)}</td>
                      </tr>
                    );
                  })}
                  <tr><td><strong>{t('i.all')}</strong></td><td className="num">{f.int(all.pop)}</td><td className="num">{f.int(all.exposed)}</td><td className="num">{f.int(all.lost)}</td>
                    <td className="num">{f.int(all.slower)}</td><td className="num">{all.meanDeltaMin === null ? '—' : `+${f.dec(all.meanDeltaMin, 0)}`}</td>
                    <td className="num">{f.int(all.undetermined)}</td><td className="num">{f.int(all.noAccess)}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="small x-dim">{t('i.byIsland.note', { pm: f.int(all.personMinutes) })}{cond.timeBudgetMin !== null ? ` ${t('i.budgetResult', { h: f.dec(cond.timeBudgetMin / 60, 1), n: f.int(all.lostWithinBudget) })}` : ''}</p>
            <div className="r-buttons">
              <button type="button" className="pill-btn" onClick={() => downloadText(`${base}.csv`, comparisonCsv(result))}>{t('i.csv')}</button>
              <button type="button" className="pill-btn" onClick={() => current && downloadText(`${base}.json`, islandResultJson(result, current[0], current[1], meta.region, meta.buildVersion), 'application/json')}>{t('i.json')}</button>
            </div>
          </section>

          <details className="r-box">
            <summary className="r-h4">{t('i.sens')}</summary>
            <Sensitivity data={data} stopped={stopped} cond={cond} island={island} />
          </details>
        </>
      )}

      <details className="r-box" open={!result}>
        <summary className="r-h4">{t('i.global')}</summary>
        <GlobalVsLocal data={data} destination={cond.destination} gwName={gwName} />
      </details>

      <details className="r-box">
        <summary className="r-h4">{t('i.sources')}</summary>
        <Sources data={data} svcLabel={svcLabel} svc={svc} />
      </details>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={warn ? 'stat-value i-warn' : 'stat-value'}>{value}</span>
      {sub && <span className="small x-dim">{sub}</span>}
    </div>
  );
}

/** Where the residents go after the stop (by population), and whether that is a real alternative. */
/** Frequency as published (Japanese) or as round trips per week (English). */
function useFreq() {
  const { t, locale } = useI18n();
  const f = useFormat();
  return (s: Service) => (locale === 'ja' ? s.frequencyText : t('i.freqWeek', { n: f.dec(s.roundTripsPerWeek, s.roundTripsPerWeek % 1 ? 2 : 0) }));
}

function Alternatives({ daily, any, island, level, svc, gw, gwName }: { daily: Comparison; any: Comparison; island: string; level: ServiceLevel; svc: Map<string, Service>; gw: Map<string, Gateway>; gwName: (g: Gateway | undefined) => string }) {
  const { t } = useI18n();
  const freq = useFreq();
  const f = useFormat();
  const groups = alternatives(daily, any, island);
  const total = groups.reduce((s, g) => s + g.pop, 0);
  // the most common first leg of each class, with the scarcest service on the route
  const route = (ex: MeshAccess[]) => {
    const c = new Map<string, number>();
    for (const a of ex) {
      const first = a.path?.[0] ? svc.get(a.path[0]) : undefined;
      if (!first) continue;
      const k = `${t(first.mode === 'air' ? 'i.alt.air' : 'i.alt.sea', { at: gwName(gw.get(a.board ?? '')), freq: freq(first) })}${a.minFreq != null ? ` ${t('i.alt.scarcest', { n: f.dec(a.minFreq, a.minFreq % 1 ? 2 : 0) })}` : ''}${a.status === 'time-unknown' ? ` ${t('i.alt.timeUnknown')}` : ''}`;
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return [...c.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k);
  };
  return (
    <div className="i-alt">
      <h4 className="small">{t('i.alt.title')}</h4>
      <p className="small x-dim">{t('i.alt.levelNote', { level: t(`i.level.${level}`) })}</p>
      <ul className="r-mini">
        {groups.map((g) => (
          <li key={g.cls} className={g.pop ? '' : 'x-dim'}>
            <strong>{t(`i.alt.cls.${g.cls}`)}</strong> — {t('i.alt.count', { n: f.int(g.pop), p: f.pct(total ? g.pop / total : 0, 0) })}
            {g.pop > 0 && (g.cls === 'daily' || g.cls === 'lowFreq') && <span className="small x-dim">：{route(g.examples).join(' / ')}</span>}
          </li>
        ))}
      </ul>
      {groups.find((g) => g.cls === 'lowFreq')!.pop > 0 && <p className="small x-dim">{t('i.alt.lowFreqNote')}</p>}
    </div>
  );
}

function Quality({ data }: { data: IslandData }) {
  const { t } = useI18n();
  const q = data.meta.quality;
  const missingAdsb = q.airObservedVsOfficial.filter((x) => x.status === 'operating' && x.observedFlights === 0).length;
  return (
    <ul className="r-mini i-quality">
      <li>{t('i.q.pop', { year: q.populationYear, mesh: q.meshLevel })}</li>
      <li>{t('i.q.services', { air: data.meta.serviceSources['pref-r8']!.asOfAir.slice(0, 10), sea: data.meta.serviceSources['pref-r8']!.asOfSea.slice(0, 10) })}</li>
      <li>{t('i.q.model')}</li>
      <li>{t('i.q.adsb', { n: missingAdsb })}</li>
      <li>{t('i.q.years')}</li>
    </ul>
  );
}

// ---- map --------------------------------------------------------------------------------------

const TIME_BINS = [90, 180, 360, 720];
const TIME_COLORS = ['#7fd6ff', '#b8ecff', '#ffd27a', '#f2b45a', '#ff7a7a'];
const CHANGE_COLORS: Record<Change, string> = {
  lost: '#ff6147', slower: '#ffd27a', 'fewer-services': '#f2b45a', undetermined: '#8193a8', same: 'rgba(127, 214, 255, 0.35)', better: 'rgba(127, 214, 255, 0.35)', 'n/a': 'transparent',
};

function accessColor(a: MeshAccess): string {
  if (a.status === 'unreachable') return '#ff6147';
  if (a.status === 'time-unknown') return '#8193a8';
  if (a.status !== 'ok') return 'transparent';
  const i = TIME_BINS.findIndex((b) => a.time! <= b);
  return TIME_COLORS[i < 0 ? TIME_BINS.length : i]!;
}

function IslandMap({ data, island, r, view, stopped }: { data: IslandData; island: string; r: Comparison; view: 'change' | 'before' | 'after'; stopped: string[] }) {
  const { t, locale } = useI18n();
  const f = useFormat();
  const poly = data.geo.islands.find((i) => i.island === island);
  const rows = r.rows.filter((x) => x[1] === island);
  const gws = data.network.gateways.filter((g) => g.island === island && g.kind !== 'portGroup');
  if (!poly) return null;
  const pts = poly.rings[0]!;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of pts) { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
  const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
  const W = 640;
  const pad = 0.06;
  const spanX = (x1 - x0) * k;
  const spanY = y1 - y0;
  const s = (W * (1 - 2 * pad)) / Math.max(spanX, spanY * 1.25);
  const H = Math.min(560, Math.max(260, spanY * s / (1 - 2 * pad)));
  const X = (lon: number) => W * pad + (lon - x0) * k * s + (W * (1 - 2 * pad) - spanX * s) / 2;
  const Y = (lat: number) => H * pad + (y1 - lat) * s + (H * (1 - 2 * pad) - spanY * s) / 2;
  const d = (ring: [number, number][]) => ring.map(([lon, lat], i) => `${i ? 'L' : 'M'}${X(lon).toFixed(1)},${Y(lat).toFixed(1)}`).join('') + 'Z';
  const line = (c: [number, number][]) => c.map(([lon, lat], i) => `${i ? 'L' : 'M'}${X(lon).toFixed(1)},${Y(lat).toFixed(1)}`).join('');
  const inBox = (c: [number, number][]) => c.some(([lon, lat]) => lon >= x0 - 0.02 && lon <= x1 + 0.02 && lat >= y0 - 0.02 && lat <= y1 + 0.02);
  const dlat = 7.5 / 3600;
  const dlon = 11.25 / 3600;
  const meshByCode = new Map(data.meshes.rows.map((m) => [m[0], m]));
  const legend = view === 'change'
    ? (['lost', 'slower', 'fewer-services', 'undetermined', 'same'] as Change[]).map((c) => ({ c: CHANGE_COLORS[c], l: t(`i.ch.${c}` as MessageKey) }))
    : [...TIME_BINS.map((b, i) => ({ c: TIME_COLORS[i]!, l: `≤ ${f.dec(b / 60, 1)} h` })), { c: TIME_COLORS[4]!, l: `> ${f.dec(12, 0)} h` }, { c: '#8193a8', l: t('i.st.time-unknown') }, { c: '#ff6147', l: t('i.st.unreachable') }];
  return (
    <>
      <svg className="i-map" viewBox={`0 0 ${W} ${H.toFixed(0)}`} role="img" aria-label={t('i.map')}>
        <rect x={0} y={0} width={W} height={H} className="x-map-bg" />
        {poly.rings.map((ring, i) => <path key={i} d={d(ring)} className="x-land" />)}
        {data.geo.roads.filter((x) => inBox(x.c)).map((x, i) => <path key={i} d={line(x.c)} className={x.w >= 3 ? 'i-road i-road-main' : 'i-road'} />)}
        {data.geo.links.filter(inBox).map((x, i) => <path key={`l${i}`} d={line(x)} className="i-link" />)}
        {rows.map(([code, , pop, b, a, ch]) => {
          const m = meshByCode.get(code)!;
          const fill = view === 'change' ? CHANGE_COLORS[ch] : accessColor(view === 'before' ? b : a);
          const acc = view === 'before' ? b : a;
          return (
            <rect key={code} x={X(m[2] - dlon / 2)} y={Y(m[1] + dlat / 2)} width={Math.max(1, dlon * k * s)} height={Math.max(1, dlat * s)} fill={fill} className="i-mesh">
              <title>{`${code}: ${f.int(pop)}${t('i.persons')} — ${t(`i.st.${acc.status}` as MessageKey)}${acc.time != null ? ` ${f.dec(acc.time, 0)} ${t('i.min')}` : ''} / ${t(`i.ch.${ch}` as MessageKey)}`}</title>
            </rect>
          );
        })}
        {gws.map((g) => (
          <g key={g.id} transform={`translate(${X(g.lon).toFixed(1)},${Y(g.lat).toFixed(1)})`} className={stopped.includes(g.id) ? 'i-gw is-stopped' : 'i-gw'}>
            {g.kind === 'airport' ? <path d="M0,-6 L5,4 L-5,4 Z" /> : <rect x={-3.5} y={-3.5} width={7} height={7} />}
            <text x={7} y={4} className="small">{g.kind === 'airport' ? g.iata : (locale === 'ja' ? g.nameJa : g.nameEn).replace(/（.*?）|\(.*?\)/g, '')}</text>
          </g>
        ))}
      </svg>
      <div className="legend i-legend">
        {legend.map((x) => <span key={x.l} className="legend-item"><span className="i-swatch" style={{ background: x.c }} />{x.l}</span>)}
        <span className="legend-item"><span className="i-swatch i-swatch-ap" />{t('i.legend.airport')}</span>
        <span className="legend-item"><span className="i-swatch i-swatch-port" />{t('i.legend.port')}</span>
      </div>
      <p className="small x-dim">{t(view === 'change' ? 'i.map.noteChange' : 'i.map.noteTime')} {data.geo.credit}</p>
    </>
  );
}

// ---- sensitivity --------------------------------------------------------------------------------

function Sensitivity({ data, stopped, cond, island }: { data: IslandData; stopped: string[]; cond: IslandScenario; island: string }) {
  const { t, locale } = useI18n();
  const f = useFormat();
  const rows = useMemo(() => {
    const variants: { key: string; label: string; c: Partial<IslandScenario> }[] = [
      ...LEVELS.map((lv) => ({ key: `lv-${lv}`, label: t(`i.level.${lv}`), c: { serviceLevel: lv } })),
      { key: 'nosea', label: t('i.sens.noSea'), c: { sea: false } },
      { key: 'nobridge', label: t('i.sens.noBridge'), c: { bridges: false } },
      { key: 'seasonal', label: t('i.sens.seasonal'), c: { includeSeasonal: true } },
      ...data.meta.destinations.map((d) => ({ key: `d-${d.id}`, label: `${t('i.destination')}: ${locale === 'ja' ? d.nameJa : d.nameEn}`, c: { destination: d.id } })),
    ];
    return variants.map((v) => {
      const b = { ...cond, stoppedAirports: [], stoppedServices: [], ...v.c };
      const a = { ...cond, stoppedAirports: stopped, ...v.c };
      const r = compare(data.network, data.meshes, b, a);
      return { ...v, tot: r.totals[island]!, all: r.totals._all! };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stopped, cond, island, locale]);
  return (
    <>
      <p className="small x-dim">{t('i.sens.lead')}</p>
      <div className="r-table-wrap">
        <table className="r-table r-compact">
          <thead><tr><th>{t('i.sens.cond')}</th><th className="num">{t('i.col.exposed')}</th><th className="num">{t('i.col.lost')}</th><th className="num">{t('i.col.slower')}</th><th className="num">{t('i.col.mean')}</th><th className="num">{t('i.col.undetermined')}</th><th className="num">{t('i.sens.allLost')}</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.key}><td>{x.label}</td><td className="num">{f.int(x.tot.exposed)}</td><td className="num">{f.int(x.tot.lost)}</td><td className="num">{f.int(x.tot.slower)}</td>
              <td className="num">{x.tot.meanDeltaMin === null ? '—' : `+${f.dec(x.tot.meanDeltaMin, 0)}`}</td><td className="num">{f.int(x.tot.undetermined)}</td><td className="num">{f.int(x.all.lost)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

// ---- Phase 9E comparison ----------------------------------------------------------------------------

function GlobalVsLocal({ data, destination, gwName }: { data: IslandData; destination: string; gwName: (g: Gateway | undefined) => string }) {
  const { t } = useI18n();
  const f = useFormat();
  const g = data.global;
  const rows = useMemo(() => PILOT_AIRPORTS.map((ap) => {
    const daily = { ...baseScenario(destination), serviceLevel: 'daily' as const };
    const rd = compare(data.network, data.meshes, daily, { ...daily, stoppedAirports: [ap] });
    const any = baseScenario(destination);
    const ra = compare(data.network, data.meshes, any, { ...any, stoppedAirports: [ap] });
    // population whose base route uses this airport (its users under the model, also via a ship first)
    let users = 0;
    for (const [, , pop, b] of ra.rows) if (b.path?.some((sid) => { const s = data.network.services.find((x) => x.id === sid); return s?.a === ap || s?.b === ap; })) users += pop;
    const gi = g?.airports.find((x) => x.airport === ap) ?? null;
    return { ap, lost: rd.totals._all!.lost, exposedAny: ra.totals._all!.exposed, mean: ra.totals._all!.meanDeltaMin, users, gi };
  }), [data, destination, g]);
  if (!g) return <p className="small x-dim">{t('i.global.missing')}</p>;
  const W = 560;
  const H = 260;
  const px = (pos: number) => 50 + ((pos - 1) / (g.airports[0]!.augmented.of - 1)) * (W - 70);
  const py = (n: number) => H - 30 - (Math.log10(Math.max(1, n)) / 5) * (H - 50);
  return (
    <>
      <p className="small x-dim">{t('i.global.lead')}</p>
      <div className="r-table-wrap">
        <table className="r-table r-compact">
          <thead><tr>
            <th>{t('i.col.airport')}</th><th className="num">{t('i.col.sysObs')}</th><th className="num">{t('i.col.spillObs')}</th><th className="num">{t('i.col.sysAug')}</th><th className="num">{t('i.col.spillAug')}</th>
            <th className="num">{t('i.col.users')}</th><th className="num">{t('i.col.lostDaily')}</th><th className="num">{t('i.col.share')}</th><th className="num">{t('i.col.exposedAny')}</th>
          </tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.ap}>
              <td>{gwName(data.network.gateways.find((q) => q.id === x.ap))}</td>
              <td className="num">{x.gi?.observed ? f.int(x.gi.observed.rankSystemic) : t('i.global.notObserved')}</td>
              <td className="num">{x.gi?.observed ? (x.gi.observed.spilloverDrop > 0 ? f.int(x.gi.observed.rankSpillover) : t('i.global.zero')) : '—'}</td>
              <td className="num">{x.gi ? f.int(x.gi.augmented.positionSystemic) : '—'}</td>
              <td className="num">{x.gi ? (x.gi.augmented.spilloverDrop > 0 ? f.int(x.gi.augmented.positionSpillover) : t('i.global.zero')) : '—'}</td>
              <td className="num">{f.int(x.users)}</td>
              <td className="num">{f.int(x.lost)}</td>
              <td className="num">{x.users ? f.pct(x.lost / x.users, 0) : '—'}</td>
              <td className="num">{f.int(x.exposedAny)}{x.mean !== null ? ` (+${f.dec(x.mean, 0)} ${t('i.min')})` : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <svg className="i-scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('i.global.chart')}>
        <line x1={50} x2={W - 20} y1={H - 30} y2={H - 30} className="x-axis" />
        <line x1={50} x2={50} y1={10} y2={H - 30} className="x-axis" />
        {[1, 10, 100, 1000, 10000, 100000].map((v) => (
          <g key={v}><line x1={46} x2={50} y1={py(v)} y2={py(v)} className="x-axis" /><text x={42} y={py(v) + 4} textAnchor="end" className="x-label">{f.int(v)}</text></g>
        ))}
        {[1, 1000, 2000, 3000, g.airports[0]!.augmented.of].map((v) => (
          <g key={v}><line x1={px(v)} x2={px(v)} y1={H - 30} y2={H - 26} className="x-axis" /><text x={px(v)} y={H - 14} textAnchor="middle" className="x-label">{f.int(v)}</text></g>
        ))}
        {rows.map((x) => x.gi && (
          <g key={x.ap}>
            <circle cx={px(x.gi.augmented.positionSystemic)} cy={py(x.lost)} r={5} className="i-pt" />
            <text x={px(x.gi.augmented.positionSystemic) + 7} y={py(x.lost) - 6} className="x-label">{data.network.gateways.find((q) => q.id === x.ap)?.iata}</text>
          </g>
        ))}
      </svg>
      <p className="small x-dim">{t('i.global.axes')}</p>
      <p className="small x-dim">{t('i.global.note', { added: g.network.addedArcs })}</p>
    </>
  );
}

function Sources({ data, svcLabel, svc }: { data: IslandData; svcLabel: (s: Service) => string; svc: Map<string, Service> }) {
  const { t } = useI18n();
  const freq = useFreq();
  const f = useFormat();
  const q = data.meta.quality;
  return (
    <>
      <h4 className="small">{t('i.src.services')}</h4>
      <div className="r-table-wrap">
        <table className="r-table r-compact">
          <thead><tr><th>{t('i.col.route')}</th><th>{t('i.col.mode')}</th><th className="num">{t('i.col.duration')}</th><th>{t('i.col.freq')}</th><th>{t('i.col.status')}</th><th className="num">{t('i.col.adsb')}</th><th>{t('i.col.source')}</th></tr></thead>
          <tbody>{data.network.services.map((s) => {
            const v = q.airObservedVsOfficial.find((x) => x.service === s.id);
            return (
              <tr key={s.id}>
                <td>{svcLabel(s)}</td><td>{t(`i.mode.${s.mode}`)}</td>
                <td className="num">{s.durationMin ? (s.durationMin[0] === s.durationMin[1] ? f.int(s.durationMin[0]) : `${s.durationMin[0]}–${s.durationMin[1]}`) : t('i.unknown')}</td>
                <td>{freq(s)}</td><td>{t(`i.status.${s.status}` as MessageKey)}</td>
                <td className="num">{v ? f.int(v.observedFlights) : '—'}</td>
                <td className="small">{s.source === 'pref-r8' ? t('i.src.pref', { p: s.page ?? '' }) : t('i.src.adsb')}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <p className="small x-dim">{t('i.src.adsbNote')}</p>
      <h4 className="small">{t('i.src.population')}</h4>
      <ul className="r-mini">
        <li>{t('i.src.popTotal', { n: f.int(q.populationTotalInMeshFiles), a: f.int(Object.entries(q.populationByIsland).filter(([k]) => k !== '_other').reduce((s, [, v]) => s + v, 0)), o: f.int(q.unassignedPopulation), sea: f.int(q.seaPopulation) })}</li>
        <li>{q.suppressionNote}</li>
        <li>{t('i.src.noRoad', { n: f.int(q.noRoadPopulation), g: f.int(q.noGatewayPopulation) })}</li>
        <li>{t('i.src.roads', { e: f.int(q.roads.edges), l: f.int(q.roads.interIslandLinkEdges) })}</li>
      </ul>
      <h4 className="small">{t('i.src.notModelled')}</h4>
      <ul className="r-mini">{data.meta.notModelled.map((x) => <li key={x}>{x}</li>)}</ul>
      <h4 className="small">{t('i.src.inputs')}</h4>
      <ul className="r-mini">{data.meta.inputs.map((x) => <li key={x.file}><span className="mono">{x.file}</span> — {x.licence}（{x.retrieved.slice(0, 10)}）</li>)}</ul>
      <p className="small x-dim">{svc.size ? t('i.src.portGroup') : ''} {data.meta.portGroupRule}</p>
    </>
  );
}
