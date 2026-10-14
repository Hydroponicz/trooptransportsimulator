import * as THREE from 'three';
import type { Terrain } from '../world/terrain';
import type { RNG } from '../util/noise';
import type { Side } from './campaign';

const sandbagGeo = new THREE.BoxGeometry(1.9, 0.55, 0.75).translate(0, 0.27, 0);
const sandbagMat: Record<Side, THREE.MeshLambertMaterial> = {
  blue: new THREE.MeshLambertMaterial({ color: 0x958763 }),
  red: new THREE.MeshLambertMaterial({ color: 0x8a7d62 }),
};
const trenchMat = new THREE.MeshLambertMaterial({
  color: 0x3a3226,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const hedgehogGeo = (() => {
  const g: THREE.BufferGeometry[] = [];
  const beam = () => new THREE.BoxGeometry(0.18, 0.18, 2.4);
  const a = beam().rotateX(Math.PI / 4);
  const b = beam().rotateY(Math.PI / 2).rotateZ(Math.PI / 4);
  const c = beam().rotateX(-Math.PI / 4).rotateY(Math.PI / 2);
  g.push(a, b, c);
  // Manual merge (all non-indexed-compatible boxes).
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const x of g) {
    const ni = x.toNonIndexed();
    pos.push(...(ni.getAttribute('position').array as Float32Array));
    nrm.push(...(ni.getAttribute('normal').array as Float32Array));
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.translate(0, 0.85, 0);
  return out;
})();
const hedgehogMat = new THREE.MeshLambertMaterial({ color: 0x3a3a36 });
const postGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.1, 4).translate(0, 0.55, 0);
const wireMat = new THREE.LineBasicMaterial({ color: 0x2b2b28 });

/** One side's trench line in a sector. Grows as engineers dig. */
export class TrenchLine {
  group = new THREE.Group();
  /** Centerline points ordered along the line. */
  points: THREE.Vector3[] = [];
  /** Which way the enemy is (unit, horizontal). */
  facing = new THREE.Vector3();
  private ribbon: THREE.Mesh;
  private bags: THREE.InstancedMesh;
  private bagCount: number;
  private bagMats: THREE.Matrix4[] = [];
  progress = 0;

  constructor(
    terrain: Terrain,
    readonly side: Side,
    centerline: (t: number) => THREE.Vector2,
    length: number,
    progress: number,
    rng: RNG,
  ) {
    const n = Math.max(2, Math.round(length / 4));
    const W = 2.4;
    const pos = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    this.facing.set(side === 'blue' ? 1 : -1, 0, 0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const c = centerline(t);
      const y = terrain.heightAt(c.x, c.y);
      this.points.push(new THREE.Vector3(c.x, y, c.y));
      const nx = i === 0 ? centerline(1 / (n - 1)) : c;
      const pv = i === 0 ? c : centerline((i - 1) / (n - 1));
      let dx = nx.x - pv.x;
      let dz = nx.y - pv.y;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      for (let s = 0; s < 2; s++) {
        const o = (s ? 1 : -1) * W * 0.5;
        const x = c.x - dz * o;
        const z = c.y + dx * o;
        const j = (i * 2 + s) * 3;
        pos[j] = x;
        pos[j + 1] = terrain.heightAt(x, z) + 0.06;
        pos[j + 2] = z;
      }
      if (i > 0) {
        const a = (i - 1) * 2;
        const b = i * 2;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    if ((geo.getAttribute('normal') as THREE.BufferAttribute).getY(0) < 0) {
      geo.setIndex(idx.map((_, k) => idx[k - (k % 3) + (2 - (k % 3))]));
      geo.computeVertexNormals();
    }
    this.ribbon = new THREE.Mesh(geo, trenchMat);
    this.ribbon.receiveShadow = true;
    this.group.add(this.ribbon);

    // Parapet sandbags on the enemy-facing lip.
    this.bagCount = n;
    this.bags = new THREE.InstancedMesh(sandbagGeo, sandbagMat[side], n);
    this.bags.castShadow = true;
    this.bags.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const nxt = this.points[Math.min(n - 1, i + 1)];
      const prv = this.points[Math.max(0, i - 1)];
      const ang = Math.atan2(-(nxt.z - prv.z), nxt.x - prv.x);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang + Math.PI / 2);
      const x = p.x + this.facing.x * 1.6;
      const z = p.z + this.facing.z * 1.6;
      m.compose(new THREE.Vector3(x, terrain.heightAt(x, z) - 0.05, z), q, new THREE.Vector3(2.25, rng.range(1.0, 1.3), 1.15));
      this.bagMats.push(m.clone());
    }
    this.bags.frustumCulled = false;
    this.group.add(this.bags);

    // Wire obstacle out in front.
    const wire: number[] = [];
    const postM: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i += 3) {
      const p = this.points[i];
      const x = p.x + this.facing.x * 22;
      const z = p.z + this.facing.z * 22;
      const y = terrain.heightAt(x, z);
      postM.push(new THREE.Matrix4().makeTranslation(x, y, z));
      if (i >= 3) {
        const pp = this.points[i - 3];
        const px = pp.x + this.facing.x * 22;
        const pz = pp.z + this.facing.z * 22;
        const py = terrain.heightAt(px, pz);
        wire.push(px, py + 0.9, pz, x, y + 0.9, z, px, py + 0.45, pz, x, y + 0.45, z);
      }
    }
    const posts = new THREE.InstancedMesh(postGeo, hedgehogMat, postM.length);
    postM.forEach((pm, i) => posts.setMatrixAt(i, pm));
    posts.computeBoundingSphere();
    this.group.add(posts);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    this.group.add(new THREE.LineSegments(wg, wireMat));
    this.setProgress(progress);
  }

  /** 0..1 — how much of the line has been dug and sandbagged. */
  setProgress(p: number) {
    this.progress = Math.max(0.05, Math.min(1, p));
    const n = this.points.length;
    const built = Math.max(2, Math.round(n * this.progress));
    // Dig outward from the middle of the line.
    const start = Math.floor((n - built) / 2);
    this.ribbon.geometry.setDrawRange(start * 6, (built - 1) * 6);
    const count = Math.min(this.bagCount, built);
    for (let i = 0; i < count; i++) this.bags.setMatrixAt(i, this.bagMats[start + i]);
    this.bags.count = count;
    this.bags.instanceMatrix.needsUpdate = true;
  }

  /** Points currently inside the dug part. */
  builtRange(): [number, number] {
    const n = this.points.length;
    const built = Math.max(2, Math.round(n * this.progress));
    const start = Math.floor((n - built) / 2);
    return [start, start + built - 1];
  }

  /** Where engineers work: the two ends of the dug section. */
  digFronts(): THREE.Vector3[] {
    const [a, b] = this.builtRange();
    return [this.points[a], this.points[b]];
  }

  dispose() {
    this.ribbon.geometry.dispose();
    this.group.clear();
  }
}

/** Tank traps scattered in no-man's land. */
export function hedgehogs(terrain: Terrain, at: (t: number, off: number) => THREE.Vector2, rng: RNG, n: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(hedgehogGeo, hedgehogMat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const p = at(rng.next(), rng.range(-45, 45));
    m.compose(
      new THREE.Vector3(p.x, terrain.heightAt(p.x, p.y), p.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI)),
      new THREE.Vector3(1, 1, 1),
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.castShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}
