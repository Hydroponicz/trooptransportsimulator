import * as THREE from 'three';
import { clamp, smoothstep } from '../util/math';
import { mergeStatic } from '../util/mergeStatic';
import type { CabinLayout } from '../game/cargo';
import type { PlayerTarget } from '../game/target';
import type { DriveInput, GroundEnv } from './humvee';

const G = 9.81;

/**
 * M2 Bradley infantry fighting vehicle: a tracked hull with a two-man turret
 * (25 mm Bushmaster, coax and a TOW launcher, modelled but unarmed for now)
 * and a power ramp at the back for the dismounts and their kit.
 *
 * Body frame: forward = −Z, origin at the middle of the hull floor.
 */

/** Road wheels along each track (body Z). */
const ROAD_Z = [-2.2, -1.43, -0.66, 0.11, 0.88, 1.65];
/** Track centre lines (body X). */
const TRACK_X = 1.42;
const TRACK_W = 0.53;
const MOUNT_Y = 0.12;
const REST = 0.3;
const RADIUS = 0.32;
/** Drive sprocket at the front, idler at the back (body Y/Z, radius). */
const SPROCKET = { z: -2.95, y: 0.42, r: 0.3 };
const IDLER = { z: 2.55, y: 0.36, r: 0.28 };
const WHEELS = ROAD_Z.flatMap((z) => [
  { x: -TRACK_X, z, side: -1 },
  { x: TRACK_X, z, side: 1 },
]);

/** Troop compartment: six seats along the walls, two litters on the floor, one pallet. */
export const BAY: CabinLayout = (() => {
  const F = 0.26;
  const seats: CabinLayout['seats'] = [];
  for (const z of [0.75, 1.5, 2.25])
    for (const sx of [-1, 1]) seats.push({ pos: new THREE.Vector3(sx * 0.9, F + 0.05, z), heading: (sx * Math.PI) / 2 });
  return {
    floor: F,
    hinge: new THREE.Vector3(0, F, 3.2),
    seats,
    litters: [new THREE.Vector3(-0.45, F + 0.3, 1.7), new THREE.Vector3(0.45, F + 0.3, 1.7)],
    pallets: [new THREE.Vector3(0, F, 1.7)],
    hull: { halfWidth: 1.85, front: -3.5, back: 3.35 },
  };
})();

const BUMPERS = [
  new THREE.Vector3(0, 0.6, -3.45),
  new THREE.Vector3(-1.6, 0.6, -3.2),
  new THREE.Vector3(1.6, 0.6, -3.2),
  new THREE.Vector3(0, 0.6, 3.35),
  new THREE.Vector3(-1.6, 0.6, 3.2),
  new THREE.Vector3(1.6, 0.6, 3.2),
  new THREE.Vector3(-1.75, 0.8, 0),
  new THREE.Vector3(1.75, 0.8, 0),
];
const PROBES = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

/** Track link pattern: dark steel shoes with raised grousers and rubber pads. */
function treadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d1e1b';
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 4; i++) {
    const y = i * 16;
    g.fillStyle = '#3a3b36';
    g.fillRect(0, y + 1, 64, 9);
    g.fillStyle = '#121311';
    g.fillRect(0, y + 10, 64, 6);
    // Rubber pads and the centre guide horns.
    g.fillStyle = '#262624';
    g.fillRect(6, y + 3, 20, 5);
    g.fillRect(38, y + 3, 20, 5);
    g.fillStyle = '#4a4b45';
    g.fillRect(29, y + 2, 6, 7);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Track shoe thickness: the road wheels run on its inside, the ground meets its outside. */
const SHOE = 0.07;
/** Road wheel tyre radius (the physics' RADIUS reaches the ground through the shoe). */
const WHEEL_R = RADIUS - SHOE;

/** Points round the inside of one track loop (body Z/Y) for given road-wheel heights, evenly spaced. */
function trackLoop(wheelY: number[], out: Float32Array, n: number) {
  // Outline: along the top from the sprocket back to the idler, round the idler,
  // under each road wheel to the front, round the sprocket.
  const pts: [number, number][] = [];
  const arc = (cz: number, cy: number, r: number, a0: number, a1: number) => {
    for (let k = 0; k <= 8; k++) {
      const a = a0 + ((a1 - a0) * k) / 8;
      pts.push([cz + Math.sin(a) * r, cy + Math.cos(a) * r]);
    }
  };
  pts.push([SPROCKET.z, SPROCKET.y + SPROCKET.r]);
  // Top run on the return rollers.
  pts.push([-1.0, 0.87], [0.9, 0.87]);
  arc(IDLER.z, IDLER.y, IDLER.r, 0, Math.PI * 0.75);
  for (let i = ROAD_Z.length - 1; i >= 0; i--) {
    const y = wheelY[i] - WHEEL_R;
    pts.push([ROAD_Z[i] + 0.2, y], [ROAD_Z[i] - 0.2, y]);
  }
  arc(SPROCKET.z, SPROCKET.y, SPROCKET.r, Math.PI * 1.25, Math.PI * 2);
  // Resample evenly by length.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * total;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out[k * 2] = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f;
    out[k * 2 + 1] = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
  }
  return total;
}

