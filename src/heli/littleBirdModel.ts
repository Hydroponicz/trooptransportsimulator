import * as THREE from 'three';
import { rotorDiscTexture } from '../util/textures';
import { mergeStatic } from '../util/mergeStatic';
import type { FlightSpec } from './flight';
import type { AirframeCabin, AirframeParts } from './airframe';

/**
 * Procedural MH-6 Little Bird: a small egg-shaped cabin flown with the doors
 * off, a six-blade main rotor, a slender boom with a T-tail, skids, and the
 * external "people pod" benches on both sides that carry three operators each.
 * Body frame: forward = −Z, right = +X, up = +Y; origin near the centre of mass.
 */
export const LB_GEAR_Y = -1.38;
export const LB_ROTOR_RADIUS = 4.15;
export const LB_HUB = new THREE.Vector3(0, 1.32, -0.25);
/** Bench top and the outboard edge the operators sit on, legs over the side. */
const BENCH_Y = -0.58;
const BENCH_X = 1.22;
/** Pilot's eye (right seat). */
export const LB_COCKPIT_POS = new THREE.Vector3(0.33, 0.28, -1.05);

const SKID_X = 0.98;
export const LB_SKIDS = [
  new THREE.Vector3(-SKID_X, LB_GEAR_Y, -1.45),
  new THREE.Vector3(SKID_X, LB_GEAR_Y, -1.45),
  new THREE.Vector3(-SKID_X, LB_GEAR_Y, 1.15),
  new THREE.Vector3(SKID_X, LB_GEAR_Y, 1.15),
];
const LB_HULL = [
  new THREE.Vector3(0, -0.35, -2.05),
  new THREE.Vector3(0, -0.95, -0.4),
  new THREE.Vector3(0, 0.25, 4.6),
  new THREE.Vector3(-0.2, 0.5, 5.2),
  new THREE.Vector3(0, 1.4, -0.25),
  new THREE.Vector3(-0.8, -0.2, -0.6),
  new THREE.Vector3(0.8, -0.2, -0.6),
  new THREE.Vector3(-1.45, BENCH_Y, -0.95),
  new THREE.Vector3(1.45, BENCH_Y, -0.95),
  new THREE.Vector3(-1.45, BENCH_Y, 0.85),
  new THREE.Vector3(1.45, BENCH_Y, 0.85),
];

/** Light and nimble: ~1.6 t at full load against ~2.4 t of rotor thrust. */
export const LITTLEBIRD_FLIGHT: FlightSpec = {
  emptyMass: 820,
  fuelCapacity: 190,
  maxThrustKg: 2450,
  inertia: [1800, 1900, 700],
  refMass: 1300,
  drag: [4, 3.5, 1.1],
  fuelBurn: 0.06,
  agility: 1.8,
  gearY: LB_GEAR_Y,
  wheels: LB_SKIDS,
  hull: LB_HULL,
};

/**
 * Three operators a side on the pods, facing out. Seat entries are soldier
 * root positions (under the pelvis, a sitting height below the bench top).
 */
export const LITTLEBIRD_CABIN: AirframeCabin = (() => {
  const seats: { pos: THREE.Vector3; heading: number }[] = [];
  for (const z of [-0.72, 0.05, 0.82])
    for (const sx of [-1, 1]) seats.push({ pos: new THREE.Vector3(sx * (BENCH_X - 0.05), BENCH_Y - 0.45, z), heading: sx < 0 ? Math.PI / 2 : -Math.PI / 2 });
  return {
    floor: BENCH_Y - 0.45,
    hinge: new THREE.Vector3(BENCH_X + 0.7, BENCH_Y - 0.45, 0),
    seats,
    litters: [],
    pallets: [],
    hull: { halfWidth: 1.75, front: -2.4, back: 5.6 },
    sideBenches: true,
    crewChief: null,
    gunners: [],
    pilots: [
      { pos: new THREE.Vector3(0.33, -0.92, -1.05), heading: 0 },
      { pos: new THREE.Vector3(-0.33, -0.92, -1.05), heading: 0 },
    ],
  };
})();

