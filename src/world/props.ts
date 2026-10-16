import * as THREE from 'three';
import type { DistanceCuller } from './lod';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB, ColliderSet } from './colliders';
import type { ShadowCasters } from './shadows';
import { surf, withSurfaces, type SurfName } from './surfaces';
import { buildCityProto, CITY_COLLIDE, CITY_VIEW, type CityProto } from './buildings';

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
  return surf(g, 'plain');
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt: number, rb: number, h: number, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);
/** part() made of a given surface; `tint` false keeps the colour under per-instance tints. */
export const sp = (kind: SurfName, tint: boolean, ...a: Parameters<typeof part>) => surf(part(...a), kind, tint);

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
  for (const x of xs) for (const z of zs) out.push(sp('plain', false, cyl(r, r, 0.35, 10), 0x1c1c1a, x, y, z, 0, 0, Math.PI / 2));
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
  | 'house_d'
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
  | 'bridge_pier'
  | 'lattice'
  | 'woodpole'
  | 'streetlight'
  | 'delineator'
  | 'jersey'
  | 'railpost'
  | 'fencepost'
  | 'signpost'
  | 'hospital'
  | 'medtent'
  | 'ammo_dump'
  | 'signboard'
  | CityProto;

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

/**
 * A pitched roof over a w × d footprint at height y: the gable ends in the
 * wall finish (`gableSurf`, tinted with the walls), two roof planes with
 * eaves and verges overhanging, and a ridge cap. Ridge along Z.
 */
export function pitchedRoof(p: THREE.BufferGeometry[], w: number, d: number, y: number, rise: number, roofKind: SurfName, roofColor: number, gableSurf: SurfName, gableColor: number, gableTint: boolean) {
  p.push(sp(gableSurf, gableTint, gable(w, rise, d), gableColor, 0, y, 0));
  const eave = 0.5;
  const a = Math.atan2(rise, w / 2);
  const run = w / 2 + eave;
  const len = run / Math.cos(a);
  for (const sx of [-1, 1]) {
    // From the ridge down to the eave, lifted by half its thickness to sit on the gable.
    const cx = (sx * run) / 2 + sx * Math.sin(a) * 0.07;
    const cy = y + rise - (run / 2) * Math.tan(a) + Math.cos(a) * 0.07;
    p.push(sp(roofKind, false, box(len, 0.14, d + 0.7), roofColor, cx, cy, 0, 0, 0, -sx * a));
  }
  p.push(sp('plain', false, box(0.26, 0.16, d + 0.75), roofColor, 0, y + rise + 0.08, 0));
}

/** A window: painted frame, glass with a cross mullion, sill, and optional shutters. Faces +Z unless rotated. */
function windowAt(p: THREE.BufferGeometry[], x: number, y: number, z: number, ry: number, w = 1.1, h = 1.3, shutter?: number) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
  if (LO) {
    // Distant version: just the pane.
    const g = sp('glass', false, box(w, h, 0.06), 0x1e262c, 0, 0, 0).applyQuaternion(q);
    const o = new THREE.Vector3(0, 0, 0.03).applyQuaternion(q);
    p.push(g.translate(x + o.x, y + o.y, z + o.z));
    return;
  }
  const put = (g: THREE.BufferGeometry, ox: number, oy: number, oz: number) => {
    const o = new THREE.Vector3(ox, oy, oz).applyQuaternion(q);
    g.applyQuaternion(q);
    g.translate(x + o.x, y + o.y, z + o.z);
    p.push(g);
  };
  const FRAME = 0xeeebe2;
  put(sp('paint', false, box(w + 0.2, h + 0.2, 0.06), FRAME, 0, 0, 0), 0, 0, 0.02);
  put(sp('glass', false, box(w - 0.08, h - 0.08, 0.06), 0x1e262c, 0, 0, 0), 0, 0, 0.05);
  put(sp('paint', false, box(0.06, h - 0.08, 0.04), FRAME, 0, 0, 0), 0, 0, 0.09);
  put(sp('paint', false, box(w - 0.08, 0.06, 0.04), FRAME, 0, 0, 0), 0, h * 0.18, 0.09);
  put(sp('concrete', false, box(w + 0.35, 0.08, 0.22), 0x9a978e, 0, 0, 0), 0, -h / 2 - 0.12, 0.1);
  if (shutter !== undefined)
    for (const sx of [-1, 1]) put(sp('wood', false, box(w * 0.48, h + 0.05, 0.05), shutter, 0, 0, 0), sx * (w * 0.5 + 0.38), 0, 0.04);
}

export interface HouseSpec {
  w: number;
  d: number;
  floors: number;
  wall: 'plaster' | 'brick';
  roof: 'tile' | 'sheet' | 'metal';
  roofColor: number;
  shutters?: number;
  porch?: boolean;
}