const LOOP_N = 96;
/** Four strips round the loop: outside (tread), inside, and the two edges. */
const STRIPS = 4;

/** The track as a band with thickness, its V coordinate in track lengths (for the scrolling links). */
function trackGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const nv = LOOP_N * 2 * STRIPS;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2));
  const idx: number[] = [];
  for (let st = 0; st < STRIPS; st++) {
    const o = st * LOOP_N * 2;
    for (let k = 0; k < LOOP_N - 1; k++) idx.push(o + k * 2, o + k * 2 + 1, o + k * 2 + 2, o + k * 2 + 1, o + k * 2 + 3, o + k * 2 + 2);
  }
  g.setIndex(idx);
  return g;
}

function buildModel() {
  // NATO green with a darker shade for the armour tiles, like a fielded M2A3.
  const paint = new THREE.MeshStandardMaterial({ color: 0x4f5638, roughness: 0.82 });
  const paint2 = new THREE.MeshStandardMaterial({ color: 0x454b31, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f201c, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3c37, roughness: 0.55, metalness: 0.5 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x24343c, roughness: 0.08, metalness: 0.5 });
  const lining = new THREE.MeshStandardMaterial({ color: 0xb9bda6, roughness: 0.9 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff3c8 });
  const tail = new THREE.MeshBasicMaterial({ color: 0x8a1408 });
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
  const cyl = (r0: number, r1: number, h: number, seg = 12) => new THREE.CylinderGeometry(r0, r1, h, seg);

  // Lower hull between the tracks, and the bow.
  add(box(2.3, 0.62, 5.9), paint, 0, 0.31, -0.25);
  // Upper hull over the tracks: a side profile extruded across the width (front part, ahead of the troop bay).
  {
    const s = new THREE.Shape();
    // (z, y) in the shape's (x, y); z forward is negative.
    s.moveTo(-3.42, 0.6);
    s.lineTo(-3.05, 1.18);
    s.lineTo(-1.75, 1.66);
    s.lineTo(0.05, 1.66);
    s.lineTo(0.05, 0.6);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 3.3, bevelEnabled: false });
    // Extrusion runs along +Z: turn it so the depth is across the hull (X) and the profile is Y/Z.
    geo.rotateY(-Math.PI / 2);
    geo.translate(1.65, 0, 0);
    add(geo, paint, 0, 0, 0);
    // Lower glacis down to the bow.
    const bow = new THREE.Shape();
    bow.moveTo(-3.42, 0.6);
    bow.lineTo(-3.2, 0.05);
    bow.lineTo(-2.9, 0.0);
    bow.lineTo(-2.9, 0.6);
    bow.closePath();
    const bg = new THREE.ExtrudeGeometry(bow, { depth: 2.3, bevelEnabled: false });
    bg.rotateY(-Math.PI / 2);
    bg.translate(1.15, 0, 0);
    add(bg, paint, 0, 0, 0);
  }
  // Troop bay: walls with a light lining inside, open at the back for the ramp.
  for (const sx of [-1, 1]) {
    add(box(0.12, 1.06, 3.2), paint, sx * 1.59, 1.13, 1.65);
    add(box(0.04, 1.3, 3.1), lining, sx * 1.35, 0.95, 1.65, body, false);
    // Sponson top over the track inside the bay wall.
    add(box(0.3, 0.06, 3.1), lining, sx * 1.2, 0.62, 1.65, body, false);
  }
  add(box(3.3, 0.1, 3.25), paint, 0, 1.61, 1.62); // roof
  add(box(2.65, 0.04, 3.1), lining, 0, 1.54, 1.65, body, false); // headliner
  add(box(2.6, 0.04, 3.1), dark, 0, BAY.floor - 0.02, 1.65, body, false); // floor plate
  add(box(2.6, 1.3, 0.06), lining, 0, 0.92, 0.12, body, false); // bulkhead behind the turret basket
  // Rear face round the ramp opening.
  for (const sx of [-1, 1]) add(box(0.65, 1.35, 0.12), paint, sx * 1.33, 0.95, 3.22);
  add(box(3.3, 0.25, 0.12), paint, 0, 1.5, 3.22);
  // Bench seats along the bay walls, with backrests and belts.
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2d3324, roughness: 0.95 });
  for (const sx of [-1, 1]) {
    add(box(0.42, 0.08, 2.4), seatMat, sx * 1.02, BAY.floor + 0.42, 1.5, body, false);
    add(box(0.08, 0.5, 2.4), seatMat, sx * 1.26, BAY.floor + 0.75, 1.5, body, false);
    for (const z of [0.75, 1.5, 2.25]) add(box(0.05, 0.4, 0.06), dark, sx * 1.22, BAY.floor + 0.78, z, body, false);
  }
  // Ammunition racks and radios against the bulkhead.
  add(box(0.7, 0.55, 0.35), steel, -0.85, BAY.floor + 0.3, 0.35, body, false);
  add(box(0.5, 0.35, 0.3), dark, 0.9, 1.1, 0.32, body, false);
  // Interior light.
  add(box(0.25, 0.04, 0.12), lamp, 0, 1.51, 2.0, body, false);

  // Sponson stowage boxes and the side armour skirts (with bolted tiles) over the upper track run.
  for (const sx of [-1, 1]) {
    add(box(0.07, 0.72, 6.0), paint, sx * 1.72, 0.48, -0.25);
    for (let i = 0; i < 8; i++) add(box(0.06, 0.32, 0.68), paint2, sx * 1.77, 0.62, -3.0 + i * 0.75);
    for (let i = 0; i < 8; i++) add(box(0.06, 0.28, 0.68), paint2, sx * 1.77, 0.29, -3.0 + i * 0.75);
    // Mudguards over the sprocket.
    add(box(0.56, 0.05, 0.6), paint, sx * TRACK_X, 0.9, -3.1);
  }
  // Bow: trim vane, tow hooks, headlight guards and lights.
  add(box(2.2, 0.06, 0.9), paint2, 0, 1.0, -3.12).rotation.x = -0.9;
  for (const sx of [-1, 1]) {
    add(box(0.12, 0.2, 0.15), steel, sx * 0.9, 0.1, -3.3);
    add(box(0.32, 0.22, 0.16), dark, sx * 1.25, 1.12, -3.08);
    add(box(0.12, 0.1, 0.03), lamp, sx * 1.2, 1.13, -3.17);
  }
  // Engine deck (front right): grille slats and exhaust.
  for (let i = 0; i < 6; i++) add(box(1.1, 0.03, 0.08), dark, 0.75, 1.68, -1.8 + i * 0.16);
  add(cyl(0.09, 0.09, 0.3, 8).rotateZ(Math.PI / 2), steel, 1.62, 1.35, -1.55);
  // Driver's hatch with periscopes (front left).
  add(cyl(0.38, 0.38, 0.1, 14), paint2, -0.85, 1.71, -1.95);
  for (let i = 0; i < 4; i++) add(box(0.14, 0.09, 0.08), glass, -1.2 + i * 0.23, 1.68, -2.32);
  // Rear stowage, tail lights.
  for (const sx of [-1, 1]) {
    add(box(0.5, 0.3, 0.35), paint2, sx * 1.35, 1.78, 2.9);
    add(box(0.1, 0.08, 0.03), tail, sx * 1.4, 1.35, 3.29);
  }

  // Turret: two-man, offset right of centre, gun and TOW on it.
  const turret = new THREE.Group();
  turret.position.set(0.25, 1.66, -0.55);
  body.add(turret);
  {
    const s = new THREE.Shape();
    // Plan outline (x, z) with chamfered front corners.
    s.moveTo(-1.0, -0.95);
    s.lineTo(-0.7, -1.3);
    s.lineTo(0.7, -1.3);
    s.lineTo(1.0, -0.95);
    s.lineTo(1.0, 1.05);
    s.lineTo(-1.0, 1.05);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.72, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0.78, 0);
    add(geo, paint, 0, 0, 0, turret);
  }
  // Bustle rack at the back of the turret.
  add(box(1.9, 0.05, 0.55), steel, 0, 0.55, 1.35, turret);
  for (const sx of [-1, 0, 1]) add(box(0.04, 0.35, 0.04), steel, sx * 0.93, 0.72, 1.6, turret);
  add(box(1.7, 0.3, 0.45), new THREE.MeshStandardMaterial({ color: 0x6b6446, roughness: 0.95 }), 0, 0.7, 1.35, turret);
  // Commander's hatch and the CIV sight (right), gunner's ISU sight (left).
  add(cyl(0.36, 0.36, 0.1, 14), paint2, 0.45, 0.88, 0.35, turret);
  add(box(0.45, 0.4, 0.5), paint2, 0.55, 1.05, -0.35, turret);
  add(box(0.36, 0.22, 0.04), glass, 0.55, 1.08, -0.61, turret);
  add(box(0.5, 0.32, 0.55), paint2, -0.45, 0.98, -0.85, turret);
  add(box(0.4, 0.18, 0.04), glass, -0.45, 1.0, -1.13, turret);
  // Smoke grenade launchers on the front corners.
  for (const sx of [-1, 1])
    for (let i = 0; i < 4; i++) add(cyl(0.045, 0.045, 0.22, 6).rotateX(Math.PI / 2 - 0.4), dark, sx * (0.72 + i * 0.07), 0.62 + (i % 2) * 0.08, -1.32, turret);
  // Antennas.
  for (const sx of [-1, 1]) add(cyl(0.012, 0.02, 2.6, 4), dark, sx * 0.85, 2.0, 1.0, turret);
  // TOW launcher (left side), stowed down along the turret.
  const tow = new THREE.Group();
  tow.position.set(-1.28, 0.42, -0.25);
  turret.add(tow);
  add(box(0.52, 0.48, 1.65), paint, 0, 0, 0, tow);
  for (const y of [-0.12, 0.12]) {
    add(cyl(0.11, 0.11, 0.04, 12).rotateX(Math.PI / 2), dark, 0, y, -0.83, tow);
    add(cyl(0.11, 0.11, 0.04, 12).rotateX(Math.PI / 2), dark, 0, y, 0.83, tow);
  }
  add(box(0.08, 0.3, 0.4), steel, 0.3, 0, 0.1, tow);
  // 25 mm M242 Bushmaster in its mantlet, with the coax beside it.
  const gun = new THREE.Group();
  gun.position.set(0, 0.42, -1.32);
  turret.add(gun);
  add(box(0.62, 0.5, 0.4), paint2, 0, 0, -0.1, gun);
  add(cyl(0.09, 0.1, 0.5, 10).rotateX(Math.PI / 2), steel, 0, 0, -0.5, gun);
  add(cyl(0.045, 0.05, 2.25, 10).rotateX(Math.PI / 2), steel, 0, 0, -1.6, gun);
  add(cyl(0.065, 0.065, 0.2, 10).rotateX(Math.PI / 2), steel, 0, 0, -2.75, gun);
  add(cyl(0.025, 0.025, 0.45, 6).rotateX(Math.PI / 2), dark, 0.24, -0.02, -0.5, gun);

  // Ramp (hinged at the floor, swings down to the ground) with its crew door.
  const ramp = new THREE.Group();
  ramp.position.set(0, BAY.floor - 0.05, 3.24);
  body.add(ramp);
  add(box(2.0, 1.32, 0.12), paint, 0, 0.66, 0, ramp);
  add(box(1.9, 1.25, 0.03), lining, 0, 0.66, -0.07, ramp, false);
  add(box(0.7, 1.05, 0.03), paint2, -0.45, 0.66, 0.075, ramp);
  add(box(0.05, 0.12, 0.04), steel, -0.18, 0.7, 0.1, ramp);
  for (let i = 0; i < 5; i++) add(box(1.7, 0.025, 0.04), dark, 0, 0.15 + i * 0.25, -0.09, ramp, false);

  // Running gear: road wheels on swing arms, sprockets, idlers, return rollers.
  const wheelGeo = cyl(WHEEL_R, WHEEL_R, 0.18, 16).rotateZ(Math.PI / 2);
  const hubGeo = cyl(0.13, 0.13, 0.22, 8).rotateZ(Math.PI / 2);
  const wheels: THREE.Group[] = [];
  for (const w of WHEELS) {
    const pivot = new THREE.Group();
    pivot.position.set(w.x, MOUNT_Y - REST, w.z);
    body.add(pivot);
    for (const dx of [-0.13, 0.13]) add(wheelGeo, rubber, dx, 0, 0, pivot);
    add(hubGeo, steel, 0, 0, 0, pivot);
    wheels.push(pivot);
  }
  const spinners: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    for (const [c, teeth] of [
      [SPROCKET, true],
      [IDLER, false],
    ] as const) {
      const g = new THREE.Group();
      g.position.set(sx * TRACK_X, c.y, c.z);
      body.add(g);
      add(cyl(c.r, c.r, 0.36, 18).rotateZ(Math.PI / 2), teeth ? steel : rubber, 0, 0, 0, g);
      add(cyl(0.12, 0.12, 0.4, 8).rotateZ(Math.PI / 2), paint2, 0, 0, 0, g);
      if (teeth) for (let i = 0; i < 10; i++) add(box(0.4, 0.08, 0.1), steel, 0, Math.cos((i / 10) * Math.PI * 2) * c.r, Math.sin((i / 10) * Math.PI * 2) * c.r, g).rotation.x = -(i / 10) * Math.PI * 2;
      spinners.push(g);
    }
    for (const z of [-1.0, 0.9]) add(cyl(0.1, 0.1, 0.3, 8).rotateZ(Math.PI / 2), steel, sx * TRACK_X, 0.77, z);
  }
  // The tracks: a ribbon round each loop, re-laid every frame under the road wheels.
  const tex = treadTexture();
  const tracks = [-1, 1].map((sx) => {
    const t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(trackGeometry(), mat);
    mesh.position.x = sx * TRACK_X;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    body.add(mesh);
    return { mesh, tex: t };
  });

  mergeStatic(body, new Set<THREE.Object3D>([turret, ramp, ...wheels, ...spinners, ...tracks.map((t) => t.mesh)]));
  mergeStatic(turret, new Set([tow, gun]));
  mergeStatic(ramp, new Set());
  for (const w of wheels) mergeStatic(w, new Set());
  return { group, ramp, wheels, spinners, tracks, turret, gun };
}

