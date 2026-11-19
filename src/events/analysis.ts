/**
 * Event-study statistics on daily series (Phase 9G). Pure functions: the series come from the
 * temporal aggregator (group series), so the counting is the same as everywhere else in 1090web.
 *
 * Conventions
 * - Days are UTC days. The event day is the publication date of the advisory version (EASA gives
 *   a date in its local time, no hour), so the event day itself is a buffer and belongs to
 *   neither window by default: before = [E - n, E), after = [E + b, E + b + n) with b = 1 day.
 * - Windows are never filled in: a window that leaves the observed period is shortened and flagged.
 * - Nothing here is a causal effect. The comparison with the comparison group (a difference in
 *   differences of log means) is reported as a descriptive figure; its checks can fail to reject
 *   a pre-trend, but cannot show that the trends would have stayed parallel (Phase 9I).
 * - Daily flight counts are autocorrelated, so trend t values use a Newey-West (HAC) standard
 *   error; the plain OLS t is kept alongside (Phase 9I).
 */

export const DAY = 86_400_000;

export interface DailySeries {
  /** UTC ms of the first day */
  startMs: number;
  values: number[];
}

export interface StudyWindow {
  startMs: number;
  endMs: number;
  days: number;
  /** shortened because the data end (or start) inside it */
  truncated: boolean;
  /** number of each UTC weekday (0 = Sunday) in the window */
  weekdays: number[];
}

export interface WindowPair {
  eventDayMs: number;
  length: number;
  bufferDays: number;
  before: StudyWindow;
  after: StudyWindow;
  /** same weekday composition before and after */
  sameWeekdays: boolean;
}

export function utcDayMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function weekdayMix(startMs: number, endMs: number): number[] {
  const w = [0, 0, 0, 0, 0, 0, 0];
  for (let t = startMs; t < endMs; t += DAY) w[new Date(t).getUTCDay()]!++;
  return w;
}

function window(startMs: number, endMs: number, dataStart: number, dataEnd: number): StudyWindow {
  const s = Math.max(startMs, dataStart);
  const e = Math.min(endMs, dataEnd);
  const days = Math.max(0, Math.round((e - s) / DAY));
  return { startMs: s, endMs: Math.max(s, e), days, truncated: s !== startMs || e !== endMs, weekdays: weekdayMix(s, Math.max(s, e)) };
}

/** Before / after windows of `length` days around the event day, within the observed data. */
export function windowPair(eventDayMs: number, length: number, dataStartMs: number, dataEndMs: number, bufferDays = 1): WindowPair {
  const before = window(eventDayMs - length * DAY, eventDayMs, dataStartMs, dataEndMs);
  const aStart = eventDayMs + bufferDays * DAY;
  const after = window(aStart, aStart + length * DAY, dataStartMs, dataEndMs);
  return { eventDayMs, length, bufferDays, before, after, sameWeekdays: before.weekdays.every((v, i) => v === after.weekdays[i]) };
}

