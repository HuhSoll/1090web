import { useI18n } from '../../i18n/useI18n';
import type { ExternalRow, ResearchMeta } from '../../research/data';
import type { AnalysisResult } from '../../research/results';
import { airportValidation, findValidation, TIER_LABEL } from '../../research/validation';
import { useAppStore } from '../../state/store';
import { Note } from './common';
import { useFormat } from './format';

const NOTE_COUNTRIES = ['US', 'BR', 'JP'] as const;

export function ReliabilityPanel({ result, meta, focusAirport }: { result: AnalysisResult; meta: ResearchMeta; focusAirport: number | null }) {
  const { t, monthLabel, countryName, dateTime } = useI18n();
  const f = useFormat();
  const network = useAppStore((s) => s.network)!;
  const { config } = result;
  const q = meta.quality;
  const month = q.months.find((m) => m.month === config.month);
  const anomalies = q.anomalies.filter((a) => a.day.startsWith(config.month));
  const match = findValidation(config, meta.externalRows, q);
  const world = month ? Object.values(month.tiers).reduce((a, b) => a + b, 0) : 0;
  const region = config.region ?? (config.country ? q.continents[config.country] : null);
  const regionRow = region ? q.regions.find((r) => r.scope_type === 'continent' && r.scope_id === region && r.month === config.month) : null;
  const airportId = config.airport ?? (focusAirport !== null ? network.airports[focusAirport]!.id : null);
  const apVal = airportId ? airportValidation(q, config.month, airportId) : [];

  return (
    <div className="r-stack">
      <section className="r-box">
        <h4 className="r-h4">{t('r.rel.dataset')}</h4>
        <dl className="kv">
          <div className="kv-row"><dt>{t('r.rel.datasetId')}</dt><dd className="mono">{meta.manifest.datasetId} v{meta.manifest.datasetVersion}</dd></div>
          <div className="kv-row"><dt>{t('r.rel.period')}</dt><dd>{monthLabel(q.months[0]!.month)} – {monthLabel(q.months[q.months.length - 1]!.month)}</dd></div>
          <div className="kv-row"><dt>{t('r.rel.ruleset')}</dt><dd className="mono">{q.dataset.ruleset ?? '—'}</dd></div>
          <div className="kv-row"><dt>{t('r.rel.generated')}</dt><dd>{dateTime(q.dataset.generatedAt)}</dd></div>
          <div className="kv-row"><dt>{t('r.rel.commit')}</dt><dd className="mono">{q.dataset.commit?.slice(0, 7) ?? '—'}</dd></div>
        </dl>
        <details>
          <summary className="small">{t('r.rel.inputs')}</summary>
          <ul className="r-hashes">
            {q.dataset.inputs.map((i) => <li key={i.file}><span>{i.file}</span> <span className="mono">{i.sha256.slice(0, 16)}…</span></li>)}
          </ul>
        </details>
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('r.rel.month', { month: monthLabel(config.month) })}</h4>
        {month && (
          <dl className="kv">
            {(['T1', 'T2', 'T3', 'T4', 'X'] as const).map((k) => (
              <div className="kv-row" key={k}>
                <dt>{t(`r.tier.${k}`)}</dt>
                <dd>{f.int(month.tiers[k])} ({f.pct(world ? month.tiers[k] / world : null)})</dd>
              </div>
            ))}
          </dl>
        )}
        <Note>{t('r.rel.worldTiersNote')}</Note>
        {anomalies.length === 0 ? (
          <p className="small">{t('r.rel.noAnomalies')}</p>
        ) : (
          <ul className="r-mini">
            {anomalies.map((a) => (
              <li key={a.day}>
                <span>{a.day} · {t(`r.evidence.${a.evidence}` as 'r.evidence.collection_gap')} · {t(`r.scope.${a.scope}` as 'r.scope.global')}</span>
                <span className="num">{a.world_ratio !== null ? f.pct(a.world_ratio, 0) : '—'}</span>
              </li>
            ))}
          </ul>
        )}
        <Note>{t('r.rel.anomalyNote')}</Note>
      </section>

      {regionRow && (
        <section className="r-box">
          <h4 className="r-h4">{t('r.rel.region', { region: t(`r.region.${regionRow.scope_id}` as 'r.region.EU') })}</h4>
          <dl className="kv">
            <div className="kv-row"><dt>{t('r.tier.T1')}</dt><dd>{f.pct(regionRow.share_T1)}</dd></div>
            <div className="kv-row"><dt>{t('r.tier.T4')}</dt><dd>{f.pct(regionRow.share_T4)}</dd></div>
            <div className="kv-row"><dt>{t('r.rel.callsignEnds')}</dt><dd>{f.pct(regionRow.callsign_only_end_share)}</dd></div>
          </dl>
          <Note>{t('r.rel.regionNote')}</Note>
        </section>
      )}

      <section className="r-box">
        <h4 className="r-h4">{t('r.rel.external')}</h4>
        {!q.external.available && <p className="small">{t('r.rel.externalMissing')}</p>}
        {q.external.available && !match && <p className="small">{t('r.rel.unvalidated')}</p>}
        {match && match.japan && (
          <dl className="kv">
            <div className="kv-row"><dt>{t('r.rel.jpObserved')}</dt><dd>{f.int(match.japan.observed_jp_domestic)}</dd></div>
            <div className="kv-row"><dt>{t('r.rel.jpReported')}</dt><dd>{f.int(match.japan.reported_domestic_total)}</dd></div>
            <div className="kv-row"><dt>{t('r.rel.ratio')}</dt><dd>{f.dec(match.japan.ratio, 2)}</dd></div>
          </dl>
        )}
        {match && !match.japan && match.source !== 'MLIT_AIR_TRANSPORT_FLASH' && (
          <>
            <p className="small">{t(`r.rel.src.${match.source}` as 'r.rel.src.BTS_T100_SEGMENT')} · {match.scope} · {TIER_LABEL[config.tiers]} · {t(config.directed ? 'r.graph.directed' : 'r.graph.undirected')} · ≥{match.usedThreshold}</p>
            {match.row ? <ValidationTable row={match.row} /> : <p className="small">{t('r.rel.noMonth')}</p>}
            {match.reference && (
              <details>
                <summary className="small">{t('r.rel.reference')}</summary>
                <ValidationTable row={match.reference} />
              </details>
            )}
          </>
        )}
        {match && match.differences.length > 0 && (
          <Note warn>{t('r.rel.differences')} {match.differences.map((d) => t(`r.diff.${d}`)).join(' / ')}</Note>
        )}
        <Note>{t('r.rel.notAccuracy')}</Note>
        {apVal.length > 0 && airportId && (
          <div>
            <h5 className="r-h5">{t('r.rel.airport', { airport: airportId })}</h5>
            <ul className="r-mini">
              {apVal.map((v) => (
                <li key={v.source}><span>{t(`r.rel.src.${v.source}` as 'r.rel.src.BTS_T100_SEGMENT')}: {f.int(v.observed)} / {f.int(v.reported)}</span><span className="num">{f.dec(v.ratio, 2)}</span></li>
              ))}
            </ul>
            <Note>{t('r.rel.airportNote')}</Note>
          </div>
        )}
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('r.rel.notes')}</h4>
        <ul className="r-notes">
          {NOTE_COUNTRIES.map((c) => (
            <li key={c} className={config.country === c ? 'is-current' : undefined}><strong>{countryName(c)}</strong> — {t(`r.note.${c}`)}</li>
          ))}
          <li className={config.country && !(NOTE_COUNTRIES as readonly string[]).includes(config.country) ? 'is-current' : undefined}>{t('r.note.other')}</li>
        </ul>
        {q.external.sources && (
          <details>
            <summary className="small">{t('r.rel.sources')}</summary>
            <ul className="r-hashes">
              {Object.entries(q.external.sources).map(([k, v]) => (
                <li key={k}><span>{t(`r.rel.src.${k}` as 'r.rel.src.BTS_T100_SEGMENT')}</span> <span className="muted">{v.retrieved.join(', ')} · {v.files}</span></li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function ValidationTable({ row }: { row: ExternalRow }) {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <dl className="kv">
      <div className="kv-row"><dt>{t('r.val.found')}</dt><dd>{f.pct(row.share_reported_found)}</dd></div>
      <div className="kv-row"><dt>{t('r.val.confirmed')}</dt><dd>{f.pct(row.share_observed_confirmed)}</dd></div>
      <div className="kv-row"><dt>{t('r.val.wape')}</dt><dd>{f.pct(row.vol_WAPE)}</dd></div>
      <div className="kv-row"><dt>{t('r.val.bias')}</dt><dd>{f.signedPct(row.vol_bias)}</dd></div>
      <div className="kv-row"><dt>{t('r.val.spearman')}</dt><dd>{f.dec(row.vol_spearman, 3)}</dd></div>
      <div className="kv-row"><dt>{t('r.val.n')}</dt><dd>{f.int(row.vol_n)}</dd></div>
    </dl>
  );
}
