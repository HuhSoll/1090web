/**
 * Island dependency lab (Phase 9F): data files written by pipeline/islands/build.py.
 * Islands, airports / ports (gateways) and administrative areas have separate identifiers.
 */

export const ISLAND_REGION = 'okinawa-pilot';

export type ServiceMode = 'air' | 'sea';
export type ServiceLevel = 'any' | 'weekly' | 'daily';

export interface Gateway {
  id: string;
  kind: 'airport' | 'port' | 'portGroup';
  iata?: string;
  nameJa: string;
  nameEn: string;
  /** island id, or null outside the pilot islands (Naha, mainland) */
  island: string | null;
  lat: number;
  lon: number;
  members?: string[];
  osm?: string;
  note?: string | null;
  roadSnapM?: number;
}

export interface Service {
  id: string;
  mode: ServiceMode;
  a: string;
  b: string;
  /** scheduled one-way time [min, max] in minutes; null = not verified */
  durationMin: [number, number] | null;
  roundTripsPerWeek: number;
  frequencyText: string;
  status: 'operating' | 'seasonal' | 'suspended';
  season?: string;
  source: 'pref-r8' | '1090web-adsb' | string;
  page?: number;
  note?: string;
}

export interface Destination {
  id: string;
  nameJa: string;
  nameEn: string;
  kind: 'prefectural-hub' | 'mainland';
  nodes: string[];
}

export interface Assumptions {
  roadSpeedKmhByWidth: Record<string, number>;
  connectorKmh: number;
  connectorMaxM: number;
  terminalMin: Record<ServiceMode, number>;
  transferMin: Record<string, number>;
  note: string;
}

export interface IslandNetwork {
  schemaVersion: number;
  region: string;
  gateways: Gateway[];
  services: Service[];
  /** [gateway index, gateway index, minutes] for gateways joined by road */
  roadLinks: { withBridges: [number, number, number][]; noBridges: [number, number, number][] };
  destinations: Destination[];
  assumptions: Assumptions;
}

/** columns: code, lat, lon, pop, island, basis, snapM, accessWith, accessNo */
export type MeshRow = [string, number, number, number, string | null, string, number | null, [number, number][], [number, number][]];

export interface MeshTable {
  schemaVersion: number;
  region: string;
  columns: string[];
  rows: MeshRow[];
}

export interface IslandInfo {
  id: string;
  nameJa: string;
  nameEn: string;
  municipality: string;
  population2020: number;
  airports: string[];
  ports: string[];
}

export interface IslandMeta {
  schemaVersion: number;
  buildVersion: string;
  region: string;
  generatedAt: string;
  nameJa: string;
  nameEn: string;
  islands: IslandInfo[];
  destinations: Destination[];
  defaultDestination: string;
  assumptions: Assumptions;
  portGroupRule: string;
  notModelled: string[];
  serviceSources: Record<string, { titleJa: string; url: string; asOfAir: string; asOfSea: string }>;
  inputs: { file: string; url: string; licence: string; retrieved: string; sha256: string; note: string }[];
  quality: {
    populationYear: number;
    meshLevel: string;
    populationTotalInMeshFiles: number;
    populationByIsland: Record<string, number>;
    unassignedPopulation: number;
    seaPopulation: number;
    noRoadPopulation: number;
    noGatewayPopulation: number;
    suppressedMeshes: number;
    suppressionNote: string;
    assignBasis: Record<string, number>;
    roads: { nodes: number; edges: number; interIslandLinkEdges: number };
    airObservedVsOfficial: { service: string; official: number; status: string; observedFlights: number; observedRoundTripsPerWeek: number }[];
  };
}

export interface IslandGeo {
  islands: { island: string; areaKm2: number; rings: [number, number][][] }[];
  roads: { w: number; b: number; c: [number, number][] }[];
  links: [number, number][][];
  credit: string;
}

export interface GlobalImportance {
  month: string;
  network: { observedAirports: number; augmentedAirports: number; addedArcs: number; addedServices: string[] };
  airports: {
    airport: string;
    observed: null | { systemicDrop: number; spilloverDrop: number; unreachablePairs: number; directLost: number; rankSystemic: number; rankSpillover: number; of: number };
    augmented: { systemicDrop: number; spilloverDrop: number; unreachablePairs: number; directLost: number; positionSystemic: number; positionSpillover: number; of: number };
  }[];
}

export interface IslandScenario {
  destination: string;
  air: boolean;
  sea: boolean;
  serviceLevel: ServiceLevel;
  bridges: boolean;
  includeSeasonal: boolean;
  stoppedAirports: string[];
  stoppedServices: string[];
  timeBudgetMin: number | null;
}

export function baseScenario(destination = 'naha'): IslandScenario {
  return { destination, air: true, sea: true, serviceLevel: 'any', bridges: true, includeSeasonal: false, stoppedAirports: [], stoppedServices: [], timeBudgetMin: null };
}

export type MeshStatus = 'ok' | 'time-unknown' | 'unreachable' | 'no-access' | 'unassigned';

export interface MeshAccess {
  status: MeshStatus;
  time?: number | null;
  /** time of the verified route when a route with fewer legs has no verified duration */
  bound?: number;
  legs?: number | null;
  minFreq?: number | null;
  gateway?: string;
  board?: string | null;
  firstMode?: ServiceMode | null;
  path?: string[];
}

export type Change = 'same' | 'lost' | 'slower' | 'fewer-services' | 'undetermined' | 'better' | 'n/a';

export interface Totals {
  pop: number;
  exposed: number;
  lost: number;
  slower: number;
  undetermined: number;
  fewerServices: number;
  noAccess: number;
  unreachableBefore: number;
  unreachableAfter: number;
  personMinutes: number;
  deltaPop: number;
  deltaMax: number;
  lostWithinBudget: number;
  withinBudgetBefore: number;
  withinBudgetAfter: number;
  computablePop: number;
  meanDeltaMin: number | null;
}

export interface Comparison {
  totals: Record<string, Totals>;
  /** per inhabited mesh of a pilot island: code, island, pop, before, after, change */
  rows: [string, string, number, MeshAccess, MeshAccess, Change][];
}

/** Pilot airports (for the Simulation hand-off). */
export const PILOT_AIRPORTS = ['ROMY', 'RORS', 'ROIG', 'ROYN', 'RORT', 'ROMD', 'RORK'];
