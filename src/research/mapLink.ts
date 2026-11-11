import type { NetworkFilters } from '../domain/networkView';
import type { ResearchConfig } from './model';

export type UnmappedCondition = 'tiers' | 'region' | 'relation' | 'directed' | 'minMonths' | 'classes' | 'airport';

/**
 * Explore filters closest to a Research config, and the conditions Explore cannot express.
 * Explore shows observed (T1-T3) or observed + callsign (T1-T4), passenger-only or all classes,
 * one country (routes touching it) and a monthly threshold on the airport pair.
 */
export function exploreFiltersFor(c: ResearchConfig): { filters: NetworkFilters; unmapped: UnmappedCondition[] } {
  const unmapped: UnmappedCondition[] = [];
  if (c.tiers === 'A' || c.tiers === 'B') unmapped.push('tiers');
  if (c.region && !c.country) unmapped.push('region');
  if (c.relation !== 'all') unmapped.push('relation');
  if (c.directed) unmapped.push('directed');
  if (c.minMonths > 0) unmapped.push('minMonths');
  const passengerOnly = c.classes.length === 1 && c.classes[0] === 'passenger';
  if (!passengerOnly && c.classes.length < 3) unmapped.push('classes');
  if (c.airport) unmapped.push('airport');
  return {
    filters: {
      country: c.country,
      carrierId: c.carrier,
      mode: passengerOnly ? 'passenger' : 'all',
      minFlights: c.minFlights <= 1 ? 0 : c.minFlights,
      includeCallsign: c.tiers === 'D',
    },
    unmapped,
  };
}
