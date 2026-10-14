import * as THREE from 'three';
import { merge, part } from '../world/props';

/** An AI vehicle model: a body plus separately animated wheels. Faces −Z. */
export interface VehicleModel {
  group: THREE.Group;
  /** Sprung body (pitches and rolls on its suspension). */
  body: THREE.Object3D;
  wheels: { pivot: THREE.Object3D; spin: THREE.Object3D; front: boolean; r: number }[];
  length: number;
  width: number;
  height: number;
  wheelbase: number;
}

export type VehicleKind = 'cargo' | 'tanker' | 'hmmwv' | 'mrap';

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);

const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const tireMat = new THREE.MeshLambertMaterial({ color: 0x1a1a18 });
const hubMat = new THREE.MeshLambertMaterial({ color: 0x4a4d3a });
const geoCache = new Map<string, THREE.BufferGeometry>();

function wheelGeo(r: number, w: number) {
  const k = `t${r}:${w}`;
  if (!geoCache.has(k)) {
    geoCache.set(k, cyl(r, r, w, 16).rotateZ(Math.PI / 2));
    geoCache.set(`h${r}:${w}`, cyl(r * 0.5, r * 0.5, w + 0.04, 8).rotateZ(Math.PI / 2));
  }
  return { tire: geoCache.get(k)!, hub: geoCache.get(`h${r}:${w}`)! };
}

function assemble(
  bodyParts: THREE.BufferGeometry[],
  axles: { z: number; front: boolean; dual?: boolean }[],
  track: number,
  r: number,
  dims: { length: number; width: number; height: number },
): VehicleModel {
  const group = new THREE.Group();
  const body = new THREE.Mesh(merge(bodyParts), bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const wheels: VehicleModel['wheels'] = [];
  const { tire, hub } = wheelGeo(r, 0.42);
  for (const a of axles)
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set((sx * track) / 2, r, a.z);
      const spin = new THREE.Group();
      pivot.add(spin);
      const t = new THREE.Mesh(tire, tireMat);
      t.castShadow = true;
      spin.add(t, new THREE.Mesh(hub, hubMat));
      group.add(pivot);
      wheels.push({ pivot, spin, front: a.front, r });
    }
  const zs = axles.map((a) => a.z);
  return { group, body, wheels, ...dims, wheelbase: Math.max(...zs) - Math.min(...zs) || 3 };
}

const OLIVE = 0x4d5434;
const OLIVE2 = 0x5b5f40;
const TAN = 0x8a7d5a;
const DARK = 0x22262a;
const GLASS = 0x2a3a44;
const LAMP = 0xfff2c4;
const RED = 0x8c2a22;

function lights(z: number, y: number, x: number): THREE.BufferGeometry[] {
  return [part(box(0.28, 0.18, 0.06), LAMP, -x, y, z), part(box(0.28, 0.18, 0.06), LAMP, x, y, z)];
}
function tailLights(z: number, y: number, x: number): THREE.BufferGeometry[] {
  return [part(box(0.2, 0.14, 0.05), RED, -x, y, z), part(box(0.2, 0.14, 0.05), RED, x, y, z)];
}

/** 5-ton 6×6 cargo truck with a canvas-covered bed. */
function cargo(): VehicleModel {
  const r = 0.55;
  const p: THREE.BufferGeometry[] = [
    // Chassis rails and bumper.
    part(box(1.2, 0.3, 7.6), DARK, 0, r + 0.25, 0.2),
    part(box(2.4, 0.3, 0.2), DARK, 0, r + 0.2, -3.75),
    // Bonnet and grille.
    part(box(1.9, 0.8, 1.4), OLIVE, 0, r + 0.85, -3.0),
    part(box(1.6, 0.6, 0.05), DARK, 0, r + 0.85, -3.72),
    // Fenders.
    part(box(0.45, 0.12, 1.3), OLIVE, -1.05, r + 0.6, -2.95),
    part(box(0.45, 0.12, 1.3), OLIVE, 1.05, r + 0.6, -2.95),
    // Cab with windscreen and side windows.
    part(box(2.3, 1.45, 1.6), OLIVE, 0, r + 1.3, -1.6),
    part(box(2.0, 0.6, 0.05), GLASS, 0, r + 1.65, -2.42),
    part(box(0.05, 0.5, 0.8), GLASS, -1.16, r + 1.65, -1.6),
    part(box(0.05, 0.5, 0.8), GLASS, 1.16, r + 1.65, -1.6),
    part(box(2.35, 0.08, 1.65), OLIVE2, 0, r + 2.06, -1.6),
    // Bed with canvas cover on hoops.
    part(box(2.4, 0.5, 4.6), OLIVE, 0, r + 0.75, 1.3),
    part(box(2.42, 1.6, 4.5), TAN, 0, r + 1.8, 1.3),
    part(box(2.0, 0.25, 4.4), TAN, 0, r + 2.7, 1.3),
    // Exhaust stack and spare.
    part(cyl(0.07, 0.07, 1.6, 6), DARK, 1.05, r + 1.9, -2.3),
    part(cyl(0.5, 0.5, 0.35, 12).rotateX(Math.PI / 2), DARK, 0, r + 1.0, -0.65),
    ...lights(-3.74, r + 0.95, 0.75),
    ...tailLights(3.6, r + 0.6, 1.0),
  ];
  return assemble(p, [{ z: -2.9, front: true }, { z: 1.3, front: false }, { z: 2.7, front: false }], 2.0, r, { length: 7.8, width: 2.5, height: 3.4 });
}

