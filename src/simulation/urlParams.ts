/**
 * Scenario <-> URL (short scenarios only; longer ones are shared as JSON files):
 *   sim=1&sm=t&sb=d&ss=2026-03-10T00:00Z&se=2026-03-11T00:00Z&st=...&sev=A~OMDB~b~...&sti=C&smin=4&sd=1&sbas=start&sp=ref
 */
import { eventsFromParam, eventsToParam, isoMinute, newScenario, parseIsoUtc, type SimulationScenario } from './model';

export function scenarioToParams(s: SimulationScenario, p: URLSearchParams): void {
  p.set('sim', '1');
  if (s.simulationModel === 'temporal') p.set('sm', 't');
  if (s.baselineMode === 'dynamic') p.set('sb', 'd');
  p.set('ss', s.analysisStart);
  p.set('se', s.analysisEnd);
  if (s.evaluationTime) p.set('st', s.evaluationTime);
  const ev = eventsToParam(s.events);
  if (ev) p.set('sev', ev);
  if (s.filters.tiers !== 'D') p.set('sti', s.filters.tiers);
  if (s.filters.minFlights !== 1) p.set('smin', String(s.filters.minFlights));
  if (s.analysisSettings.directed) p.set('sd', '1');
  if (s.filters.basis === 'start') p.set('sbas', 'start');
  if (s.filters.timeProxy === 'reference') p.set('sp', 'ref');
}

/** null when the URL has no scenario. Events are validated later, like a loaded file. */
export function scenarioFromParams(p: URLSearchParams, datasetId: string): SimulationScenario | null {
  if (p.get('sim') !== '1') return null;
  const start = parseIsoUtc(p.get('ss'));
  const end = parseIsoUtc(p.get('se'));
  if (start === null || end === null || !(end > start)) return null;
  const s = newScenario(datasetId, null, start, end);
  s.simulationModel = p.get('sm') === 't' ? 'temporal' : 'structural';
  s.baselineMode = p.get('sb') === 'd' ? 'dynamic' : 'fixed';
  const st = parseIsoUtc(p.get('st'));
  s.evaluationTime = st === null ? null : isoMinute(st);
  s.events = eventsFromParam(p.get('sev') ?? '');
  const ti = p.get('sti');
  if (ti === 'A' || ti === 'B' || ti === 'C') s.filters.tiers = ti;
  const min = Number(p.get('smin'));
  if (Number.isInteger(min) && min >= 1) s.filters.minFlights = min;
  s.analysisSettings.directed = p.get('sd') === '1';
  if (p.get('sbas') === 'start') s.filters.basis = 'start';
  if (p.get('sp') === 'ref') s.filters.timeProxy = 'reference';
  return s;
}