/** A village house: rendered or brick walls, windows with frames and sills, a door under a little porch roof, a chimney. */
export function house(o: HouseSpec): THREE.BufferGeometry {
  const { w, d } = o;
  const wallH = o.floors * 2.85 + 0.45;
  const brick = o.wall === 'brick';
  const WALL = brick ? 0xae6447 : 0xffffff;
  const p: THREE.BufferGeometry[] = [sp(brick ? 'brick' : 'plaster', !brick, box(w, wallH, d), WALL, 0, wallH / 2, 0)];
  // Brick houses get a rendered band under the eaves and a plinth; plastered ones a cornice.
  p.push(sp(brick ? 'plaster' : 'paint', false, box(w + 0.14, 0.22, d + 0.14), brick ? 0xd9d1bf : 0xe6e1d4, 0, wallH - 0.11, 0));
  const roofKind: SurfName = o.roof === 'tile' ? 'tile' : 'sheet';
  pitchedRoof(p, w, d, wallH, w * 0.42, roofKind, o.roofColor, brick ? 'brick' : 'plaster', WALL, !brick);
  const across = Math.max(1, Math.floor((w - 1.2) / 2.6));
  const along = Math.max(1, Math.floor((d - 1.2) / 3.0));
  for (let f = 0; f < o.floors; f++) {
    const y = 1.55 + f * 2.85;
    for (let i = 0; i < across; i++) {
      const x = -w / 2 + (w / across) * (i + 0.5);
      // Front: leave room for the door on the ground floor.
      if (!(f === 0 && Math.abs(x) < 1.0)) windowAt(p, x, y, d / 2, 0, 1.1, 1.3, o.shutters);
      windowAt(p, x, y, -d / 2, Math.PI, 1.1, 1.3, o.shutters);
    }
    for (let i = 0; i < along; i++) {
      const z = -d / 2 + (d / along) * (i + 0.5);
      windowAt(p, w / 2, y, z, Math.PI / 2, 1.0, 1.25);
      windowAt(p, -w / 2, y, z, -Math.PI / 2, 1.0, 1.25);
    }
  }
  // Door, frame, step and a small porch roof.
  const dx = across % 2 === 1 ? (w / across) * 0.5 : 0;
  p.push(sp('paint', false, box(1.3, 2.35, 0.08), 0xe9e5da, dx, 1.18, d / 2 + 0.02));
  p.push(sp('wood', false, box(1.0, 2.1, 0.1), 0x5b3b25, dx, 1.05, d / 2 + 0.05));
  p.push(sp('concrete', false, box(1.8, 0.2, 1.0), 0x8e8b84, dx, 0.1, d / 2 + 0.5));
  if (o.porch) {
    p.push(sp('sheet', false, box(2.2, 0.08, 1.3), o.roofColor, dx, 2.75, d / 2 + 0.62, 0.18, 0, 0));
    for (const sx of [-0.95, 0.95]) p.push(sp('wood', false, box(0.1, 2.6, 0.1), 0x6b5038, dx + sx, 1.3, d / 2 + 1.15));
  }
  // Chimney through the roof.
  p.push(sp('brick', false, box(0.6, 2.0, 0.6), 0x8e4a35, w * 0.22, wallH + w * 0.32, -d * 0.18));
  p.push(sp('concrete', false, box(0.75, 0.1, 0.75), 0x6e6c66, w * 0.22, wallH + w * 0.32 + 1.02, -d * 0.18));
  return merge(p);
}

/** Ruined walls: jagged shell, scorched, no roof, rubble inside. */
function ruin(w: number, d: number, h: number, seed: number): THREE.BufferGeometry {
  const rnd = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const p: THREE.BufferGeometry[] = [];
  const wall = 0xb8ae9a;
  const burnt = 0x3d3a35;
  const seg = 4;
  for (let side = 0; side < 4; side++) {
    const along = side % 2 === 0 ? w : d;
    for (let i = 0; i < seg; i++) {
      if (rnd(side * 10 + i) < 0.18) continue;
      const hh = h * (0.25 + 0.75 * rnd(side * 10 + i + 5));
      const t = -along / 2 + (i + 0.5) * (along / seg);
      const burned = rnd(side * 3 + i) < 0.5;
      const k: SurfName = burned ? 'brick' : 'plaster';
      const col = burned ? 0x5a4136 : wall;
      if (side === 0) p.push(sp(k, false, box(along / seg, hh, 0.4), col, t, hh / 2, d / 2));
      if (side === 2) p.push(sp(k, false, box(along / seg, hh, 0.4), col, t, hh / 2, -d / 2));
      if (side === 1) p.push(sp(k, false, box(0.4, hh, along / seg), col, w / 2, hh / 2, t));
      if (side === 3) p.push(sp(k, false, box(0.4, hh, along / seg), col, -w / 2, hh / 2, t));
      if (rnd(side * 7 + i) < 0.5) p.push(sp('plain', false, box(along / seg + 0.05, hh * 0.4, 0.42), burnt, side % 2 ? (side === 1 ? w / 2 : -w / 2) : t, hh * 0.8, side % 2 ? t : side === 0 ? d / 2 : -d / 2, 0, side % 2 ? Math.PI / 2 : 0, 0));
    }
  }
  p.push(sp('rock', false, new THREE.IcosahedronGeometry(1, 0), 0x77706a, 0, 0.4, 0, 0, 0, 0, w * 0.45, 1.3, d * 0.45));
  // A charred beam or two.
  p.push(sp('wood', false, box(w * 0.9, 0.22, 0.22), 0x2a2420, 0.2, 1.2, 0.5, 0.3, 0.4, 0.2));
  return merge(p);
}

/**
 * A five-storey prefabricated panel block (the familiar post-war estate
 * housing): concrete panels, rows of windows, balconies on the front with
 * mismatched enclosures, entrance canopies at the back, flat roof with a
 * parapet and vent stacks. Footprint 24 × 12.
 */
function apartment(): THREE.BufferGeometry {
  const W = 24;
  const D = 12;
  const H = 14;
  const p: THREE.BufferGeometry[] = [
    sp('facade_panel', true, box(W, H, D), 0xe2ddd0, 0, H / 2, 0),
    sp('concrete', false, box(W + 0.3, 0.5, D + 0.3), 0x9b978d, 0, H + 0.25, 0),
    sp('plain', false, box(W - 0.4, 0.05, D - 0.4), 0x3a3a38, 0, H + 0.48, 0),
  ];
  const balc = [0xc9c4b6, 0xa7b5a0, 0xd8cdb2, 0x9fb0bd, 0xc6c0b0];
  for (let f = 1; f < 5; f++)
    for (let i = 1; i < 8; i += 2) {
      // Balcony: slab and front panel (some glazed in), in the window grid.
      const x = -W / 2 + 3 * (i + 0.5);
      const y = f * 2.8;
      const c = balc[(i * 7 + f * 3) % balc.length];
      p.push(sp('concrete', false, box(2.8, 0.16, 1.15), 0x9b978d, x, y + 0.02, D / 2 + 0.57));
      if ((i + f) % 3 === 0) p.push(sp('glass', false, box(2.8, 1.0, 0.06), 0x1e262c, x, y + 0.6, D / 2 + 1.12));
      else p.push(sp('concrete', false, box(2.8, 1.0, 0.08), c, x, y + 0.6, D / 2 + 1.12));
    }
  // Entrance canopies and doors at the back.
  for (const x of [-7.5, 1.5]) {
    p.push(sp('concrete', false, box(2.6, 0.18, 1.6), 0x9b978d, x, 2.65, -D / 2 - 0.8));
    p.push(sp('wood', false, box(1.2, 2.2, 0.1), 0x4c4136, x, 1.1, -D / 2 - 0.06));
    p.push(sp('concrete', false, box(2.2, 0.3, 1.5), 0x8e8b84, x, 0.15, -D / 2 - 0.75));
  }
  for (const x of [-9, -2.5, 4, 10]) p.push(sp('brick', false, box(1.0, 1.3, 0.8), 0x8a5a45, x, H + 1.0, 0));
  return merge(p);
}

