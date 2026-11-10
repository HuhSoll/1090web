import { PROJECTION_GLSL } from './projection';

/**
 * Base route layer shaders (WebGL2 / GLSL 3).
 *
 * Every route is ONE instance of a shared line-strip template. The template only stores the
 * arc parameter t; the vertex shader builds the route from the per-instance endpoints, both
 * as a raised great-circle arc on the globe and as the projected great circle on the flat map,
 * and blends them with uMorph. Per-route state (weight / highlight) lives in a small RGBA
 * texture indexed by gl_InstanceID, so filters, month changes and selection never touch
 * vertex buffers.
 *
 * Arc shapes must match `arcAltitude()` / `sampleArcFlat()` in src/utils/geo.ts.
 */
export const ROUTE_VERTEX = /* glsl */ `
precision highp float;
precision highp int;

${PROJECTION_GLSL}

in vec3 aStart;
in vec3 aEnd;
/** Route id: index into the state texture (instances may be a compacted subset of routes). */
in float aRouteId;

uniform sampler2D uState;
uniform int uStateWidth;
uniform float uHasSelection;
uniform float uBaseRadius;
uniform float uCompare;

out float vAlpha;
out vec3 vColor;
/** Distance along the arc in dash units; vDashed > 0.5 draws the route dashed. */
out float vDashPos;
out float vDashed;

void main() {
  int id = int(aRouteId + 0.5);
  vDashed = 0.0;
  vDashPos = 0.0;
  vec4 s = texelFetch(uState, ivec2(id % uStateWidth, id / uStateWidth), 0);
  float encoded = s.r;
  if (encoded <= 0.0) {
    // Hidden route: collapse outside the clip volume so it is clipped before rasterisation.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }
  float w = clamp((encoded * 255.0 - 1.0) / 254.0, 0.0, 1.0);
  float connected = s.g;
  // Change category in compare mode (see domain/comparison.ts ChangeKind).
  int kind = int(s.b * 255.0 + 0.5);

  float t = position.x;
  float d = clamp(dot(aStart, aEnd), -1.0, 1.0);
  float ang = acos(d);
  float sn = sin(ang);
  vec3 dir = normalize(sn < 1e-5 ? mix(aStart, aEnd, t) : (sin((1.0 - t) * ang) * aStart + sin(t * ang) * aEnd) / sn);

  vec3 globe = dir * (uBaseRadius + sin(PI * t) * (0.012 + 0.11 * (ang / PI)));

  float lonA = atan(aStart.x, aStart.z);
  float lon = lonA + wrapAngle(atan(dir.x, dir.z) - lonA);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec3 flatP = flatPoint(lat, lon, 0.002 + 0.004 * sin(PI * t));

  vec3 p = morphPoint(globe, flatP);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);

  vec3 low = vec3(0.10, 0.42, 0.78);
  vec3 high = vec3(0.62, 0.92, 1.0);
  vColor = mix(low, high, w * w);
  // Squared weight widens the gap between thin regional routes and trunk routes.
  float alpha = 0.035 + 0.45 * w * w;
  if (uCompare > 0.5) {
    // Diverging, colour-blind-safe: blue = more flights, orange = fewer, grey = unchanged.
    // New and no-longer-seen routes are told apart by line style too, not by hue alone:
    // new = bright near-white solid, gone = dashed orange.
    if (kind == 2) { vColor = vec3(0.30, 0.70, 1.00); alpha *= 1.6; }        // up
    else if (kind == 3) { vColor = vec3(1.00, 0.58, 0.25); alpha *= 1.6; }   // down
    else if (kind == 4) { vColor = vec3(0.80, 1.00, 0.90); alpha = max(alpha * 2.8, 0.22); } // new
    else if (kind == 5) {                                                     // gone
      vColor = vec3(1.00, 0.45, 0.22);
      alpha = max(alpha * 2.8, 0.22);
      vDashed = 1.0;
      // Roughly constant dash length: more dashes on longer arcs.
      vDashPos = t * max(6.0, ang * 90.0);
    }
    else { vColor = vec3(0.45, 0.52, 0.62); alpha *= 0.45; }                // stable
  }
  // When something is selected, everything that is not connected recedes.
  float dim = mix(1.0, mix(0.16, 1.4, connected), uHasSelection);
  // On the globe, arcs near the horizon are seen edge-on and pile up; fade them.
  vec3 worldP = (modelMatrix * vec4(p, 1.0)).xyz;
  float facing = dot(normalize(globe), normalize(cameraPosition - worldP));
  float limb = mix(mix(0.3, 1.0, smoothstep(0.0, 0.45, facing)), 1.0, uMorph);
  vAlpha = alpha * dim * limb;
}
`;

export const ROUTE_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uOpacity;

in float vAlpha;
in vec3 vColor;
in float vDashPos;
in float vDashed;

out vec4 outColor;

void main() {
  if (vAlpha <= 0.0) discard;
  if (vDashed > 0.5 && fract(vDashPos) > 0.55) discard;
  outColor = vec4(vColor * vAlpha * uOpacity, 1.0);
}
`;
