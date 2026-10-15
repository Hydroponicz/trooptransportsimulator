import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Replace a container's static single-material meshes with one merged mesh per
 * material (and shadow setting). Subtrees in `keep` are left alone (they move).
 */
export function mergeStatic(container: THREE.Object3D, keep: Set<THREE.Object3D>) {
  container.updateMatrixWorld(true);
  const inv = container.matrixWorld.clone().invert();
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const visit = (o: THREE.Object3D) => {
    if (keep.has(o)) return;
    for (const c of o.children) visit(c);
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || (m.material as THREE.MeshBasicMaterial).map) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.clearGroups();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const key = `${m.material.uuid}:${m.castShadow}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: m.material, cast: m.castShadow, geos: [], meshes: [] }));
    b.geos.push(g);
    b.meshes.push(m);
  };
  visit(container);
  for (const b of buckets.values()) {
    if (b.meshes.length < 2) continue;
    for (const m of b.meshes) m.parent?.remove(m);
    const merged = new THREE.Mesh(mergeGeometries(b.geos, false)!, b.mat);
    merged.castShadow = b.cast;
    merged.receiveShadow = true;
    container.add(merged);
  }
}

