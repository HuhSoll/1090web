export const EARTH_VERTEX = /* glsl */ `
precision highp float;

out vec2 vUv;
out vec3 vNormalView;
out vec3 vViewDir;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const EARTH_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uLandMask;
uniform float uHasMask;
uniform vec3 uOcean;
uniform vec3 uLand;
uniform vec3 uRim;

in vec2 vUv;
in vec3 vNormalView;
in vec3 vViewDir;

out vec4 outColor;

void main() {
  float land = uHasMask > 0.5 ? texture(uLandMask, vUv).r : 0.0;
  vec3 color = mix(uOcean, uLand, land);
  float facing = clamp(dot(vNormalView, vViewDir), 0.0, 1.0);
  // Very soft shading towards the limb + a thin cool rim.
  color *= mix(0.55, 1.0, pow(facing, 0.6));
  float rim = pow(1.0 - facing, 3.0);
  color += uRim * rim * 0.55;
  outColor = vec4(color, 1.0);
}
`;

export const ATMOSPHERE_VERTEX = /* glsl */ `
precision highp float;

out vec3 vNormalView;
out vec3 vViewDir;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uFalloff;
uniform float uIntensity;

in vec3 vNormalView;
in vec3 vViewDir;

out vec4 outColor;

void main() {
  // Rendered on the back faces of a slightly larger shell. k is 0 at the shell's silhouette and
  // grows towards the globe's limb, so the glow hugs the planet edge and fades outwards.
  float k = clamp(-dot(vNormalView, vViewDir), 0.0, 1.0);
  float glow = pow(clamp(k / uFalloff, 0.0, 1.0), 2.6);
  outColor = vec4(uColor * glow * uIntensity, 1.0);
}
`;
