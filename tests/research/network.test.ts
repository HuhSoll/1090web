import { describe, expect, it } from 'vitest';
import { mergeMonth } from '../../src/research/data';
import { defaultConfig } from '../../src/research/model';
import { areaNetwork, buildResearchNetwork, edgeArrays, routeRows, type ScopeContext } from '../../src/research/network';
import { april, aprilTiers, continentOf, march, network, persistence } from './fixtures';

const carriers = network.carriers.map((c) => c.id);
const ctx: ScopeContext = { network, continentOf, persistence };
const apr = mergeMonth(april, aprilTiers, carriers);
const mar = mergeMonth(march, [], carriers);
const cfg = (patch: Partial<ReturnType<typeof defaultConfig>> = {}) => ({ ...defaultConfig('2026-04'), minFlights: 1, ...patch });

describe('merging Explore records with the tier split', () => {
  it('T1 = basis 0 minus T2 and T3 (per class); basis 1 is T4', () => {
    const rows = Array.from({ length: apr.size }, (_, i) => ({
      route: apr.route[i], dir: apr.dir[i], tier: apr.tier[i], p: apr.passenger[i], c: apr.cargo[i], u: apr.unknown[i],
    }));
    const hndItm = rows.filter((r) => r.route === 0 && r.dir === 0);
    expect(hndItm).toEqual([
      { route: 0, dir: 0, tier: 1, p: 5, c: 0, u: 1 }, // 10/0/2 - T2 3/0/1 - T3 2/0/0
      { route: 0, dir: 0, tier: 2, p: 3, c: 0, u: 1 },
      { route: 0, dir: 0, tier: 3, p: 2, c: 0, u: 0 },
      { route: 0, dir: 0, tier: 4, p: 5, c: 0, u: 0 },
    ]);
    expect(apr.inconsistencies).toBe(0);
    const total = (m: typeof apr) => Array.from({ length: m.size }, (_, i) => m.passenger[i]! + m.cargo[i]! + m.unknown[i]!).reduce((a, b) => a + b, 0);
    expect(total(apr)).toBe(12 + 8 + 5 + 3 + 25 + 1 + 2); // nothing lost or invented
  });
  it('counts tier records that do not fit their Explore record', () => {
    const bad = mergeMonth(april, [[4, 0, 'AAA', 2, 1, 0, 0], [0, 1, 'AAA', 3, 99, 0, 0]], carriers);
    expect(bad.inconsistencies).toBe(2);
  });
});

describe('building the analysed network', () => {
  it('tier sets are nested and filter by tier', () => {
    const flights = (t: 'A' | 'B' | 'C' | 'D') => buildResearchNetwork(ctx, apr, cfg({ tiers: t })).flights;
    expect(flights('A')).toBe(6 + 8 + 3 + 20 + 2); // T1 only
    expect(flights('B')).toBe(flights('A') + 4);
    expect(flights('C')).toBe(flights('B') + 2 + 5);
    expect(flights('D')).toBe(flights('C') + 5 + 1);
    const net = buildResearchNetwork(ctx, apr, cfg());
    expect(net.tierFlights).toEqual([39, 4, 7, 6]);
  });
  it('threshold applies to the airport pair (both directions summed) and is reported', () => {
    const net = buildResearchNetwork(ctx, apr, cfg({ minFlights: 4 }));
    expect(net.routes.map((r) => r.routeId)).toEqual([0, 2]); // HND-JFK 3 and GRU-JFK 2 dropped
    expect(net.droppedByMinFlights).toEqual({ routes: 2, flights: 5 });
    expect(net.candidateRoutes).toBe(4);
    const r0 = net.routes[0]!;
    expect([r0.ab, r0.ba]).toEqual([17, 8]); // 12 (T1-T3) + 5 (T4), 8
  });
  it('classes, airline and persistence filters', () => {
    expect(buildResearchNetwork(ctx, apr, cfg({ classes: ['cargo'] })).flights).toBe(5);
    expect(buildResearchNetwork(ctx, apr, cfg({ carrier: 'BBB' })).flights).toBe(5);
    const p = buildResearchNetwork(ctx, apr, cfg({ minMonths: 2 }));
    expect(p.routes.map((r) => r.routeId)).toEqual([0, 2]); // persistence digits 2,1,2,1,0
    expect(p.droppedByMinMonths.routes).toBe(2);
  });
  it('geographic scope: country and relation', () => {
    const ids = (patch: object) => buildResearchNetwork(ctx, apr, cfg(patch)).routes.map((r) => r.routeId);
    expect(ids({ country: 'US' })).toEqual([1, 2, 3]);
    expect(ids({ country: 'US', relation: 'domestic' })).toEqual([2]);
    expect(ids({ country: 'US', relation: 'international' })).toEqual([1, 3]);
    expect(ids({ relation: 'domestic' })).toEqual([0, 2]); // world: same country at both ends
    expect(ids({ region: 'SA' })).toEqual([3]);
    expect(ids({ airport: 'RHND' })).toEqual([0, 1]);
  });
  it('directed and undirected edges for the graph', () => {
    const net = buildResearchNetwork(ctx, apr, cfg());
    const d = edgeArrays(net, true);
    expect(d.src.length).toBe(net.directedRoutes);
    const u = edgeArrays(net, false);
    expect(u.src.length).toBe(net.routes.length);
    expect(Array.from(u.weight).reduce((a, b) => a + b, 0)).toBe(net.flights);
  });
});

describe('route table and month-over-month', () => {
  it('compares with the same config in the previous month', () => {
    const a = buildResearchNetwork(ctx, apr, cfg());
    const prev = buildResearchNetwork(ctx, mar, cfg({ month: '2026-03' }));
    const und = routeRows(a, false, prev);
    const hi = und.find((r) => r.routeId === 0)!;
    expect(hi.flights).toBe(25);
    expect(hi.previous).toBe(10);
    expect(hi.monthsPresent).toBe(2);
    expect(und.find((r) => r.routeId === 1)!.previous).toBe(0); // not seen in March
    const dir = routeRows(a, true, prev);
    expect(dir.filter((r) => r.routeId === 0).map((r) => [r.flights, r.previous])).toEqual([[17, 10], [8, 0]]);
    expect(routeRows(a, false, null)[0]!.previous).toBeNull();
  });
});

describe('country and region networks', () => {
  it('counts each flight once on its area pair; same-area flights are domestic', () => {
    const net = buildResearchNetwork(ctx, apr, cfg());
    const c = areaNetwork(net, (i) => network.airports[i]!.country, 'country', false);
    expect(c.pairs).toEqual([{ from: 'JP', to: 'US', flights: 3 }, { from: 'BR', to: 'US', flights: 2 }]);
    const jp = c.stats.find((s) => s.area === 'JP')!;
    expect(jp.domestic).toBe(25);
    expect(jp.international).toBe(3);
    const us = c.stats.find((s) => s.area === 'US')!;
    expect([us.domestic, us.international, us.partners]).toEqual([26, 5, 2]);
    const total = c.pairs.reduce((s, p) => s + p.flights, 0) + c.stats.reduce((s, x) => s + x.domestic, 0);
    expect(total).toBe(net.flights);
    const directed = areaNetwork(net, (i) => network.airports[i]!.country, 'country', true);
    expect(directed.pairs).toEqual([{ from: 'JP', to: 'US', flights: 3 }, { from: 'US', to: 'BR', flights: 2 }]);
  });
});
