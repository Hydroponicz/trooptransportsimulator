import * as THREE from 'three';
import { rotorDiscTexture } from '../util/textures';

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
export const COCKPIT_POS = new THREE.Vector3(0.62, 0.95, -7.15);
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
    color: 0x223038,
    roughness: 0.08,
    metalness: 0.6,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const interior = new THREE.MeshStandardMaterial({ color: 0x4a4d44, roughness: 0.9, side: THREE.DoubleSide });

  const root = new THREE.Group();
  const exterior = new THREE.Group();
  root.add(exterior);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = exterior) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Main cabin: a hollow rounded tube (open at the back, where the ramp is).
  const shellShape = roundedRect(3.8, 3.6, 0.75);
  shellShape.holes.push(roundedRect(3.44, 3.24, 0.6) as unknown as THREE.Path);
  const cabin = new THREE.ExtrudeGeometry(shellShape, { depth: 13.2, bevelEnabled: false, curveSegments: 4 });
  cabin.translate(0, 0.2, -6.2);
  add(cabin, olive);
  // Aft pylon closure above the ramp opening.
  add(new THREE.BoxGeometry(3.5, 0.75, 0.12), olive, 0, 1.45, 6.94);

  // Chin / lower nose.
  add(
    shapedBox(3.6, 1.7, 2.8, (v) => {
      if (v.z < 0) {
        v.y += v.y < 0 ? 0.35 : 0;
        v.x *= 0.85;
      }
    }),
    olive,
    0,
    -0.75,
    -7.5,
  );
  // Nose cone.
  add(
    shapedBox(3.0, 1.1, 0.9, (v) => {
      if (v.z < 0) {
        v.x *= 0.6;
        v.y = v.y * 0.6 - 0.1;
      }
    }),
    oliveDark,
    0,
    -0.45,
    -9.25,
  );

  // Cockpit glazing, slanted windshield.
  const canopy = shapedBox(3.5, 1.9, 2.6, (v) => {
    if (v.z < 0 && v.y > 0) v.z += 1.1;
    if (v.y > 0) v.x *= 0.88;
  });
  add(canopy, glass, 0, 1.0, -7.4);
  // Window frames.
  // Window frames, laid along the slanted windshield.
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3d33, roughness: 0.8 });
  const frameGeo = new THREE.BoxGeometry(0.035, 2.15, 0.035);
  for (const x of [-1.5, 0, 1.5]) {
    // The windshield leans back toward the crew: bottom at z≈-8.7, top at z≈-7.6.
    const f = add(frameGeo, frameMat, x * 0.9, 1.0, -8.17);
    f.rotation.x = 0.52;
  }
  add(new THREE.BoxGeometry(3.4, 0.12, 1.5), olive, 0, 1.98, -6.85);

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

  // Cabin windows.
  const winGeo = new THREE.BoxGeometry(0.06, 0.55, 0.55);
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1a2228, roughness: 0.2, metalness: 0.5 });
  for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) add(winGeo, winMat, sx * 1.91, 0.75, -4.2 + i * 1.75);
  // Crew door (right side, front).
  add(new THREE.BoxGeometry(0.06, 1.75, 0.9), dark, 1.91, -0.2, -5.0);

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
  add(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 0, 0.6, 7.1);
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
  const strobe = add(new THREE.SphereGeometry(0.16, 8, 6), strobeMat, 0, 4.35, 3.2);

  // Cockpit interior (only matters from the pilot's seat).
  const cockpitInterior = new THREE.Group();
  root.add(cockpitInterior);
  const panel = add(new THREE.BoxGeometry(3.0, 0.75, 0.5), interior, 0, 0.15, -8.05, cockpitInterior);
  panel.rotation.x = -0.35;
  add(new THREE.BoxGeometry(3.2, 0.12, 0.7), interior, 0, 0.58, -7.95, cockpitInterior);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x1f5a34 });
  for (const x of [-1.0, -0.35, 0.35, 1.0]) {
    const s = add(new THREE.PlaneGeometry(0.5, 0.42), screenMat, x, 0.2, -7.78, cockpitInterior);
    s.rotation.x = -0.35;
  }
  add(new THREE.BoxGeometry(0.05, 1.6, 2.6), interior, 1.75, -0.6, -7.3, cockpitInterior);
  add(new THREE.BoxGeometry(0.05, 1.6, 2.6), interior, -1.75, -0.6, -7.3, cockpitInterior);
  add(new THREE.BoxGeometry(3.4, 0.05, 2.6), interior, 0, -0.75, -7.3, cockpitInterior);
  cockpitInterior.visible = false;

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
  };
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
    const z = -5.3 + i * 0.6;
    seats.push({ pos: new THREE.Vector3(-1.36, CABIN_FLOOR, z), heading: -Math.PI / 2 });
    seats.push({ pos: new THREE.Vector3(1.36, CABIN_FLOOR, z), heading: Math.PI / 2 });
  }
  // Litters on centreline stanchions, two tiers.
  const litters = [-3.7, -1.2].flatMap((z) => [new THREE.Vector3(0, CABIN_FLOOR + 0.42, z), new THREE.Vector3(0, CABIN_FLOOR + 1.15, z)]);
  // Pallets on the roller tracks, front to back.
  const pallets = [-4.6, -3.0, -1.4, 0.2, 1.8].map((z) => new THREE.Vector3(0, CABIN_FLOOR, z));
  return { seats, litters, pallets, hinge: new THREE.Vector3(0, CABIN_FLOOR, 6.85), floor: CABIN_FLOOR, crewChief: new THREE.Vector3(1.36, CABIN_FLOOR, 5.7), gunner: new THREE.Vector3(1.2, CABIN_FLOOR, -5.55) };
})();

