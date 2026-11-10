import type { Advisory } from '../data/model/advisory';

/** First and last calendar day of a "YYYY-MM" month, as YYYY-MM-DD strings. */
export function monthBounds(ym: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` };
}

/** Advisories in effect at any time during the month (ISO date strings compare lexically). */
export function advisoriesInMonth(items: readonly Advisory[], ym: string): Advisory[] {
  const b = monthBounds(ym);
  if (!b) return [];
  return items.filter((a) => (a.issued ?? '0000') <= b.end && (a.end === null || a.end >= b.start));
}

/** ISO numeric codes of countries touched by the given advisories (for the map tint). */
export function advisoryCountryCodes(items: readonly Advisory[]): string[] {
  return [...new Set(items.flatMap((a) => a.countries.map((c) => c.isoNumeric)))];
}

/** Advisories that mention a country (ISO alpha-2). */
export function advisoriesForCountry(items: readonly Advisory[], iso2: string): Advisory[] {
  return items.filter((a) => a.countries.some((c) => c.iso2 === iso2));
}
