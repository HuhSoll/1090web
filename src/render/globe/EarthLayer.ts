import * as THREE from 'three';
import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MultiLineString } from 'geojson';
import countriesUrl from 'world-atlas/countries-110m.json?url';
import { latLonToVec3 } from '../../utils/geo';
import {
  ATMOSPHERE_FRAGMENT,
  ATMOSPHERE_VERTEX,
  EARTH_FRAGMENT,
  EARTH_VERTEX,
} from '../shaders/earthShaders';

type WorldTopology = Topology<{ countries: GeometryCollection; land: GeometryCollection }>;

/**
 * Dark, minimal Earth: a sphere shaded from a land mask texture (rasterised once from Natural
 * Earth via world-atlas), vector borders/coastlines as thin line segments, a faint graticule and
 * a subtle atmosphere rim.
 */
export class EarthLayer {
  readonly group = new THREE.Group();
  private readonly earthMaterial: THREE.ShaderMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    const sphere = new THREE.SphereGeometry(1, 128, 96);
    this.earthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: EARTH_VERTEX,
      fragmentShader: EARTH_FRAGMENT,
      uniforms: {
        uLandMask: { value: null },
        uHasMask: { value: 0 },
        uOcean: { value: new THREE.Color('#050b16') },
        uLand: { value: new THREE.Color('#16293f') },
        uRim: { value: new THREE.Color('#2a6f9e') },
      },
    });
    const earth = new THREE.Mesh(sphere, this.earthMaterial);
    // SphereGeometry's u=0 seam sits at our lon -90 (see utils/geo.ts convention); rotate so that
    // equirectangular texture longitude matches latLonToVec3().
    earth.rotation.y = -Math.PI / 2;
    earth.renderOrder = 0;
    this.group.add(earth);

    const atmosphereGeom = new THREE.SphereGeometry(1.09, 96, 64);
    const atmosphereMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      uniforms: {
        uColor: { value: new THREE.Color('#3d8fd1') },
        uFalloff: { value: 0.42 },
        uIntensity: { value: 0.32 },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(atmosphereGeom, atmosphereMat);
    this.group.add(atmosphere);

    const graticule = this.buildLines(geoGraticule10() as MultiLineString, 1.0004, '#3b6a8f', 0.07);
    this.group.add(graticule);

    this.disposables.push(sphere, this.earthMaterial, atmosphereGeom, atmosphereMat);
  }

  /** Loads the basemap (land mask + borders). Resolves even if it fails; the caller decides how to report. */
  async loadBasemap(maxTextureSize: number, signal?: AbortSignal): Promise<void> {
    const res = await fetch(countriesUrl, { signal });
    if (!res.ok) throw new Error(`Basemap HTTP ${res.status}`);
    const topo = (await res.json()) as WorldTopology;

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
    this.group.add(this.buildLines(borders, 1.0006, '#4f7fa6', 0.28));
    this.group.add(this.buildLines(coast, 1.0006, '#5d93bf', 0.42));
  }

  private buildLines(geom: MultiLineString, radius: number, color: string, opacity: number): THREE.LineSegments {
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
          positions.push(...latLonToVec3(lat1 + dLat * s, lon1 + dLon * s, radius));
          positions.push(...latLonToVec3(lat1 + dLat * (s + 1), lon1 + dLon * (s + 1), radius));
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    this.disposables.push(geometry, material);
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 1;
    return lines;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
