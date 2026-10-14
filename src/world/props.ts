import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB, ColliderSet } from './colliders';

/** Bake a primitive into a non-indexed, vertex-colored geometry part. */
export function part(
  geo: THREE.BufferGeometry,
  color: number,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);

function tentGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-2.5, 0);
  s.lineTo(2.5, 0);
  s.lineTo(2.5, 1.8);
  s.lineTo(0, 3.2);
  s.lineTo(-2.5, 1.8);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 8, bevelEnabled: false });
  g.translate(0, 0, -4);
  return g;
}

function hangarGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-11, 0);
  s.absarc(0, 0, 11, Math.PI, 0, true);
  s.lineTo(-11, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 26, bevelEnabled: false, curveSegments: 14 });
  g.translate(0, 0, -13);
  return g;
}

function wheels(xs: number[], zs: number[], r: number, y: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const x of xs) for (const z of zs) out.push(part(cyl(r, r, 0.35, 10), 0x1c1c1a, x, y, z, 0, 0, Math.PI / 2));
  return out;
}

export type ProtoName =
  | 'hesco'
  | 'sandbag'
  | 'container'
  | 'tent'
  | 'hangar'
  | 'tower'
  | 'tank'
  | 'bladder'
  | 'twall'
  | 'building'
  | 'net'
  | 'crates'
  | 'truck'
  | 'hmmwv'
  | 'antenna'
  | 'aagun'
  | 'barrel'
  | 'wreck'
  | 'house_a'
  | 'house_b'
  | 'house_c'
  | 'apartment'
  | 'church'
  | 'ruin_house'
  | 'ruin_apartment'
  | 'rubble'
  | 'slab'
  | 'barn'
  | 'silo'
  | 'pylon'
  | 'rock'
  | 'haybale'
  | 'bridge_pier';

/** Gable roof prism: ridge along Z. */
function gable(w: number, h: number, d: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(-w / 2, 0);
  sh.lineTo(w / 2, 0);
  sh.lineTo(0, h);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}

/** A house: walls, pitched roof, windows and a door. */
function house(w: number, d: number, wallH: number, wall: number, roof: number): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [part(box(w, wallH, d), wall, 0, wallH / 2, 0), part(gable(w + 0.8, w * 0.42, d + 0.8), roof, 0, wallH, 0)];
  const win = 0x2a3036;
  const floors = Math.max(1, Math.round(wallH / 3));
  for (let f = 0; f < floors; f++) {
    const y = 1.6 + f * 2.9;
    for (let i = -1; i <= 1; i += 2) {
      p.push(part(box(1.1, 1.2, 0.08), win, i * w * 0.25, y, d / 2 + 0.03));
      p.push(part(box(1.1, 1.2, 0.08), win, i * w * 0.25, y, -d / 2 - 0.03));
      p.push(part(box(0.08, 1.2, 1.1), win, w / 2 + 0.03, y, i * d * 0.25));
    }
  }
  p.push(part(box(1.1, 2.1, 0.08), 0x4a3a2a, 0, 1.05, d / 2 + 0.04));
  p.push(part(box(0.7, 1.6, 0.7), 0x6a5a4a, w * 0.25, wallH + w * 0.32, 0));
  return merge(p);
}

/** Ruined walls: jagged shell, scorched, no roof, rubble inside. */
function ruin(w: number, d: number, h: number, seed: number): THREE.BufferGeometry {
  const rnd = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const p: THREE.BufferGeometry[] = [];
  const wall = 0x7d766b;
  const burnt = 0x3d3a35;
  const seg = 4;
  for (let side = 0; side < 4; side++) {
    const along = side % 2 === 0 ? w : d;
    for (let i = 0; i < seg; i++) {
      if (rnd(side * 10 + i) < 0.18) continue;
      const hh = h * (0.25 + 0.75 * rnd(side * 10 + i + 5));
      const t = -along / 2 + (i + 0.5) * (along / seg);
      const col = rnd(side * 3 + i) < 0.5 ? wall : burnt;
      if (side === 0) p.push(part(box(along / seg, hh, 0.4), col, t, hh / 2, d / 2));
      if (side === 2) p.push(part(box(along / seg, hh, 0.4), col, t, hh / 2, -d / 2));
      if (side === 1) p.push(part(box(0.4, hh, along / seg), col, w / 2, hh / 2, t));
      if (side === 3) p.push(part(box(0.4, hh, along / seg), col, -w / 2, hh / 2, t));
    }
  }
  p.push(part(new THREE.IcosahedronGeometry(1, 0), 0x6b645a, 0, 0.4, 0, 0, 0, 0, w * 0.45, 1.3, d * 0.45));
  return merge(p);
}

