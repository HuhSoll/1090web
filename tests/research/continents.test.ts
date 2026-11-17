import { describe, expect, it } from 'vitest';
import { airportContinents, continentRule } from '../../src/research/data';
import type { StaticNetwork } from '../../src/data/model/network';

const net = {
  airports: [
    { id: 'GCLP', country: 'ES' },
    { id: 'LEMD', country: 'ES' },
    { id: 'UUEE', country: 'RU' },
    { id: 'UHWW', country: 'RU' },
    { id: 'XXXX', country: 'QQ' },
  ],
} as unknown as StaticNetwork;

describe('continents per airport (Phase 9F)', () => {
  it('uses the airport exception, then the country majority', () => {
    const q = { continents: { ES: 'EU', RU: 'AS' }, airportContinents: { GCLP: 'AF', UUEE: 'EU' }, continentRule: 'airport-v1' };
    expect(airportContinents(net, q)).toEqual(['AF', 'EU', 'EU', 'AS', '']);
    expect(continentRule(q)).toBe('airport-v1');
  });

  it('old quality files keep their country map and are marked as such', () => {
    const q = { continents: { ES: 'AF', RU: 'EU' } };
    expect(airportContinents(net, q)).toEqual(['AF', 'AF', 'EU', 'EU', '']);
    expect(continentRule(q)).toBe('country-first');
  });
});
