import { useActiveAdvisories } from '../../app/useAdvisories';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';

/**
 * Sidebar section for the safety-advisory overlay. Only data that exists is offered: today that
 * is EASA conflict-zone bulletins (safety warnings). Other kinds are stated as not shown rather
 * than offered as inactive controls.
 */
export function AdvisoryPanel() {
  const { t, monthLabel, locale } = useI18n();
  const enabled = useAppStore((s) => s.advisoriesEnabled);
  const setEnabled = useAppStore((s) => s.setAdvisoriesEnabled);
  const status = useAppStore((s) => s.advisoriesStatus);
  const source = useAppStore((s) => s.advisories?.source);
  const month = useAppStore((s) => s.month?.month);
  const stress = useAppStore((s) => s.stressRouteCount);
  const active = useActiveAdvisories();

  const fmt = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
  const date = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : '');

  if (stress !== null) return null;

  return (
    <section className="section" aria-labelledby="advisory-title">
      <h2 id="advisory-title" className="section-title">
        {t('advisory.title')}
      </h2>
      <label className="toggle-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>{t('advisory.toggle')}</span>
      </label>
      <p className="hint">{t('advisory.note')}</p>

      {enabled && status === 'loading' && <p className="hint">{t('advisory.loading')}</p>}
      {enabled && status === 'error' && <p className="hint warn">{t('advisory.error')}</p>}
      {enabled && status === 'ready' && month && (
        <>
          <p className="field-label">
            {active.length > 0
              ? t('advisory.inMonth', { count: active.length, month: monthLabel(month) })
              : t('advisory.none', { month: monthLabel(month) })}
          </p>
          <ul className="advisory-list">
            {active.map((a) => (
              <li key={a.id}>
                <div className="advisory-head">
                  <span className="badge advisory-badge">{t('advisory.kindSafety')}</span>
                  <span className="advisory-title" lang="en">
                    {a.title}
                  </span>
                </div>
                <span className="muted small">
                  {t('advisory.period', { start: date(a.issued), end: a.end ? date(a.end) : t('advisory.ongoing') })}
                </span>
                {a.partialArea && <span className="muted tiny">{t('advisory.partial')}</span>}
                {a.endIsApproximate && <span className="muted tiny">{t('advisory.approxEnd')}</span>}
              </li>
            ))}
          </ul>
          {active.length > 0 && <p className="muted tiny">{t('advisory.titles')}</p>}
          {source && (
            <a className="link-btn" href={source.url} target="_blank" rel="noreferrer">
              {t('advisory.openSource')} ↗
            </a>
          )}
        </>
      )}
      <p className="muted tiny">{t('advisory.notShown')}</p>
    </section>
  );
}
