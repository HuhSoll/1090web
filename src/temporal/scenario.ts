/**
 * Data flow of the temporal explorer and the place reserved for scenarios (Phase 9C+):
 *
 *   Temporal data (day files)
 *     -> window selection (TemporalSelection -> TimeWindow, UTC, [start, end))
 *     -> observed network (WindowAggregator -> MonthData / ResearchMonth)
 *     -> [scenario transform: not implemented]
 *     -> analysis (computeNetworkView / Research metrics)
 *     -> visualisation (map, globe, panels)
 *
 * Only types are defined here. No event is loaded or shown in Phase 9B, and the app ships no
 * events: a real event needs a source; a made-up one must carry isHypothetical = true.
 */

/** An advisory restricts or warns; a closure removes capacity. They are not interchangeable. */
export type ScenarioEventType = 'airspace_advisory' | 'airspace_closure' | 'airport_closure' | 'route_suspension';

export interface ScenarioEvent {
  eventId: string;
  eventType: ScenarioEventType;
  /** ISO 8601 UTC */
  startTime: string;
  /** ISO 8601 UTC, exclusive; null = open-ended */
  endTime: string | null;
  /** airport ids (ICAO-like codes of the dataset) */
  affectedAirports: string[];
  /** route keys "A-B" (undirected airport id pairs) */
  affectedRoutes: string[];
  /** publisher / document (e.g. a NOTAM or an official notice) */
  source: string;
  sourceUrl: string | null;
  /** true for user-made "what if" events; such events are never shown as observed facts */
  isHypothetical: boolean;
}

/** Whether an event is in effect at some point of [startMs, endMs). */
export function eventOverlaps(e: ScenarioEvent, startMs: number, endMs: number): boolean {
  const s = Date.parse(e.startTime);
  const end = e.endTime === null ? Number.POSITIVE_INFINITY : Date.parse(e.endTime);
  return Number.isFinite(s) && s < endMs && end > startMs;
}

/** An advisory never removes routes; only closures / suspensions may (in a future transform). */
export const removesCapacity = (e: ScenarioEvent) => e.eventType !== 'airspace_advisory';
