import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ColliderSet } from './colliders';

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
  | 'wreck';

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
};

interface Batch {
  geo: THREE.BufferGeometry;
  mats: THREE.Matrix4[];
  colors: (THREE.Color | null)[];
}

/** Collects structure placements and emits one InstancedMesh per prototype. */
export class Props {
  private batches = new Map<ProtoName, Batch>();
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private tmpBox = new THREE.Box3();

  constructor(private colliders: ColliderSet) {}

  add(name: ProtoName, x: number, y: number, z: number, rotY = 0, scale = 1, color?: number) {
    let b = this.batches.get(name);
    if (!b) {
      b = { geo: buildProto(name), mats: [], colors: [] };
      this.batches.set(name, b);
    }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
      new THREE.Vector3(scale, scale, scale),
    );
    b.mats.push(m);
    b.colors.push(color !== undefined ? new THREE.Color(color) : null);
    if (COLLIDE[name]) {
      this.tmpBox.copy(b.geo.boundingBox!).applyMatrix4(m);
      const bb = this.tmpBox;
      this.colliders.add({ minX: bb.min.x, minY: bb.min.y, minZ: bb.min.z, maxX: bb.max.x, maxY: bb.max.y, maxZ: bb.max.z });
    }
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
