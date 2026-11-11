import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAT_WORLD_WIDTH, latLonToVec3, vec3ToLatLon, wrapAngle, type Vec3 } from '../../utils/geo';
import { AirportLayer } from './AirportLayer';
import { EarthLayer, type MorphUniform } from './EarthLayer';
import { HighlightLayer } from './HighlightLayer';
import { RouteLayer } from './RouteLayer';
import { COPY_OFFSETS } from './wrapCopies';

/**
 * Imperative WebGL renderer for the network map. It can show the network on a 3D globe or on a
 * flat (equirectangular) map and morphs between the two. It knows nothing about React,
 * datasets or filters: inputs are typed arrays indexed by airport / route id, outputs are pick
 * events.
 */

export type ViewMode = 'globe' | 'flat';

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

const DEG2RAD = Math.PI / 180;
const GLOBE_DEFAULT_DISTANCE = 3.5;
// Closest zoom: about 400 km above the surface on the globe, a ~2 degree wide view on the map.
const GLOBE_MIN_DISTANCE = 1.06;
const GLOBE_MAX_DISTANCE = 6;
const FLAT_MIN_HEIGHT = 0.05;
const FLAT_MAX_HEIGHT = 7.5;
/** Flat-map camera height per unit of globe altitude (keeps the zoom level similar across modes). */
const FLAT_PER_GLOBE_ALTITUDE = 1.9;
const FLAT_MAX_LAT = 1.25;
const GLOBE_ZOOM_SPEED = 0.7;
const FLAT_ZOOM_SPEED = 2.4;
const MORPH_DURATION_MS = 1300;
const AIRPORT_PICK_RADIUS_PX = 12;
const ROUTE_PICK_RADIUS_PX = 6;
const CLICK_MAX_MOVE_PX = 5;
const AUTO_ROTATE_RESUME_MS = 7000;
const FLAT_AIRPORT_Z = 0.008;
/** Minimum on-screen distance between airport lights; closer, less busy airports are hidden. */
const DECLUTTER_MIN_PX = 13;
const DECLUTTER_INTERVAL_MS = 120;

export class WebGLUnavailableError extends Error {
  constructor() {
    super('WebGL2 is not available in this browser');
    this.name = 'WebGLUnavailableError';
  }
}

interface CameraTween {
  kind: 'orbit' | 'linear';
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

interface MorphTransition {
  from: number;
  to: number;
  start: number;
  duration: number;
  /** centre of the view in radians, kept fixed under the camera during the morph */
  lat: number;
  lon: number;
  globeAltitude: number;
  flatHeight: number;
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export class GlobeRenderer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly morph: MorphUniform = { value: 0 };
  private readonly earth: EarthLayer;
  private readonly routes: RouteLayer;
  private readonly highlight = new HighlightLayer();
  private readonly airports: AirportLayer;
  private readonly resizeObserver: ResizeObserver;
  private readonly callbacks: GlobeCallbacks;
  private readonly reducedMotion: boolean;

  private frame = 0;
  private dirty = true;
  private disposed = false;
  private width = 1;
  private height = 1;

  private mode: ViewMode;
  private transition: MorphTransition | null = null;
  private insets = { top: 0, bottom: 0 };

  private airportUnit = new Float32Array(0);
  private airportLatLonRad = new Float32Array(0);
  private routeEndpoints: Uint32Array = new Uint32Array(0);
  private airportVisible = new Uint8Array(0);
  /** Airport indices, busiest first: the order in which decluttering keeps airports. */
  private airportOrder = new Int32Array(0);
  /** Airports that must stay visible (selected, hovered, connected to the selection). */
  private pinnedAirports = new Set<number>();
  private declutterPending = true;
  private lastDeclutter = 0;
  private lastDeclutterKey = '';

  private pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private pointerDirty = false;
  private pointerDown: { x: number; y: number; time: number } | null = null;
  private lastHit: PickHit | null = null;

  private autoRotateEnabled = true;
  private autoRotateSuppressed = false;
  private lastInteraction = 0;
  private tween: CameraTween | null = null;

