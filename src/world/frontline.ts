import type { Noise2D } from '../util/noise';
import { WORLD_SCALE } from './terrain';

/** The front runs roughly north–south. West (−x) is friendly, east (+x) is enemy. */
export class Frontline {
  constructor(private noise: Noise2D) {}

  x(z: number): number {
    return 900 * WORLD_SCALE + 520 * this.noise.noise(z * 0.00035, 7.3) + 140 * this.noise.noise(z * 0.0014, 3.1);
  }

  /** Signed distance (approx.) from the front. Positive = enemy territory. */
  side(x: number, z: number): number {
    return x - this.x(z);
  }
}
