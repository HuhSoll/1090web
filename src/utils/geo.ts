/**
 * Geographic helpers shared by the data layer and the renderer.
 * Pure functions with no Three.js dependency so they are trivially testable.
 */

export type Vec3 = [number, number, number];

const DEG2RAD = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;

/**
 * Converts latitude/longitude (degrees) to a point on a sphere.
 * Convention (matches the globe texture mapping): +Y is north, lon 0 faces +Z, lon +90 faces +X.
 */
export function latLonToVec3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = lat * DEG2RAD;
  const lambda = lon * DEG2RAD;
  const c = Math.cos(phi);
  return [radius * c * Math.sin(lambda), radius * Math.sin(phi), radius * c * Math.cos(lambda)];
}

export function vec3ToLatLon(v: Vec3): { lat: number; lon: number } {
  const [x, y, z] = v;
  const r = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(y / r) / DEG2RAD, lon: Math.atan2(x, z) / DEG2RAD };
}

/** Central angle between two lat/lon points, in radians. */
export function centralAngle(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG2RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return centralAngle(lat1, lon1, lat2, lon2) * EARTH_RADIUS_KM;
}

/**
 * Arc altitude above the unit sphere at parameter t in [0,1] for a route spanning `angle` radians.
 * MUST stay in sync with the GLSL implementation in render/shaders/routeShaders.ts.
 */
export function arcAltitude(angle: number, t: number): number {
  return Math.sin(Math.PI * t) * (0.012 + 0.11 * (angle / Math.PI));
}

/**
 * Samples a raised great-circle arc between two unit vectors.
 * Returns `segments + 1` points (flattened xyz).
 */
export function sampleArc(a: Vec3, b: Vec3, segments: number, baseRadius = 1): Float32Array {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  const sinA = Math.sin(angle);
  const out = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let wa: number;
    let wb: number;
    if (sinA < 1e-6) {
      wa = 1 - t;
      wb = t;
    } else {
      wa = Math.sin((1 - t) * angle) / sinA;
      wb = Math.sin(t * angle) / sinA;
    }
    const x = wa * a[0] + wb * b[0];
    const y = wa * a[1] + wb * b[1];
    const z = wa * a[2] + wb * b[2];
    const len = Math.hypot(x, y, z) || 1;
    const r = baseRadius + arcAltitude(angle, t);
    out[i * 3] = (x / len) * r;
    out[i * 3 + 1] = (y / len) * r;
    out[i * 3 + 2] = (z / len) * r;
  }
  return out;
}
