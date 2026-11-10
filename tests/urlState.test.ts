import { describe, expect, it } from 'vitest';
import { parseUrlState, serializeUrlState, type SerializableState } from '../src/app/urlState';
import { buildStaticNetwork } from '../src/data/loaders/datasetLoader';
import type { AirportRecord, DatasetManifest } from '../src/data/model/schema';
import { DEFAULT_FILTERS } from '../src/domain/networkView';

const manifest = {
  schemaVersion: 1,
  datasetId: 't',
  kind: 'observed',
  title: 't',
  generatedAt: '',
  months: ['2026-01', '2026-02', '2026-03'].map((month) => ({ month, file: '', observedDays: 30, recordCount: 0 })),
  carriers: [{ id: 'JAL', name: 'JAL', operatorType: 'unknown' }],
  sources: [],
  disclaimer: '',
} as unknown as DatasetManifest;
const ap = (id: string, country: string): AirportRecord => ({ id, iata: null, icao: id, name: id, city: '', country, lat: 0, lon: 0 });
const network = buildStaticNetwork(manifest, [ap('RJTT', 'JP'), ap('KLAX', 'US')], [[0, 'KLAX', 'RJTT']]);

const state: SerializableState = {
  monthIndex: 2,
  compareEnabled: false,
  compareBaseIndex: 0,
  selectedAirport: null,
  filters: DEFAULT_FILTERS,
  viewMode: 'flat',
};

describe('URL state', () => {
  it('produces a clean URL for the default state', () => {
    expect(serializeUrlState(state, network, '')).toBe('');
  });

  it('round-trips month, comparison, airport and filters', () => {
    const search = serializeUrlState(
      {
        ...state,
        monthIndex: 1,
        compareEnabled: true,
        compareBaseIndex: 0,
        selectedAirport: 0,
        filters: { ...DEFAULT_FILTERS, country: 'JP', carrierId: 'JAL', mode: 'passenger', includeCallsign: false, minFlights: 30 },
        viewMode: 'globe',
      },
      network,
      '?dataset=demo',
    );
    expect(search).toBe('?dataset=demo&month=2026-02&compare=2026-01&airport=RJTT&country=JP&airline=JAL&traffic=passenger&airports=observed&min=30&view=globe');
    expect(parseUrlState(search, network)).toEqual({
      monthIndex: 1,
      compareBaseIndex: 0,
      airport: 0,
      filters: { country: 'JP', carrierId: 'JAL', mode: 'passenger', includeCallsign: false, minFlights: 30 },
    });
  });

  it('ignores unknown or malformed values', () => {
    expect(parseUrlState('?month=2030-01&airport=XXXX&country=ZZ&airline=NOPE&min=-5&traffic=foo', network)).toEqual({});
  });
});
