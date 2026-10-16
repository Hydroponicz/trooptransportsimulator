import * as THREE from 'three';

const CELL = 64;
/**
 * The near copies draw nothing in the main pass (no colour, no depth); the
 * shadow pass uses its own depth material, so they still cast.
 */
const INVISIBLE = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

interface Source {
  geo: THREE.BufferGeometry;
  cells: Map<number, THREE.Matrix4[]>;
  proxy: THREE.InstancedMesh | null;
}

/**
 * Shadow casters near the camera only.
 *
 * Trees and buildings are drawn in instanced chunks a couple of kilometres
 * across, but the sun's shadow map only covers ~180 m round the player. Left
 * to itself, the shadow pass would draw every tree and building in any chunk
 * that touches that box, hundreds of thousands of triangles that land
 * outside the map. Instead the chunks don't cast, and this keeps small
 * instanced copies of just the casters within reach of the shadow box,
 * which draw nothing in the main pass, refreshed as the player moves.
 */
export class ShadowCasters {
  group = new THREE.Group();
  private sources: Source[] = [];
  private at = new THREE.Vector3(1e9, 0, 1e9);
  /** Casters within this distance of the shadow box centre are drawn into it. */
  radius = 170;

  /** Register instances of a geometry (world matrices) whose shadows should be drawn when near. */
  add(geo: THREE.BufferGeometry, matrices: THREE.Matrix4[]) {
    if (!matrices.length) return;
    let src = this.sources.find((s) => s.geo === geo);
    if (!src) this.sources.push((src = { geo, cells: new Map(), proxy: null }));
    for (const m of matrices) {
      const e = m.elements;
      const k = Math.floor(e[12] / CELL) * 100003 + Math.floor(e[14] / CELL);
      let arr = src.cells.get(k);
      if (!arr) src.cells.set(k, (arr = []));
      arr.push(m);
    }
  }

  /** Rebuild the near casters when the shadow box has moved far enough. */
  update(target: THREE.Vector3) {
    if (Math.hypot(target.x - this.at.x, target.z - this.at.z) < 24) return;
    this.at.copy(target);
    const R = this.radius;
    const r2 = R * R;
    const c0x = Math.floor((target.x - R) / CELL);
    const c1x = Math.floor((target.x + R) / CELL);
    const c0z = Math.floor((target.z - R) / CELL);
    const c1z = Math.floor((target.z + R) / CELL);
    for (const src of this.sources) {
      const near: THREE.Matrix4[] = [];
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cz = c0z; cz <= c1z; cz++) {
          const arr = src.cells.get(cx * 100003 + cz);
          if (!arr) continue;
          for (const m of arr) {
            const e = m.elements;
            const dx = e[12] - target.x;
            const dz = e[14] - target.z;
            if (dx * dx + dz * dz < r2) near.push(m);
          }
        }
      if (!near.length) {
        if (src.proxy) src.proxy.count = 0;
        continue;
      }
      if (!src.proxy || src.proxy.instanceMatrix.count < near.length) {
        if (src.proxy) {
          this.group.remove(src.proxy);
          src.proxy.dispose();
        }
        const p = new THREE.InstancedMesh(src.geo, INVISIBLE, Math.ceil(near.length * 1.5) + 8);
        p.castShadow = true;
        p.receiveShadow = false;
        p.frustumCulled = false;
        p.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(p);
        src.proxy = p;
      }
      near.forEach((m, i) => src.proxy!.setMatrixAt(i, m));
      src.proxy.count = near.length;
      src.proxy.instanceMatrix.needsUpdate = true;
    }
  }
}
