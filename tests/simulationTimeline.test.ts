import { describe, expect, it } from 'vitest';
import { mergeMonth } from '../src/research/data';
import { defaultConfig } from '../src/research/model';
import { buildResearchNetwork } from '../src/research/network';
import { compareConfig } from '../src/research/useResearch';
import { activeSignature, boundaries, eventActiveAt, networkIndex, resolveDisruption, scenarioContext } from '../src/simulation/disruption';
import { impactInputOf, researchConfigOf, structuralWhen } from '../src/simulation/engine';
import { graphOf } from '../src/simulation/impact';
import { eventLabel } from '../src/simulation/labels';
import {
  airportClosure,
  baseHash,
  durationMs,
  isoDuration,
  newScenario,
  parseIsoUtc,
  parseScenario,
  routeSuspension,
  scenarioHash,
  scenarioJson,
  SIM_SCHEMA_VERSION,
  type SimulationScenario,
} from '../src/simulation/model';
import { leaveOneOut, nextBoundary, pairCause, seriesTimes, structuralDirectAt, structuralSeries, timelineRange, type StructuralBase } from '../src/simulation/series';
import { scenarioFromParams, scenarioToParams } from '../src/simulation/urlParams';
import { useAppStore } from '../src/state/store';
import { april, aprilTiers, continentOf, network } from './research/fixtures';

const T = (s: string) => parseIsoUtc(s)!;
// fixture network: HND 0, ITM 1, JFK 2, LAX 3, GRU 4; April edges HND-ITM, HND-JFK, JFK-LAX, GRU-JFK
const ctx = scenarioContext(network, '1', T('2026-01-01T00:00Z'), T('2026-10-01T00:00Z'));
const idx = networkIndex(network);
const beforeR = mergeMonth(april, aprilTiers, network.carriers.map((c) => c.id));

function base(events: SimulationScenario['events']): { b: StructuralBase; s: SimulationScenario } {
  const s = newScenario('test-ds', '1', T('2026-04-01T00:00Z'), T('2026-05-01T00:00Z'));
  s.events = events;
  s.filters.minFlights = 1;
  const beforeNet = buildResearchNetwork({ network, continentOf, persistence: null }, beforeR, researchConfigOf(s, '2026-04'));
  return { s, b: { network, scope: { network, continentOf, persistence: null }, scenario: s, beforeR, beforeNet } };
}

