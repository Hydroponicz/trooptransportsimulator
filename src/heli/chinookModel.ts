import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rotorDiscTexture } from '../util/textures';
import { mergeStatic } from '../util/mergeStatic';
import type { FlightSpec } from './flight';

/**
 * Procedural CH-47 style tandem-rotor helicopter.
 * Body frame: forward = −Z, right = +X, up = +Y. Origin = center of mass.
 * Gear contact plane sits at y = GEAR_Y.
 */
export const GEAR_Y = -2.25;
export const ROTOR_RADIUS = 9.15;
export const FRONT_HUB = new THREE.Vector3(0, 3.0, -6.4);
export const AFT_HUB = new THREE.Vector3(0, 4.15, 6.0);
export const HOOK_POS = new THREE.Vector3(0, -1.75, 0.2);
/** Cockpit deck: one step up from the cabin floor. */
export const COCKPIT_FLOOR = -1.25;
/** Pilot's eye (right seat). */
export const COCKPIT_POS = new THREE.Vector3(0.62, COCKPIT_FLOOR + 1.24, -7.62);
export const WHEELS = [
  new THREE.Vector3(-1.3, GEAR_Y, -4.6),
  new THREE.Vector3(1.3, GEAR_Y, -4.6),
  new THREE.Vector3(-1.5, GEAR_Y, 3.9),
  new THREE.Vector3(1.5, GEAR_Y, 3.9),
];
/** Hull points for scrape / crash detection. */
export const HULL_POINTS = [
  new THREE.Vector3(0, -1.0, -9.0),
  new THREE.Vector3(0, 0.3, 8.0),
  new THREE.Vector3(-2.4, -1.6, -2),
  new THREE.Vector3(2.4, -1.6, -2),
  new THREE.Vector3(-2.4, -1.6, 4),
  new THREE.Vector3(2.4, -1.6, 4),
  new THREE.Vector3(0, -1.7, 6.8),
  new THREE.Vector3(0, 2.2, 0),
  new THREE.Vector3(0, 5.2, 6.0),
];

/** CH-47 handling (the original tuning). */
export const CHINOOK_FLIGHT: FlightSpec = {
  emptyMass: 10400,
  fuelCapacity: 2400,
  maxThrustKg: 25000,
  inertia: [2.6e5, 2.4e5, 6.5e4],
  refMass: 12500,
  drag: [28, 22, 7],
  fuelBurn: 1,
  agility: 1,
  gearY: GEAR_Y,
  wheels: WHEELS,
  hull: HULL_POINTS,
};

export interface ChinookParts {
  root: THREE.Group;
  frontRotor: THREE.Group;
  aftRotor: THREE.Group;
  frontBlades: THREE.Mesh[];
  aftBlades: THREE.Mesh[];
  frontDisc: THREE.Mesh;
  aftDisc: THREE.Mesh;
  bladeMat: THREE.MeshStandardMaterial;
  discMat: THREE.MeshBasicMaterial;
  ramp: THREE.Group;
  rampEnd: THREE.Object3D;
  cabinPoint: THREE.Object3D;
  rearOpening: THREE.Mesh;
  hook: THREE.Object3D;
  strobe: THREE.Mesh;
  strobeMat: THREE.MeshBasicMaterial;
  exhaustL: THREE.Object3D;
  exhaustR: THREE.Object3D;
  cockpitInterior: THREE.Group;
  exterior: THREE.Group;
  /** Cabin light (on when the ramp is open). */
  cabinLight: THREE.PointLight;
  /** Door and window guns (same order as CABIN.gunners): they swivel on their mounts. */
  doorGuns: DoorGunMount[];
}