function ruinedApartment(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [
    sp('concrete', false, box(10, 15, 12), 0xb0aa9c, -7, 7.5, 0),
    sp('concrete', false, box(8, 9, 12), 0x8f897c, 2, 4.5, 0),
    sp('concrete', false, box(6, 4, 12), 0x4a463f, 9, 2, 0),
  ];
  for (let f = 0; f < 5; f++) p.push(sp('plain', false, box(9.6, 1.2, 0.1), 0x17191b, -7, 1.7 + f * 2.9, 6.05));
  for (let f = 0; f < 3; f++) p.push(sp('plain', false, box(7.6, 1.2, 0.1), 0x17191b, 2, 1.7 + f * 2.9, 6.05));
  // Scorch marks above the blown-out windows.
  for (let f = 1; f < 5; f += 2) p.push(sp('plain', false, box(4, 1.6, 0.12), 0x2a2825, -8, 2.6 + f * 2.9, 6.08));
  p.push(sp('rock', false, new THREE.IcosahedronGeometry(1, 0), 0x7a746a, 7, 0.5, 2, 0, 0, 0, 6, 2.2, 5));
  return merge(p);
}

/** Onion dome on a drum, with a cross: the village church's crown. */
function onionDome(p: THREE.BufferGeometry[], x: number, y: number, z: number, r: number, color: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    // Bulb: swells out above the base, then draws into a point.
    const rr = r * (Math.sin(Math.PI * Math.min(1, t * 1.25)) * (1 - t * 0.35) + (t < 0.1 ? 0.75 : 0)) * (1 - Math.pow(t, 3));
    pts.push(new THREE.Vector2(Math.max(0.02, rr), t * r * 2.4));
  }
  p.push(sp('plaster', false, cyl(r * 0.8, r * 0.8, r * 1.2, 14), 0xf1eee6, x, y + r * 0.6, z));
  p.push(sp('paint', false, new THREE.LatheGeometry(pts, 16), color, x, y + r * 1.2, z));
  p.push(sp('paint', false, box(0.12, r * 1.3, 0.12), 0xd8b44a, x, y + r * 3.9, z));
  p.push(sp('paint', false, box(r * 0.65, 0.12, 0.12), 0xd8b44a, x, y + r * 4.1, z));
}

/** Building the simplified far-away version (see buildProtoLo). */
let LO = false;
/** Prototypes with a simplified version for distant viewing, and the distance it takes over. */
const LOD_NEAR = 1200;
const HAS_LO = new Set<ProtoName>(['house_a', 'house_b', 'house_c', 'house_d', 'church', 'hospital', 'building', 'farmhouse']);

/** The far version of a building: same shape and colours, windows reduced to plain panes. */
export function buildProtoLo(name: ProtoName): THREE.BufferGeometry {
  LO = true;
  try {
    return buildProto(name);
  } finally {
    LO = false;
  }
}

