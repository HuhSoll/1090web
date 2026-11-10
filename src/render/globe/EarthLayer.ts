import * as THREE from 'three';
import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MultiLineString } from 'geojson';
import countriesUrl from 'world-atlas/countries-110m.json?url';
import {
  ATMOSPHERE_FRAGMENT,
  ATMOSPHERE_VERTEX,
  EARTH_FRAGMENT,
  EARTH_VERTEX,
  GEO_LINE_FRAGMENT,
  GEO_LINE_VERTEX,
} from '../shaders/earthShaders';
import { Wrapped } from './wrapCopies';

type WorldTopology = Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
export type MorphUniform = { value: number };

const DEG2RAD = Math.PI / 180;

/**
 * Colour for our raw ShaderMaterials. THREE.Color converts sRGB hex to linear by default, but
 * these shaders write the value straight to the screen, so the hex would render much darker
 * than picked. Storing it "as linear" keeps the on-screen colour equal to the hex.
 */
const screenColor = (hex: string) => new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace);

const OCEAN = '#050a14';
const LAND = '#1c3049';
const RIM = '#2a6f9e';
const GRATICULE = '#3b6a8f';
const BORDERS = '#4a7398';
const COAST = '#6a9cc6';
const ADVISORY = '#e0963c';

/**
 * Dark, minimal Earth that can morph between a globe and a flat (equirectangular) map:
 * a surface shaded from a land mask (rasterised once from Natural Earth via world-atlas),
 * vector borders/coastlines, a faint graticule and a globe-only atmosphere rim.
 */
export class EarthLayer {
  readonly group = new THREE.Group();
  private readonly earthMaterial: THREE.ShaderMaterial;
  private readonly atmosphere: THREE.Mesh;
  private readonly atmosphereMaterial: THREE.ShaderMaterial;
  private readonly wrapped: Wrapped<THREE.Mesh | THREE.LineSegments>[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly morph: MorphUniform;
  private topo: WorldTopology | null = null;
  private advisoryCanvas: HTMLCanvasElement | null = null;
  private advisoryTexture: THREE.CanvasTexture | null = null;
  private pendingAdvisoryIds: readonly string[] = [];

  constructor(morph: MorphUniform) {
    this.morph = morph;
    const sphere = new THREE.SphereGeometry(1, 160, 100);
    this.earthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: EARTH_VERTEX,
      fragmentShader: EARTH_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: {
        uMorph: morph,
        uLandMask: { value: null },
        uHasMask: { value: 0 },
        uOcean: { value: screenColor(OCEAN) },
        uLand: { value: screenColor(LAND) },
        uRim: { value: screenColor(RIM) },
        uAdvisoryMask: { value: null },
        uHasAdvisory: { value: 0 },
        uAdvisory: { value: screenColor(ADVISORY) },
      },
    });
    const earth = new THREE.Mesh(sphere, this.earthMaterial);
    // Vertex positions are computed in the shader; the bounding volume is meaningless.
    earth.frustumCulled = false;
    earth.renderOrder = 0;
    this.wrapped.push(new Wrapped<THREE.Mesh | THREE.LineSegments>(earth).addTo(this.group));

    const atmosphereGeom = new THREE.SphereGeometry(1.09, 96, 64);
    this.atmosphereMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      uniforms: {
        uColor: { value: screenColor('#3d8fd1') },
        uFalloff: { value: 0.42 },
        uIntensity: { value: 0.32 },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.atmosphere = new THREE.Mesh(atmosphereGeom, this.atmosphereMaterial);
    this.group.add(this.atmosphere);

    this.addLines(geoGraticule10() as MultiLineString, 1.0004, 0.0004, GRATICULE, 0.06);

    this.disposables.push(sphere, this.earthMaterial, atmosphereGeom, this.atmosphereMaterial);
  }

  /** Called every frame with the current morph and whether the flat copies should be drawn. */
  update(copies: boolean | readonly boolean[]): void {
    const m = this.morph.value;
    this.atmosphere.visible = m < 0.99;
    this.atmosphereMaterial.uniforms.uIntensity!.value = 0.32 * (1 - m) * (1 - m);
    for (const w of this.wrapped) w.setVisible(true, copies);
  }