/** Fuel tanker on the same 6×6 chassis. */
function tanker(): VehicleModel {
  const r = 0.55;
  const p: THREE.BufferGeometry[] = [
    part(box(1.2, 0.3, 7.6), DARK, 0, r + 0.25, 0.2),
    part(box(2.4, 0.3, 0.2), DARK, 0, r + 0.2, -3.75),
    part(box(1.9, 0.8, 1.4), OLIVE, 0, r + 0.85, -3.0),
    part(box(1.6, 0.6, 0.05), DARK, 0, r + 0.85, -3.72),
    part(box(2.3, 1.45, 1.6), OLIVE, 0, r + 1.3, -1.6),
    part(box(2.0, 0.6, 0.05), GLASS, 0, r + 1.65, -2.42),
    part(box(0.05, 0.5, 0.8), GLASS, -1.16, r + 1.65, -1.6),
    part(box(0.05, 0.5, 0.8), GLASS, 1.16, r + 1.65, -1.6),
    // Tank: an elliptical cylinder with end caps and a walkway.
    part(cyl(1.0, 1.0, 4.4, 18).rotateX(Math.PI / 2), 0x5f6346, 0, r + 1.55, 1.35, 0, 0, 0, 1.15, 0.95, 1),
    part(box(0.6, 0.06, 4.0), DARK, 0, r + 2.55, 1.35),
    part(box(2.2, 0.25, 4.6), DARK, 0, r + 0.6, 1.35),
    part(box(0.5, 0.35, 0.5), DARK, 0, r + 0.75, 3.55),
    ...lights(-3.74, r + 0.95, 0.75),
    ...tailLights(3.6, r + 0.6, 1.0),
  ];
  return assemble(p, [{ z: -2.9, front: true }, { z: 1.3, front: false }, { z: 2.7, front: false }], 2.0, r, { length: 7.8, width: 2.5, height: 3.0 });
}

/** HMMWV with a ring-mounted gun. */
function hmmwv(): VehicleModel {
  const r = 0.45;
  const c = 0x6b6440;
  const p: THREE.BufferGeometry[] = [
    part(box(2.2, 0.8, 4.6), c, 0, r + 0.45, 0),
    part(box(2.1, 0.3, 1.5), c, 0, r + 0.95, -1.5),
    part(box(2.0, 0.8, 2.2), c, 0, r + 1.25, 0.3),
    part(box(1.85, 0.45, 0.05), GLASS, 0, r + 1.35, -0.82),
    part(box(0.05, 0.4, 1.6), GLASS, -1.01, r + 1.35, 0.3),
    part(box(0.05, 0.4, 1.6), GLASS, 1.01, r + 1.35, 0.3),
    part(box(2.0, 0.55, 1.2), TAN, 0, r + 1.1, 1.8),
    part(cyl(0.5, 0.55, 0.25, 12), DARK, 0, r + 1.78, 0.35),
    part(box(0.8, 0.45, 0.05), DARK, 0, r + 2.05, 0.0),
    part(cyl(0.04, 0.04, 1.0, 5).rotateX(Math.PI / 2), DARK, 0, r + 2.05, -0.45),
    part(box(1.9, 0.3, 0.15), DARK, 0, r + 0.25, -2.35),
    ...lights(-2.33, r + 0.75, 0.75),
    ...tailLights(2.31, r + 0.7, 0.85),
  ];
  return assemble(p, [{ z: -1.55, front: true }, { z: 1.5, front: false }], 1.9, r, { length: 4.8, width: 2.2, height: 2.6 });
}

/** MRAP with its V-hull and big armoured cab. */
function mrap(): VehicleModel {
  const r = 0.6;
  const c = 0x7a6f52;
  const p: THREE.BufferGeometry[] = [
    // V-hull underside.
    part(box(1.4, 0.5, 5.6), DARK, 0, r + 0.15, 0, 0, 0, 0, 1, 1, 1),
    part(box(2.4, 1.6, 4.4), c, 0, r + 1.35, 0.5),
    part(box(2.3, 0.9, 1.4), c, 0, r + 0.95, -2.3),
    part(box(2.2, 0.55, 0.06), GLASS, 0, r + 1.75, -1.72),
    part(box(0.06, 0.5, 0.9), GLASS, -1.21, r + 1.7, -1.1),
    part(box(0.06, 0.5, 0.9), GLASS, 1.21, r + 1.7, -1.1),
    part(box(2.45, 0.1, 4.45), 0x6a604a, 0, r + 2.2, 0.5),
    part(cyl(0.55, 0.6, 0.35, 12), DARK, 0, r + 2.42, 0.3),
    part(box(0.9, 0.5, 0.06), DARK, 0, r + 2.75, 0.0),
    part(box(2.0, 0.35, 0.2), DARK, 0, r + 0.45, -3.05),
    // Rear door and side steps.
    part(box(1.0, 1.3, 0.06), 0x6a604a, 0, r + 1.35, 2.73),
    part(box(0.25, 0.08, 0.8), DARK, -1.3, r + 0.35, -0.6),
    part(box(0.25, 0.08, 0.8), DARK, 1.3, r + 0.35, -0.6),
    ...lights(-3.0, r + 1.0, 0.85),
    ...tailLights(2.72, r + 0.8, 1.0),
  ];
  return assemble(p, [{ z: -1.9, front: true }, { z: 1.8, front: false }], 2.1, r, { length: 6.2, width: 2.5, height: 3.4 });
}

export function buildVehicle(kind: VehicleKind): VehicleModel {
  switch (kind) {
    case 'cargo':
      return cargo();
    case 'tanker':
      return tanker();
    case 'hmmwv':
      return hmmwv();
    case 'mrap':
      return mrap();
  }
}
