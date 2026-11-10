import { useEffect } from 'react';
import { GlobeView } from '../components/globe/GlobeView';
import { Sidebar } from '../components/layout/Sidebar';
import { Timeline } from '../components/layout/Timeline';
import { TopBar } from '../components/layout/TopBar';
import { InfoPanel } from '../components/panels/InfoPanel';
import { SourcesDialog } from '../components/panels/SourcesDialog';
import { Tooltip } from '../components/common/Tooltip';
import { useI18n } from '../i18n/useI18n';
import { useAppStore } from '../state/store';
import { useDataset, useNetworkView } from './useDataset';

export function App() {
  const { retry } = useDataset();
  const view = useNetworkView();
  const { t, number, locale } = useI18n();
  const status = useAppStore((s) => s.status);
  const kind = useAppStore((s) => s.network?.manifest.kind);
  const stress = useAppStore((s) => s.stressRouteCount);
  const basemapError = useAppStore((s) => s.basemapError);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Escape clears the selection (route first, then airport).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const st = useAppStore.getState();
      if (st.sourcesOpen) return;
      if (st.selectedRoute !== null) st.selectRoute(null);
      else if (st.selectedAirport !== null) st.selectAirport(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />
      <main className="stage">
        <GlobeView view={view} />
      </main>

      {(kind === 'demo' || stress !== null) && (
        <div className="banner" role="note">
          <span className="badge warn-badge">{stress !== null ? t('stress.badge') : t('demo.badge')}</span>
          <span>{stress !== null ? t('stress.banner', { count: number(stress) }) : t('demo.banner')}</span>
        </div>
      )}

      <Sidebar view={view} />
      <InfoPanel view={view} />
      <TopBar />
      <Timeline />
      <Tooltip view={view} />
      <SourcesDialog />

      {basemapError && (
        <div className="toast" role="status">
          {t('app.basemapError')}
        </div>
      )}

      {status.state === 'loading' && (
        <div className="overlay" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>{t('app.loading')}</span>
        </div>
      )}
      {status.state === 'error' && (
        <div className="overlay" role="alert">
          <div className="overlay-card panel">
            <h2>{t('app.error.title')}</h2>
            <p className="muted small mono">{status.message}</p>
            <button type="button" className="primary-btn" onClick={retry}>
              {t('app.error.retry')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
