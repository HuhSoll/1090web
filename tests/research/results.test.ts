import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/research/analysis';
import { mergeMonth } from '../../src/research/data';
import { exploreFiltersFor } from '../../src/research/mapLink';
import {
  canonicalConfig,
  changedFields,
  configFromParams,
  configHash,
  configToParams,
  defaultConfig,
  sanitizeConfig,
} from '../../src/research/model';
import { areaNetwork, buildResearchNetwork, edgeArrays, routeRows } from '../../src/research/network';
import { airportsCsv, analysisDocument, csvEscape, importDocument, routesCsv, type AnalysisResult } from '../../src/research/results';
import { compareConfig, configContext } from '../../src/research/useResearch';
import { findValidation } from '../../src/research/validation';
import { externalRows } from '../../src/research/data';
import { april, aprilTiers, continentOf, meta, network, persistence, quality } from './fixtures';

const ctxCfg = configContext(network);

function analyse(patch = {}): AnalysisResult {
  const config = { ...defaultConfig('2026-04'), minFlights: 1, ...patch };
  const month = mergeMonth(april, aprilTiers, network.carriers.map((c) => c.id));
  const net = buildResearchNetwork({ network, continentOf, persistence }, month, config);
  const metrics = computeMetrics(edgeArrays(net, config.directed), { pathMethod: config.pathMethod, samples: config.samples, seed: config.seed });
  return {
    config, hash: configHash(config), network: net, metrics, routes: routeRows(net, config.directed, null),
    countries: areaNetwork(net, (a) => network.airports[a]!.country, 'country', config.directed),
    regions: areaNetwork(net, (a) => continentOf[a]!, 'region', config.directed),
    previousMonth: null, computedAt: '2026-11-11T00:00:00Z',
  };
}

describe('analysis conditions', () => {
  it('defaults: all tiers, threshold 4, undirected', () => {
    const d = defaultConfig('2026-04');
    expect([d.tiers, d.minFlights, d.directed, d.minMonths]).toEqual(['D', 4, false, 0]);
  });
  it('round-trips through the URL', () => {
    const c = { ...defaultConfig('2026-04'), country: 'US', tiers: 'C' as const, minFlights: 10, directed: true, classes: ['passenger' as const], relation: 'domestic' as const };
    const p = new URLSearchParams();
    configToParams(c, p);
    expect(p.toString()).toBe('rm=2026-04&rc=US&rk=p&rmin=10&rt=C&rd=d&rrel=domestic');
    const back = sanitizeConfig(configFromParams(p), ctxCfg).config;
    expect(back).toEqual(c);
  });
  it('drops invalid values and reports them', () => {
    const { config, dropped } = sanitizeConfig({ month: '2030-01', tiers: 'Z' as never, minFlights: -3, country: 'ZZ' }, ctxCfg);
    expect(dropped.sort()).toEqual(['country', 'minFlights', 'month', 'tiers']);
    expect(config.month).toBe('2026-04'); // latest month
  });
  it('hash is stable and changes with any condition', () => {
    const a = defaultConfig('2026-04');
    expect(configHash(a)).toBe(configHash({ ...a }));
    expect(configHash(a)).not.toBe(configHash({ ...a, seed: 2 }));
    expect(canonicalConfig(a)).toBe(canonicalConfig({ ...a }));
    expect(changedFields(a, { ...a, minFlights: 10, tiers: 'C' })).toEqual(['minFlights', 'tiers']);
  });
  it('comparison changes exactly one condition', () => {
    const a = defaultConfig('2026-04');
    expect(changedFields(a, compareConfig(a, { enabled: true, field: 'minFlights', value: 10 })!)).toEqual(['minFlights']);
    expect(changedFields(a, compareConfig(a, { enabled: true, field: 'month', value: '2026-03' })!)).toEqual(['month']);
    expect(changedFields(a, compareConfig(a, { enabled: true, field: 'area', value: 'C:JP' })!)).toEqual(['country']);
    expect(compareConfig(a, { enabled: true, field: 'minFlights', value: 4 })).toBeNull(); // same value
    expect(compareConfig(a, { enabled: false, field: 'month', value: '2026-03' })).toBeNull();
  });
});

