import { Rivers } from './water';
import { Crop, Farmland } from './farms';
import * as THREE from 'three';
import { Noise2D, RNG } from '../util/noise';
import { ColliderSet } from './colliders';
import { Frontline } from './frontline';
import { Props } from './props';
import { Roads, type RoadClass } from './roads';
import { buildRoadside } from './roadside';
import { buildSite, type Site, type SiteKind, type SiteDecor } from './sites';
import { PLAY_HALF, Terrain, WORLD_SCALE } from './terrain';
import { DistanceCuller, splitByCells } from './lod';
import { Vegetation } from './vegetation';
import { buildTown, CITY_NAMES, TOWN_NAMES, type SettlementKind, type Town } from './towns';
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
  towns: Town[];
  enemies: EnemyPos[];
  smokeSpots: THREE.Vector3[];
  windsocks: THREE.Object3D[];
  group: THREE.Group;
  /** Hides far-off chunks of forest, props and roadside furniture. */
  culler: DistanceCuller;
  rivers: Rivers;
  farmland: Farmland;
}

const NAMES: Record<SiteKind, string[]> = {
  base: ['Camp Anvil', 'Camp Liberty', 'Camp Ironside', 'Camp Bastion'],
  fob: ['FOB Viper', 'FOB Granite', 'FOB Hatchet', 'FOB Raven', 'FOB Sentinel', 'FOB Warhorse', 'FOB Talon', 'FOB Cobra', 'FOB Bulldog', 'FOB Phoenix', 'FOB Tomahawk', 'FOB Lancer'],
  cop: [
    'COP Hammer', 'COP Spartan', 'COP Badger', 'COP Wolfhound', 'COP Tusk', 'COP Gauntlet', 'COP Mako', 'COP Rattler',
    'COP Javelin', 'COP Coyote', 'COP Bayonet', 'COP Stryker', 'COP Kodiak', 'COP Saber', 'COP Wolverine', 'COP Grizzly',
  ],
  lz: [
    'LZ Alpha', 'LZ Bravo', 'LZ Charlie', 'LZ Delta', 'LZ Echo', 'LZ Foxtrot', 'LZ Golf', 'LZ Hotel', 'LZ India', 'LZ Juliet', 'LZ Kilo', 'LZ Lima',
    'LZ Mike', 'LZ November', 'LZ Oscar', 'LZ Papa', 'LZ Quebec', 'LZ Romeo', 'LZ Sierra', 'LZ Tango', 'LZ Uniform', 'LZ Victor', 'LZ Whiskey', 'LZ Xray',
  ],
};

const RADIUS: Record<SiteKind, number> = { base: 175, fob: 112, cop: 64, lz: 34 };
const BLEND: Record<SiteKind, number> = { base: 110, fob: 80, cop: 70, lz: 45 };