/** A pintle-mounted M240: `mount` turns (YXZ: yaw about the post, then elevation). */
export interface DoorGunMount {
  mount: THREE.Group;
  /** Mount yaw with the barrel straight out of the opening. */
  baseYaw: number;
  muzzle: THREE.Object3D;
  flash: THREE.Mesh;
  /** Where the gunner's hands go. */
  gripR: THREE.Object3D;
  gripL: THREE.Object3D;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Box whose vertices are moved by a function — cheap way to get tapered shapes. */
function shapedBox(w: number, h: number, d: number, fn: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildChinook(): ChinookParts {
  const olive = new THREE.MeshStandardMaterial({ color: 0x666f47, roughness: 0.72, metalness: 0.02 });
  const oliveDark = new THREE.MeshStandardMaterial({ color: 0x4d5434, roughness: 0.78, metalness: 0.02 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2e26, roughness: 0.7, metalness: 0.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x5a7482,
    roughness: 0.05,
    metalness: 0.3,
    transparent: true,
    opacity: 0.38,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const interior = new THREE.MeshStandardMaterial({ color: 0x4a4d44, roughness: 0.9, side: THREE.DoubleSide });
  // The skin is seen from inside the cabin and cockpit too.
  const oliveShell = olive.clone();
  oliveShell.side = THREE.DoubleSide;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3d33, roughness: 0.8 });

  const root = new THREE.Group();
  const exterior = new THREE.Group();
  root.add(exterior);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, parent: THREE.Object3D = exterior) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    // Glass lets sunlight into the cabin and cockpit.
    m.castShadow = mat !== glass;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Fuselage: one lofted shell from the nose to the ramp, with real glazing and open gun ports.
  const hull = buildHull();
  add(hull.geometry, [oliveShell, glass]);
  add(strutGeometry(hull.frames, 0.05), frameMat);
  // Rim around the ramp opening so the skin reads as having thickness.
  const rimShape = roundedRect(3.8, 3.6, 0.75);
  rimShape.holes.push(roundedRect(3.5, 3.3, 0.62) as unknown as THREE.Path);
  add(new THREE.ExtrudeGeometry(rimShape, { depth: 0.14, bevelEnabled: false, curveSegments: 4 }).translate(0, 0.2, 6.86), olive);
  // Aft pylon closure above the ramp opening.
  add(new THREE.BoxGeometry(3.5, 0.75, 0.12), olive, 0, 1.45, 6.94);
  // Windshield wipers, pitot tubes and the nose hatch seam.
  for (const sx of [-1, 1]) {
    const w = add(new THREE.BoxGeometry(0.03, 0.7, 0.03), dark, sx * 0.55, -0.15, -9.0);
    w.rotation.x = -0.7;
    w.rotation.z = sx * 0.2;
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 5).rotateX(Math.PI / 2), dark, sx * 0.45, -1.05, -9.95);
  }

  // Front pylon.
  add(
    shapedBox(1.7, 1.2, 2.8, (v) => {
      if (v.z < 0 && v.y > 0) v.z += 0.6;
    }),
    olive,
    0,
    2.5,
    -6.3,
  );
  // Aft pylon (tall, tapered at the back).
  add(
    shapedBox(2.0, 2.6, 5.2, (v) => {
      if (v.z < 0 && v.y > 0) v.z += 1.2;
      if (v.z > 0 && v.y < 0) v.z -= 0.6;
      if (v.y > 0) v.x *= 0.8;
    }),
    olive,
    0,
    2.95,
    5.0,
  );
  // Spine fairing between pylons.
  add(new THREE.BoxGeometry(0.9, 0.5, 9.5), oliveDark, 0, 2.15, -0.3);

  // Engines either side of the aft pylon.
  const engGeo = new THREE.CylinderGeometry(0.55, 0.6, 3.2, 14).rotateX(Math.PI / 2);
  const intakeGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.3, 14).rotateX(Math.PI / 2);
  const exhausts: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    add(engGeo, oliveDark, sx * 1.45, 2.75, 5.4);
    add(intakeGeo, dark, sx * 1.45, 2.75, 3.75);
    add(new THREE.BoxGeometry(0.5, 0.25, 1.6), olive, sx * 1.05, 2.45, 5.4);
    const ex = new THREE.Object3D();
    ex.position.set(sx * 1.45, 2.75, 7.1);
    exterior.add(ex);
    exhausts.push(ex);
  }

  // Sponsons (fuel pods) and their fairings.
  for (const sx of [-1, 1]) {
    add(
      shapedBox(0.75, 1.0, 9.6, (v) => {
        if (Math.abs(v.z) > 4) v.y *= 0.7;
      }),
      olive,
      sx * 2.2,
      -1.05,
      0.2,
    );
  }

  // Steps below the right forward door.
  add(new THREE.BoxGeometry(0.3, 0.05, 0.8), dark, 2.0, -1.45, -5.0);
  add(new THREE.BoxGeometry(0.06, 0.6, 0.06), dark, 2.12, -1.2, -5.38);

  // Landing gear.
  const strut = new THREE.CylinderGeometry(0.1, 0.1, 1.0, 8);
  const wheel = new THREE.CylinderGeometry(0.45, 0.45, 0.32, 16).rotateZ(Math.PI / 2);
  for (const w of WHEELS) {
    const front = w.z < 0;
    add(strut, dark, w.x, -1.4, w.z);
    if (front) {
      add(wheel, rubber, w.x - 0.2, GEAR_Y + 0.45, w.z);
      add(wheel, rubber, w.x + 0.2, GEAR_Y + 0.45, w.z);
    } else {
      add(wheel, rubber, w.x, GEAR_Y + 0.45, w.z);
    }
  }

  // Cargo hook.
  const hook = new THREE.Object3D();
  hook.position.copy(HOOK_POS);
  exterior.add(hook);
  add(new THREE.BoxGeometry(0.4, 0.25, 0.4), dark, HOOK_POS.x, HOOK_POS.y + 0.1, HOOK_POS.z);

  // Rear opening (visible when the ramp is down).
  // (The cabin is modelled inside now; the old black backdrop is never shown.)
  const rearOpening = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), new THREE.MeshBasicMaterial({ color: 0x0e0f0c }));
  rearOpening.visible = false;

  // Ramp hinged at the bottom of the rear.
  const ramp = new THREE.Group();
  ramp.position.set(0, -1.55, 6.95);
  exterior.add(ramp);
  const rampMesh = add(new THREE.BoxGeometry(3.3, 0.16, 2.9), olive, 0, 0, 1.45, ramp);
  rampMesh.castShadow = true;
  add(new THREE.BoxGeometry(3.1, 0.02, 2.8), interior, 0, -0.09, 1.45, ramp);
  const rampEnd = new THREE.Object3D();
  rampEnd.position.set(0, 0.1, 2.9);
  ramp.add(rampEnd);
  const cabinPoint = new THREE.Object3D();
  cabinPoint.position.set(0, -1.2, 2.5);
  exterior.add(cabinPoint);

  const cabinInterior = buildCabinInterior(add, exterior, interior, dark, olive);

  // Rotors.
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x2a2b26, roughness: 0.6, metalness: 0.2, transparent: true });
  const discMat = new THREE.MeshBasicMaterial({
    map: rotorDiscTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const bladeGeo = new THREE.BoxGeometry(ROTOR_RADIUS, 0.07, 0.64).translate(ROTOR_RADIUS / 2, 0, 0);
  const discGeo = new THREE.CircleGeometry(ROTOR_RADIUS, 48).rotateX(-Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.35, 0.45, 0.6, 10);
  const mkRotor = (hub: THREE.Vector3) => {
    const g = new THREE.Group();
    g.position.copy(hub);
    exterior.add(g);
    add(hubGeo, dark, 0, 0, 0, g);
    const blades: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(bladeGeo, bladeMat);
      b.rotation.y = (i / 3) * Math.PI * 2;
      b.rotation.z = -0.025;
      b.castShadow = true;
      g.add(b);
      blades.push(b);
    }
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.y = 0.05;
    disc.renderOrder = 2;
    g.add(disc);
    return { g, blades, disc };
  };
  const fr = mkRotor(FRONT_HUB);
  const ar = mkRotor(AFT_HUB);
  // Rotor masts.
  add(new THREE.CylinderGeometry(0.22, 0.28, 0.6, 8), dark, FRONT_HUB.x, FRONT_HUB.y - 0.35, FRONT_HUB.z);
  add(new THREE.CylinderGeometry(0.22, 0.28, 0.6, 8), dark, AFT_HUB.x, AFT_HUB.y - 0.35, AFT_HUB.z);

  // Lights.
  const lightGeo = new THREE.SphereGeometry(0.12, 8, 6);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff2020 }), -1.95, 0.4, -5.6);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0x20ff40 }), 1.95, 0.4, -5.6);
  // Tail position light, on the closure panel above the ramp opening.
  add(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), 0, 1.62, 7.04);
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
  const strobe = add(new THREE.SphereGeometry(0.16, 8, 6), strobeMat, 0, 4.35, 3.2);

  // Cockpit, on the same deck as the cabin (one step up), seen from inside and through the glazing.
  const cockpitInterior = buildCockpit(add, dark, frameMat);
  root.add(cockpitInterior);

  // Hundreds of small static parts → a few merged meshes (one per material), so the
  // aircraft costs a handful of draw calls instead of over a thousand with shadows.
  mergeStatic(exterior, new Set<THREE.Object3D>([ramp, fr.g, ar.g, hook, ...cabinInterior.guns.map((x) => x.mount)]));
  mergeStatic(cockpitInterior, new Set());
  // The flight deck sits inside the hull: no need for it to cast shadows.
  cockpitInterior.traverse((o) => (o.castShadow = false));

  return {
    root,
    frontRotor: fr.g,
    aftRotor: ar.g,
    frontBlades: fr.blades,
    aftBlades: ar.blades,
    frontDisc: fr.disc,
    aftDisc: ar.disc,
    bladeMat,
    discMat,
    ramp,
    rampEnd,
    cabinPoint,
    rearOpening,
    hook,
    strobe,
    strobeMat,
    exhaustL: exhausts[0],
    exhaustR: exhausts[1],
    cockpitInterior,
    exterior,
    cabinLight: cabinInterior.light,
    doorGuns: cabinInterior.guns,
  };
}


