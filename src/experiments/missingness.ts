/**
 * Missingness models (Phase 9E), applied to observed flights: every flight of the period is kept
 * or removed, then routes are rebuilt from the kept flights (thresholds apply after removal).
 * They only remove flights; they never invent unobserved ones.
 *
 * The browser works on aggregated rows (route x direction x tier x airline, flights per class);
 * each flight in a row gets its own Bernoulli draw, which is the flight-level model exactly.
 * The random stream differs from the Python runner (which draws per flight id), so browser and
 * batch trials agree in distribution, not draw for draw.
 */
import type { ResearchMonth } from '../research/data';
import type { CombineRule, MissingnessModel } from './model';

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed of one (seed, trial, stream): every trial has its own stream, so results do not depend on run order. */
export function trialSeed(seed: number, trial: number, stream = 0): number {
  let h = 0x9e3779b9 ^ seed;
  for (const x of [trial, stream]) {
    h = Math.imul(h ^ (x + 0x7f4a7c15), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0 || 1;
}

export const combine: Record<CombineRule, (po: number, pd: number) => number> = {
  origin: (po) => po,
  destination: (_po, pd) => pd,
  max: (po, pd) => Math.max(po, pd),
  /** missed when missed at either end (independent) */
  either: (po, pd) => 1 - (1 - po) * (1 - pd),
  /** missed only when missed at both ends (independent) */
  both: (po, pd) => po * pd,
};

export interface MissingnessContext {
  /** route id -> [a, b] airport indices */
  ends: (routeId: number) => readonly [number, number];
  continentOf: readonly string[];
  /** flights per route (both directions) in the reference network (route model) */
  routeFlights: ReadonlyMap<number, number>;
}

/** Number of kept flights out of n, each removed with probability p. */
function thin(n: number, p: number, r: () => number): number {
  if (n <= 0 || p <= 0) return n;
  if (p >= 1) return 0;
  let k = 0;
  for (let i = 0; i < n; i++) if (r() >= p) k++;
  return k;
}

/** One trial of a missingness model on a month (trial 0 = the month unchanged). */
export function applyMissingness(m: ResearchMonth, model: MissingnessModel, seed: number, trial: number, ctx: MissingnessContext): ResearchMonth {
  if (trial === 0) return m;
  const r = rng(trialSeed(seed, trial, 0));
  const rate = new Float64Array(m.size);
  let routeGone: Set<number> | null = null;
  for (let i = 0; i < m.size; i++) {
    const [a, b] = ctx.ends(m.route[i]!);
    const [o, d] = m.dir[i] === 0 ? [a, b] : [b, a];
    if (model.model === 'uniform') rate[i] = model.rate;
    else if (model.model === 'regional') {
      const po = model.regionRates[ctx.continentOf[o]!] ?? model.otherRate;
      const pd = model.regionRates[ctx.continentOf[d]!] ?? model.otherRate;
      rate[i] = combine[model.combine](po, pd);
    } else {
      const low = (ctx.routeFlights.get(m.route[i]!) ?? 0) < model.lowFrequency.threshold;
      rate[i] = low ? (model.lowFrequency.unit === 'route' ? -1 : model.lowFrequency.rateLow) : model.lowFrequency.rateOther;
    }
  }
  if (model.model === 'route' && model.lowFrequency.unit === 'route') {
    // whole low-frequency routes disappear together: one draw per route, in route id order
    const r2 = rng(trialSeed(seed, trial, 1));
    const low = [...ctx.routeFlights.entries()].filter(([, f]) => f < model.lowFrequency.threshold).map(([id]) => id).sort((x, y) => x - y);
    routeGone = new Set(low.filter(() => r2() < model.lowFrequency.rateLow));
  }
  const passenger = new Float64Array(m.size);
  const cargo = new Float64Array(m.size);
  const unknown = new Float64Array(m.size);
  for (let i = 0; i < m.size; i++) {
    if (rate[i] === -1) {
      const gone = routeGone!.has(m.route[i]!);
      passenger[i] = gone ? 0 : m.passenger[i]!;
      cargo[i] = gone ? 0 : m.cargo[i]!;
      unknown[i] = gone ? 0 : m.unknown[i]!;
      continue;
    }
    const p = rate[i]!;
    passenger[i] = thin(Math.round(m.passenger[i]!), p, r);
    cargo[i] = thin(Math.round(m.cargo[i]!), p, r);
    unknown[i] = thin(Math.round(m.unknown[i]!), p, r);
  }
  return { ...m, passenger, cargo, unknown };
}
