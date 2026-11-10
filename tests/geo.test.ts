import { describe, expect, it } from 'vitest';
import { arcAltitude, centralAngle, greatCircleKm, latLonToVec3, sampleArc, vec3ToLatLon } from '../src/utils/geo';

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
