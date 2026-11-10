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
  if (aState >= 2.0) size = max(size, 10.0) + 7.0;
  else if (aState >= 1.0) size += 2.0;
  gl_PointSize = size * uPixelRatio;
}
`;

export const AIRPORT_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uHasSelection;

in float vState;
in float vVisible;
in float vFacing;

out vec4 outColor;

void main() {
  if (vVisible < 0.5 || vFacing <= 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;

  vec3 color;
  float alpha;
  if (vState >= 2.0) {
    // Selected (2) / hovered (3): amber core with a thin ring.
    float core = smoothstep(0.42, 0.30, r);
    float ring = smoothstep(0.62, 0.72, r) * smoothstep(1.0, 0.86, r);
    color = vec3(1.0, 0.80, 0.42);
    alpha = max(core, ring * 0.9);
  } else {
    float soft = smoothstep(1.0, 0.35, r);
    color = vState >= 1.0 ? vec3(0.85, 0.97, 1.0) : vec3(0.55, 0.85, 1.0);
    float base = vState >= 1.0 ? 1.0 : mix(0.75, 0.25, uHasSelection);
    alpha = soft * base;
  }
  outColor = vec4(color, alpha * vFacing);
}
`;
