import { APP_BUILD } from '../../app/build';
import { METHOD_VERSION as EVENTS_METHOD } from '../../events/study';
import { METHOD_VERSION as EXPERIMENTS_METHOD } from '../../experiments/model';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/messages';
import { METHOD_VERSION as SIMULATION_METHOD } from '../../simulation/model';
import { goTo, type Target } from '../../research/findings';
import { useAppStore } from '../../state/store';

interface Question { id: string; targets: Target[] }

/** Start from the question; every research view stays reachable from the tabs as before. */
const QUESTIONS: Question[] = [
  { id: 'critical', targets: ['rankings', 'experiments'] },
  { id: 'stop', targets: ['simulation'] },
  { id: 'data', targets: ['reliability', 'experiments'] },
  { id: 'islands', targets: ['islands'] },
  { id: 'crisis', targets: ['events'] },
  { id: 'findings', targets: ['findings'] },
];

/** Research Home (Phase 9I): what do you want to examine? */
export function HomePanel() {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.network?.manifest);
  const months = manifest?.months ?? [];
  return (
    <div className="rh">
      <section className="r-box">
        <h3 className="r-h4">{t('rh.title')}</h3>
        <ul className="rh-list">
          {QUESTIONS.map((q) => (
            <li key={q.id} className="rh-row">
              <div className="rh-q">
                <span className="rh-q-title">{t(`rh.q.${q.id}` as MessageKey)}</span>
                <span className="small x-dim">{t(`rh.q.${q.id}.where` as MessageKey)}</span>
              </div>
              <div className="rh-go">
                {q.targets.map((x) => (
                  <button key={x} type="button" className="pill-btn panel" onClick={() => goTo(x)}>{t(`rh.go.${x}` as MessageKey)}</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="r-box">
        <h4 className="r-h4">{t('rh.read.title')}</h4>
        <ul className="r-mini">
          <li>{t('rh.read.observed')}</li>
          <li>{t('rh.read.gaps')}</li>
          <li>{t('rh.read.approx')}</li>
          <li>{t('rh.read.causal')}</li>
        </ul>
      </section>
      <section className="r-box">
        <h4 className="r-h4">{t('rh.base.title')}</h4>
        <div className="kv-row"><span>{t('rh.base.dataset')}</span><span className="mono small">{manifest ? `${manifest.datasetId} ${manifest.datasetVersion ?? ''}` : '—'}{months.length ? ` · ${months[0]!.month} – ${months[months.length - 1]!.month}` : ''}</span></div>
        <div className="kv-row"><span>{t('rh.base.methods')}</span><span className="mono small">simulation {SIMULATION_METHOD} · experiments {EXPERIMENTS_METHOD} · events {EVENTS_METHOD}</span></div>
        <div className="kv-row"><span>{t('rh.base.build')}</span><span className="mono small">1090web {APP_BUILD.version}{APP_BUILD.commit ? ` · ${APP_BUILD.commit}` : ''}{APP_BUILD.builtAt ? ` · ${APP_BUILD.builtAt}` : ''}</span></div>
        <p className="small x-dim">{t('rh.base.note')}</p>
      </section>
    </div>
  );
}
