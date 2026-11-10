import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { sampleArc, sampleArcFlat, type Vec3 } from '../../utils/geo';
import { ROUTE_BASE_RADIUS } from './RouteLayer';
import { Wrapped } from './wrapCopies';

const HIGHLIGHT_SEGMENTS = 48;

export interface HighlightRoute {
  routeId: number;
  start: Vec3;
  end: Vec3;
  /** 0..1 normalised weight */
  weight: number;
  /** Override the tier palette (e.g. change colours in compare mode). */
  color?: string;
  /** Draw dashed (notable tier only; used for routes no longer seen). */
  dashed?: boolean;
}

interface Palette {
  low: THREE.Color;
  high: THREE.Color;
  /** brightness at weight 0 (scaled up to 1 at weight 1) */
  floor: number;
}

const CONNECTED_PALETTE: Palette = { low: new THREE.Color('#1f8fd6'), high: new THREE.Color('#e9fbff'), floor: 0.45 };
const NOTABLE_PALETTE: Palette = { low: new THREE.Color('#2a9be0'), high: new THREE.Color('#d9f6ff'), floor: 0.35 };

interface Tier {
  wrapped: Wrapped<LineSegments2>;
  arcs: Map<number, Float32Array>;
  /** extra radius on the globe / extra z on the flat map, so tiers stack without z-fighting */
  lift: number;
}

/**
 * Thick lines for small route subsets, built on the CPU (each set is tiny compared with the
 * full network). Three tiers, bottom to top:
 * - notable:   the highest-volume routes of the current view, always slightly thicker
 * - connected: routes touching the selected airport
 * - focus:     the hovered / selected route
 * Lines are built for the current mode (globe or flat map). Inputs are remembered so the
 * tiers can be rebuilt after a mode switch. Sampled arcs are kept for route picking.
 */
export class HighlightLayer {
  readonly group = new THREE.Group();
  private readonly notableMat: LineMaterial;
  private readonly connectedMat: LineMaterial;
  private readonly focusMat: LineMaterial;
  private readonly notable: Tier;
  private readonly notableDashed: Tier;
  private readonly notableDashedMat: LineMaterial;
  private readonly connected: Tier;
  private readonly focus: Tier;
  private flat = false;
  private hidden = false;
  private copies: boolean | readonly boolean[] = false;
  private lastNotable: readonly HighlightRoute[] = [];
  private lastConnected: readonly HighlightRoute[] = [];
  private lastFocus: { start: Vec3; end: Vec3 } | null = null;

  constructor() {
    const additive = { vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, worldUnits: false };
    this.notableMat = new LineMaterial({ ...additive, linewidth: 2.2 });
    this.connectedMat = new LineMaterial({ ...additive, linewidth: 1.8 });
    this.focusMat = new LineMaterial({ linewidth: 3, color: 0xffd27a, transparent: true, depthWrite: false, worldUnits: false });
    const tier = (mat: LineMaterial, order: number, lift: number): Tier => {
      const obj = new LineSegments2(new LineSegmentsGeometry(), mat);
      obj.frustumCulled = false;
      obj.visible = false;
      obj.renderOrder = order;
      return { wrapped: new Wrapped(obj).addTo(this.group), arcs: new Map(), lift };
    };
    this.notable = tier(this.notableMat, 3, 0.0003);
    // Dash lengths are in world units: ~0.02 reads well on both the unit globe and the flat map.
    this.notableDashedMat = new LineMaterial({ ...additive, linewidth: 2.4, dashed: true, dashSize: 0.018, gapSize: 0.014 });
    this.notableDashed = tier(this.notableDashedMat, 3, 0.0003);
    this.connected = tier(this.connectedMat, 4, 0.0006);
    this.focus = tier(this.focusMat, 5, 0.001);
  }

  /** Picking candidates: the connected tier when it has routes, otherwise the notable tiers. */
  get pickArcs(): ReadonlyMap<number, Float32Array> {
    if (this.connected.arcs.size > 0) return this.connected.arcs;
    if (this.notableDashed.arcs.size === 0) return this.notable.arcs;
    return new Map([...this.notable.arcs, ...this.notableDashed.arcs]);
  }

  setResolution(width: number, height: number): void {
    for (const m of [this.notableMat, this.notableDashedMat, this.connectedMat, this.focusMat]) m.resolution.set(width, height);
  }

