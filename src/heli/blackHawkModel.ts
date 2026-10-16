import * as THREE from 'three';
import { rotorDiscTexture } from '../util/textures';
import { mergeStatic } from '../util/mergeStatic';
import type { FlightSpec } from './flight';
import type { AirframeCabin, AirframeParts } from './airframe';
import { buildM240, type DoorGunMount } from './chinookModel';

/**
 * Procedural UH-60 Black Hawk: a lofted fuselage with the cabin doors slid
 * open on both sides, gunner windows with M240s, a four-blade main rotor,
 * the tail pylon with its four-blade tail rotor and the stabilator, and
 * tail-dragger wheels. Body frame: forward = −Z, right = +X, up = +Y.
 */
export const BH_GEAR_Y = -1.95;
export const BH_ROTOR_RADIUS = 8.18;
export const BH_HUB = new THREE.Vector3(0, 2.15, -0.4);
/** Cabin floor. */
const F = -1.25;
/** Pilot's eye (right seat). */
export const BH_COCKPIT_POS = new THREE.Vector3(0.55, F + 1.4, -3.3);
/** Cabin door openings: both sides, this stretch of the fuselage. */
const DOOR_Z0 = -1.75;
const DOOR_Z1 = 0.35;

export const BH_WHEELS = [
  new THREE.Vector3(-1.45, BH_GEAR_Y, -2.0),
  new THREE.Vector3(1.45, BH_GEAR_Y, -2.0),
  new THREE.Vector3(0, BH_GEAR_Y, 7.6),
];
const BH_HULL = [
  new THREE.Vector3(0, -0.9, -5.0),
  new THREE.Vector3(0, -1.35, -0.4),
  new THREE.Vector3(0, 0.55, 9.3),
  new THREE.Vector3(0.4, 2.1, 9.2),
  new THREE.Vector3(0, 2.25, -0.4),
  new THREE.Vector3(-1.2, -0.5, -0.6),
  new THREE.Vector3(1.2, -0.5, -0.6),
  new THREE.Vector3(-2.2, 0.75, 8.9),
  new THREE.Vector3(2.2, 0.75, 8.9),
  new THREE.Vector3(0, -0.8, 3.2),
];

/** Medium lift: ~5.2 t empty, ~11 t of rotor thrust, quick but heavier than the Little Bird. */
export const BLACKHAWK_FLIGHT: FlightSpec = {
  emptyMass: 5200,
  fuelCapacity: 1100,
  maxThrustKg: 11200,
  inertia: [5.5e4, 5.0e4, 1.3e4],
  refMass: 7500,
  drag: [12, 10, 2.6],
  fuelBurn: 0.42,
  agility: 1.3,
  gearY: BH_GEAR_Y,
  wheels: BH_WHEELS,
  hull: BH_HULL,
};

/**
 * Eleven troop seats round the cabin walls (rear row facing forward, front
 * row facing aft, three along the left wall, one behind the right door), two
 * litters on the centreline, loading through the right-hand door.
 */
export const BLACKHAWK_CABIN: AirframeCabin = (() => {
  const seats: { pos: THREE.Vector3; heading: number }[] = [];
  for (const x of [-0.81, -0.27, 0.27, 0.81]) seats.push({ pos: new THREE.Vector3(x, F, 1.05), heading: 0 });
  for (const z of [-0.85, -0.2, 0.45]) seats.push({ pos: new THREE.Vector3(-0.92, F, z), heading: -Math.PI / 2 });
  seats.push({ pos: new THREE.Vector3(0.92, F, 0.75), heading: Math.PI / 2 });
  for (const x of [-0.6, 0, 0.6]) seats.push({ pos: new THREE.Vector3(x, F, -1.5), heading: Math.PI });
  return {
    floor: F,
    hinge: new THREE.Vector3(0.95, F, -0.55),
    out: new THREE.Vector3(1, 0, 0),
    /** Fast ropes from both cabin doors. */
    ropes: [new THREE.Vector3(1.3, F, -0.55), new THREE.Vector3(-1.3, F, -0.55)],
    seats,
    litters: [new THREE.Vector3(0, F + 0.42, -0.2), new THREE.Vector3(0, F + 1.02, -0.2)],
    pallets: [],
    hull: { halfWidth: 1.6, front: -5.5, back: 9.6 },
    crewChief: null,
    gunners: [
      { pos: new THREE.Vector3(0.82, F, -2.05), heading: -Math.PI / 2 },
      { pos: new THREE.Vector3(-0.82, F, -2.05), heading: Math.PI / 2 },
    ],
    pilots: [
      { pos: new THREE.Vector3(0.55, F + 0.12, -3.25), heading: 0 },
      { pos: new THREE.Vector3(-0.55, F + 0.12, -3.25), heading: 0 },
    ],
  };
})();

