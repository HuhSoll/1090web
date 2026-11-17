import type { Comparison, MeshAccess } from './model';

/**
 * What is left for the residents after a stop, judged on two service levels at once so that
 * "no daily route" is never shown as "no route at all" (Phase 9G fix of the Phase 9F display).
 *
 *   daily     a route made only of daily services remains
 *   lowFreq   no daily route, but a route with less frequent services remains (e.g. 2 ships a week)
 *   none      no verified route under any frequency
 *   noData    cannot be judged (no road from the mesh to an airport or port)
 */
export type AlternativeClass = 'daily' | 'lowFreq' | 'none' | 'noData';

export interface AlternativeGroup {
  cls: AlternativeClass;
  pop: number;
  /** after-stop access of the meshes in this class (on the level that defines the class) */
  examples: MeshAccess[];
}

const reachable = (a: MeshAccess) => a.status === 'ok' || a.status === 'time-unknown';

export function classify(daily: MeshAccess, any: MeshAccess): AlternativeClass {
  if (daily.status === 'no-access' || daily.status === 'unassigned' || any.status === 'no-access' || any.status === 'unassigned') return 'noData';
  if (reachable(daily)) return 'daily';
  if (reachable(any)) return 'lowFreq';
  return 'none';
}

/** `daily` and `any` must compare the same meshes (same scenario except the service level). */
export function alternatives(daily: Comparison, any: Comparison, island: string | null): AlternativeGroup[] {
  const byCode = new Map(any.rows.map((r) => [r[0], r[4]]));
  const out = new Map<AlternativeClass, AlternativeGroup>((['daily', 'lowFreq', 'none', 'noData'] as const).map((c) => [c, { cls: c, pop: 0, examples: [] }]));
  for (const [code, isl, pop, , a] of daily.rows) {
    if (island !== null && isl !== island) continue;
    const anyAfter = byCode.get(code);
    if (!anyAfter) continue;
    const c = classify(a, anyAfter);
    const g = out.get(c)!;
    g.pop += pop;
    g.examples.push(c === 'lowFreq' ? anyAfter : a);
  }
  return [...out.values()];
}
