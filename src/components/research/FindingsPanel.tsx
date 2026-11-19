import { useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { openFinding, useFindings, VALIDATION_STATUSES, type Finding, type Text, type ValidationStatus } from '../../research/findings';

const STATUS_CLASS: Record<ValidationStatus, string> = {
  'Validated': 'rf-ok',
  'Conditionally Supported': 'rf-cond',
  'Preliminary': 'rf-pre',
  'Needs Review': 'rf-review',
  'Not Supported': 'rf-no',
};

/** Research findings (Phase 9I): claim, evidence, scope and validation status, linked to the analysis. */
export function FindingsPanel() {
  const { t, locale } = useI18n();
  const s = useFindings();
  const [status, setStatus] = useState<ValidationStatus | 'all'>('all');
  const [sel, setSel] = useState<string | null>(null);
  if (s.state === 'loading') return <p className="hint">{t('rf.loading')}</p>;
  if (s.state === 'error') return <p className="hint warn">{t('rf.error')} <span className="mono small">{s.message}</span></p>;
  const tx = (x: Text) => (locale === 'ja' ? x.ja : x.en);
  const list = s.findings.filter((f) => status === 'all' || f.validationStatus === status);
  const current = s.findings.find((f) => f.findingId === sel) ?? list[0] ?? null;
  return (
    <div className="rf">
      <section className="r-box">
        <h3 className="r-h4">{t('rf.title')}</h3>
        <p className="small">{t('rf.lead')}</p>
        <div className="rf-statuses" role="radiogroup" aria-label={t('rf.status')}>
          <button type="button" role="radio" aria-checked={status === 'all'} className={`pill-btn panel ${status === 'all' ? 'is-active' : ''}`} onClick={() => setStatus('all')}>{t('rf.all')} ({s.findings.length})</button>
          {VALIDATION_STATUSES.map((v) => {
            const n = s.findings.filter((f) => f.validationStatus === v).length;
            return <button key={v} type="button" role="radio" aria-checked={status === v} disabled={!n} className={`pill-btn panel ${status === v ? 'is-active' : ''}`} onClick={() => setStatus(v)} title={t(`rf.s.${v}.def` as MessageKey)}>{t(`rf.s.${v}` as MessageKey)} ({n})</button>;
          })}
        </div>
        {s.dropped.length > 0 && <p className="small r-warn-text">{t('rf.dropped', { ids: s.dropped.join(', ') })}</p>}
      </section>
      <div className="rf-split">
        <ul className="rf-list" aria-label={t('rf.title')}>
          {list.map((f) => (
            <li key={f.findingId}>
              <button type="button" className={`rf-item ${current?.findingId === f.findingId ? 'is-active' : ''}`} onClick={() => setSel(f.findingId)}>
                <span className={`badge ${STATUS_CLASS[f.validationStatus]}`}>{t(`rf.s.${f.validationStatus}` as MessageKey)}</span>
                <span className="rf-item-title">{tx(f.title)}</span>
              </button>
            </li>
          ))}
        </ul>
        {current && <FindingDetail f={current} tx={tx} />}
      </div>
      <p className="small x-dim">{t('rf.note', { d: s.file.updatedAt })}</p>
    </div>
  );
}

function FindingDetail({ f, tx }: { f: Finding; tx: (x: Text) => string }) {
  const { t } = useI18n();
  return (
    <article className="r-box rf-detail">
      <div className="rf-head">
        <span className={`badge ${STATUS_CLASS[f.validationStatus]}`}>{t(`rf.s.${f.validationStatus}` as MessageKey)}</span>
        <span className="mono small x-dim">{f.findingId}</span>
      </div>
      <h4 className="r-h4">{tx(f.title)}</h4>
      <p className="small x-dim">{t('rf.k.question')}: {tx(f.researchQuestion)}</p>
      <p>{tx(f.statement)}</p>
      <p className="small x-dim">{t(`rf.s.${f.validationStatus}.def` as MessageKey)}</p>
      <div className="rf-actions">
        <button type="button" className="primary-btn small" onClick={() => openFinding(f.link, tx(f.title))}>{t(`rf.open.${f.link.tab}` as MessageKey)}</button>
      </div>
      <h5 className="small">{t('rf.k.evidence')}</h5>
      <ul className="r-mini">{f.evidence.map((e, i) => <li key={i}>{tx(e)}</li>)}</ul>
      <h5 className="small">{t('rf.k.validation')}</h5>
      <p className="small">{tx(f.validation)}</p>
      {f.limitations.length > 0 && <>
        <h5 className="small">{t('rf.k.limitations')}</h5>
        <ul className="r-mini r-warn-text">{f.limitations.map((e, i) => <li key={i}>{tx(e)}</li>)}</ul>
      </>}
      <h5 className="small">{t('rf.k.conditions')}</h5>
      <div className="kv-row"><span>{t('rf.k.dataset')}</span><span className="mono small">{f.dataset.id} {f.dataset.version}</span></div>
      <div className="kv-row"><span>{t('rf.k.period')}</span><span className="mono small">{f.period.start} – {f.period.end}</span></div>
      <div className="kv-row"><span>{t('rf.k.method')}</span><span className="small">{tx(f.method)}</span></div>
      {Object.entries(f.conditions).map(([k, v]) => <div key={k} className="kv-row"><span className="mono small">{k}</span><span className="small">{v}</span></div>)}
      <div className="kv-row"><span>{t('rf.k.version')}</span><span className="mono small">{f.calculationVersion} · {t('rf.k.verified')} {f.lastVerifiedAt}</span></div>
      {f.relatedExperiments.length > 0 && <div className="kv-row"><span>{t('rf.k.experiments')}</span><span className="mono small">{f.relatedExperiments.join(', ')}</span></div>}
      <div className="kv-row"><span>{t('rf.k.reproduce')}</span><code className="small">{f.reproduce.command}</code></div>
      <div className="kv-row"><span>{t('rf.k.sources')}</span><span className="small">{f.sourceReferences.map((r) => r.label).join(' · ')}</span></div>
    </article>
  );
}
