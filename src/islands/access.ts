/**
 * Access model A ("network availability") of the island lab. Same algorithm, order and tie-breaking
 * as pipeline/islands/access.py; tests/islands compare both on the published data.
 *
 * Waiting for a departure is not included: there is no verified timetable, only the number of
 * services per week. Times are road (assumed speeds) + terminal / transfer (assumed) + scheduled
 * in-vehicle time.
 */
import type { Change, Comparison, IslandNetwork, IslandScenario, MeshAccess, MeshTable, Service, ServiceMode, Totals } from './model';

const LEVEL_MIN_PER_WEEK = { any: 1e-9, weekly: 1, daily: 7 } as const;

export function usableServices(net: IslandNetwork, sc: IslandScenario): Service[] {
  const stopped = new Set(sc.stoppedAirports);
  const off = new Set(sc.stoppedServices);
  return net.services.filter((s) => {
    if (s.status === 'suspended') return false;
    if (s.status === 'seasonal' && !sc.includeSeasonal) return false;
    if (!(s.mode === 'air' ? sc.air : sc.sea)) return false;
    if (s.roundTripsPerWeek < LEVEL_MIN_PER_WEEK[sc.serviceLevel]) return false;
    return !(stopped.has(s.a) || stopped.has(s.b) || off.has(s.id));
  });
}

