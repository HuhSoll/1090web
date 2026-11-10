import type { AirportRecord, CarrierInfo, DatasetManifest, MonthRecordTuple } from './schema';

/** In-memory, index-based representation used by filtering and rendering. */
export interface Airport extends AirportRecord {
  index: number;
}

export interface Route {
  id: number;
  /** airport index */
  a: number;
  /** airport index */
  b: number;
}

export interface MonthData {
  month: string;
  observedDays: number;
  records: MonthRecordTuple[];
}

export interface StaticNetwork {
  manifest: DatasetManifest;
  airports: Airport[];
  airportIndexById: Map<string, number>;
  routes: Route[];
  carriers: CarrierInfo[];
  /** Route ids touching each airport index. */
  routesByAirport: number[][];
}