describe('event timeline: when an event is in effect', () => {
  const e = airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'));
  it('half-open: in effect from the start minute, not at the end minute', () => {
    expect(eventActiveAt(e, T('2026-04-10T11:59Z'))).toBe(false);
    expect(eventActiveAt(e, T('2026-04-10T12:00Z'))).toBe(true);
    expect(eventActiveAt(e, T('2026-04-10T17:59Z'))).toBe(true);
    expect(eventActiveAt(e, T('2026-04-10T18:00Z'))).toBe(false);
    expect(eventActiveAt({ ...e, enabled: false }, T('2026-04-10T13:00Z'))).toBe(false);
    expect(eventActiveAt(airportClosure(['KJFK']), T('2026-04-10T13:00Z'))).toBe(true); // no times: always
  });
  it('boundaries, jumps and the active set signature', () => {
    const d = resolveDisruption([e, airportClosure(['KLAX'], T('2026-04-10T18:00Z'), T('2026-04-11T06:00Z'))], idx, ctx);
    expect(boundaries(d)).toEqual([T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'), T('2026-04-11T06:00Z')]);
    expect(nextBoundary(d, T('2026-04-10T12:00Z'), 1)).toBe(T('2026-04-10T18:00Z'));
    expect(nextBoundary(d, T('2026-04-10T12:00Z'), -1)).toBeNull();
    expect(nextBoundary(d, T('2026-04-11T06:00Z'), 1)).toBeNull();
    // same events in effect -> same signature (results shared); different -> different
    expect(activeSignature(d, T('2026-04-10T13:00Z'))).toBe(activeSignature(d, T('2026-04-10T17:00Z')));
    expect(activeSignature(d, T('2026-04-10T13:00Z'))).not.toBe(activeSignature(d, T('2026-04-10T19:00Z')));
    expect(activeSignature(d, T('2026-04-10T11:00Z'))).toBe(activeSignature(d, T('2026-04-11T07:00Z'))); // nothing in effect
  });
  it('simultaneous starts, equal ends and the order of events', () => {
    const a = airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'));
    const b = routeSuspension('RHND', 'RITM', 'both', T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'));
    const d1 = resolveDisruption([a, b], idx, ctx);
    const d2 = resolveDisruption([b, a], idx, ctx);
    for (const t of ['2026-04-10T11:00Z', '2026-04-10T12:00Z', '2026-04-10T17:59Z', '2026-04-10T18:00Z']) {
      expect(activeSignature(d1, T(t))).toBe(activeSignature(d2, T(t)));
    }
    expect(boundaries(d1)).toEqual([T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z')]);
  });
  it('UTC across day and month boundaries', () => {
    const m = airportClosure(['KJFK'], T('2026-04-30T22:00Z'), T('2026-05-01T02:00Z'));
    expect(eventActiveAt(m, T('2026-04-30T23:30Z'))).toBe(true);
    expect(eventActiveAt(m, T('2026-05-01T01:59Z'))).toBe(true);
    expect(eventActiveAt(m, T('2026-05-01T02:00Z'))).toBe(false);
  });
});

describe('structural model over time (fixed baseline)', () => {
  it('stop, recovery and the baseline staying fixed', () => {
    const { b } = base([airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'))]);
    const d = resolveDisruption(b.scenario.events, idx, ctx);
    const memo = new Map();
    const before = JSON.stringify(b.beforeNet);
    const pts = structuralSeries(b, d, [T('2026-04-10T11:00Z'), T('2026-04-10T12:00Z'), T('2026-04-10T15:00Z'), T('2026-04-10T18:00Z')], memo);
    expect(pts.map((p) => p.lostConnections)).toEqual([0, 3, 3, 0]); // JFK: HND-JFK, JFK-LAX, GRU-JFK
    expect(pts.map((p) => p.active.length)).toEqual([0, 1, 1, 0]);
    expect(pts[3]!.flights).toBe(0); // after the end: back to the baseline
    expect(memo.size).toBe(2); // one evaluation per distinct set of events in effect
    expect(JSON.stringify(b.beforeNet)).toBe(before); // the baseline network never changes
  });
  it('two airports stopped at different times and reopened at different times (staged recovery)', () => {
    const { b } = base([
      airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-11T06:00Z')),
      airportClosure(['RHND'], T('2026-04-10T18:00Z'), T('2026-04-12T12:00Z')),
    ]);
    const d = resolveDisruption(b.scenario.events, idx, ctx);
    const at = (s: string) => structuralDirectAt(b, d, T(s)).lostConnections;
    expect(at('2026-04-10T11:00Z')).toBe(0);
    expect(at('2026-04-10T12:00Z')).toBe(3); // JFK
    expect(at('2026-04-10T18:00Z')).toBe(4); // JFK + HND: HND-JFK counted once
    expect(at('2026-04-11T06:00Z')).toBe(2); // JFK reopened: HND-ITM, HND-JFK
    expect(at('2026-04-12T12:00Z')).toBe(0);
  });
  it('overlapping events: no double counting, and leave-one-out differences are not additive', () => {
    const { b } = base([
      airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z')),
      airportClosure(['KJFK'], T('2026-04-10T10:00Z'), T('2026-04-10T20:00Z')),
      routeSuspension('RHND', 'KJFK', 'both', T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z')),
    ]);
    const d = resolveDisruption(b.scenario.events, idx, ctx);
    const all = structuralDirectAt(b, d, T('2026-04-10T14:00Z'));
    const single = structuralDirectAt(base([airportClosure(['KJFK'])]).b, resolveDisruption([airportClosure(['KJFK'])], idx, ctx), T('2026-04-10T14:00Z'));
    expect([all.lostConnections, all.flights]).toEqual([single.lostConnections, single.flights]);
    const loo = leaveOneOut(b, ctx, T('2026-04-10T14:00Z'));
    expect(loo.map((x) => x.lostWith - x.lostWithout)).toEqual([0, 0, 0]);
    expect(loo.reduce((a, x) => a + (x.lostWith - x.lostWithout), 0)).not.toBe(all.lostConnections);
  });
  it('the structural state at an instant (Phase 9D) and the Phase 9C rule without one', () => {
    const s = newScenario('x', null, T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z'));
    const w = { s: T('2026-04-10T00:00Z'), e: T('2026-04-11T00:00Z') };
    expect(structuralWhen(s, w, T('2026-04-10T14:00Z'))).toEqual({ at: T('2026-04-10T14:00Z') });
    expect(structuralWhen({ ...s, baselineMode: 'dynamic' }, w, T('2026-04-10T14:00Z'))).toEqual({ at: T('2026-04-10T14:00Z') });
    expect(structuralWhen({ ...s, baselineMode: 'dynamic' }, w)).toEqual({ window: w }); // 9C call
  });
});

describe('cause of a lost path', () => {
  it('lists the stopped airports and lost legs of the original path, and checks each event alone', () => {
    const { b } = base([airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'))]);
    const d = resolveDisruption(b.scenario.events, idx, ctx);
    const at = T('2026-04-10T13:00Z');
    // the simulated graph from the structural state
    const di = structuralDirectAt(b, d, at);
    expect(di.lostConnections).toBe(3);
    const { input, nodes } = impactInputOf(b.beforeNet, { ...b.beforeNet, routes: b.beforeNet.routes.filter((r) => r.a !== 2 && r.b !== 2) }, d, false);
    const graphs = { before: graphOf(input.n, input.before, false), after: graphOf(input.n, input.after, false), nodes };
    const c = pairCause(b, ctx, at, 0, 3, graphs, [2], true)!; // HND -> LAX
    expect(c.before).toEqual([0, 2, 3]);
    expect(c.after).toEqual([]);
    expect(c.targetsOnPath).toEqual([2]);
    expect(c.lostLegs).toEqual([[0, 2], [2, 3]]);
    expect(c.withoutEvent).toEqual([{ eventId: b.scenario.events[0]!.eventId, hops: 2 }]);
  });
});

describe('timeline range and steps', () => {
  it('covers the period and the events, with room after the last end', () => {
    const s = newScenario('x', null, T('2026-03-10T00:00Z'), T('2026-03-11T00:00Z'));
    s.events = [airportClosure(['KJFK'], T('2026-03-10T12:00Z'), T('2026-03-12T12:00Z'))];
    const r = timelineRange(s, s.events, { startMs: T('2026-01-01T00:00Z'), endMs: T('2026-10-01T00:00Z') });
    expect(r.startMs).toBe(T('2026-03-10T00:00Z'));
    expect(r.endMs).toBeGreaterThan(T('2026-03-12T12:00Z'));
    // the scenario's own range wins
    s.timeline = { start: '2026-03-09T00:00Z', end: '2026-03-13T00:00Z', step: 'PT6H' };
    expect(timelineRange(s, s.events, { startMs: 0, endMs: Infinity })).toEqual({ startMs: T('2026-03-09T00:00Z'), endMs: T('2026-03-13T00:00Z') });
    expect(seriesTimes({ startMs: 0, endMs: 24 * 3_600_000 }, 6 * 3_600_000).times.length).toBe(4);
    expect(seriesTimes({ startMs: 0, endMs: 1000 * 3_600_000 }, 3_600_000, 100).stepMs).toBe(16 * 3_600_000);
  });
  it('ISO durations', () => {
    expect(durationMs('PT1H')).toBe(3_600_000);
    expect(durationMs('PT6H')).toBe(21_600_000);
    expect(durationMs('P1D')).toBe(86_400_000);
    expect(durationMs('P1DT6H')).toBe(30 * 3_600_000);
    expect(durationMs('PT0H')).toBeNull();
    expect(durationMs('1h')).toBeNull();
    expect(isoDuration(21_600_000)).toBe('PT6H');
    expect(isoDuration(86_400_000)).toBe('P1D');
  });
});

describe('scenario files: schema 2 and Phase 9C files', () => {
  const sctx = { ...ctx, datasetId: 'test-ds' };
  it('round trip keeps events, labels, timeline and the simulation time', () => {
    const s = newScenario('test-ds', '1', T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z'));
    s.events = [{ ...airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-11T06:00Z')), label: 'JFK closed' }, airportClosure(['RHND'], T('2026-04-10T18:00Z'), null)];
    s.timeline = { start: null, end: null, step: 'PT6H' };
    s.evaluationTime = '2026-04-10T18:00Z';
    const back = parseScenario(scenarioJson(s), sctx);
    expect(back.issues).toEqual([]);
    expect(back.scenario!.schemaVersion).toBe(SIM_SCHEMA_VERSION);
    expect(back.scenario!.events[0]!.label).toBe('JFK closed');
    expect(back.scenario!.timeline.step).toBe('PT6H');
    expect(back.scenario!.evaluationTime).toBe('2026-04-10T18:00Z');
    expect(scenarioHash(back.scenario!)).toBe(scenarioHash(s));
  });
  it('a Phase 9C file (schema 1) loads; a timed structural scenario gets an explicit evaluation time', () => {
    const s = newScenario('test-ds', '1', T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z'));
    s.events = [airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'))];
    const v1 = JSON.parse(scenarioJson(s));
    v1.schemaVersion = 1;
    delete v1.timeline;
    delete v1.methodVersion;
    for (const e of v1.events) delete e.label;
    const back = parseScenario(JSON.stringify(v1), sctx);
    expect(back.scenario!.evaluationTime).toBe('2026-04-10T12:00Z');
    expect(back.issues).toEqual([{ code: 'migrated_evaluation_time', value: '2026-04-10T12:00Z' }]);
    expect(back.scenario!.events[0]!.label).toBe('');
    expect(back.scenario!.timeline.step).toBe('PT1H');
    // an always-on Phase 9C scenario keeps its result (no time needed)
    const always = { ...v1, events: [{ ...v1.events[0], startTimeUtc: null, endTimeUtc: null }] };
    const b2 = parseScenario(JSON.stringify(always), sctx);
    expect(b2.issues).toEqual([]);
    expect(b2.scenario!.evaluationTime).toBeNull();
  });
  it('the base key ignores the simulation time; the scenario hash does not', () => {
    const s = newScenario('x', null, T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z'));
    const a = { ...s, evaluationTime: '2026-04-10T12:00Z' };
    const b = { ...s, evaluationTime: '2026-04-10T13:00Z' };
    expect(baseHash(a)).toBe(baseHash(b));
    expect(scenarioHash(a)).not.toBe(scenarioHash(b));
  });
  it('URLs: the step, the time, and Phase 9C links without a time', () => {
    const s = newScenario('x', null, T('2026-04-10T00:00Z'), T('2026-04-11T00:00Z'));
    s.events = [airportClosure(['KJFK'], T('2026-04-10T12:00Z'), T('2026-04-10T18:00Z'))];
    s.timeline.step = 'PT6H';
    s.evaluationTime = '2026-04-10T15:00Z';
    const p = new URLSearchParams();
    scenarioToParams(s, p);
    const back = scenarioFromParams(p, 'x')!;
    expect([back.timeline.step, back.evaluationTime]).toEqual(['PT6H', '2026-04-10T15:00Z']);
    p.delete('st');
    expect(scenarioFromParams(p, 'x')!.evaluationTime).toBe('2026-04-10T12:00Z');
  });
});

describe('labels', () => {
  it('a label, else the targets', () => {
    const code = (id: string) => id.slice(1);
    expect(eventLabel(airportClosure(['KJFK', 'RHND']), code)).toBe('JFK, HND');
    expect(eventLabel(routeSuspension('KJFK', 'KLAX', 'directed'), code)).toBe('JFK→LAX');
    expect(eventLabel(routeSuspension('KJFK', 'KLAX', 'both'), code)).toBe('JFK⇄LAX');
    expect(eventLabel({ ...airportClosure(['KJFK']), label: 'Closure A' }, code)).toBe('Closure A');
  });
});

describe('store: edit history and the clock hand-over', () => {
  it('undo / redo of scenario edits', () => {
    const st = useAppStore.getState();
    const s0 = newScenario('x', null, 0, 86_400_000);
    st.setSimScenario(s0);
    const s1 = { ...s0, events: [airportClosure(['KJFK'])] };
    st.editSimScenario(s1);
    const s2 = { ...s1, events: [] };
    useAppStore.getState().editSimScenario(s2);
    useAppStore.getState().undoSim();
    expect(useAppStore.getState().simScenario).toBe(s1);
    useAppStore.getState().undoSim();
    expect(useAppStore.getState().simScenario).toBe(s0);
    useAppStore.getState().undoSim(); // nothing more to undo
    expect(useAppStore.getState().simScenario).toBe(s0);
    useAppStore.getState().redoSim();
    expect(useAppStore.getState().simScenario).toBe(s1);
    useAppStore.getState().editSimScenario(s2); // a new edit clears the redo stack
    expect(useAppStore.getState().simFuture).toEqual([]);
  });
  it('opening switches Explore to the temporal clock; closing restores the time mode and drops results', () => {
    const st = useAppStore.getState();
    st.setExploreTime('monthly');
    useAppStore.getState().setSimOpen(true);
    expect(useAppStore.getState().exploreTime).toBe('temporal');
    useAppStore.getState().setSimSeries({ key: 'k', stepMs: 1, points: [], done: 0, total: 0, method: '' });
    useAppStore.getState().setSimOpen(false);
    const s = useAppStore.getState();
    expect([s.exploreTime, s.simSeries, s.simStatus.state, s.temporalPlaying]).toEqual(['monthly', null, 'idle', false]);
  });
});

describe('Research Mode: the same scenario without one event', () => {
  it('compares with the n-th event left out', () => {
    const e1 = airportClosure(['KJFK']);
    const e2 = airportClosure(['RHND']);
    const c = { ...defaultConfig('2026-04'), scenario: { model: 'structural' as const, evaluationTime: null, timeProxy: 'endpoint' as const, events: [e1, e2], name: '' } };
    expect(compareConfig(c, { enabled: true, field: 'scenario', value: 'without:1' })!.scenario!.events).toEqual([e1]);
    expect(compareConfig(c, { enabled: true, field: 'scenario', value: 'without:5' })).toBeNull();
    expect(compareConfig(c, { enabled: true, field: 'scenario', value: 'off' })!.scenario).toBeNull();
  });
});