/** Fuselage cross-sections along the body: z, width, height, centre height. */
const SECTIONS: [number, number, number, number][] = [
  // The nose sits below the windscreen line, so the pilots see over it.
  [-5.35, 0.42, 0.5, -0.85],
  [-5.0, 1.1, 0.95, -0.7],
  [-4.4, 1.75, 1.6, -0.38],
  [-3.6, 2.1, 2.0, -0.15],
  [-2.6, 2.32, 2.2, -0.05],
  [1.3, 2.36, 2.2, -0.05],
  [2.4, 1.95, 1.85, 0.05],
  [3.4, 1.05, 1.05, 0.35],
  [6.0, 0.62, 0.7, 0.55],
  [8.7, 0.42, 0.52, 0.7],
];

/** A superellipse ring (|x/a|^4 + |y/b|^4 = 1 bulged to |…|^3) of n points. */
function ring(w: number, h: number, yc: number, n: number) {
  const pts: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const e = 2 / 3;
    pts.push({ x: (w / 2) * Math.sign(c) * Math.abs(c) ** e, y: yc + (h / 2) * Math.sign(s) * Math.abs(s) ** e, nx: c, ny: s });
  }
  return pts;
}

/** The lofted skin, split into hull and glazing, with the cabin door openings left out. */
function buildSkin(): { hull: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const N = 28;
  const hullPos: number[] = [];
  const glassPos: number[] = [];
  const rings = SECTIONS.map(([z, w, h, yc]) => ({ z, pts: ring(w, h, yc, N) }));
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k];
    const B = rings[k + 1];
    // Subdivide long sections so the door and window edges land cleanly.
    const steps = Math.max(1, Math.round((B.z - A.z) / 0.35));
    for (let st = 0; st < steps; st++) {
      const u0 = st / steps;
      const u1 = (st + 1) / steps;
      const z0 = THREE.MathUtils.lerp(A.z, B.z, u0);
      const z1 = THREE.MathUtils.lerp(A.z, B.z, u1);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const p = (r: number, idx: number) => {
          const a = A.pts[idx];
          const b = B.pts[idx];
          return [THREE.MathUtils.lerp(a.x, b.x, r), THREE.MathUtils.lerp(a.y, b.y, r)];
        };
        const [ax0, ay0] = p(u0, i);
        const [bx0, by0] = p(u0, j);
        const [ax1, ay1] = p(u1, i);
        const [bx1, by1] = p(u1, j);
        const zm = (z0 + z1) / 2;
        const ym = (ay0 + by0 + ay1 + by1) / 4;
        const side = Math.abs(A.pts[i].nx + A.pts[j].nx) / 2;
        // Cabin doors (slid back, open): side faces in the door stretch, floor to door top.
        if (zm > DOOR_Z0 && zm < DOOR_Z1 && side > 0.55 && ym > F + 0.05 && ym < F + 1.5) continue;
        // Gunner windows: open, just ahead of the doors.
        if (zm > -2.45 && zm < DOOR_Z0 && side > 0.6 && ym > F + 0.75 && ym < F + 1.5) continue;
        // Windscreen and cockpit side glass: the upper nose.
        const glassFace = zm < -2.55 && zm > -4.95 && ym > -0.35 && !(Math.abs(A.pts[i].ny) > 0.97 && zm > -3.4);
        const out = glassFace ? glassPos : hullPos;
        out.push(ax0, ay0, z0, bx0, by0, z0, bx1, by1, z1, ax0, ay0, z0, bx1, by1, z1, ax1, ay1, z1);
      }
    }
  }
  const mk = (arr: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  return { hull: mk(hullPos), glass: mk(glassPos) };
}

