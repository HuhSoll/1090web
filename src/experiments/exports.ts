/** Experiment result exports and the stability class (pure; shared by the views and tests). */
import type { AirportRow, ExperimentResult } from './model';

type Key = 'systemic' | 'spillover';

/** Rank range (p05..p95) that still counts as stable: 3 places, or a quarter of the reference rank. */
export function stability(a: AirportRow, key: Key): 'stable' | 'variable' {
  const s = a[`${key}RankStats`] as AirportRow['systemicRankStats'];
  const ref = key === 'systemic' ? a.ref.rankSystemic : a.ref.rankSpillover;
  if (s.p05 === null || s.p95 === null) return 'stable';
  return s.p95 - s.p05 <= Math.max(3, 0.25 * ref) ? 'stable' : 'variable';
}


const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** One row per run x airport (same columns as the Python runner's rankings.csv). */
export function rankingsCsv(r: ExperimentResult): string {
  const lines = ['definition_hash,run_id,run_label,airport_id,iata,systemic_drop,spillover_drop,rank_systemic,rank_spillover,exact,sources'];
  r.runs.forEach((x, j) => {
    for (const a of r.airports) {
      lines.push([r.definitionHash, x.runId, q(x.label), a.id, a.iata ?? '', a.runs.systemic[j], a.runs.spillover[j], a.runs.rankSystemic[j], a.runs.rankSpillover[j], x.exact, x.sources].join(','));
    }
  });
  return `${lines.join('\n')}\n`;
}

export function statsCsv(r: ExperimentResult): string {
  const k0 = r.definition.topK;
  const head = ['definition_hash', 'airport_id', 'iata', 'continent', 'metric', 'ref_value', 'ref_rank', 'mean', 'median', 'sd', 'p05', 'p25', 'p75', 'p95', 'rank_median', 'rank_p05', 'rank_p95', ...k0.map((k) => `top${k}_share`), 'stability'];
  const lines = [head.join(',')];
  for (const a of r.airports) {
    for (const key of ['systemic', 'spillover'] as const) {
      const s = a[`${key}Stats`] as AirportRow['systemicStats'];
      const rs = a[`${key}RankStats`] as AirportRow['systemicRankStats'];
      lines.push([r.definitionHash, a.id, a.iata ?? '', a.continent, key, a.runs[key][0], key === 'systemic' ? a.ref.rankSystemic : a.ref.rankSpillover,
        s.mean, s.median, s.sd, s.p05, s.p25, s.p75, s.p95, rs.median, rs.p05, rs.p95, ...k0.map((k) => a[`${key}Top${k}Share`]), stability(a, key)].map((v) => v ?? '').join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}
