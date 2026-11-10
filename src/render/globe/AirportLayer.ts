import * as THREE from 'three';
import { AIRPORT_FRAGMENT, AIRPORT_VERTEX } from '../shaders/airportShaders';

export const AIRPORT_RADIUS = 1.002;

export const AirportState = {
  Normal: 0,
  Connected: 1,
  Selected: 2,
  Hovered: 3,
} as const;

/** All airports as one Points draw call; size and state are per-vertex attributes. */
export class AirportLayer {
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private sizes = new Float32Array(0);
  private states = new Float32Array(0);
  /** Unit-sphere positions (xyz) for CPU picking. */
  positions: Float32Array = new Float32Array(0);

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: AIRPORT_VERTEX,
      fragmentShader: AIRPORT_FRAGMENT,
      uniforms: {
        uPixelRatio: { value: 1 },
        uHasSelection: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
  }

  setAirports(unitPositions: Float32Array): void {
    const n = unitPositions.length / 3;
    this.positions = unitPositions;
    const scaled = new Float32Array(unitPositions.length);
    for (let i = 0; i < unitPositions.length; i++) scaled[i] = unitPositions[i]! * AIRPORT_RADIUS;
    this.sizes = new Float32Array(n);
    this.states = new Float32Array(n);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(scaled, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aState', new THREE.BufferAttribute(this.states, 1));
  }

  /** @param weights normalised 0..1; 0 hides the airport */
  setWeights(weights: Float32Array): void {
    for (let i = 0; i < this.sizes.length; i++) {
      const w = weights[i] ?? 0;
      this.sizes[i] = w > 0 ? 3.6 + 7.5 * Math.sqrt(w) : 0;
    }
    this.geometry.getAttribute('aSize').needsUpdate = true;
  }

  isVisible(index: number): boolean {
    return (this.sizes[index] ?? 0) > 0;
  }

  setStates(selected: number | null, hovered: number | null, connected: ReadonlySet<number> | null): void {
    this.states.fill(AirportState.Normal);
    if (connected) for (const i of connected) this.states[i] = AirportState.Connected;
    if (hovered !== null) this.states[hovered] = AirportState.Hovered;
    if (selected !== null) this.states[selected] = AirportState.Selected;
    this.material.uniforms.uHasSelection!.value = selected !== null ? 1 : 0;
    this.geometry.getAttribute('aState').needsUpdate = true;
  }

  update(pixelRatio: number, cameraPos: THREE.Vector3): void {
    this.material.uniforms.uPixelRatio!.value = pixelRatio;
    (this.material.uniforms.uCameraPos!.value as THREE.Vector3).copy(cameraPos);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