function apartment(): THREE.BufferGeometry {
  const W = 24;
  const D = 12;
  const H = 15;
  const p: THREE.BufferGeometry[] = [part(box(W, H, D), 0xb8b0a0, 0, H / 2, 0), part(box(W + 0.4, 0.4, D + 0.4), 0x77736a, 0, H + 0.2, 0)];
  for (let f = 0; f < 5; f++) {
    const y = 1.7 + f * 2.9;
    p.push(part(box(W - 2, 1.2, 0.1), 0x2a3036, 0, y, D / 2 + 0.05));
    p.push(part(box(W - 2, 1.2, 0.1), 0x2a3036, 0, y, -D / 2 - 0.05));
    p.push(part(box(W - 1.5, 0.12, 1.2), 0x8a857a, 0, y - 0.85, D / 2 + 0.6));
  }
  p.push(part(box(3, 2, 3), 0x8a857a, -6, H + 1.2, 0));
  return merge(p);
}

function ruinedApartment(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [
    part(box(10, 15, 12), 0x8f887b, -7, 7.5, 0),
    part(box(8, 9, 12), 0x6f695f, 2, 4.5, 0),
    part(box(6, 4, 12), 0x3d3a35, 9, 2, 0),
  ];
  for (let f = 0; f < 5; f++) p.push(part(box(9.6, 1.2, 0.1), 0x17191b, -7, 1.7 + f * 2.9, 6.05));
  for (let f = 0; f < 3; f++) p.push(part(box(7.6, 1.2, 0.1), 0x17191b, 2, 1.7 + f * 2.9, 6.05));
  p.push(part(new THREE.IcosahedronGeometry(1, 0), 0x6b645a, 7, 0.5, 2, 0, 0, 0, 6, 2.2, 5));
  return merge(p);
}