/** Values of the series inside [startMs, endMs), skipping excluded days (e.g. collection gaps). */
export function slice(s: DailySeries, startMs: number, endMs: number, exclude: ReadonlySet<number> = new Set()): { day: number; v: number }[] {
  const out: { day: number; v: number }[] = [];
  for (let t = startMs; t < endMs; t += DAY) {
    const i = Math.round((t - s.startMs) / DAY);
    if (i < 0 || i >= s.values.length || exclude.has(t)) continue;
    out.push({ day: t, v: s.values[i]! });
  }
  return out;
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

export interface BeforeAfter {
  beforeMean: number;
  afterMean: number;
  beforeDays: number;
  afterDays: number;
  /** after / before - 1 (null when before is 0) */
  change: number | null;
  /** log((after + 1) / (before + 1)) */
  logChange: number;
}

export function beforeAfter(s: DailySeries, w: WindowPair, exclude: ReadonlySet<number> = new Set()): BeforeAfter {
  const b = slice(s, w.before.startMs, w.before.endMs, exclude).map((x) => x.v);
  const a = slice(s, w.after.startMs, w.after.endMs, exclude).map((x) => x.v);
  const bm = mean(b);
  const am = mean(a);
  return { beforeMean: bm, afterMean: am, beforeDays: b.length, afterDays: a.length, change: bm > 0 ? am / bm - 1 : null, logChange: Math.log((am + 1) / (bm + 1)) };
}

export interface Trend {
  n: number;
  /** slope of log(y + 1) per day */
  slope: number;
  /** Newey-West (Bartlett kernel) standard error of the slope, lag `lag` (Phase 9I) */
  se: number;
  t: number;
  lag: number;
  /** ordinary OLS standard error and t (assume independent days; kept for comparison with 9G) */
  seOls: number;
  tOls: number;
  /** relative change implied over the window: exp(slope * (n - 1)) - 1 */
  impliedChange: number;
}

/** Lag of the Newey-West estimator: floor(4 (n / 100)^(2/9)) (Newey and West 1994 rule of thumb). */
export function neweyWestLag(n: number): number {
  return Math.floor(4 * (n / 100) ** (2 / 9));
}

/** Least squares of y on day index; t with a Newey-West (HAC) standard error and the plain OLS one. */
export function trend(y: number[]): Trend | null {
  const n = y.length;
  if (n < 5) return null;
  const x = y.map((_, i) => i);
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
  }
  const slope = sxy / sxx;
  const u = y.map((v, i) => v - (my + slope * (x[i]! - mx)));
  const sse = u.reduce((a, v) => a + v * v, 0);
  const seOls = Math.sqrt(sse / (n - 2) / sxx);
  // HAC variance of the slope: sum over lags of Bartlett-weighted autocovariances of (x - mx) u, / sxx^2
  const lag = neweyWestLag(n);
  const g = x.map((xi, i) => (xi - mx) * u[i]!);
  let s = g.reduce((a, v) => a + v * v, 0);
  for (let l = 1; l <= lag; l++) {
    let c = 0;
    for (let i = l; i < n; i++) c += g[i]! * g[i - l]!;
    s += 2 * (1 - l / (lag + 1)) * c;
  }
  const se = Math.sqrt(Math.max(0, s) * (n / (n - 2))) / sxx;
  const tOf = (e: number) => (e > 0 ? slope / e : slope === 0 ? 0 : Infinity);
  return { n, slope, se, t: tOf(se), lag, seOls, tOls: tOf(seOls), impliedChange: Math.exp(slope * (n - 1)) - 1 };
}

/** Trend of log(y + 1) in the before window: did the change start before the event? */
export function preTrend(s: DailySeries, w: WindowPair, exclude: ReadonlySet<number> = new Set()): Trend | null {
  return trend(slice(s, w.before.startMs, w.before.endMs, exclude).map((x) => Math.log(x.v + 1)));
}

/** Trend of log((target + 1) / (comparison + 1)) in the before window. */
export function ratioPreTrend(target: DailySeries, comp: DailySeries, w: WindowPair, exclude: ReadonlySet<number> = new Set()): Trend | null {
  const a = slice(target, w.before.startMs, w.before.endMs, exclude);
  const b = new Map(slice(comp, w.before.startMs, w.before.endMs, exclude).map((x) => [x.day, x.v]));
  return trend(a.filter((x) => b.has(x.day)).map((x) => Math.log((x.v + 1) / (b.get(x.day)! + 1))));
}

export interface PlaceboResult {
  /** placebo event days and their log change */
  placebos: { dayMs: number; logChange: number }[];
  actual: number;
  /** share of placebos whose |log change| is at least the actual one */
  shareAsLarge: number | null;
  /** placebo days looked at (every step back until the data run out) */
  tried: number;
  /** of those, left out because their after window would reach the event day */
  overlapping: number;
  /** placebos with |log change| at least the actual one */
  asLarge: number;
}

/**
 * The same before / after comparison on other days (no advisory). Placebo days are taken every
 * `stepDays` going back from the event, as long as both windows fit in the data and the placebo's
 * after window ends on or before the event day (so no day after the advisory enters a placebo).
 */
export function placebo(s: DailySeries, w: WindowPair, dataStartMs: number, dataEndMs: number, stepDays = 7, exclude: ReadonlySet<number> = new Set(), maxPlacebos = 12): PlaceboResult {
  const actual = beforeAfter(s, w, exclude).logChange;
  const out: { dayMs: number; logChange: number }[] = [];
  let tried = 0;
  let overlapping = 0;
  for (let k = 1; out.length < maxPlacebos; k++) {
    const d = w.eventDayMs - k * stepDays * DAY;
    const p = windowPair(d, w.length, dataStartMs, dataEndMs, w.bufferDays);
    if (p.before.truncated || p.before.startMs < dataStartMs) break;
    tried++;
    if (p.after.endMs > w.eventDayMs) { overlapping++; continue; } // would include the event
    out.push({ dayMs: d, logChange: beforeAfter(s, p, exclude).logChange });
  }
  const large = out.filter((p) => Math.abs(p.logChange) >= Math.abs(actual)).length;
  return { placebos: out, actual, shareAsLarge: out.length ? large / out.length : null, tried, overlapping, asLarge: large };
}

