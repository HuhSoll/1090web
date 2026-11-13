/**
 * Time-window model (pure). Everything is UTC epoch milliseconds; strings are parsed and
 * formatted explicitly as UTC so the browser's time zone never shifts a day.
 *
 * Windows are half-open [start, end). A flight belongs to a window when its referenceTime
 * (track start, else track end) lies in it - see docs/temporal-data-model.md.
 */

import { DAY_MS } from './model';

export { DAY_MS };
export const HOUR_MS = 3_600_000;

export type WindowPreset = 'month' | 'day' | 'rolling7d' | 'rolling24h' | 'rolling6h' | 'rolling1h' | 'custom';
export const WINDOW_PRESETS: readonly WindowPreset[] = ['day', 'month', 'rolling7d', 'rolling24h', 'rolling6h', 'rolling1h', 'custom'];
export type TimeBasisFilter = 'all' | 'start';
export type PlaybackSpeed = 'slow' | 'normal' | 'fast';
/** Minimum time a frame stays on screen while playing; the next step also waits for its data. */
export const SPEED_MS: Record<PlaybackSpeed, number> = { slow: 2500, normal: 1200, fast: 500 };
export const STEPS_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS, 7 * DAY_MS] as const;
export type TemporalCompare = 'off' | 'previous' | 'day' | 'week';

export interface TemporalSelection {
  /** the selected instant (UTC ms) */
  cursorMs: number;
  preset: WindowPreset;
  /** only for 'custom' */
  customStartMs: number;
  customEndMs: number;
  stepMs: number;
  basis: TimeBasisFilter;
  speed: PlaybackSpeed;
  loop: boolean;
  compare: TemporalCompare;
}

export interface DataRange {
  /** first instant with data (inclusive) */
  startMs: number;
  /** end of the data (exclusive) */
  endMs: number;
}

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export function defaultSelection(range: DataRange): TemporalSelection {
  return {
    cursorMs: range.startMs,
    preset: 'day',
    customStartMs: range.startMs,
    customEndMs: range.startMs + DAY_MS,
    stepMs: DAY_MS,
    basis: 'all',
    speed: 'normal',
    loop: false,
    compare: 'off',
  };
}

const floorTo = (ms: number, unit: number) => Math.floor(ms / unit) * unit;

/** The window a selection describes, before clamping to the data. */
export function windowFor(sel: TemporalSelection): TimeWindow {
  const c = sel.cursorMs;
  switch (sel.preset) {
    case 'day': {
      const s = floorTo(c, DAY_MS);
      return { startMs: s, endMs: s + DAY_MS };
    }
    case 'month': {
      const d = new Date(c);
      return { startMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), endMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
    }
    case 'rolling7d':
      return { startMs: c - 7 * DAY_MS, endMs: c };
    case 'rolling24h':
      return { startMs: c - DAY_MS, endMs: c };
    case 'rolling6h':
      return { startMs: c - 6 * HOUR_MS, endMs: c };
    case 'rolling1h':
      return { startMs: c - HOUR_MS, endMs: c };
    case 'custom':
      return { startMs: sel.customStartMs, endMs: sel.customEndMs };
  }
}

/** Part of the window inside the data, and whether it was cut (null when nothing is left). */
export function clampWindow(w: TimeWindow, range: DataRange): { window: TimeWindow; clipped: boolean } | null {
  const startMs = Math.max(w.startMs, range.startMs);
  const endMs = Math.min(w.endMs, range.endMs);
  if (!(endMs > startMs)) return null;
  return { window: { startMs, endMs }, clipped: startMs !== w.startMs || endMs !== w.endMs };
}

/** Cursor bounds so that the window keeps at least some data. Rolling windows end at the cursor. */
export function cursorBounds(preset: WindowPreset, range: DataRange): { min: number; max: number } {
  const rolling = preset.startsWith('rolling');
  return { min: rolling ? range.startMs + HOUR_MS : range.startMs, max: rolling ? range.endMs : range.endMs - HOUR_MS };
}

export function clampCursor(ms: number, preset: WindowPreset, range: DataRange): number {
  const b = cursorBounds(preset, range);
  return Math.min(b.max, Math.max(b.min, ms));
}

/**
 * Moves the cursor by n steps. Returns null when the move leaves the data and `loop` is off;
 * with `loop` it wraps to the start.
 */
export function stepCursor(sel: TemporalSelection, n: number, range: DataRange): number | null {
  const b = cursorBounds(sel.preset, range);
  if (sel.preset === 'month') {
    const d = new Date(sel.cursorMs);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
    if (next >= b.min && next <= b.max) return next;
    return sel.loop ? b.min : null;
  }
  const next = sel.cursorMs + n * sel.stepMs;
  if (next >= b.min && next <= b.max) return next;
  if (sel.loop) return n > 0 ? b.min : b.max;
  return null;
}

/** A window of the same length placed earlier, for comparisons (null when off). */
export function compareWindow(w: TimeWindow, mode: TemporalCompare): TimeWindow | null {
  const len = w.endMs - w.startMs;
  const shift = mode === 'previous' ? len : mode === 'day' ? DAY_MS : mode === 'week' ? 7 * DAY_MS : 0;
  return shift ? { startMs: w.startMs - shift, endMs: w.endMs - shift } : null;
}

// ---- UTC text ------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-03-10 12:00 UTC" */
export function formatUtc(ms: number, withZone = true): string {
  const d = new Date(ms);
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withZone ? `${s} UTC` : s;
}

/** "2026-03-10" */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Compact URL/JSON form: "2026-03-10T12:00Z". */
export function toIsoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/**
 * Parses "YYYY-MM-DD", "YYYY-MM-DDTHH:MM" (with an optional ":SS" and "Z") as UTC.
 * Strings with another offset are rejected rather than converted.
 */
export function parseUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo! - 1 || back.getUTCDate() !== d! || h! > 23 || mi! > 59 || sec! > 59) return null;
  return ms;
}

/** Window length as hours / days for labels. */
export function windowLength(w: TimeWindow): { hours: number; days: number } {
  const h = (w.endMs - w.startMs) / HOUR_MS;
  return { hours: h, days: h / 24 };
}

/** Bin size for time series: hours up to 2 days, days otherwise. */
export function seriesBinMs(w: TimeWindow): number {
  return w.endMs - w.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
}

/**
 * One playback / button step as a selection patch. Fixed presets move the cursor (stepCursor);
 * a custom window is shifted as a whole by the step. Returns null at the edge of the data
 * unless `loop` is on (then it wraps to the start).
 */
export function stepSelection(sel: TemporalSelection, n: number, range: DataRange): Partial<TemporalSelection> | null {
  if (sel.preset !== 'custom') {
    const c = stepCursor(sel, n, range);
    return c === null ? null : { cursorMs: c };
  }
  const len = sel.customEndMs - sel.customStartMs;
  const start = sel.customStartMs + n * sel.stepMs;
  if (start >= range.startMs && start + len <= range.endMs) return { customStartMs: start, customEndMs: start + len };
  if (!sel.loop) return null;
  const s = n > 0 ? range.startMs : Math.max(range.startMs, range.endMs - len);
  return { customStartMs: s, customEndMs: s + len };
}

/** Default step for a preset (the step can still be changed independently). */
export function defaultStep(preset: WindowPreset): number {
  return preset === 'rolling24h' || preset === 'rolling6h' || preset === 'rolling1h' ? HOUR_MS : DAY_MS;
}
