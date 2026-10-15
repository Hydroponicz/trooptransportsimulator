import * as THREE from 'three';
import { merge, part } from '../world/props';

/** An AI vehicle model: a body plus separately animated wheels. Faces −Z. */
export interface VehicleModel {
  group: THREE.Group;
  /** Sprung body (pitches and rolls on its suspension). */
  body: THREE.Object3D;
  wheels: { pivot: THREE.Object3D; spin: THREE.Object3D; front: boolean; r: number }[];
  /** Body and wheels as one static mesh, for when the vehicle is far away. */
  far: THREE.Mesh;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
}

export type VehicleKind = 'cargo' | 'tanker' | 'hmmwv' | 'mrap' | CivKind | 'tractor' | 'combine';
/** Civilian traffic. */
export type CivKind = 'sedan' | 'hatch' | 'van' | 'bus' | 'lorry';

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
  axles: { z: number; front: boolean; dual?: boolean; r?: number; w?: number }[],
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
  for (const a of axles)
    for (const sx of [-1, 1]) {
      const ar = a.r ?? r;
      const { tire, hub } = wheelGeo(ar, a.w ?? 0.42);
      const pivot = new THREE.Group();
      pivot.position.set((sx * track) / 2, ar, a.z);
      const spin = new THREE.Group();
      pivot.add(spin);
      const t = new THREE.Mesh(tire, tireMat);
      t.castShadow = true;
      spin.add(t, new THREE.Mesh(hub, hubMat));
      group.add(pivot);
      wheels.push({ pivot, spin, front: a.front, r: ar });
    }
  const farParts = [...bodyParts];
  for (const a of axles)
    for (const sx of [-1, 1]) {
      const ar = a.r ?? r;
      const { tire, hub } = wheelGeo(ar, a.w ?? 0.42);
      farParts.push(part(tire, 0x1a1a18, (sx * track) / 2, ar, a.z));
      farParts.push(part(hub, 0x4a4d3a, (sx * track) / 2, ar, a.z));
    }
  const far = new THREE.Mesh(merge(farParts), bodyMat);
  far.castShadow = true;
  far.visible = false;
  group.add(far);
  const zs = axles.map((a) => a.z);
  return { group, body, wheels, far, ...dims, wheelbase: Math.max(...zs) - Math.min(...zs) || 3 };
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

const CHROME = 0x9a9c9e;
const BLACK = 0x1e1f20;

/** Family saloon (the boxy kind that still fills these roads). */
function sedan(c: number): VehicleModel {
  const r = 0.31;
  const p: THREE.BufferGeometry[] = [
    part(box(1.66, 0.62, 4.2), c, 0, r + 0.32, 0),
    part(box(1.5, 0.56, 2.1), c, 0, r + 0.9, 0.15),
    part(box(1.44, 0.46, 0.05), GLASS, 0, r + 0.92, -0.9, -0.5, 0, 0),
    part(box(1.44, 0.44, 0.05), GLASS, 0, r + 0.92, 1.2, 0.5, 0, 0),
    part(box(0.05, 0.42, 1.8), GLASS, -0.76, r + 0.92, 0.15),
    part(box(0.05, 0.42, 1.8), GLASS, 0.76, r + 0.92, 0.15),
    part(box(1.7, 0.16, 0.12), CHROME, 0, r + 0.2, -2.1),
    part(box(1.7, 0.16, 0.12), CHROME, 0, r + 0.2, 2.1),
    part(box(1.3, 0.2, 0.05), BLACK, 0, r + 0.42, -2.1),
    ...lights(-2.11, r + 0.42, 0.62),
    ...tailLights(2.11, r + 0.45, 0.66),
  ];
  return assemble(p, [{ z: -1.3, front: true }, { z: 1.3, front: false }], 1.42, r, { length: 4.25, width: 1.7, height: 1.5 });
}

/** Small hatchback. */
function hatch(c: number): VehicleModel {
  const r = 0.29;
  const p: THREE.BufferGeometry[] = [
    part(box(1.6, 0.6, 3.7), c, 0, r + 0.3, 0),
    part(box(1.48, 0.58, 2.1), c, 0, r + 0.88, 0.45),
    part(box(1.4, 0.46, 0.05), GLASS, 0, r + 0.9, -0.62, -0.55, 0, 0),
    part(box(1.4, 0.48, 0.05), GLASS, 0, r + 0.9, 1.5, 0.2, 0, 0),
    part(box(0.05, 0.42, 1.8), GLASS, -0.75, r + 0.9, 0.45),
    part(box(0.05, 0.42, 1.8), GLASS, 0.75, r + 0.9, 0.45),
    part(box(1.64, 0.16, 0.1), BLACK, 0, r + 0.18, -1.86),
    part(box(1.64, 0.16, 0.1), BLACK, 0, r + 0.18, 1.86),
    ...lights(-1.86, r + 0.42, 0.58),
    ...tailLights(1.86, r + 0.5, 0.64),
  ];
  return assemble(p, [{ z: -1.15, front: true }, { z: 1.2, front: false }], 1.38, r, { length: 3.75, width: 1.62, height: 1.48 });
}

/** Minibus / delivery van. */
function van(c: number): VehicleModel {
  const r = 0.36;
  const p: THREE.BufferGeometry[] = [
    part(box(1.95, 1.9, 4.9), c, 0, r + 1.15, 0.2),
    part(box(1.9, 0.75, 0.9), c, 0, r + 0.55, -2.55),
    part(box(1.8, 0.75, 0.05), GLASS, 0, r + 1.55, -2.2, -0.35, 0, 0),
    part(box(0.05, 0.6, 3.8), GLASS, -0.98, r + 1.55, 0.3),
    part(box(0.05, 0.6, 3.8), GLASS, 0.98, r + 1.55, 0.3),
    part(box(1.98, 0.18, 0.12), BLACK, 0, r + 0.2, -3.0),
    ...lights(-3.0, r + 0.6, 0.7),
    ...tailLights(2.66, r + 0.7, 0.85),
  ];
  return assemble(p, [{ z: -1.9, front: true }, { z: 1.6, front: false }], 1.7, r, { length: 5.4, width: 2.0, height: 2.5 });
}

