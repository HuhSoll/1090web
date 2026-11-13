import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { Icon } from '../components/common/Icon';
import { Logo } from '../components/common/Logo';
import { Sidebar } from '../components/layout/Sidebar';
import { Timeline } from '../components/layout/Timeline';
import { TemporalTimeline } from '../components/layout/TemporalTimeline';
import { useTemporal } from '../temporal/useTemporal';
import { TopBar } from '../components/layout/TopBar';
import { InfoPanel } from '../components/panels/InfoPanel';
import { CompareLegend } from '../components/panels/ComparePanels';
import { SourcesDialog } from '../components/panels/SourcesDialog';
import { Tooltip } from '../components/common/Tooltip';
import { useI18n } from '../i18n/useI18n';
import { useAppStore } from '../state/store';
import { useComparison, useDataset, useNetworkView } from './useDataset';
import { useUrlState } from './urlState';
import { useAdvisoryLoader } from './useAdvisories';

// The map renderer (three.js, d3-geo, topojson) is the bulk of the bundle. Loading it as a
// separate chunk lets the panels render immediately while WebGL code downloads.
const GlobeView = lazy(() => import('../components/globe/GlobeView').then((m) => ({ default: m.GlobeView })));
// Research Mode is loaded only when opened.
const ResearchView = lazy(() => import('../components/research/ResearchView').then((m) => ({ default: m.ResearchView })));

export function App() {
  const { retry } = useDataset();
  useUrlState();
  useAdvisoryLoader();
  const temporalMeta = useTemporal();
  const exploreTime = useAppStore((s) => s.exploreTime);
  const view = useNetworkView();
  const comparison = useComparison();
  const { t, number, locale } = useI18n();
  const status = useAppStore((s) => s.status);
  const kind = useAppStore((s) => s.network?.manifest.kind);
  const stress = useAppStore((s) => s.stressRouteCount);
  const basemapError = useAppStore((s) => s.basemapError);
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const appMode = useAppStore((s) => s.appMode);
  const mapNote = useAppStore((s) => s.researchMapNote);
  const setMapNote = useAppStore((s) => s.setResearchMapNote);
  const research = appMode === 'research';

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Escape clears the selection (route first, then airport).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const st = useAppStore.getState();
      if (st.sourcesOpen || st.appMode === 'research') return;
      if (st.drawerOpen) {
        st.setDrawerOpen(false);
        return;
      }
      if (st.selectedRoute !== null) st.selectRoute(null);
      else if (st.selectedAirport !== null) st.selectAirport(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${exploreTime === 'temporal' && !research ? 'is-temporal' : ''}`}>
      <div className="backdrop" aria-hidden="true" />
      <main className="stage">
        <ErrorBoundary
          fallback={() => (
            <div className="globe-fallback" role="alert">
              <h2>{t('app.mapLoadError')}</h2>
              {/* React caches a failed lazy import, so a reload is the reliable retry. */}
              <button type="button" className="primary-btn" onClick={() => window.location.reload()}>
                {t('app.error.retry')}
              </button>
            </div>
          )}
        >
          <Suspense fallback={<div className="globe-fallback"><div className="spinner" aria-hidden="true" /></div>}>
            <GlobeView view={view} comparison={comparison} />
          </Suspense>
        </ErrorBoundary>
      </main>

      {research && (
        <ErrorBoundary fallback={() => <div className="globe-fallback" role="alert"><h2>{t('r.loadError')}</h2></div>}>
          <Suspense fallback={<div className="overlay" role="status"><div className="spinner" aria-hidden="true" /></div>}>
            <ResearchView />
          </Suspense>
        </ErrorBoundary>
      )}

      {!research && (kind === 'demo' || stress !== null) && (
        <div className="banner" role="note">
          <span className="badge warn-badge">{stress !== null ? t('stress.badge') : t('demo.badge')}</span>
          <span>{stress !== null ? t('stress.banner', { count: number(stress) }) : t('demo.banner')}</span>
        </div>
      )}
      {!research && kind === 'observed' && stress === null && (
        <div className="banner banner-info" role="note">
          <span className="badge info-badge">{t('observed.badge')}</span>
          <span>{t('observed.banner')}</span>
        </div>
      )}

      {/* Mobile only: compact header that opens the sidebar as a drawer. */}
      {!research && <div className="mobile-bar">
        <button
          type="button"
          className="icon-btn"
          aria-label={t('drawer.open')}
          aria-expanded={drawerOpen}
          aria-controls="sidebar"
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <Logo />
      </div>}
      {!research && drawerOpen && <div className="drawer-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
      {!research && <Sidebar view={view} />}
      {!research && <InfoPanel view={view} comparison={comparison} />}
      {!research && comparison && <CompareLegend comparison={comparison} />}
      <TopBar />
      {!research && (exploreTime === 'temporal' ? <TemporalTimeline meta={temporalMeta} /> : <Timeline />)}
      {!research && <Tooltip view={view} />}
      <SourcesDialog />
      {!research && mapNote && (
        <button type="button" className="toast r-map-toast" onClick={() => setMapNote(null)}>
          {mapNote} <span className="muted">({t('r.map.dismiss')})</span>
        </button>
      )}

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