describe('export and import', () => {
  it('escapes CSV values', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(0.1 + 0.2)).toBe('0.3');
  });
  it('CSV rows carry the same hash and version as the JSON', () => {
    const r = analyse();
    const m = meta();
    const doc = analysisDocument(r, m);
    const lines = airportsCsv(r, network, m).trim().split('\n');
    expect(lines[0]!.startsWith('config_hash,dataset_id,dataset_version,month,rank_by,rank,airport_id')).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith(`${doc.configHash},test-ds,1.0.0,2026-04,`)).toBe(true);
    expect(lines.length - 1).toBe(r.network.airports.length);
    const routes = routesCsv(r, network, m).trim().split('\n');
    expect(routes.length - 1).toBe(r.routes.length);
    expect(doc.config).toEqual(r.config);
    expect(doc.approximate).toBe(false);
    expect(doc.dataset.inputs).toEqual({ 'routes_monthly.parquet': 'h0' });
  });
  it('ranks ties equally in the airport CSV', () => {
    const r = analyse();
    const rows = airportsCsv(r, network, meta()).trim().split('\n').slice(1).map((l) => l.split(','));
    // degree: JFK 3 (rank 1); HND 2 (rank 2); ITM, LAX, GRU 1 (shared rank 3, ordered by id)
    expect(rows.map((x) => [x[6], x[5]])).toEqual([['KJFK', '1'], ['RHND', '2'], ['KLAX', '3'], ['RITM', '3'], ['SGRU', '3']]);
  });
  it('restores conditions from the JSON and checks the dataset version', () => {
    const r = analyse({ tiers: 'C', minFlights: 10 });
    const m = meta();
    const text = JSON.stringify(analysisDocument(r, m));
    const ok = importDocument(text, m, ctxCfg);
    expect(ok.config).toEqual(r.config);
    expect(ok.warnings).toEqual([]);
    const other = { ...m, manifest: { ...m.manifest, datasetVersion: '2.0.0' } };
    expect(importDocument(text, other, ctxCfg).warnings).toContain('dataset_version_differs');
    const otherId = { ...m, manifest: { ...m.manifest, datasetId: 'x' } };
    expect(importDocument(text, otherId, ctxCfg).warnings).toContain('dataset_id_differs');
    expect(importDocument('{', m, ctxCfg).errors).toEqual(['invalid_json']);
    expect(importDocument('{"format":"x"}', m, ctxCfg).errors).toEqual(['not_an_analysis_file']);
    const tampered = JSON.parse(text);
    tampered.config.minFlights = 30;
    expect(importDocument(JSON.stringify(tampered), m, ctxCfg).warnings).toContain('hash_mismatch');
  });
});

describe('external validation matching', () => {
  const rows = externalRows(quality);
  it('uses the row with the same conditions and lists the differences', () => {
    const m = findValidation({ ...defaultConfig('2026-04'), country: 'US', relation: 'domestic' }, rows, quality)!;
    expect(m.row?.vol_WAPE).toBe(0.1);
    expect(m.usedThreshold).toBe(4);
    expect(m.differences).toEqual(['carrierMatched']);
  });
  it('never applies another month or threshold silently', () => {
    const m = findValidation({ ...defaultConfig('2026-03'), country: 'US', relation: 'domestic', minFlights: 12 }, rows, quality)!;
    expect(m.row).toBeNull();
    expect(m.usedThreshold).toBe(10);
    expect(m.differences).toEqual(['carrierMatched', 'threshold', 'month']);
  });
  it('Japan: national totals only; other countries: unvalidated', () => {
    const jp = findValidation({ ...defaultConfig('2026-04'), country: 'JP', relation: 'domestic', minFlights: 1 }, rows, quality)!;
    expect(jp.japan?.ratio).toBe(0.76);
    expect(jp.differences).toEqual(['nationalTotal']);
    expect(findValidation({ ...defaultConfig('2026-04'), country: 'DE' }, rows, quality)).toBeNull();
    expect(findValidation(defaultConfig('2026-04'), rows, quality)).toBeNull();
  });
});

describe('map link', () => {
  it('maps what Explore can show and reports the rest', () => {
    const { filters, unmapped } = exploreFiltersFor({ ...defaultConfig('2026-04'), tiers: 'C', country: 'JP', carrier: 'AAA', minFlights: 10 });
    expect(filters).toEqual({ country: 'JP', carrierId: 'AAA', mode: 'all', minFlights: 10, includeCallsign: false });
    expect(unmapped).toEqual([]);
    expect(exploreFiltersFor({ ...defaultConfig('2026-04'), tiers: 'A', directed: true, region: 'EU' }).unmapped).toEqual(['tiers', 'region', 'directed']);
  });
});