const mid = (d: [number, number] | null) => (d === null ? null : (d[0] + d[1]) / 2);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Lexicographic comparison of number / string tuples (Python tuple order). */
function cmp(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

class Heap<T extends readonly (number | string)[]> {
  private h: T[] = [];
  get size() { return this.h.length; }
  push(x: T) {
    const h = this.h;
    h.push(x);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(h[i]!, h[p]!) >= 0) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  pop(): T {
    const h = this.h;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && cmp(h[l]!, h[m]!) < 0) m = l;
        if (r < h.length && cmp(h[r]!, h[m]!) < 0) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

interface Edge { to: number; kind: 'service' | 'road'; mode: ServiceMode | 'road'; minutes: number | null; freq: number; sid: string | null }

export interface GatewayResult {
  reachable: boolean;
  time: number | null;
  legs: number | null;
  fewestLegs: number | null;
  minFreq: number | null;
  path: string[];
  firstMode: ServiceMode | null;
  board: string | null;
}

export function gatewayResults(net: IslandNetwork, sc: IslandScenario): Map<string, GatewayResult> {
  const ids = net.gateways.map((g) => g.id);
  const idx = new Map(ids.map((g, i) => [g, i]));
  const dest = net.destinations.find((d) => d.id === sc.destination);
  if (!dest) throw new Error(`unknown destination ${sc.destination}`);
  const targets = new Set(dest.nodes.filter((n) => idx.has(n)).map((n) => idx.get(n)!));
  const adj: Edge[][] = ids.map(() => []);
  for (const s of usableServices(net, sc)) {
    const a = idx.get(s.a)!;
    const b = idx.get(s.b)!;
    const m = mid(s.durationMin);
    adj[a]!.push({ to: b, kind: 'service', mode: s.mode, minutes: m, freq: s.roundTripsPerWeek, sid: s.id });
    adj[b]!.push({ to: a, kind: 'service', mode: s.mode, minutes: m, freq: s.roundTripsPerWeek, sid: s.id });
  }
  for (const [i, j, t] of net.roadLinks[sc.bridges ? 'withBridges' : 'noBridges']) {
    adj[i]!.push({ to: j, kind: 'road', mode: 'road', minutes: t, freq: Infinity, sid: null });
    adj[j]!.push({ to: i, kind: 'road', mode: 'road', minutes: t, freq: Infinity, sid: null });
  }
  const term = net.assumptions.terminalMin;
  const trans = net.assumptions.transferMin;
  const out = new Map<string, GatewayResult>();

  for (let g = 0; g < ids.length; g++) {
    // reachability and fewest service legs
    const bestLegs = new Map<number, number>([[g, 0]]);
    const prevR = new Map<number, [number, string | null, number, ServiceMode | 'road'] | null>([[g, null]]);
    const dq = new Heap<[number, number]>();
    dq.push([0, g]);
    let reachLegs: number | null = null;
    let reachNode = -1;
    while (dq.size) {
      const [legs, u] = dq.pop();
      if (legs > (bestLegs.get(u) ?? 1e9)) continue;
      if (targets.has(u)) { reachLegs = legs; reachNode = u; break; }
      for (const e of adj[u]!) {
        const nl = legs + (e.kind === 'service' ? 1 : 0);
        if (nl < (bestLegs.get(e.to) ?? 1e9)) {
          bestLegs.set(e.to, nl);
          prevR.set(e.to, [u, e.sid, e.freq, e.mode]);
          dq.push([nl, e.to]);
        }
      }
    }
    const r: GatewayResult = { reachable: reachLegs !== null, time: null, legs: reachLegs, fewestLegs: reachLegs, minFreq: null, path: [], firstMode: null, board: null };
    if (reachLegs !== null) {
      const path: string[] = [];
      let f = Infinity;
      let x = reachNode;
      while (prevR.get(x)) {
        const [u, sid, freq, mode] = prevR.get(x)!;
        if (sid) { path.push(sid); f = Math.min(f, freq); r.firstMode = mode as ServiceMode; r.board = ids[u]!; }
        x = u;
      }
      r.path = path.reverse();
      r.minFreq = f === Infinity ? null : f;
    }
    if (r.reachable) {
      type Key = string;
      const key = (u: number, last: string): Key => `${u}|${last}`;
      const dist = new Map<Key, [number, number]>([[key(g, 'none'), [0, 0]]]);
      const prev = new Map<Key, [[number, string], string | null, number, ServiceMode | 'road'] | null>([[key(g, 'none'), null]]);
      const pq = new Heap<[number, number, number, string]>();
      pq.push([0, 0, g, 'none']);
      let found: [number, string] | null = null;
      while (pq.size) {
        const [t, legs, u, last] = pq.pop();
        const d0 = dist.get(key(u, last)) ?? [1e18, 0];
        if (cmp([t, legs], d0) > 0) continue;
        if (targets.has(u)) { found = [u, last]; break; }
        for (const e of adj[u]!) {
          if (e.minutes === null) continue;
          let nt: number;
          let nlast: string;
          let nl: number;
          if (e.kind === 'road') { nt = t + e.minutes; nlast = last; nl = legs; }
          else {
            const extra = last === 'none' ? term[e.mode as ServiceMode] : trans[`${last}-${e.mode}`]!;
            nt = t + extra + e.minutes;
            nlast = e.mode;
            nl = legs + 1;
          }
          const k = key(e.to, nlast);
          if (cmp([nt, nl], dist.get(k) ?? [1e18, 0]) < 0) {
            dist.set(k, [nt, nl]);
            prev.set(k, [[u, last], e.sid, e.freq, e.mode]);
            pq.push([nt, nl, e.to, nlast]);
          }
        }
      }
      if (found) {
        const [t, legs] = dist.get(key(found[0], found[1]))!;
        const path: string[] = [];
        let f = Infinity;
        let first: ServiceMode | null = null;
        let board: string | null = null;
        let x: [number, string] = found;
        for (;;) {
          const p = prev.get(key(x[0], x[1]));
          if (!p) break;
          const [px, sid, freq, mode] = p;
          if (sid) { path.push(sid); f = Math.min(f, freq); first = mode as ServiceMode; board = ids[px[0]]!; }
          x = px;
        }
        r.time = r3(t);
        r.legs = legs;
        r.path = path.reverse();
        r.minFreq = f === Infinity ? null : f;
        r.firstMode = first;
        r.board = board;
      }
    }
    out.set(ids[g]!, r);
  }
  return out;
}

export function evaluate(net: IslandNetwork, meshes: MeshTable, sc: IslandScenario): MeshAccess[] {
  const gw = gatewayResults(net, sc);
  const ids = net.gateways.map((g) => g.id);
  const out: MeshAccess[] = [];
  for (const row of meshes.rows) {
    if (row[4] === null) { out.push({ status: 'unassigned' }); continue; }
    const acc = sc.bridges ? row[7] : row[8];
    if (!acc.length) { out.push({ status: 'no-access' }); continue; }
    let best: { key: [number, number]; gi: number; r: GatewayResult; tot: number } | null = null;
    let bestReach: { key: [number, number, number]; gi: number; r: GatewayResult } | null = null;
    let fewest: number | null = null;
    for (const [gi, a] of acc) {
      const r = gw.get(ids[gi]!)!;
      if (!r.reachable) continue;
      const kr: [number, number, number] = [r.legs!, -(r.minFreq || 0), a];
      if (!bestReach || cmp(kr, bestReach.key) < 0) bestReach = { key: kr, gi, r };
      fewest = fewest === null ? r.fewestLegs! : Math.min(fewest, r.fewestLegs!);
      if (r.time !== null) {
        const tot = a + r.time;
        const k: [number, number] = [Math.round(tot * 1e6) / 1e6, r.legs!];
        if (!best || cmp(k, best.key) < 0) best = { key: k, gi, r, tot };
      }
    }
    const pick = (gi: number, r: GatewayResult) => ({ legs: r.legs, minFreq: r.minFreq, gateway: ids[gi]!, board: r.board, firstMode: r.firstMode, path: r.path });
    if (best && best.r.legs! > fewest!) out.push({ status: 'time-unknown', time: null, bound: r3(best.tot), ...pick(best.gi, best.r) });
    else if (best) out.push({ status: 'ok', time: r3(best.tot), ...pick(best.gi, best.r) });
    else if (bestReach) out.push({ status: 'time-unknown', time: null, ...pick(bestReach.gi, bestReach.r) });
    else out.push({ status: 'unreachable' });
  }
  return out;
}

function sameAccess(a: MeshAccess, b: MeshAccess): boolean {
  return a.status === b.status && a.time === b.time && a.bound === b.bound && a.legs === b.legs && a.minFreq === b.minFreq &&
    a.gateway === b.gateway && a.board === b.board && a.firstMode === b.firstMode && JSON.stringify(a.path) === JSON.stringify(b.path);
}

export function change(b: MeshAccess, a: MeshAccess): Change {
  const na = (s: string) => s === 'unassigned' || s === 'no-access';
  if (na(b.status) || na(a.status)) return 'n/a';
  if (b.status !== 'unreachable' && a.status === 'unreachable') return 'lost';
  if (b.status === 'unreachable') return a.status === 'unreachable' ? 'same' : 'better';
  if (b.status === 'ok' && a.status === 'ok') {
    if (a.time! > b.time! + 0.5) return 'slower';
    if (a.time! < b.time! - 0.5) return 'better';
  }
  const worse = (a.minFreq || 0) < (b.minFreq || 0) - 1e-9 || (a.legs || 0) > (b.legs || 0);
  if (b.status === 'ok' && a.status === 'ok') return worse ? 'fewer-services' : 'same';
  if (sameAccess(b, a) || (JSON.stringify(b.path) === JSON.stringify(a.path) && b.status === a.status)) return 'same';
  return 'undetermined';
}

const emptyTotals = (): Totals => ({
  pop: 0, exposed: 0, lost: 0, slower: 0, undetermined: 0, fewerServices: 0, noAccess: 0, unreachableBefore: 0, unreachableAfter: 0,
  personMinutes: 0, deltaPop: 0, deltaMax: 0, lostWithinBudget: 0, withinBudgetBefore: 0, withinBudgetAfter: 0, computablePop: 0, meanDeltaMin: null,
});

/** Population-weighted comparison of two scenarios over the same meshes and population. */
export function compare(net: IslandNetwork, meshes: MeshTable, base: IslandScenario, after: IslandScenario): Comparison {
  const eb = evaluate(net, meshes, base);
  const ea = evaluate(net, meshes, after);
  const budget = after.timeBudgetMin;
  const totals: Record<string, Totals> = {};
  const rows: Comparison['rows'] = [];
  meshes.rows.forEach((row, i) => {
    const isl = row[4];
    if (isl === null) return;
    const pop = row[3];
    const b = eb[i]!;
    const a = ea[i]!;
    const ch = change(b, a);
    rows.push([row[0], isl, pop, b, a, ch]);
    for (const k of [isl, '_all']) {
      const t = (totals[k] ??= emptyTotals());
      t.pop += pop;
      if (ch === 'n/a') { t.noAccess += pop; continue; }
      if (b.status === 'unreachable') t.unreachableBefore += pop;
      if (a.status === 'unreachable') t.unreachableAfter += pop;
      if (ch === 'lost' || ch === 'slower' || ch === 'fewer-services') t.exposed += pop;
      if (ch === 'lost') t.lost += pop;
      else if (ch === 'slower') t.slower += pop;
      else if (ch === 'undetermined') t.undetermined += pop;
      else if (ch === 'fewer-services') t.fewerServices += pop;
      if (b.status === 'ok' && a.status === 'ok') {
        const d = a.time! - b.time!;
        t.computablePop += pop;
        if (d > 0.5) { t.personMinutes += pop * d; t.deltaPop += pop; t.deltaMax = Math.max(t.deltaMax, d); }
      }
      if (budget !== null) {
        const wb = b.status === 'ok' && b.time! <= budget;
        const wa = a.status === 'ok' && a.time! <= budget;
        t.withinBudgetBefore += wb ? pop : 0;
        t.withinBudgetAfter += wa ? pop : 0;
        t.lostWithinBudget += wb && !wa ? pop : 0;
      }
    }
  });
  for (const t of Object.values(totals)) {
    t.meanDeltaMin = t.deltaPop ? Math.round((t.personMinutes / t.deltaPop) * 100) / 100 : null;
    t.personMinutes = Math.round(t.personMinutes * 10) / 10;
    t.deltaMax = Math.round(t.deltaMax * 100) / 100;
  }
  return { totals, rows };
}
