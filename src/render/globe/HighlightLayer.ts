import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { sampleArc, type Vec3 } from '../../utils/geo';
import { ROUTE_BASE_RADIUS } from './RouteLayer';

const HIGHLIGHT_SEGMENTS = 48;

export interface HighlightRoute {
  routeId: number;
  start: Vec3;
  end: Vec3;
  /** 0..1 normalised weight */
  weight: number;
}

/**
 * Thick, bright lines for the (small) set of routes connected to the selection, plus a focus
 * line for the hovered/selected route. Built on the CPU because the set is tiny compared with
 * the full network; also keeps sampled arcs around for screen-space route picking.
 */
export class HighlightLayer {
  readonly group = new THREE.Group();
  private readonly connected: LineSegments2;
  private readonly focus: LineSegments2;
  private readonly connectedMat: LineMaterial;
  private readonly focusMat: LineMaterial;
  /** routeId -> sampled arc points (xyz flattened) for picking */
  readonly arcs = new Map<number, Float32Array>();

  constructor() {
    this.connectedMat = new LineMaterial({
      linewidth: 1.6,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      worldUnits: false,
    });
    this.focusMat = new LineMaterial({
      linewidth: 3,
      color: 0xffd27a,
      transparent: true,
      depthWrite: false,
      worldUnits: false,
    });
    this.connected = new LineSegments2(new LineSegmentsGeometry(), this.connectedMat);
    this.focus = new LineSegments2(new LineSegmentsGeometry(), this.focusMat);
    for (const o of [this.connected, this.focus]) {
      o.frustumCulled = false;
      o.visible = false;
      this.group.add(o);
    }
    this.connected.renderOrder = 3;
    this.focus.renderOrder = 4;
  }

  setResolution(width: number, height: number): void {
    this.connectedMat.resolution.set(width, height);
    this.focusMat.resolution.set(width, height);
  }

  setConnected(routes: readonly HighlightRoute[]): void {
    this.arcs.clear();
    if (routes.length === 0) {
      this.connected.visible = false;
      return;
    }
    const positions = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const colors = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const low = new THREE.Color('#1f8fd6');
    const high = new THREE.Color('#e9fbff');
    const c = new THREE.Color();
    routes.forEach((r, ri) => {
      const arc = sampleArc(r.start, r.end, HIGHLIGHT_SEGMENTS, ROUTE_BASE_RADIUS + 0.0005);
      this.arcs.set(r.routeId, arc);
      c.copy(low).lerp(high, r.weight).multiplyScalar(0.45 + 0.55 * r.weight);
      for (let s = 0; s < HIGHLIGHT_SEGMENTS; s++) {
        const o = (ri * HIGHLIGHT_SEGMENTS + s) * 6;
        positions.set(arc.subarray(s * 3, s * 3 + 6), o);
        // Brighter in the middle of the arc, softer near the airports.
        const t = (s + 0.5) / HIGHLIGHT_SEGMENTS;
        const k = 0.65 + 0.35 * Math.sin(Math.PI * t);
        colors[o] = c.r * k;
        colors[o + 1] = c.g * k;
        colors[o + 2] = c.b * k;
        colors[o + 3] = c.r * k;
        colors[o + 4] = c.g * k;
        colors[o + 5] = c.b * k;
      }
    });
    this.replaceGeometry(this.connected, positions, colors);
    this.connected.visible = true;
  }

  setFocus(route: { start: Vec3; end: Vec3 } | null): void {
    if (!route) {
      this.focus.visible = false;
      return;
    }
    const arc = sampleArc(route.start, route.end, HIGHLIGHT_SEGMENTS, ROUTE_BASE_RADIUS + 0.001);
    const positions = new Float32Array(HIGHLIGHT_SEGMENTS * 6);
    for (let s = 0; s < HIGHLIGHT_SEGMENTS; s++) positions.set(arc.subarray(s * 3, s * 3 + 6), s * 6);
    this.replaceGeometry(this.focus, positions, null);
    this.focus.visible = true;
  }

  private replaceGeometry(obj: LineSegments2, positions: Float32Array, colors: Float32Array | null): void {
    obj.geometry.dispose();
    const g = new LineSegmentsGeometry();
    g.setPositions(positions);
    if (colors) g.setColors(colors);
    obj.geometry = g;
  }

  dispose(): void {
    this.connected.geometry.dispose();
    this.focus.geometry.dispose();
    this.connectedMat.dispose();
    this.focusMat.dispose();
  }
}
