/**
 * Temporal selection <-> URL query parameters (all times UTC, minute precision):
 *   time=temporal&tc=2026-03-10T12:00Z&tw=rolling24h&ts=1h&tb=start&tcmp=previous&tsp=fast&tl=1
 *   custom windows: tw=custom&tcs=2026-03-10T18:00Z&tce=2026-03-11T06:00Z
 */
import {
  DAY_MS,
  HOUR_MS,
  parseUtc,
  toIsoMinute,
  WINDOW_PRESETS,
  type PlaybackSpeed,
  type TemporalCompare,
  type TemporalSelection,
  type WindowPreset,
} from './window';

const STEP_CODES: Record<string, number> = { '1h': HOUR_MS, '6h': 6 * HOUR_MS, '1d': DAY_MS, '7d': 7 * DAY_MS };

export function stepCode(ms: number): string {
  return Object.entries(STEP_CODES).find(([, v]) => v === ms)?.[0] ?? '1d';
}

export function selectionToParams(s: TemporalSelection, p: URLSearchParams): void {
  p.set('tc', toIsoMinute(s.cursorMs));
  if (s.preset !== 'day') p.set('tw', s.preset);
  if (s.preset === 'custom') {
    p.set('tcs', toIsoMinute(s.customStartMs));
    p.set('tce', toIsoMinute(s.customEndMs));
  }
  if (s.stepMs !== DAY_MS) p.set('ts', stepCode(s.stepMs));
  if (s.basis !== 'all') p.set('tb', s.basis);
  if (s.compare !== 'off') p.set('tcmp', s.compare);
  if (s.speed !== 'normal') p.set('tsp', s.speed);
  if (s.loop) p.set('tl', '1');
}

/** Reads what is present and valid; unknown values are ignored (defaults apply). */
export function selectionFromParams(p: URLSearchParams): Partial<TemporalSelection> {
  const out: Partial<TemporalSelection> = {};
  const c = parseUtc(p.get('tc') ?? '');
  if (c !== null) out.cursorMs = c;
  const tw = p.get('tw');
  if (tw && (WINDOW_PRESETS as readonly string[]).includes(tw)) out.preset = tw as WindowPreset;
  const cs = parseUtc(p.get('tcs') ?? '');
  const ce = parseUtc(p.get('tce') ?? '');
  if (cs !== null && ce !== null && ce > cs) {
    out.customStartMs = cs;
    out.customEndMs = ce;
  } else if (out.preset === 'custom') {
    delete out.preset;
  }
  const ts = STEP_CODES[p.get('ts') ?? ''];
  if (ts) out.stepMs = ts;
  if (p.get('tb') === 'start') out.basis = 'start';
  const cmp = p.get('tcmp');
  if (cmp === 'previous' || cmp === 'day' || cmp === 'week') out.compare = cmp as TemporalCompare;
  const sp = p.get('tsp');
  if (sp === 'slow' || sp === 'fast') out.speed = sp as PlaybackSpeed;
  if (p.get('tl') === '1') out.loop = true;
  return out;
}
