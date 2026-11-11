import { describe, expect, it } from 'vitest';
import { parseUrlState, serializeUrlState } from '../../src/app/urlState';
import { DEFAULT_FILTERS } from '../../src/domain/networkView';
import { defaultConfig } from '../../src/research/model';
import { network } from './fixtures';

describe('Research Mode in the shared URL', () => {
  it('writes and reads the mode, the conditions and the comparison', () => {
    const researchConfig = { ...defaultConfig('2026-03'), country: 'JP', tiers: 'C' as const };
    const search = serializeUrlState({
      monthIndex: 1, compareEnabled: false, compareBaseIndex: 0, selectedAirport: null, filters: DEFAULT_FILTERS,
      viewMode: 'flat', advisoriesEnabled: false, appMode: 'research', researchConfig,
      researchCompare: { enabled: true, field: 'minFlights', value: 10 },
    }, network, '?dataset=test-ds');
    expect(search).toBe('?dataset=test-ds&mode=research&rm=2026-03&rc=JP&rt=C&rcmp=minFlights%3A10');
    const u = parseUrlState(search, network);
    expect(u.appMode).toBe('research');
    expect(u.research).toEqual({ month: '2026-03', country: 'JP', tiers: 'C' });
    expect(u.researchCompare).toEqual({ field: 'minFlights', value: 10 });
  });
  it('Explore URLs are unchanged', () => {
    const search = serializeUrlState({
      monthIndex: 1, compareEnabled: false, compareBaseIndex: 0, selectedAirport: null, filters: DEFAULT_FILTERS,
      viewMode: 'flat', advisoriesEnabled: false, appMode: 'explore', researchConfig: defaultConfig('2026-03'),
    }, network, '');
    expect(search).toBe('');
    expect(parseUrlState('?month=2026-03', network).appMode).toBeUndefined();
  });
});
