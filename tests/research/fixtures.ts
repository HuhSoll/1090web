import { buildStaticNetwork } from '../../src/data/loaders/datasetLoader';
import type { MonthData } from '../../src/data/model/network';
import type { DatasetManifest } from '../../src/data/model/schema';
import type { PersistenceFile, QualityFile, ResearchMeta, TierRecord } from '../../src/research/data';

/**
 * Tiny network: JP-1 (HND), JP-2 (ITM), US-1 (JFK), US-2 (LAX), BR-1 (GRU).
 * routes: 0 HND-ITM, 1 HND-JFK, 2 JFK-LAX, 3 GRU-JFK, 4 ITM-LAX
 */
export const manifest: DatasetManifest = {
  schemaVersion: 1,
  datasetId: 'test-ds',
  kind: 'observed',
  title: 't',
  generatedAt: '2026-01-01T00:00:00Z',
  months: [
    { month: '2026-03', file: 'months/2026-03.json', observedDays: 31, daysInMonth: 31, recordCount: 0 },
    { month: '2026-04', file: 'months/2026-04.json', observedDays: 30, daysInMonth: 30, recordCount: 0 },
  ],
  carriers: [{ id: 'AAA', name: 'AAA', operatorType: 'passenger' }, { id: 'BBB', name: 'BBB', operatorType: 'passenger' }],
  sources: [],
  disclaimer: '',
};

const ap = (id: string, country: string, lat = 0, lon = 0) => ({ id, iata: id.slice(1), icao: id, name: id, city: id, country, lat, lon });
export const network = buildStaticNetwork(
  manifest,
  [ap('RHND', 'JP'), ap('RITM', 'JP'), ap('KJFK', 'US'), ap('KLAX', 'US'), ap('SGRU', 'BR')],
  [[0, 'RHND', 'RITM'], [1, 'RHND', 'KJFK'], [2, 'KJFK', 'KLAX'], [3, 'SGRU', 'KJFK'], [4, 'RITM', 'KLAX']],
);
export const continentOf = ['AS', 'AS', 'NA', 'NA', 'SA'];

/** Explore records [route, dir, airline, p, c, u, basis] */
export const april: MonthData = {
  month: '2026-04',
  observedDays: 30,
  daysInMonth: 30,
  records: [
    [0, 0, 'AAA', 10, 0, 2, 0], // HND->ITM basis 0: 12 (T1..T3)
    [0, 1, 'AAA', 8, 0, 0, 0], // ITM->HND 8
    [0, 0, 'AAA', 5, 0, 0, 1], // HND->ITM T4: 5
    [1, 0, 'BBB', 3, 0, 0, 0], // HND->JFK 3
    [2, 0, 'AAA', 20, 5, 0, 0], // JFK->LAX 25
    [2, 1, 'AAA', 1, 0, 0, 1], // LAX->JFK T4 1
    [3, 1, 'BBB', 2, 0, 0, 0], // JFK->GRU 2
  ],
};
/** T2/T3 split of some basis-0 records */
export const aprilTiers: TierRecord[] = [
  [0, 0, 'AAA', 2, 3, 0, 1], // HND->ITM T2: 4 (p3 u1)
  [0, 0, 'AAA', 3, 2, 0, 0], // HND->ITM T3: 2
  [2, 0, 'AAA', 3, 0, 5, 0], // JFK->LAX T3: 5 cargo
];
export const march: MonthData = {
  month: '2026-03',
  observedDays: 31,
  daysInMonth: 31,
  records: [
    [0, 0, 'AAA', 10, 0, 0, 0],
    [2, 0, 'AAA', 30, 0, 0, 0],
  ],
};

export const persistence: PersistenceFile = {
  months: ['2026-03', '2026-04'],
  routeCount: 5,
  minFlights: 1,
  // per route id: months present for tier sets A..D
  tierSets: { A: '21210', B: '21210', C: '21210', D: '21210' },
};

export const quality: QualityFile = {
  schemaVersion: 1,
  dataset: { id: 'test-ds', version: '1.0.0', generatedAt: '2026-01-01T00:00:00Z', ruleset: 'r', commit: 'abc', inputs: [] },
  months: [],
  anomalies: [],
  gapRuns: [],
  regions: [],
  continents: { JP: 'AS', US: 'NA', BR: 'SA' },
  external: {
    available: true,
    rowFields: ['source', 'scope', 'months', 'reported', 'observed', 'tiers', 'direction', 'min_flights', 'vol_WAPE', 'vol_bias'],
    rows: [
      ['BTS_T100_SEGMENT', 'US-domestic', '2026-04', 'all_reported_carrier_matched', 'carrier_matched', 'T1-T4', 'undirected', 4, 0.1, -0.07],
      ['BTS_T100_SEGMENT', 'US-domestic', '2026-04', 'all_reported_carrier_matched', 'carrier_matched', 'T1-T4', 'undirected', 10, 0.09, -0.06],
      ['BTS_T100_SEGMENT', 'US-touching', 'all_excl_2026-05', 'all_reported_carrier_matched', 'carrier_matched', 'T1-T4', 'undirected', 4, 0.11, -0.08],
    ],
    japan: [{ month: '2026-04', tiers: 'T1-T4', observed_jp_domestic: 76, reported_domestic_total: 100, ratio: 0.76 }],
    airports: [['BTS_T100_SEGMENT', '2026-04', 'KJFK', 900, 1000]],
  },
};

export const meta = (): ResearchMeta => ({
  manifest: { schemaVersion: 1, datasetId: 'test-ds', datasetVersion: '1.0.0', months: ['2026-03', '2026-04'], generatedAt: 'x', script: { name: 's', version: '1' }, files: { 'tiers/2026-04.json': 'h1', 'quality.json': 'h2' }, inputs: { 'routes_monthly.parquet': 'h0' } },
  quality,
  persistence,
  externalRows: [],
});
