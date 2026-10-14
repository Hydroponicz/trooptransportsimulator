import * as THREE from 'three';
import type { Side } from './campaign';

export type VehicleKind = 'tank' | 'apc';

const PAINT: Record<Side, { hull: number; dark: number }> = {
  blue: { hull: 0x56603e, dark: 0x3c4330 },
  red: { hull: 0x8f8466, dark: 0x5d5642 },
};

function slopedBox(w: number, h: number, d: number, frontSlope: number, topTaper: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const z = p.getZ(i);
    if (y > 0) {
      p.setX(i, p.getX(i) * (1 - topTaper));
      if (z < 0) p.setZ(i, z + frontSlope);
    }
  }
  g.computeVertexNormals();
  return g;
}

export interface VehicleParts {
  root: THREE.Group;
  turret: THREE.Group;
  muzzle: THREE.Object3D;
  materials: THREE.MeshLambertMaterial[];
}

/** Models face −Z, origin on the ground. */
export function buildVehicle(kind: VehicleKind, side: Side): VehicleParts {
  const hull = new THREE.MeshLambertMaterial({ color: PAINT[side].hull });
  const dark = new THREE.MeshLambertMaterial({ color: PAINT[side].dark });
  const track = new THREE.MeshLambertMaterial({ color: 0x232320 });
  const root = new THREE.Group();
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const turret = new THREE.Group();
  const muzzle = new THREE.Object3D();
  if (kind === 'tank') {
    add(slopedBox(3.5, 1.0, 7.2, 1.2, 0.05), hull, 0, 1.25, 0);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.75, 0.95, 7.0), track, sx * 1.65, 0.5, 0);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.8, 0.12, 7.1), dark, sx * 1.65, 1.02, 0);
    turret.position.set(0, 1.75, 0.5);
    root.add(turret);
    add(slopedBox(2.5, 0.75, 3.2, 0.8, 0.15), hull, 0, 0.35, 0, turret);
    add(new THREE.CylinderGeometry(0.12, 0.15, 4.6, 8).rotateX(Math.PI / 2), dark, 0, 0.4, -3.6, turret);
    add(new THREE.BoxGeometry(0.6, 0.3, 0.6), dark, 0.6, 0.85, 0.4, turret);
    muzzle.position.set(0, 0.4, -5.95);
  } else {
    add(slopedBox(2.9, 1.7, 6.6, 1.6, 0.12), hull, 0, 1.45, 0);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.55, 0.8, 6.2), track, sx * 1.35, 0.45, 0);
    add(new THREE.BoxGeometry(1.6, 1.0, 0.08), dark, 0, 1.3, 3.32);
    turret.position.set(0, 2.35, -0.3);
    root.add(turret);
    add(new THREE.CylinderGeometry(0.55, 0.65, 0.5, 10), hull, 0, 0.15, 0, turret);
    add(new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6).rotateX(Math.PI / 2), dark, 0, 0.2, -1.2, turret);
    muzzle.position.set(0, 0.2, -2.1);
  }
  turret.add(muzzle);
  return { root, turret, muzzle, materials: [hull, dark] };
}

export class Vehicle {
  parts: VehicleParts;
  pos = new THREE.Vector3();
  heading = 0;
  turretYaw = 0;
  hp: number;
  dead = false;
  deadT = 0;
  goal: THREE.Vector3 | null = null;
  speed: number;
  fireCd = 0;
  acquireT = 0;
  target: unknown = null;
  /** APC passengers waiting to dismount. */
  carrying = 0;
  task: 'patrol' | 'ferry' | 'return' | 'support' = 'patrol';
  pause = 0;

  constructor(
    readonly id: number,
    readonly kind: VehicleKind,
    readonly side: Side,
    readonly sector: number,
  ) {
    this.parts = buildVehicle(kind, side);
    this.hp = kind === 'tank' ? 3 : 2;
    this.speed = kind === 'tank' ? 5.5 : 8;
  }

  get root() {
    return this.parts.root;
  }

  muzzleWorld(out: THREE.Vector3) {
    return this.parts.muzzle.getWorldPosition(out);
  }

  wreck() {
    this.dead = true;
    for (const m of this.parts.materials) m.color.multiplyScalar(0.3);
    this.parts.turret.rotation.z = 0.25;
    this.parts.turret.position.y += 0.15;
  }
}
