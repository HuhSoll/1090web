import { useRef, useState } from 'react';
import { periodSlug } from '../../research/periods';
import { useI18n } from '../../i18n/useI18n';
import type { ResearchMeta } from '../../research/data';
import { changedFields, configHash, type ResearchConfig } from '../../research/model';
import {
  airportScores,
  airportsCsv,
  analysisDocument,
  areaCsv,
  importDocument,
  routesCsv,
  summaryCsv,
  toCsv,
  type AnalysisResult,
} from '../../research/results';
import { compareRankings } from '../../research/stats';
import { configContext } from '../../research/useResearch';
import { useAppStore } from '../../state/store';
import { Note } from './common';
import { downloadText } from './format';

export function ExportPanel({ result, meta, other }: { result: AnalysisResult; meta: ResearchMeta; other: AnalysisResult | null }) {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network)!;
  const setConfig = useAppStore((s) => s.setResearchConfig);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `1090web_${periodSlug(result.config)}_${result.hash}`;

  const comparisonCsv = () => {
    if (!other) return '';
    const c = compareRankings(airportScores(result, 'degree'), airportScores(other, 'degree'), 20);
    const id = (i: number) => network.airports[i]!.id;
    return toCsv(['config_hash_a', 'config_hash_b', 'changed', 'metric', 'airport', 'rank_a', 'rank_b', 'rank_change', 'value_a', 'value_b',
      'spearman_union_top20', 'kendall_union_top20', 'jaccard_top20'],
    c.rows.map((r) => [result.hash, other.hash, changedFields(result.config, other.config).join(';'), 'degree', id(r.key), r.rankRef, r.rankOther,
      r.rankChange, r.scoreRef, r.scoreOther, c.spearman, c.kendall, c.jaccard]));
  };

  const doc = () =>
    analysisDocument(result, meta, other ? { config: other.config, configHash: other.hash, changed: changedFields(result.config, other.config) } : undefined);

  const onImport = async (file: File) => {
    const text = await file.text();
    const r = importDocument(text, meta, configContext(network));
    if (!r.config) {
      setImportMsg({ ok: false, lines: r.errors.map((e) => t(`r.imp.${e}` as 'r.imp.invalid_json')) });
      return;
    }
    setConfig(r.config as ResearchConfig);
    setImportMsg({ ok: true, lines: [t('r.imp.applied', { hash: configHash(r.config) }), ...r.warnings.map((w) => (w.startsWith('dropped:') ? t('r.imp.dropped', { fields: w.slice(8) }) : t(`r.imp.${w}` as 'r.imp.hash_mismatch')))] });
  };

  return (
    <div className="r-stack">
      <section className="r-box">
        <h4 className="r-h4">{t('r.exp.title')}</h4>
        <p className="hint">{t('r.exp.hash', { hash: result.hash, version: meta.manifest.datasetVersion ?? '—' })}</p>
        <div className="r-buttons">
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_airports.csv`, airportsCsv(result, network, meta))}>{t('r.exp.airports')}</button>
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_routes.csv`, routesCsv(result, network, meta))}>{t('r.exp.routes')}</button>
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_countries.csv`, areaCsv(result, meta, result.countries))}>{t('r.exp.countries')}</button>
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_regions.csv`, areaCsv(result, meta, result.regions))}>{t('r.exp.regions')}</button>
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_summary.csv`, summaryCsv(result, meta))}>{t('r.exp.summary')}</button>
          <button type="button" className="pill-btn panel" disabled={!other} onClick={() => downloadText(`${base}_comparison.csv`, comparisonCsv())}>{t('r.exp.comparison')}</button>
          <button type="button" className="pill-btn panel" onClick={() => downloadText(`${base}_conditions.json`, `${JSON.stringify(doc(), null, 1)}\n`, 'application/json')}>{t('r.exp.json')}</button>
        </div>
        <Note>{t('r.exp.note')}</Note>
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('r.imp.title')}</h4>
        <input ref={fileRef} type="file" accept="application/json,.json" className="r-file" onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImport(file);
          e.target.value = '';
        }} />
        {importMsg && (
          <ul className={importMsg.ok ? 'r-mini' : 'r-mini r-warn-text'}>
            {importMsg.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
        <Note>{t('r.imp.note')}</Note>
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('r.share.title')}</h4>
        <button type="button" className="pill-btn panel" onClick={() => {
          void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
        }}>{copied ? t('r.share.copied') : t('r.share.copy')}</button>
        <Note>{t('r.share.note')}</Note>
      </section>
    </div>
  );
}
