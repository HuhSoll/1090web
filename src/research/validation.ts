/**
 * Picks the Phase 7 external-comparison result that matches the current analysis, and lists
 * every way the comparison's conditions differ from the analysis. A result for another month,
 * scope or definition is never shown as if it applied: the differences are always returned.
 */
import type { ExternalRow, QualityFile } from './data';
import type { ResearchConfig, TierSet } from './model';

export const TIER_LABEL: Record<TierSet, string> = { A: 'T1', B: 'T1-T2', C: 'T1-T3', D: 'T1-T4' };
export const VALIDATION_THRESHOLDS = [1, 4, 10, 30] as const;

export type ValidationSource = 'BTS_T100_SEGMENT' | 'ANAC_DADOS_ESTATISTICOS' | 'MLIT_AIR_TRANSPORT_FLASH';

/** Condition differences between the analysis and the external comparison (i18n keys suffixes). */
export type Difference =
  | 'carrierMatched'
  | 'carrierFilter'
  | 'classes'
  | 'minMonths'
  | 'airport'
  | 'threshold'
  | 'relation'
  | 'month'
  | 'nationalTotal';

export interface ValidationMatch {
  source: ValidationSource;
  scope: string;
  row: ExternalRow | null;
  /** row for all months without the collection-gap month, for reference */
  reference: ExternalRow | null;
  japan: { month: string; tiers: string; observed_jp_domestic: number; reported_domestic_total: number; ratio: number } | null;
  usedThreshold: number | null;
  differences: Difference[];
}

const COUNTRY_SOURCE: Record<string, { source: ValidationSource; domestic: string; touching: string }> = {
  US: { source: 'BTS_T100_SEGMENT', domestic: 'US-domestic', touching: 'US-touching' },
  BR: { source: 'ANAC_DADOS_ESTATISTICOS', domestic: 'Brazil-domestic', touching: 'Brazil-touching' },
};

export function findValidation(config: ResearchConfig, rows: readonly ExternalRow[], quality: QualityFile): ValidationMatch | null {
  const common: Difference[] = [];
  if (config.carrier) common.push('carrierFilter');
  if (config.classes.length < 3) common.push('classes');
  if (config.minMonths > 0) common.push('minMonths');
  if (config.airport) common.push('airport');

  if (config.country === 'JP') {
    const japan = (quality.external.japan ?? []).find((r) => r.month === config.month && r.tiers === TIER_LABEL[config.tiers]) ?? null;
    const differences: Difference[] = ['nationalTotal', ...common];
    if (config.relation !== 'domestic') differences.push('relation');
    if (config.minFlights > 1) differences.push('threshold');
    if (!japan) differences.push('month');
    return { source: 'MLIT_AIR_TRANSPORT_FLASH', scope: 'Japan-domestic', row: null, reference: null, japan, usedThreshold: null, differences };
  }
  const spec = config.country ? COUNTRY_SOURCE[config.country] : undefined;
  if (!spec) return null;

  const differences: Difference[] = ['carrierMatched', ...common];
  const scope = config.relation === 'domestic' ? spec.domestic : spec.touching;
  if (config.relation === 'international') differences.push('relation');
  const exactThreshold = (VALIDATION_THRESHOLDS as readonly number[]).includes(config.minFlights);
  const usedThreshold = exactThreshold ? config.minFlights : [...VALIDATION_THRESHOLDS].reverse().find((v) => v <= config.minFlights) ?? 1;
  if (!exactThreshold) differences.push('threshold');
  const direction = config.directed ? 'directed' : 'undirected';
  const pick = (months: string) =>
    rows.find((r) => r.source === spec.source && r.scope === scope && r.months === months && r.tiers === TIER_LABEL[config.tiers]
      && r.direction === direction && r.min_flights === usedThreshold) ?? null;
  const row = pick(config.month);
  if (!row) differences.push('month');
  return { source: spec.source, scope, row, reference: pick('all_excl_2026-05'), japan: null, usedThreshold, differences };
}

/** Airport movements vs the official statistic for one month (null when not compared). */
export function airportValidation(quality: QualityFile, month: string, airportId: string) {
  return (quality.external.airports ?? [])
    .filter((r) => r[1] === month && r[2] === airportId)
    .map(([source, , , observed, reported]) => ({ source, observed, reported, ratio: reported ? observed / reported : null }));
}
