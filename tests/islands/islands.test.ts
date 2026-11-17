import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from './crosscheck.fixture.json';
import { change, compare, evaluate } from '../../src/islands/access';
import { baseScenario, type IslandNetwork, type IslandScenario, type MeshAccess, type MeshTable } from '../../src/islands/model';
import { comparisonCsv, islandResultJson } from '../../src/islands/exports';
import { alternatives, classify } from '../../src/islands/alternatives';

const dir = resolve(__dirname, '../../public/data/islands/okinawa-pilot');
const net = JSON.parse(readFileSync(resolve(dir, 'network.json'), 'utf-8')) as IslandNetwork;
const meshes = JSON.parse(readFileSync(resolve(dir, 'meshes.json'), 'utf-8')) as MeshTable;

/** Python Scenario fields (snake_case) -> TypeScript */
function sc(p: Record<string, unknown>): IslandScenario {
  const s = baseScenario((p.destination as string) ?? 'naha');
  if ('air' in p) s.air = p.air as boolean;
  if ('sea' in p) s.sea = p.sea as boolean;
  if ('service_level' in p) s.serviceLevel = p.service_level as IslandScenario['serviceLevel'];
  if ('bridges' in p) s.bridges = p.bridges as boolean;
  if ('include_seasonal' in p) s.includeSeasonal = p.include_seasonal as boolean;
  if ('stopped_airports' in p) s.stoppedAirports = p.stopped_airports as string[];
  if ('stopped_services' in p) s.stoppedServices = p.stopped_services as string[];
  return s;
}

describe('islands: Python cross-check (pipeline/islands/access.py)', () => {
  for (const c of fixture.cases) {
    it(`${JSON.stringify(c.base)} -> ${JSON.stringify(c.after)}`, () => {
      const r = compare(net, meshes, sc(c.base), sc(c.after));
      for (const [k, t] of Object.entries(c.totals)) {
        const mine = r.totals[k]!;
        for (const [f, v] of Object.entries(t)) {
          const got = (mine as unknown as Record<string, number | null>)[f];
          if (v === null) expect(got, `${k}.${f}`).toBeNull();
          else expect(got, `${k}.${f}`).toBeCloseTo(v as number, 1);
        }
      }
      const ea = evaluate(net, meshes, sc(c.after));
      const byCode = new Map(r.rows.map((x) => [x[0], x[5]]));
      for (const [i, status, time, bound, legs, minFreq, board, ch] of c.sample as [number, string, number | null, number | null, number | null, number | null, string | null, string | null][]) {
        const e = ea[i]!;
        expect(e.status, `mesh ${i}`).toBe(status);
        if (time === null) expect(e.time ?? null).toBeNull();
        else expect(e.time).toBeCloseTo(time, 3);
        if (bound !== null) expect(e.bound).toBeCloseTo(bound, 3);
        expect(e.legs ?? null).toBe(legs);
        expect(e.minFreq ?? null).toBe(minFreq);
        expect(e.board ?? null).toBe(board);
        expect(byCode.get(meshes.rows[i]![0]) ?? null).toBe(ch);
      }
    });
  }
});

describe('islands: model rules', () => {
  const ok = (t: number, legs = 1, f = 7): MeshAccess => ({ status: 'ok', time: t, legs, minFreq: f, path: ['x'] });
  it('change categories keep unreachable and unknown apart', () => {
    expect(change(ok(10), { status: 'unreachable' })).toBe('lost');
    expect(change(ok(10), ok(20))).toBe('slower');
    expect(change(ok(10), ok(10, 2))).toBe('fewer-services');
    expect(change(ok(10), { status: 'time-unknown', legs: 2, minFreq: 1, path: ['y'] })).toBe('undetermined');
    expect(change({ status: 'no-access' }, ok(1))).toBe('n/a');
  });

  it('the same population is compared before and after; unreachable is not averaged as a time', () => {
    const base = baseScenario();
    base.serviceLevel = 'daily';
    const r = compare(net, meshes, base, { ...base, stoppedAirports: ['ROYN'] });
    const t = r.totals.yonaguni!;
    expect(t.lost).toBe(t.pop - t.noAccess);
    expect(t.meanDeltaMin).toBeNull();          // nobody with a computable time change
    const all = r.totals._all!;
    expect(all.pop).toBe(meshes.rows.filter((x) => x[4] !== null).reduce((s, x) => s + x[3], 0));
  });

  it('exports CSV and JSON with the conditions', () => {
    const base = baseScenario();
    const after = { ...base, stoppedAirports: ['RORS'] };
    const r = compare(net, meshes, base, after);
    const csv = comparisonCsv(r);
    expect(csv.split('\n')[0]).toBe('mesh,island,population_2020,status_before,time_before_min,status_after,time_after_min,change,board_before,board_after');
    expect(csv.split('\n').length).toBe(r.rows.length + 1);
    const j = JSON.parse(islandResultJson(r, base, after, 'okinawa-pilot', '9f.1')) as { format: string; conditions: { after: { stoppedAirports: string[] } }; totals: unknown };
    expect(j.format).toBe('1090web-island-dependency');
    expect(j.conditions.after.stoppedAirports).toEqual(['RORS']);
  });
});

describe('islands: what is left after a stop (Phase 9G display fix)', () => {
  const run = (level: 'daily' | 'any', extra: Partial<IslandScenario> = {}) => {
    const b = { ...baseScenario(), serviceLevel: level, ...extra };
    return compare(net, meshes, { ...b, stoppedAirports: [] }, { ...b, stoppedAirports: ['ROIG'] });
  };
  it('Ishigaki: no daily route but a low-frequency ship route -> not "no route"', () => {
    const g = Object.fromEntries(alternatives(run('daily'), run('any'), 'ishigaki').map((x) => [x.cls, x.pop]));
    expect(g).toEqual({ daily: 0, lowFreq: 47637, none: 0, noData: 0 });
  });
  it('without ships nothing verified is left; unreachable meshes of Iriomote stay "cannot be judged"', () => {
    const g = Object.fromEntries(alternatives(run('daily', { sea: false }), run('any', { sea: false }), 'ishigaki').map((x) => [x.cls, x.pop]));
    expect(g.none).toBe(47637);
    const ir = Object.fromEntries(alternatives(run('daily'), run('any'), 'iriomote').map((x) => [x.cls, x.pop]));
    expect(ir.noData).toBe(41);
    expect((ir.lowFreq ?? 0) + (ir.noData ?? 0)).toBe(2226);
  });
  it('classify keeps the four cases apart', () => {
    const ok: MeshAccess = { status: 'ok', time: 1 };
    const un: MeshAccess = { status: 'unreachable' };
    expect(classify(ok, ok)).toBe('daily');
    expect(classify(un, { status: 'time-unknown' })).toBe('lowFreq');
    expect(classify(un, un)).toBe('none');
    expect(classify({ status: 'no-access' }, { status: 'no-access' })).toBe('noData');
  });
});
