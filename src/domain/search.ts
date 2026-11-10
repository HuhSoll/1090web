import type { Airport } from '../data/model/network';

const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/**
 * Ranks airports for a free-text query. Exact IATA/ICAO codes rank first, then prefix matches
 * on code/city/name, then substring matches. Pure function: easy to test and to move into a
 * Web Worker if the airport table grows large.
 */
export function searchAirports(airports: readonly Airport[], query: string, limit = 8): Airport[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { a: Airport; score: number }[] = [];
  for (const a of airports) {
    const iata = (a.iata ?? '').toLowerCase();
    const icao = (a.icao ?? '').toLowerCase();
    const city = normalize(a.city);
    const name = normalize(a.name);
    let score = 0;
    if (iata === q || icao === q) score = 100;
    else if (iata.startsWith(q) || icao.startsWith(q)) score = 60;
    else if (city.startsWith(q)) score = 50;
    else if (name.startsWith(q)) score = 45;
    else if (city.includes(q) || name.includes(q)) score = 20;
    if (score > 0) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name));
  return scored.slice(0, limit).map((s) => s.a);
}