type AddFn = (geo: THREE.BufferGeometry, mat: THREE.Material, x?: number, y?: number, z?: number, parent?: THREE.Object3D) => THREE.Mesh;

function buildCabinInterior(add: AddFn, exterior: THREE.Group, liner: THREE.Material, dark: THREE.Material, olive: THREE.Material) {
  const g = new THREE.Group();
  exterior.add(g);
  const F = CABIN_FLOOR;
  const quilt = new THREE.MeshStandardMaterial({ color: 0x6b705c, roughness: 0.95 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3d3f38, roughness: 0.85, metalness: 0.2 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d86, roughness: 0.5, metalness: 0.6 });
  const webbing = new THREE.MeshStandardMaterial({ color: 0x8a3428, roughness: 0.9 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xffeccc });
  const redLamp = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
  const glassIn = new THREE.MeshBasicMaterial({ color: 0x7d8f98 });

  const z0 = -5.95;
  const z1 = 6.95;
  const len = z1 - z0;
  const zc = (z0 + z1) / 2;
  // Floor, wall lining and ceiling.
  add(new THREE.BoxGeometry(3.36, 0.06, len), floorMat, 0, F - 0.03, zc, g);
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, 2.6, len), quilt, sx * 1.66, F + 1.45, zc, g);
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
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 2.7, 0.08), liner, sx * 1.62, F + 1.42, z, g);
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
  // Windows (light coming in).
  for (const sx of [-1, 1])
    for (let z = z0 + 1.0; z < z1 - 1.5; z += 1.6) add(new THREE.CircleGeometry(0.16, 12).rotateY(-sx * Math.PI / 2), glassIn, sx * 1.632, F + 1.75, z, g);
  // Troop seats: red webbing on tube frames, folded up between occupied rows.
  for (const s of CABIN.seats) {
    const sx = Math.sign(s.pos.x);
    add(new THREE.BoxGeometry(0.44, 0.04, 0.5), webbing, sx * 1.4, F + 0.44, s.pos.z, g);
    add(new THREE.BoxGeometry(0.04, 0.55, 0.5), webbing, sx * 1.62, F + 0.78, s.pos.z, g);
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 5), metal, sx * 1.18, F + 0.22, s.pos.z - 0.24, g);
  }
  // Seat rails along the walls.
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.022, 0.022, 9.2, 6).rotateX(Math.PI / 2), metal, sx * 1.19, F + 0.45, -0.95, g);
    add(new THREE.CylinderGeometry(0.022, 0.022, 9.2, 6).rotateX(Math.PI / 2), metal, sx * 1.6, F + 1.08, -0.95, g);
  }
  // Bulkhead to the cockpit with a doorway.
  add(new THREE.BoxGeometry(1.25, 3.0, 0.08), liner, -1.07, F + 1.5, z0, g);
  add(new THREE.BoxGeometry(1.25, 3.0, 0.08), liner, 1.07, F + 1.5, z0, g);
  add(new THREE.BoxGeometry(0.9, 0.9, 0.08), liner, 0, F + 2.6, z0, g);
  // Crew chief's jump seat by the ramp and the door-gun mount up front.
  add(new THREE.BoxGeometry(0.44, 0.05, 0.44), webbing, 1.4, F + 0.44, CABIN.crewChief.z, g);
  add(new THREE.BoxGeometry(0.05, 0.6, 0.44), webbing, 1.62, F + 0.8, CABIN.crewChief.z, g);
  add(new THREE.BoxGeometry(0.4, 0.05, 0.4), webbing, 1.25, F + 0.5, CABIN.gunner.z, g);
  add(new THREE.CylinderGeometry(0.04, 0.05, 1.1, 6), metal, 1.5, F + 0.95, CABIN.gunner.z - 0.4, g);
  // M240 on its pintle, poking out of the window.
  const gun = new THREE.Group();
  gun.position.set(1.55, F + 1.5, CABIN.gunner.z - 0.4);
  gun.rotation.y = -Math.PI / 2 + 0.25;
  g.add(gun);
  add(new THREE.BoxGeometry(0.1, 0.14, 0.75), dark, 0, 0, 0, gun);
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6).rotateX(Math.PI / 2), dark, 0, 0.02, -0.7, gun);
  add(new THREE.BoxGeometry(0.16, 0.14, 0.18), olive, -0.1, -0.06, 0.05, gun);
  // Fuel and fire extinguisher bottles on the forward bulkhead.
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), redLamp, -1.3, F + 0.9, z0 + 0.15, g);
  // Cabin light.
  const light = new THREE.PointLight(0xfff0d8, 0, 14, 1.6);
  light.position.set(0, 1.3, 1.5);
  g.add(light);
  return { group: g, light };
}
