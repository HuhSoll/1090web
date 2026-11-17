import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { exploreFiltersFor } from '../../research/mapLink';
import { defaultConfig } from '../../research/model';
import { defaultSelection } from '../../temporal/window';
import { compareConfig, useAnalysis, useMetricsClients, useResearchMeta } from '../../research/useResearch';
import { useAppStore, type ResearchTab } from '../../state/store';
import { Logo } from '../common/Logo';
import { ComparisonPanel, Progress } from './ComparisonPanel';
import { ExperimentsPanel } from './ExperimentsPanel';
import { ExportPanel } from './ExportPanel';
import { GeographyPanel } from './GeographyPanel';
import { IslandsPanel } from './IslandsPanel';
import { OverviewPanel } from './OverviewPanel';
import { RankingsPanel } from './RankingsPanel';
import { ReliabilityPanel } from './ReliabilityPanel';
import { SettingsPanel } from './SettingsPanel';

const TABS: ResearchTab[] = ['overview', 'rankings', 'geography', 'reliability', 'comparison', 'experiments', 'islands', 'export'];
/** tabs that do not use the analysis of the left column */
const OWN_DATA: ResearchTab[] = ['experiments', 'islands'];

/** Research Mode: analysis conditions on the left, results in tabs on the right. */
export function ResearchView() {
  const { t } = useI18n();
  const network = useAppStore((s) => s.network);
  const config = useAppStore((s) => s.researchConfig);
  const setConfig = useAppStore((s) => s.setResearchConfig);
  const tab = useAppStore((s) => s.researchTab);
  const setTab = useAppStore((s) => s.setResearchTab);
  const cmp = useAppStore((s) => s.researchCompare);
  const collapsed = useAppStore((s) => s.researchSidebarCollapsed);
  const setCollapsed = useAppStore((s) => s.setResearchSidebarCollapsed);
  const metaState = useResearchMeta();
  const meta = metaState.state === 'ready' ? metaState.meta : null;
  const clients = useMetricsClients();
  const [focus, setFocus] = useState<number | null>(null);

  // First visit: start from the month and airline shown in Explore.
  useEffect(() => {
    if (!network || config) return;
    const st = useAppStore.getState();
    const months = network.manifest.months;
    const month = months[st.monthIndex]?.month ?? months[months.length - 1]!.month;
    setConfig({ ...defaultConfig(month), carrier: st.filters.carrierId, country: st.filters.country });
  }, [network, config, setConfig]);

  const main = useAnalysis(config, meta, clients.main);
  const otherConfig = useMemo(() => compareConfig(config, cmp), [config, cmp]);
  const other = useAnalysis(otherConfig, meta, clients.compare);
  const result = main.state === 'ready' && !main.stale ? main.result : null;
  const focusInNet = focus !== null && result?.network.airports.includes(focus) ? focus : null;

  const showOnMap = (airport: number | null) => {
    if (!network || !config) return;
    const st = useAppStore.getState();
    const { filters, unmapped } = exploreFiltersFor(config);
    const idx = network.manifest.months.findIndex((m) => m.month === config.month);
    if (idx >= 0) st.setMonthIndex(idx);
    st.setCompareEnabled(false);
    if (config.window) {
      // the same window in the temporal view (as a custom window, so it is shown exactly)
      const w = config.window;
      const base = st.temporalSel ?? { ...defaultSelection({ startMs: w.startMs, endMs: w.endMs }), speed: 'normal' as const };
      st.setExploreTime('temporal');
      st.setTemporalSel({ ...base, preset: 'custom', customStartMs: w.startMs, customEndMs: w.endMs, cursorMs: w.startMs, basis: w.basis, stepMs: w.stepMs, compare: 'off' });
    } else if (st.exploreTime === 'temporal') {
      st.setExploreTime('monthly');
    }
    st.setFilters(filters);
    st.selectAirport(airport);
    st.setAppMode('explore');
    st.setResearchMapNote(unmapped.length ? `${t('r.map.unmappedTitle')} ${unmapped.map((u) => t(`r.map.unmapped.${u}`)).join(' / ')}` : null);
  };

  if (!network || !config) return null;

  return (
    <div className={collapsed ? 'research is-collapsed' : 'research'} role="region" aria-label={t('r.title')}>
      <aside className="research-settings panel" aria-label={t('r.settings')}>
        {collapsed ? (
          <button type="button" className="r-collapse" onClick={() => setCollapsed(false)} aria-expanded={false} title={t('r.sidebar.expand')}>
            <span aria-hidden="true">»</span>
            <span className="r-collapse-label">{t('r.settings')}</span>
          </button>
        ) : (
          <>
            <div className="brand"><Logo /></div>
            <div className="r-settings-head">
              <h2 className="section-title">{t('r.settings')}</h2>
              <button type="button" className="r-collapse-btn" onClick={() => setCollapsed(true)} aria-expanded title={t('r.sidebar.collapse')}>«</button>
            </div>
            <div className="sidebar-scroll">
              <SettingsPanel config={config} />
            </div>
          </>
        )}
      </aside>
      <section className="research-main panel">
        <header className="research-head">
          <nav className="research-tabs" role="tablist" aria-label={t('r.title')}>
            {TABS.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
                {t(`r.tab.${k}`)}
              </button>
            ))}
          </nav>
          <span className="badge info-badge">{t('r.badge')}</span>
        </header>
        <div className="research-body">
          {metaState.state === 'error' && tab !== 'islands' && (
            <div className="r-box r-warn">
              <h4 className="r-h4">{t('r.metaError')}</h4>
              <p className="small mono">{metaState.message}</p>
            </div>
          )}
          {main.state === 'error' && !OWN_DATA.includes(tab) && <p className="hint warn">{t('r.status.error')} {main.message}</p>}
          {meta && tab === 'experiments' && <ExperimentsPanel config={config} meta={meta} onShowOnMap={showOnMap} />}
          {tab === 'islands' && <IslandsPanel />}
          {meta && !OWN_DATA.includes(tab) && !result && main.state !== 'error' && <Progress state={main} />}
          {meta && result && !OWN_DATA.includes(tab) && (
            <>
              {tab === 'overview' && <OverviewPanel result={result} meta={meta} />}
              {tab === 'rankings' && <RankingsPanel result={result} focus={focusInNet} onFocus={setFocus} onShowOnMap={showOnMap} />}
              {tab === 'geography' && <GeographyPanel result={result} />}
              {tab === 'reliability' && <ReliabilityPanel result={result} meta={meta} focusAirport={focusInNet} />}
              {tab === 'comparison' && <ComparisonPanel result={result} other={other} otherConfig={otherConfig} meta={meta} />}
              {tab === 'export' && <ExportPanel result={result} meta={meta} other={other.state === 'ready' && !other.stale ? other.result : null} />}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