export function buildLittleBird(): AirframeParts {
  const black = new THREE.MeshStandardMaterial({ color: 0x1d1f1e, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c2a, roughness: 0.7, metalness: 0.2 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x55585a, roughness: 0.45, metalness: 0.6 });
  const bench = new THREE.MeshStandardMaterial({ color: 0x3b3d38, roughness: 0.85 });
  const interior = new THREE.MeshStandardMaterial({ color: 0x2e302d, roughness: 0.9, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x2b3a44,
    roughness: 0.05,
    metalness: 0.3,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const root = new THREE.Group();
  const exterior = new THREE.Group();
  root.add(exterior);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = exterior) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = mat !== glass;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** A tube between two points. */
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = add(new THREE.CylinderGeometry(r, r, d.length(), 8), mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  };

  // The egg: a stretched sphere in pieces, leaving the door openings (flown doors-off)
  // and the windscreen, which is glazed.
  const EGG = new THREE.Vector3(0.8, 0.84, 1.45);
  const EGG_C = new THREE.Vector3(0, -0.12, -0.55);
  const shell = (phi0: number, phi1: number, th0: number, th1: number, mat: THREE.Material) => {
    const g = new THREE.SphereGeometry(1, 28, 18, phi0 * Math.PI, (phi1 - phi0) * Math.PI, th0 * Math.PI, (th1 - th0) * Math.PI);
    g.scale(EGG.x, EGG.y, EGG.z);
    add(g, mat, EGG_C.x, EGG_C.y, EGG_C.z);
  };
  // Three's sphere: z = sin(phi) sin(theta), so the front (−Z) is phi in (1, 2) × π.
  shell(0, 2, 0.6, 1, black); // belly and chin
  shell(0, 1, 0, 0.6, black); // aft half, behind the doors
  shell(1, 2, 0, 0.18, black); // roof over the cockpit
  shell(1.22, 1.78, 0.18, 0.6, glass); // windscreen
  // Door frames: the posts between the openings and the windscreen.
  for (const sx of [-1, 1]) {
    tube(new THREE.Vector3(sx * 0.6, 0.45, -1.35), new THREE.Vector3(sx * 0.66, -0.35, -1.62), 0.035, black);
    tube(new THREE.Vector3(sx * 0.74, 0.35, -0.2), new THREE.Vector3(sx * 0.8, -0.4, -0.25), 0.04, black);
  }
  // Floor inside, seen through the open doors.
  add(new THREE.BoxGeometry(1.3, 0.05, 2.1), interior, 0, -0.84, -0.7);
  // Engine and transmission fairing behind the mast, exhaust out the back.
  add(new THREE.BoxGeometry(0.72, 0.42, 1.3), black, 0, 0.72, 0.2).geometry.translate(0, 0, 0);
  add(new THREE.SphereGeometry(0.36, 14, 10).scale(1, 0.6, 1.2), black, 0, 0.82, -0.35);
  const exhaust = new THREE.Object3D();
  exhaust.position.set(0, 0.62, 0.95);
  exterior.add(exhaust);
  add(new THREE.CylinderGeometry(0.11, 0.13, 0.3, 10).rotateX(Math.PI / 2), dark, 0, 0.62, 0.85);

  // Tail boom, slightly up-tilted, with the T-tail and the tail rotor on the left.
  tube(new THREE.Vector3(0, 0.12, 0.6), new THREE.Vector3(0, 0.38, 5.05), 0.17, black).scale.set(1, 1, 1);
  tube(new THREE.Vector3(0, 0.38, 4.6), new THREE.Vector3(0, 0.38, 5.1), 0.09, black);
  const fin = add(new THREE.BoxGeometry(0.06, 1.0, 0.5), black, 0, 0.75, 5.05);
  fin.rotation.x = -0.35;
  add(new THREE.BoxGeometry(0.05, 0.5, 0.35), black, 0, 0.12, 5.0).rotation.x = 0.3;
  add(new THREE.BoxGeometry(1.5, 0.05, 0.36), black, 0, 1.2, 5.25);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.32, 0.28), black, sx * 0.75, 1.2, 5.27);

  // Skids and crosstubes.
  for (const sx of [-1, 1]) {
    tube(new THREE.Vector3(sx * SKID_X, LB_GEAR_Y + 0.04, -1.55), new THREE.Vector3(sx * SKID_X, LB_GEAR_Y + 0.04, 1.3), 0.045, metal);
    tube(new THREE.Vector3(sx * SKID_X, LB_GEAR_Y + 0.04, -1.55), new THREE.Vector3(sx * SKID_X, LB_GEAR_Y + 0.28, -1.85), 0.045, metal);
    for (const z of [-0.95, 0.68]) tube(new THREE.Vector3(sx * SKID_X, LB_GEAR_Y + 0.04, z), new THREE.Vector3(sx * 0.5, -0.86, z), 0.05, metal);
  }
  for (const z of [-0.95, 0.68]) tube(new THREE.Vector3(-0.5, -0.86, z), new THREE.Vector3(0.5, -0.86, z), 0.05, metal);

  // People pods: a bench plank outboard on each side, on struts off the crosstubes, with a footrest bar.
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.46, 0.07, 2.05), bench, sx * BENCH_X, BENCH_Y - 0.035, -0.05);
    for (const z of [-0.95, 0.68]) tube(new THREE.Vector3(sx * 0.7, -0.82, z), new THREE.Vector3(sx * (BENCH_X + 0.15), BENCH_Y - 0.07, z), 0.035, metal);
    tube(new THREE.Vector3(sx * (BENCH_X + 0.32), -1.08, -0.95), new THREE.Vector3(sx * (BENCH_X + 0.32), -1.08, 0.85), 0.025, metal);
  }

  // Main rotor: six blades on a low hub.
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x232523, roughness: 0.6, metalness: 0.2, transparent: true });
  const discMat = new THREE.MeshBasicMaterial({ map: rotorDiscTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  add(new THREE.CylinderGeometry(0.09, 0.12, 0.45, 8), metal, LB_HUB.x, LB_HUB.y - 0.25, LB_HUB.z);
  const main = new THREE.Group();
  main.position.copy(LB_HUB);
  exterior.add(main);
  add(new THREE.CylinderGeometry(0.2, 0.24, 0.16, 12), dark, 0, 0, 0, main);
  const bladeGeo = new THREE.BoxGeometry(LB_ROTOR_RADIUS, 0.04, 0.19).translate(LB_ROTOR_RADIUS / 2, 0, 0);
  const blades: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.y = (i / 6) * Math.PI * 2;
    b.castShadow = true;
    main.add(b);
    blades.push(b);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(LB_ROTOR_RADIUS, 40).rotateX(-Math.PI / 2), discMat);
  disc.position.y = 0.03;
  disc.renderOrder = 2;
  main.add(disc);
  // Tail rotor: two blades turning about the boom's cross axis.
  const tail = new THREE.Group();
  tail.position.set(-0.16, 0.5, 5.15);
  exterior.add(tail);
  const tailBlades: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.75, 0.1).translate(0, 0.375, 0), bladeMat);
    b.rotation.x = i * Math.PI;
    tail.add(b);
    tailBlades.push(b);
  }

  // Lights.
  const lightGeo = new THREE.SphereGeometry(0.06, 8, 6);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff2020 }), -0.82, -0.1, -0.55);
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0x20ff40 }), 0.82, -0.1, -0.55);
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
  add(new THREE.SphereGeometry(0.08, 8, 6), strobeMat, 0, 1.28, 5.1);

  // Cockpit: two seats, the panel, the sticks.
  const cockpitInterior = new THREE.Group();
  root.add(cockpitInterior);
  const cp = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => add(geo, mat, x, y, z, cockpitInterior);
  cp(new THREE.BoxGeometry(1.1, 0.32, 0.16), dark, 0, -0.32, -1.72);
  cp(new THREE.BoxGeometry(0.9, 0.03, 0.26), interior, 0, -0.15, -1.63);
  for (const sx of [-1, 1]) {
    cp(new THREE.BoxGeometry(0.46, 0.1, 0.48), interior, sx * 0.33, -0.5, -0.95);
    cp(new THREE.BoxGeometry(0.46, 0.62, 0.1), interior, sx * 0.33, -0.2, -0.68);
    cp(new THREE.CylinderGeometry(0.015, 0.02, 0.5, 6), dark, sx * 0.33, -0.6, -1.32);
  }

  const rampEnd = new THREE.Object3D();
  rampEnd.position.set(BENCH_X + 0.7, LB_GEAR_Y + 0.05, 0);
  exterior.add(rampEnd);
  const cabinPoint = new THREE.Object3D();
  cabinPoint.position.set(0, -0.5, -0.4);
  exterior.add(cabinPoint);
  const hook = new THREE.Object3D();
  hook.position.set(0, -1.1, 0);
  exterior.add(hook);

  mergeStatic(exterior, new Set<THREE.Object3D>([main, tail]));
  mergeStatic(cockpitInterior, new Set());
  cockpitInterior.traverse((o) => (o.castShadow = false));

  return {
    root,
    exterior,
    rotors: [
      // MH-6 main rotor turns counter-clockwise seen from above (~470 rpm), tail rotor fast.
      { g: main, blades, axis: 'y', rate: 49, phase: 0 },
      { g: tail, blades: tailBlades, axis: 'x', rate: 290, phase: 0 },
    ],
    bladeMat,
    discMat,
    strobeMat,
    ramp: null,
    rampEnd,
    cabinPoint,
    hook,
    exhaustL: exhaust,
    exhaustR: exhaust,
    cockpitInterior,
    cabinLight: null,
    doorGuns: [],
  };
}
