/**
 * GLSL helpers shared by every layer that can morph between the globe and the flat map.
 * uMorph = 0 -> globe, 1 -> flat (equirectangular, radians, z = 0 plane).
 * Must stay in sync with src/utils/geo.ts (latLonToVec3, sampleArcFlat, flatLift).
 */
export const PROJECTION_GLSL = /* glsl */ `
const float PI = 3.141592653589793;

uniform float uMorph;

// lat/lon in radians -> point on a sphere of radius r (+Y north, lon 0 faces +Z).
vec3 globePoint(float lat, float lon, float r) {
  float c = cos(lat);
  return vec3(r * c * sin(lon), r * sin(lat), r * c * cos(lon));
}

vec3 flatPoint(float lat, float lon, float z) {
  return vec3(lon, lat, z);
}

float wrapAngle(float a) {
  return mod(a + PI, 2.0 * PI) - PI;
}

vec3 morphPoint(vec3 globe, vec3 flat_) {
  // Smoothstep keeps the start/end of the transition calm.
  float m = smoothstep(0.0, 1.0, uMorph);
  return mix(globe, flat_, m);
}
`;