  private readonly tmpV = new THREE.Vector3();
  private readonly abortBasemap = new AbortController();

  constructor(container: HTMLElement, callbacks: GlobeCallbacks = {}, initialMode: ViewMode = 'globe') {
    this.container = container;
    this.callbacks = callbacks;
    this.mode = initialMode;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new WebGLUnavailableError();
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvas.className = 'globe-canvas';
    canvas.setAttribute('aria-label', 'Interactive map of flight routes');
    container.appendChild(canvas);

    this.earth = new EarthLayer(this.morph);
    this.routes = new RouteLayer(this.morph);
    this.airports = new AirportLayer(this.morph);

    // Near plane small enough for the closest zoom levels above.
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.004, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.autoRotateSpeed = 0.35;
    this.autoRotateEnabled = !this.reducedMotion;
    this.controls.addEventListener('change', this.markDirty);
    this.controls.addEventListener('start', this.onControlsStart);

    for (const o of this.routes.wrapped.all) this.scene.add(o);
    this.scene.add(this.earth.group, this.highlight.group);
    for (const o of this.airports.wrapped.all) this.scene.add(o);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // Initial view: East Asia / Pacific on the globe, the whole world on the flat map.
    if (initialMode === 'flat') {
      this.morph.value = 1;
      this.highlight.setFlat(true);
      this.controls.target.set(15 * DEG2RAD, 20 * DEG2RAD, 0);
      this.camera.position.set(15 * DEG2RAD, 20 * DEG2RAD, this.flatDefaultHeight());
    } else {
      this.camera.position.set(...latLonToVec3(28, 150, GLOBE_DEFAULT_DISTANCE));
    }
    this.configureControls();

    this.frame = requestAnimationFrame(this.loop);
  }

  /**
   * Stops (or resumes) the animation loop, e.g. while another screen covers the map. Nothing
   * about the scene changes; resuming redraws the current state.
   */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      cancelAnimationFrame(this.frame);
    } else {
      this.markDirty();
      this.frame = requestAnimationFrame(this.loop);
    }
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  /** Loads the basemap; rejects if it fails (the map keeps working without it). */
  loadBasemap(): Promise<void> {
    const maxTex = this.renderer.capabilities.maxTextureSize;
    return this.earth.loadBasemap(maxTex, this.abortBasemap.signal).then(this.markDirty);
  }

