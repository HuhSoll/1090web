import { useMemo } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { useAppStore } from '../../state/store';
import { gapMask, windowQuality } from '../../temporal/quality';
import { useTemporalMeta, windowLabel } from '../../temporal/useTemporal';
import { formatUtc, HOUR_MS } from '../../temporal/window';

/** Small line chart of one series; bins inside a suspected collection gap are shaded. */
function Spark({ values, gaps, label }: { values: number[]; gaps: boolean[]; label: string }) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const W = 240;
  const H = 44;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  const bw = n > 1 ? W / (n - 1) : W;
  return (
    <svg className="t-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {gaps.map((g, i) => (g ? <rect key={i} className="gap" x={Math.max(0, x(i) - bw / 2)} y={0} width={bw} height={H} /> : null))}
      <polyline className="line" points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function TemporalStats() {
  const { t, number } = useI18n();
  const status = useAppStore((s) => s.temporalStatus);
  const network = useAppStore((s) => s.network);
  const selectedAirport = useAppStore((s) => s.selectedAirport);
  const meta = useTemporalMeta(true);
  const index = meta.state === 'ready' ? meta.meta.index : null;
  const result = status.state === 'ready' ? status.result : null;

  const derived = useMemo(() => {
    if (!result || !index) return null;
    const s = result.series;
    const gaps = gapMask(index, s.startMs, s.binMs, s.flights.length);
    const q = windowQuality(index, result.window, { flights: s.flights.reduce((a, b) => a + b, 0), missingDays: result.missingDays });
    return { s, gaps, q };
  }, [result, index]);

  if (!result || !derived || !network || meta.state !== 'ready') return null;
  const { s, gaps, q } = derived;
  const bin = t(s.binMs === HOUR_MS ? 't.stats.bin.hour' : 't.stats.bin.day');
  const at = (i: number) => formatUtc(s.startMs + i * s.binMs, false);
  const extremes = (v: number[]) => {
    if (v.length === 0) return '';
    let hi = 0;
    let lo = 0;
    v.forEach((x, i) => {
      if (x > v[hi]!) hi = i;
      if (x < v[lo]!) lo = i;
    });
    return `${t('t.stats.peak', { value: number(v[hi]!), time: at(hi) })} · ${t('t.stats.low', { value: number(v[lo]!), time: at(lo) })}`;
  };
  const fallbackShare = result.trackStart + result.fallback > 0 ? result.fallback / (result.trackStart + result.fallback) : 0;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const airport = selectedAirport !== null ? network.airports[selectedAirport] : null;
  const regions = Object.entries(meta.meta.quality.timeQuality.start_missing_by_region).filter(([r]) => r !== '?');
  const base = result.base;
  const hours = (result.window.endMs - result.window.startMs) / HOUR_MS;

  return (
    <div className="info-body t-stats">
      <h3 className="section-title">{t('t.stats.title')}</h3>
      <p className="hint">{windowLabel(result.window)}</p>
      {hours < 24 && <p className="hint warn">{t('t.shortWindowNote')}</p>}

      <div>
        <p className="small">{t('t.stats.traffic', { bin })}</p>
        <Spark values={s.flights} gaps={gaps} label={t('t.stats.traffic', { bin })} />
        <p className="hint">{extremes(s.flights)}</p>
      </div>
      <div>
        <p className="small">{t('t.stats.routes', { bin })}</p>
        <Spark values={s.routes} gaps={gaps} label={t('t.stats.routes', { bin })} />
        <p className="hint">{extremes(s.routes)}</p>
      </div>
      {s.partners && airport && (
        <div>
          <p className="small">{t('t.stats.partners', { bin, airport: airport.iata ?? airport.id })}</p>
          <Spark values={s.partners} gaps={gaps} label={t('t.stats.partners', { bin, airport: airport.iata ?? airport.id })} />
          <p className="hint">{extremes(s.partners)}</p>
        </div>
      )}
      <p className="hint">{t('t.stats.filtered')}</p>
      <p className="hint">{t('t.stats.world', { flights: number(q.worldFlights) })}</p>
      {base && (
        <p className="hint">
          {t('t.stats.compare', {
            window: windowLabel(base.window),
            base: number(base.flights),
            current: number(result.flights),
            change: base.flights ? `${result.flights >= base.flights ? '+' : ''}${(((result.flights - base.flights) / base.flights) * 100).toFixed(1)}%` : '—',
          })}
        </p>
      )}
      {base && <p className="hint">{t('t.compareNote')}</p>}

      <h3 className="section-title">{t('t.stats.quality')}</h3>
      <p className="hint">{t('t.stats.fallbackShare', { share: pct(fallbackShare) })}</p>
      <p className="hint">{t('t.membership')}</p>
      <p className="small">{t('t.stats.regionMissing')}</p>
      <dl className="kv">
        {regions.map(([r, [n, m]]) => (
          <div className="kv-row" key={r}>
            <dt>{t(`r.region.${r}` as 'r.region.AF')}</dt>
            <dd>{n ? pct(m / n) : '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