export interface DidResult {
  /**
   * The log difference when every check passes, else null. Kept for the saved JSON of Phase 9G;
   * since Phase 9I it is shown as a descriptive figure either way, never as an effect.
   */
  estimate: number | null;
  /** log change of the target minus log change of the comparison group */
  logDifference: number;
  conditions: { id: string; ok: boolean; detail: string }[];
  /** always 'descriptive' (Phase 9I) */
  interpretation: 'descriptive';
  /** log change of the comparison group itself (it can be touched by the same crisis) */
  comparisonLogChange: number;
  /** target / comparison daily mean in the before window (level difference) */
  levelRatioBefore: number | null;
  /** the same difference on the placebo days (same estimator as the actual one) */
  placebos: number[];
}

/**
 * Difference in differences of log daily means. `estimate` stays null unless: both windows are
 * complete and at least 14 days, the weekdays match, no excluded (gap) day falls in a window,
 * the comparison group has at least `minComparison` flights a day, the pre-period trend of the
 * log ratio is not distinguishable from zero (|t| < 2), and at least 3 placebos exist on which
 * the same difference is smaller than the actual one. Passing these does not prove parallel
 * trends; the UI says so.
 */
export function differenceInDifferences(
  target: DailySeries, comp: DailySeries, w: WindowPair, dataStartMs: number, dataEndMs: number,
  gaps: ReadonlySet<number> = new Set(), minComparison = 30,
): DidResult {
  const bt = beforeAfter(target, w);
  const bc = beforeAfter(comp, w);
  const diff = bt.logChange - bc.logChange;
  const rt = ratioPreTrend(target, comp, w);
  const gapIn = [...gaps].some((g) => (g >= w.before.startMs && g < w.before.endMs) || (g >= w.after.startMs && g < w.after.endMs));
  // placebos with the same estimator as the actual figure (difference of log means). Phase 9G used
  // the mean of daily log ratios here, a different quantity from the one it was compared with.
  const pl: number[] = [];
  for (let k = 1; pl.length < 12; k++) {
    const p = windowPair(w.eventDayMs - k * 7 * DAY, w.length, dataStartMs, dataEndMs, w.bufferDays);
    if (p.before.truncated) break;
    if (p.after.endMs > w.eventDayMs) continue;
    pl.push(beforeAfter(target, p).logChange - beforeAfter(comp, p).logChange);
  }
  const conditions = [
    { id: 'complete', ok: !w.before.truncated && !w.after.truncated && w.length >= 14, detail: `${w.before.days} / ${w.after.days} days` },
    { id: 'weekdays', ok: w.sameWeekdays, detail: w.sameWeekdays ? 'same' : 'different' },
    { id: 'gaps', ok: !gapIn, detail: gapIn ? 'collection gap in a window' : 'none' },
    { id: 'comparisonSize', ok: bc.beforeMean >= minComparison, detail: `${bc.beforeMean.toFixed(1)} flights / day` },
    { id: 'preTrend', ok: rt !== null && Math.abs(rt.t) < 2, detail: rt ? `t = ${rt.t.toFixed(2)}` : 'too few days' },
    { id: 'placebo', ok: pl.length >= 3 && pl.every((x) => Math.abs(x) < Math.abs(diff)), detail: `${pl.length} placebos, max |${Math.max(0, ...pl.map(Math.abs)).toFixed(3)}|` },
  ];
  return {
    estimate: conditions.every((c) => c.ok) ? diff : null, logDifference: diff, conditions, interpretation: 'descriptive',
    comparisonLogChange: bc.logChange, levelRatioBefore: bc.beforeMean > 0 ? bt.beforeMean / bc.beforeMean : null, placebos: pl,
  };
}

/** A daily series of `n` days starting at `startMs` from bins of the aggregator (bin = 1 day). */
export function daily(startMs: number, values: number[]): DailySeries {
  return { startMs, values };
}