  setNetwork(input: GlobeNetworkInput): void {
    const nAirports = input.airportLatLon.length / 2;
    this.airportUnit = new Float32Array(nAirports * 3);
    this.airportLatLonRad = new Float32Array(nAirports * 2);
    for (let i = 0; i < nAirports; i++) {
      const lat = input.airportLatLon[i * 2]!;
      const lon = input.airportLatLon[i * 2 + 1]!;
      this.airportUnit.set(latLonToVec3(lat, lon), i * 3);
      this.airportLatLonRad[i * 2] = lat * DEG2RAD;
      this.airportLatLonRad[i * 2 + 1] = lon * DEG2RAD;
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
    this.airports.setAirports(this.airportUnit, this.airportLatLonRad);
    this.airportVisible = new Uint8Array(nAirports);
    this.markDirty();
  }

  /** Per-route and per-airport weights (0..1, 0 = hidden). Cheap: only textures/attributes update. */
  /**
   * @param changeKinds per-route change category in compare mode (domain/comparison ChangeKind);
   *                    null for the normal view
   */
  setWeights(
    routeWeights: Float32Array,
    airportWeights: Float32Array,
    connectedRouteIds: ReadonlySet<number> | null,
    changeKinds: Uint8Array | null = null,
  ): void {
    this.routes.updateState(routeWeights, connectedRouteIds, changeKinds);
    this.airports.setWeights(airportWeights);
    for (let i = 0; i < this.airportVisible.length; i++) this.airportVisible[i] = (airportWeights[i] ?? 0) > 0 ? 1 : 0;
    const order = Array.from({ length: airportWeights.length }, (_, i) => i).filter((i) => (airportWeights[i] ?? 0) > 0);
    order.sort((a, b) => airportWeights[b]! - airportWeights[a]!);
    this.airportOrder = Int32Array.from(order);
    this.declutterPending = true;
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
    this.pinnedAirports = new Set(connectedAirports);
    if (sel.selectedAirport !== null) this.pinnedAirports.add(sel.selectedAirport);
    if (sel.hoveredAirport !== null) this.pinnedAirports.add(sel.hoveredAirport);
    this.declutterPending = true;
    this.highlight.setNotableDimmed(sel.selectedAirport !== null);
    this.autoRotateSuppressed = sel.selectedAirport !== null || sel.focusRoute !== null;
    this.markDirty();
  }

  /** Highest-volume routes drawn slightly thicker; also hoverable when nothing is selected. */
  setNotableRoutes(
    routes: readonly { routeId: number; weight: number; color?: string; dashed?: boolean }[],
  ): void {
    this.highlight.setNotable(
      routes.map(({ routeId, weight, color, dashed }) => {
        const a = this.routeEndpoints[routeId * 2]!;
        const b = this.routeEndpoints[routeId * 2 + 1]!;
        return { routeId, weight, color, dashed, start: this.unit(a), end: this.unit(b) };
      }),
    );
    this.markDirty();
  }

  /**
   * Screen space covered by UI at the top/bottom (px). The projection centre is shifted into the
   * uncovered area, so fly-to targets and the initial view are not hidden behind panels.
   */
  setViewInsets(top: number, bottom: number): void {
    if (top === this.insets.top && bottom === this.insets.bottom) return;
    this.insets = { top, bottom };
    this.applyViewOffset();
  }

  /** Countries (ISO numeric ids) to tint for the advisory overlay; empty clears it. */
  setAdvisoryCountries(ids: readonly string[]): void {
    this.earth.setAdvisoryCountries(ids);
    this.markDirty();
  }

  setAutoRotate(enabled: boolean): void {
    this.autoRotateEnabled = enabled;
    this.markDirty();
  }

  /** Morphs between the globe and the flat map, keeping the current view centre in place. */
  setViewMode(mode: ViewMode): void {
    const target = mode === 'flat' ? 1 : 0;
    if (this.transition ? this.transition.to === target : this.mode === mode) return;

    const center = this.transition ? { lat: this.transition.lat, lon: this.transition.lon } : this.viewCenter();
    const globeAltitude = this.transition
      ? this.transition.globeAltitude
      : this.mode === 'globe'
        ? this.camera.position.length() - 1
        : (this.camera.position.z - this.controls.target.z) / FLAT_PER_GLOBE_ALTITUDE;
    const flatHeight = THREE.MathUtils.clamp(globeAltitude * FLAT_PER_GLOBE_ALTITUDE, FLAT_MIN_HEIGHT, FLAT_MAX_HEIGHT);

    this.tween = null;
    this.controls.enabled = false;
    this.highlight.setHidden(true, false);
    this.transition = {
      from: this.morph.value,
      to: target,
      start: performance.now(),
      duration: this.reducedMotion ? 1 : MORPH_DURATION_MS * Math.abs(target - this.morph.value),
      lat: center.lat,
      lon: center.lon,
      globeAltitude: THREE.MathUtils.clamp(globeAltitude, GLOBE_MIN_DISTANCE - 1, GLOBE_MAX_DISTANCE - 1),
      flatHeight,
    };
    this.markDirty();
  }

  /** Smoothly moves the view to a lat/lon (degrees), keeping (or tightening) the zoom level. */
  flyTo(lat: number, lon: number): void {
    if (this.transition) return;
    if (this.mode === 'globe') {
      const current = this.camera.position.length();
      const to = new THREE.Vector3(...latLonToVec3(lat, lon, Math.min(current, 2.6)));
      this.startTween('orbit', to, new THREE.Vector3(), 1100);
    } else {
      const t = this.controls.target;
      const latR = THREE.MathUtils.clamp(lat * DEG2RAD, -FLAT_MAX_LAT, FLAT_MAX_LAT);
      // Choose the copy of the longitude closest to where we are now.
      const lonR = lon * DEG2RAD + FLAT_WORLD_WIDTH * Math.round((t.x - lon * DEG2RAD) / FLAT_WORLD_WIDTH);
      const h = Math.min(this.camera.position.z - t.z, 3.2);
      this.startTween('linear', new THREE.Vector3(lonR, latR, h), new THREE.Vector3(lonR, latR, 0), 1000);
    }
  }

  zoomBy(factor: number): void {
    if (this.transition) return;
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    const [min, max] = this.mode === 'globe' ? [GLOBE_MIN_DISTANCE, GLOBE_MAX_DISTANCE] : [FLAT_MIN_HEIGHT, FLAT_MAX_HEIGHT];
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, min, max));
    this.camera.position.copy(t).add(offset);
    this.lastInteraction = performance.now();
    this.markDirty();
  }

  resetView(): void {
    if (this.transition) return;
    if (this.mode === 'globe') {
      const dir = this.camera.position.clone().normalize();
      this.startTween('orbit', dir.multiplyScalar(GLOBE_DEFAULT_DISTANCE), new THREE.Vector3(), 800);
    } else {
      const x = this.controls.target.x;
      this.startTween('linear', new THREE.Vector3(x, 0.3, this.flatDefaultHeight()), new THREE.Vector3(x, 0.3, 0), 800);
    }
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

  /**
   * Camera height that fits the whole world width on the flat map, but never so high that empty
   * space shows above and below the world (narrow/tall screens get a regional view instead).
   */
  private flatDefaultHeight(): number {
    const visibleHeightPerHeight = 2 * Math.tan((this.camera.fov * DEG2RAD) / 2);
    const fitWidth = (FLAT_WORLD_WIDTH * 0.95) / (visibleHeightPerHeight * this.camera.aspect);
    const fitHeight = (Math.PI * 0.95) / visibleHeightPerHeight;
    return THREE.MathUtils.clamp(Math.min(fitWidth, fitHeight), 2, FLAT_MAX_HEIGHT);
  }

  /** Centre of the current view as lat/lon in radians. */
  private viewCenter(): { lat: number; lon: number } {
    if (this.mode === 'globe') {
      const p = this.camera.position;
      const { lat, lon } = vec3ToLatLon([p.x, p.y, p.z]);
      return { lat: lat * DEG2RAD, lon: lon * DEG2RAD };
    }
    const t = this.controls.target;
    return { lat: THREE.MathUtils.clamp(t.y, -FLAT_MAX_LAT, FLAT_MAX_LAT), lon: wrapAngle(t.x) };
  }

  private configureControls(): void {
    const c = this.controls;
    const flat = this.mode === 'flat';
    c.enabled = true;
    c.enableRotate = !flat;
    c.enablePan = flat;
    c.screenSpacePanning = true;
    c.zoomToCursor = flat;
    // A flat map spans a much larger zoom range than the globe; a slow wheel feels sluggish.
    c.zoomSpeed = flat ? FLAT_ZOOM_SPEED : GLOBE_ZOOM_SPEED;
    c.minDistance = flat ? FLAT_MIN_HEIGHT : GLOBE_MIN_DISTANCE;
    c.maxDistance = flat ? FLAT_MAX_HEIGHT : GLOBE_MAX_DISTANCE;
    c.mouseButtons = { LEFT: flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = { ONE: flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    if (!flat) c.target.set(0, 0, 0);
    c.update();
  }

  private startTween(kind: CameraTween['kind'], toPos: THREE.Vector3, toTarget: THREE.Vector3, duration: number): void {
    this.tween = {
      kind,
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      duration: this.reducedMotion ? 1 : duration,
    };
    this.markDirty();
  }

  private stepTween(now: number): void {
    const tw = this.tween;
    if (!tw) return;
    const k = Math.min(1, (now - tw.start) / tw.duration);
    const e = ease(k);
    if (tw.kind === 'orbit') {
      // Spherical interpolation of the view direction around the globe.
      const len = THREE.MathUtils.lerp(tw.fromPos.length(), tw.toPos.length(), e);
      const dir = tw.fromPos.clone().normalize();
      const toDir = tw.toPos.clone().normalize();
      const angle = dir.angleTo(toDir);
      if (angle > 1e-5) {
        const axis = new THREE.Vector3().crossVectors(dir, toDir);
        if (axis.lengthSq() < 1e-10) axis.set(0, 1, 0);
        dir.applyAxisAngle(axis.normalize(), angle * e);
      }
      this.camera.position.copy(dir.multiplyScalar(len));
    } else {
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    }
    if (k >= 1) this.tween = null;
    this.dirty = true;
  }

  private stepTransition(now: number): void {
    const tr = this.transition;
    if (!tr) return;
    const k = Math.min(1, (now - tr.start) / Math.max(1, tr.duration));
    const m = THREE.MathUtils.lerp(tr.from, tr.to, ease(k));
    this.morph.value = m;

    // Keep the view centre under the camera while the surface unrolls: the camera rides along
    // the centre point's (morphing) normal at an interpolated height.
    const s = smooth(m);
    const globeP = new THREE.Vector3(...latLonToVec3(tr.lat / DEG2RAD, tr.lon / DEG2RAD));
    const flatP = new THREE.Vector3(tr.lon, tr.lat, 0);
    const surface = globeP.clone().lerp(flatP, s);
    const normal = slerpUnit(globeP, new THREE.Vector3(0, 0, 1), s);
    const h = THREE.MathUtils.lerp(tr.globeAltitude, tr.flatHeight, s);
    this.camera.position.copy(surface).addScaledVector(normal, h);
    this.controls.target.copy(surface);
    this.camera.lookAt(surface);
    this.dirty = true;

    if (k >= 1) {
      this.transition = null;
      this.mode = tr.to === 1 ? 'flat' : 'globe';
      this.morph.value = tr.to;
      this.highlight.setFlat(this.mode === 'flat');
      this.configureControls();
      this.highlight.setHidden(false, this.mode === 'flat');
    }
  }

  /** Flat map: keep latitude in range and wrap longitude so panning is endless. */
  private constrainFlat(): void {
    const t = this.controls.target;
    const cam = this.camera.position;
    // Zoom-to-cursor moves the target along the view ray; keep it on the map plane.
    if (t.z !== 0) {
      cam.z -= t.z;
      t.z = 0;
    }
    const dy = THREE.MathUtils.clamp(t.y, -FLAT_MAX_LAT, FLAT_MAX_LAT) - t.y;
    let dx = 0;
    if (t.x > Math.PI) dx = -FLAT_WORLD_WIDTH;
    else if (t.x < -Math.PI) dx = FLAT_WORLD_WIDTH;
    if (dx !== 0 || dy !== 0) {
      t.x += dx;
      t.y += dy;
      cam.x += dx;
      cam.y += dy;
      if (this.tween) {
        this.tween.toPos.x += dx;
        this.tween.toTarget.x += dx;
        this.tween.fromPos.x += dx;
        this.tween.fromTarget.x += dx;
      }
    }
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    this.camera.aspect = this.width / this.height;
    this.applyViewOffset();
    const pr = this.renderer.getPixelRatio();
    this.highlight.setResolution(this.width * pr, this.height * pr);
    this.markDirty();
  }

  private viewKey(): string {
    const c = this.camera.position;
    const t = this.controls.target;
    return [c.x, c.y, c.z, t.x, t.y, this.width, this.height].map((v) => v.toFixed(3)).join(',');
  }

  /**
   * How much to enlarge airport lights for the current zoom (1 at the whole-world view).
   * Grows slowly (power 0.35) so close-up views get larger points without giant blobs.
   */
  private zoomSizeScale(): number {
    const ratio =
      this.mode === 'flat'
        ? this.flatDefaultHeight() / Math.max(1e-3, this.camera.position.z - this.controls.target.z)
        : (GLOBE_DEFAULT_DISTANCE - 1) / Math.max(1e-3, this.camera.position.length() - 1);
    return THREE.MathUtils.clamp(ratio ** 0.35, 1, 2.4);
  }

  /**
   * Screen-space decluttering: walk airports busiest first and keep one only if no kept airport
   * lies within DECLUTTER_MIN_PX on screen. Zooming in spreads airports apart, so more of them
   * appear. Pinned airports (selection) are always kept. Off-screen airports are kept (they cost
   * nothing and are ready when panned into view).
   */
  private declutterAirports(): void {
    const n = this.airportVisible.length;
    if (n === 0) return;
    const mask = new Uint8Array(n);
    const cell = DECLUTTER_MIN_PX;
    const grid = new Map<number, number[]>();
    const flat = this.mode === 'flat';
    const cam = this.camera.position;
    const tx = this.controls.target.x;
    const minSq = DECLUTTER_MIN_PX * DECLUTTER_MIN_PX;
    const place = (i: number, force: boolean): void => {
      let p: { sx: number; sy: number } | null;
      if (flat) {
        const lat = this.airportLatLonRad[i * 2]!;
        const lon = this.airportLatLonRad[i * 2 + 1]!;
        const x = lon + FLAT_WORLD_WIDTH * Math.round((tx - lon) / FLAT_WORLD_WIDTH);
        p = this.project(x, lat, FLAT_AIRPORT_Z);
      } else {
        const x = this.airportUnit[i * 3]!;
        const y = this.airportUnit[i * 3 + 1]!;
        const z = this.airportUnit[i * 3 + 2]!;
        if (x * cam.x + y * cam.y + z * cam.z <= 1.0) {
          mask[i] = 1; // behind the horizon: invisible anyway, takes no space
          return;
        }
        p = this.project(x, y, z);
      }
      if (!p || p.sx < -50 || p.sy < -50 || p.sx > this.width + 50 || p.sy > this.height + 50) {
        mask[i] = 1;
        return;
      }
      const cx = Math.floor(p.sx / cell);
      const cy = Math.floor(p.sy / cell);
      if (!force) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const pts = grid.get((cx + dx) * 100003 + (cy + dy));
            if (!pts) continue;
            for (let k = 0; k < pts.length; k += 2) {
              if ((pts[k]! - p.sx) ** 2 + (pts[k + 1]! - p.sy) ** 2 < minSq) return;
            }
          }
        }
      }
      mask[i] = 1;
      const key = cx * 100003 + cy;
      const list = grid.get(key);
      if (list) list.push(p.sx, p.sy);
      else grid.set(key, [p.sx, p.sy]);
    };
    for (const i of this.pinnedAirports) if (this.airportVisible[i]) place(i, true);
    for (const i of this.airportOrder) if (!mask[i]) place(i, false);
    this.airports.setMask(mask);
  }

  /** Which of the side copies (COPY_OFFSETS) overlap the current flat-map view. */
  private visibleCopies(): boolean[] {
    const t = this.controls.target;
    const h = this.camera.position.z - t.z;
    const halfW = h * Math.tan((this.camera.fov * DEG2RAD) / 2) * this.camera.aspect * 1.15;
    // Each copy spans [-PI + dx, PI + dx]; arcs can overshoot the edge, hence the margin.
    const margin = 0.6;
    return COPY_OFFSETS.map((dx) => Math.PI + dx + margin > t.x - halfW && -Math.PI + dx - margin < t.x + halfW);
  }

  private applyViewOffset(): void {
    const shift = Math.round((this.insets.bottom - this.insets.top) / 2);
    if (shift === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, 0, shift, this.width, this.height);
    this.camera.updateProjectionMatrix();
    this.markDirty();
  }

  private paused = false;

  private readonly loop = (now: number): void => {
    if (this.disposed || this.paused) return;
    this.frame = requestAnimationFrame(this.loop);

    if (this.transition) {
      this.stepTransition(now);
    } else {
      this.stepTween(now);
      const globe = this.mode === 'globe';
      const idle = now - this.lastInteraction > AUTO_ROTATE_RESUME_MS;
      this.controls.autoRotate = globe && this.autoRotateEnabled && !this.autoRotateSuppressed && idle && !this.tween;
      if (globe) {
        // Slower rotation when zoomed in so the surface does not fly past the cursor.
        const dist = this.camera.position.length();
        this.controls.rotateSpeed = THREE.MathUtils.clamp((dist - 1) * 0.42, 0.06, 1);
      }
      this.controls.update();
      if (!globe) this.constrainFlat();
    }

    // The scene moved under a stationary cursor: re-pick so hover/tooltip stay truthful.
    if (this.dirty && this.pointer) this.pointerDirty = true;
    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.updateHover();
    }

    // Re-run airport decluttering when the view changed (throttled while moving; it always runs
    // once more after the camera stops because the key keeps differing until then).
    const key = this.viewKey();
    if (key !== this.lastDeclutterKey) this.declutterPending = true;
    if (this.declutterPending && !this.transition && now - this.lastDeclutter > DECLUTTER_INTERVAL_MS) {
      this.declutterAirports();
      this.lastDeclutter = now;
      this.lastDeclutterKey = key;
      this.declutterPending = false;
      this.dirty = true;
    }

    if (!this.dirty) return;
    this.dirty = false;
    const copies = this.mode === 'flat' && !this.transition ? this.visibleCopies() : false;
    this.earth.update(copies);
    this.routes.wrapped.setVisible(true, copies);
    this.airports.wrapped.setVisible(true, copies);
    this.highlight.setHidden(this.transition !== null, copies);
    this.airports.update(this.renderer.getPixelRatio(), this.zoomSizeScale());
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

  /** True when the segment from the camera to p is not blocked by the unit sphere (globe only). */
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
    if (this.transition) return null;
    const flat = this.mode === 'flat';
    const offsets = flat ? [0, ...COPY_OFFSETS] : [0];
    const cam = this.camera.position;

    // 1) Airports.
    let best = -1;
    let bestD = AIRPORT_PICK_RADIUS_PX * AIRPORT_PICK_RADIUS_PX;
    for (let i = 0; i < this.airportVisible.length; i++) {
      if (!this.airports.isDrawn(i)) continue;
      for (const off of offsets) {
        let p: { sx: number; sy: number } | null;
        if (flat) {
          p = this.project(this.airportLatLonRad[i * 2 + 1]! + off, this.airportLatLonRad[i * 2]!, FLAT_AIRPORT_Z);
        } else {
          const x = this.airportUnit[i * 3]!;
          const y = this.airportUnit[i * 3 + 1]!;
          const z = this.airportUnit[i * 3 + 2]!;
          if (x * cam.x + y * cam.y + z * cam.z <= 1.0) continue; // behind the horizon
          p = this.project(x, y, z);
        }
        if (!p) continue;
        const d = (p.sx - px) ** 2 + (p.sy - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return { kind: 'airport', index: best };

    // 2) Thick-line routes (small sets) via screen-space distance to sampled arcs: the routes of
    //    the selected airport when there is a selection, otherwise the notable routes.
    let bestRoute = -1;
    let bestRouteD = ROUTE_PICK_RADIUS_PX;
    for (const [routeId, arc] of this.highlight.pickArcs) {
      for (const off of offsets) {
        let prev: { sx: number; sy: number } | null = null;
        for (let i = 0; i < arc.length; i += 3) {
          const x = arc[i]! + off;
          const y = arc[i + 1]!;
          const z = arc[i + 2]!;
          const p = flat || this.isUnoccluded(x, y, z) ? this.project(x, y, z) : null;
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
    }
    if (bestRoute >= 0) return { kind: 'route', routeId: bestRoute };
    return null;
  }
}

/** Spherical interpolation between two unit vectors (handles the antiparallel case). */
function slerpUnit(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-5) return a.clone();
  let axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() < 1e-10) axis = new THREE.Vector3(0, 1, 0);
  return a.clone().applyAxisAngle(axis.normalize(), angle * t);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
