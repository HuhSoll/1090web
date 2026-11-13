import * as THREE from 'three';
import { AIRPORT_FRAGMENT, AIRPORT_VERTEX } from '../shaders/airportShaders';
import type { MorphUniform } from './EarthLayer';
import { Wrapped } from './wrapCopies';

export const AIRPORT_RADIUS = 1.002;

export const AirportState = {
  Normal: 0,
  Connected: 1,
  Selected: 2,
  Hovered: 3,
  /** a scenario target (simulation): drawn larger in a warm red */
  Marked: 4,
} as const;

/**
 * All airports as one Points draw call; size and state are per-vertex attributes.
 * Points are soft additive lights. Two things keep dense regions calm:
 * - a declutter mask (computed by the renderer per zoom level) hides small airports that would
 *   overlap a busier one on screen;
 * - uSizeScale grows the points as the user zooms in.
 */
export class AirportLayer {
  readonly object: THREE.Points;
  readonly wrapped: Wrapped<THREE.Points>;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private sizes = new Float32Array(0);
  private baseSizes = new Float32Array(0);
  private mask: Uint8Array = new Uint8Array(0);
  private states = new Float32Array(0);
  /** Unit-sphere positions (xyz) for CPU picking. */
  positions: Float32Array = new Float32Array(0);

  constructor(morph: MorphUniform) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: AIRPORT_VERTEX,
      fragmentShader: AIRPORT_FRAGMENT,
      uniforms: {
        uMorph: morph,
        uRadius: { value: AIRPORT_RADIUS },
        uPixelRatio: { value: 1 },
        uHasSelection: { value: 0 },
        uSizeScale: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.wrapped = new Wrapped(this.object);
  }

  /** @param latLonRad [lat0, lon0, lat1, lon1, ...] in radians */
  setAirports(unitPositions: Float32Array, latLonRad: Float32Array): void {
    const n = unitPositions.length / 3;
    this.positions = unitPositions;
    this.sizes = new Float32Array(n);
    this.baseSizes = new Float32Array(n);
    this.mask = new Uint8Array(n).fill(1);
    this.states = new Float32Array(n);
    // `position` is only used for the draw count; the shader positions points from aLatLon.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(unitPositions, 3));
    this.geometry.setAttribute('aLatLon', new THREE.BufferAttribute(latLonRad, 2));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aState', new THREE.BufferAttribute(this.states, 1));
  }

  /** @param weights normalised 0..1; 0 hides the airport */
  setWeights(weights: Float32Array): void {
    for (let i = 0; i < this.baseSizes.length; i++) {
      const w = weights[i] ?? 0;
      // Visible light size in px at the whole-world view; hubs larger, small airports small.
      this.baseSizes[i] = w > 0 ? 3 + 6 * w * w : 0;
    }
    this.applySizes();
  }

  /** 1 = draw, 0 = hidden by decluttering at the current zoom level. */
  setMask(mask: Uint8Array): void {
    this.mask = mask;
    this.applySizes();
  }

  private applySizes(): void {
    for (let i = 0; i < this.sizes.length; i++) this.sizes[i] = this.mask[i] ? this.baseSizes[i]! : 0;
    this.geometry.getAttribute('aSize').needsUpdate = true;
  }

  /** Has traffic under the current filters (independent of decluttering). */
  hasTraffic(index: number): boolean {
    return (this.baseSizes[index] ?? 0) > 0;
  }

  /** Drawn right now (has traffic and survived decluttering). */
  isDrawn(index: number): boolean {
    return (this.sizes[index] ?? 0) > 0;
  }

  /** Light size at the world view, used to rank airports when decluttering. */
  baseSize(index: number): number {
    return this.baseSizes[index] ?? 0;
  }

  setStates(selected: number | null, hovered: number | null, connected: ReadonlySet<number> | null, marked: readonly number[] = []): void {
    this.states.fill(AirportState.Normal);
    if (connected) for (const i of connected) this.states[i] = AirportState.Connected;
    for (const i of marked) this.states[i] = AirportState.Marked;
    if (hovered !== null) this.states[hovered] = AirportState.Hovered;
    if (selected !== null) this.states[selected] = AirportState.Selected;
    this.material.uniforms.uHasSelection!.value = selected !== null ? 1 : 0;
    this.geometry.getAttribute('aState').needsUpdate = true;
  }

  update(pixelRatio: number, sizeScale: number): void {
    this.material.uniforms.uPixelRatio!.value = pixelRatio;
    this.material.uniforms.uSizeScale!.value = sizeScale;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
