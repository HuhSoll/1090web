/**
 * Data-quality state of a time window, from the day index (world, unfiltered hourly counts) and
 * the aggregation result. The states are kept apart on purpose:
 *
 *   A zeroObserved  the data covers the window and no flight was observed
 *   B gap           part of the window lies in a suspected collection gap (missing observations,
 *                   not stopped traffic)
 *   C missingFile   a day of the window has no day file
 *   D loadFailed    day data could not be loaded
 *   E zeroFiltered  flights were observed, but none match the current filters
 *
 * More than one can apply (e.g. a gap and zero after filters).
 */
import { dayStartMs, type TemporalIndex } from './model';
import { HOUR_MS, type TimeWindow } from './window';

export type QualityFlag = 'zeroObserved' | 'gap' | 'missingFile' | 'loadFailed' | 'zeroFiltered';

/**
 * On a day the pipeline marked as a collection gap, an hour with fewer world flights than this
 * counts as a gap hour. Normal hours have about 2,500-5,000 flights worldwide.
 */
export const GAP_HOUR_MAX_FLIGHTS = 100;

export interface WindowQuality {
  flags: QualityFlag[];
  /** world flights in the hours the window touches (index, unfiltered, both time bases) */
  worldFlights: number;
  gapHours: number;
  gapDays: string[];
  missingDays: string[];
}

export interface QualityInput {
  /** flights after filters, null while unknown (loading / failed) */
  flights: number | null;
  /** days the aggregation could not find */
  missingDays?: readonly string[];
  failed?: boolean;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function windowQuality(index: TemporalIndex, w: TimeWindow, input: QualityInput): WindowQuality {
  const byDay = new Map(index.days.map((d) => [d.day, d]));
  const missing = new Set(input.missingDays ?? []);
  const gapDays = new Set<string>();
  let worldFlights = 0;
  let gapHours = 0;
  // every hour the window touches (a window not on hour boundaries counts its partial hours fully)
  const first = Math.floor(w.startMs / HOUR_MS) * HOUR_MS;
  for (let h = first; h < w.endMs; h += HOUR_MS) {
    const day = dayKey(h);
    const entry = byDay.get(day);
    if (!entry) {
      missing.add(day);
      continue;
    }
    const n = entry.hourly[Math.floor((h - dayStartMs(day)) / HOUR_MS)] ?? 0;
    worldFlights += n;
    if (entry.anomaly?.evidence === 'collection_gap' && n < GAP_HOUR_MAX_FLIGHTS) {
      gapHours++;
      gapDays.add(day);
    }
  }
  const flags: QualityFlag[] = [];
  if (input.failed) flags.push('loadFailed');
  if (missing.size > 0) flags.push('missingFile');
  if (gapHours > 0) flags.push('gap');
  if (!input.failed && input.flights === 0) {
    if (worldFlights === 0 && gapHours === 0 && missing.size === 0) flags.push('zeroObserved');
    else if (worldFlights > 0) flags.push('zeroFiltered');
  }
  return { flags, worldFlights, gapHours, gapDays: [...gapDays].sort(), missingDays: [...missing].sort() };
}

/** Days (YYYY-MM-DD) with a pipeline anomaly flag, for the timeline strip. */
export function anomalyDays(index: TemporalIndex): { day: string; startMs: number; evidence: string; direction: 'low' | 'high' }[] {
  return index.days
    .filter((d) => d.anomaly)
    .map((d) => ({ day: d.day, startMs: dayStartMs(d.day), evidence: d.anomaly!.evidence, direction: d.anomaly!.direction }));
}

/** For each series bin: true when the bin lies (partly) in a suspected collection gap hour. */
export function gapMask(index: TemporalIndex, startMs: number, binMs: number, bins: number): boolean[] {
  const byDay = new Map(index.days.map((d) => [d.day, d]));
  const isGapHour = (h: number) => {
    const day = dayKey(h);
    const e = byDay.get(day);
    if (!e) return true; // no data for that day at all
    return e.anomaly?.evidence === 'collection_gap' && (e.hourly[Math.floor((h - dayStartMs(day)) / HOUR_MS)] ?? 0) < GAP_HOUR_MAX_FLIGHTS;
  };
  const out: boolean[] = [];
  for (let i = 0; i < bins; i++) {
    const s = startMs + i * binMs;
    let gap = false;
    for (let h = Math.floor(s / HOUR_MS) * HOUR_MS; h < s + binMs && !gap; h += HOUR_MS) gap = isGapHour(h);
    out.push(gap);
  }
  return out;
}
