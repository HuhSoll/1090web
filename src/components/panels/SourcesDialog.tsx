import { useEffect, useRef } from 'react';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';
import type { DatasetQuality, DatasetSource } from '../../data/model/schema';
import type { MessageKey } from '../../i18n/messages';

/** Localised descriptions for sources we know; others fall back to the manifest text. */
const SOURCE_DESC: Record<string, MessageKey> = {
  mrairspace: 'source.desc.mrairspace',
  ourairports: 'source.desc.ourairports',
  'this-dataset': 'source.desc.this-dataset',
};

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
  const describe = (s: DatasetSource) => (SOURCE_DESC[s.id] ? t(SOURCE_DESC[s.id]!) : s.description);
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
            <dd>
              {manifest.kind === 'observed' && first
                ? t('source.datasetObserved', { year: first.slice(0, 4) })
                : manifest.title}
            </dd>
            <dt>{t('source.period')}</dt>
            <dd>{first && last ? `${monthLabel(first)} – ${monthLabel(last)}` : '—'}</dd>
            <dt>{t('source.generated')}</dt>
            <dd>{dateTime(manifest.generatedAt)}</dd>
          </dl>
          <ul className="source-list">
            {manifest.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</strong>
                <p className="muted small">{describe(s)}</p>
                <p className="muted tiny">
                  {t('source.license')}: {s.license}
                </p>
              </li>
            ))}
          </ul>
          {manifest.quality && <QualitySummary quality={manifest.quality} />}
        </>
      )}
      <p className="muted small">{t('source.basemap')}</p>
    </dialog>
  );
}

/** Feature 8 quality criterion: data-quality problems are shown, not hidden. */
function QualitySummary({ quality }: { quality: DatasetQuality }) {
  const { t, number } = useI18n();
  const total = quality.flightsWithAirlineCode;
  const pct = (n: number | undefined) => (total > 0 && n ? ` (${((n / total) * 100).toFixed(1)}%)` : '');
  const conflicts = quality.observedVsCallsignConflicts.origin + quality.observedVsCallsignConflicts.destination;
  const classTotal = (quality.classes.passenger ?? 0) + (quality.classes.cargo ?? 0) + (quality.classes.unknown ?? 0);
  const rows: [string, string][] = [
    [t('source.qFlights'), number(total)],
    [t('source.qOnMap'), number(quality.flightsOnMap) + pct(quality.flightsOnMap)],
    [t('source.qObserved'), number(quality.basis.observed ?? 0) + pct(quality.basis.observed)],
    [t('source.qCallsign'), number(quality.basis.callsign ?? 0) + pct(quality.basis.callsign)],
    [t('source.qUnknown'), number(quality.basis.unknown ?? 0) + pct(quality.basis.unknown)],
    [t('source.qConflicts'), number(conflicts)],
    [
      t('source.qClassUnknown'),
      number(quality.classes.unknown ?? 0) +
        (classTotal > 0 ? ` (${(((quality.classes.unknown ?? 0) / classTotal) * 100).toFixed(1)}%)` : ''),
    ],
    [t('source.qNoAirline'), number(quality.flightsWithoutAirlineCode)],
  ];
  return (
    <section>
      <h3 className="section-title">{t('source.quality')}</h3>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
