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

interface Palette {
  low: THREE.Color;
  high: THREE.Color;
  /** brightness at weight 0 (scaled up to 1 at weight 1) */
  floor: number;
}

const CONNECTED_PALETTE: Palette = { low: new THREE.Color('#1f8fd6'), high: new THREE.Color('#e9fbff'), floor: 0.45 };
const NOTABLE_PALETTE: Palette = { low: new THREE.Color('#2a9be0'), high: new THREE.Color('#d9f6ff'), floor: 0.35 };

/**
 * Thick lines for small route subsets, built on the CPU (each set is tiny compared with the
 * full network). Three tiers, bottom to top:
 * - notable:   the highest-volume routes of the current view, always slightly thicker
 * - connected: routes touching the selected airport
 * - focus:     the hovered / selected route
 * Sampled arcs are kept for screen-space route picking.
 */
export class HighlightLayer {
  readonly group = new THREE.Group();
  private readonly notable: LineSegments2;
  private readonly connected: LineSegments2;
  private readonly focus: LineSegments2;
  private readonly notableMat: LineMaterial;
  private readonly connectedMat: LineMaterial;
  private readonly focusMat: LineMaterial;
  /** routeId -> sampled arc points (xyz flattened), connected tier */
  readonly arcs = new Map<number, Float32Array>();
  /** routeId -> sampled arc points, notable tier */
  readonly notableArcs = new Map<number, Float32Array>();

  constructor() {
    const additive = { vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, worldUnits: false };
    this.notableMat = new LineMaterial({ ...additive, linewidth: 2.2 });
    this.connectedMat = new LineMaterial({ ...additive, linewidth: 1.8 });
    this.focusMat = new LineMaterial({
      linewidth: 3,
      color: 0xffd27a,
      transparent: true,
      depthWrite: false,
      worldUnits: false,
    });
    this.notable = new LineSegments2(new LineSegmentsGeometry(), this.notableMat);
    this.connected = new LineSegments2(new LineSegmentsGeometry(), this.connectedMat);
    this.focus = new LineSegments2(new LineSegmentsGeometry(), this.focusMat);
    [this.notable, this.connected, this.focus].forEach((o, i) => {
      o.frustumCulled = false;
      o.visible = false;
      o.renderOrder = 3 + i;
      this.group.add(o);
    });
  }

  setResolution(width: number, height: number): void {
    for (const m of [this.notableMat, this.connectedMat, this.focusMat]) m.resolution.set(width, height);
  }

  setNotable(routes: readonly HighlightRoute[]): void {
    this.buildTier(this.notable, this.notableArcs, routes, NOTABLE_PALETTE, 0.0003);
  }

  /** While something is selected the notable tier recedes like the rest of the network. */
  setNotableDimmed(dimmed: boolean): void {
    this.notableMat.opacity = dimmed ? 0.12 : 1;
  }

  setConnected(routes: readonly HighlightRoute[]): void {
    this.buildTier(this.connected, this.arcs, routes, CONNECTED_PALETTE, 0.0006);
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

  private buildTier(
    obj: LineSegments2,
    arcs: Map<number, Float32Array>,
    routes: readonly HighlightRoute[],
    palette: Palette,
    lift: number,
  ): void {
    arcs.clear();
    if (routes.length === 0) {
      obj.visible = false;
      return;
    }
    const positions = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const colors = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const c = new THREE.Color();
    routes.forEach((r, ri) => {
      const arc = sampleArc(r.start, r.end, HIGHLIGHT_SEGMENTS, ROUTE_BASE_RADIUS + lift);
      arcs.set(r.routeId, arc);
      c.copy(palette.low)
        .lerp(palette.high, r.weight)
        .multiplyScalar(palette.floor + (1 - palette.floor) * r.weight);
      for (let s = 0; s < HIGHLIGHT_SEGMENTS; s++) {
        const o = (ri * HIGHLIGHT_SEGMENTS + s) * 6;
        positions.set(arc.subarray(s * 3, s * 3 + 6), o);
        // Brighter in the middle of the arc, softer near the airports.
        const t = (s + 0.5) / HIGHLIGHT_SEGMENTS;
        const k = 0.65 + 0.35 * Math.sin(Math.PI * t);
        colors[o] = colors[o + 3] = c.r * k;
        colors[o + 1] = colors[o + 4] = c.g * k;
        colors[o + 2] = colors[o + 5] = c.b * k;
      }
    });
    this.replaceGeometry(obj, positions, colors);
    obj.visible = true;
  }

  private replaceGeometry(obj: LineSegments2, positions: Float32Array, colors: Float32Array | null): void {
    obj.geometry.dispose();
    const g = new LineSegmentsGeometry();
    g.setPositions(positions);
    if (colors) g.setColors(colors);
    obj.geometry = g;
  }

  dispose(): void {
    for (const o of [this.notable, this.connected, this.focus]) o.geometry.dispose();
    this.notableMat.dispose();
    this.connectedMat.dispose();
    this.focusMat.dispose();
  }
}