// ---------------------------------------------------------------- Hull

/** Cabin windows (centres along Z, both sides) and the gunners' openings. */
const CABIN_WINDOWS = [-4.2, -2.45, -0.7, 1.05, 2.8, 4.55];
const WIN_HALF = 0.275;
const WIN_Y: [number, number] = [-0.35, 0.2];
/** Right forward crew door, upper half open for the door gun. */
const DOOR = { z: [-5.45, -4.55], y: [-0.75, 0.95] };
/** Left forward escape window, open for the window gun. */
const PORT = { z: [-5.3, -4.7], y: [-0.75, 0.2] };

interface Profile {
  hw: number;
  top: number;
  bot: number;
  r: number;
}
/** Cross-sections along the nose; everything aft of −6.2 is the constant cabin section. */
const NOSE: [number, Profile][] = [
  [-6.2, { hw: 1.9, top: 2.0, bot: -1.6, r: 0.75 }],
  [-7.3, { hw: 1.9, top: 2.0, bot: -1.6, r: 0.75 }],
  [-7.9, { hw: 1.86, top: 1.85, bot: -1.58, r: 0.8 }],
  [-8.5, { hw: 1.78, top: 1.2, bot: -1.55, r: 0.8 }],
  [-9.1, { hw: 1.62, top: 0.15, bot: -1.5, r: 0.7 }],
  [-9.5, { hw: 1.4, top: -0.55, bot: -1.42, r: 0.4 }],
  [-9.75, { hw: 1.0, top: -0.9, bot: -1.3, r: 0.2 }],
];
const NOSE_TIP = new THREE.Vector3(0, -1.1, -9.85);

function profileAt(z: number): Profile {
  if (z >= NOSE[0][0]) return NOSE[0][1];
  for (let i = 1; i < NOSE.length; i++) {
    const [z1, p1] = NOSE[i];
    const [z0, p0] = NOSE[i - 1];
    if (z >= z1) {
      const t = (z - z0) / (z1 - z0);
      return { hw: p0.hw + (p1.hw - p0.hw) * t, top: p0.top + (p1.top - p0.top) * t, bot: p0.bot + (p1.bot - p0.bot) * t, r: p0.r + (p1.r - p0.r) * t };
    }
  }
  return NOSE[NOSE.length - 1][1];
}

type Tag = 'B' | 'BR' | 'R' | 'TR' | 'T' | 'TL' | 'L' | 'BL';
/** Flat-side break points, so window edges land on ring vertices. */
const FLAT_X = [-1, -0.7, -0.4, 0, 0.4, 0.7, 1];
const SIDE_Y = [-0.75, -0.6, -0.5, -0.35, 0.2, 0.95, 1.2];

/** One ring of the loft: same vertex count at every station. */
function ring(p: Profile): { x: number; y: number; tag: Tag }[] {
  const r = Math.min(p.r, p.hw - 0.01, (p.top - p.bot) / 2 - 0.01);
  const fx = p.hw - r;
  const out: { x: number; y: number; tag: Tag }[] = [];
  const arc = (cx: number, cy: number, a0: number, tag: Tag) => {
    for (let i = 1; i <= 3; i++) {
      const a = a0 + (i / 4) * (Math.PI / 2);
      out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, tag });
    }
  };
  const y0 = p.bot + r;
  const y1 = p.top - r;
  const side = (up: boolean, x: number, tag: Tag) => {
    const ys = [y0, ...SIDE_Y.map((y) => Math.min(y1, Math.max(y0, y))), y1];
    if (!up) ys.reverse();
    for (const y of ys) out.push({ x, y, tag });
  };
  for (const f of FLAT_X) out.push({ x: f * fx, y: p.bot, tag: 'B' });
  arc(fx, y0, -Math.PI / 2, 'BR');
  side(true, p.hw, 'R');
  arc(fx, y1, 0, 'TR');
  for (const f of [...FLAT_X].reverse()) out.push({ x: f * fx, y: p.top, tag: 'T' });
  arc(-fx, y1, Math.PI / 2, 'TL');
  side(false, -p.hw, 'L');
  arc(-fx, y0, Math.PI, 'BL');
  return out;
}