/** The tracked M2 Bradley: suspension on twelve road wheels, skid steering, rear ramp. */
export class Bradley implements PlayerTarget {
  readonly kind = 'ground' as const;
  readonly name = 'Bradley';
  /** Driver's head, out of the hatch (body frame). */
  readonly eye = new THREE.Vector3(-0.85, 2.15, -1.95);
  /** Chase camera: farther back and higher than for the Humvee. */
  readonly camScale = 1.45;
  readonly camHeight = 2.6;
  /** Armour: small arms barely scratch it, and everything else hurts less. */
  readonly armour = 0.3;
  group: THREE.Group;
  private ramp: THREE.Group;
  private wheelPivots: THREE.Group[];
  private spinners: THREE.Group[];
  private tracks: { mesh: THREE.Mesh; tex: THREE.Texture }[];
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  angVel = new THREE.Vector3();
  emptyMass = 27000;
  payload = 0;
  hp = 100;
  destroyed = false;
  readonly hitHalfLength = 3.2;
  readonly hitRadius = 1.8;
  readonly agl = 0.5;
  onDamage: ((amount: number, source: string) => void) | null = null;
  onDestroyed: ((source: string) => void) | null = null;
  input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  steerAngle = 0;
  /** The ramp is down (the cargo code calls it the doors on the ground vehicles). */
  doorsOpen = false;
  doorT = 0;
  contacts = 0;
  speed = 0;
  loadFactor = 1;
  pitch = 0;
  roll = 0;
  heading = 0;
  waterDepth = 0;
  stalled = false;
  engineLoad = 0;
  private comp = new Array(WHEELS.length).fill(0);
  /** How far each track has run (m), for the links and wheels. */
  private run = [0, 0];
  private prevVel = new THREE.Vector3();
  private settled = false;
  onImpact: ((speed: number) => void) | null = null;
  private impactCool = 0;
  private loop = new Float32Array(LOOP_N * 2);

