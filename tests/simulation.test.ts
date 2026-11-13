import { describe, expect, it } from 'vitest';
import { pathMeasures } from '../src/research/graph';
import { subtractRows, WindowAggregator } from '../src/temporal/aggregate';
import { attachEndpoints, decodeDay, type DayFile } from '../src/temporal/model';
import {
  affected,
  inIntervals,
  matchFlight,
  MATCH,
  mergeIntervals,
  resolveDisruption,
  structuralRemoved,
  structuralState,
  type NetworkIndex,
} from '../src/simulation/disruption';
import { alternativePaths, computeImpact, graphOf } from '../src/simulation/impact';
import {
  airportClosure,
  canonicalScenario,
  eventsFromParam,
  eventsToParam,
  isoMinute,
  newScenario,
  parseIsoUtc,
  parseScenario,
  routeSuspension,
  scenarioHash,
  scenarioJson,
  type ScenarioContext,
} from '../src/simulation/model';

const T = (s: string) => parseIsoUtc(s)!;
const pairs = (...p: [number, number][]) => ({ src: Int32Array.from(p.map((x) => x[0])), dst: Int32Array.from(p.map((x) => x[1])) });

// airports 0 AAAA, 1 BBBB, 2 CCCC, 3 DDDD; routes 0 A-B, 1 B-C, 2 A-C (a < b by id)
const ids = ['AAAA', 'BBBB', 'CCCC', 'DDDD'];
const routeList: [number, number][] = [[0, 1], [1, 2], [0, 2]];
const idx: NetworkIndex = {
  airportIndex: new Map(ids.map((id, i) => [id, i])),
  routeIndex: new Map(routeList.map(([a, b], i) => [`${ids[a]}|${ids[b]}`, i])),
  routeEnds: (rid) => routeList[rid]!,
};
const ctx: ScenarioContext = {
  datasetId: 'ds', datasetVersion: '1', airportIds: new Set(ids), routeKeys: new Set(idx.routeIndex.keys()),
  dataStartMs: T('2026-01-01T00:00Z'), dataEndMs: T('2026-10-01T00:00Z'),
};

describe('time intervals', () => {
  it('half-open: start included, end excluded, minute boundaries', () => {
    const l = mergeIntervals([{ s: T('2026-03-10T12:00Z'), e: T('2026-03-10T18:00Z') }]);
    expect(inIntervals(l, T('2026-03-10T12:00Z'))).toBe(true);
    expect(inIntervals(l, T('2026-03-10T17:59Z'))).toBe(true);
    expect(inIntervals(l, T('2026-03-10T18:00Z'))).toBe(false);
    expect(inIntervals(l, T('2026-03-10T11:59Z'))).toBe(false);
    expect(inIntervals(l, NaN)).toBe(false);
  });
  it('merges overlapping and touching intervals; order does not matter', () => {
    const a = { s: 1, e: 3 };
    const b = { s: 3, e: 5 };
    const c = { s: 10, e: 12 };
    expect(mergeIntervals([c, b, a])).toEqual([{ s: 1, e: 5 }, { s: 10, e: 12 }]);
    expect(mergeIntervals([a, a, a])).toEqual([a]);
    expect(mergeIntervals([{ s: 5, e: 5 }])).toEqual([]);
  });
  it('UTC parsing rejects offsets and non-zero seconds; ISO minute output', () => {
    expect(parseIsoUtc('2026-03-10T12:00+09:00')).toBeNull();
    expect(parseIsoUtc('2026-03-10T12:00:30Z')).toBeNull();
    expect(parseIsoUtc('2026-03-10T12:00:00Z')).toBe(Date.UTC(2026, 2, 10, 12));
    expect(parseIsoUtc('2026-02-30T00:00Z')).toBeNull();
    expect(isoMinute(Date.UTC(2026, 3, 1, 0, 5))).toBe('2026-04-01T00:05Z');
  });
});