  /** Loads the basemap (land mask + borders). Rejects on failure; the caller decides how to report. */
  async loadBasemap(maxTextureSize: number, signal?: AbortSignal): Promise<void> {
    const res = await fetch(countriesUrl, { signal });
    if (!res.ok) throw new Error(`Basemap HTTP ${res.status}`);
    const topo = (await res.json()) as WorldTopology;
    this.topo = topo;

    const land = feature(topo, topo.objects.land);
    const width = Math.min(4096, maxTextureSize);
    const height = width / 2;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const projection = geoEquirectangular()
      .scale(width / (2 * Math.PI))
      .translate([width / 2, height / 2])
      .precision(0.1);
    const path = geoPath(projection, ctx);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    path(land);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.earthMaterial.uniforms.uLandMask!.value = texture;
    this.earthMaterial.uniforms.uHasMask!.value = 1;
    this.disposables.push(texture);

    const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b) as MultiLineString;
    const coast = mesh(topo, topo.objects.land) as MultiLineString;
    this.addLines(borders, 1.0006, 0.0008, BORDERS, 0.3);
    this.addLines(coast, 1.0006, 0.0008, COAST, 0.45);
    this.setAdvisoryCountries(this.pendingAdvisoryIds);
  }

  /**
   * Tints whole countries (ISO numeric ids, as in world-atlas) for the advisory overlay.
   * Rasterised into a small equirectangular mask that the earth shader samples, so it works on
   * both the globe and the flat map. Cheap enough to redraw on every month change.
   */
  setAdvisoryCountries(ids: readonly string[]): void {
    this.pendingAdvisoryIds = ids;
    const uniforms = this.earthMaterial.uniforms;
    if (!this.topo) return;
    if (ids.length === 0) {
      uniforms.uHasAdvisory!.value = 0;
      return;
    }
    if (!this.advisoryCanvas) {
      this.advisoryCanvas = document.createElement('canvas');
      this.advisoryCanvas.width = 2048;
      this.advisoryCanvas.height = 1024;
    }
    const canvas = this.advisoryCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const projection = geoEquirectangular()
      .scale(canvas.width / (2 * Math.PI))
      .translate([canvas.width / 2, canvas.height / 2])
      .precision(0.1);
    const path = geoPath(projection, ctx);
    const wanted = new Set(ids);
    const countries = feature(this.topo, this.topo.objects.countries);
    ctx.fillStyle = '#fff';
    for (const f of countries.features) {
      if (f.id === undefined || !wanted.has(String(f.id))) continue;
      ctx.beginPath();
      path(f);
      ctx.fill();
    }
    if (!this.advisoryTexture) {
      this.advisoryTexture = new THREE.CanvasTexture(canvas);
      this.advisoryTexture.colorSpace = THREE.NoColorSpace;
      this.advisoryTexture.generateMipmaps = false;
      this.advisoryTexture.minFilter = THREE.LinearFilter;
      this.disposables.push(this.advisoryTexture);
      uniforms.uAdvisoryMask!.value = this.advisoryTexture;
    }
    this.advisoryTexture.needsUpdate = true;
    uniforms.uHasAdvisory!.value = 1;
  }

  /** Lines store (lat, lon) in radians; the shader projects them for globe or flat map. */
  private addLines(geom: MultiLineString, radius: number, flatZ: number, color: string, opacity: number): void {
    const positions: number[] = [];
    const MAX_STEP_DEG = 1.5;
    for (const line of geom.coordinates) {
      for (let i = 0; i < line.length - 1; i++) {
        const [lon1, lat1] = line[i] as [number, number];
        const [lon2, lat2] = line[i + 1] as [number, number];
        // Densify long segments so they follow the sphere instead of cutting through it.
        let dLon = lon2 - lon1;
        if (Math.abs(dLon) > 180) continue; // antimeridian split artefact
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(lat2 - lat1)) / MAX_STEP_DEG));
        dLon /= steps;
        const dLat = (lat2 - lat1) / steps;
        for (let s = 0; s < steps; s++) {
          positions.push((lat1 + dLat * s) * DEG2RAD, (lon1 + dLon * s) * DEG2RAD, 0);
          positions.push((lat1 + dLat * (s + 1)) * DEG2RAD, (lon1 + dLon * (s + 1)) * DEG2RAD, 0);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GEO_LINE_VERTEX,
      fragmentShader: GEO_LINE_FRAGMENT,
      uniforms: {
        uMorph: this.morph,
        uRadius: { value: radius },
        uFlatZ: { value: flatZ },
        uColor: { value: screenColor(color) },
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthWrite: false,
    });
    this.disposables.push(geometry, material);
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    this.wrapped.push(new Wrapped<THREE.Mesh | THREE.LineSegments>(lines).addTo(this.group));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
