import { useMemo } from 'react';
import { ChangeKind, type Comparison } from '../domain/comparison';
import { computeNetworkView, type NetworkView } from '../domain/networkView';
import { computeSimulationOverlay } from '../domain/simulationOverlay';
import type { SimMarks } from '../components/globe/GlobeView';
import { useAppStore, type SimAirportMetric } from '../state/store';
import type { ImpactResult } from '../simulation/impact';
import type { SimulationOutput } from '../simulation/engine';

/**
 * While the simulation is open, the map shows the scenario's networks instead of the Explore
 * view (Phase 9D modes):
 *   focus    - only what changed: lost (dashed) and reduced connections; unchanged ones hidden
 *   overlay  - before + after, unchanged connections faint
 *   after / before - one network ("show before" can also be held down: simPeek)
 *   airports - airports by the chosen impact measure (stopped airports marked separately)
 * The camera is never moved by a mode change. While a new result is computed the last one stays on
 * the map (the panel shows that it is updating).
 */
export function useSimMap(view: NetworkView | null, comparison: Comparison | null): {
  view: NetworkView | null; comparison: Comparison | null; marks: SimMarks | null; temporal: boolean; mode: string;
} {
  const open = useAppStore((s) => s.simOpen);
  const status = useAppStore((s) => s.simStatus);
  const simView = useAppStore((s) => s.simView);
  const peek = useAppStore((s) => s.simPeek);
  const filters = useAppStore((s) => s.filters);
  const network = useAppStore((s) => s.network);
  const pathRoutes = useAppStore((s) => s.simPathRoutes);
  const impact = useAppStore((s) => s.simImpact);
  const metric = useAppStore((s) => s.simAirportMetric);
  const selectedEvent = useAppStore((s) => s.simSelectedEvent);
  const scenario = useAppStore((s) => s.simScenario);
  const out = status.state === 'ready' ? status.output : status.state === 'loading' ? status.previous : null;
  const imp = out && impact.state === 'ready' && impact.key === `${out.key}:impact` ? impact.result : null;
  return useMemo(() => {
    if (!open || !out || !network) return { view, comparison, marks: null, temporal: false, mode: 'off' };
    const mode = peek ? 'before' : simView;
    // the selected event's routes are drawn highlighted (its airports are marked anyway)
    const ev = scenario?.events.find((e) => e.eventId === selectedEvent);
    const evRoutes = ev && ev.targetType === 'route'
      ? ev.targetIds.map((id) => routeIdOf(network, id)).filter((x): x is number => x !== null) : [];
    const marks: SimMarks = { airports: out.targetAirports, suspendedRoutes: out.targetRoutes, pathRoutes: pathRoutes.length ? pathRoutes : evRoutes, impacted: [] };
    const temporal = out.model === 'temporal';
    if (mode === 'before' || mode === 'after') {
      const m = mode === 'before' ? out.before.explore : out.after.explore;
      return { view: computeNetworkView(network, m, filters), comparison: null, marks, temporal, mode };
    }
    const overlay = computeSimulationOverlay(network, out.before.explore, out.after.explore, filters);
    if (mode === 'overlay') return { view: computeNetworkView(network, out.after.explore, filters), comparison: overlay, marks, temporal, mode };
    // focus / airports: unchanged connections are not drawn
    const changed = onlyChanged(overlay, network.routes);
    if (mode === 'airports' && imp) {
      const { weights, impacted } = airportImpact(out, imp, metric, network.airports.length);
      return { view: computeNetworkView(network, out.after.explore, filters), comparison: { ...changed, airportBase: weights, airportTarget: weights }, marks: { ...marks, impacted }, temporal, mode };
    }
    return { view: computeNetworkView(network, out.after.explore, filters), comparison: changed, marks, temporal, mode };
  }, [open, out, network, simView, peek, filters, pathRoutes, view, comparison, imp, metric, selectedEvent, scenario]);
}

function routeIdOf(network: { airports: { id: string }[]; routes: { a: number; b: number }[] }, id: string): number | null {
  const [a, b] = id.split('>');
  const ia = network.airports.findIndex((x) => x.id === a);
  const ib = network.airports.findIndex((x) => x.id === b);
  if (ia < 0 || ib < 0) return null;
  const r = network.routes.findIndex((x) => (x.a === ia && x.b === ib) || (x.a === ib && x.b === ia));
  return r < 0 ? null : r;
}

/** The overlay without unchanged connections; airports keep only the size of their changed connections. */
function onlyChanged(c: Comparison, routes: readonly { a: number; b: number }[]): Comparison {
  const kind = c.kind.slice();
  const weight = c.weight.slice();
  const airport = new Float32Array(c.airportBase.length);
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] === ChangeKind.Stable) {
      kind[i] = ChangeKind.Hidden;
      weight[i] = 0;
    }
    if (kind[i] === ChangeKind.Hidden) continue;
    const r = routes[i]!;
    // same units as the overlay (comparisonAsView multiplies by 30)
    airport[r.a]! += weight[i]! / 30;
    airport[r.b]! += weight[i]! / 30;
  }
  return { ...c, kind, weight, counts: { ...c.counts, stable: 0 }, airportBase: airport, airportTarget: airport };
}

/**
 * Airport weights for the 'airports' view: the chosen measure over the non-target airports
 * (lost: partners no longer reachable; hop2: fewer airports within 2 hops; degree: fewer direct
 * connections). Not a "risk" score: a named, countable change.
 */
export function airportImpact(out: SimulationOutput, imp: ImpactResult, metric: SimAirportMetric, nAirports: number): { weights: Float32Array; impacted: number[] } {
  const p = imp.perNode;
  const targets = new Set(out.targetAirports);
  const weights = new Float32Array(nAirports);
  const impacted: number[] = [];
  out.impactNodes.forEach((g, i) => {
    if (targets.has(g)) return;
    const v = metric === 'lost' ? p.lost[i]! : metric === 'hop2' ? p.hop2Before[i]! - p.hop2After[i]! : p.degBefore[i]! - p.degAfter[i]!;
    if (v > 0) {
      weights[g] = v;
      impacted.push(g);
    }
  });
  for (const g of out.targetAirports) weights[g] = Math.max(...weights, 1);
  return { weights, impacted };
}
