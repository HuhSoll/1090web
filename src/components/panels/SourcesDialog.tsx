import { useEffect, useRef } from 'react';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

/** Feature 15: data source, observation period and license display. */
export function SourcesDialog() {
  const { t, monthLabel, dateTime } = useI18n();
  const open = useAppStore((s) => s.sourcesOpen);
  const setOpen = useAppStore((s) => s.setSourcesOpen);
  const network = useAppStore((s) => s.network);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const manifest = network?.manifest;
  const months = manifest?.months ?? [];
  const first = months[0]?.month;
  const last = months[months.length - 1]?.month;

  return (
    <dialog ref={ref} className="dialog panel" onClose={() => setOpen(false)} aria-labelledby="sources-title">
      <div className="dialog-head">
        <h2 id="sources-title">{t('source.title')}</h2>
        <button type="button" className="icon-btn small" onClick={() => setOpen(false)} aria-label={t('source.close')}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {manifest && (
        <>
          {manifest.kind === 'demo' && <p className="hint warn">{manifest.disclaimer}</p>}
          <dl className="kv">
            <dt>{t('source.dataset')}</dt>
            <dd>{manifest.title}</dd>
            <dt>{t('source.period')}</dt>
            <dd>{first && last ? `${monthLabel(first)} – ${monthLabel(last)}` : '—'}</dd>
            <dt>{t('source.generated')}</dt>
            <dd>{dateTime(manifest.generatedAt)}</dd>
          </dl>
          <ul className="source-list">
            {manifest.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</strong>
                <p className="muted small">{s.description}</p>
                <p className="muted tiny">
                  {t('source.license')}: {s.license}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">{t('source.basemap')}</p>
    </dialog>
  );
}