/** 0 = skin, 1 = glass, -1 = opening. */
function skinKind(tag: Tag, x: number, y: number, z: number): number {
  const side = tag === 'L' || tag === 'R';
  if (z < -6.2) {
    // Cockpit: windshield, side windows, chin windows.
    if ((tag === 'T' || tag === 'TR' || tag === 'TL') && z < -7.3) return 1;
    if (side && z < -6.45 && z > -8.4 && y > -0.5 && y < 1.2) return 1;
    if ((side || tag === 'TR' || tag === 'TL') && z < -8.4 && y > -0.95) return 1;
    if ((tag === 'B' || tag === 'BR' || tag === 'BL') && z < -8.6 && Math.abs(x) > 0.25 && Math.abs(x) < 1.3) return 1;
    return 0;
  }
  if (!side) return 0;
  if (x > 0 && z > DOOR.z[0] && z < DOOR.z[1] && y > DOOR.y[0] && y < DOOR.y[1]) return -1;
  if (x < 0 && z > PORT.z[0] && z < PORT.z[1] && y > PORT.y[0] && y < PORT.y[1]) return -1;
  if (y > WIN_Y[0] && y < WIN_Y[1] && CABIN_WINDOWS.some((c) => Math.abs(z - c) < WIN_HALF)) return 1;
  return 0;
}

/** Lofted fuselage skin (groups: 0 skin, 1 glass) plus window-frame edges. */
function buildHull() {
  const zs = new Set<number>([7.0, -6.2, -6.45, ...NOSE.map((n) => n[0]), -8.4, -8.6, DOOR.z[0], DOOR.z[1], PORT.z[0], PORT.z[1]]);
  for (const c of CABIN_WINDOWS) (zs.add(c - WIN_HALF), zs.add(c + WIN_HALF));
  for (let z = 6; z > -6; z -= 1.5) zs.add(+z.toFixed(2));
  const stations = [...zs].sort((a, b) => b - a);
  const rings = stations.map((z) => ring(profileAt(z)).map((q) => ({ ...q, z })));
  const n = rings[0].length;
  const pos: number[] = [];
  const idxSkin: number[] = [];
  const idxGlass: number[] = [];
  for (const r of rings) for (const q of r) pos.push(q.x, q.y, q.z);
  const id = (k: number, i: number) => k * n + (i % n);
  const kinds: number[][] = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = rings[k][i], b = rings[k][(i + 1) % n], c = rings[k + 1][(i + 1) % n], d = rings[k + 1][i];
      const tag: Tag = a.tag === b.tag ? a.tag : a.tag.length === 2 ? a.tag : b.tag;
      const kind = skinKind(tag, (a.x + b.x + c.x + d.x) / 4, (a.y + b.y + c.y + d.y) / 4, (a.z + d.z) / 2);
      row.push(kind);
      if (kind < 0) continue;
      const list = kind === 1 ? idxGlass : idxSkin;
      list.push(id(k, i), id(k, i + 1), id(k + 1, i + 1), id(k, i), id(k + 1, i + 1), id(k + 1, i));
    }
    kinds.push(row);
  }
  // Nose cap.
  const tip = pos.length / 3;
  pos.push(NOSE_TIP.x, NOSE_TIP.y, NOSE_TIP.z);
  const last = rings.length - 1;
  for (let i = 0; i < n; i++) idxSkin.push(id(last, i), tip, id(last, i + 1));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex([...idxSkin, ...idxGlass]);
  geometry.addGroup(0, idxSkin.length, 0);
  geometry.addGroup(idxSkin.length, idxGlass.length, 1);
  geometry.computeVertexNormals();

  // Frames: every edge between glass/openings and skin, plus the main posts and bows.
  const frames: [THREE.Vector3, THREE.Vector3][] = [];
  const V = (k: number, i: number) => {
    const q = rings[k][i % n];
    return new THREE.Vector3(q.x, q.y, q.z);
  };
  const kindAt = (k: number, i: number) => (k < 0 || k >= kinds.length ? 0 : kinds[k][(i + n) % n]);
  const posts = new Set<number>();
  rings[0].forEach((q, i) => {
    if (q.tag === 'T' && [0, -1, 1].some((f) => Math.abs(q.x - f * (profileAt(7).hw - profileAt(7).r)) < 1e-3)) posts.add(i);
  });
  const bows = new Set(stations.filter((z) => z === -7.9).map((z) => stations.indexOf(z)));
  for (let k = 0; k < kinds.length; k++)
    for (let i = 0; i < n; i++) {
      const me = kindAt(k, i);
      // Longitudinal edge at ring vertex i (between cells i-1 and i).
      const left = kindAt(k, i - 1);
      if ((me !== left && (me !== 0 || left !== 0)) || (me === 1 && left === 1 && posts.has(i))) frames.push([V(k, i), V(k + 1, i)]);
      // Ring edge at station k (between cells k-1 and k).
      const fwd = kindAt(k - 1, i);
      if ((me !== fwd && (me !== 0 || fwd !== 0)) || (me === 1 && fwd === 1 && bows.has(k))) frames.push([V(k, i), V(k, i + 1)]);
    }
  return { geometry, frames };
}

/** Thin boxes along a list of segments, merged into one geometry. */
function strutGeometry(segs: [THREE.Vector3, THREE.Vector3][], t: number) {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  for (const [a, b] of segs) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-3) continue;
    const g = new THREE.BoxGeometry(t, t, len + t);
    q.setFromUnitVectors(up, d.normalize());
    g.applyQuaternion(q);
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    parts.push(g);
  }
  return mergeGeometries(parts, false)!;
}

// ---------------------------------------------------------------- Cockpit

