import { LOCALES } from '../../i18n/messages';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';
import { openSimulation } from '../../simulation/start';

export function TopBar() {
  const { t, locale } = useI18n();
  const setLocale = useAppStore((s) => s.setLocale);
  const setSourcesOpen = useAppStore((s) => s.setSourcesOpen);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const appMode = useAppStore((s) => s.appMode);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const ready = useAppStore((s) => s.network !== null && s.stressRouteCount === null);
  const observed = useAppStore((s) => s.network?.manifest.kind === 'observed' && s.stressRouteCount === null);
  const simOpen = useAppStore((s) => s.simOpen);
  const setSimOpen = useAppStore((s) => s.setSimOpen);
  return (
    <div className="topbar">
      <div className="segmented panel lang" role="radiogroup" aria-label={t('mode.label')}>
        {(['explore', 'research'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={appMode === m} className={appMode === m ? 'is-active' : ''} disabled={m === 'research' && !ready} onClick={() => setAppMode(m)}>
            {t(m === 'explore' ? 'mode.explore' : 'mode.research')}
          </button>
        ))}
      </div>
      {appMode === 'explore' && observed && (
        <button type="button" className={`pill-btn panel ${simOpen ? 'is-active' : ''}`} aria-pressed={simOpen} onClick={() => (simOpen ? setSimOpen(false) : openSimulation())}>
          {t('sim.open')}
        </button>
      )}
      <button type="button" className="pill-btn panel" onClick={() => setSourcesOpen(true)} aria-label={t('source.open')}>
        <Icon name="info" size={14} />
        <span className="pill-label">{t('source.open')}</span>
      </button>
      {appMode === 'explore' && <div className="segmented panel lang" role="radiogroup" aria-label={t('view.label')}>
        {(['flat', 'globe'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={viewMode === m} className={viewMode === m ? 'is-active' : ''} onClick={() => setViewMode(m)}>
            {t(m === 'flat' ? 'view.flat' : 'view.globe')}
          </button>
        ))}
      </div>}
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
