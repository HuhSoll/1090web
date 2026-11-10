import type { NetworkView } from '../../domain/networkView';
import { useI18n } from '../../i18n/useI18n';
import { AirportSearch } from '../controls/AirportSearch';
import { FilterPanel } from '../controls/FilterPanel';
import { Logo } from '../common/Logo';

export function Sidebar({ view }: { view: NetworkView | null }) {
  const { t } = useI18n();
  return (
    <aside className="sidebar panel" aria-label="Controls">
      <header className="brand">
        <Logo />
      </header>
      <div className="sidebar-scroll">
        <section className="section">
          <AirportSearch />
        </section>
        <FilterPanel view={view} />
        <section className="section roadmap" aria-labelledby="roadmap-title">
          <h2 id="roadmap-title" className="section-title">
            {t('roadmap.title')}
          </h2>
          <ul>
            {(['roadmap.compare', 'roadmap.incidents', 'roadmap.observed'] as const).map((k) => (
              <li key={k}>
                <span>{t(k)}</span>
                <span className="badge muted-badge">{t('roadmap.notAvailable')}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