/** Town bus. */
function bus(c: number): VehicleModel {
  const r = 0.5;
  const p: THREE.BufferGeometry[] = [
    part(box(2.5, 2.5, 10.5), c, 0, r + 1.45, 0),
    part(box(2.52, 0.9, 10.3), GLASS, 0, r + 1.95, 0.1),
    part(box(2.3, 1.1, 0.05), GLASS, 0, r + 1.8, -5.26),
    part(box(2.52, 0.4, 10.52), 0xf2f0ea, 0, r + 2.6, 0),
    part(box(2.52, 0.3, 10.52), 0x3a3a3a, 0, r + 0.3, 0),
    part(box(1.2, 2.0, 0.06), GLASS, 1.27, r + 1.2, -3.5, 0, Math.PI / 2, 0),
    ...lights(-5.26, r + 0.6, 0.85),
    ...tailLights(5.26, r + 0.7, 1.0),
  ];
  return assemble(p, [{ z: -3.4, front: true }, { z: 3.0, front: false }], 2.0, r, { length: 10.6, width: 2.55, height: 3.5 });
}

/** Civilian two-axle lorry with a box body. */
function lorry(c: number): VehicleModel {
  const r = 0.5;
  const p: THREE.BufferGeometry[] = [
    part(box(1.2, 0.3, 6.6), DARK, 0, r + 0.25, 0.3),
    part(box(2.3, 1.6, 1.7), c, 0, r + 1.2, -2.6),
    part(box(2.1, 0.75, 0.05), GLASS, 0, r + 1.55, -3.46),
    part(box(2.42, 2.5, 4.6), 0xe8e6e0, 0, r + 1.75, 1.1),
    ...lights(-3.46, r + 0.6, 0.85),
    ...tailLights(3.42, r + 0.6, 1.0),
  ];
  return assemble(p, [{ z: -2.5, front: true }, { z: 2.2, front: false }], 1.95, r, { length: 7.0, width: 2.45, height: 3.4 });
}

/** Farm tractor: big rear wheels, small fronts, a cab, an exhaust. */
function tractor(c: number): VehicleModel {
  const p: THREE.BufferGeometry[] = [
    part(box(1.0, 0.9, 2.3), c, 0, 1.2, -0.6),
    part(box(1.1, 0.25, 1.6), c, 0, 0.85, 0.6),
    part(box(1.35, 1.35, 1.35), GLASS, 0, 2.2, 0.7),
    part(box(1.5, 0.12, 1.55), c, 0, 2.9, 0.7),
    part(box(1.3, 0.3, 1.3), DARK, 0, 1.5, 0.7),
    part(cyl(0.06, 0.06, 1.3, 5), DARK, 0.35, 2.4, -1.2),
    part(box(0.9, 0.3, 0.2), DARK, 0, 0.9, -1.85),
    ...lights(-1.76, 1.35, 0.35),
  ];
  for (const sx of [-1, 1]) p.push(part(box(0.55, 0.08, 1.4), c, sx * 1.0, 1.75, 0.8));
  return assemble(p, [{ z: -1.25, front: true, r: 0.48, w: 0.32 }, { z: 0.8, front: false, r: 0.85, w: 0.5 }], 1.95, 0.6, { length: 4.0, width: 2.4, height: 3.0 });
}

/** Combine harvester with its header and unloading auger. */
function combine(c: number): VehicleModel {
  const p: THREE.BufferGeometry[] = [
    part(box(3.0, 2.4, 6.5), c, 0, 2.2, 0.6),
    part(box(1.8, 1.5, 1.6), GLASS, 0, 3.9, -1.9),
    part(box(2.0, 0.12, 1.8), 0xf2f0ea, 0, 4.7, -1.9),
    part(box(2.6, 1.2, 2.6), c, 0, 4.0, 1.4),
    // Header: wide cutter bar and reel out front.
    part(box(6.4, 0.6, 1.6), c, 0, 0.7, -3.6),
    part(cyl(0.45, 0.45, 6.2, 10).rotateZ(Math.PI / 2), 0xd8b44a, 0, 1.35, -3.9),
    part(box(1.4, 1.0, 1.4), DARK, 0, 1.4, -2.6),
    // Unloading auger folded along the side.
    part(cyl(0.18, 0.18, 4.5, 8).rotateX(Math.PI / 2), c, 1.7, 4.3, 0.8),
  ];
  return assemble(p, [{ z: -1.5, front: false, r: 0.9, w: 0.6 }, { z: 2.6, front: true, r: 0.6, w: 0.4 }], 2.8, 0.8, { length: 9.0, width: 6.4, height: 4.9 });
}

export function buildVehicle(kind: VehicleKind, color?: number): VehicleModel {
  switch (kind) {
    case 'sedan':
      return sedan(color ?? 0xf2f2ee);
    case 'hatch':
      return hatch(color ?? 0x9a2a24);
    case 'van':
      return van(color ?? 0xf2f2ee);
    case 'bus':
      return bus(color ?? 0xd8a02a);
    case 'lorry':
      return lorry(color ?? 0x2a4a7a);
    case 'tractor':
      return tractor(color ?? 0xb8352c);
    case 'combine':
      return combine(color ?? 0x3f7a3a);
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
