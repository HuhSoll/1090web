import { describe, expect, it } from 'vitest';
import {
  arcAltitude,
  centralAngle,
  greatCircleKm,
  latLonToVec3,
  sampleArc,
  sampleArcFlat,
  vec3ToLatLon,
  wrapAngle,
} from '../src/utils/geo';

describe('latLonToVec3', () => {
  it('maps cardinal points to the expected axes', () => {
    const north = latLonToVec3(90, 0);
    expect(north[1]).toBeCloseTo(1);
    const lon0 = latLonToVec3(0, 0);
    expect(lon0[2]).toBeCloseTo(1);
    const lon90 = latLonToVec3(0, 90);
    expect(lon90[0]).toBeCloseTo(1);
  });

  it('round-trips through vec3ToLatLon', () => {
    for (const [lat, lon] of [
      [35.55, 139.78],
      [-33.94, 151.17],
      [51.47, -0.45],
      [-54.8, -68.3],
    ] as const) {
      const back = vec3ToLatLon(latLonToVec3(lat, lon));
      expect(back.lat).toBeCloseTo(lat, 6);
      expect(back.lon).toBeCloseTo(lon, 6);
    }
  });

  it('respects the radius', () => {
    const v = latLonToVec3(10, 20, 2.5);
    expect(Math.hypot(...v)).toBeCloseTo(2.5);
  });
});

describe('great-circle distance', () => {
  it('HND–LHR is about 9,600 km', () => {
    const km = greatCircleKm(35.5523, 139.7798, 51.47, -0.4543);
    expect(km).toBeGreaterThan(9500);
    expect(km).toBeLessThan(9700);
  });

  it('antipodes are π apart', () => {
    expect(centralAngle(0, 0, 0, 180)).toBeCloseTo(Math.PI);
  });
});

describe('sampleArc', () => {
  it('starts and ends on the endpoints at the base radius', () => {
    const a = latLonToVec3(35, 139);
    const b = latLonToVec3(40, -74);
    const arc = sampleArc(a, b, 16, 1);
    expect(arc.length).toBe(17 * 3);
    expect(arc[0]).toBeCloseTo(a[0]);
    expect(arc[1]).toBeCloseTo(a[1]);
    expect(arc[2]).toBeCloseTo(a[2]);
    expect(arc[48]).toBeCloseTo(b[0]);
    expect(arc[49]).toBeCloseTo(b[1]);
    expect(arc[50]).toBeCloseTo(b[2]);
  });

  it('rises highest at the midpoint, more for longer routes', () => {
    const a = latLonToVec3(0, 0);
    const near = sampleArc(a, latLonToVec3(0, 10), 8);
    const far = sampleArc(a, latLonToVec3(0, 120), 8);
    const radiusAt = (arc: Float32Array, i: number) => Math.hypot(arc[i * 3]!, arc[i * 3 + 1]!, arc[i * 3 + 2]!);
    expect(radiusAt(near, 4)).toBeGreaterThan(radiusAt(near, 1));
    expect(radiusAt(far, 4)).toBeGreaterThan(radiusAt(near, 4));
    expect(arcAltitude(Math.PI, 0.5)).toBeLessThan(0.15);
  });
});

describe('flat map projection', () => {
  const D = Math.PI / 180;

  it('wraps angles into [-PI, PI)', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle(Math.PI * 4 + 0.1)).toBeCloseTo(0.1);
  });

  it('maps endpoints to (lon, lat) in radians', () => {
    const arc = sampleArcFlat(latLonToVec3(35.55, 139.78), latLonToVec3(51.47, -0.45), 20);
    expect(arc[0]).toBeCloseTo(139.78 * D, 4);
    expect(arc[1]).toBeCloseTo(35.55 * D, 4);
    expect(arc[60]).toBeCloseTo(-0.45 * D, 4);
    expect(arc[61]).toBeCloseTo(51.47 * D, 4);
  });

  it('follows the great circle poleward', () => {
    // Tokyo–London bends north of both endpoints on an equirectangular map.
    const arc = sampleArcFlat(latLonToVec3(35.55, 139.78), latLonToVec3(51.47, -0.45), 20);
    expect(arc[10 * 3 + 1]!).toBeGreaterThan(60 * D);
  });

  it('crosses the antimeridian as one continuous line', () => {
    // Tokyo -> Los Angeles: longitude keeps increasing past +PI instead of jumping to -PI.
    const arc = sampleArcFlat(latLonToVec3(35.55, 139.78), latLonToVec3(33.94, -118.41), 32);
    for (let i = 1; i <= 32; i++) expect(arc[i * 3]!).toBeGreaterThan(arc[(i - 1) * 3]!);
    expect(arc[32 * 3]!).toBeCloseTo((360 - 118.41) * D, 4);
  });
});
