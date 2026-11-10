import type { AirportRecord, DatasetManifest, MonthFile, RouteTuple } from '../model/schema';

/**
 * Lightweight runtime validation of the public dataset. Data files are produced by our own
 * pipeline, but they are fetched over the network, so we fail loudly instead of rendering
 * garbage when a file is truncated or the schema drifts.
 */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SchemaError(message);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateManifest(raw: unknown): DatasetManifest {
  assert(raw && typeof raw === 'object', 'manifest: not an object');
  const m = raw as DatasetManifest;
  assert(m.schemaVersion === 1, `manifest: unsupported schemaVersion ${String(m.schemaVersion)}`);
  assert(m.kind === 'demo' || m.kind === 'observed', 'manifest: invalid kind');
  assert(Array.isArray(m.months) && m.months.length > 0, 'manifest: months missing');
  for (const month of m.months) {
    assert(/^\d{4}-\d{2}$/.test(month.month), `manifest: bad month ${month.month}`);
  }
  assert(Array.isArray(m.carriers), 'manifest: carriers missing');
  assert(Array.isArray(m.sources), 'manifest: sources missing');
  return m;
}

export function validateAirports(raw: unknown): AirportRecord[] {
  assert(Array.isArray(raw), 'airports: not an array');
  const seen = new Set<string>();
  for (const a of raw as AirportRecord[]) {
    assert(typeof a.id === 'string' && a.id.length > 0, 'airports: missing id');
    assert(!seen.has(a.id), `airports: duplicate id ${a.id}`);
    seen.add(a.id);
    assert(isFiniteNumber(a.lat) && a.lat >= -90 && a.lat <= 90, `airports: bad lat for ${a.id}`);
    assert(isFiniteNumber(a.lon) && a.lon >= -180 && a.lon <= 180, `airports: bad lon for ${a.id}`);
  }
  return raw as AirportRecord[];
}

export function validateRoutes(raw: unknown, airportIds: Set<string>): RouteTuple[] {
  assert(Array.isArray(raw), 'routes: not an array');
  (raw as RouteTuple[]).forEach((r, i) => {
    assert(Array.isArray(r) && r.length === 3, `routes[${i}]: bad tuple`);
    assert(r[0] === i, `routes[${i}]: ids must be dense and ordered`);
    assert(airportIds.has(r[1]) && airportIds.has(r[2]), `routes[${i}]: unknown airport`);
    assert(r[1] !== r[2], `routes[${i}]: self loop`);
  });
  return raw as RouteTuple[];
}

export function validateMonth(raw: unknown, routeCount: number): MonthFile {
  assert(raw && typeof raw === 'object', 'month: not an object');
  const m = raw as MonthFile;
  assert(Array.isArray(m.records), 'month: records missing');
  for (const r of m.records) {
    assert(r[0] >= 0 && r[0] < routeCount, `month ${m.month}: route id out of range`);
    assert(r[1] === 0 || r[1] === 1, `month ${m.month}: bad direction`);
    assert(r[3] >= 0 && r[4] >= 0 && r[5] >= 0, `month ${m.month}: negative counts`);
    assert(r.length === 6 || r[6] === 0 || r[6] === 1, `month ${m.month}: bad basis`);
  }
  return m;
}
