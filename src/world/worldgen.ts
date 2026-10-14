import * as THREE from 'three';
import { Noise2D, RNG } from '../util/noise';
import { ColliderSet } from './colliders';
import { Frontline } from './frontline';
import { Props } from './props';
import { Roads, type RoadClass } from './roads';
import { buildRoadside } from './roadside';
import { buildSite, type Site, type SiteKind, type SiteDecor } from './sites';
import { PLAY_HALF, Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { buildTown, TOWN_NAMES, type Town } from './towns';
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
  const towns: Town[] = [];
  const townNames = [...TOWN_NAMES];
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
  const base = place('base', () => [-2900, -2200], [-1200, 1200], 80)!;
  const bands = (n: number, lo: number, hi: number) =>
    Array.from({ length: n }, (_, i) => [lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n] as [number, number]);
  for (const zr of bands(3, -2700, 2700)) place('fob', (z) => [-1800, front.x(z) - 1000], zr, 50);
  for (const zr of bands(6, -2900, 2900)) place('cop', (z) => [front.x(z) - 650, front.x(z) - 280], zr, 40);
  // Towns: some straddle the front (contested), others sit safely behind either line.
  const placeTown = (contested: boolean, xr: (z: number) => [number, number], zr: [number, number], rr: [number, number]) => {
    let best: { x: number; z: number; r: number; score: number } | null = null;
    for (let i = 0; i < 40; i++) {
      const z = rng.range(zr[0], zr[1]);
      const [xa, xb] = xr(z);
      const x = rng.range(xa, xb);
      const r = rng.range(rr[0], rr[1]);
      if (Math.abs(x) > PLAY_HALF - r - 100 || Math.abs(z) > PLAY_HALF - r - 100) continue;
      if (terrain.baseHeight(x, z) < 6) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + r + 140)) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r + 400)) continue;
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
    const town: Town = {
      name: townNames.splice(Math.floor(rng.next() * townNames.length), 1)[0] ?? 'Town',
      x: best.x,
      z: best.z,
      y: h,
      r: best.r,
      rot: rng.range(-0.6, 0.6),
      contested,
      enemySide: front.side(best.x, best.z) > 0,
    };
    towns.push(town);
    terrain.flattens.push({ x: town.x, z: town.z, radius: town.r + 10, blend: 170, height: h });
    if (!contested) terrain.farms.push({ x: town.x, z: town.z, rot: town.rot, r: town.r });
  };
  for (const zr of bands(3, -2600, 2600)) placeTown(true, (z) => [front.x(z) - 90, front.x(z) + 90], zr, [150, 190]);
  for (const zr of bands(4, -2700, 2700)) placeTown(false, (z) => [-2600, front.x(z) - 1000], zr, [85, 120]);
  for (const zr of bands(2, -2400, 2400)) placeTown(false, (z) => [front.x(z) + 900, 2800], zr, [85, 115]);

  for (const zr of bands(7, -2900, 2900)) place('lz', (z) => [front.x(z) - 1500, front.x(z) - 200], zr, 30);
  for (const zr of bands(4, -2600, 2600)) place('lz', (z) => [front.x(z) + 250, front.x(z) + 1100], zr, 30);

  // Shell craters along the front.
  const nearSite = (x: number, z: number, m: number) =>
    sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m) || towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + m);
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
  // Plan the road network before building the sites, so each site can be
  // turned to face its connections with a proper gate.
  const plan = planNetwork(sites, towns, terrain);
  for (const s of sites) buildSite(s, props, terrain, rng.fork(), decor);
  for (const t of towns) buildTown(t, props, terrain, rng.fork());

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
  for (const t of towns) {
    const hub = plan.townLinks.get(t);
    const edge = (o: { x: number; z: number }) => {
      const d = Math.hypot(o.x - t.x, o.z - t.z) || 1;
      return new THREE.Vector2(t.x + ((o.x - t.x) / d) * t.r * 0.85, t.z + ((o.z - t.z) / d) * t.r * 0.85);
    };
    if (hub) {
      connect(hub.junction, hub.dir, edge({ x: hub.junction.x, z: hub.junction.y }), undefined, 'track');
    } else if (t.enemySide && !t.contested) {
      const others = towns.filter((o) => o !== t && (o.contested || o.enemySide));
      if (!others.length) continue;
      const o = others.reduce((a, b) => (dist(a, t) < dist(b, t) ? a : b));
      const from = new THREE.Vector2(o.x + ((t.x - o.x) / (dist(o, t) || 1)) * o.r * 0.85, o.z + ((t.z - o.z) / (dist(o, t) || 1)) * o.r * 0.85);
      const e = edge(o);
      roads.add(from.x, from.y, e.x, e.y, rng, 'track');
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
  for (let i = 0; i < 900; i++) {
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
  for (const fm of terrain.farms)
    for (let i = 0; i < 30; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(fm.r + 60, fm.r + 450);
      const x = fm.x + Math.cos(a) * r;
      const z = fm.z + Math.sin(a) * r;
      const y = terrain.heightAt(x, z);
      if (y < 2 || roads.distance(x, z) < 13 || roads.distance(x + 13, z) < 13 || nearSite(x, z, 10)) continue;
      const bales = rng.int(2, 6);
      for (let k = 0; k < bales; k++) props.add('haybale', x + k * 2.2, terrain.heightAt(x + k * 2.2, z), z, rng.range(-0.2, 0.2));
    }

  onProgress?.('Planting forests');
  const inFarmland = (x: number, z: number) =>
    terrain.farms.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 600) && n3.noise(x * 0.02, z * 0.02) > -0.55;
  const blocked = (x: number, z: number) =>
    nearSite(x, z, 28) ||
    roads.distance(x, z) < 14 ||
    yards.some((q) => Math.hypot(q.x - x, q.z - z) < q.r) ||
    inFarmland(x, z) ||
    enemies.some((e) => Math.abs(e.pos.x - x) < 14 && Math.abs(e.pos.z - z) < 14);
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
    towns,
    enemies,
    smokeSpots,
    windsocks: decor.windsocks,
    group,
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