export function buildProto(name: ProtoName): THREE.BufferGeometry {
  switch (name) {
    case 'hesco':
      return merge([sp('mesh', true, box(4.4, 1.4, 1.1), 0xb5a27a, 0, 0.7, 0), sp('sandbag', true, box(4.3, 0.06, 1.0), 0x8c7c58, 0, 1.42, 0)]);
    case 'sandbag':
      return merge([sp('sandbag', true, box(2, 0.45, 0.7), 0x9a8b66, 0, 0.225, 0), sp('sandbag', true, box(1.9, 0.45, 0.6), 0x8e805d, 0, 0.67, 0)]);
    case 'container':
      return merge([
        sp('metal', true, box(6.06, 2.6, 2.44), 0xffffff, 0, 1.3, 0),
        sp('metal', true, box(0.05, 2.4, 2.2), 0xcccccc, 3.04, 1.3, 0),
        sp('paint', true, box(6.0, 0.06, 2.4), 0xdddddd, 0, 2.62, 0),
        sp('paint', false, box(0.06, 2.3, 0.05), 0x8a8a84, 3.08, 1.3, -0.4),
        sp('paint', false, box(0.06, 2.3, 0.05), 0x8a8a84, 3.08, 1.3, 0.4),
      ]);
    case 'tent':
      return merge([sp('canvas', true, tentGeo(), 0x6e6c48), sp('canvas', false, box(1.2, 1.7, 0.1), 0x3a3926, 0, 0.85, 4.02)]);
    case 'hangar':
      return merge([sp('metal', true, hangarGeo(), 0x8d8b7c), sp('metal', false, box(14, 8, 0.2), 0x4a4a44, 0, 4, 13.05), sp('concrete', false, box(22.4, 0.5, 26.4), 0x8e8b84, 0, 0.25, 0)]);
    case 'tower': {
      const p: THREE.BufferGeometry[] = [];
      for (const sx of [-1.3, 1.3]) for (const sz of [-1.3, 1.3]) p.push(sp('wood', false, box(0.25, 5, 0.25), 0x5a4a35, sx, 2.5, sz));
      p.push(sp('wood', false, box(3.2, 0.3, 3.2), 0x5a4a35, 0, 5.1, 0));
      p.push(sp('sandbag', false, box(3.2, 1.1, 3.2), 0x958763, 0, 5.8, 0));
      for (const sx of [-1.5, 1.5]) for (const sz of [-1.5, 1.5]) p.push(sp('wood', false, box(0.15, 1.4, 0.15), 0x5a4a35, sx, 7.0, sz));
      p.push(sp('sheet', false, box(3.8, 0.15, 3.8), 0x55573e, 0, 7.75, 0));
      return merge(p);
    }
    case 'tank':
      return merge([sp('paint', true, cyl(2.5, 2.5, 4, 14), 0x6d7055, 0, 2, 0), sp('paint', true, cyl(2.3, 2.5, 0.4, 14), 0x5f624a, 0, 4.2, 0), sp('paint', false, box(0.3, 4.4, 0.3), 0x55584a, 2.55, 2.2, 0)]);
    case 'bladder':
      return merge([sp('canvas', true, new THREE.SphereGeometry(1, 12, 6), 0x2b2b24, 0, 0.5, 0, 0, 0, 0, 4.5, 0.7, 2.6)]);
    case 'twall':
      return merge([sp('concrete', true, box(1.5, 3.6, 0.35), 0xb3afa4, 0, 1.8, 0), sp('concrete', true, box(1.5, 0.4, 1.2), 0xa8a498, 0, 0.2, 0)]);
    case 'building': {
      // Single-storey HQ block: rendered walls, flat roof with parapet, windows and a door.
      const p = [
        sp('plaster', true, box(12, 4.5, 9), 0xd0c6ae, 0, 2.25, 0),
        sp('concrete', false, box(12.4, 0.35, 9.4), 0x8b857a, 0, 4.6, 0),
        sp('wood', false, box(1.2, 2.2, 0.1), 0x4a3c2c, -3, 1.1, 4.52),
        sp('sheet', false, box(2.4, 0.1, 1.4), 0x6d6f68, -3, 2.6, 5.2),
      ];
      for (const x of [0.5, 3, 5.2]) windowAt(p, x, 2.4, 4.5, 0, 1.4, 1.1);
      for (const x of [-4, -1, 2, 5]) windowAt(p, x, 2.4, -4.5, Math.PI, 1.4, 1.1);
      return merge(p);
    }
    case 'net':
      return merge([
        sp('canvas', true, new THREE.ConeGeometry(8, 2.2, 4, 1, true), 0x4c5a32, 0, 3.3, 0, 0, Math.PI / 4, 0),
        sp('wood', true, box(0.15, 2.6, 0.15), 0x3e3a2c, 0, 1.3, 0),
      ]);
    case 'crates':
      return merge([
        sp('wood', true, box(1.2, 1.0, 1.2), 0x7a6642, 0, 0.5, 0),
        sp('paint', true, box(1.2, 1.0, 1.2), 0x5e6342, 1.3, 0.5, 0.1),
        sp('wood', true, box(1.2, 1.0, 1.2), 0x7a6642, 0.6, 1.5, 0),
      ]);
    case 'truck':
      return merge([
        sp('paint', true, box(2.4, 1.0, 7.6), 0x4d5434, 0, 1.3, 0),
        sp('paint', true, box(2.3, 1.6, 2.0), 0x4d5434, 0, 2.5, -2.6),
        sp('glass', false, box(2.1, 0.7, 0.05), 0x22262a, 0, 2.8, -3.62),
        sp('canvas', true, box(2.4, 1.9, 5.0), 0x5b5f40, 0, 2.75, 1.1),
        ...wheels([-1.05, 1.05], [-2.6, 1.0, 2.6], 0.55, 0.55),
      ]);
    case 'hmmwv':
      return merge([
        sp('paint', true, box(2.2, 0.9, 4.6), 0x8a7d58, 0, 1.0, 0),
        sp('paint', true, box(2.0, 0.8, 2.2), 0x8a7d58, 0, 1.85, 0.3),
        sp('glass', false, box(1.9, 0.55, 0.05), 0x22262a, 0, 1.95, -0.82),
        ...wheels([-1.0, 1.0], [-1.5, 1.5], 0.45, 0.45),
      ]);
    case 'antenna':
      return merge([sp('paint', true, cyl(0.06, 0.12, 14, 5), 0x777777, 0, 7, 0), sp('paint', true, box(1, 0.6, 1), 0x555544, 0, 0.3, 0)]);
    case 'aagun': {
      const p: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        p.push(sp('sandbag', true, box(2.2, 0.9, 0.8), 0x8a7d5c, Math.cos(a) * 3.2, 0.45, Math.sin(a) * 3.2, 0, -a + Math.PI / 2, 0));
      }
      p.push(sp('paint', true, box(1.4, 0.8, 1.6), 0x3d4230, 0, 0.8, 0));
      p.push(sp('paint', false, cyl(0.06, 0.06, 3.2, 5), 0x222222, -0.25, 1.6, -1.2, Math.PI / 2.6, 0, 0));
      p.push(sp('paint', false, cyl(0.06, 0.06, 3.2, 5), 0x222222, 0.25, 1.6, -1.2, Math.PI / 2.6, 0, 0));
      return merge(p);
    }
    case 'barrel':
      return merge([sp('paint', true, cyl(0.3, 0.3, 0.9, 10), 0x4a5030, 0, 0.45, 0), sp('paint', false, cyl(0.31, 0.31, 0.04, 10), 0x3a3e28, 0, 0.6, 0)]);
    case 'house_a':
      // Single-storey cottage: rendered walls, clay tiles, painted shutters, porch.
      return house({ w: 8, d: 9, floors: 1, wall: 'plaster', roof: 'tile', roofColor: 0xa64a2e, shutters: 0x3a6688, porch: true });
    case 'house_b':
      // Two storeys, grey corrugated cement roof.
      return house({ w: 9, d: 11, floors: 2, wall: 'plaster', roof: 'sheet', roofColor: 0x8f918a });
    case 'house_c':
      // Small cottage under a green painted metal roof, brown shutters.
      return house({ w: 7, d: 8, floors: 1, wall: 'plaster', roof: 'metal', roofColor: 0x3f6a48, shutters: 0x6a4a2e, porch: true });
    case 'house_d':
      // Red-brick two-storey house with a dark tile roof.
      return house({ w: 9, d: 10, floors: 2, wall: 'brick', roof: 'tile', roofColor: 0x6e3a28 });
    case 'apartment':
      return apartment();
    case 'church': {
      // Orthodox village church: white nave under a green roof, apse, bell tower with an onion dome.
      const WHITE = 0xf4f1ea;
      const p: THREE.BufferGeometry[] = [sp('plaster', true, box(9, 8, 18), WHITE, 0, 4, 0)];
      pitchedRoof(p, 9, 18, 8, 3.6, 'sheet', 0x3f6b55, 'plaster', WHITE, true);
      // Apse: a half-round end, lower than the nave.
      p.push(sp('plaster', true, new THREE.CylinderGeometry(3.0, 3.0, 6, 16, 1, false, 0, Math.PI), WHITE, 0, 3, 9, 0, -Math.PI / 2, 0));
      p.push(sp('sheet', false, new THREE.SphereGeometry(3.15, 16, 6, 0, Math.PI, 0, Math.PI / 2), 0x3f6b55, 0, 6, 9));
      p.push(sp('plaster', true, box(5.2, 15, 5.2), WHITE, 0, 7.5, -11.4));
      p.push(sp('plaster', true, box(4.2, 3.2, 4.2), WHITE, 0, 16.6, -11.4));
      p.push(sp('sheet', false, box(5.6, 0.25, 5.6), 0x3f6b55, 0, 15.1, -11.4));
      onionDome(p, 0, 18.2, -11.4, 1.6, 0xd2a63c);
      onionDome(p, 0, 11.6, 0, 1.2, 0x3a6aa8);
      // Tall arched windows along the nave, belfry openings.
      for (const z of [-5, 0, 5]) for (const sx of [-1, 1]) windowAt(p, sx * 4.5, 4.2, z, (sx * Math.PI) / 2, 1.1, 2.6);
      for (const sx of [-1, 1]) windowAt(p, sx * 2.1, 16.6, -11.4, (sx * Math.PI) / 2, 1.2, 1.8);
      windowAt(p, 0, 16.6, -13.5, Math.PI, 1.2, 1.8);
      p.push(sp('wood', false, box(1.8, 3.2, 0.12), 0x5b3b25, 0, 1.6, -14.05));
      p.push(sp('paint', false, box(2.4, 3.6, 0.08), 0xd8b44a, 0, 1.8, -14.02));
      return merge(p);
    }
    case 'ruin_house':
      return ruin(8.5, 9.5, 4.5, 3.1);
    case 'ruin_apartment':
      return ruinedApartment();
    case 'rubble':
      return merge([
        sp('rock', true, new THREE.IcosahedronGeometry(1, 0), 0x7a736a, 0, 0.5, 0, 0, 0, 0, 3.5, 1.4, 2.8),
        sp('brick', true, new THREE.IcosahedronGeometry(1, 0), 0x7a4a3a, 2.2, 0.3, 1, 0.5, 0.3, 0, 1.6, 0.8, 1.4),
        sp('plain', true, box(3, 0.3, 0.3), 0x3a3a38, -1, 0.9, 0.5, 0.3, 0.6, 0.2),
      ]);
    case 'slab':
      return merge([sp('concrete', true, box(1, 0.06, 1), 0x4c4b48, 0, 0.03, 0)]);
    case 'barn':
      // Timber barn: dark red boards, corrugated roof, big double doors.
      {
        const p: THREE.BufferGeometry[] = [sp('wood', false, box(12, 6, 18), 0x7a3426, 0, 3, 0)];
        pitchedRoof(p, 12, 18, 6, 5, 'sheet', 0x7d7f78, 'wood', 0x7a3426, false);
        p.push(sp('wood', false, box(4.2, 4.6, 0.12), 0x4a2a1e, 0, 2.3, 9.04));
        p.push(sp('wood', false, box(0.18, 4.6, 0.16), 0xd8d0bc, 0, 2.3, 9.1));
        p.push(sp('wood', false, box(4.2, 0.18, 0.16), 0xd8d0bc, 0, 2.3, 9.1, 0, 0, 0.83));
        p.push(sp('concrete', false, box(12.2, 0.4, 18.2), 0x8e8b84, 0, 0.2, 0));
        return merge(p);
      }
    case 'silo':
      return merge([
        sp('metal', true, cyl(2.4, 2.4, 13, 18), 0xb8b8b2, 0, 6.5, 0),
        sp('metal', true, new THREE.ConeGeometry(2.6, 2.2, 18), 0x9a9a94, 0, 14.1, 0),
        sp('concrete', false, cyl(2.7, 2.7, 0.5, 18), 0x8e8b84, 0, 0.25, 0),
        sp('paint', false, box(0.1, 13.5, 0.4), 0x5a5a56, 2.45, 6.8, 0),
      ]);
    case 'pylon': {
      const p: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.push(sp('paint', true, box(0.25, 22, 0.25), 0x6d6f70, sx * 1.1, 11, sz * 1.1, sz * 0.05, 0, -sx * 0.05));
      p.push(sp('paint', true, box(8, 0.3, 0.3), 0x6d6f70, 0, 19, 0), sp('paint', true, box(6, 0.3, 0.3), 0x6d6f70, 0, 15.5, 0));
      for (let y = 3; y < 19; y += 4) p.push(sp('paint', true, box(2.4, 0.15, 0.15), 0x6d6f70, 0, y, 1.1, 0, 0, 0.6), sp('paint', true, box(2.4, 0.15, 0.15), 0x6d6f70, 0, y, -1.1, 0, 0, -0.6));
      return merge(p);
    }
    case 'rock':
      return merge([sp('rock', true, new THREE.DodecahedronGeometry(1, 1), 0x8f8a80, 0, 0.3, 0, 0, 0, 0, 1.3, 0.8, 1)]);
    case 'haybale':
      return merge([sp('hay', true, cyl(0.75, 0.75, 1.3, 14), 0xc9b265, 0, 0.75, 0, 0, 0, Math.PI / 2)]);
    case 'lattice': {
      // Steel lattice transmission tower, crossarms along local X.
      const st = 0x7c7f80;
      const p: THREE.BufferGeometry[] = [];
      const H = 23.5;
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          // Legs taper from 2.4 m apart at the base to 0.7 m at the top.
          const lean = Math.atan2(0.85, H);
          p.push(sp('paint', true, box(0.22, H + 0.3, 0.22), st, sx * 0.78, H / 2, sz * 0.78, -sz * lean, 0, sx * lean));
        }
      // Cross bracing on each face.
      for (let y = 1.5; y < 21; y += 3.2) {
        const w = 2.4 - (y / H) * 1.7;
        for (const [fx, fz, ry] of [[0, 1, 0], [0, -1, 0], [1, 0, Math.PI / 2], [-1, 0, Math.PI / 2]] as const) {
          const d = (w / 2) * 1.0;
          p.push(sp('paint', true, box(w * 1.35, 0.1, 0.1), st, fx * d, y + 1.3, fz * d, 0, ry, 0.95));
          p.push(sp('paint', true, box(w * 1.35, 0.1, 0.1), st, fx * d, y + 1.3, fz * d, 0, ry, -0.95));
          p.push(sp('paint', true, box(w, 0.12, 0.12), st, fx * d, y, fz * d, 0, ry, 0));
        }
      }
      // Crossarms (upper wider), each a pair of beams tapering to the tip.
      for (const [y, span] of [[19, 4.8], [15, 3.8]] as const) {
        p.push(sp('paint', true, box(span * 2, 0.25, 0.25), st, 0, y, 0.35), sp('paint', true, box(span * 2, 0.25, 0.25), st, 0, y, -0.35));
        for (const sx of [-1, 1]) {
          p.push(sp('paint', true, box(span, 0.12, 0.12), st, (sx * span) / 2, y - 0.9, 0, 0, 0, sx * 0.35));
          // Insulator string.
          for (let k = 0; k < 5; k++) p.push(sp('plain', false, cyl(0.16, 0.16, 0.12, 8), 0x3a3c3e, sx * (span - 0.4), y - 0.3 - k * 0.22, 0));
        }
      }
      // Earth-wire peak.
      p.push(sp('paint', true, box(0.18, 2.4, 0.18), st, 0, H + 0.8, 0));
      return merge(p);
    }
    case 'woodpole': {
      const p: THREE.BufferGeometry[] = [sp('bark', true, cyl(0.13, 0.17, 10.5, 8), 0x5b4632, 0, 5.25, 0)];
      p.push(sp('wood', true, box(2.6, 0.14, 0.14), 0x4e3c2a, 0, 9.3, 0));
      for (const x of [-1.1, 1.1]) p.push(sp('plain', false, cyl(0.07, 0.09, 0.32, 6), 0xd8d2c0, x, 9.55, 0));
      p.push(sp('plain', false, cyl(0.07, 0.09, 0.32, 6), 0xd8d2c0, 0, 10.65, 0));
      // Braces.
      for (const sx of [-1, 1]) p.push(sp('wood', true, box(0.06, 1.0, 0.06), 0x3f3122, sx * 0.4, 8.95, 0, 0, 0, sx * 0.7));
      return merge(p);
    }
    case 'streetlight': {
      // Pole at the origin, arm reaching along +X over the road.
      const g = 0x9a9d9e;
      return merge([
        sp('concrete', true, box(0.5, 0.4, 0.5), 0x8a877f, 0, 0.2, 0),
        sp('paint', true, cyl(0.08, 0.12, 8, 8), g, 0, 4.2, 0),
        sp('paint', true, box(2.6, 0.1, 0.1), g, 1.25, 8.1, 0, 0, 0, 0.08),
        sp('paint', true, box(0.9, 0.18, 0.4), 0x55585a, 2.6, 8.05, 0),
        sp('plain', false, box(0.7, 0.04, 0.3), 0xfff2c4, 2.6, 7.95, 0),
      ]);
    }
    case 'delineator':
      return merge([
        sp('plain', true, box(0.12, 1.1, 0.12), 0xe4e2da, 0, 0.55, 0),
        sp('plain', true, box(0.13, 0.18, 0.13), 0x1d1d1d, 0, 0.85, 0),
        sp('plain', false, box(0.06, 0.12, 0.135), 0xff8a1c, 0, 0.98, 0),
      ]);
    case 'jersey': {
      // Concrete barrier, long axis X.
      const c = 0xb3afa4;
      return merge([sp('concrete', true, box(3, 0.25, 0.8), c, 0, 0.125, 0), sp('concrete', true, box(3, 0.35, 0.5), c, 0, 0.42, 0), sp('concrete', true, box(3, 0.25, 0.25), c, 0, 0.72, 0)]);
    }
    case 'railpost':
      return merge([sp('paint', true, box(0.12, 0.9, 0.18), 0x8d9091, 0, 0.45, 0)]);
    case 'fencepost':
      // Galvanised post with the barbed-wire outrigger leaning out along −Z.
      return merge([sp('paint', true, cyl(0.04, 0.04, 2.3, 6), 0x9fa3a3, 0, 1.15, 0), sp('paint', true, box(0.04, 0.5, 0.04), 0x9fa3a3, 0, 2.45, -0.15, -0.6, 0, 0)]);
    case 'signpost':
      // Two posts and a grey backing board along local X (sign face is +Z).
      return merge([
        sp('paint', true, box(0.16, 4.2, 0.16), 0x8d9091, -1.9, 2.1, -0.1),
        sp('paint', true, box(0.16, 4.2, 0.16), 0x8d9091, 1.9, 2.1, -0.1),
        sp('paint', true, box(5.3, 1.6, 0.08), 0x6c6e6e, 0, 3.4, -0.06),
      ]);
    case 'hospital': {
      // Permanent field hospital: door, canopy and red crosses face +Z.
      const WALL = 0xe2dccb;
      const TRIM = 0x8f8a7c;
      const RED = 0xb3201c;
      const WHITE = 0xf0f0ec;
      const p: THREE.BufferGeometry[] = [
        sp('plaster', true, box(22, 4.4, 12), WALL, 0, 2.2, 0),
        sp('concrete', false, box(22.6, 0.35, 12.6), TRIM, 0, 4.55, 0),
        sp('plain', false, box(5.5, 0.06, 5.5), WHITE, 0, 4.76, 0),
        sp('plain', false, box(4.2, 0.08, 1.3), RED, 0, 4.8, 0),
        sp('plain', false, box(1.3, 0.08, 4.2), RED, 0, 4.8, 0),
        sp('glass', false, box(2.6, 2.7, 0.1), 0x1e262c, 0, 1.35, 6.03),
        sp('concrete', false, box(6, 0.2, 3.4), TRIM, 0, 3.1, 7.7),
        sp('concrete', false, box(3.4, 0.25, 2.2), 0x9a958a, 0, 0.12, 7.1),
        sp('plain', false, box(2.2, 2.2, 0.06), WHITE, 5.2, 2.5, 6.04),
        sp('plain', false, box(1.6, 0.48, 0.08), RED, 5.2, 2.5, 6.08),
        sp('plain', false, box(0.48, 1.6, 0.08), RED, 5.2, 2.5, 6.08),
        sp('metal', false, box(1.4, 1.4, 1.0), 0x9a9a92, -7, 5.4, -3),
        sp('metal', false, box(1.4, 1.4, 1.0), 0x9a9a92, 7, 5.4, -3),
        sp('paint', false, box(2.4, 1.6, 1.3), 0x5e6342, 12.6, 0.8, -3),
      ];
      for (const sx of [-2.8, 2.8]) p.push(sp('paint', false, box(0.18, 3.0, 0.18), 0x6e6a5e, sx, 1.5, 9.25));
      for (const x of [-9, -6.2, -3.4, 9]) windowAt(p, x, 2.6, 6.0, 0, 1.6, 1.0);
      for (const sx of [-1, 1]) for (const z of [-3.5, 0, 3.5]) windowAt(p, sx * 11, 2.6, z, (sx * Math.PI) / 2, 1.6, 1.0);
      return merge(p);
    }
    case 'medtent': {
      // Large canvas medical tent, door and cross at +Z.
      const CANVAS = 0xd9d2b8;
      const RED = 0xb3201c;
      const WHITE = 0xf2f0ea;
      const p: THREE.BufferGeometry[] = [
        sp('canvas', true, tentGeo(), CANVAS, 0, 0, 0, 0, 0, 0, 1.4, 1.15, 1.25),
        sp('canvas', false, box(1.8, 2.1, 0.1), 0x2b2a22, 0, 1.05, 5.02),
        sp('plain', false, box(1.3, 1.3, 0.06), WHITE, 0, 2.75, 5.03),
        sp('plain', false, box(1.0, 0.32, 0.08), RED, 0, 2.75, 5.07),
        sp('plain', false, box(0.32, 1.0, 0.08), RED, 0, 2.75, 5.07),
      ];
      // Crosses on both roof slopes, visible from the air.
      for (const sx of [-1, 1]) {
        p.push(sp('plain', false, box(2.2, 0.05, 2.2), WHITE, sx * 1.75, 2.93, 0, 0, 0, -sx * 0.43));
        p.push(sp('plain', false, box(1.7, 0.06, 0.5), RED, sx * 1.74, 2.96, 0, 0, 0, -sx * 0.43));
        p.push(sp('plain', false, box(0.5, 0.06, 1.7), RED, sx * 1.74, 2.96, 0, 0, 0, -sx * 0.43));
      }
      return merge(p);
    }
    case 'ammo_dump': {
      // Sandbagged ammunition supply point, open to +Z, with ammo stacks and a warning sign.
      const BAG = 0x9a8b66;
      const BAG2 = 0x8e805d;
      const AMMO = 0x4b5034;
      const BAND = 0xc9a227;
      const p: THREE.BufferGeometry[] = [
        sp('sandbag', true, box(10.6, 0.7, 0.8), BAG, 0, 0.35, -4.2),
        sp('sandbag', true, box(10.4, 0.65, 0.75), BAG2, 0, 1.02, -4.2),
      ];
      for (const sx of [-1, 1]) {
        p.push(sp('sandbag', true, box(0.8, 0.7, 7.4), BAG, sx * 5.1, 0.35, -0.7));
        p.push(sp('sandbag', true, box(0.75, 0.65, 7.2), BAG2, sx * 5.1, 1.02, -0.7));
      }
      for (const [x, z, h] of [[-3.4, -3.2, 3], [-2.1, -3.2, 2], [2.6, -3.2, 3], [3.9, -3.2, 2], [-3.4, -2.2, 1]] as const)
        for (let k = 0; k < h; k++) {
          p.push(sp('paint', true, box(1.2, 0.55, 0.8), AMMO, x, 0.28 + k * 0.56, z));
          p.push(sp('paint', false, box(1.22, 0.07, 0.82), BAND, x, 0.4 + k * 0.56, z));
        }
      p.push(sp('wood', false, box(0.1, 2.2, 0.1), 0x5a4a35, 4.4, 1.1, 3.4));
      p.push(sp('paint', false, box(1.2, 0.8, 0.05), 0xb3201c, 4.4, 1.9, 3.43));
      p.push(sp('paint', false, box(0.9, 0.12, 0.06), BAND, 4.4, 1.9, 3.47));
      return merge(p);
    }
    case 'signboard':
      // Small painted sign on two posts, face +Z (tinted per use).
      return merge([
        sp('wood', false, box(0.1, 1.9, 0.1), 0x5a4a35, -0.9, 0.95, 0),
        sp('wood', false, box(0.1, 1.9, 0.1), 0x5a4a35, 0.9, 0.95, 0),
        sp('paint', true, box(2.2, 0.9, 0.06), 0xffffff, 0, 1.55, 0.04),
      ]);
    case 'bridge_pier':
      return merge([sp('concrete', true, box(1.6, 1, 6.5), 0x8d8b84, 0, 0.5, 0)]);
    case 'wreck':
      return merge([
        sp('paint', true, box(3.0, 1.4, 6.5), 0x26231e, 0, 0.9, 0, 0.05, 0, 0.12),
        sp('paint', true, box(2.0, 0.6, 2.4), 0x1e1c18, 0.2, 1.8, 0.4, 0, 0.3, 0),
        sp('paint', true, cyl(0.1, 0.1, 3.6, 5), 0x1a1a18, 0.2, 2.1, -1.8, Math.PI / 2.2, 0.3, 0),
        sp('paint', false, box(2.8, 0.2, 6.0), 0x4a2a18, 0, 0.3, 0),
      ]);
    default:
      return buildCityProto(name);
  }
}

