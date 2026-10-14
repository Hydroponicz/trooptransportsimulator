import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Props, ProtoName } from './props';
import type { Terrain } from './terrain';
import { padTexture } from '../util/textures';

export type SiteKind = 'base' | 'fob' | 'cop' | 'lz';

export type FacilityKind = 'medical' | 'ammo' | 'supply' | 'hq' | 'barracks';

/** A place on a site where a kind of cargo goes (or comes from). */
export interface Facility {
  kind: FacilityKind;
  /** Doorway people walk into (and come out of). */
  door: THREE.Vector3;
  /** A few metres out in front of the door. */
  approach: THREE.Vector3;
  /** Where pallets are set down (supply yards and ammo points). */
  area: THREE.Vector3 | null;
  /** World yaw the front faces (local +Z direction is (sin, cos)). */
  yaw: number;
}

export interface Site {
  id: number;
  name: string;
  kind: SiteKind;
  x: number;
  z: number;
  y: number;
  rot: number;
  radius: number;
  /** Landing pad centers (world space). */
  pads: THREE.Vector3[];
  /** Where passengers/cargo wait for each pad. */
  waits: THREE.Vector3[];
  enemySide: boolean;
  /** Distance to the front (positive = enemy side). */
  frontDist: number;
  services: { fuel: boolean; repair: boolean; hangar: boolean; flares: boolean };
  /** Medical, ammo, supply, HQ and barracks areas (none at landing zones). */
  facilities: Facility[];
}

export const SITE_KIND_LABEL: Record<SiteKind, string> = {
  base: 'Main Operating Base',
  fob: 'Forward Operating Base',
  cop: 'Combat Outpost',
  lz: 'Landing Zone',
};

let padGeo: THREE.CircleGeometry | null = null;
const padMats = new Map<string, THREE.MeshLambertMaterial>();

function padMesh(label: string): THREE.Mesh {
  padGeo ??= new THREE.CircleGeometry(13, 40).rotateX(-Math.PI / 2);
  let mat = padMats.get(label);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      map: padTexture(label),
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    padMats.set(label, mat);
  }
  const m = new THREE.Mesh(padGeo, mat);
  m.receiveShadow = true;
  return m;
}

/** Turns site-local coordinates into world placement. */
class Layout {
  constructor(
    private site: Site,
    private props: Props,
    private terrain: Terrain,
  ) {}
  w(lx: number, lz: number): [number, number] {
    const c = Math.cos(this.site.rot);
    const s = Math.sin(this.site.rot);
    return [this.site.x + lx * c + lz * s, this.site.z - lx * s + lz * c];
  }
  put(name: ProtoName, lx: number, lz: number, rot = 0, scale = 1, color?: number) {
    const [x, z] = this.w(lx, lz);
    this.props.add(name, x, this.terrain.heightAt(x, z), z, this.site.rot + rot, scale, color);
  }
  vec(lx: number, lz: number, dy = 0): THREE.Vector3 {
    const [x, z] = this.w(lx, lz);
    return new THREE.Vector3(x, this.terrain.heightAt(x, z) + dy, z);
  }
  /**
   * Register a facility. `door` and `area` are offsets in the facility's own
   * frame (rotated by `rot`, front = +Z) from its local origin (lx, lz).
   */
  facility(kind: FacilityKind, lx: number, lz: number, rot: number, door: [number, number], area?: [number, number], sign?: number) {
    const off = (dx: number, dz: number): [number, number] => [lx + dx * Math.cos(rot) + dz * Math.sin(rot), lz - dx * Math.sin(rot) + dz * Math.cos(rot)];
    const d = off(door[0], door[1]);
    const ap = off(door[0], door[1] + 3.8);
    const ar = area ? off(area[0], area[1]) : null;
    this.site.facilities.push({
      kind,
      door: this.vec(d[0], d[1]),
      approach: this.vec(ap[0], ap[1]),
      area: ar ? this.vec(ar[0], ar[1]) : null,
      yaw: this.site.rot + rot,
    });
    if (sign !== undefined) {
      const sp = off(door[0] - 2.6, door[1] + 1.2);
      this.put('signboard', sp[0], sp[1], rot, 1, sign);
    }
  }
  /** A straight wall of a repeated segment prototype between two local points. */
  wall(name: ProtoName, x0: number, z0: number, x1: number, z1: number, seg: number, gapAt?: number, gap = 0) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / seg));
    const rot = Math.atan2(-(z1 - z0), x1 - x0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      if (gapAt !== undefined && Math.abs(t - gapAt) * len < gap / 2) continue;
      this.put(name, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, rot);
    }
  }
  ring(name: ProtoName, r: number, seg: number, gapAngle?: number, gap = 0) {
    const n = Math.round((Math.PI * 2 * r) / seg);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (gapAngle !== undefined) {
        let d = Math.abs(a - gapAngle);
        d = Math.min(d, Math.PI * 2 - d);
        if (d * r < gap / 2) continue;
      }
      this.put(name, Math.cos(a) * r, Math.sin(a) * r, -a + Math.PI / 2);
    }
  }
}

