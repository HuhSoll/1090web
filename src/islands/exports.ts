import type { Comparison, IslandScenario } from './model';

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per inhabited mesh: before / after access and the change. */
export function comparisonCsv(r: Comparison): string {
  const head = ['mesh', 'island', 'population_2020', 'status_before', 'time_before_min', 'status_after', 'time_after_min', 'change', 'board_before', 'board_after'];
  const lines = [head.join(',')];
  for (const [code, isl, pop, b, a, ch] of r.rows) {
    lines.push([code, isl, pop, b.status, b.time ?? '', a.status, a.time ?? '', ch, b.board ?? '', a.board ?? ''].map(cell).join(','));
  }
  return lines.join('\n');
}

/** Totals with every condition needed to read them. */
export function islandResultJson(r: Comparison, base: IslandScenario, after: IslandScenario, region: string, buildVersion: string): string {
  return JSON.stringify({
    format: '1090web-island-dependency',
    schemaVersion: 1,
    region,
    buildVersion,
    model: 'A (network availability; no timetable, waiting time not included)',
    units: { time: 'minutes (road at assumed speeds + assumed terminal and transfer times + scheduled in-vehicle time)', population: 'persons, 2020 census 250 m mesh' },
    conditions: { before: base, after },
    totals: r.totals,
    note: 'Not an estimate of travel demand or medical transport. Unreachable populations are counted separately and never averaged as a time.',
  }, null, 1);
}