const COLLIDE: Record<ProtoName, boolean> = {
  ...CITY_COLLIDE,
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
  house_d: true,
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
  lattice: true,
  woodpole: true,
  streetlight: false,
  delineator: false,
  jersey: true,
  railpost: false,
  fencepost: false,
  signpost: false,
  hospital: true,
  medtent: true,
  ammo_dump: false,
  signboard: false,
};

interface Batch {
  /** Simplified geometry for distant viewing, if this prototype has one. */
  lo?: THREE.BufferGeometry;
  geo: THREE.BufferGeometry;
  mats: THREE.Matrix4[];
  colors: (THREE.Color | null)[];
  boxes: (AABB | null)[];
}

/** Collects structure placements and emits one InstancedMesh per prototype. */
/** How far away each prototype stays drawn (metres from its chunk); unlisted ones use 4 km. */
const VIEW: Partial<Record<ProtoName, number>> = {
  ...CITY_VIEW,
  delineator: 900,
  fencepost: 1200,
  railpost: 1200,
  barrel: 1200,
  crates: 1500,
  sandbag: 1800,
  haybale: 1800,
  signpost: 1800,
  signboard: 1200,
  streetlight: 2200,
  jersey: 1800,
  rubble: 2500,
  rock: 3000,
  hangar: 7500,
  building: 7500,
  hospital: 7500,
  house_a: 7500,
  house_b: 7500,
  house_c: 7500,
  house_d: 7500,
  apartment: 7500,
  church: 7500,
  ruin_house: 7000,
  ruin_apartment: 7500,
  barn: 7000,
  silo: 7500,
  pylon: 7500,
  lattice: 7500,
  bridge_pier: 7500,
  tank: 6000,
  antenna: 6000,
};