/** Little canvas displays for the multifunction screens. */
function mfdTexture(kind: 'adi' | 'map' | 'eng' | 'nav'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05080a';
  g.fillRect(0, 0, 128, 128);
  g.lineWidth = 2;
  if (kind === 'adi') {
    g.fillStyle = '#2b6fb3';
    g.fillRect(8, 8, 112, 58);
    g.fillStyle = '#7a4f24';
    g.fillRect(8, 66, 112, 54);
    g.strokeStyle = '#fff';
    g.beginPath();
    g.moveTo(8, 66);
    g.lineTo(120, 66);
    for (const d of [-24, -12, 12, 24]) (g.moveTo(48, 66 + d), g.lineTo(80, 66 + d));
    g.stroke();
    g.strokeStyle = '#ffd23a';
    g.beginPath();
    g.moveTo(34, 66);
    g.lineTo(56, 66);
    g.lineTo(64, 74);
    g.lineTo(72, 66);
    g.lineTo(94, 66);
    g.stroke();
  } else if (kind === 'map') {
    g.fillStyle = '#20301c';
    g.fillRect(6, 6, 116, 116);
    g.strokeStyle = '#4c6a38';
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(30 + i * 15, 70 - i * 6, 18 + i * 3, 0.3, 2.8);
      g.stroke();
    }
    g.strokeStyle = '#d6c76a';
    g.beginPath();
    g.moveTo(20, 110);
    g.lineTo(60, 70);
    g.lineTo(100, 30);
    g.stroke();
    g.fillStyle = '#ff5ad6';
    g.fillRect(60, 64, 8, 8);
  } else if (kind === 'eng') {
    g.fillStyle = '#56e07a';
    g.font = '10px monospace';
    ['TQ', 'NR', 'T4', 'NG'].forEach((l, i) => {
      g.fillText(l, 10 + i * 29, 118);
      g.strokeStyle = '#2d5a38';
      g.strokeRect(12 + i * 29, 16, 14, 88);
      g.fillRect(14 + i * 29, 104 - (60 + i * 7), 10, 60 + i * 7);
    });
  } else {
    g.strokeStyle = '#56e07a';
    g.beginPath();
    g.arc(64, 70, 46, 0, Math.PI * 2);
    g.stroke();
    for (let a = 0; a < 36; a++) {
      const r0 = a % 3 ? 42 : 38;
      const t = (a / 36) * Math.PI * 2;
      g.beginPath();
      g.moveTo(64 + Math.sin(t) * r0, 70 - Math.cos(t) * r0);
      g.lineTo(64 + Math.sin(t) * 46, 70 - Math.cos(t) * 46);
      g.stroke();
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(64, 54);
    g.lineTo(58, 80);
    g.lineTo(70, 80);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Flight deck: armoured seats, controls, instrument panel, consoles and companionway. */
function buildCockpit(add: AddFn, dark: THREE.Material, frameMat: THREE.Material) {
  const g = new THREE.Group();
  const CF = COCKPIT_FLOOR;
  const deck = new THREE.MeshStandardMaterial({ color: 0x34362f, roughness: 0.9 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2a, roughness: 0.75 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x5b5f5c, roughness: 0.7 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x3f4536, roughness: 0.95 });
  const armor = new THREE.MeshStandardMaterial({ color: 0x4b4e48, roughness: 0.6, metalness: 0.3 });
  const knob = new THREE.MeshBasicMaterial({ color: 0xd8d2b0 });
  const amber = new THREE.MeshBasicMaterial({ color: 0xffb040 });

  // Deck (stops short of the nose so the chin windows show at the pilots' feet) and the step down to the cabin.
  add(new THREE.BoxGeometry(3.3, 0.05, 2.65), deck, 0, CF - 0.025, -7.27, g);
  add(new THREE.BoxGeometry(3.3, 0.22, 0.05), deck, 0, CF - 0.11, -5.95, g);
  // Lower wall linings below the side windows.
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.04, 0.72, 2.2), panelMat, sx * 1.84, CF + 0.36, -7.4, g);
    // Side consoles with switch rows.
    add(new THREE.BoxGeometry(0.28, 0.08, 1.0), panelMat, sx * 1.62, CF + 0.62, -7.6, g);
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.03, 0.03, 0.03), knob, sx * 1.62, CF + 0.68, -8.0 + i * 0.16, g);
  }
  // Instrument panel: tilted face, glareshield and five multifunction displays.
  const panel = add(new THREE.BoxGeometry(2.9, 0.62, 0.08), panelMat, 0, CF + 0.62, -8.58, g);
  panel.rotation.x = -0.22;
  add(new THREE.BoxGeometry(2.95, 0.05, 0.32), dark, 0, CF + 0.95, -8.6, g);
  add(new THREE.BoxGeometry(2.9, 0.08, 0.05), dark, 0, CF + 0.93, -8.44, g);
  const kinds: ('nav' | 'adi' | 'eng' | 'map')[] = ['nav', 'adi', 'eng', 'adi', 'map'];
  kinds.forEach((k, i) => {
    const x = (i - 2) * 0.55;
    const bezel = add(new THREE.BoxGeometry(0.42, 0.38, 0.03), dark, x, CF + 0.64, -8.535, g);
    bezel.rotation.x = -0.22;
    const scr = add(new THREE.PlaneGeometry(0.33, 0.3), new THREE.MeshBasicMaterial({ map: mfdTexture(k) }), x, CF + 0.645, -8.515, g);
    scr.rotation.x = -0.22;
    for (let b = 0; b < 4; b++) {
      const kb = add(new THREE.BoxGeometry(0.025, 0.025, 0.02), knob, x - 0.19, CF + 0.55 + b * 0.06, -8.51, g);
      kb.rotation.x = -0.22;
    }
  });
  // Master caution lights on the glareshield.
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.08, 0.04, 0.04), amber, sx * 0.62, CF + 0.99, -8.48, g);
  // Centre console (pedestal) running back between the seats.
  add(new THREE.BoxGeometry(0.46, 0.5, 1.35), panelMat, 0, CF + 0.25, -7.8, g);
  const ped = add(new THREE.BoxGeometry(0.46, 0.04, 1.35), grey, 0, CF + 0.52, -7.8, g);
  ped.rotation.x = -0.06;
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 4; c++) add(new THREE.BoxGeometry(0.035, 0.02, 0.035), r === 1 ? amber : knob, -0.15 + c * 0.1, CF + 0.55 + r * 0.008, -8.3 + r * 0.24, g);
  // Overhead console hanging down between the pilots.
  add(new THREE.BoxGeometry(0.62, 0.1, 1.0), panelMat, 0, 1.05, -7.6, g);
  add(new THREE.BoxGeometry(0.5, 0.95, 0.12), frameMat, 0, 1.55, -7.15, g);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 5; c++) add(new THREE.BoxGeometry(0.03, 0.04, 0.03), knob, -0.2 + c * 0.1, 0.99, -7.95 + r * 0.2, g);
  // Magnetic compass on the centre windshield post.
  add(new THREE.BoxGeometry(0.07, 0.06, 0.07), dark, 0, CF + 1.0, -8.52, g);

  // Pilot seats with armour wings, cyclics, collectives and pedals.
  for (const sx of [-1, 1]) {
    const x = sx * 0.62;
    add(new THREE.BoxGeometry(0.42, 0.36, 0.42), armor, x, CF + 0.18, -7.5, g);
    add(new THREE.BoxGeometry(0.5, 0.09, 0.5), seatMat, x, CF + 0.41, -7.52, g);
    const back = add(new THREE.BoxGeometry(0.52, 0.72, 0.09), seatMat, x, CF + 0.82, -7.22, g);
    back.rotation.x = -0.12;
    const shell = add(new THREE.BoxGeometry(0.6, 0.8, 0.05), armor, x, CF + 0.78, -7.15, g);
    shell.rotation.x = -0.12;
    for (const wx of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.5, 0.42), armor, x + wx * 0.29, CF + 0.72, -7.35, g);
    // Headrest on two posts, low enough to look back over.
    add(new THREE.BoxGeometry(0.26, 0.16, 0.07), seatMat, x, CF + 1.3, -7.1, g);
    for (const px of [-0.08, 0.08]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 4), grey, x + px, CF + 1.16, -7.11, g);
    // Cyclic between the knees.
    const cyc = add(new THREE.CylinderGeometry(0.018, 0.025, 0.62, 6), dark, x, CF + 0.3, -7.95, g);
    cyc.rotation.x = 0.12;
    add(new THREE.BoxGeometry(0.05, 0.12, 0.05), dark, x, CF + 0.64, -7.99, g);
    // Collective on the left of each seat.
    const col = add(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), dark, x - 0.36, CF + 0.32, -7.6, g);
    col.rotation.x = -1.2;
    add(new THREE.BoxGeometry(0.06, 0.06, 0.14), dark, x - 0.36, CF + 0.45, -7.95, g);
    // Pedals.
    for (const px of [-0.14, 0.14]) {
      const ped = add(new THREE.BoxGeometry(0.1, 0.2, 0.03), grey, x + px, CF + 0.14, -8.48, g);
      ped.rotation.x = -0.5;
    }
  }
  // Dim flood light so the flight deck reads in shade.
  const flood = new THREE.PointLight(0xdfe8ff, 1.2, 4, 1.5);
  flood.position.set(0, 0.85, -7.3);
  g.add(flood);
  // Jump seat in the companionway for a third crewman.
  add(new THREE.BoxGeometry(0.4, 0.05, 0.36), seatMat, 0, CF + 0.42, -6.55, g);
  add(new THREE.BoxGeometry(0.42, 0.6, 0.05), seatMat, 0, CF + 0.75, -6.32, g);
  // Circuit-breaker panels on the companionway walls.
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, 1.0, 0.6), panelMat, sx * 1.72, CF + 1.0, -6.5, g);
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 4; c++) add(new THREE.BoxGeometry(0.02, 0.02, 0.02), knob, sx * 1.69, CF + 0.65 + r * 0.12, -6.68 + c * 0.12, g);
  }
  return g;
}

