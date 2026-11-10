import * as THREE from 'three';
import { ROUTE_FRAGMENT, ROUTE_VERTEX } from '../shaders/routeShaders';
import type { MorphUniform } from './EarthLayer';
import { Wrapped } from './wrapCopies';

export const ARC_SEGMENTS = 32;
export const ROUTE_BASE_RADIUS = 1.0015;
const STATE_TEXTURE_WIDTH = 1024;

export function densityOpacity(visibleRoutes: number): number {
  if (visibleRoutes <= 0) return 1;
  // Floor of 0.3: real networks concentrate traffic in corridors, so fainter would hide them.
  return Math.min(1, Math.max(0.3, Math.sqrt(600 / visibleRoutes)));
}

/**
 * All routes in a single draw call.
 *
 * Memory per route: 2 x vec3 endpoints (24 bytes) + 4 bytes of state texture. The arc shape is
 * computed on the GPU from a shared 32-segment template, so 50k routes cost ~1.4 MB of buffers
 * regardless of segment count. Filtering/selection only rewrites the state texture.
 */
export class RouteLayer {
  readonly object: THREE.LineSegments;
  readonly wrapped: Wrapped<THREE.LineSegments>;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private stateTexture: THREE.DataTexture;
  private stateData: Uint8Array;
  private routeCount = 0;

  constructor(morph: MorphUniform) {
    this.geometry = new THREE.InstancedBufferGeometry();
    // Template: ARC_SEGMENTS line segments; position.x carries t in [0, 1].
    const template = new Float32Array(ARC_SEGMENTS * 2 * 3);
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      template[i * 6] = i / ARC_SEGMENTS;
      template[i * 6 + 3] = (i + 1) / ARC_SEGMENTS;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(template, 3));
    this.geometry.instanceCount = 0;

    this.stateData = new Uint8Array(STATE_TEXTURE_WIDTH * 4);
    this.stateTexture = this.createStateTexture(1);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ROUTE_VERTEX,
      fragmentShader: ROUTE_FRAGMENT,
      uniforms: {
        uMorph: morph,
        uState: { value: this.stateTexture },
        uStateWidth: { value: STATE_TEXTURE_WIDTH },
        uHasSelection: { value: 0 },
        uBaseRadius: { value: ROUTE_BASE_RADIUS },
        uOpacity: { value: 1 },
        uCompare: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    // Bounding volume is the whole globe + max arc altitude; disable culling recomputation.
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.wrapped = new Wrapped(this.object);
  }

  private createStateTexture(rows: number): THREE.DataTexture {
    const tex = new THREE.DataTexture(this.stateData, STATE_TEXTURE_WIDTH, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Builds per-instance endpoint buffers. Called once per dataset, not per month or filter. */
  setRoutes(endpoints: Float32Array): void {
    const count = endpoints.length / 6;
    this.routeCount = count;
    const start = new Float32Array(count * 3);
    const end = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      start.set(endpoints.subarray(i * 6, i * 6 + 3), i * 3);
      end.set(endpoints.subarray(i * 6 + 3, i * 6 + 6), i * 3);
    }
    this.geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(start, 3));
    this.geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(end, 3));
    this.geometry.instanceCount = count;

    const rows = Math.max(1, Math.ceil(count / STATE_TEXTURE_WIDTH));
    this.stateData = new Uint8Array(rows * STATE_TEXTURE_WIDTH * 4);
    this.stateTexture.dispose();
    this.stateTexture = this.createStateTexture(rows);
    this.material.uniforms.uState!.value = this.stateTexture;
  }

  /**
   * @param weights normalised 0..1 per route; values <= 0 hide the route
   * @param connected optional set of route ids to keep bright while a selection is active
   */
  updateState(weights: Float32Array, connected: ReadonlySet<number> | null, kinds: Uint8Array | null = null): void {
    const data = this.stateData;
    const n = Math.min(this.routeCount, weights.length);
    let visible = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i]!;
      const o = i * 4;
      data[o] = w > 0 ? 1 + Math.round(Math.min(1, w) * 254) : 0;
      data[o + 1] = connected?.has(i) ? 255 : 0;
      data[o + 2] = kinds ? kinds[i]! : 0;
      if (w > 0) visible++;
    }
    this.material.uniforms.uHasSelection!.value = connected ? 1 : 0;
    this.material.uniforms.uCompare!.value = kinds ? 1 : 0;
    // Additive blending saturates as line count grows; scale overall opacity so that density
    // (not raw count) drives brightness. ~1 for hundreds of routes, ~0.1 for 50k.
    this.material.uniforms.uOpacity!.value = densityOpacity(visible);
    this.stateTexture.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.stateTexture.dispose();
  }
}
