/**
 * Public dataset schema (what the browser downloads from /data/<datasetId>/).
 *
 * The same shape is used for the Phase 1 demo dataset and for the production dataset
 * that Phase 2's Python + DuckDB pipeline will emit, so the frontend never needs to know
 * where the numbers came from — only `manifest.kind` tells it whether they are real.
 */

export type DatasetKind = 'demo' | 'observed';

export interface DatasetSource {
  id: string;
  name: string;
  description: string;
  license: string;
  url?: string;
  retrievedAt?: string;
  files?: string[];
}

export interface MonthEntry {
  /** "YYYY-MM" */
  month: string;
  /** Path relative to the dataset root. */
  file: string;
  /** Number of days that actually have observations in this month. */
  observedDays: number;
  /** Calendar days in the month (absent in older/demo manifests). */
  daysInMonth?: number;
  recordCount: number;
}

export type OperatorType = 'passenger' | 'cargo' | 'unknown';

export interface CarrierInfo {
  id: string;
  name: string;
  operatorType: OperatorType;
  /** Total flights in the dataset (observed datasets list carriers busiest first). */
  flights?: number;
}

export interface DatasetManifest {
  schemaVersion: 1;
  datasetId: string;
  kind: DatasetKind;
  title: string;
  generatedAt: string;
  months: MonthEntry[];
  carriers: CarrierInfo[];
  sources: DatasetSource[];
  disclaimer: string;
  quality?: DatasetQuality;
}

/** Data-quality summary produced by the pipeline (observed datasets only). */
export interface DatasetQuality {
  flightsWithAirlineCode: number;
  flightsOnMap: number;
  basis: Partial<Record<'observed' | 'callsign' | 'unknown', number>>;
  classes: Partial<Record<'passenger' | 'cargo' | 'unknown', number>>;
  observedVsCallsignConflicts: { origin: number; destination: number };
  flightsWithoutAirlineCode: number;
}

export interface AirportRecord {
  /** Stable id used by routes (IATA for now; may become an OurAirports ident later). */
  id: string;
  iata: string | null;
  icao: string | null;
  name: string;
  city: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  lat: number;
  lon: number;
}

/** Undirected airport pair: [routeId, airportIdA, airportIdB]. Route ids are dense 0..n-1. */
export type RouteTuple = [number, string, string];

/** 0 = A→B, 1 = B→A */
export type Direction = 0 | 1;

/**
 * How the airports of the counted flights were determined.
 * 0 = observed in the ADS-B track (or track + callsign route agree), 1 = callsign route only.
 */
export type Basis = 0 | 1;

/**
 * [routeId, direction, carrierId, passengerFlights, cargoFlights, unknownFlights, basis?]
 * basis is omitted in the demo dataset (treated as observed).
 */
export type MonthRecordTuple =
  | [number, Direction, string, number, number, number]
  | [number, Direction, string, number, number, number, Basis];

export interface MonthFile {
  month: string;
  observedDays: number;
  daysInMonth?: number;
  recordColumns: string[];
  records: MonthRecordTuple[];
}
