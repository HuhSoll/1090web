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
  if (aState >= 2.0) size = max(size, 8.0) + 4.0;
  else if (aState >= 1.0) size += 1.5;
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

void main() {
  if (vVisible < 0.5 || vFacing <= 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.2;

  // Plain filled dots (no rings: dense clusters of rings are hard to look at).
  float dot_ = 1.0 - smoothstep(1.0 - aa * 1.5, 1.0, r);

  vec3 color;
  float alpha;
  if (vState >= 2.0) {
    // Selected (2) / hovered (3): amber dot with a thin dark edge so it stands out.
    float edge = smoothstep(0.72, 0.8, r);
    color = mix(vec3(1.0, 0.80, 0.42), vec3(0.02, 0.04, 0.08), edge * 0.8);
    alpha = dot_;
  } else if (vState >= 1.0) {
    color = vec3(0.88, 0.98, 1.0);
    alpha = dot_;
  } else {
    color = vec3(0.62, 0.89, 1.0);
    // Smaller (quieter) airports are fainter; everything recedes while something is selected.
    float quiet = mix(0.5, 0.95, clamp((vSize - 2.5) / 7.0, 0.0, 1.0));
    alpha = dot_ * quiet * mix(1.0, 0.35, uHasSelection);
  }
  outColor = vec4(color, alpha * vFacing);
}
`;