const CONTAINER_COLORS = [0x6b6f4a, 0x8a7d5a, 0x7a4a32, 0x4f5a5e, 0x6a6a5e];

export interface SiteDecor {
  group: THREE.Group;
  windsocks: THREE.Object3D[];
}

function windsock(at: THREE.Vector3): THREE.Object3D {
  const root = new THREE.Group();
  root.position.copy(at);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 6), new THREE.MeshLambertMaterial({ color: 0x777777 }));
  pole.position.y = 3;
  root.add(pole);
  const pivot = new THREE.Group();
  pivot.position.y = 5.8;
  const sock = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 3.2, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.6),
    new THREE.MeshLambertMaterial({ color: 0xe8661c, side: THREE.DoubleSide }),
  );
  sock.castShadow = true;
  pivot.add(sock);
  root.add(pivot);
  root.userData.pivot = pivot;
  return root;
}

function flag(at: THREE.Vector3): THREE.Object3D {
  const root = new THREE.Group();
  root.position.copy(at);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 9, 6), new THREE.MeshLambertMaterial({ color: 0xbbbbbb }));
  pole.position.y = 4.5;
  root.add(pole);
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.4).translate(1.2, 0, 0),
    new THREE.MeshLambertMaterial({ color: 0x3d5a8a, side: THREE.DoubleSide }),
  );
  cloth.position.y = 8.2;
  root.add(cloth);
  root.userData.pivot = cloth;
  return root;
}

/** Sign colours for the facility areas. */
const SIGN = { ammo: 0xc0442c, supply: 0x6e8f45, hq: 0x2f4f8f, barracks: 0x8a7a52 };

