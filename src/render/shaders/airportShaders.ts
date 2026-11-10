import { PROJECTION_GLSL } from './projection';

/**
 * Airport point sprites. State: 0 = normal, 1 = connected to selection, 2 = selected, 3 = hovered.
 * Positions come from aLatLon (radians) so the same buffer works on the globe and the flat map.
 */
export const AIRPORT_VERTEX = /* glsl */ `
precision highp float;

${PROJECTION_GLSL}

in vec2 aLatLon;
in float aSize;
in float aState;

uniform float uPixelRatio;
uniform float uRadius;

out float vState;
out float vVisible;
out float vFacing;
out float vSize;

void main() {
  vState = aState;
  vVisible = aSize > 0.0 ? 1.0 : 0.0;
  vec3 globe = globePoint(aLatLon.x, aLatLon.y, uRadius);
  vec3 p = morphPoint(globe, flatPoint(aLatLon.x, aLatLon.y, 0.008));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // On the globe, fade points as they approach the limb so they do not pile up on the horizon.
  vec3 worldP = (modelMatrix * vec4(p, 1.0)).xyz;
  float facing = clamp(dot(normalize(globe), normalize(cameraPosition - worldP)) * 3.0, 0.0, 1.0);
  vFacing = mix(facing, 1.0, uMorph);
  float size = aSize;
  if (aState >= 2.0) size = max(size, 14.0) + 6.0;
  else if (aState >= 1.0) size += 2.0;
  gl_PointSize = size * uPixelRatio;
  vSize = size;
}
`;

export const AIRPORT_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uHasSelection;

in float vState;
in float vVisible;
in float vFacing;
in float vSize;

out vec4 outColor;

// Markers smaller than this (CSS px) are drawn as a plain dot; a ring would not be legible.
const float RING_MIN_SIZE = 9.0;

// Anti-aliased band between radii a and b (r is 0 at the centre, 1 at the sprite edge).
float band(float r, float a, float b, float aa) {
  return smoothstep(a - aa, a, r) * (1.0 - smoothstep(b, b + aa, r));
}

void main() {
  if (vVisible < 0.5 || vFacing <= 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.2;

  // Marker = bright core + thin outer ring, on a dark halo so it reads over routes and land.
  float core = 1.0 - smoothstep(0.30 - aa, 0.30, r);
  float ring = band(r, 0.58, 0.74, aa);
  float halo = 1.0 - smoothstep(0.86, 1.0, r);

  vec3 color;
  float strength;
  if (vState >= 2.0) {
    // Selected (2) / hovered (3): amber.
    color = vec3(1.0, 0.80, 0.42);
    strength = 1.0;
  } else if (vState >= 1.0) {
    // Connected to the selection.
    color = vec3(0.88, 0.98, 1.0);
    strength = 1.0;
  } else {
    color = vec3(0.62, 0.89, 1.0);
    strength = mix(1.0, 0.35, uHasSelection);
  }

  float mark;
  float haloAlpha;
  if (vSize < RING_MIN_SIZE && vState < 2.0) {
    // Small airport: soft dot, fainter the smaller it is, no halo.
    mark = 1.0 - smoothstep(0.55, 1.0, r);
    strength *= mix(0.45, 0.85, clamp((vSize - 3.0) / (RING_MIN_SIZE - 3.0), 0.0, 1.0));
    haloAlpha = 0.0;
  } else {
    mark = max(core, ring * 0.9);
    haloAlpha = halo * 0.55;
  }
  vec3 rgb = mix(vec3(0.01, 0.03, 0.07), color, mark);
  float alpha = max(mark, haloAlpha) * strength * vFacing;
  outColor = vec4(rgb, alpha);
}
`;
