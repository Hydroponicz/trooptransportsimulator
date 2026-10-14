import * as THREE from 'three';
import { Noise2D, RNG } from '../util/noise';
import { ColliderSet } from './colliders';
import { Frontline } from './frontline';
import { Props } from './props';
import { Roads } from './roads';
import { buildSite, type Site, type SiteKind, type SiteDecor } from './sites';
import { PLAY_HALF, Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { groundDetailTexture } from '../util/textures';

export type EnemyKind = 'aa' | 'mg' | 'manpads';
export interface EnemyPos {
  pos: THREE.Vector3;
  kind: EnemyKind;
}

export interface World {
  seed: number;
  terrain: Terrain;
  front: Frontline;
  sites: Site[];
  base: Site;
  colliders: ColliderSet;
  vegetation: Vegetation;
  roads: Roads;
  enemies: EnemyPos[];
  smokeSpots: THREE.Vector3[];
  windsocks: THREE.Object3D[];
  group: THREE.Group;
}

const NAMES: Record<SiteKind, string[]> = {
  base: ['Camp Anvil', 'Camp Liberty', 'Camp Ironside', 'Camp Bastion'],
  fob: ['FOB Viper', 'FOB Granite', 'FOB Hatchet', 'FOB Raven', 'FOB Sentinel', 'FOB Warhorse'],
  cop: ['COP Hammer', 'COP Spartan', 'COP Badger', 'COP Wolfhound', 'COP Tusk', 'COP Gauntlet', 'COP Mako', 'COP Rattler'],
  lz: ['LZ Alpha', 'LZ Bravo', 'LZ Charlie', 'LZ Delta', 'LZ Echo', 'LZ Foxtrot', 'LZ Golf', 'LZ Hotel', 'LZ India', 'LZ Juliet', 'LZ Kilo', 'LZ Lima'],
};

const RADIUS: Record<SiteKind, number> = { base: 175, fob: 112, cop: 64, lz: 34 };
const BLEND: Record<SiteKind, number> = { base: 110, fob: 80, cop: 70, lz: 45 };

export function generateWorld(seed: number, onProgress?: (msg: string) => void): World {
  const rng = new RNG(seed);
  const n1 = new Noise2D(seed ^ 0x1234);
  const n2 = new Noise2D(seed ^ 0x5678);
  const n3 = new Noise2D(seed ^ 0x9abc);
  const front = new Frontline(new Noise2D(seed ^ 0xdef0));
  const terrain = new Terrain(n1, n2, n3, front);
  const sites: Site[] = [];
  const names = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, [...v]])) as Record<SiteKind, string[]>;
  const takeName = (k: SiteKind) => {
    const arr = names[k];
    return arr.splice(Math.floor(rng.next() * arr.length), 1)[0] ?? `${k.toUpperCase()} ${sites.length}`;
  };

  /** Max height deviation across an area: lower = flatter. */
  const roughness = (x: number, z: number, r: number) => {
    const c = terrain.baseHeight(x, z);
    let dev = 0;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      for (const f of [0.5, 1]) dev = Math.max(dev, Math.abs(terrain.baseHeight(x + Math.cos(a) * r * f, z + Math.sin(a) * r * f) - c));
    }
    return dev;
  };

  const place = (kind: SiteKind, xr: (z: number) => [number, number], zr: [number, number], tries = 40): Site | null => {
    const radius = RADIUS[kind];
    let best: { x: number; z: number; score: number } | null = null;
    for (let i = 0; i < tries; i++) {
      const z = rng.range(zr[0], zr[1]);
      const [xa, xb] = xr(z);
      const x = rng.range(xa, xb);
      if (Math.abs(x) > PLAY_HALF - radius || Math.abs(z) > PLAY_HALF - radius) continue;
      if (terrain.baseHeight(x, z) < 6) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + radius + 220)) continue;
      const score = roughness(x, z, radius + 30);
      if (!best || score < best.score) best = { x, z, score };
    }
    if (!best) return null;
    let h = 0;
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i === 8 ? 0 : radius * 0.7;
      h += terrain.baseHeight(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r);
    }
    h = Math.max(4, h / 9);
    const fd = front.side(best.x, best.z);
    const site: Site = {
      id: sites.length,
      name: takeName(kind),
      kind,
      x: best.x,
      z: best.z,
      y: h,
      rot: kind === 'lz' ? 0 : Math.round(rng.range(-2, 2)) * (Math.PI / 2) + rng.range(-0.3, 0.3),
      radius,
      pads: [],
      waits: [],
      enemySide: fd > 0,
      frontDist: fd,
      services: {
        fuel: kind !== 'lz' && kind !== 'cop',
        repair: kind === 'base' || kind === 'fob',
        hangar: kind === 'base',
        flares: kind !== 'lz',
      },
    };
    sites.push(site);
    terrain.flattens.push({ x: site.x, z: site.z, radius, blend: BLEND[kind], height: h });
    return site;
  };

  onProgress?.('Surveying terrain');
  const base = place('base', () => [-2900, -2200], [-1200, 1200], 80)!;
  const bands = (n: number, lo: number, hi: number) =>
    Array.from({ length: n }, (_, i) => [lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n] as [number, number]);
  for (const zr of bands(3, -2700, 2700)) place('fob', (z) => [-1800, front.x(z) - 1000], zr, 50);
  for (const zr of bands(6, -2900, 2900)) place('cop', (z) => [front.x(z) - 650, front.x(z) - 280], zr, 40);
  for (const zr of bands(7, -2900, 2900)) place('lz', (z) => [front.x(z) - 1500, front.x(z) - 200], zr, 30);
  for (const zr of bands(4, -2600, 2600)) place('lz', (z) => [front.x(z) + 250, front.x(z) + 1100], zr, 30);

  // Shell craters along the front.
  const nearSite = (x: number, z: number, m: number) => sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m);
  for (let i = 0; i < 340; i++) {
    const z = rng.range(-PLAY_HALF, PLAY_HALF);
    const x = front.x(z) + rng.gauss() * 230;
    if (nearSite(x, z, 60)) continue;
    terrain.addCrater({ x, z, r: rng.range(6, 17), depth: rng.range(1.2, 3.2) });
  }

  onProgress?.('Raising terrain');
  const detail = groundDetailTexture();
  const group = new THREE.Group();
  group.add(terrain.build(detail));

  onProgress?.('Building outposts');
  const colliders = new ColliderSet();
  const props = new Props(colliders);
  const decor: SiteDecor = { group: new THREE.Group(), windsocks: [] };
  for (const s of sites) buildSite(s, props, terrain, rng.fork(), decor);

  // Enemy positions on the far side of the line.
  const enemies: EnemyPos[] = [];
  const enemyPlace = (kind: EnemyKind, lo: number, hi: number, n: number) => {
    let made = 0;
    for (let t = 0; t < n * 10 && made < n; t++) {
      const z = rng.range(-PLAY_HALF + 200, PLAY_HALF - 200);
      const x = front.x(z) + rng.range(lo, hi);
      if (Math.abs(x) > PLAY_HALF - 100) continue;
      if (nearSite(x, z, 220)) continue;
      const y = terrain.heightAt(x, z);
      if (y < 2) continue;
      enemies.push({ pos: new THREE.Vector3(x, y, z), kind });
      props.add(kind === 'aa' ? 'aagun' : 'sandbag', x, y, z, rng.range(0, 6));
      if (kind !== 'aa') {
        props.add('sandbag', x + 1.6, y, z + 0.8, rng.range(0, 6));
        props.add('sandbag', x - 1.2, y, z + 1.4, rng.range(0, 6));
      }
      made++;
    }
  };
  enemyPlace('aa', 450, 1900, 8);
  enemyPlace('mg', 120, 900, 18);
  enemyPlace('manpads', 400, 1700, 5);

  // Burning wrecks along the front.
  const smokeSpots: THREE.Vector3[] = [];
  for (let i = 0; i < 14; i++) {
    const z = rng.range(-PLAY_HALF + 300, PLAY_HALF - 300);
    const x = front.x(z) + rng.gauss() * 160;
    if (nearSite(x, z, 40)) continue;
    const y = terrain.heightAt(x, z);
    if (y < 1) continue;
    props.add('wreck', x, y, z, rng.range(0, 6));
    smokeSpots.push(new THREE.Vector3(x, y + 1.5, z));
  }

  onProgress?.('Grading roads');
  const roads = new Roads(terrain);
  const fobs = sites.filter((s) => s.kind === 'fob');
  const cops = sites.filter((s) => s.kind === 'cop');
  for (const f of fobs) roads.add(base.x, base.z, f.x, f.z, rng);
  for (const c of cops) {
    const f = fobs.reduce((a, b) => (Math.hypot(a.x - c.x, a.z - c.z) < Math.hypot(b.x - c.x, b.z - c.z) ? a : b));
    roads.add(f.x, f.z, c.x, c.z, rng);
  }
  group.add(roads.build());

  onProgress?.('Planting forests');
  const blocked = (x: number, z: number) =>
    nearSite(x, z, 28) || roads.distance(x, z) < 9 || enemies.some((e) => Math.abs(e.pos.x - x) < 14 && Math.abs(e.pos.z - z) < 14);
  const vegetation = new Vegetation(terrain, n3, rng.fork(), blocked);
  group.add(vegetation.group);
  group.add(props.build());
  group.add(decor.group);

  return {
    seed,
    terrain,
    front,
    sites,
    base,
    colliders,
    vegetation,
    roads,
    enemies,
    smokeSpots,
    windsocks: decor.windsocks,
    group,
  };
}
