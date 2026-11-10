import type { MonthData, StaticNetwork } from '../model/network';
import type { AirportRecord, DatasetManifest, MonthRecordTuple, RouteTuple } from '../model/schema';
import { buildStaticNetwork } from '../loaders/datasetLoader';

/**
 * Renderer stress test (enabled with `?stress=<routeCount>`). Generates random airports and
 * random routes in memory so we can verify that the GPU path stays smooth at production scale.
 * Everything is random; the UI labels this mode explicitly.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STRESS_MAX_ROUTES = 100_000;

export function buildStressNetwork(
  routeCount: number,
  baseManifest: DatasetManifest,
): { network: StaticNetwork; month: MonthData } {
  const n = Math.min(Math.max(100, Math.floor(routeCount)), STRESS_MAX_ROUTES);
  const rand = mulberry32(42);
  const airportCount = Math.max(200, Math.round(Math.sqrt(n) * 12));
  const airports: AirportRecord[] = [];
  for (let i = 0; i < airportCount; i++) {
    // Bias latitude towards the populated mid-latitudes of the northern hemisphere.
    const lat = Math.max(-60, Math.min(70, (rand() - 0.35) * 140));
    const lon = rand() * 360 - 180;
    const id = `S${i}`;
    airports.push({ id, iata: null, icao: null, name: `Stress ${i}`, city: '—', country: 'ZZ', lat, lon });
  }
  const routes: RouteTuple[] = [];
  const records: MonthRecordTuple[] = [];
  const seen = new Set<number>();
  // Preferential attachment-ish: low indices behave like hubs.
  const pick = () => Math.floor(airportCount * rand() ** 2.2);
  while (routes.length < n) {
    let a = pick();
    let b = Math.floor(rand() * airportCount);
    if (a === b) continue;
    if (a > b) [a, b] = [b, a];
    const key = a * airportCount + b;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = routes.length;
    routes.push([id, `S${a}`, `S${b}`]);
    const f = Math.max(1, Math.round(400 * rand() ** 3));
    records.push([id, 0, 'stress', f, 0, 0]);
  }
  const manifest: DatasetManifest = {
    ...baseManifest,
    datasetId: 'stress',
    title: `Renderer stress test (${n.toLocaleString('en')} random routes)`,
    months: [{ month: 'stress', file: '', observedDays: 0, recordCount: records.length }],
    carriers: [{ id: 'stress', name: 'Random', operatorType: 'unknown' }],
  };
  const network = buildStaticNetwork(manifest, airports, routes);
  return { network, month: { month: 'stress', observedDays: 0, records } };
}
