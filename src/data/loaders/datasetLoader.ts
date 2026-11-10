import type { Airport, MonthData, Route, StaticNetwork } from '../model/network';
import type { AirportRecord, DatasetManifest, RouteTuple } from '../model/schema';
import { assetUrl, fetchJson } from './fetchJson';
import { validateAirports, validateManifest, validateMonth, validateRoutes } from './validate';

/**
 * Loads a public dataset from `<baseUrl>data/<datasetId>/`.
 * Only the small static tables are loaded up front; months are fetched on demand and cached.
 */
export class DatasetLoader {
  private readonly root: string;
  private readonly monthCache = new Map<string, Promise<MonthData>>();
  private network: StaticNetwork | null = null;

  constructor(baseUrl: string, datasetId: string) {
    this.root = assetUrl(baseUrl, `data/${datasetId}/`);
  }

  async loadStatic(signal?: AbortSignal): Promise<StaticNetwork> {
    const manifest = validateManifest(await fetchJson<unknown>(`${this.root}manifest.json`, signal));
    const [airportsRaw, routesRaw] = await Promise.all([
      fetchJson<unknown>(`${this.root}airports.json`, signal),
      fetchJson<unknown>(`${this.root}routes.json`, signal),
    ]);
    const airportRecords = validateAirports(airportsRaw);
    const ids = new Set(airportRecords.map((a) => a.id));
    const routeTuples = validateRoutes(routesRaw, ids);
    this.network = buildStaticNetwork(manifest, airportRecords, routeTuples);
    return this.network;
  }

  loadMonth(month: string): Promise<MonthData> {
    const cached = this.monthCache.get(month);
    if (cached) return cached;
    const network = this.network;
    if (!network) return Promise.reject(new Error('loadStatic() must be called first'));
    const entry = network.manifest.months.find((m) => m.month === month);
    if (!entry) return Promise.reject(new Error(`Month ${month} is not in the manifest`));
    const promise = fetchJson<unknown>(`${this.root}${entry.file}`).then((raw) => {
      const file = validateMonth(raw, network.routes.length);
      return { month: file.month, observedDays: file.observedDays, records: file.records };
    });
    promise.catch(() => this.monthCache.delete(month));
    this.monthCache.set(month, promise);
    return promise;
  }
}

export function buildStaticNetwork(
  manifest: DatasetManifest,
  airportRecords: readonly AirportRecord[],
  routeTuples: readonly RouteTuple[],
): StaticNetwork {
  const airports: Airport[] = airportRecords.map((a, index) => ({ ...a, index }));
  const airportIndexById = new Map(airports.map((a) => [a.id, a.index]));
  const routesByAirport: number[][] = airports.map(() => []);
  const routes: Route[] = routeTuples.map(([id, ia, ib]) => {
    const a = airportIndexById.get(ia);
    const b = airportIndexById.get(ib);
    if (a === undefined || b === undefined) throw new Error(`Route ${id} references unknown airport`);
    routesByAirport[a]!.push(id);
    routesByAirport[b]!.push(id);
    return { id, a, b };
  });
  return { manifest, airports, airportIndexById, routes, carriers: manifest.carriers, routesByAirport };
}