// ---------------------------------------------------------------- Cabin

/** Cabin floor height in the body frame. */
export const CABIN_FLOOR = -1.47;

/**
 * Where people and cargo go in the cabin (body frame, forward = −Z).
 * Seat entries are soldier root positions (under the pelvis) and headings.
 */
export const CABIN = (() => {
  const seats: { pos: THREE.Vector3; heading: number }[] = [];
  // Troop seats along both walls, filled front to back, alternating sides.
  for (let i = 0; i < 15; i++) {
    const z = -4.3 + i * 0.58;
    seats.push({ pos: new THREE.Vector3(-1.36, CABIN_FLOOR, z), heading: -Math.PI / 2 });
    seats.push({ pos: new THREE.Vector3(1.36, CABIN_FLOOR, z), heading: Math.PI / 2 });
  }
  // Litters on centreline stanchions, two tiers.
  const litters = [-3.7, -1.2].flatMap((z) => [new THREE.Vector3(0, CABIN_FLOOR + 0.42, z), new THREE.Vector3(0, CABIN_FLOOR + 1.15, z)]);
  // Pallets on the roller tracks, front to back.
  const pallets = [-4.6, -3.0, -1.4, 0.2, 1.8].map((z) => new THREE.Vector3(0, CABIN_FLOOR, z));
  return {
    seats,
    litters,
    pallets,
    hinge: new THREE.Vector3(0, CABIN_FLOOR, 6.85),
    floor: CABIN_FLOOR,
    /** Fuselage, sponsons and lowered ramp, for walking around on the ground. */
    hull: { halfWidth: 2.9, front: -10.2, back: 10.1 },
    crewChief: new THREE.Vector3(1.36, CABIN_FLOOR, 5.7),
    /** Right door gunner and left window gunner, facing out. */
    gunners: [
      { pos: new THREE.Vector3(1.22, CABIN_FLOOR, -5.0), heading: -Math.PI / 2 },
      { pos: new THREE.Vector3(-1.22, CABIN_FLOOR, -5.0), heading: Math.PI / 2 },
    ],
    pilots: [
      { pos: new THREE.Vector3(0.62, COCKPIT_FLOOR, -7.5), heading: 0 },
      { pos: new THREE.Vector3(-0.62, COCKPIT_FLOOR, -7.5), heading: 0 },
    ],
  };
})();

