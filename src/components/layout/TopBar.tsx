import { LOCALES } from '../../i18n/messages';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

export function TopBar() {
  const { t, locale } = useI18n();
  const setLocale = useAppStore((s) => s.setLocale);
  const setSourcesOpen = useAppStore((s) => s.setSourcesOpen);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  return (
    <div className="topbar">
      <button type="button" className="pill-btn panel" onClick={() => setSourcesOpen(true)} aria-label={t('source.open')}>
        <Icon name="info" size={14} />
        <span className="pill-label">{t('source.open')}</span>
      </button>
      <div className="segmented panel lang" role="radiogroup" aria-label={t('view.label')}>
        {(['flat', 'globe'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={viewMode === m} className={viewMode === m ? 'is-active' : ''} onClick={() => setViewMode(m)}>
            {t(m === 'flat' ? 'view.flat' : 'view.globe')}
          </button>
        ))}
      </div>
      <div className="segmented panel lang" role="radiogroup" aria-label={t('lang.label')}>
        {LOCALES.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={locale === l} className={locale === l ? 'is-active' : ''} onClick={() => setLocale(l)} lang={l}>
            {l === 'ja' ? '日本語' : 'EN'}
          </button>
        ))}
      </div>
    </div>
  );
}