export class Props {
  private batches = new Map<ProtoName, Batch>();
  private material = withSurfaces(new THREE.MeshLambertMaterial({ vertexColors: true }));
  private tmpBox = new THREE.Box3();

  constructor(private colliders: ColliderSet) {}

  add(name: ProtoName, x: number, y: number, z: number, rotY = 0, scale: number | [number, number, number] = 1, color?: number) {
    const sc = typeof scale === 'number' ? [scale, scale, scale] : scale;
    let b = this.batches.get(name);
    if (!b) {
      b = { geo: buildProto(name), lo: HAS_LO.has(name) ? buildProtoLo(name) : undefined, mats: [], colors: [], boxes: [] };
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

  /**
   * One instanced mesh per prototype per 2.4 km cell, so each can be frustum
   * culled (and shadow-culled) and hidden by distance: clutter goes first,
   * buildings and pylons stay visible out to the fog.
   */
  build(culler: DistanceCuller, shadows?: ShadowCasters): THREE.Group {
    const g = new THREE.Group();
    const CELLSZ = 2400;
    const white = new THREE.Color(1, 1, 1);
    for (const [name, b] of this.batches) {
      shadows?.add(b.geo, b.mats);
      const cells = new Map<string, number[]>();
      b.mats.forEach((m, i) => {
        const e = m.elements;
        const k = `${Math.floor(e[12] / CELLSZ)},${Math.floor(e[14] / CELLSZ)}`;
        let arr = cells.get(k);
        if (!arr) cells.set(k, (arr = []));
        arr.push(i);
      });
      for (const idx of cells.values()) {
        // Buildings with a far version: detailed up close, simplified beyond LOD_NEAR.
        for (const lo of b.lo ? [false, true] : [false]) {
          const mesh = new THREE.InstancedMesh(lo ? b.lo! : b.geo, this.material, idx.length);
          idx.forEach((src, i) => {
            mesh.setMatrixAt(i, b.mats[src]);
            mesh.setColorAt(i, b.colors[src] ?? white);
          });
          // Shadows come from the near-caster copies (see shadows.ts) when those are in use.
          mesh.castShadow = !shadows;
          mesh.receiveShadow = true;
          mesh.computeBoundingSphere();
          g.add(mesh);
          if (!b.lo) culler.addMesh(mesh, VIEW[name] ?? 4000);
          else if (lo) culler.addMesh(mesh, VIEW[name] ?? 4000, LOD_NEAR);
          else culler.addMesh(mesh, LOD_NEAR);
        }
      }
    }
    return g;
  }
}
