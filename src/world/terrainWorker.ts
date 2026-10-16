/// <reference lib="webworker" />
/**
 * Works out terrain tiles' natural heights off the main thread, with the
 * same Terrain code (so the numbers are identical): given the seed, the
 * flattened sites, the craters and the river distance grid, it posts back
 * each tile's heights as it finishes it.
 */
import { Noise2D } from '../util/noise';
import { Frontline } from './frontline';
import { TILES, Terrain, type Crater, type FlattenZone } from './terrain';

interface Job {
  seed: number;
  flattens: FlattenZone[];
  craters: Crater[];
  river: Float32Array;
  keys: number[];
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { seed, flattens, craters, river, keys } = e.data;
  // The same noises worldgen makes from the seed.
  const terrain = new Terrain(new Noise2D(seed ^ 0x1234), new Noise2D(seed ^ 0x5678), new Noise2D(seed ^ 0x9abc), new Frontline(new Noise2D(seed ^ 0xdef0)));
  terrain.flattens = flattens;
  for (const c of craters) terrain.addCrater(c);
  terrain.useRiverGrid(river);
  for (const key of keys) {
    const tx = key % TILES;
    const tz = (key - tx) / TILES;
    const h = terrain.naturalTile(tx, tz);
    (self as unknown as Worker).postMessage({ key, h }, [h.buffer]);
  }
  (self as unknown as Worker).postMessage({ done: true });
};