export function generateWorld(seed: number, report?: (msg: string) => void): World {
  // Time each phase (logged once at the end) so slow generation is easy to pin down.
  const marks: [string, number][] = [['start', performance.now()]];
  const onProgress = (msg: string) => {
    marks.push([msg, performance.now()]);
    report?.(msg);
  };
  const rng = new RNG(seed);
  const n1 = new Noise2D(seed ^ 0x1234);
  const n2 = new Noise2D(seed ^ 0x5678);
  const n3 = new Noise2D(seed ^ 0x9abc);
  const front = new Frontline(new Noise2D(seed ^ 0xdef0));
  const terrain = new Terrain(n1, n2, n3, front);
  const sites: Site[] = [];
  const towns: Town[] = [];
  const townNames = [...TOWN_NAMES];
  const cityNames = [...CITY_NAMES];
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
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + radius + 150)) continue;
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
      facilities: [],
    };
    sites.push(site);
    terrain.flattens.push({ x: site.x, z: site.z, radius, blend: BLEND[kind], height: h });
    return site;
  };

  onProgress?.('Surveying terrain');
  // Everything is laid out on the original 6.2 km plan, scaled up to the current map.
  const K = WORLD_SCALE;
  const base = place('base', () => [-2900 * K, -2200 * K], [-1200 * K, 1200 * K], 80)!;
  const bands = (n: number, lo: number, hi: number) =>
    Array.from({ length: n }, (_, i) => [lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n] as [number, number]);
  for (const zr of bands(6, -2700 * K, 2700 * K)) place('fob', (z) => [-1800 * K, front.x(z) - 1000], zr, 50);
  for (const zr of bands(12, -2900 * K, 2900 * K)) place('cop', (z) => [front.x(z) - 650, front.x(z) - 280], zr, 40);
  // Towns: some straddle the front (contested), others sit safely behind either line.
  const placeTown = (kind: SettlementKind, contested: boolean, xr: (z: number) => [number, number], zr: [number, number], rr: [number, number]) => {
    let best: { x: number; z: number; r: number; score: number } | null = null;
    const gap = kind === 'village' ? 260 : 400;
    for (let i = 0; i < (kind === 'city' ? 120 : 40); i++) {
      const z = rng.range(zr[0], zr[1]);
      const [xa, xb] = xr(z);
      if (xb <= xa) continue;
      const x = rng.range(xa, xb);
      const r = rng.range(rr[0], rr[1]);
      if (Math.abs(x) > PLAY_HALF - r - 100 || Math.abs(z) > PLAY_HALF - r - 100) continue;
      if (terrain.baseHeight(x, z) < 6) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + r + 140)) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r + gap)) continue;
      // Away from rivers: a settlement needs dry, level ground.
      if (terrain.river(x, z).dist < r + 60) continue;
      const score = roughness(x, z, r);
      if (!best || score < best.score) best = { x, z, r, score };
    }
    if (!best) return;
    let h = 0;
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rr2 = i === 8 ? 0 : best.r * 0.7;
      h += terrain.baseHeight(best.x + Math.cos(a) * rr2, best.z + Math.sin(a) * rr2);
    }
    h = Math.max(5, h / 9);
    const names = kind === 'city' && cityNames.length ? cityNames : townNames;
    const town: Town = {
      name: names.splice(Math.floor(rng.next() * names.length), 1)[0] ?? 'Town',
      x: best.x,
      z: best.z,
      y: h,
      r: best.r,
      rot: rng.range(-0.6, 0.6),
      kind,
      contested,
      enemySide: front.side(best.x, best.z) > 0,
      streets: [],
    };
    towns.push(town);
    terrain.flattens.push({ x: town.x, z: town.z, radius: town.r + 10, blend: kind === 'city' ? 260 : 170, height: h });
    // Farmland round towns and villages (cities are ringed by their suburbs).
    if (!contested && kind !== 'city') terrain.farms.push({ x: town.x, z: town.z, rot: town.rot, r: town.r });
  };
  // Cities first (they need the most room): two behind our lines, one behind theirs.
  for (const zr of bands(2, -2600 * K, 2600 * K)) placeTown('city', false, (z) => [-2500 * K, front.x(z) - 1700], zr, [480, 600]);
  placeTown('city', false, (z) => [front.x(z) + 1700, 2700 * K], [-2000 * K, 2000 * K], [420, 520]);
  for (const zr of bands(6, -2600 * K, 2600 * K)) placeTown('town', true, (z) => [front.x(z) - 90, front.x(z) + 90], zr, [150, 190]);
  for (const zr of bands(6, -2700 * K, 2700 * K)) placeTown('town', false, (z) => [-2600 * K, front.x(z) - 1000], zr, [170, 230]);
  for (const zr of bands(3, -2400 * K, 2400 * K)) placeTown('town', false, (z) => [front.x(z) + 900, 2800 * K], zr, [160, 210]);
  // Farming villages on the outskirts of each city, then more scattered through the countryside.
  for (const c of towns.filter((q) => q.kind === 'city'))
    for (let k = 0; k < 3; k++) {
      const R = c.r + 1400;
      const enemy = front.side(c.x, c.z) > 0;
      placeTown('village', false, (z) => (enemy ? [Math.max(c.x - R, front.x(z) + 700), c.x + R] : [c.x - R, Math.min(c.x + R, front.x(z) - 700)]), [c.z - R, c.z + R], [60, 95]);
    }
  // Villages and farming communities scattered through the countryside.
  for (const zr of bands(16, -2800 * K, 2800 * K)) placeTown('village', false, (z) => [-2700 * K, front.x(z) - 700], zr, [55, 100]);
  for (const zr of bands(8, -2600 * K, 2600 * K)) placeTown('village', false, (z) => [front.x(z) + 700, 2800 * K], zr, [55, 95]);

  for (const zr of bands(14, -2900 * K, 2900 * K)) place('lz', (z) => [front.x(z) - 1500 * K, front.x(z) - 200], zr, 30);
  for (const zr of bands(8, -2600 * K, 2600 * K)) place('lz', (z) => [front.x(z) + 250, front.x(z) + 1100 * K], zr, 30);

  // Shell craters along the front.
  // Sites and towns bucketed by 500 m cell (rebuilt if more are added), so placement checks stay cheap on a big map.
  const SG = 500;
  const siteGrid = new Map<number, { x: number; z: number; r: number }[]>();
  let gridCount = -1;
  const nearSite = (x: number, z: number, m: number) => {
    if (gridCount !== sites.length + towns.length) {
      gridCount = sites.length + towns.length;
      siteGrid.clear();
      for (const o of [...sites.map((s) => ({ x: s.x, z: s.z, r: s.radius })), ...towns.map((t) => ({ x: t.x, z: t.z, r: t.r }))]) {
        const R = o.r + 300;
        for (let cx = Math.floor((o.x - R) / SG); cx <= Math.floor((o.x + R) / SG); cx++)
          for (let cz = Math.floor((o.z - R) / SG); cz <= Math.floor((o.z + R) / SG); cz++) {
            const k = cx + 1000 + (cz + 1000) * 3000;
            let arr = siteGrid.get(k);
            if (!arr) siteGrid.set(k, (arr = []));
            arr.push(o);
          }
      }
    }
    if (m > 300) return sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m) || towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + m);
    const arr = siteGrid.get(Math.floor(x / SG) + 1000 + (Math.floor(z / SG) + 1000) * 3000);
    return !!arr && arr.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + m);
  };
  for (let i = 0; i < 340 * 2; i++) {
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
  // Plan the road network before building the sites, so each site can be
  // turned to face its connections with a proper gate.
  const plan = planNetwork(sites, towns, terrain);
  for (const s of sites) buildSite(s, props, terrain, rng.fork(), decor);
  for (const t of towns) buildTown(t, props, terrain, rng.fork());
  // Farmland: crops per plot (for the ground shader, crops and machinery), farmyards, pastures, bales.
  const farmland = new Farmland(terrain, front, rng.fork(), sites);
  terrain.fieldTex.value = farmland.texture;

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
  enemyPlace('aa', 450, 1900 * K, 16);
  enemyPlace('mg', 120, 900, 36);
  enemyPlace('manpads', 400, 1700 * K, 10);

  // Burning wrecks along the front.
  const smokeSpots: THREE.Vector3[] = [];
  for (let i = 0; i < 28; i++) {
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
  const nearSiteXZ = (x: number, z: number, m: number) => sites.some((st) => Math.hypot(st.x - x, st.z - z) < st.radius + m);
  // Access roads: from inside each site out through its gate to a junction.
  const stubs = new Set<number>();
  for (const g of plan.gates) {
    roads.add(g.inner.x, g.inner.y, g.junction.x, g.junction.y, rng, g.site.kind === 'cop' ? 'secondary' : 'main', { straight: true, freeEnd: true });
    stubs.add(roads.paths.length - 1);
    roads.gates.push({ x: g.gate.x, z: g.gate.y, dx: g.dir.x, dz: g.dir.y, junction: g.junction.clone(), site: g.site.name });
  }
  // Sites with a front and back gate: an internal road joins the two motor pools.
  for (const site of sites) {
    const two = plan.gates.filter((g) => g.site === site);
    if (two.length === 2) {
      roads.add(two[0].inner.x, two[0].inner.y, two[1].inner.x, two[1].inner.y, rng, site.kind === 'cop' ? 'secondary' : 'main', { straight: true });
      stubs.add(roads.paths.length - 1);
    }
  }
  // Join a new road onto the network: from the parent's junction, or with a
  // T-junction off an existing road when that is clearly closer, so roads
  // branch like a real network instead of running side by side.
  const connect = (from: THREE.Vector2 | null, fromDir: THREE.Vector2 | undefined, to: THREE.Vector2, toDir: THREE.Vector2 | undefined, cls: RoadClass) => {
    let best: { pi: number; k: number; d: number } | null = null;
    roads.paths.forEach((path, pi) => {
      if (stubs.has(pi) || path.length < 12) return;
      for (let k = 6; k < path.length - 6; k++) {
        const dd = Math.hypot(path[k].x - to.x, path[k].y - to.y);
        if (best && dd >= best.d) continue;
        if (nearSiteXZ(path[k].x, path[k].y, 30)) continue;
        // Not on a stretch that will end up a bridge: no water nearby along
        // the host or the first stretch of the branch, and fairly even ground.
        const y = terrain.heightAt(path[k].x, path[k].y);
        const ya = terrain.heightAt(path[k - 6].x, path[k - 6].y);
        const yb = terrain.heightAt(path[k + 6].x, path[k + 6].y);
        if (y < 2.5 || Math.abs(y - (ya + yb) / 2) > 3) continue;
        let wet = false;
        let lo = Infinity;
        let hi = -Infinity;
        for (let q = Math.max(0, k - 10); q <= Math.min(path.length - 1, k + 10); q++) {
          const g = terrain.heightAt(path[q].x, path[q].y);
          if (g < 2.5) wet = true;
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
        for (let m = 10; m <= 80 && !wet; m += 10) {
          const bx = path[k].x + ((to.x - path[k].x) / (dd || 1)) * m;
          const bz = path[k].y + ((to.y - path[k].y) / (dd || 1)) * m;
          if (terrain.heightAt(bx, bz) < 2.5) wet = true;
        }
        if (wet || hi - lo > 8) continue;
        // The branch must leave at a real angle, not run alongside the host.
        const tx = path[k + 1].x - path[k - 1].x;
        const tz = path[k + 1].y - path[k - 1].y;
        const tl = Math.hypot(tx, tz) || 1;
        if (Math.abs((tx * (to.x - path[k].x) + tz * (to.y - path[k].y)) / (tl * (dd || 1))) > 0.75) continue;
        best = { pi, k, d: dd };
      }
    });
    const direct = from ? from.distanceTo(to) : Infinity;
    const b = best as { pi: number; k: number; d: number } | null;
    // Would the new road leave its junction alongside a road already leaving it?
    // Then it must branch off that road rather than run next to it.
    let sibling = false;
    if (from) {
      const want = new THREE.Vector2().subVectors(to, from).normalize();
      for (const [pi, path] of roads.paths.entries()) {
        if (stubs.has(pi) || path.length < 6) continue;
        const atStart = path[0].distanceTo(from) < 1;
        const atEnd = path[path.length - 1].distanceTo(from) < 1;
        if (!atStart && !atEnd) continue;
        const a = atStart ? path[0] : path[path.length - 1];
        const c = atStart ? path[5] : path[path.length - 6];
        if (new THREE.Vector2().subVectors(c, a).normalize().dot(want) > 0.8) sibling = true;
      }
    }
    if (b && (b.d < direct * 0.95 || (sibling && b.d < direct * 1.3))) {
      const host = roads.paths[b.pi];
      const P = host[b.k].clone();
      const t = new THREE.Vector2().subVectors(host[b.k + 1], host[b.k - 1]).normalize();
      const away = new THREE.Vector2().subVectors(to, P);
      // Leave square to the host road, on the side the destination is.
      const n = new THREE.Vector2(-t.y, t.x);
      const leave = n.dot(away) >= 0 ? n : n.clone().negate();
      roads.split(b.pi, b.k);
      roads.junctionPads.push(P);
      layClear(P, leave, to, toDir, cls, true);
    } else if (from) {
      layClear(from, fromDir, to, toDir, cls, false);
    }
  };
  // Lay a road, re-rolling its curve (and swinging its departure) if it would
  // run alongside an existing road; keep the attempt with the least overlap.
  function layClear(a: THREE.Vector2, leaveA: THREE.Vector2 | undefined, b: THREE.Vector2, leaveB: THREE.Vector2 | undefined, cls: RoadClass, freeStart: boolean) {
    let bestTry = -1;
    let bestOverlap = Infinity;
    for (let t = 0; t < 6; t++) {
      const swing = t === 0 ? 0 : (t % 2 ? 1 : -1) * 0.35 * Math.ceil(t / 2);
      const la = leaveA ? leaveA.clone().rotateAround(new THREE.Vector2(), swing) : undefined;
      const seed = rng.int(0, 1e9);
      roads.add(a.x, a.y, b.x, b.y, new RNG(seed), cls, { leaveA: la, leaveB, freeStart });
      const o = roads.overlap(roads.paths.length - 1);
      roads.removeLast();
      if (o < bestOverlap) {
        bestOverlap = o;
        bestTry = seed * 10 + t;
      }
      if (o === 0) break;
    }
    const t = bestTry % 10;
    const seed = Math.floor(bestTry / 10);
    const swing = t === 0 ? 0 : (t % 2 ? 1 : -1) * 0.35 * Math.ceil(t / 2);
    roads.add(a.x, a.y, b.x, b.y, new RNG(seed), cls, { leaveA: leaveA ? leaveA.clone().rotateAround(new THREE.Vector2(), swing) : undefined, leaveB, freeStart });
  }
  for (const r of plan.links) {
    const cls = r.a.site.kind === 'cop' || r.b.site.kind === 'cop' ? 'secondary' : 'main';
    connect(r.a.junction, r.a.dir, r.b.junction, r.b.dir, cls);
  }
  // Every town gets a track: rear villages and contested towns join the
  // nearest road or hub junction, enemy villages the nearest enemy-side town.
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  const linked = new Set<string>();
  for (const t of towns) {
    const hub = plan.townLinks.get(t);
    const edge = (o: { x: number; z: number }) => {
      const d = Math.hypot(o.x - t.x, o.z - t.z) || 1;
      return new THREE.Vector2(t.x + ((o.x - t.x) / d) * t.r * 0.85, t.z + ((o.z - t.z) / d) * t.r * 0.85);
    };
    if (hub) {
      // Cities get a main road, towns a secondary one, villages a track.
      connect(hub.junction, hub.dir, edge({ x: hub.junction.x, z: hub.junction.y }), undefined, t.kind === 'city' ? 'main' : t.kind === 'town' && !t.contested ? 'secondary' : 'track');
    } else if (t.enemySide && !t.contested) {
      const others = towns.filter((o) => o !== t && (o.contested || o.enemySide));
      if (!others.length) continue;
      const o = others.reduce((a, b) => (dist(a, t) < dist(b, t) ? a : b));
      // Mutual nearest neighbours would otherwise get two overlapping tracks.
      const pair = [t.name, o.name].sort().join('|');
      if (linked.has(pair)) continue;
      linked.add(pair);
      const from = new THREE.Vector2(o.x + ((t.x - o.x) / (dist(o, t) || 1)) * o.r * 0.85, o.z + ((t.z - o.z) / (dist(o, t) || 1)) * o.r * 0.85);
      const e = edge(o);
      roads.add(from.x, from.y, e.x, e.y, rng, 'track');
    }
  }
  // Country roads between the towns and villages behind each line, for civilian
  // traffic: each joins its nearest neighbours (cities a few more), never
  // passing close to a military site and never running near the front.
  {
    const peaceful = towns.filter((t) => !t.contested && Math.abs(front.side(t.x, t.z)) > 1500);
    const military = sites.filter((s) => s.kind !== 'lz');
    const pairs = new Set<string>();
    const clearOfSites = (a: THREE.Vector2, b: THREE.Vector2) => {
      for (let k = 0; k <= 20; k++) {
        const x = a.x + ((b.x - a.x) * k) / 20;
        const z = a.y + ((b.y - a.y) * k) / 20;
        if (military.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 260)) return false;
        if (Math.abs(front.side(x, z)) < 1300) return false;
      }
      return true;
    };
    for (const t of peaceful) {
      const side = front.side(t.x, t.z) > 0;
      const others = peaceful
        .filter((o) => o !== t && front.side(o.x, o.z) > 0 === side)
        .sort((a, b) => dist(a, t) - dist(b, t));
      const want = t.kind === 'city' ? 4 : t.kind === 'town' ? 2 : 1;
      let made = 0;
      for (const o of others) {
        if (made >= want || dist(o, t) > 4800) break;
        const pair = [t.name, o.name].sort().join('|');
        if (pairs.has(pair)) {
          made++;
          continue;
        }
        const d = dist(o, t) || 1;
        const a = new THREE.Vector2(t.x + ((o.x - t.x) / d) * t.r * 0.95, t.z + ((o.z - t.z) / d) * t.r * 0.95);
        const b = new THREE.Vector2(o.x + ((t.x - o.x) / d) * o.r * 0.95, o.z + ((t.z - o.z) / d) * o.r * 0.95);
        if (!clearOfSites(a, b)) continue;
        // Not straight through another settlement either.
        if (peaceful.some((q) => q !== t && q !== o && segPointDist(a, b, q.x, q.z) < q.r + 40)) continue;
        pairs.add(pair);
        made++;
        const big = t.kind === 'city' || o.kind === 'city';
        layClear(a, undefined, b, undefined, big ? 'main' : t.kind === 'village' && o.kind === 'village' ? 'track' : 'secondary', false);
        // Drop it if it would run alongside another road for a stretch (a crossing is fine):
        // two roads that close on different levels can't both be graded cleanly.
        const pi = roads.paths.length - 1;
        const path = roads.paths[pi];
        let alongside = 0;
        for (let i = 4; i < path.length - 4; i++) {
          // Probe across the road out to ~35 m each side (the lookup itself only reaches ~12 m).
          const tx = path[i + 1].x - path[i - 1].x;
          const tz = path[i + 1].y - path[i - 1].y;
          const tl = Math.hypot(tx, tz) || 1;
          if ([0, -12, 12, -24, 24].some((o) => roads.distanceExcept(path[i].x - (tz / tl) * o, path[i].y + (tx / tl) * o, pi) < 11)) alongside++;
        }
        if (alongside > 12) {
          roads.removeLast();
          pairs.delete(pair);
          made--;
          continue;
        }
        roads.civilian.add(pi);
      }
    }
  }
  roads.grade();
  // Clear a lane: walls get gates, and anything else sitting on a road is removed.
  // Large buildings are tested over their whole footprint, not just their center.
  props.removeAllWhere((x, z, box) => {
    if (roads.distance(x, z) < 9) return true;
    if (!box) return false;
    const x0 = box.minX - 3, x1 = box.maxX + 3, z0 = box.minZ - 3, z1 = box.maxZ + 3;
    const nx = Math.max(1, Math.ceil((x1 - x0) / 3)), nz = Math.max(1, Math.ceil((z1 - z0) / 3));
    for (let i = 0; i <= nx; i++)
      for (let j = 0; j <= nz; j++) if (roads.distance(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz) < 7.5) return true;
    return false;
  }, ['slab']);
  group.add(roads.build(colliders));

  // Power lines, guard rails, fences, lights, signs and checkpoints.
  const roadside = buildRoadside(roads, terrain, sites, towns, front, props, rng.fork());
  group.add(roadside);
  const yards = roadside.userData.yards as { x: number; z: number; r: number }[];

  // Rock outcrops and hay bales.
  for (let i = 0; i < 3600; i++) {
    const x = rng.range(-PLAY_HALF, PLAY_HALF);
    const z = rng.range(-PLAY_HALF, PLAY_HALF);
    const y = terrain.heightAt(x, z);
    if (y < 2 || nearSite(x, z, 20) || roads.distance(x, z) < 13) continue;
    const slope = terrain.baseSlope(x, z);
    if (slope > 0.18 || rng.chance(0.15)) {
      const n = rng.int(1, 4);
      for (let k = 0; k < n; k++) props.add('rock', x + rng.range(-4, 4), y - 0.3, z + rng.range(-4, 4), rng.range(0, 6), rng.range(0.8, 2.6));
    }
  }
  farmland.populate(props, terrain, rng.fork(), (x, z) => nearSite(x, z, 30) || roads.distance(x, z) < 12);

  onProgress?.('Planting forests');
  // No trees on the plots themselves (hedgerow trees along pastures are fine, now and then).
  const inFarmland = (x: number, z: number) => {
    const f = farmland.fieldAt(x, z);
    return !!f && (f.kind !== Crop.Pasture || n3.noise(x * 0.02, z * 0.02) > -0.7);
  };
  const blocked = (x: number, z: number) =>
    nearSite(x, z, 28) ||
    roads.distance(x, z) < 14 ||
    yards.some((q) => Math.hypot(q.x - x, q.z - z) < q.r) ||
    inFarmland(x, z) ||
    enemies.some((e) => Math.abs(e.pos.x - x) < 14 && Math.abs(e.pos.z - z) < 14);
  const culler = new DistanceCuller();
  const vegetation = new Vegetation(terrain, n3, rng.fork(), blocked, culler);
  group.add(vegetation.group);
  group.add(props.build(culler));
  // Long merged roadside meshes (rails, fences, wires) → per-cell pieces that can be culled.
  for (const child of [...roadside.children]) {
    const o = child as THREE.Mesh | THREE.LineSegments;
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.LineSegments).isLineSegments) continue;
    if ((o as THREE.InstancedMesh).isInstancedMesh) continue;
    o.geometry.computeBoundingSphere();
    if (o.geometry.boundingSphere!.radius < 1200) continue;
    roadside.remove(o);
    for (const piece of splitByCells(o, 3200)) {
      roadside.add(piece);
      culler.addMesh(piece, (o as THREE.LineSegments).isLineSegments ? 3500 : 4500);
    }
  }
  group.add(decor.group);
  const rivers = new Rivers(terrain);
  group.add(rivers.group);

  marks.push(['done', performance.now()]);
  console.info(
    `World generated in ${Math.round(marks[marks.length - 1][1] - marks[0][1])} ms:`,
    marks.slice(1).map(([m, t], i) => `${marks[i][0]} ${Math.round(t - marks[i][1])}ms`).join(', '),
  );
  return {
    seed,
    terrain,
    front,
    sites,
    base,
    colliders,
    vegetation,
    roads,
    towns,
    enemies,
    smokeSpots,
    windsocks: decor.windsocks,
    group,
    culler,
    rivers,
    farmland,
  };
}