type AddFn = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x?: number, y?: number, z?: number, parent?: THREE.Object3D) => THREE.Mesh;

interface Opening {
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

/** Windows and gun openings on one side of the cabin. */
function openings(sx: number): Opening[] {
  const list: Opening[] = CABIN_WINDOWS.map((c) => ({ z0: c - WIN_HALF, z1: c + WIN_HALF, y0: WIN_Y[0], y1: WIN_Y[1] }));
  const o = sx > 0 ? DOOR : PORT;
  list.push({ z0: o.z[0], z1: o.z[1], y0: o.y[0], y1: o.y[1] });
  return list;
}

/** Quilted wall lining for one side, with holes for the windows and the gun opening. */
function liningGeometry(sx: number, z0: number, z1: number, y0: number, y1: number) {
  const shape = new THREE.Shape();
  shape.moveTo(z0, y0);
  shape.lineTo(z1, y0);
  shape.lineTo(z1, y1);
  shape.lineTo(z0, y1);
  shape.lineTo(z0, y0);
  for (const o of openings(sx)) {
    const h = new THREE.Path();
    h.moveTo(o.z0, o.y0);
    h.lineTo(o.z0, o.y1);
    h.lineTo(o.z1, o.y1);
    h.lineTo(o.z1, o.y0);
    h.lineTo(o.z0, o.y0);
    shape.holes.push(h);
  }
  // Shape X runs along the body's Z axis.
  const geo = new THREE.ShapeGeometry(shape);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, 0, p.getY(i), p.getX(i));
  geo.computeVertexNormals();
  return geo;
}

