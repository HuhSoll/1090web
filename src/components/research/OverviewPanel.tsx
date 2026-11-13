import { useI18n } from '../../i18n/useI18n';
import type { ResearchMeta } from '../../research/data';
import type { AnalysisResult } from '../../research/results';
import { gapDaysIn, isShortWindow, periodOf } from '../../research/periods';
import { Note, Stat } from './common';
import { useFormat } from './format';

/** Network summary, tier mix, what the thresholds removed, and the month's data-gap warning. */
export function OverviewPanel({ result, meta }: { result: AnalysisResult; meta: ResearchMeta }) {
  const { t, monthLabel } = useI18n();
  const f = useFormat();
  const { network: net, metrics, config } = result;
  const s = metrics.summary;
  // monthly quality applies to calendar-month analyses only
  const q = config.window ? undefined : meta.quality.months.find((m) => m.month === config.month);
  const windowGaps = config.window ? gapDaysIn(meta, config.window.startMs, config.window.endMs) : [];
  const days = q?.calendarDays ?? net.daysInMonth;
  const tierTotal = net.tierFlights.reduce((a, b) => a + b, 0);
  const n = net.airports.length;
  const nw = q?.normalisationWorld;

  return (
    <div className="r-stack">
      <h3 className="r-h">{t('r.ov.title', { month: monthLabel(periodOf(config)) })}</h3>
      {config.window && <Note>{t('t.membership')}</Note>}
      {isShortWindow(config) && <Note warn>{t('t.shortWindowNote')}</Note>}
      {windowGaps.length > 0 && (
        <section className="r-box r-warn">
          <h4 className="r-h4">{t('r.gap.title')}</h4>
          <p className="small">{t('r.ov.windowGap', { days: windowGaps.join(', ') })}</p>
        </section>
      )}
      <div className="stats r-stats">
        <Stat label={t('r.ov.airports')} value={f.int(n)} />
        <Stat label={config.directed ? t('r.ov.routesDirected') : t('r.ov.routes')} value={f.int(config.directed ? net.directedRoutes : net.routes.length)} />
        <Stat label={t('r.ov.flights')} value={f.int(net.flights)} note={t('r.ov.flightsNote')} />
        {config.window ? (
          // a window is not scaled up to a day: flights per hour of the window
          <Stat label={t('r.ov.perHour')} value={f.int(net.flights / ((config.window.endMs - config.window.startMs) / 3_600_000))} note={t('r.ov.perHourNote', { hours: (config.window.endMs - config.window.startMs) / 3_600_000 })} />
        ) : (
          <Stat label={t('r.ov.perDay')} value={f.int(days ? net.flights / days : null)} note={t('r.ov.perDayNote', { days: days ?? '—' })} />
        )}
        <Stat label={t('r.ov.meanDegree')} value={f.dec(n ? metrics.degree.reduce((a, b) => a + b, 0) / n : null, 1)} note={t('r.ov.meanDegreeNote')} />
        <Stat label={t('r.ov.density')} value={f.dec(s.density, 4)} />
        <Stat label={t('r.ov.components')} value={f.int(s.components)} />
        <Stat label={t('r.ov.largest')} value={f.pct(n ? s.largestComponent / n : null)} note={t('r.ov.largestNote', { count: s.largestComponent })} />
        {s.strongComponents !== null && <Stat label={t('r.ov.strong')} value={f.int(s.strongComponents)} note={t('r.ov.strongNote', { count: s.largestStrongComponent ?? 0 })} />}
        <Stat label={t('r.ov.clustering')} value={f.dec(s.averageClustering, 3)} />
        <Stat label={t('r.ov.transitivity')} value={f.dec(s.transitivity, 3)} />
      </div>

      <section className="r-box">
        <h4 className="r-h4">{t('r.ov.tierMix')}</h4>
        <div className="r-bar" aria-hidden="true">
          {net.tierFlights.map((v, i) => (
            <span key={i} className={`r-bar-t${i + 1}`} style={{ width: `${tierTotal ? (100 * v) / tierTotal : 0}%` }} />
          ))}
        </div>
        <dl className="kv">
          {net.tierFlights.map((v, i) => (
            <div className="kv-row" key={i}>
              <dt>{t(`r.tier.T${i + 1}` as 'r.tier.T1')}</dt>
              <dd>{f.int(v)} ({f.pct(tierTotal ? v / tierTotal : null)})</dd>
            </div>
          ))}
        </dl>
        <Note>{t('r.ov.tierNote')}</Note>
      </section>

      <section className="r-box">
        <h4 className="r-h4">{t('r.ov.filtersEffect')}</h4>
        <dl className="kv">
          <div className="kv-row"><dt>{t('r.ov.candidate')}</dt><dd>{f.int(net.candidateRoutes)} / {f.int(net.candidateFlights)}</dd></div>
          <div className="kv-row"><dt>{t('r.ov.droppedMin', { n: config.minFlights })}</dt><dd>{f.int(net.droppedByMinFlights.routes)} / {f.int(net.droppedByMinFlights.flights)}</dd></div>
          {config.minMonths > 0 && <div className="kv-row"><dt>{t('r.ov.droppedMonths', { n: config.minMonths })}</dt><dd>{f.int(net.droppedByMinMonths.routes)} / {f.int(net.droppedByMinMonths.flights)}</dd></div>}
        </dl>
        <Note>{t('r.ov.filtersNote')}</Note>
      </section>

      {q && q.gapDays.length > 0 && (
        <section className="r-box r-warn">
          <h4 className="r-h4">{t('r.gap.title')}</h4>
          <p className="small">{t('r.gap.body', { days: q.gapDays.map((d) => d.slice(5)).join(', ') })}</p>
          {nw && nw.B_per_calendar_day !== null && nw.C2_per_good_day !== null && (
            <dl className="kv">
              <div className="kv-row"><dt>{t('r.gap.raw')}</dt><dd>{f.int(net.flights)}</dd></div>
              <div className="kv-row"><dt>{t('r.gap.perCalendarDay')}</dt><dd>{f.int(days ? net.flights / days : null)}</dd></div>
              <div className="kv-row"><dt>{t('r.gap.worldFactor')}</dt><dd>{f.signedPct(nw.C2_per_good_day / nw.B_per_calendar_day - 1)}</dd></div>
            </dl>
          )}
          <Note warn>{t('r.gap.note', { excluded: nw?.excluded_days.join(', ') ?? '' })}</Note>
        </section>
      )}
      {q && q.gapDays.length === 0 && q.anomalyDays.length > 0 && (
        <Note>{t('r.gap.anomalyOnly', { days: q.anomalyDays.map((d) => d.slice(5)).join(', ') })}</Note>
      )}

      <section className="r-box">
        <h4 className="r-h4">{t('r.ov.method')}</h4>
        <dl className="kv">
          <div className="kv-row"><dt>{t('r.ov.pathMethod')}</dt><dd>{s.path.exact ? t('r.path.exactUsed') : t('r.path.sampledUsed', { k: s.path.sources, seed: s.path.seed ?? '' })}</dd></div>
          <div className="kv-row"><dt>{t('r.ov.pagerank')}</dt><dd>{t('r.ov.pagerankValue', { it: s.pagerankIterations })}</dd></div>
          <div className="kv-row"><dt>{t('r.ov.elapsed')}</dt><dd>{f.int(s.elapsedMs)} ms</dd></div>
        </dl>
        {!s.path.exact && <Note warn>{t('r.path.approxWarning')}</Note>}
        <Note>{t('r.ov.structureNote')}</Note>
      </section>
    </div>
  );
}
