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
/** Grows points as the user zooms in (1 at the whole-world view). */
uniform float uSizeScale;

out float vState;
out float vVisible;
out float vFacing;
out float vSize;

// The sprite is larger than the visible light so the glow can fade to zero before the edge.
const float GLOW_FOOTPRINT = 2.4;

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
  float size = aSize * uSizeScale;
  if (aState >= 2.0) size = max(size, 9.0) + 3.0;
  else if (aState >= 1.0) size += 1.0;
  vSize = size;
  gl_PointSize = size * GLOW_FOOTPRINT * uPixelRatio;
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
  // r = 1 at the edge of the *visible* light (the sprite is GLOW_FOOTPRINT times larger).
  float r = length(gl_PointCoord - 0.5) * 2.0 * 2.4;
  // Soft light instead of a disc: no hard outline, so dense areas read as a glow rather than
  // as a field of holes. A small bright core keeps the exact position readable.
  float glow = exp(-r * r * 1.6);
  float core = exp(-r * r * 9.0);
  float light = glow * 0.55 + core * 0.75;
  if (light < 0.01) discard;

  vec3 color;
  float strength;
  if (vState >= 3.5) {
    color = vec3(1.0, 0.38, 0.28); // scenario target (simulation): warm red
    strength = 1.4;
  } else if (vState >= 2.0) {
    color = vec3(1.0, 0.80, 0.42); // selected / hovered: amber
    strength = 1.3;
  } else if (vState >= 1.0) {
    color = vec3(0.88, 0.98, 1.0); // connected to the selection
    strength = 1.0;
  } else {
    color = vec3(0.62, 0.89, 1.0);
    strength = mix(1.0, 0.3, uHasSelection);
  }
  outColor = vec4(color * light * strength * vFacing, 1.0);
}
`;