describe('resolving events', () => {
  it('single and multiple airport closures, sides', () => {
    const d = resolveDisruption([airportClosure(['AAAA']), airportClosure(['BBBB', 'CCCC'], null, null, 'departures')], idx, ctx);
    expect([...d.dep.keys()].sort()).toEqual([0, 1, 2]);
    expect([...d.arr.keys()]).toEqual([0]);
    expect(d.targetAirports).toEqual([0, 1, 2]);
  });
  it('directed and two-way route suspensions', () => {
    const one = resolveDisruption([routeSuspension('CCCC', 'AAAA', 'directed')], idx, ctx);
    // route 2 is A-C (a = AAAA); C -> A is the b -> a direction
    expect([...one.ba.keys()]).toEqual([2]);
    expect(one.ab.size).toBe(0);
    const both = resolveDisruption([routeSuspension('CCCC', 'AAAA', 'both')], idx, ctx);
    expect([...both.ab.keys(), ...both.ba.keys()]).toEqual([2, 2]);
  });
  it('disabled, invalid and unknown targets are not applied and are reported', () => {
    const off = airportClosure(['AAAA']);
    off.enabled = false;
    const bad = airportClosure(['BBBB'], T('2026-03-10T18:00Z'), T('2026-03-10T12:00Z'));
    const unknown = airportClosure(['ZZZZ']);
    const noRoute = routeSuspension('BBBB', 'DDDD', 'both');
    const d = resolveDisruption([off, bad, unknown, noRoute], idx, ctx);
    expect(d.dep.size + d.arr.size + d.ab.size + d.ba.size).toBe(0);
    expect(d.issues.map((i) => i.code).sort()).toEqual(['invalid_event_period', 'unknown_airport', 'unknown_route']);
    expect(d.applied).toEqual([]);
  });
  it('duplicates and event order give the same disruption (idempotent, order-independent)', () => {
    const e1 = airportClosure(['AAAA'], T('2026-03-10T12:00Z'), T('2026-03-10T18:00Z'));
    const e2 = routeSuspension('AAAA', 'BBBB', 'both', T('2026-03-10T10:00Z'), T('2026-03-10T14:00Z'));
    const e3 = airportClosure(['AAAA'], T('2026-03-10T16:00Z'), T('2026-03-10T20:00Z'));
    const x = resolveDisruption([e1, e2, e3, e1], idx, ctx);
    const y = resolveDisruption([e3, e1, e2], idx, ctx);
    expect([...x.dep]).toEqual([...y.dep]);
    expect([...x.ab]).toEqual([...y.ab]);
    expect(x.dep.get(0)).toEqual([{ s: T('2026-03-10T12:00Z'), e: T('2026-03-10T20:00Z') }]);
    const s = newScenario('ds', '1', T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z'));
    expect(canonicalScenario({ ...s, events: [e1, e2, e3] })).toBe(canonicalScenario({ ...s, events: [e3, e2, e1] }));
  });
});

describe('structural model', () => {
  const d = resolveDisruption([
    airportClosure(['BBBB'], T('2026-03-10T12:00Z'), T('2026-03-10T18:00Z')),
    routeSuspension('AAAA', 'CCCC', 'directed'),
  ], idx, ctx);
  it('events in effect at an instant, or overlapping a window', () => {
    expect(structuralState(d, { at: T('2026-03-10T11:00Z') }).dep.size).toBe(0);
    expect(structuralState(d, { at: T('2026-03-10T12:00Z') }).dep.has(1)).toBe(true);
    expect(structuralState(d, { at: T('2026-03-10T18:00Z') }).dep.size).toBe(0);
    expect(structuralState(d, { window: { s: T('2026-03-10T00:00Z'), e: T('2026-03-11T00:00Z') } }).arr.has(1)).toBe(true);
    expect(structuralState(d, null).ab.has(2)).toBe(true);
  });
  it('removes movements touching a closed airport and the suspended direction only', () => {
    const st = structuralState(d, null);
    expect(structuralRemoved(st, 0, 0, 0, 1)).toBe(true); // A -> B (arrival at B)
    expect(structuralRemoved(st, 0, 1, 0, 1)).toBe(true); // B -> A (departure at B)
    expect(structuralRemoved(st, 2, 0, 0, 2)).toBe(true); // A -> C suspended
    expect(structuralRemoved(st, 2, 1, 0, 2)).toBe(false); // C -> A still flown
  });
});

describe('temporal model: matching flight records', () => {
  const d = resolveDisruption([airportClosure(['BBBB'], T('2026-03-10T12:00Z'), T('2026-03-10T18:00Z'))], idx, ctx);
  const B_TO_A = [0, 1, 0, 1] as const; // route 0 (A-B), dir 1 = B -> A
  const A_TO_B = [0, 0, 0, 1] as const;
  const m = (r: readonly [number, number, number, number], refMs: number, basis: number, endMs: number, proxy: 'endpoint' | 'reference') =>
    matchFlight(d, r[0], r[1], r[2], r[3], { refMs, basis, endMs }, proxy);
  it('departure side uses the track start; boundaries are exact to the minute', () => {
    expect(m(B_TO_A, T('2026-03-10T12:00Z'), 0, NaN, 'endpoint') & MATCH.DEP).toBeTruthy();
    expect(affected(m(B_TO_A, T('2026-03-10T18:00Z'), 0, NaN, 'endpoint'))).toBe(false);
    expect(affected(m(B_TO_A, T('2026-03-10T11:59Z'), 0, NaN, 'endpoint'))).toBe(false);
  });
  it('arrival side uses the track end: a flight that started before the closure can arrive in it', () => {
    const f = m(A_TO_B, T('2026-03-10T10:00Z'), 0, T('2026-03-10T12:30Z'), 'endpoint');
    expect(f & MATCH.ARR).toBeTruthy();
    // with the reference proxy only the start time is seen: not affected
    expect(affected(m(A_TO_B, T('2026-03-10T10:00Z'), 0, T('2026-03-10T12:30Z'), 'reference'))).toBe(false);
  });
  it('fallback flights: the departure time is unknown, so the endpoint proxy does not guess', () => {
    // B -> A, track start missing, reference = track end 13:00
    expect(m(B_TO_A, T('2026-03-10T13:00Z'), 1, T('2026-03-10T13:00Z'), 'endpoint')).toBe(MATCH.UNDETERMINED);
    expect(m(B_TO_A, T('2026-03-10T13:00Z'), 1, T('2026-03-10T13:00Z'), 'reference') & MATCH.DEP).toBeTruthy();
    // arrival at B with a missing track end is undetermined too
    expect(m(A_TO_B, T('2026-03-10T09:00Z'), 0, NaN, 'endpoint')).toBe(MATCH.UNDETERMINED);
    // ... but not when the known time rules the closure out (track at most 24 h)
    expect(m(B_TO_A, T('2026-03-10T02:00Z'), 1, T('2026-03-10T02:00Z'), 'endpoint')).toBe(0); // arrived before the closure
    expect(m(A_TO_B, T('2026-03-10T19:00Z'), 0, NaN, 'endpoint')).toBe(0); // departed after it
    expect(m(A_TO_B, T('2026-03-09T11:00Z'), 0, NaN, 'endpoint')).toBe(0); // more than 24 h before
  });
  it('a flight touched by several events counts once', () => {
    const both = resolveDisruption([
      airportClosure(['AAAA'], T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z')),
      airportClosure(['BBBB'], T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z')),
      routeSuspension('AAAA', 'BBBB', 'both', T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z')),
    ], idx, ctx);
    const f = matchFlight(both, 0, 0, 0, 1, { refMs: T('2026-03-10T08:00Z'), basis: 0, endMs: T('2026-03-10T09:00Z') }, 'endpoint');
    expect(f).toBe(MATCH.DEP | MATCH.ARR | MATCH.ROUTE);
    expect(affected(f)).toBe(true);
  });
});

// day files (same layout as the Phase 9A files) + endpoint files in file order
const code = (dir: number, cls: number, tier: number, basis = 0) => dir + 2 * cls + 6 * (tier - 1) + 24 * basis;
function dayFile(d: string, rows: [number, number, number, number, number][]): { day: DayFile; e: number[] } {
  const sorted = [...rows].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const f: DayFile = { schemaVersion: 1, day: d, n: rows.length, r: [], k: [], t: [], c: [], x: [] };
  const e: number[] = [];
  let pr = -1;
  let pm = 0;
  for (const [mm, rid, c, x, end] of sorted) {
    if (rid !== pr) {
      f.r.push(pr < 0 ? rid : rid - pr);
      f.k.push(0);
      pr = rid;
      pm = 0;
    }
    f.k[f.k.length - 1]!++;
    f.t.push(mm - pm);
    pm = mm;
    f.c.push(c);
    f.x.push(x);
    e.push(end);
  }
  return { day: f, e };
}

describe('temporal model: aggregation from records', () => {
  const geo = { a: Int32Array.from(routeList.map((r) => r[0])), b: Int32Array.from(routeList.map((r) => r[1])), airportCountry: new Int32Array(4) };
  // minute, route, carrier, code, track end (minutes after the reference minute, -1 unknown)
  const raw = dayFile('2026-03-10', [
    [600, 0, 0, code(0, 0, 1), 120], // A -> B 10:00, arrives 12:00            -> arrival in closure
    [700, 0, 0, code(1, 0, 1), 60], //  B -> A 11:40, before the closure       -> not affected
    [720, 0, 0, code(1, 0, 1), 60], //  B -> A 12:00 exactly                   -> departure in closure
    [1079, 1, 0, code(0, 0, 1), 30], // B -> C 17:59                            -> departure in closure
    [1080, 1, 0, code(0, 0, 1), 30], // B -> C 18:00 (end excluded)             -> not affected
    [800, 0, 0, code(1, 0, 4, 1), -1], // B -> A fallback, ref = end 13:20       -> undetermined (endpoint)
    [900, 2, 1, code(0, 1, 2), 90], // A -> C, other route                      -> not affected
    [1430, 0, 0, code(0, 0, 1), 60], // A -> B 23:50, arrives next day 00:50   -> not affected
  ]);
  const ev = attachEndpoints(decodeDay(raw.day), { schemaVersion: 1, day: '2026-03-10', n: raw.e.length, e: raw.e });
  const d = resolveDisruption([airportClosure(['BBBB'], T('2026-03-10T12:00Z'), T('2026-03-10T18:00Z'))], idx, ctx);
  const win = { startMs: T('2026-03-10T00:00Z'), endMs: T('2026-03-11T00:00Z') };

  it('endpoint files are aligned through the decoder reordering', () => {
    const i = [...ev.timeMs].indexOf(T('2026-03-10T10:00Z'));
    expect(ev.endMs![i]).toBe(T('2026-03-10T12:00Z'));
    const fb = [...ev.timeMs].indexOf(T('2026-03-10T13:20Z'));
    expect(ev.endMs![fb]).toBe(T('2026-03-10T13:20Z'));
    expect(() => attachEndpoints(decodeDay(raw.day), { schemaVersion: 1, day: '2026-03-10', n: 2, e: [1, 2] })).toThrow();
  });
  it('only the closure hours are affected inside a 24-hour window', () => {
    const agg = new WindowAggregator(win, 'all', 2, 3_600_000, geo, null);
    agg.setDisruption(d, 'endpoint');
    agg.addDay(ev);
    const st = agg.disruptionStats()!;
    expect(st.affected).toBe(3);
    expect([st.dep, st.arr, st.route]).toEqual([2, 1, 0]);
    expect(st.undetermined).toBe(1); // the fallback B -> A arriving 13:20 could have left B after 12:00
    expect(st.byBasis).toEqual([3, 0]);
    // with the reference proxy: the 12:00 departure, the 17:59 departure, the fallback at 13:20
    expect(st.affectedReference).toBe(3);
    expect(st.affectedEndpoint).toBe(3);
    expect(st.series.reduce((a, b) => a + b, 0)).toBe(3);
    const all = agg.rows();
    const left = subtractRows(all, agg.affectedRows());
    const sum = (r: typeof all) => r.count.reduce((a, b) => a + b, 0);
    expect([sum(all), sum(left)]).toEqual([8, 5]);
  });
  it('a closure that does not overlap the window affects nothing; the input is not changed', () => {
    const before = ev.timeMs.slice();
    const far = resolveDisruption([airportClosure(['BBBB'], T('2026-04-01T00:00Z'), T('2026-04-02T00:00Z'))], idx, ctx);
    const agg = new WindowAggregator(win, 'all', 2, 3_600_000, geo, null);
    agg.setDisruption(far, 'endpoint');
    agg.addDay(ev);
    expect(agg.disruptionStats()!.affected).toBe(0);
    expect(agg.affectedRows().size).toBe(0);
    expect(ev.timeMs).toEqual(before);
  });
  it('without track ends the reference proxy is used and reported', () => {
    const plain = decodeDay(raw.day);
    const agg = new WindowAggregator(win, 'all', 2, 3_600_000, geo, null);
    agg.setDisruption(d, 'endpoint');
    agg.addDay(plain);
    const st = agg.disruptionStats()!;
    expect(st.daysWithoutEndpoints).toEqual(['2026-03-10']);
    expect(st.affectedEndpoint).toBeNull();
    expect(st.affected).toBe(st.affectedReference);
  });
});

describe('connectivity impact (hand-checked)', () => {
  // A0 - B1 - C2 - D3, and E4 - B1. Close B.
  const before = pairs([0, 1], [1, 2], [2, 3], [4, 1]);
  const after = pairs([2, 3]);
  const r = computeImpact({ n: 5, directed: false, before, after, targets: Int32Array.of(1), excludedPairs: new Int32Array(0) });
  it('total impact keeps the closed airport in the node set (same denominator)', () => {
    expect(r.total.before.pairs).toBe(20);
    expect(r.total.after.pairs).toBe(20);
    expect(r.total.before.reachable).toBe(20);
    expect(r.total.after.reachable).toBe(2);
    expect(r.total.before.efficiency).toBeCloseTo(13.3333333 / 20, 6);
    expect(r.total.after.efficiency).toBeCloseTo(0.1, 9);
  });
  it('spillover: pairs of the other airports, paths through B allowed before', () => {
    expect(r.spillover.nodes).toBe(4);
    expect(r.spillover.before.pairs).toBe(12);
    expect(r.spillover.before.efficiency).toBeCloseTo(6.3333333 / 12, 6);
    expect(r.spillover.after.efficiency).toBeCloseTo(2 / 12, 9);
    expect([r.spillover.before.hop1, r.spillover.before.hop2, r.spillover.before.hop3]).toEqual([2, 8, 12]);
    expect(r.lostPairs.total).toBe(5);
    expect(r.hopChange).toEqual({ same: 2, plus1: 0, plus2: 0, plus3more: 0, lost: 10 });
  });
  it('components (isolated airports count) and per-airport changes', () => {
    expect(r.components.before).toEqual({ count: 1, largest: 5 });
    expect(r.components.after).toEqual({ count: 4, largest: 2 });
    expect([r.perNode.degBefore[0], r.perNode.degAfter[0], r.perNode.reachBefore[0], r.perNode.reachAfter[0], r.perNode.lost[0]]).toEqual([1, 0, 3, 0, 3]);
    expect(r.connectedNodes).toEqual({ before: 5, after: 2 });
  });
  it('global efficiency equals the mean of Research Mode harmonic closeness', () => {
    const g = graphOf(5, before, false);
    const h = pathMeasures(g, { sources: null }).harmonicNormalized;
    expect(r.total.before.efficiency).toBeCloseTo(h.reduce((a, b) => a + b, 0) / 5, 9);
  });
  it('a route suspension: the suspended pair is left out of the spillover', () => {
    // square A-B-C-D-A; suspend A-B
    const sq = computeImpact({ n: 4, directed: false, before: pairs([0, 1], [1, 2], [2, 3], [3, 0]), after: pairs([1, 2], [2, 3], [3, 0]), targets: new Int32Array(0), excludedPairs: Int32Array.of(0, 1) });
    expect(sq.spillover.before.pairs).toBe(10);
    expect(sq.spillover.before.efficiency).toBeCloseTo(0.8, 9);
    expect(sq.spillover.after.efficiency).toBeCloseTo(0.8, 9);
    expect(sq.total.before.efficiency).toBeCloseTo(10 / 12, 9);
    expect(sq.total.after.efficiency).toBeCloseTo((8 + 2 / 3) / 12, 9);
    expect(sq.hopChange.lost).toBe(0);
  });
  it('directed: reachability is one-way', () => {
    // A -> B -> C; B departures closed
    const dr = computeImpact({ n: 3, directed: true, before: pairs([0, 1], [1, 2]), after: pairs([0, 1]), targets: Int32Array.of(1), excludedPairs: new Int32Array(0) });
    expect(dr.total.before.reachable).toBe(3);
    expect(dr.total.after.reachable).toBe(1);
    expect(dr.lostPairs.total).toBe(1); // A -> C
    expect([...dr.lostPairs.list]).toEqual([0, 2]);
  });
  it('alternative paths avoid the intermediate airports of the earlier ones', () => {
    // 0-1-3, 0-2-3, 0-3 direct
    const g = graphOf(4, pairs([0, 1], [1, 3], [0, 2], [2, 3], [0, 3]), false);
    const p = alternativePaths(g, 0, 3, 3);
    expect(p[0]).toEqual([0, 3]);
    expect(p.slice(1).map((x) => x.length)).toEqual([3, 3]);
    expect(new Set(p.slice(1).map((x) => x[1]))).toEqual(new Set([1, 2]));
    expect(alternativePaths(graphOf(4, pairs([0, 1]), false), 0, 3)).toEqual([]);
  });
});

describe('scenario files and URLs', () => {
  const s = newScenario('ds', '1', T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z'));
  s.simulationModel = 'temporal';
  s.events = [airportClosure(['AAAA', 'BBBB'], T('2026-03-10T12:00Z'), T('2026-03-10T18:00Z')), routeSuspension('AAAA', 'CCCC', 'directed')];
  it('JSON round trip keeps the result-relevant conditions (same hash)', () => {
    const back = parseScenario(scenarioJson(s), ctx);
    expect(back.issues).toEqual([]);
    expect(scenarioHash(back.scenario!)).toBe(scenarioHash(s));
    expect(back.scenario!.events.map((e) => e.targetIds)).toEqual([['AAAA', 'BBBB'], ['AAAA>CCCC']]);
  });
  it('rejects or reports bad input without applying it', () => {
    expect(parseScenario('{', ctx).issues).toEqual([{ code: 'invalid_json' }]);
    expect(parseScenario('{"format":"x","events":[]}', ctx).scenario).toBeNull();
    const raw = JSON.parse(scenarioJson(s));
    raw.schemaVersion = 9;
    raw.datasetVersion = '0.9';
    raw.events.push({ eventType: 'WEATHER_DISRUPTION', targetType: 'airport', targetIds: ['AAAA'] });
    raw.events.push({ eventType: 'SAFETY_ADVISORY', targetType: 'airport', targetIds: ['AAAA'] });
    raw.events.push({ eventType: 'AIRPORT_CLOSURE', targetType: 'airport', targetIds: ['QQQQ'], startTimeUtc: '2026-03-10T12:00+09:00' });
    raw.analysisEnd = raw.analysisStart;
    const r = parseScenario(JSON.stringify(raw), ctx);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['newer_schema', 'dataset_version_differs', 'invalid_period', 'event_not_implemented',
      'advisory_not_applied', 'unknown_airport', 'invalid_event_period']));
    // reserved and advisory events are kept in the file but never applied
    const d = resolveDisruption(r.scenario!.events, idx, ctx);
    expect(d.applied.length).toBe(2);
  });
  it('URL form of the events', () => {
    const p = eventsToParam(s.events)!;
    expect(p).toBe('M~AAAA,BBBB~b~2026-03-10T12:00Z~2026-03-10T18:00Z~1;R~AAAA>CCCC~o~~~1');
    const back = eventsFromParam(p);
    expect(canonicalScenario({ ...s, events: back })).toBe(canonicalScenario(s));
    const many = Array.from({ length: 200 }, (_, i) => airportClosure([`A${String(i).padStart(3, '0')}`]));
    expect(eventsToParam(many)).toBeNull(); // too long: share the JSON file instead
  });
  it('the key changes with every condition that changes a result', () => {
    const k = scenarioHash(s);
    expect(scenarioHash({ ...s, filters: { ...s.filters, timeProxy: 'reference' } })).not.toBe(k);
    expect(scenarioHash({ ...s, analysisSettings: { ...s.analysisSettings, directed: true } })).not.toBe(k);
    expect(scenarioHash({ ...s, filters: { ...s.filters, tiers: 'C' } })).not.toBe(k);
    expect(scenarioHash({ ...s, events: [s.events[0]!] })).not.toBe(k);
    expect(scenarioHash({ ...s, name: 'other name' })).toBe(k);
    // a fixed period gives the same key with or without the explicit window
    expect(scenarioHash(s, { startMs: T('2026-03-10T00:00Z'), endMs: T('2026-03-11T00:00Z') })).toBe(k);
    // disabling every event gives the key of the empty scenario
    expect(scenarioHash({ ...s, events: s.events.map((e) => ({ ...e, enabled: false })) })).toBe(scenarioHash({ ...s, events: [] }));
  });
});