export function buildProto(name: ProtoName): THREE.BufferGeometry {
  switch (name) {
    case 'hesco':
      return merge([part(box(4.4, 1.4, 1.1), 0xb09d74, 0, 0.7, 0), part(box(4.3, 0.06, 1.0), 0x8c7c58, 0, 1.42, 0)]);
    case 'sandbag':
      return merge([part(box(2, 0.45, 0.7), 0x958763, 0, 0.225, 0), part(box(1.9, 0.45, 0.6), 0x8a7c5a, 0, 0.67, 0)]);
    case 'container':
      return merge([
        part(box(6.06, 2.6, 2.44), 0xffffff, 0, 1.3, 0),
        part(box(0.05, 2.4, 2.2), 0xcccccc, 3.04, 1.3, 0),
        part(box(6.0, 0.06, 2.4), 0xdddddd, 0, 2.62, 0),
      ]);
    case 'tent':
      return merge([part(tentGeo(), 0x6e6c48), part(box(1.2, 1.7, 0.1), 0x3a3926, 0, 0.85, 4.02)]);
    case 'hangar':
      return merge([part(hangarGeo(), 0x8d8b7c), part(box(14, 8, 0.2), 0x2c2c28, 0, 4, 13.05)]);
    case 'tower': {
      const p: THREE.BufferGeometry[] = [];
      for (const sx of [-1.3, 1.3]) for (const sz of [-1.3, 1.3]) p.push(part(box(0.25, 5, 0.25), 0x5a4a35, sx, 2.5, sz));
      p.push(part(box(3.2, 0.3, 3.2), 0x5a4a35, 0, 5.1, 0));
      p.push(part(box(3.2, 1.1, 3.2), 0x958763, 0, 5.8, 0));
      for (const sx of [-1.5, 1.5]) for (const sz of [-1.5, 1.5]) p.push(part(box(0.15, 1.4, 0.15), 0x5a4a35, sx, 7.0, sz));
      p.push(part(box(3.8, 0.15, 3.8), 0x55573e, 0, 7.75, 0));
      return merge(p);
    }
    case 'tank':
      return merge([part(cyl(2.5, 2.5, 4, 14), 0x6d7055, 0, 2, 0), part(cyl(2.3, 2.5, 0.4, 14), 0x5f624a, 0, 4.2, 0)]);
    case 'bladder':
      return merge([part(new THREE.SphereGeometry(1, 12, 6), 0x2b2b24, 0, 0.5, 0, 0, 0, 0, 4.5, 0.7, 2.6)]);
    case 'twall':
      return merge([part(box(1.5, 3.6, 0.35), 0xa19e93, 0, 1.8, 0), part(box(1.5, 0.4, 1.2), 0x989588, 0, 0.2, 0)]);
    case 'building':
      return merge([
        part(box(12, 4.5, 9), 0xab9f86, 0, 2.25, 0),
        part(box(12.4, 0.3, 9.4), 0x7b7363, 0, 4.6, 0),
        part(box(1.4, 2.4, 0.1), 0x3a352c, -3, 1.2, 4.52),
        part(box(1.6, 1.0, 0.1), 0x2a2e33, 2, 2.4, 4.52),
        part(box(1.6, 1.0, 0.1), 0x2a2e33, 4.5, 2.4, 4.52),
      ]);
    case 'net':
      return merge([
        part(new THREE.ConeGeometry(8, 2.2, 4, 1, true), 0x4c5a32, 0, 3.3, 0, 0, Math.PI / 4, 0),
        part(box(0.15, 2.6, 0.15), 0x3e3a2c, 0, 1.3, 0),
      ]);
    case 'crates':
      return merge([
        part(box(1.2, 1.0, 1.2), 0x6b5a3a, 0, 0.5, 0),
        part(box(1.2, 1.0, 1.2), 0x5e6342, 1.3, 0.5, 0.1),
        part(box(1.2, 1.0, 1.2), 0x6b5a3a, 0.6, 1.5, 0),
      ]);
    case 'truck':
      return merge([
        part(box(2.4, 1.0, 7.6), 0x4d5434, 0, 1.3, 0),
        part(box(2.3, 1.6, 2.0), 0x4d5434, 0, 2.5, -2.6),
        part(box(2.1, 0.7, 0.05), 0x22262a, 0, 2.8, -3.62),
        part(box(2.4, 1.9, 5.0), 0x5b5f40, 0, 2.75, 1.1),
        ...wheels([-1.05, 1.05], [-2.6, 1.0, 2.6], 0.55, 0.55),
      ]);
    case 'hmmwv':
      return merge([
        part(box(2.2, 0.9, 4.6), 0x6b6440, 0, 1.0, 0),
        part(box(2.0, 0.8, 2.2), 0x6b6440, 0, 1.85, 0.3),
        part(box(1.9, 0.55, 0.05), 0x22262a, 0, 1.95, -0.82),
        ...wheels([-1.0, 1.0], [-1.5, 1.5], 0.45, 0.45),
      ]);
    case 'antenna':
      return merge([part(cyl(0.06, 0.12, 14, 5), 0x777777, 0, 7, 0), part(box(1, 0.6, 1), 0x555544, 0, 0.3, 0)]);
    case 'aagun': {
      const p: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        p.push(part(box(2.2, 0.9, 0.8), 0x7d7055, Math.cos(a) * 3.2, 0.45, Math.sin(a) * 3.2, 0, -a + Math.PI / 2, 0));
      }
      p.push(part(box(1.4, 0.8, 1.6), 0x3d4230, 0, 0.8, 0));
      p.push(part(cyl(0.06, 0.06, 3.2, 5), 0x222222, -0.25, 1.6, -1.2, Math.PI / 2.6, 0, 0));
      p.push(part(cyl(0.06, 0.06, 3.2, 5), 0x222222, 0.25, 1.6, -1.2, Math.PI / 2.6, 0, 0));
      return merge(p);
    }
    case 'barrel':
      return merge([part(cyl(0.3, 0.3, 0.9, 8), 0x4a5030, 0, 0.45, 0)]);
    case 'house_a':
      return house(8, 9, 3.2, 0xe2d9c2, 0x8e3b2a);
    case 'house_b':
      return house(9, 11, 5.8, 0xd8d6d0, 0x5d6066);
    case 'house_c':
      return house(7, 8, 3.0, 0xc9a86a, 0x6b4a32);
    case 'apartment':
      return apartment();
    case 'church':
      return merge([
        part(box(9, 8, 18), 0xeeeae0, 0, 4, 0),
        part(gable(9.8, 4.5, 18.8), 0x3f6b4f, 0, 8, 0),
        part(box(5, 16, 5), 0xeeeae0, 0, 8, -11),
        part(new THREE.SphereGeometry(2.6, 12, 8), 0xc9a43a, 0, 17.6, -11, 0, 0, 0, 1, 1.35, 1),
        part(box(0.25, 2.6, 0.25), 0xc9a43a, 0, 21, -11),
        part(box(1.4, 0.25, 0.25), 0xc9a43a, 0, 21.3, -11),
        part(box(1.6, 3, 0.1), 0x4a3a2a, 0, 1.5, 9.05),
      ]);
    case 'ruin_house':
      return ruin(8.5, 9.5, 4.5, 3.1);
    case 'ruin_apartment':
      return ruinedApartment();
    case 'rubble':
      return merge([
        part(new THREE.IcosahedronGeometry(1, 0), 0x6b645a, 0, 0.5, 0, 0, 0, 0, 3.5, 1.4, 2.8),
        part(new THREE.IcosahedronGeometry(1, 0), 0x57524a, 2.2, 0.3, 1, 0.5, 0.3, 0, 1.6, 0.8, 1.4),
        part(box(3, 0.3, 0.3), 0x3a3a38, -1, 0.9, 0.5, 0.3, 0.6, 0.2),
      ]);
    case 'slab':
      return merge([part(box(1, 0.06, 1), 0x474643, 0, 0.03, 0)]);
    case 'barn':
      return merge([part(box(12, 6, 18), 0x7a3328, 0, 3, 0), part(gable(13, 5, 19), 0x3d3d3a, 0, 6, 0), part(box(4, 4.5, 0.1), 0x3a2620, 0, 2.25, 9.05)]);
    case 'silo':
      return merge([part(cyl(2.4, 2.4, 13, 14), 0xb4b4ae, 0, 6.5, 0), part(new THREE.ConeGeometry(2.6, 2.2, 14), 0x8a8a84, 0, 14.1, 0)]);
    case 'pylon': {
      const p: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.push(part(box(0.25, 22, 0.25), 0x6d6f70, sx * 1.1, 11, sz * 1.1, sz * 0.05, 0, -sx * 0.05));
      p.push(part(box(8, 0.3, 0.3), 0x6d6f70, 0, 19, 0), part(box(6, 0.3, 0.3), 0x6d6f70, 0, 15.5, 0));
      for (let y = 3; y < 19; y += 4) p.push(part(box(2.4, 0.15, 0.15), 0x6d6f70, 0, y, 1.1, 0, 0, 0.6), part(box(2.4, 0.15, 0.15), 0x6d6f70, 0, y, -1.1, 0, 0, -0.6));
      return merge(p);
    }
    case 'rock':
      return merge([part(new THREE.DodecahedronGeometry(1, 0), 0x8a8478, 0, 0.3, 0, 0, 0, 0, 1.3, 0.8, 1)]);
    case 'haybale':
      return merge([part(cyl(0.75, 0.75, 1.3, 12), 0xc9b265, 0, 0.75, 0, 0, 0, Math.PI / 2)]);
    case 'bridge_pier':
      return merge([part(box(1.6, 1, 6.5), 0x8d8b84, 0, 0.5, 0)]);
    case 'wreck':
      return merge([
        part(box(3.0, 1.4, 6.5), 0x26231e, 0, 0.9, 0, 0.05, 0, 0.12),
        part(box(2.0, 0.6, 2.4), 0x1e1c18, 0.2, 1.8, 0.4, 0, 0.3, 0),
        part(cyl(0.1, 0.1, 3.6, 5), 0x1a1a18, 0.2, 2.1, -1.8, Math.PI / 2.2, 0.3, 0),
      ]);
  }
}

