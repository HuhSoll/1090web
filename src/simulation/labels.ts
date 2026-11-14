import type { SimulationEvent } from './model';

/** Name of an event on the timeline: its label, else its targets ("DXB", "LHR→JFK", "DXB⇄DOH"). */
export function eventLabel(e: SimulationEvent, code: (id: string) => string): string {
  if (e.label) return e.label;
  return e.targetIds.map((id) => (e.targetType === 'route' ? id.split('>').map(code).join(e.direction === 'directed' ? '→' : '⇄') : code(id))).join(', ');
}