  constructor() {
    const m = buildModel();
    this.group = m.group;
    this.ramp = m.ramp;
    this.wheelPivots = m.wheels;
    this.spinners = m.spinners;
    this.tracks = m.tracks;
    this.layTracks();
  }

  damage(amount: number, source: string) {
    if (this.destroyed || amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount * this.armour);
    this.onDamage?.(amount * this.armour, source);
    if (this.hp <= 0) {
      this.destroyed = true;
      this.input.throttle = 0;
      this.input.handbrake = true;
      this.onDestroyed?.(source);
    }
  }

  repair() {
    this.hp = 100;
    this.destroyed = false;
    this.group.traverse((o) => {
      const mat = (o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material as THREE.MeshStandardMaterial) : null;
      if (mat?.userData.baseColor !== undefined) mat.color.setHex(mat.userData.baseColor);
    });
  }

  scorch() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.isMesh ? (m.material as THREE.MeshStandardMaterial) : null;
      if (!mat?.color || mat.transparent || mat.map) return;
      if (mat.userData.baseColor === undefined) mat.userData.baseColor = mat.color.getHex();
      mat.color.setHex(0x1c1b18);
    });
  }

  private impact(sp: number) {
    if (this.impactCool > 0) return;
    this.impactCool = 0.5;
    this.onImpact?.(sp);
  }

  /** No separate interior: the driver rides head-out of his hatch. */
  setInteriorView(_on: boolean) {}

  get mass() {
    return this.emptyMass + this.payload;
  }
  get groundSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }
  get onGround() {
    return this.contacts >= 6;
  }
  get gearBottom() {
    return this.pos.y;
  }
  get loadable() {
    return this.contacts >= 6 && this.groundSpeed < 0.6;
  }
  get rampDown() {
    return this.doorT > 0.95;
  }

  place(at: THREE.Vector3, heading: number, env: GroundEnv) {
    this.pos.set(at.x, env.surfaceAt(at.x, at.z) - MOUNT_Y + REST + RADIUS - 0.1, at.z);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    this.heading = heading;
    this.stalled = false;
    this.settled = false;
    this.sync();
  }

  worldPoint(local: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }
  /** Foot of the lowered ramp. */
  rampEndWorld(out: THREE.Vector3) {
    return this.worldPoint(_v.set(0, -0.45, 4.35), out);
  }
  cabinWorld(out: THREE.Vector3) {
    return this.worldPoint(_v.set(0, 0.9, 1.6), out);
  }
  get cabinFrame(): THREE.Object3D {
    return this.group;
  }
  get cabinLayout(): CabinLayout {
    return BAY;
  }

  step(dt: number, env: GroundEnv) {
    this.impactCool = Math.max(0, this.impactCool - dt);
    const m = this.mass;
    const q = this.quat;
    _qi.copy(q).invert();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    this.roll = Math.atan2(-right.y, up.y);
    this.heading = Math.atan2(fwd.x, -fwd.z);
    this.speed = this.vel.dot(fwd);
    const inp = this.input;
    const absSpeed = Math.abs(this.speed);

    // Fords up to about a metre; deeper floods the engine.
    this.waterDepth = env.waterDepth(this.pos.x, this.pos.z, this.pos.y + 0.3);
    if (this.waterDepth > 1.5) this.stalled = true;

    const scale = m / 27000;
    const Ix = 105000 * scale;
    const Iy = 125000 * scale;
    const Iz = 40000 * scale;
    const F = new THREE.Vector3(0, -m * G, 0);
    const T = new THREE.Vector3();
    const omegaW = this.angVel.clone().applyQuaternion(q);
    const n = WHEELS.length;
    const k = (m * G) / n / 0.1;
    const c = 2 * 0.6 * Math.sqrt((k * m) / n);
    const mw = m / n;
    const throttle = this.stalled ? 0 : clamp(inp.throttle, -1, 1);
    // 600 hp through a hydromechanical box: strong pull, 66 km/h flat out, slow in reverse.
    const top = throttle >= 0 ? 18 : 6;
    const drive = 95000 * throttle * Math.max(0, 1 - absSpeed / top);
    // Skid steering: one track pushes harder than the other (reversed when backing up, like a car).
    const steerIn = this.stalled ? 0 : clamp(inp.steer, -1, 1) * (this.speed < -0.5 ? -1 : 1);
    this.steerAngle = steerIn * 0.4;
    const sideForce = [drive / 2, drive / 2];
    this.engineLoad = Math.min(1, Math.abs(throttle) + Math.abs(steerIn) * 0.5);
    let contacts = 0;
    let impact = 0;
    const grounded = [0, 0];
    const trackSpeed = [0, 0];

    WHEELS.forEach((w, wi) => {
      const r = new THREE.Vector3(w.x, MOUNT_Y, w.z).applyQuaternion(q);
      const mx = this.pos.x + r.x;
      const my = this.pos.y + r.y;
      const mz = this.pos.z + r.z;
      const ground = env.surfaceAt(mx, mz, my + 0.3);
      const length = my - ground - RADIUS;
      let comp = REST - length;
      const si = w.side < 0 ? 0 : 1;
      if (comp <= 0) {
        this.comp[wi] = 0;
        return;
      }
      contacts++;
      grounded[si]++;
      env.normalAt(mx, mz, _n, my + 0.3);
      const vp = new THREE.Vector3().crossVectors(omegaW, r).add(this.vel);
      const vn = vp.dot(_n);
      if (vn < -4) impact = Math.max(impact, -vn);
      comp = Math.min(comp, REST + 0.12);
      let Fs = Math.max(0, k * comp - c * vn);
      if (comp > REST) Fs += k * 6 * (comp - REST);
      this.comp[wi] = comp;
      const fw = fwd.clone().addScaledVector(_n, -fwd.dot(_n)).normalize();
      const sd = new THREE.Vector3().crossVectors(fw, _n).normalize();
      const vLong = vp.dot(fw);
      const vLat = vp.dot(sd);
      trackSpeed[si] += vLong;
      const grip = env.grip(mx, mz, my + 0.3) * (this.waterDepth > 0.3 ? 0.7 : 1);
      const parking = inp.handbrake && absSpeed < 3;
      // Tracks roll stiffly and the transmission brakes hard off the throttle.
      let fLong = sideForce[si] / ROAD_Z.length - vLong * (Math.abs(throttle) < 0.05 ? 1500 : 60);
      const brakeForce = parking ? 320000 : inp.handbrake ? 160000 : 260000 * inp.brake;
      if (brakeForce > 0) fLong -= Math.sign(vLong) * Math.min(Math.abs(vLong) * (mw / dt) * 0.5, brakeForce / n);
      // Track grousers grip well along the track but scrub sideways (that's what lets it pivot).
      let fLat = -vLat * (mw / dt) * 0.3;
      const latLim = grip * 0.42 * Fs;
      if (Math.abs(fLat) > latLim) fLat = Math.sign(fLat) * latLim;
      const longLim = grip * 0.95 * Fs;
      if (Math.abs(fLong) > longLim) fLong = Math.sign(fLong) * longLim;
      const fSus = _n.clone().multiplyScalar(Fs);
      const fTrack = fw.clone().multiplyScalar(fLong).addScaledVector(sd, fLat);
      F.add(fSus).add(fTrack);
      T.add(new THREE.Vector3().crossVectors(r, fSus));
      const rT = r.clone().addScaledVector(up, -r.dot(up) * 0.7);
      T.add(new THREE.Vector3().crossVectors(rT, fTrack));
    });
    this.contacts = contacts;
    if (impact > 6) this.impact(impact);
    // Skid steering: the tracks are driven at different speeds to turn the hull at a set
    // rate (quick on the spot, gentler at speed), against the tracks scrubbing sideways.
    // With no steering it holds the hull straight.
    if (contacts > 0) {
      const wantYaw = -steerIn * (0.62 - 0.32 * smoothstep(3, 15, absSpeed));
      const tq = clamp((wantYaw - omegaW.dot(up)) * Iy * 8, -520000, 520000) * (contacts / n);
      T.addScaledVector(up, tq);
    }
    for (let s = 0; s < 2; s++) this.run[s] += (grounded[s] ? trackSpeed[s] / grounded[s] : throttle * 3) * dt;

    const sp = this.vel.length();
    F.addScaledVector(this.vel, -1.6 * sp);
    if (this.waterDepth > 0.2) F.addScaledVector(this.vel, -m * 0.7 * Math.min(1.2, this.waterDepth));

    const still = contacts >= 6 && Math.abs(throttle) < 0.01 && Math.abs(inp.steer) < 0.01 && sp < 0.15 && this.angVel.lengthSq() < 0.002;
    if (still && (inp.handbrake || inp.brake > 0 || sp < 0.05)) this.settled = true;
    if (!still) this.settled = false;

    this.prevVel.copy(this.vel);
    const prevPos = this.pos.clone();
    const prevQuat = q.clone();
    if (this.settled) {
      this.vel.set(0, 0, 0);
      this.angVel.set(0, 0, 0);
    } else {
      this.vel.addScaledVector(F, dt / m);
      this.pos.addScaledVector(this.vel, dt);
      const tb = T.applyQuaternion(_qi);
      const w = this.angVel;
      w.x += (tb.x / Ix) * dt;
      w.y += (tb.y / Iy) * dt;
      w.z += (tb.z / Iz) * dt;
      w.multiplyScalar(Math.exp(-0.8 * dt));
      const wl = w.length();
      if (wl > 1e-7) {
        _q.setFromAxisAngle(_v.copy(w).divideScalar(wl), wl * dt);
        q.multiply(_q).normalize();
      }
    }

    // Bump into buildings, walls, trees and vehicles. Only motion further into the
    // obstacle is undone (position and turn), so it can always back or pivot out.
    for (const b of BUMPERS) {
      const p = this.worldPoint(b, new THREE.Vector3());
      if (!env.blocked(p)) continue;
      const nn = new THREE.Vector3();
      const probe = new THREE.Vector3();
      for (const [dx, dz] of PROBES) if (!env.blocked(probe.set(p.x + dx * 0.8, p.y, p.z + dz * 0.8))) (nn.x += dx), (nn.z += dz);
      if (nn.lengthSq() < 0.01) nn.set(-this.vel.x, 0, -this.vel.z);
      if (nn.lengthSq() < 1e-6) continue;
      nn.normalize();
      // How the bumper point itself is moving (turning counts).
      const r = p.clone().sub(this.pos);
      const pv = new THREE.Vector3().crossVectors(this.angVel.clone().applyQuaternion(q), r).add(this.vel);
      const vn = pv.dot(nn);
      if (vn >= 0) continue;
      this.pos.x = prevPos.x;
      this.pos.z = prevPos.z;
      q.copy(prevQuat);
      const lin = this.vel.dot(nn);
      if (lin < 0) this.vel.addScaledVector(nn, -lin * 1.2);
      this.vel.multiplyScalar(0.9);
      this.angVel.y *= 0.3;
      if (-vn > 5) this.impact(-vn);
      break;
    }

    const acc = _v.copy(this.vel).sub(this.prevVel).divideScalar(dt);
    acc.y += G;
    this.loadFactor = acc.dot(up) / G;
  }

  /** Lay each track round its wheels where the suspension has them now. */
  private layTracks() {
    const L = this.loop;
    for (let side = 0; side < 2; side++) {
      const ys = ROAD_Z.map((_, i) => MOUNT_Y - (REST - this.comp[i * 2 + side]));
      trackLoop(ys, L, LOOP_N);
      const t = this.tracks[side];
      const pos = t.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const uv = t.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const hw = TRACK_W / 2;
      let along = 0;
      for (let k = 0; k < LOOP_N; k++) {
        const z = L[k * 2];
        const y = L[k * 2 + 1];
        if (k) along += Math.hypot(z - L[k * 2 - 2], y - L[k * 2 - 1]);
        // Outward normal: the loop runs back along the top and forward underneath.
        const a = Math.max(0, k - 1);
        const b = Math.min(LOOP_N - 1, k + 1);
        const tz = L[b * 2] - L[a * 2];
        const ty = L[b * 2 + 1] - L[a * 2 + 1];
        const tl = Math.hypot(tz, ty) || 1;
        const oz = z - (ty / tl) * SHOE;
        const oy = y + (tz / tl) * SHOE;
        const v = along / 0.64;
        // Outside (tread), inside, and the two edges.
        const rows: [number, number, number, number, number, number][] = [
          [-hw, oy, oz, hw, oy, oz],
          [hw, y, z, -hw, y, z],
          [-hw, y, z, -hw, oy, oz],
          [hw, oy, oz, hw, y, z],
        ];
        rows.forEach((r, st) => {
          const o = st * LOOP_N * 2 + k * 2;
          pos.setXYZ(o, r[0], r[1], r[2]);
          pos.setXYZ(o + 1, r[3], r[4], r[5]);
          uv.setXY(o, st < 2 ? 0 : 0.45, v);
          uv.setXY(o + 1, st < 2 ? 1 : 0.55, v);
        });
      }
      pos.needsUpdate = true;
      uv.needsUpdate = true;
      t.mesh.geometry.computeVertexNormals();
      t.mesh.geometry.computeBoundingSphere();
      // Links run back along the top and forward underneath as the vehicle moves.
      t.tex.offset.y = -this.run[side] / 0.64;
    }
  }

  /** Visuals: suspension, wheels turning, the tracks running, the ramp. */
  update(dt: number) {
    this.doorT = clamp(this.doorT + (this.doorsOpen ? dt : -dt) / 3.2, 0, 1);
    this.ramp.rotation.x = smoothstep(0, 1, this.doorT) * 2.03;
    WHEELS.forEach((w, i) => {
      const p = this.wheelPivots[i];
      p.position.y = MOUNT_Y - (REST - this.comp[i]);
      p.rotation.x = -this.run[w.side < 0 ? 0 : 1] / RADIUS;
    });
    this.spinners.forEach((g, i) => {
      const s = i < 2 ? 0 : 1;
      g.rotation.x = -this.run[s] / (i % 2 ? IDLER.r : SPROCKET.r);
    });
    this.layTracks();
    this.sync();
  }

  sync() {
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
  }

  get flipped() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat).y < 0.3;
  }
}
