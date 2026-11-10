#!/usr/bin/env node
/**
 * Generates the Phase 1 DEMO dataset into public/data/demo/.
 *
 * IMPORTANT
 * - Airport identities and coordinates are real-world reference points (approximate,
 *   hand-entered) used only so the globe looks geographically correct.
 * - Routes, carriers and flight counts are SYNTHETIC. They are produced by a seeded
 *   random generator and must never be presented as real aviation statistics.
 * - Carriers are fictional ("Demo ...") on purpose, to avoid attributing invented
 *   routes to real airlines.
 *
 * The output layout intentionally mirrors the planned production layout so the
 * frontend loading path is identical (see src/data/model/schema.ts):
 *   manifest.json         dataset metadata, months, sources, disclaimers
 *   airports.json         airport table
 *   routes.json           undirected airport-pair universe (geometry is built once from this)
 *   months/YYYY-MM.json   per-month directed records referencing route ids
 *
 * Usage: node scripts/generate-demo-data.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'demo');
const SEED = 20260101;
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

// [iata, icao, name, city, countryIso2, lat, lon, tier(1=mega hub..3=regional), region, cargoHub]
const AIRPORTS = [
  ['HND', 'RJTT', 'Tokyo Haneda', 'Tokyo', 'JP', 35.5523, 139.7798, 1, 'EAS', false],
  ['NRT', 'RJAA', 'Narita International', 'Narita', 'JP', 35.7647, 140.3864, 1, 'EAS', true],
  ['KIX', 'RJBB', 'Kansai International', 'Osaka', 'JP', 34.4347, 135.244, 2, 'EAS', true],
  ['ITM', 'RJOO', 'Osaka Itami', 'Osaka', 'JP', 34.7855, 135.4382, 3, 'EAS', false],
  ['NGO', 'RJGG', 'Chubu Centrair', 'Nagoya', 'JP', 34.8584, 136.8054, 3, 'EAS', false],
  ['CTS', 'RJCC', 'New Chitose', 'Sapporo', 'JP', 42.7752, 141.6923, 2, 'EAS', false],
  ['FUK', 'RJFF', 'Fukuoka', 'Fukuoka', 'JP', 33.5859, 130.4511, 2, 'EAS', false],
  ['OKA', 'ROAH', 'Naha', 'Naha', 'JP', 26.1958, 127.6459, 3, 'EAS', false],
  ['ICN', 'RKSI', 'Incheon International', 'Seoul', 'KR', 37.4602, 126.4407, 1, 'EAS', true],
  ['GMP', 'RKSS', 'Gimpo International', 'Seoul', 'KR', 37.5583, 126.7906, 3, 'EAS', false],
  ['PEK', 'ZBAA', 'Beijing Capital', 'Beijing', 'CN', 40.0801, 116.5846, 1, 'EAS', false],
  ['PKX', 'ZBAD', 'Beijing Daxing', 'Beijing', 'CN', 39.5098, 116.4105, 2, 'EAS', false],
  ['PVG', 'ZSPD', 'Shanghai Pudong', 'Shanghai', 'CN', 31.1443, 121.8083, 1, 'EAS', true],
  ['SHA', 'ZSSS', 'Shanghai Hongqiao', 'Shanghai', 'CN', 31.1979, 121.3363, 2, 'EAS', false],
  ['CAN', 'ZGGG', 'Guangzhou Baiyun', 'Guangzhou', 'CN', 23.3924, 113.2988, 1, 'EAS', false],
  ['SZX', 'ZGSZ', "Shenzhen Bao'an", 'Shenzhen', 'CN', 22.6393, 113.8107, 2, 'EAS', false],
  ['CTU', 'ZUUU', 'Chengdu Shuangliu', 'Chengdu', 'CN', 30.5785, 103.9471, 2, 'EAS', false],
  ['HKG', 'VHHH', 'Hong Kong International', 'Hong Kong', 'HK', 22.308, 113.9185, 1, 'EAS', true],
  ['TPE', 'RCTP', 'Taoyuan International', 'Taipei', 'TW', 25.0777, 121.2328, 2, 'EAS', true],
  ['MNL', 'RPLL', 'Ninoy Aquino International', 'Manila', 'PH', 14.5086, 121.0198, 2, 'SEA', false],
  ['BKK', 'VTBS', 'Suvarnabhumi', 'Bangkok', 'TH', 13.69, 100.7501, 1, 'SEA', false],
  ['SIN', 'WSSS', 'Changi', 'Singapore', 'SG', 1.3644, 103.9915, 1, 'SEA', true],
  ['KUL', 'WMKK', 'Kuala Lumpur International', 'Kuala Lumpur', 'MY', 2.7456, 101.7099, 2, 'SEA', false],
  ['CGK', 'WIII', 'Soekarno-Hatta', 'Jakarta', 'ID', -6.1256, 106.6559, 2, 'SEA', false],
  ['DPS', 'WADD', 'Ngurah Rai', 'Denpasar', 'ID', -8.7482, 115.1672, 3, 'SEA', false],
  ['SGN', 'VVTS', 'Tan Son Nhat', 'Ho Chi Minh City', 'VN', 10.8188, 106.652, 2, 'SEA', false],
  ['HAN', 'VVNB', 'Noi Bai', 'Hanoi', 'VN', 21.2212, 105.8072, 3, 'SEA', false],
  ['DEL', 'VIDP', 'Indira Gandhi International', 'Delhi', 'IN', 28.5562, 77.1, 1, 'SAS', false],
  ['BOM', 'VABB', 'Chhatrapati Shivaji Maharaj International', 'Mumbai', 'IN', 19.0896, 72.8656, 2, 'SAS', false],
  ['BLR', 'VOBL', 'Kempegowda International', 'Bengaluru', 'IN', 13.1986, 77.7066, 3, 'SAS', false],
  ['DXB', 'OMDB', 'Dubai International', 'Dubai', 'AE', 25.2532, 55.3657, 1, 'MEA', true],
  ['AUH', 'OMAA', 'Zayed International', 'Abu Dhabi', 'AE', 24.433, 54.6511, 2, 'MEA', false],
  ['DOH', 'OTHH', 'Hamad International', 'Doha', 'QA', 25.2731, 51.6081, 1, 'MEA', true],
  ['IST', 'LTFM', 'Istanbul Airport', 'Istanbul', 'TR', 41.2753, 28.7519, 1, 'EUR', false],
  ['LHR', 'EGLL', 'Heathrow', 'London', 'GB', 51.47, -0.4543, 1, 'EUR', false],
  ['LGW', 'EGKK', 'Gatwick', 'London', 'GB', 51.1537, -0.1821, 2, 'EUR', false],
  ['CDG', 'LFPG', 'Charles de Gaulle', 'Paris', 'FR', 49.0097, 2.5479, 1, 'EUR', true],
  ['AMS', 'EHAM', 'Schiphol', 'Amsterdam', 'NL', 52.3105, 4.7683, 1, 'EUR', true],
  ['FRA', 'EDDF', 'Frankfurt', 'Frankfurt', 'DE', 50.0379, 8.5622, 1, 'EUR', true],
  ['MUC', 'EDDM', 'Munich', 'Munich', 'DE', 48.3537, 11.775, 2, 'EUR', false],
  ['LEJ', 'EDDP', 'Leipzig/Halle', 'Leipzig', 'DE', 51.4239, 12.2364, 3, 'EUR', true],
  ['MAD', 'LEMD', 'Adolfo Suárez Madrid-Barajas', 'Madrid', 'ES', 40.4983, -3.5676, 1, 'EUR', false],
  ['BCN', 'LEBL', 'Josep Tarradellas Barcelona-El Prat', 'Barcelona', 'ES', 41.2974, 2.0833, 2, 'EUR', false],
  ['FCO', 'LIRF', 'Leonardo da Vinci–Fiumicino', 'Rome', 'IT', 41.8003, 12.2389, 2, 'EUR', false],
  ['ZRH', 'LSZH', 'Zurich', 'Zurich', 'CH', 47.4582, 8.5555, 2, 'EUR', false],
  ['VIE', 'LOWW', 'Vienna International', 'Vienna', 'AT', 48.1103, 16.5697, 2, 'EUR', false],
  ['CPH', 'EKCH', 'Copenhagen', 'Copenhagen', 'DK', 55.618, 12.6508, 2, 'EUR', false],
  ['HEL', 'EFHK', 'Helsinki-Vantaa', 'Helsinki', 'FI', 60.3172, 24.9633, 2, 'EUR', false],
  ['LIS', 'LPPT', 'Humberto Delgado', 'Lisbon', 'PT', 38.7742, -9.1342, 2, 'EUR', false],
  ['DUB', 'EIDW', 'Dublin', 'Dublin', 'IE', 53.4264, -6.2499, 2, 'EUR', false],
  ['JFK', 'KJFK', 'John F. Kennedy International', 'New York', 'US', 40.6413, -73.7781, 1, 'NAM', true],
  ['EWR', 'KEWR', 'Newark Liberty International', 'Newark', 'US', 40.6895, -74.1745, 2, 'NAM', false],
  ['BOS', 'KBOS', 'Logan International', 'Boston', 'US', 42.3656, -71.0096, 2, 'NAM', false],
  ['ATL', 'KATL', 'Hartsfield-Jackson Atlanta International', 'Atlanta', 'US', 33.6407, -84.4277, 1, 'NAM', false],
  ['ORD', 'KORD', "O'Hare International", 'Chicago', 'US', 41.9742, -87.9073, 1, 'NAM', true],
  ['DFW', 'KDFW', 'Dallas/Fort Worth International', 'Dallas', 'US', 32.8998, -97.0403, 1, 'NAM', false],
  ['DEN', 'KDEN', 'Denver International', 'Denver', 'US', 39.8561, -104.6737, 2, 'NAM', false],
  ['LAX', 'KLAX', 'Los Angeles International', 'Los Angeles', 'US', 33.9416, -118.4085, 1, 'NAM', true],
  ['SFO', 'KSFO', 'San Francisco International', 'San Francisco', 'US', 37.6213, -122.379, 2, 'NAM', false],
  ['SEA', 'KSEA', 'Seattle-Tacoma International', 'Seattle', 'US', 47.4502, -122.3088, 2, 'NAM', false],
  ['MIA', 'KMIA', 'Miami International', 'Miami', 'US', 25.7959, -80.287, 2, 'NAM', true],
  ['ANC', 'PANC', 'Ted Stevens Anchorage International', 'Anchorage', 'US', 61.1743, -149.9963, 3, 'NAM', true],
  ['MEM', 'KMEM', 'Memphis International', 'Memphis', 'US', 35.0424, -89.9767, 3, 'NAM', true],
  ['SDF', 'KSDF', 'Louisville Muhammad Ali International', 'Louisville', 'US', 38.1744, -85.736, 3, 'NAM', true],
  ['HNL', 'PHNL', 'Daniel K. Inouye International', 'Honolulu', 'US', 21.3187, -157.9225, 2, 'OCE', false],
  ['YYZ', 'CYYZ', 'Toronto Pearson International', 'Toronto', 'CA', 43.6777, -79.6248, 1, 'NAM', false],
  ['YVR', 'CYVR', 'Vancouver International', 'Vancouver', 'CA', 49.1967, -123.1815, 2, 'NAM', false],
  ['MEX', 'MMMX', 'Mexico City International', 'Mexico City', 'MX', 19.4361, -99.0719, 1, 'LAM', false],
  ['CUN', 'MMUN', 'Cancún International', 'Cancún', 'MX', 21.0365, -86.8771, 2, 'LAM', false],
  ['PTY', 'MPTO', 'Tocumen International', 'Panama City', 'PA', 9.0714, -79.3835, 2, 'LAM', false],
  ['BOG', 'SKBO', 'El Dorado International', 'Bogotá', 'CO', 4.7016, -74.1469, 2, 'LAM', false],
  ['LIM', 'SPJC', 'Jorge Chávez International', 'Lima', 'PE', -12.0219, -77.1143, 2, 'LAM', false],
  ['GRU', 'SBGR', 'São Paulo/Guarulhos International', 'São Paulo', 'BR', -23.4356, -46.4731, 1, 'LAM', true],
  ['GIG', 'SBGL', 'Rio de Janeiro/Galeão International', 'Rio de Janeiro', 'BR', -22.809, -43.2506, 2, 'LAM', false],
  ['EZE', 'SAEZ', 'Ministro Pistarini International', 'Buenos Aires', 'AR', -34.8222, -58.5358, 2, 'LAM', false],
  ['SCL', 'SCEL', 'Arturo Merino Benítez International', 'Santiago', 'CL', -33.393, -70.7858, 2, 'LAM', false],
  ['JNB', 'FAOR', 'O. R. Tambo International', 'Johannesburg', 'ZA', -26.1392, 28.246, 1, 'AFR', false],
  ['CPT', 'FACT', 'Cape Town International', 'Cape Town', 'ZA', -33.9715, 18.6021, 2, 'AFR', false],
  ['ADD', 'HAAB', 'Addis Ababa Bole International', 'Addis Ababa', 'ET', 8.9779, 38.7993, 1, 'AFR', true],
  ['NBO', 'HKJK', 'Jomo Kenyatta International', 'Nairobi', 'KE', -1.3192, 36.9278, 2, 'AFR', false],
  ['CAI', 'HECA', 'Cairo International', 'Cairo', 'EG', 30.1219, 31.4056, 2, 'AFR', false],
  ['CMN', 'GMMN', 'Mohammed V International', 'Casablanca', 'MA', 33.3675, -7.5898, 2, 'AFR', false],
  ['LOS', 'DNMM', 'Murtala Muhammed International', 'Lagos', 'NG', 6.5774, 3.3212, 2, 'AFR', false],
  ['SYD', 'YSSY', 'Sydney Kingsford Smith', 'Sydney', 'AU', -33.9399, 151.1753, 1, 'OCE', false],
  ['MEL', 'YMML', 'Melbourne', 'Melbourne', 'AU', -37.669, 144.841, 2, 'OCE', false],
  ['BNE', 'YBBN', 'Brisbane', 'Brisbane', 'AU', -27.3842, 153.1175, 2, 'OCE', false],
  ['PER', 'YPPH', 'Perth', 'Perth', 'AU', -31.9385, 115.9672, 3, 'OCE', false],
  ['AKL', 'NZAA', 'Auckland', 'Auckland', 'NZ', -37.0082, 174.785, 2, 'OCE', false],
];

// Fictional carriers. regions: where they are based. cargo: freighter-only operator.
const CARRIERS = [
  { id: 'demo-aurora', name: 'Demo Aurora Air', regions: ['EAS', 'SEA', 'OCE'], cargo: false },
  { id: 'demo-meridian', name: 'Demo Meridian Airways', regions: ['EUR', 'MEA', 'AFR'], cargo: false },
  { id: 'demo-polaris', name: 'Demo Polaris Airlines', regions: ['NAM', 'LAM'], cargo: false },
  { id: 'demo-monsoon', name: 'Demo Monsoon Air', regions: ['SAS', 'MEA', 'SEA'], cargo: false },
  { id: 'demo-zephyr', name: 'Demo Zephyr Connect', regions: ['EUR', 'NAM', 'EAS'], cargo: false },
  { id: 'demo-freight', name: 'Demo Freight Lines', regions: [], cargo: true },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const rand = mulberry32(SEED);
const ap = AIRPORTS.map(([iata, icao, name, city, country, lat, lon, tier, region, cargoHub]) => ({
  iata, icao, name, city, country, lat, lon, tier, region, cargoHub,
}));

// ---- 1. Route universe (undirected pairs) --------------------------------------------
const routes = [];
const degree = new Array(ap.length).fill(0);
for (let i = 0; i < ap.length; i++) {
  for (let j = i + 1; j < ap.length; j++) {
    const a = ap[i];
    const b = ap[j];
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (km < 150) continue; // same-city pairs are not interesting for the demo
    const sameRegion = a.region === b.region;
    const hubScore = (4 - a.tier) * (4 - b.tier); // 1..9
    let p = 0.02 * hubScore * (sameRegion ? 2.4 : 1) * (km > 12000 ? 0.45 : 1);
    if (a.cargoHub && b.cargoHub) p += 0.08;
    if (rand() < Math.min(0.92, p)) {
      routes.push({ a: i, b: j, km });
      degree[i]++;
      degree[j]++;
    }
  }
}
// Guarantee every airport has at least 3 connections (to nearest larger hubs).
for (let i = 0; i < ap.length; i++) {
  if (degree[i] >= 3) continue;
  const candidates = ap
    .map((b, j) => ({ j, km: haversineKm(ap[i].lat, ap[i].lon, b.lat, b.lon), tier: b.tier }))
    .filter((c) => c.j !== i && c.km > 150 && c.tier <= 2)
    .sort((x, y) => x.km - y.km);
  for (const c of candidates) {
    if (degree[i] >= 3) break;
    const [a, b] = i < c.j ? [i, c.j] : [c.j, i];
    if (routes.some((r) => r.a === a && r.b === b)) continue;
    routes.push({ a, b, km: c.km });
    degree[i]++;
    degree[c.j]++;
  }
}
routes.sort((x, y) => x.a - y.a || x.b - y.b);

// ---- 2. Static per-route attributes (carriers, base volume, seasonality) ---------------
const routeProfiles = routes.map((r) => {
  const a = ap[r.a];
  const b = ap[r.b];
  const pax = CARRIERS.filter((c) => !c.cargo && (c.regions.includes(a.region) || c.regions.includes(b.region)));
  const pool = pax.length > 0 ? pax : CARRIERS.filter((c) => !c.cargo);
  const carriers = [];
  const first = pool[Math.floor(rand() * pool.length)];
  carriers.push(first.id);
  if (rand() < 0.35 && pool.length > 1) {
    const second = pool[Math.floor(rand() * pool.length)];
    if (second.id !== first.id) carriers.push(second.id);
  }
  const hasCargo = (a.cargoHub || b.cargoHub) && rand() < (a.cargoHub && b.cargoHub ? 0.75 : 0.25);
  const distanceDecay = r.km < 1500 ? 1.6 : r.km < 5000 ? 1 : r.km < 9000 ? 0.55 : 0.35;
  const base = Math.max(6, Math.round((4 - a.tier) * (4 - b.tier) * 14 * distanceDecay * (0.5 + rand())));
  const seasonal = rand() < 0.08; // some routes only operate part of the year
  const phase = rand() * Math.PI * 2;
  return { carriers, hasCargo, base, seasonal, phase };
});

// ---- 3. Monthly directed records ------------------------------------------------------
const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

mkdirSync(join(OUT, 'months'), { recursive: true });
const monthSummaries = [];
MONTHS.forEach((month, mi) => {
  const days = daysInMonth(month);
  const records = [];
  routes.forEach((r, routeId) => {
    const prof = routeProfiles[routeId];
    if (prof.seasonal && Math.sin(mi * 0.6 + prof.phase) < -0.2) return;
    const season = 1 + 0.12 * Math.sin(((mi - 3) / 12) * Math.PI * 2) + (rand() - 0.5) * 0.12;
    const monthly = prof.base * season * (days / 30);
    prof.carriers.forEach((carrierId, ci) => {
      const share = prof.carriers.length === 1 ? 1 : ci === 0 ? 0.65 : 0.35;
      for (const dir of [0, 1]) {
        const v = monthly * share * 0.5 * (0.92 + rand() * 0.16);
        const passenger = Math.round(v * 0.97);
        const unknown = Math.round(v * 0.03 * rand() * 2);
        if (passenger + unknown <= 0) continue;
        records.push([routeId, dir, carrierId, passenger, 0, unknown]);
      }
    });
    if (prof.hasCargo) {
      for (const dir of [0, 1]) {
        const cargo = Math.round((2 + rand() * 10) * (days / 30));
        if (cargo > 0) records.push([routeId, dir, 'demo-freight', 0, cargo, 0]);
      }
    }
  });
  const file = {
    month,
    observedDays: days,
    recordColumns: ['routeId', 'direction', 'carrierId', 'passenger', 'cargo', 'unknown'],
    records,
  };
  writeFileSync(join(OUT, 'months', `${month}.json`), JSON.stringify(file));
  monthSummaries.push({ month, file: `months/${month}.json`, observedDays: days, recordCount: records.length });
});

// ---- 4. Static tables + manifest ----------------------------------------------------
writeFileSync(
  join(OUT, 'airports.json'),
  JSON.stringify(
    ap.map(({ iata, icao, name, city, country, lat, lon }) => ({ id: iata, iata, icao, name, city, country, lat, lon })),
  ),
);
writeFileSync(join(OUT, 'routes.json'), JSON.stringify(routes.map((r, id) => [id, ap[r.a].iata, ap[r.b].iata])));

const manifest = {
  schemaVersion: 1,
  datasetId: 'demo-2026',
  kind: 'demo',
  title: 'AeroGraph demo dataset (synthetic)',
  generatedAt: '2026-11-10T00:00:00Z',
  generator: 'scripts/generate-demo-data.mjs',
  seed: SEED,
  months: monthSummaries,
  carriers: CARRIERS.map(({ id, name, cargo }) => ({ id, name, operatorType: cargo ? 'cargo' : 'passenger' })),
  sources: [
    {
      id: 'demo-synthetic',
      name: 'Synthetic demo values',
      description:
        'Routes, carriers and flight counts are randomly generated for UI development. They are not observations.',
      license: 'n/a',
    },
    {
      id: 'airport-reference',
      name: 'Hand-entered airport reference points',
      description:
        'Approximate airport coordinates entered for the demo. Will be replaced by OurAirports data in Phase 2.',
      license: 'n/a',
    },
  ],
  disclaimer:
    'DEMO DATA: all flight counts, routes and carriers are synthetic and must not be read as real aviation statistics.',
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`airports: ${ap.length}, routes: ${routes.length}, months: ${MONTHS.length}`);
console.log(`records per month: ${monthSummaries.map((m) => m.recordCount).join(', ')}`);
