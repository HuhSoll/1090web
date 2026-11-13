/** Period helpers shared by Research panels (monthly or time-window analyses). */
import type { ResearchMeta } from './data';
import type { ResearchConfig } from './model';
import { formatUtc } from '../temporal/window';

/** Days with a Phase 6B collection gap that overlap [startMs, endMs). */
export function gapDaysIn(meta: ResearchMeta, startMs: number, endMs: number): string[] {
  return meta.quality.anomalies
    .filter((a) => a.evidence === 'collection_gap')
    .map((a) => a.day)
    .filter((d) => {
      const s = Date.parse(`${d}T00:00:00Z`);
      return s < endMs && s + 86_400_000 > startMs;
    });
}

/** Windows shorter than a day: many routes are simply not seen in such a short time. */
export const isShortWindow = (c: ResearchConfig) => c.window !== null && c.window.endMs - c.window.startMs < 86_400_000;

/** The analysed period as text: a "YYYY-MM" month (for monthLabel) or the UTC window. */
export function periodOf(c: ResearchConfig): string {
  return c.window ? `${formatUtc(c.window.startMs, false)} – ${formatUtc(c.window.endMs)}` : c.month;
}

/** File-name part for the period: "2026-03" or "2026-03-10T1200Z_2026-03-10T1800Z". */
export function periodSlug(c: ResearchConfig): string {
  const f = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(':', '') + 'Z';
  return c.window ? `${f(c.window.startMs)}_${f(c.window.endMs)}` : c.month;
}
