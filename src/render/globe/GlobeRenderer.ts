import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLonToVec3, type Vec3 } from '../../utils/geo';
import { AirportLayer } from './AirportLayer';
import { EarthLayer } from './EarthLayer';
import { HighlightLayer } from './HighlightLayer';
import { RouteLayer } from './RouteLayer';

/**
 * Imperative WebGL renderer for the globe. It knows nothing about React, datasets or filters:
 * inputs are typed arrays indexed by airport / route id, outputs are pick events.
 */

export interface GlobeNetworkInput {
  /** [lat0, lon0, lat1, lon1, ...] in degrees */
  airportLatLon: Float32Array;
  /** [a0, b0, a1, b1, ...] airport indices per route id */
  routeEndpoints: Uint32Array;
}

export interface GlobeSelectionInput {
  selectedAirport: number | null;
  hoveredAirport: number | null;
  /** Routes to draw as thick highlight lines (typically those touching the selected airport). */
  highlightedRoutes: readonly { routeId: number; weight: number }[];
  /** Route drawn in the focus colour (hovered or selected route). */
  focusRoute: number | null;
}

export type PickHit = { kind: 'airport'; index: number } | { kind: 'route'; routeId: number };

export interface GlobeCallbacks {
  onHover?: (hit: PickHit | null, clientX: number, clientY: number) => void;
  onClick?: (hit: PickHit | null) => void;
  onUserInteraction?: () => void;
}

const CAMERA_DEFAULT_DISTANCE = 3.5;
const MIN_DISTANCE = 1.32;
const MAX_DISTANCE = 6;
const AIRPORT_PICK_RADIUS_PX = 10;
const ROUTE_PICK_RADIUS_PX = 6;
const CLICK_MAX_MOVE_PX = 5;
const AUTO_ROTATE_RESUME_MS = 7000;

export class WebGLUnavailableError extends Error {
  constructor() {
    super('WebGL2 is not available in this browser');
    this.name = 'WebGLUnavailableError';
  }
}