function buildCabinInterior(add: AddFn, exterior: THREE.Group, liner: THREE.Material, dark: THREE.Material, olive: THREE.Material) {
  const g = new THREE.Group();
  exterior.add(g);
  const F = CABIN_FLOOR;
  const quilt = new THREE.MeshStandardMaterial({ color: 0x6b705c, roughness: 0.95, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3d3f38, roughness: 0.85, metalness: 0.2 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d86, roughness: 0.5, metalness: 0.6 });
  const webbing = new THREE.MeshStandardMaterial({ color: 0x8a3428, roughness: 0.9 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xffeccc });
  const redLamp = new THREE.MeshBasicMaterial({ color: 0xff3a2a });

  const z0 = -5.95;
  const z1 = 6.95;
  const len = z1 - z0;
  const zc = (z0 + z1) / 2;
  // Floor, wall lining and ceiling.
  add(new THREE.BoxGeometry(3.36, 0.06, len), floorMat, 0, F - 0.03, zc, g);
  for (const sx of [-1, 1]) {
    add(liningGeometry(sx, z0, z1, F + 0.15, F + 2.75), quilt, sx * 1.66, 0, 0, g);
    // Window and gun-port reveals through the wall thickness.
    for (const o of openings(sx)) {
      for (const y of [o.y0, o.y1]) add(new THREE.BoxGeometry(0.26, 0.03, o.z1 - o.z0), liner, sx * 1.78, y, (o.z0 + o.z1) / 2, g);
      for (const z of [o.z0, o.z1]) add(new THREE.BoxGeometry(0.26, o.y1 - o.y0, 0.03), liner, sx * 1.78, (o.y0 + o.y1) / 2, z, g);
    }
    // Roller tracks and tie-down rings.
    add(new THREE.BoxGeometry(0.28, 0.035, len - 0.4), metal, sx * 0.55, F + 0.018, zc, g);
    for (let z = z0 + 0.6; z < z1 - 0.3; z += 0.5) add(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 6), dark, sx * 0.55, F + 0.04, z, g);
    for (let z = z0 + 0.4; z < z1 - 0.3; z += 1.0) add(new THREE.TorusGeometry(0.06, 0.012, 4, 8).rotateX(Math.PI / 2), metal, sx * 1.0, F + 0.02, z, g);
  }
  add(new THREE.BoxGeometry(3.0, 0.05, len), quilt, 0, 1.76, zc, g);
  // Hook hatch ("hell hole").
  add(new THREE.BoxGeometry(0.9, 0.012, 0.9), dark, 0, F + 0.01, 0.2, g);
  add(new THREE.BoxGeometry(0.95, 0.03, 0.06), metal, 0, F + 0.02, -0.25, g);
  add(new THREE.BoxGeometry(0.95, 0.03, 0.06), metal, 0, F + 0.02, 0.65, g);
  // Frames (ribs).
  for (let z = z0 + 0.4; z < z1; z += 0.8) {
    for (const sx of [-1, 1]) if (!openings(sx).some((o) => z > o.z0 - 0.08 && z < o.z1 + 0.08)) add(new THREE.BoxGeometry(0.1, 2.7, 0.08), liner, sx * 1.62, F + 1.42, z, g);
    add(new THREE.BoxGeometry(3.0, 0.1, 0.08), liner, 0, 1.7, z, g);
  }
  // Ceiling: cable trays and dome lights.
  for (const sx of [-0.7, 0.7]) add(new THREE.BoxGeometry(0.16, 0.06, len - 0.4), dark, sx, 1.66, zc, g);
  add(new THREE.CylinderGeometry(0.03, 0.03, len - 0.4, 6).rotateX(Math.PI / 2), metal, 0.3, 1.68, zc, g);
  add(new THREE.CylinderGeometry(0.025, 0.025, len - 0.4, 6).rotateX(Math.PI / 2), metal, -0.3, 1.68, zc, g);
  for (let z = z0 + 1.2; z < z1; z += 2.4) {
    add(new THREE.BoxGeometry(0.35, 0.04, 0.2), lamp, 0, 1.71, z, g);
    add(new THREE.BoxGeometry(0.12, 0.04, 0.12), redLamp, 0.45, 1.71, z + 0.4, g);
  }
  // Troop seats: red webbing on tube frames, folded up between occupied rows.
  for (const s of CABIN.seats) {
    const sx = Math.sign(s.pos.x);
    add(new THREE.BoxGeometry(0.44, 0.04, 0.5), webbing, sx * 1.4, F + 0.44, s.pos.z, g);
    add(new THREE.BoxGeometry(0.04, 0.55, 0.5), webbing, sx * 1.62, F + 0.78, s.pos.z, g);
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 5), metal, sx * 1.18, F + 0.22, s.pos.z - 0.24, g);
  }
  // Seat rails along the walls.
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.022, 0.022, 8.6, 6).rotateX(Math.PI / 2), metal, sx * 1.19, F + 0.45, -0.24, g);
    add(new THREE.CylinderGeometry(0.022, 0.022, 8.6, 6).rotateX(Math.PI / 2), metal, sx * 1.6, F + 1.08, -0.24, g);
  }
  // Bulkhead to the cockpit with a wide companionway.
  add(new THREE.BoxGeometry(1.05, 3.0, 0.08), liner, -1.2, F + 1.5, z0, g);
  add(new THREE.BoxGeometry(1.05, 3.0, 0.08), liner, 1.2, F + 1.5, z0, g);
  add(new THREE.BoxGeometry(1.4, 0.9, 0.08), liner, 0, F + 2.6, z0, g);
  // Crew chief's jump seat by the ramp and the door-gun mount up front.
  add(new THREE.BoxGeometry(0.44, 0.05, 0.44), webbing, 1.4, F + 0.44, CABIN.crewChief.z, g);
  add(new THREE.BoxGeometry(0.05, 0.6, 0.44), webbing, 1.62, F + 0.8, CABIN.crewChief.z, g);
  // Door and window guns: a seat, a pintle post and an M240 on a swing arm out through the opening.
  const guns: DoorGunMount[] = [];
  for (const st of CABIN.gunners) {
    const sx = Math.sign(st.pos.x);
    add(new THREE.BoxGeometry(0.4, 0.05, 0.4), webbing, sx * 1.22, F + 0.46, st.pos.z, g);
    add(new THREE.CylinderGeometry(0.025, 0.025, 0.46, 5), metal, sx * 1.22, F + 0.23, st.pos.z, g);
    // Pintle post, braced to the floor, right under the gun's pivot.
    add(new THREE.CylinderGeometry(0.04, 0.05, 0.86, 6), metal, sx * 1.66, F + 0.47, st.pos.z, g);
    add(new THREE.BoxGeometry(0.3, 0.03, 0.3), metal, sx * 1.66, F + 0.03, st.pos.z, g);
    const gun = new THREE.Group();
    gun.position.set(sx * 1.66, F + 0.98, st.pos.z);
    gun.rotation.order = 'YXZ';
    const baseYaw = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
    gun.rotation.y = baseYaw;
    g.add(gun);
    // Receiver, feed cover, barrel with its jacket and carry handle, front sight, bipod folded, butt and spade grip.
    add(new THREE.BoxGeometry(0.1, 0.14, 0.62), dark, 0, 0, -0.04, gun);
    add(new THREE.BoxGeometry(0.11, 0.04, 0.3), dark, 0, 0.085, -0.05, gun);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8).rotateX(Math.PI / 2), dark, 0, 0.02, -0.48, gun);
    add(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 6).rotateX(Math.PI / 2), dark, 0, 0.02, -0.82, gun);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8).rotateX(Math.PI / 2), dark, 0, 0.02, -1.1, gun);
    add(new THREE.BoxGeometry(0.03, 0.08, 0.14), dark, 0, 0.1, -0.5, gun);
    add(new THREE.BoxGeometry(0.02, 0.09, 0.03), dark, 0, 0.08, -1.04, gun);
    add(new THREE.BoxGeometry(0.06, 0.03, 0.3), dark, 0, -0.06, -0.7, gun);
    add(new THREE.BoxGeometry(0.06, 0.12, 0.2), dark, 0, -0.01, 0.34, gun);
    add(new THREE.BoxGeometry(0.04, 0.13, 0.05), dark, 0.0, -0.12, 0.17, gun);
    // Ammo box on the left side and the belt feeding in.
    add(new THREE.BoxGeometry(0.14, 0.16, 0.2), olive, -0.13, -0.07, -0.05, gun);
    add(new THREE.BoxGeometry(0.06, 0.02, 0.08), olive, -0.06, 0.03, -0.05, gun);
    // Pivot yoke on the post.
    add(new THREE.BoxGeometry(0.06, 0.1, 0.1), metal, 0, -0.11, 0, gun);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -1.16);
    gun.add(muzzle);
    const flash = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.42, 6, 1, true).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    flash.position.set(0, 0.02, -1.38);
    flash.visible = false;
    gun.add(flash);
    const gripR = new THREE.Object3D();
    gripR.position.set(0.0, -0.13, 0.19);
    const gripL = new THREE.Object3D();
    gripL.position.set(-0.07, 0.02, 0.06);
    gun.add(gripR, gripL);
    guns.push({ mount: gun, baseYaw, muzzle, flash, gripR, gripL });
    // Ammo can and the belt feeding the gun.
    add(new THREE.BoxGeometry(0.22, 0.2, 0.3), olive, sx * 1.42, F + 0.6, st.pos.z - 0.35, g);
  }
  // Fuel and fire extinguisher bottles on the forward bulkhead.
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), redLamp, -1.3, F + 0.9, z0 + 0.15, g);
  // Cabin light.
  const light = new THREE.PointLight(0xfff0d8, 0, 20, 1.4);
  light.position.set(0, 1.3, -1.5);
  g.add(light);
  return { group: g, light, guns };
}
