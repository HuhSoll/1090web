import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

export function Timeline() {
  const { t, monthLabel } = useI18n();
  const network = useAppStore((s) => s.network);
  const monthIndex = useAppStore((s) => s.monthIndex);
  const month = useAppStore((s) => s.month);
  const monthLoading = useAppStore((s) => s.monthLoading);
  const playing = useAppStore((s) => s.playing);
  const setPlaying = useAppStore((s) => s.setPlaying);
  const setMonthIndex = useAppStore((s) => s.setMonthIndex);
  const stress = useAppStore((s) => s.stressRouteCount);

  if (!network) return null;
  const months = network.manifest.months;
  const n = months.length;
  const current = months[monthIndex];
  const disabled = stress !== null || n < 2;

  const go = (i: number) => {
    setPlaying(false);
    setMonthIndex((i + n) % n);
  };

  return (
    <div className="timeline panel" role="group" aria-label={t('timeline.label')}>
      <div className="timeline-buttons">
        <button type="button" className="icon-btn" disabled={disabled} onClick={() => go(monthIndex - 1)} aria-label={t('timeline.prev')} title={t('timeline.prev')}>
          <Icon name="prev" />
        </button>
        <button
          type="button"
          className={`icon-btn play ${playing ? 'is-active' : ''}`}
          disabled={disabled}
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? t('timeline.pause') : t('timeline.play')}
          title={playing ? t('timeline.pause') : t('timeline.play')}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button type="button" className="icon-btn" disabled={disabled} onClick={() => go(monthIndex + 1)} aria-label={t('timeline.next')} title={t('timeline.next')}>
          <Icon name="next" />
        </button>
      </div>

      <div className="timeline-track">
        <div className="timeline-current">
          <strong>{stress !== null ? t('timeline.disabled') : current ? monthLabel(current.month) : '—'}</strong>
          {stress === null && month && (
            <span className="muted small">
              {monthLoading ? t('app.loadingMonth', { month: current ? monthLabel(current.month) : '' }) : t('timeline.observedDays', { days: month.observedDays })}
            </span>
          )}
        </div>
        <input
          type="range"
          className="timeline-range"
          min={0}
          max={Math.max(0, n - 1)}
          step={1}
          value={monthIndex}
          disabled={disabled}
          aria-label={t('timeline.label')}
          aria-valuetext={current ? monthLabel(current.month) : undefined}
          onChange={(e) => go(Number(e.target.value))}
        />
        <div className="timeline-ticks" aria-hidden="true">
          {months.map((m, i) => (
            <span key={m.month} className={i === monthIndex ? 'is-active' : ''}>
              {monthLabel(m.month, 'short')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
