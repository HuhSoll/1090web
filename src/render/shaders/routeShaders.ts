/**
 * Base route layer shaders (WebGL2 / GLSL 3).
 *
 * Every route is ONE instance of a shared line-strip template. The template only stores the
 * arc parameter t; the vertex shader builds the raised great-circle arc from the per-instance
 * endpoints. Per-route state (weight / highlight) lives in a small RGBA texture indexed by
 * gl_InstanceID, so filters, month changes and selection never touch vertex buffers.
 *
 * Arc altitude must match `arcAltitude()` in src/utils/geo.ts.
 */
export const ROUTE_VERTEX = /* glsl */ `
precision highp float;
precision highp int;

in vec3 aStart;
in vec3 aEnd;

uniform sampler2D uState;
uniform int uStateWidth;
uniform float uHasSelection;
uniform float uBaseRadius;

out float vAlpha;
out vec3 vColor;

const float PI = 3.141592653589793;

void main() {
  int id = gl_InstanceID;
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

  float t = position.x;
  float d = clamp(dot(aStart, aEnd), -1.0, 1.0);
  float ang = acos(d);
  float sn = sin(ang);
  vec3 p = sn < 1e-5 ? mix(aStart, aEnd, t) : (sin((1.0 - t) * ang) * aStart + sin(t * ang) * aEnd) / sn;
  p = normalize(p) * (uBaseRadius + sin(PI * t) * (0.012 + 0.11 * (ang / PI)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);

  vec3 low = vec3(0.10, 0.42, 0.78);
  vec3 high = vec3(0.62, 0.92, 1.0);
  vColor = mix(low, high, w);
  float alpha = 0.05 + 0.33 * w;
  // When something is selected, everything that is not connected recedes.
  float dim = mix(1.0, mix(0.16, 1.4, connected), uHasSelection);
  // Arcs near the horizon are seen edge-on and pile up; fade them so the limb does not saturate.
  float facing = dot(normalize(p), normalize(cameraPosition - p));
  float limb = mix(0.3, 1.0, smoothstep(0.0, 0.45, facing));
  vAlpha = alpha * dim * limb;
}
`;

export const ROUTE_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uOpacity;

in float vAlpha;
in vec3 vColor;

out vec4 outColor;

void main() {
  if (vAlpha <= 0.0) discard;
  outColor = vec4(vColor * vAlpha * uOpacity, 1.0);
}
`;