  /** Switches the line geometry between globe and flat map and rebuilds every tier. */
  setFlat(flat: boolean): void {
    if (flat === this.flat) return;
    this.flat = flat;
    this.setNotable(this.lastNotable);
    this.setConnected(this.lastConnected);
    this.setFocus(this.lastFocus);
  }

  /** Hidden while the map morphs (CPU lines are only valid at the end states). */
  setHidden(hidden: boolean, copies: boolean | readonly boolean[]): void {
    this.hidden = hidden;
    this.copies = copies;
    for (const t of [this.notable, this.notableDashed, this.connected, this.focus]) this.applyVisibility(t);
  }

  setNotable(routes: readonly HighlightRoute[]): void {
    this.lastNotable = routes;
    this.buildTier(this.notable, routes.filter((r) => !r.dashed), NOTABLE_PALETTE);
    this.buildTier(this.notableDashed, routes.filter((r) => r.dashed), NOTABLE_PALETTE);
    if (this.notableDashed.arcs.size > 0) this.notableDashed.wrapped.main.computeLineDistances();
  }

  /** While something is selected the notable tiers recede like the rest of the network. */
  setNotableDimmed(dimmed: boolean): void {
    this.notableMat.opacity = dimmed ? 0.12 : 1;
    this.notableDashedMat.opacity = dimmed ? 0.12 : 1;
  }

  setConnected(routes: readonly HighlightRoute[]): void {
    this.lastConnected = routes;
    this.buildTier(this.connected, routes, CONNECTED_PALETTE);
  }

  setFocus(route: { start: Vec3; end: Vec3 } | null): void {
    this.lastFocus = route;
    this.focus.arcs.clear();
    if (!route) {
      this.setTierGeometry(this.focus, null, null);
      return;
    }
    const arc = this.sample(route.start, route.end, this.focus.lift);
    const positions = new Float32Array(HIGHLIGHT_SEGMENTS * 6);
    for (let s = 0; s < HIGHLIGHT_SEGMENTS; s++) positions.set(arc.subarray(s * 3, s * 3 + 6), s * 6);
    this.setTierGeometry(this.focus, positions, null);
  }

  private sample(start: Vec3, end: Vec3, lift: number): Float32Array {
    if (!this.flat) return sampleArc(start, end, HIGHLIGHT_SEGMENTS, ROUTE_BASE_RADIUS + lift);
    const arc = sampleArcFlat(start, end, HIGHLIGHT_SEGMENTS);
    for (let i = 2; i < arc.length; i += 3) arc[i]! += 0.004 + lift * 4;
    return arc;
  }

  private buildTier(tier: Tier, routes: readonly HighlightRoute[], palette: Palette): void {
    tier.arcs.clear();
    if (routes.length === 0) {
      this.setTierGeometry(tier, null, null);
      return;
    }
    const positions = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const colors = new Float32Array(routes.length * HIGHLIGHT_SEGMENTS * 6);
    const c = new THREE.Color();
    routes.forEach((r, ri) => {
      const arc = this.sample(r.start, r.end, tier.lift);
      tier.arcs.set(r.routeId, arc);
      if (r.color) c.set(r.color).multiplyScalar(0.55 + 0.45 * r.weight);
      else
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
    this.setTierGeometry(tier, positions, colors);
  }

  private setTierGeometry(tier: Tier, positions: Float32Array | null, colors: Float32Array | null): void {
    tier.wrapped.main.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (positions) {
      g.setPositions(positions);
      if (colors) g.setColors(colors);
    }
    tier.wrapped.setGeometry(g);
    tier.wrapped.main.userData.empty = !positions;
    this.applyVisibility(tier);
  }

  private applyVisibility(tier: Tier): void {
    const empty = tier.wrapped.main.userData.empty !== false;
    tier.wrapped.setVisible(!this.hidden && !empty, this.flat ? this.copies : false);
  }

  dispose(): void {
    for (const t of [this.notable, this.notableDashed, this.connected, this.focus]) t.wrapped.main.geometry.dispose();
    this.notableMat.dispose();
    this.notableDashedMat.dispose();
    this.connectedMat.dispose();
    this.focusMat.dispose();
  }
}
