#!/usr/bin/env node
/**
 * Step 1 of the social preview image: projects land, routes and airports into pixel space
 * (equirectangular, same projection as the app's flat map) and writes them as JSON.
 * Step 2 (render-og.py) draws the PNG.
 *
 * Usage: node scripts/og/export-geometry.mjs <out.json> [datasetId]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [, , outPath, datasetId = 'demo'] = process.argv;
if (!outPath) {
  console.error('usage: node scripts/og/export-geometry.mjs <out.json> [datasetId]');
  process.exit(1);
}

const W = 1200;
const H = 630;
const LON0 = 25; // map centre longitude (degrees)
const LAT0 = 18; // map centre latitude (degrees)
const K = 205; // pixels per radian (world is 2*PI*K wide, cropped to the frame)
const D2R = Math.PI / 180;

const cx = W / 2;
const cy = H / 2 + LAT0 * D2R * K;
const projection = geoEquirectangular().rotate([-LON0, 0]).scale(K).translate([cx, cy]).precision(0.1);

// ---- land rings (d3 clips them at the antimeridian of the rotated map) -----------------
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);
const rings = [];
let current = null;
geoPath(projection, {
  moveTo(x, y) {
    current = [[x, y]];
    rings.push(current);
  },
  lineTo(x, y) {
    current.push([x, y]);
  },
  closePath() {},
  arc() {},
})(land);

// ---- routes and airports ---------------------------------------------------------------
const dataDir = join(ROOT, 'public', 'data', datasetId);
const read = (p) => JSON.parse(readFileSync(join(dataDir, p), 'utf8'));
const manifest = read('manifest.json');
const airports = read('airports.json');
const routes = read('routes.json');
const lastMonth = manifest.months[manifest.months.length - 1];
const month = read(lastMonth.file);

const byId = new Map(airports.map((a) => [a.id, a]));
const flights = new Float64Array(routes.length);
for (const [routeId, , , p, c, u] of month.records) flights[routeId] += p + c + u;
const maxFlights = Math.max(...flights);

const toUnit = (lat, lon) => {
  const c = Math.cos(lat * D2R);
  return [c * Math.sin(lon * D2R), Math.sin(lat * D2R), c * Math.cos(lon * D2R)];
};
const wrap = (a) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};
/** Great circle projected to pixels, longitude unwrapped relative to the start (see utils/geo.ts). */
function arcPixels(a, b, segments = 64) {
  const pa = toUnit(a.lat, a.lon);
  const pb = toUnit(b.lat, b.lon);
  const dot = Math.min(1, Math.max(-1, pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]));
  const ang = Math.acos(dot);
  const sn = Math.sin(ang);
  const lonA = wrap(a.lon * D2R - LON0 * D2R);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wa = sn < 1e-6 ? 1 - t : Math.sin((1 - t) * ang) / sn;
    const wb = sn < 1e-6 ? t : Math.sin(t * ang) / sn;
    const x = wa * pa[0] + wb * pb[0];
    const y = wa * pa[1] + wb * pb[1];
    const z = wa * pa[2] + wb * pb[2];
    const len = Math.hypot(x, y, z);
    const lat = Math.asin(y / len);
    const lon = lonA + wrap(Math.atan2(x, z) - LON0 * D2R - lonA);
    pts.push([cx + lon * K, cy - lat * K]);
  }
  return pts;
}

const routeOut = [];
routes.forEach(([id, ia, ib]) => {
  const f = flights[id];
  if (!f) return;
  routeOut.push({ w: Math.log1p(f) / Math.log1p(maxFlights), flights: f, pts: arcPixels(byId.get(ia), byId.get(ib)) });
});

const airportFlights = new Map();
routes.forEach(([id, ia, ib]) => {
  airportFlights.set(ia, (airportFlights.get(ia) ?? 0) + flights[id]);
  airportFlights.set(ib, (airportFlights.get(ib) ?? 0) + flights[id]);
});
const maxAirport = Math.max(...airportFlights.values());
const airportOut = airports
  .filter((a) => airportFlights.get(a.id))
  .map((a) => ({
    x: cx + wrap(a.lon * D2R - LON0 * D2R) * K,
    y: cy - a.lat * D2R * K,
    w: Math.log1p(airportFlights.get(a.id)) / Math.log1p(maxAirport),
  }));

writeFileSync(
  outPath,
  JSON.stringify({ width: W, height: H, worldWidth: 2 * Math.PI * K, kind: manifest.kind, land: rings, routes: routeOut, airports: airportOut }),
);
console.log(`rings ${rings.length}, routes ${routeOut.length}, airports ${airportOut.length} -> ${outPath}`);