interface Gate {
  site: Site;
  /** Side of the site: +1 = local +X (main gate), −1 = local −X. */
  side: number;
  /** Inner end of the access road (the motor pool). */
  inner: THREE.Vector2;
  /** Where the access road crosses the perimeter. */
  gate: THREE.Vector2;
  /** Junction outside the gate where supply routes meet. */
  junction: THREE.Vector2;
  /** Outward direction. */
  dir: THREE.Vector2;
}

/** Local layout of each site's access road: along local X at lane z, from `inner` out past the wall at `wall`. */
const ACCESS: Record<'base' | 'fob' | 'cop', { inner: number; lane: number; wall: number; out: number }> = {
  base: { inner: 92, lane: 20, wall: 165, out: 130 },
  fob: { inner: 60, lane: -22, wall: 100, out: 120 },
  cop: { inner: 26, lane: -20, wall: 56, out: 100 },
};

/**
 * Lay out the road network like a real one: supply routes form a tree
 * between bases and FOBs (each joins the nearest site already connected),
 * outposts hang off the nearest hub, and every site is turned so its gate
 * faces its connections. Roads meet at a junction outside the gate rather
 * than all converging on the middle of the base.
 */
function planNetwork(sites: Site[], towns: Town[], terrain: Terrain) {
  const base = sites.find((s) => s.kind === 'base')!;
  const fobs = sites.filter((s) => s.kind === 'fob');
  const cops = sites.filter((s) => s.kind === 'cop');
  const d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  const edges: [Site, Site][] = [];
  // Main supply routes: a spanning tree grown from the main base.
  const net: Site[] = [base];
  const left = [...fobs];
  while (left.length) {
    let best: [Site, Site, number] | null = null;
    for (const f of left) for (const n of net) if (!best || d(f, n) < best[2]) best = [n, f, d(f, n)];
    const [n, f] = best!;
    edges.push([n, f]);
    net.push(f);
    left.splice(left.indexOf(f), 1);
  }
  // Outposts, nearest first, to the nearest connected base, FOB or outpost.
  for (const c of [...cops].sort((a, b) => d(a, base) - d(b, base))) {
    const n = net.reduce((a, b) => (d(a, c) < d(b, c) ? a : b));
    edges.push([n, c]);
    net.push(c);
  }
  // Friendly and contested towns get a track from the nearest hub.
  const townHub = new Map<Town, Site>();
  for (const t of towns) {
    if (t.enemySide && !t.contested) continue;
    townHub.set(t, net.reduce((a, b) => (d(a, t) < d(b, t) ? a : b)));
  }
  // Turn each site to face its connections.
  const dirs = new Map<Site, THREE.Vector2[]>();
  const push = (s: Site, to: { x: number; z: number }) => {
    const v = new THREE.Vector2(to.x - s.x, to.z - s.z).normalize();
    if (!dirs.has(s)) dirs.set(s, []);
    dirs.get(s)!.push(v);
  };
  for (const [a, b] of edges) {
    push(a, b);
    push(b, a);
  }
  for (const [t, h] of townHub) push(h, t);
  for (const s of net) {
    const ds = dirs.get(s);
    if (!ds?.length) continue;
    const m = ds.reduce((acc, v) => acc.add(v), new THREE.Vector2());
    const main = m.length() > 0.35 * ds.length ? m.normalize() : ds[0];
    s.rot = Math.atan2(-main.y, main.x);
  }
  // Gates: everything within ~100° of the main gate uses it; bases and FOBs
  // get a back gate for connections on the far side.
  const gates = new Map<string, Gate>();
  const gateFor = (s: Site, toward: { x: number; z: number }): Gate => {
    const ax = new THREE.Vector2(Math.cos(s.rot), -Math.sin(s.rot));
    const v = new THREE.Vector2(toward.x - s.x, toward.z - s.z).normalize();
    const side = v.dot(ax) > -0.17 ? 1 : -1;
    const key = `${s.id}:${side}`;
    let g = gates.get(key);
    if (g) return g;
    const A = ACCESS[s.kind as 'base' | 'fob' | 'cop'];
    const loc = (lx: number) => {
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      return new THREE.Vector2(s.x + lx * c + A.lane * sn, s.z - lx * sn + A.lane * c);
    };
    const dir = ax.clone().multiplyScalar(side);
    // Push the junction further out when the site sits well above or below
    // the land around it (so the access road can ramp down at a sane grade),
    // and pull it in if it would land in water.
    let out = A.out;
    let junction = loc(side * (A.wall + out));
    const tooSteep = () => Math.abs(terrain.heightAt(junction.x, junction.y) - s.y) > 0.14 * (A.wall + out - A.inner);
    while (out < A.out + 250 && tooSteep()) {
      out += 25;
      junction = loc(side * (A.wall + out));
    }
    while (out > 30 && terrain.heightAt(junction.x, junction.y) < 1.5) {
      out -= 20;
      junction = loc(side * (A.wall + out));
    }
    g = { site: s, side, inner: loc(side * A.inner), gate: loc(side * A.wall), junction, dir };
    gates.set(key, g);
    return g;
  };
  const links = edges.map(([a, b]) => ({ a: gateFor(a, b), b: gateFor(b, a) }));
  const townLinks = new Map<Town, Gate>();
  for (const [t, h] of townHub) townLinks.set(t, gateFor(h, t));
  return { gates: [...gates.values()], links, townLinks };
}

/** Distance from (x, z) to the segment a–b. */
function segPointDist(a: THREE.Vector2, b: THREE.Vector2, x: number, z: number) {
  const dx = b.x - a.x;
  const dz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a.x - dx * t, z - a.y - dz * t);
}
