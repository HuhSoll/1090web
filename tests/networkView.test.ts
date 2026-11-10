import { describe, expect, it } from 'vitest';
import { buildStaticNetwork } from '../src/data/loaders/datasetLoader';
import type { MonthData } from '../src/data/model/network';
import type { AirportRecord, DatasetManifest } from '../src/data/model/schema';
import {
  computeNetworkView,
  computeRouteDetail,
  connectedRoutes,
  DEFAULT_FILTERS,
  notableRoutes,
  thresholdStepsFor,
} from '../src/domain/networkView';
import { searchAirports } from '../src/domain/search';

const manifest: DatasetManifest = {
  schemaVersion: 1,
  datasetId: 'test',
  kind: 'demo',
  title: 'test',
  generatedAt: '2026-01-01T00:00:00Z',
  months: [{ month: '2026-01', file: 'months/2026-01.json', observedDays: 31, recordCount: 0 }],
  carriers: [
    { id: 'x', name: 'X', operatorType: 'passenger' },
    { id: 'y', name: 'Y', operatorType: 'cargo' },
  ],
  sources: [],
  disclaimer: '',
};

const ap = (id: string, country: string, lat: number, lon: number): AirportRecord => ({
  id,
  iata: id,
  icao: null,
  name: `${id} Airport`,
  city: `${id} City`,
  country,
  lat,
  lon,
});

// Routes: 0 = AAA(JP)–BBB(US), 1 = AAA(JP)–CCC(FR), 2 = BBB(US)–CCC(FR)
const network = buildStaticNetwork(
  manifest,
  [ap('AAA', 'JP', 35, 139), ap('BBB', 'US', 40, -74), ap('CCC', 'FR', 49, 2.5)],
  [
    [0, 'AAA', 'BBB'],
    [1, 'AAA', 'CCC'],
    [2, 'BBB', 'CCC'],
  ],
);

const month: MonthData = {
  month: '2026-01',
  observedDays: 31,
  records: [
    [0, 0, 'x', 50, 0, 2],
    [0, 1, 'x', 48, 0, 0],
    [0, 0, 'y', 0, 10, 0],
    [1, 0, 'x', 5, 0, 1],
    [2, 1, 'y', 0, 30, 0],
  ],
};

describe('computeNetworkView', () => {
  it('sums all classifications in "all" mode', () => {
    const v = computeNetworkView(network, month, DEFAULT_FILTERS);
    expect(Array.from(v.routeFlights)).toEqual([110, 6, 30]);
    expect(v.visibleRouteCount).toBe(3);
    expect(v.totalFlights).toBe(146);
    expect(v.maxRouteFlights).toBe(110);
    // airport movements = sum of touching routes
    expect(Array.from(v.airportFlights)).toEqual([116, 140, 36]);
  });

  it('passenger mode excludes cargo and unknown (never guesses)', () => {
    const v = computeNetworkView(network, month, { ...DEFAULT_FILTERS, mode: 'passenger' });
    expect(Array.from(v.routeFlights)).toEqual([98, 5, 0]);
    expect(v.visibleRouteCount).toBe(2);
  });

  it('filters by carrier', () => {
    const v = computeNetworkView(network, month, { ...DEFAULT_FILTERS, carrierId: 'y' });
    expect(Array.from(v.routeFlights)).toEqual([10, 0, 30]);
  });

  it('filters by country on either endpoint', () => {
    const v = computeNetworkView(network, month, { ...DEFAULT_FILTERS, country: 'FR' });
    expect(Array.from(v.routeFlights)).toEqual([0, 6, 30]);
  });

  it('applies the monthly threshold and keeps the pre-threshold max', () => {
    const v = computeNetworkView(network, month, { ...DEFAULT_FILTERS, minFlights: 20 });
    expect(Array.from(v.routeFlights)).toEqual([110, 0, 30]);
    expect(v.maxRouteFlightsUnthresholded).toBe(110);
    expect(v.airportFlights[0]).toBe(110);
  });
});

describe('route helpers', () => {
  it('lists connected routes sorted by flights', () => {
    const v = computeNetworkView(network, month, DEFAULT_FILTERS);
    const list = connectedRoutes(network, v, 0);
    expect(list.map((r) => r.routeId)).toEqual([0, 1]);
    expect(list[0]!.other).toBe(1);
  });

  it('breaks a route down by direction, classification and carrier', () => {
    const d = computeRouteDetail(network, month, DEFAULT_FILTERS, 0);
    expect(d.forward).toBe(62);
    expect(d.backward).toBe(48);
    expect(d.passenger).toBe(98);
    expect(d.cargo).toBe(10);
    expect(d.unknown).toBe(2);
    expect(d.carriers).toEqual([
      { carrierId: 'x', flights: 100 },
      { carrierId: 'y', flights: 10 },
    ]);
  });

  it('picks only the top routes as notable', () => {
    const v = computeNetworkView(network, month, DEFAULT_FILTERS);
    // 3 visible routes -> minimum of 3, ordered by flights
    expect(notableRoutes(v).map((r) => r.routeId)).toEqual([0, 2, 1]);
    const filtered = computeNetworkView(network, month, { ...DEFAULT_FILTERS, minFlights: 1000 });
    expect(notableRoutes(filtered)).toEqual([]);
  });

  it('threshold steps never exceed the max', () => {
    expect(thresholdStepsFor(120)).toEqual([0, 5, 10, 20, 30, 50, 75, 100]);
    expect(thresholdStepsFor(0)).toEqual([0]);
  });
});

describe('searchAirports', () => {
  it('ranks exact codes first and matches city/name case-insensitively', () => {
    expect(searchAirports(network.airports, 'bbb')[0]?.id).toBe('BBB');
    expect(searchAirports(network.airports, 'ccc city').map((a) => a.id)).toEqual(['CCC']);
    expect(searchAirports(network.airports, '  ')).toEqual([]);
  });
});
