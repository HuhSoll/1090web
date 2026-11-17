/**
 * Observed change vs hypothetical stop (Phase 9G). Both are measured with the Phase 9C impact
 * computation (src/simulation/impact.ts) on the same node set: the airports of the before network.
 *
 *   observed      before = network of the before window, after = network of the after window
 *                 (airports seen only after are left out: the node set is the before network's).
 *                 This includes every change in the world between the windows (low-frequency
 *                 routes come and go everywhere), so it is also given restricted to the area:
 *   observedArea  after = the before network with the routes touching the area replaced by their
 *                 state in the after window (all other routes as before)
 *   hypothetical  before = the same before network, after = the before network without any route
 *                 of the chosen airports (Phase 9C structural closure of those airports)
 *
 * Targets are the area airports in both cases, so "spillover" means pairs of other airports.
 * A hypothetical airport closure is not what operators did after an advisory, and an advisory is
 * not a closure: the two are shown side by side, never as cause and effect.
 */
import { buildResearchNetwork, type ResearchNetwork, type ScopeContext } from '../research/network';
import { defaultConfig, type ResearchConfig } from '../research/model';
import { impactInputOf } from '../simulation/engine';
import type { ImpactInput } from '../simulation/impact';
import { toResearchMonth, type AggregateRows } from '../temporal/aggregate';

export interface NetworkConditions {
  tiers: ResearchConfig['tiers'];
  minFlights: number;
  directed: boolean;
}

export function windowNetwork(ctx: ScopeContext, rows: AggregateRows, days: number, label: string, c: NetworkConditions): ResearchNetwork {
  const carriers = ctx.network.carriers.map((x) => x.id);
  const month = toResearchMonth(rows, carriers, label, days);
  const config: ResearchConfig = { ...defaultConfig(label), tiers: c.tiers, minFlights: c.minFlights, directed: c.directed };
  return buildResearchNetwork(ctx, month, config);
}

/** The before network without the routes of the given airports (structural closure). */
export function withoutAirports(net: ResearchNetwork, airports: ReadonlySet<number>): ResearchNetwork {
  const routes = net.routes.filter((r) => !airports.has(r.a) && !airports.has(r.b));
  return { ...net, routes, flights: routes.reduce((s, r) => s + r.ab + r.ba, 0) };
}

/** Routes touching the area from `after`, every other route from `before`. */
export function areaOnlyAfter(before: ResearchNetwork, after: ResearchNetwork, areaAirports: ReadonlySet<number>): ResearchNetwork {
  const touches = (r: { a: number; b: number }) => areaAirports.has(r.a) || areaAirports.has(r.b);
  const routes = [...before.routes.filter((r) => !touches(r)), ...after.routes.filter(touches)];
  return { ...before, routes, flights: routes.reduce((s, r) => s + r.ab + r.ba, 0) };
}

export interface ImpactPair {
  observed: { input: ImpactInput; nodes: number[] };
  observedArea: { input: ImpactInput; nodes: number[] };
  hypothetical: { input: ImpactInput; nodes: number[] };
  /** area airports present in the before network */
  targets: number[];
}

export function impactPair(before: ResearchNetwork, after: ResearchNetwork, areaAirports: ReadonlySet<number>, directed: boolean): ImpactPair {
  const targets = before.airports.filter((a) => areaAirports.has(a));
  const d = { targetAirports: targets, targetRoutes: [] };
  return {
    observed: impactInputOf(before, after, d, directed),
    observedArea: impactInputOf(before, areaOnlyAfter(before, after, new Set(targets)), d, directed),
    hypothetical: impactInputOf(before, withoutAirports(before, new Set(targets)), d, directed),
    targets,
  };
}
