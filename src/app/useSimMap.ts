import { useMemo } from 'react';
import type { Comparison } from '../domain/comparison';
import { computeNetworkView, type NetworkView } from '../domain/networkView';
import { computeSimulationOverlay } from '../domain/simulationOverlay';
import type { SimMarks } from '../components/globe/GlobeView';
import { useAppStore } from '../state/store';

/**
 * While the simulation is open, the map shows the scenario's networks instead of the Explore
 * month: after / before / both overlaid. While a new result is computed the last one stays on the
 * map (the panel shows that it is updating). Closing the simulation returns to the observed view.
 */
export function useSimMap(view: NetworkView | null, comparison: Comparison | null): { view: NetworkView | null; comparison: Comparison | null; marks: SimMarks | null; temporal: boolean } {
  const open = useAppStore((s) => s.simOpen);
  const status = useAppStore((s) => s.simStatus);
  const simView = useAppStore((s) => s.simView);
  const filters = useAppStore((s) => s.filters);
  const network = useAppStore((s) => s.network);
  const pathRoutes = useAppStore((s) => s.simPathRoutes);
  const out = status.state === 'ready' ? status.output : status.state === 'loading' ? status.previous : null;
  return useMemo(() => {
    if (!open || !out || !network) return { view, comparison, marks: null, temporal: false };
    const marks: SimMarks = { airports: out.targetAirports, suspendedRoutes: out.targetRoutes, pathRoutes };
    const temporal = out.model === 'temporal';
    if (simView === 'overlay') {
      return { view: computeNetworkView(network, out.after.explore, filters), comparison: computeSimulationOverlay(network, out.before.explore, out.after.explore, filters), marks, temporal };
    }
    const m = simView === 'before' ? out.before.explore : out.after.explore;
    return { view: computeNetworkView(network, m, filters), comparison: null, marks, temporal };
  }, [open, out, network, simView, filters, pathRoutes, view, comparison]);
}
