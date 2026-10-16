import * as THREE from 'three';

interface Entry {
  obj: THREE.Object3D;
  x: number;
  z: number;
  /** Visible while the camera is within this (horizontal) distance of the chunk's nearest point. */
  near: number;
  far: number;
  r: number;
  /** Which quality scale (if any) applies to each bound. */
  nearK?: ScaleKind;
  farK?: ScaleKind;
}

/** Distances the graphics setting can shorten: tree/building swaps to far stand-ins, small props, and the far edge of buildings, forests and roadside. */
export type ScaleKind = 'lod' | 'clutter' | 'far';

/**
 * Hides world chunks that are too far from the camera to matter (beyond the
 * fog, or small clutter beyond a few kilometres). Frustum culling alone would
 * still draw everything ahead out to the far plane.
 */
export class DistanceCuller {
  private entries = new Map<THREE.Object3D, Entry>();
  private frame = 0;
  /** Multipliers on the tagged distances, set from the graphics quality. */
  scales: Record<ScaleKind, number> = { lod: 1, clutter: 1, far: 1 };

  /** Show `obj` when the camera is between `near` and `far` metres from its bounds. */
  add(obj: THREE.Object3D, center: THREE.Vector3, radius: number, far: number, near = 0, farK?: ScaleKind, nearK?: ScaleKind) {
    this.entries.set(obj, { obj, x: center.x, z: center.z, r: radius, near, far, nearK, farK });
  }

  /** Stop managing an object (it's being taken out of the world). */
  remove(obj: THREE.Object3D) {
    this.entries.delete(obj);
  }

  /** Register a mesh by its own bounding sphere. */
  addMesh(mesh: THREE.Mesh | THREE.LineSegments | THREE.InstancedMesh, far: number, near = 0, farK?: ScaleKind, nearK?: ScaleKind) {
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    let s = g.boundingSphere!;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const im = mesh as THREE.InstancedMesh;
      if (!im.boundingSphere) im.computeBoundingSphere();
      s = im.boundingSphere!;
    }
    this.add(mesh, s.center, s.radius, far, near, farK, nearK);
  }

  update(cam: THREE.Vector3, force = false) {
    // A few times a second is plenty for kilometre-scale rings.
    if (!force && this.frame++ % 6) return;
    const sc = this.scales;
    for (const e of this.entries.values()) {
      const d = Math.max(0, Math.hypot(cam.x - e.x, cam.z - e.z) - e.r);
      const far = e.farK ? e.far * sc[e.farK] : e.far;
      const near = e.nearK ? e.near * sc[e.nearK] : e.near;
      e.obj.visible = d <= far && d >= near;
    }
  }
}

/** Cell index → bucket key. */
const key = (x: number, z: number, cell: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;

/**
 * Split a world-spanning merged mesh (or line set) into per-cell pieces so
 * each can be frustum- and distance-culled. Triangles/segments go to the cell
 * holding their first vertex. Returns the pieces (same material).
 */
export function splitByCells(obj: THREE.Mesh | THREE.LineSegments, cell: number): (THREE.Mesh | THREE.LineSegments)[] {
  const src = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry;
  const per = (obj as THREE.LineSegments).isLineSegments ? 2 : 3;
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const names = Object.keys(src.attributes);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i += per) {
    const k = key(pos.getX(i), pos.getZ(i), cell);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(i);
  }
  const out: (THREE.Mesh | THREE.LineSegments)[] = [];
  for (const starts of buckets.values()) {
    const g = new THREE.BufferGeometry();
    for (const n of names) {
      const a = src.getAttribute(n) as THREE.BufferAttribute;
      const arr = new Float32Array(starts.length * per * a.itemSize);
      let o = 0;
      for (const s of starts)
        for (let v = 0; v < per; v++) for (let c = 0; c < a.itemSize; c++) arr[o++] = a.array[(s + v) * a.itemSize + c];
      g.setAttribute(n, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    g.computeBoundingSphere();
    const piece = (obj as THREE.LineSegments).isLineSegments ? new THREE.LineSegments(g, obj.material) : new THREE.Mesh(g, obj.material);
    piece.castShadow = obj.castShadow;
    piece.receiveShadow = obj.receiveShadow;
    piece.renderOrder = obj.renderOrder;
    out.push(piece);
  }
  return out;
}
