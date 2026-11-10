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
}

export interface MonthEntry {
  /** "YYYY-MM" */
  month: string;
  /** Path relative to the dataset root. */
  file: string;
  /** Number of days that actually have observations in this month. */
  observedDays: number;
  recordCount: number;
}

export type OperatorType = 'passenger' | 'cargo' | 'unknown';

export interface CarrierInfo {
  id: string;
  name: string;
  operatorType: OperatorType;
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

/** [routeId, direction, carrierId, passengerFlights, cargoFlights, unknownFlights] */
export type MonthRecordTuple = [number, Direction, string, number, number, number];

export interface MonthFile {
  month: string;
  observedDays: number;
  recordColumns: string[];
  records: MonthRecordTuple[];
}