export function buildBlackHawk(): AirframeParts {
  const paint = new THREE.MeshStandardMaterial({ color: 0x3a3f33, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24261f, roughness: 0.75, metalness: 0.15 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x55585a, roughness: 0.45, metalness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  const interior = new THREE.MeshStandardMaterial({ color: 0x4a4d44, roughness: 0.9, side: THREE.DoubleSide });
  const webbing = new THREE.MeshStandardMaterial({ color: 0x6b5f45, roughness: 0.95 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x5e6640, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x46596a, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });

  const root = new THREE.Group();
  const exterior = new THREE.Group();
  root.add(exterior);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, parent: THREE.Object3D = exterior) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = mat !== glass;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = add(new THREE.CylinderGeometry(r, r, d.length(), 8), mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  };

  const skin = buildSkin();
  add(skin.hull, paint);
  // Nose cap closing the loft.
  add(new THREE.SphereGeometry(0.26, 12, 8).scale(0.85, 1, 0.7), paint, 0, -0.85, -5.35);
  add(skin.glass, glass);
  // Cabin floor, the bulkheads and the open doors slid back along their rails.
  add(new THREE.BoxGeometry(2.2, 0.06, DOOR_Z1 - DOOR_Z0 + 1.6), interior, 0, F - 0.03, (DOOR_Z0 + 1.3) / 2);
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, 1.45, DOOR_Z1 - DOOR_Z0), paint, sx * 1.24, F + 0.75, DOOR_Z1 + (DOOR_Z1 - DOOR_Z0) / 2 - 0.1);
    add(new THREE.BoxGeometry(0.06, 0.06, 3.6), metal, sx * 1.2, F + 1.55, 0.6);
  }
  // Seats: webbing on tube frames.
  for (const s of BLACKHAWK_CABIN.seats) {
    const g = new THREE.Group();
    g.position.copy(s.pos);
    g.rotation.y = s.heading;
    exterior.add(g);
    add(new THREE.BoxGeometry(0.5, 0.06, 0.42), webbing, 0, 0.44, 0, g);
    add(new THREE.BoxGeometry(0.5, 0.55, 0.05), webbing, 0, 0.75, 0.22, g);
  }

  // Engines and transmission on the roof, exhausts angled out.
  add(new THREE.BoxGeometry(1.55, 0.55, 2.9), paint, 0, 1.33, -0.35);
  add(new THREE.SphereGeometry(0.62, 14, 10).scale(1.2, 0.55, 1.3), paint, 0, 1.55, -1.75);
  const exhausts: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.42, 0.34, 0.8), dark, sx * 0.85, 1.28, 0.95).rotation.y = sx * 0.35;
    const e = new THREE.Object3D();
    e.position.set(sx * 1.05, 1.28, 1.35);
    exterior.add(e);
    exhausts.push(e);
  }
  // Tail pylon (swept), stabilator, tail wheel.
  const pylon = add(new THREE.BoxGeometry(0.2, 2.2, 1.15), paint, 0, 1.55, 8.85);
  pylon.rotation.x = -0.4;
  add(new THREE.BoxGeometry(4.4, 0.07, 0.9), paint, 0, 0.75, 8.95);
  tube(new THREE.Vector3(0, -0.1, 7.6), new THREE.Vector3(0, BH_GEAR_Y + 0.22, 7.6), 0.05, metal);
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateZ(Math.PI / 2), rubber, 0, BH_GEAR_Y + 0.22, 7.6);
  // Main gear: a wheel each side on a drag beam and an oleo.
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.38, 0.38, 0.22, 14).rotateZ(Math.PI / 2), rubber, sx * 1.45, BH_GEAR_Y + 0.38, -2.0);
    tube(new THREE.Vector3(sx * 1.45, BH_GEAR_Y + 0.38, -2.0), new THREE.Vector3(sx * 1.05, -0.95, -1.5), 0.06, metal);
    tube(new THREE.Vector3(sx * 1.45, BH_GEAR_Y + 0.38, -2.0), new THREE.Vector3(sx * 1.05, -0.4, -2.3), 0.07, metal);
  }

  // Gunner windows: a seat and an M240 on its pintle each side.
  const doorGuns: DoorGunMount[] = [];
  for (const st of BLACKHAWK_CABIN.gunners) {
    const sx = Math.sign(st.pos.x);
    add(new THREE.BoxGeometry(0.4, 0.05, 0.4), webbing, st.pos.x, F + 0.46, st.pos.z);
    add(new THREE.CylinderGeometry(0.04, 0.05, 0.95, 6), metal, sx * 1.27, F + 0.5, st.pos.z);
    doorGuns.push(buildM240(add, exterior, new THREE.Vector3(sx * 1.27, F + 1.0, st.pos.z), sx, dark, olive, metal));
  }

  // Main rotor: four blades.
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x25261f, roughness: 0.6, metalness: 0.2, transparent: true });
  const discMat = new THREE.MeshBasicMaterial({ map: rotorDiscTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  add(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 8), metal, BH_HUB.x, BH_HUB.y - 0.3, BH_HUB.z);
  const main = new THREE.Group();
  main.position.copy(BH_HUB);
  exterior.add(main);
  add(new THREE.CylinderGeometry(0.32, 0.36, 0.22, 12), dark, 0, 0, 0, main);
  const bladeGeo = new THREE.BoxGeometry(BH_ROTOR_RADIUS, 0.06, 0.53).translate(BH_ROTOR_RADIUS / 2, 0, 0);
  const blades: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.y = (i / 4) * Math.PI * 2;
    b.castShadow = true;
    main.add(b);
    blades.push(b);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(BH_ROTOR_RADIUS, 48).rotateX(-Math.PI / 2), discMat);
  disc.position.y = 0.04;
  disc.renderOrder = 2;
  main.add(disc);
  // Tail rotor on the right of the pylon.
  const tail = new THREE.Group();
  tail.position.set(0.32, 2.1, 9.2);
  exterior.add(tail);
  const tailBlades: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.68, 0.2).translate(0, 0.84, 0), bladeMat);
    b.rotation.x = (i / 4) * Math.PI * 2;
    tail.add(b);
    tailBlades.push(b);
  }

  // Lights.
  const lightGeo = new THREE.SphereGeometry(0.08, 8, 6);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff2020 }), -1.2, 0.5, -1.9);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0x20ff40 }), 1.2, 0.5, -1.9);
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
  add(new THREE.SphereGeometry(0.1, 8, 6), strobeMat, 0, 2.75, 9.25);

  // Cockpit: two armoured seats, the panel and glareshield, cyclics.
  const cockpitInterior = new THREE.Group();
  root.add(cockpitInterior);
  const cp = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => add(geo, mat, x, y, z, cockpitInterior);
  // Panel low enough to see over the glareshield and out of the chin windows.
  cp(new THREE.BoxGeometry(1.9, 0.45, 0.25), dark, 0, F + 0.62, -4.25);
  cp(new THREE.BoxGeometry(1.9, 0.05, 0.4), interior, 0, F + 0.87, -4.15);
  cp(new THREE.BoxGeometry(0.4, 0.55, 0.9), dark, 0, F + 0.55, -3.55);
  for (const sx of [-1, 1]) {
    cp(new THREE.BoxGeometry(0.55, 0.12, 0.55), interior, sx * 0.55, F + 0.5, -3.2);
    cp(new THREE.BoxGeometry(0.55, 0.85, 0.12), interior, sx * 0.55, F + 0.95, -2.9);
    cp(new THREE.CylinderGeometry(0.02, 0.025, 0.55, 6), dark, sx * 0.55, F + 0.5, -3.65);
  }
  cp(new THREE.BoxGeometry(2.2, 0.05, 1.6), interior, 0, F + 0.08, -3.4);

  const rampEnd = new THREE.Object3D();
  rampEnd.position.set(1.85, BH_GEAR_Y + 0.05, -0.55);
  exterior.add(rampEnd);
  const cabinPoint = new THREE.Object3D();
  cabinPoint.position.set(0, F + 0.4, -0.4);
  exterior.add(cabinPoint);
  const hook = new THREE.Object3D();
  hook.position.set(0, -1.55, -0.3);
  exterior.add(hook);

  mergeStatic(exterior, new Set<THREE.Object3D>([main, tail, ...doorGuns.map((g) => g.mount)]));
  mergeStatic(cockpitInterior, new Set());
  cockpitInterior.traverse((o) => (o.castShadow = false));

  return {
    root,
    exterior,
    rotors: [
      // UH-60 main rotor turns counter-clockwise seen from above (~258 rpm).
      { g: main, blades, axis: 'y', rate: 27, phase: 0 },
      { g: tail, blades: tailBlades, axis: 'x', rate: 125, phase: 0 },
    ],
    bladeMat,
    discMat,
    strobeMat,
    ramp: null,
    rampEnd,
    cabinPoint,
    hook,
    exhaustL: exhausts[0],
    exhaustR: exhausts[1],
    cockpitInterior,
    cabinLight: null,
    doorGuns,
  };
}
