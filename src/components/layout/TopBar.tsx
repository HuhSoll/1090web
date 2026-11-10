import { LOCALES } from '../../i18n/messages';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

export function TopBar() {
  const { t, locale } = useI18n();
  const setLocale = useAppStore((s) => s.setLocale);
  const setSourcesOpen = useAppStore((s) => s.setSourcesOpen);
  return (
    <div className="topbar">
      <button type="button" className="pill-btn panel" onClick={() => setSourcesOpen(true)}>
        <Icon name="info" size={14} />
        <span>{t('source.open')}</span>
      </button>
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