export class GlobeRenderer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly earth = new EarthLayer();
  private readonly routes = new RouteLayer();
  private readonly highlight = new HighlightLayer();
  private readonly airports = new AirportLayer();
  private readonly resizeObserver: ResizeObserver;
  private readonly callbacks: GlobeCallbacks;

  private frame = 0;
  private dirty = true;
  private disposed = false;
  private width = 1;
  private height = 1;

  private airportUnit = new Float32Array(0);
  private routeEndpoints: Uint32Array = new Uint32Array(0);
  private airportVisible = new Uint8Array(0);

  private pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private pointerDirty = false;
  private pointerDown: { x: number; y: number; time: number } | null = null;
  private lastHit: PickHit | null = null;

  private autoRotateEnabled = true;
  private autoRotateSuppressed = false;
  private lastInteraction = 0;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number } | null = null;

  private readonly tmpV = new THREE.Vector3();
  private readonly abortBasemap = new AbortController();

  constructor(container: HTMLElement, callbacks: GlobeCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new WebGLUnavailableError();
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvas.className = 'globe-canvas';
    canvas.setAttribute('aria-label', 'Interactive 3D globe');
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    // Start looking at East Asia / Pacific.
    this.camera.position.set(...latLonToVec3(28, 150, CAMERA_DEFAULT_DISTANCE));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.autoRotateEnabled = this.controls.autoRotate;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('change', this.markDirty);
    this.controls.addEventListener('start', this.onControlsStart);

    this.scene.add(this.earth.group, this.routes.object, this.highlight.group, this.airports.object);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.frame = requestAnimationFrame(this.loop);
  }

  /** Loads the basemap; rejects if it fails (the globe keeps working without it). */
  loadBasemap(): Promise<void> {
    const maxTex = this.renderer.capabilities.maxTextureSize;
    return this.earth.loadBasemap(maxTex, this.abortBasemap.signal).then(this.markDirty);
  }

  setNetwork(input: GlobeNetworkInput): void {
    const nAirports = input.airportLatLon.length / 2;
    this.airportUnit = new Float32Array(nAirports * 3);
    for (let i = 0; i < nAirports; i++) {
      this.airportUnit.set(latLonToVec3(input.airportLatLon[i * 2]!, input.airportLatLon[i * 2 + 1]!), i * 3);
    }
    this.routeEndpoints = input.routeEndpoints;
    const nRoutes = input.routeEndpoints.length / 2;
    const endpoints = new Float32Array(nRoutes * 6);
    for (let r = 0; r < nRoutes; r++) {
      const a = input.routeEndpoints[r * 2]!;
      const b = input.routeEndpoints[r * 2 + 1]!;
      endpoints.set(this.airportUnit.subarray(a * 3, a * 3 + 3), r * 6);
      endpoints.set(this.airportUnit.subarray(b * 3, b * 3 + 3), r * 6 + 3);
    }
    this.routes.setRoutes(endpoints);
    this.airports.setAirports(this.airportUnit);
    this.airportVisible = new Uint8Array(nAirports);
    this.markDirty();
  }

  /** Per-route and per-airport weights (0..1, 0 = hidden). Cheap: only textures/attributes update. */
  setWeights(routeWeights: Float32Array, airportWeights: Float32Array, connectedRouteIds: ReadonlySet<number> | null): void {
    this.routes.updateState(routeWeights, connectedRouteIds);
    this.airports.setWeights(airportWeights);
    for (let i = 0; i < this.airportVisible.length; i++) this.airportVisible[i] = (airportWeights[i] ?? 0) > 0 ? 1 : 0;
    this.markDirty();
  }

  setSelection(sel: GlobeSelectionInput): void {
    const connectedAirports = new Set<number>();
    const highlighted = sel.highlightedRoutes.map(({ routeId, weight }) => {
      const a = this.routeEndpoints[routeId * 2]!;
      const b = this.routeEndpoints[routeId * 2 + 1]!;
      connectedAirports.add(a);
      connectedAirports.add(b);
      return { routeId, weight, start: this.unit(a), end: this.unit(b) };
    });
    this.highlight.setConnected(highlighted);
    if (sel.focusRoute !== null && sel.focusRoute * 2 + 1 < this.routeEndpoints.length) {
      const a = this.routeEndpoints[sel.focusRoute * 2]!;
      const b = this.routeEndpoints[sel.focusRoute * 2 + 1]!;
      this.highlight.setFocus({ start: this.unit(a), end: this.unit(b) });
    } else {
      this.highlight.setFocus(null);
    }
    this.airports.setStates(
      sel.selectedAirport,
      sel.hoveredAirport,
      sel.selectedAirport !== null || sel.focusRoute !== null ? connectedAirports : null,
    );
    this.autoRotateSuppressed = sel.selectedAirport !== null || sel.focusRoute !== null;
    this.markDirty();
  }

  setAutoRotate(enabled: boolean): void {
    this.autoRotateEnabled = enabled;
    this.markDirty();
  }

  /** Smoothly rotates the camera to look at a lat/lon, keeping (or tightening) the zoom level. */
  flyTo(lat: number, lon: number, distance?: number): void {
    const current = this.camera.position.length();
    const target = distance ?? Math.min(current, 2.6);
    const to = new THREE.Vector3(...latLonToVec3(lat, lon, target));
    this.tween = { from: this.camera.position.clone(), to, start: performance.now(), duration: 1100 };
    this.markDirty();
  }

  zoomBy(factor: number): void {
    const d = THREE.MathUtils.clamp(this.camera.position.length() * factor, MIN_DISTANCE, MAX_DISTANCE);
    this.camera.position.setLength(d);
    this.lastInteraction = performance.now();
    this.markDirty();
  }

  resetView(): void {
    const dir = this.camera.position.clone().normalize();
    this.tween = {
      from: this.camera.position.clone(),
      to: dir.multiplyScalar(CAMERA_DEFAULT_DISTANCE),
      start: performance.now(),
      duration: 800,
    };
    this.markDirty();
  }

  dispose(): void {
    this.disposed = true;
    this.abortBasemap.abort();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.dispose();
    this.earth.dispose();
    this.routes.dispose();
    this.highlight.dispose();
    this.airports.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  // ---------------------------------------------------------------------------------------

  private unit(i: number): Vec3 {
    return [this.airportUnit[i * 3]!, this.airportUnit[i * 3 + 1]!, this.airportUnit[i * 3 + 2]!];
  }

  private readonly markDirty = (): void => {
    this.dirty = true;
  };

  private readonly onControlsStart = (): void => {
    this.tween = null;
    this.lastInteraction = performance.now();
    this.callbacks.onUserInteraction?.();
  };

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.highlight.setResolution(this.width * pr, this.height * pr);
    this.markDirty();
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);

    if (this.tween) {
      const { from, to, start, duration } = this.tween;
      const k = Math.min(1, (now - start) / duration);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const len = THREE.MathUtils.lerp(from.length(), to.length(), e);
      // Spherical interpolation of the view direction.
      const dir = from.clone().normalize();
      const toDir = to.clone().normalize();
      const angle = dir.angleTo(toDir);
      if (angle > 1e-5) {
        const axis = new THREE.Vector3().crossVectors(dir, toDir).normalize();
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        dir.applyAxisAngle(axis, angle * e);
      }
      this.camera.position.copy(dir.multiplyScalar(len));
      if (k >= 1) this.tween = null;
      this.dirty = true;
    }

    const idle = now - this.lastInteraction > AUTO_ROTATE_RESUME_MS;
    this.controls.autoRotate = this.autoRotateEnabled && !this.autoRotateSuppressed && idle && !this.tween;
    // Slower rotation when zoomed in so the surface does not fly past the cursor.
    const dist = this.camera.position.length();
    this.controls.rotateSpeed = THREE.MathUtils.clamp((dist - 1) * 0.42, 0.06, 1);
    this.controls.update();

    // The scene moved under a stationary cursor: re-pick so hover/tooltip stay truthful.
    if (this.dirty && this.pointer) this.pointerDirty = true;

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.updateHover();
    }

    if (!this.dirty) return;
    this.dirty = false;
    this.airports.update(this.renderer.getPixelRatio(), this.camera.position);
    this.renderer.render(this.scene, this.camera);
  };

  // ---- picking ----------------------------------------------------------------------------

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top, clientX: e.clientX, clientY: e.clientY };
    this.pointerDirty = true;
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.setHit(null, 0, 0);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY, time: performance.now() };
    this.lastInteraction = performance.now();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > CLICK_MAX_MOVE_PX || performance.now() - down.time > 600) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    this.callbacks.onClick?.(hit);
  };

  private updateHover(): void {
    if (!this.pointer || this.pointerDown) return;
    const hit = this.pick(this.pointer.x, this.pointer.y);
    this.setHit(hit, this.pointer.clientX, this.pointer.clientY);
  }

  private setHit(hit: PickHit | null, clientX: number, clientY: number): void {
    const same =
      hit === this.lastHit ||
      (hit !== null &&
        this.lastHit !== null &&
        hit.kind === this.lastHit.kind &&
        (hit.kind === 'airport'
          ? hit.index === (this.lastHit as { index: number }).index
          : hit.routeId === (this.lastHit as { routeId: number }).routeId));
    this.renderer.domElement.style.cursor = hit ? 'pointer' : '';
    this.lastHit = hit;
    // Always forward (tooltip follows the cursor), but consumers can cheaply ignore same-hit updates.
    if (!same || hit) this.callbacks.onHover?.(hit, clientX, clientY);
  }

  private project(x: number, y: number, z: number): { sx: number; sy: number } | null {
    this.tmpV.set(x, y, z).project(this.camera);
    if (this.tmpV.z > 1) return null;
    return { sx: (this.tmpV.x * 0.5 + 0.5) * this.width, sy: (-this.tmpV.y * 0.5 + 0.5) * this.height };
  }

  /** True when the segment from the camera to p is not blocked by the unit sphere. */
  private isUnoccluded(x: number, y: number, z: number): boolean {
    const c = this.camera.position;
    const dx = x - c.x;
    const dy = y - c.y;
    const dz = z - c.z;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (c.x * dx + c.y * dy + c.z * dz);
    const cc = c.lengthSq() - 1;
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return true;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0.999 || t <= 0;
  }

  pick(px: number, py: number): PickHit | null {
    const cam = this.camera.position;
    // 1) Airports (front hemisphere only).
    let best = -1;
    let bestD = AIRPORT_PICK_RADIUS_PX * AIRPORT_PICK_RADIUS_PX;
    const pos = this.airportUnit;
    for (let i = 0; i < this.airportVisible.length; i++) {
      if (!this.airportVisible[i]) continue;
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      if (x * cam.x + y * cam.y + z * cam.z <= 1.0) continue; // behind the horizon
      const p = this.project(x, y, z);
      if (!p) continue;
      const d = (p.sx - px) ** 2 + (p.sy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return { kind: 'airport', index: best };

    // 2) Highlighted routes (small set) via screen-space distance to sampled arcs.
    let bestRoute = -1;
    let bestRouteD = ROUTE_PICK_RADIUS_PX;
    for (const [routeId, arc] of this.highlight.arcs) {
      let prev: { sx: number; sy: number } | null = null;
      for (let i = 0; i < arc.length; i += 3) {
        const x = arc[i]!;
        const y = arc[i + 1]!;
        const z = arc[i + 2]!;
        const p = this.isUnoccluded(x, y, z) ? this.project(x, y, z) : null;
        if (p && prev) {
          const d = distToSegment(px, py, prev.sx, prev.sy, p.sx, p.sy);
          if (d < bestRouteD) {
            bestRouteD = d;
            bestRoute = routeId;
          }
        }
        prev = p;
      }
    }
    if (bestRoute >= 0) return { kind: 'route', routeId: bestRoute };
    return null;
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