export function buildSite(site: Site, props: Props, terrain: Terrain, rng: RNG, decor: SiteDecor) {
  const L = new Layout(site, props, terrain);
  const addPad = (lx: number, lz: number, label: string, waitDir = -1) => {
    const p = L.vec(lx, lz);
    site.pads.push(p);
    site.waits.push(L.vec(lx, lz + waitDir * 34));
    const m = padMesh(label);
    m.position.set(p.x, p.y + 0.06, p.z);
    decor.group.add(m);
  };

  if (site.kind === 'base') {
    for (let i = 0; i < 4; i++) addPad(-78 + i * 52, 0, String(i + 1));
    // Tent city to the north.
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 6; i++) L.put('tent', -75 + i * 14, -78 - row * 14, 0, 1, rng.chance(0.5) ? 0xd8d0b0 : 0xffffff);
    // Hangars and the flight line to the south.
    L.put('hangar', -60, 82, Math.PI);
    L.put('hangar', -20, 82, Math.PI);
    L.put('building', 40, 74);
    L.put('building', 62, 96, Math.PI / 2);
    L.put('antenna', 74, 66);
    L.put('tower', 100, 40);
    // Fuel farm.
    for (let i = 0; i < 3; i++) L.put('tank', -120 + i * 7, 52);
    L.put('bladder', -118, 72, 0.2);
    L.put('bladder', -104, 74, -0.1);
    // Vehicles & containers.
    for (let i = 0; i < 5; i++) L.put('truck', 20 + i * 5, 118, 0);
    for (let i = 0; i < 4; i++) L.put('hmmwv', 80 + i * 4, 118, 0);
    for (let i = 0; i < 10; i++)
      L.put('container', 110 + (i % 2) * 7, -60 + Math.floor(i / 2) * 6, Math.PI / 2, 1, rng.pick(CONTAINER_COLORS));
    for (let i = 0; i < 3; i++) L.put('crates', -136 + rng.range(-4, 4), -56 + rng.range(-3, 3), rng.range(0, 3));
    // Dedicated areas for each kind of delivery.
    L.put('hospital', 55, -100, 0);
    L.facility('medical', 55, -100, 0, [0, 6.2]);
    L.put('ammo_dump', -130, -40, Math.PI / 2);
    L.facility('ammo', -130, -40, Math.PI / 2, [0, 4.6], [0, -0.6], SIGN.ammo);
    L.facility('supply', 99, -48, -Math.PI / 2, [0, 0], [0, 0], SIGN.supply);
    L.facility('hq', 40, 74, 0, [-3, 4.6], undefined, SIGN.hq);
    L.facility('barracks', -33, -78, 0, [0, 4.1], undefined, SIGN.barracks);
    L.ring('hesco', 165, 4.4);
    for (const a of [0.6, 2.4, 3.9, 5.5]) L.put('tower', Math.cos(a) * 157, Math.sin(a) * 157);
    decor.windsocks.push(windsock(L.vec(118, -18)));
    decor.windsocks.push(flag(L.vec(30, -50)));
  } else if (site.kind === 'fob') {
    addPad(-30, 0, 'H');
    addPad(30, 0, 'H');
    for (let i = 0; i < 4; i++) L.put('tent', -40 + i * 14, -64, 0);
    for (let i = 0; i < 3; i++) L.put('tent', -30 + i * 14, -80, 0);
    L.put('building', 50, 60);
    L.put('net', -50, 60);
    L.put('medtent', -70, 25, Math.PI / 2);
    L.facility('medical', -70, 25, Math.PI / 2, [0, 5.1]);
    L.put('ammo_dump', -72, -72, 0);
    L.facility('ammo', -72, -72, 0, [0, 4.6], [0, -0.6], SIGN.ammo);
    L.facility('supply', -62, 46, Math.PI / 2, [0, 0], [0, 0], SIGN.supply);
    L.facility('hq', 50, 60, 0, [-3, 4.6], undefined, SIGN.hq);
    L.facility('barracks', -26, -64, 0, [0, 4.1], undefined, SIGN.barracks);
    L.put('truck', -32, 62, 0.4);
    L.put('hmmwv', -46, 50, -0.2);
    L.put('bladder', 62, -60, 0.4);
    L.put('bladder', 74, -50, 1.2);
    L.put('antenna', 20, 58);
    for (let i = 0; i < 6; i++)
      L.put('container', -78 + (i % 3) * 7, -30 + Math.floor(i / 3) * 4, Math.PI / 2, 1, rng.pick(CONTAINER_COLORS));
    const H = 100;
    L.wall('hesco', -H, -H, H, -H, 4.4);
    L.wall('hesco', H, -H, H, H, 4.4);
    L.wall('hesco', H, H, -H, H, 4.4);
    L.wall('hesco', -H, H, -H, -H, 4.4);
    for (const [x, z] of [[-H + 4, -H + 4], [H - 4, -H + 4], [H - 4, H - 4], [-H + 4, H - 4]]) L.put('tower', x, z);
    decor.windsocks.push(windsock(L.vec(0, 34)));
    decor.windsocks.push(flag(L.vec(36, 40)));
  } else if (site.kind === 'cop') {
    addPad(0, 0, 'H');
    L.ring('hesco', 56, 4.4);
    L.put('container', -20, 42, 0, 1, rng.pick(CONTAINER_COLORS));
    L.put('container', -12, 44, 0.1, 1, rng.pick(CONTAINER_COLORS));
    L.put('net', 22, 40);
    L.put('tower', 44, 30);
    L.put('tower', -44, -28);
    for (let i = 0; i < 5; i++) L.put('twall', 6 + i * 1.5, 46, 0);
    for (let i = 0; i < 4; i++) L.put('sandbag', 34 + i * 2, -34, 0.6);
    L.put('antenna', 0, 48);
    L.put('medtent', -28, 12, Math.PI / 2, 0.8);
    L.facility('medical', -28, 12, Math.PI / 2, [0, 4.1]);
    L.put('ammo_dump', -30, 30, Math.PI / 2, 0.7);
    L.facility('ammo', -30, 30, Math.PI / 2, [0, 3.3], [0, -0.4], SIGN.ammo);
    L.facility('supply', -15, 36, Math.PI, [0, 0], [0, 0], SIGN.supply);
    L.facility('hq', 22, 40, Math.PI, [0, 5], undefined, SIGN.hq);
    L.facility('barracks', 9, 46, Math.PI, [0, 4], undefined, SIGN.barracks);
    decor.windsocks.push(windsock(L.vec(28, 10)));
  } else {
    // Landing zone: an empty field. Just a couple of markers.
    const p = L.vec(0, 0);
    site.pads.push(p);
    site.waits.push(L.vec(0, -32));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      L.put('barrel', Math.cos(a) * 20, Math.sin(a) * 20);
    }
  }
  for (const w of decor.windsocks) if (!w.parent) decor.group.add(w);
}