const COLLIDE: Record<ProtoName, boolean> = {
  hesco: true,
  sandbag: false,
  container: true,
  tent: true,
  hangar: true,
  tower: true,
  tank: true,
  bladder: false,
  twall: true,
  building: true,
  net: true,
  crates: false,
  truck: true,
  hmmwv: false,
  antenna: true,
  aagun: false,
  barrel: false,
  wreck: false,
  house_a: true,
  house_b: true,
  house_c: true,
  apartment: true,
  church: true,
  ruin_house: true,
  ruin_apartment: true,
  rubble: false,
  slab: false,
  barn: true,
  silo: true,
  pylon: true,
  rock: false,
  haybale: false,
  bridge_pier: true,
};

interface Batch {
  geo: THREE.BufferGeometry;
  mats: THREE.Matrix4[];
  colors: (THREE.Color | null)[];
  boxes: (AABB | null)[];
}

/** Collects structure placements and emits one InstancedMesh per prototype. */
export class Props {
  private batches = new Map<ProtoName, Batch>();
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private tmpBox = new THREE.Box3();

  constructor(private colliders: ColliderSet) {}

  add(name: ProtoName, x: number, y: number, z: number, rotY = 0, scale: number | [number, number, number] = 1, color?: number) {
    const sc = typeof scale === 'number' ? [scale, scale, scale] : scale;
    let b = this.batches.get(name);
    if (!b) {
      b = { geo: buildProto(name), mats: [], colors: [], boxes: [] };
      this.batches.set(name, b);
    }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
      new THREE.Vector3(sc[0], sc[1], sc[2]),
    );
    b.mats.push(m);
    b.colors.push(color !== undefined ? new THREE.Color(color) : null);
    let box: AABB | null = null;
    if (COLLIDE[name]) {
      this.tmpBox.copy(b.geo.boundingBox!).applyMatrix4(m);
      const bb = this.tmpBox;
      box = { minX: bb.min.x, minY: bb.min.y, minZ: bb.min.z, maxX: bb.max.x, maxY: bb.max.y, maxZ: bb.max.z };
      this.colliders.add(box);
    }
    b.boxes.push(box);
  }

  /** Drop placements of a prototype that match (e.g. wall segments where a road passes). */
  removeWhere(name: ProtoName, fn: (x: number, z: number, box?: AABB) => boolean): number {
    const b = this.batches.get(name);
    if (!b) return 0;
    let removed = 0;
    for (let i = b.mats.length - 1; i >= 0; i--) {
      const e = b.mats[i].elements;
      const box = b.boxes[i];
      if (!fn(e[12], e[14], box ?? undefined)) continue;
      if (box) this.colliders.remove(box);
      b.mats.splice(i, 1);
      b.colors.splice(i, 1);
      b.boxes.splice(i, 1);
      removed++;
    }
    return removed;
  }

  /** Clear every placed structure matching the predicate (except the listed prototypes). */
  removeAllWhere(fn: (x: number, z: number, box?: AABB) => boolean, keep: ProtoName[] = []): number {
    let n = 0;
    for (const name of this.batches.keys()) if (!keep.includes(name)) n += this.removeWhere(name, fn);
    return n;
  }

  build(): THREE.Group {
    const g = new THREE.Group();
    for (const [, b] of this.batches) {
      const mesh = new THREE.InstancedMesh(b.geo, this.material, b.mats.length);
      const white = new THREE.Color(1, 1, 1);
      b.mats.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, b.colors[i] ?? white);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      g.add(mesh);
    }
    return g;
  }
}
