import type * as THREE from 'three';
import { FLAT_WORLD_WIDTH } from '../../utils/geo';

/** Horizontal offsets of the extra copies drawn in flat-map mode (the main object sits at 0). */
export const COPY_OFFSETS = [-FLAT_WORLD_WIDTH, FLAT_WORLD_WIDTH] as const;

type Drawable = THREE.Object3D & { geometry: THREE.BufferGeometry };

/**
 * An object plus two clones shifted by one world width, sharing geometry and material.
 * On the flat map this makes the world repeat horizontally, so panning and routes that cross
 * the antimeridian stay seamless. On the globe only the main object is shown.
 */
export class Wrapped<T extends Drawable> {
  readonly main: T;
  readonly all: T[];

  constructor(main: T) {
    this.main = main;
    const copies = COPY_OFFSETS.map((dx) => {
      const c = main.clone() as T;
      c.position.x = dx;
      return c;
    });
    this.all = [main, ...copies];
  }

  addTo(parent: THREE.Object3D): this {
    for (const o of this.all) parent.add(o);
    return this;
  }

  setGeometry(g: T['geometry']): void {
    for (const o of this.all) o.geometry = g;
  }

  /**
   * @param copies whether the wrapped copies are drawn (flat map only): a boolean for both, or
   *               one flag per entry of COPY_OFFSETS (so off-screen copies are skipped)
   */
  setVisible(visible: boolean, copies: boolean | readonly boolean[]): void {
    this.main.visible = visible;
    for (let i = 1; i < this.all.length; i++) {
      const c = typeof copies === 'boolean' ? copies : (copies[i - 1] ?? false);
      this.all[i]!.visible = visible && c;
    }
  }
}
