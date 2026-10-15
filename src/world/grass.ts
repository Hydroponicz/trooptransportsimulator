import * as THREE from 'three';
import type { Terrain } from './terrain';
import type { Roads } from './roads';
import type { ColliderSet } from './colliders';
import { WATER_LEVEL } from './terrain';

/** Grass is laid out in square cells around the camera. */
const CELL = 16;
/** Drawn out to this distance; tufts shrink into the ground over the last quarter. */
const RANGE = 120;
const PER_CELL = 70;
/** Hidden when the camera is this high above the ground. */
const MAX_AGL = 160;

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic hash of a cell, for repeatable placement. */
function rand(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tufts of grass and wildflowers around the camera: one instanced mesh,
 * refilled from cached cells as the camera moves. Each tuft takes its colour
 * from the land cover under it, sways in the wind, and is flattened and
 * whipped about by rotor downwash.
 */
export class Grass {
  mesh: THREE.InstancedMesh;
  private cells = new Map<string, { m: THREE.Matrix4[]; c: THREE.Color[] }>();
  private key = '';
  private uniforms = { time: { value: 0 }, wash: { value: new THREE.Vector4(0, -1e5, 0, 0) }, range: { value: RANGE } };
  private capacity: number;

  constructor(
    private terrain: Terrain,
    private roads: Roads,
    private colliders: ColliderSet,
  ) {
    const span = Math.ceil(RANGE / CELL) * 2 + 1;
    this.capacity = span * span * PER_CELL;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float time;\nuniform vec4 wash;\nuniform float range;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          {
            vec3 base = instanceMatrix[3].xyz;
            float h = position.y;
            // Shrink into the ground towards the edge of the range.
            float fade = smoothstep(range, range * 0.72, distance(base.xz, cameraPosition.xz));
            transformed.y *= fade;
            // Wind: a slow swell rolling across the field plus a quick flutter.
            float ph = dot(base.xz, vec2(0.11, 0.07));
            float sway = sin(time * 1.3 + ph) * 0.55 + sin(time * 3.7 + ph * 2.3) * 0.2;
            transformed.x += sway * 0.12 * h;
            transformed.z += sway * 0.05 * h;
            // Rotor downwash: blades blown flat away from under the aircraft, thrashing.
            vec2 dw = base.xz - wash.xz;
            float dd = length(dw);
            float push = wash.w * smoothstep(28.0, 3.0, dd) * smoothstep(40.0, 8.0, wash.y - base.y);
            vec2 dir = dw / max(dd, 0.5);
            float thrash = 0.75 + 0.25 * sin(time * 17.0 + dd * 1.7);
            // Into the tuft's own frame: it is only turned about Y and scaled, so a transpose over the scale squared undoes it.
            vec3 pushW = vec3(dir.x, 0.0, dir.y) * push * thrash * h * 1.1;
            mat3 im = mat3(instanceMatrix);
            transformed += transpose(im) * pushW / dot(im[0], im[0]);
            transformed.y *= 1.0 - 0.55 * push;
          }`,
        );
      // Both faces of a blade take the ground's up-facing normal (no dark back faces).
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;',
      );
    };
    // Blades light like the ground they grow from (normals straight up), so the grass sits into the terrain.
    this.mesh = new THREE.InstancedMesh(tuftGeometry(), mat, this.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Call every frame. washAt/strength: rotor hub position and downwash strength (0..1). */
  update(dt: number, cam: THREE.Vector3, washAt: THREE.Vector3 | null, washStrength: number) {
    this.uniforms.time.value += dt;
    const w = this.uniforms.wash.value;
    if (washAt) w.set(washAt.x, washAt.y, washAt.z, washStrength);
    else w.w = 0;
    const agl = cam.y - this.terrain.heightAt(cam.x, cam.z);
    this.mesh.visible = agl < MAX_AGL;
    if (!this.mesh.visible) return;
    const cx = Math.floor(cam.x / CELL);
    const cz = Math.floor(cam.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.key) return;
    this.key = key;
    const r = Math.ceil(RANGE / CELL);
    let n = 0;
    const keep = new Set<string>();
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if ((dx * dx + dz * dz) * CELL * CELL > (RANGE + CELL) * (RANGE + CELL)) continue;
        const k = `${cx + dx},${cz + dz}`;
        keep.add(k);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = this.fill(cx + dx, cz + dz)));
        for (let i = 0; i < cell.m.length && n < this.capacity; i++, n++) {
          this.mesh.setMatrixAt(n, cell.m[i]);
          this.mesh.setColorAt(n, cell.c[i]);
        }
      }
    for (const k of this.cells.keys()) if (!keep.has(k)) this.cells.delete(k);
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Place one cell's tufts: on open ground only (not water, roads, steep banks, buildings or fields). */
  private fill(cx: number, cz: number) {
    const rnd = rand(cx * 73856093 ^ cz * 19349663);
    const m: THREE.Matrix4[] = [];
    const c: THREE.Color[] = [];
    const T = this.terrain;
    for (let i = 0; i < PER_CELL; i++) {
      const x = (cx + rnd()) * CELL;
      const z = (cz + rnd()) * CELL;
      const y = T.heightAt(x, z);
      if (y < WATER_LEVEL + 0.8) continue;
      if (T.normalAt(x, z, _v).y < 0.82) continue;
      const site = T.siteInfluence(x, z);
      if (rnd() < site * 0.75) continue;
      if (this.roads.distance(x, z) < 7) continue;
      if (inFields(T, x, z)) continue;
      if (this.colliders.hit(_v.set(x, y + 0.5, z), 0.6)) continue;
      const s = 0.7 + rnd() * 0.7;
      _q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      m.push(new THREE.Matrix4().compose(_v.set(x, y - 0.02, z), _q, _s.set(s, s * (0.8 + rnd() * 0.5), s)));
      // The land's own colour, a shade lighter at the blade, varied tuft to tuft; the odd clump of flowers.
      T.groundColor(x, z, _c).multiplyScalar(1.05 + rnd() * 0.25);
      const f = rnd();
      if (f < 0.04) _c.lerp(new THREE.Color(0xe8d24a), 0.6);
      else if (f < 0.06) _c.lerp(new THREE.Color(0xf2f0ea), 0.55);
      else if (f < 0.075) _c.lerp(new THREE.Color(0x8a6ac8), 0.5);
      c.push(_c.clone());
    }
    return { m, c };
  }
}

/** Inside the ring of fields around a village (where the shader draws crops instead). */
function inFields(T: Terrain, x: number, z: number) {
  for (const f of T.farms) {
    const d = Math.hypot(x - f.x, z - f.z);
    if (d > f.r + 30 && d < f.r + 700) return true;
  }
  return false;
}

/** One tuft: sixteen narrow blades fanning out, darker at the root. */
function tuftGeometry() {
  const rnd = rand(4242);
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  for (let b = 0; b < 16; b++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 0.25;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.35 + rnd() * 0.4;
    const lean = 0.1 + rnd() * 0.25;
    const lx = Math.cos(a) * lean;
    const lz = Math.sin(a) * lean;
    const w = 0.04 + rnd() * 0.03;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    pos.push(x - px, 0, z - pz, x + px, 0, z + pz, x + lx, h, z + lz);
    col.push(0.55, 0.55, 0.5, 0.55, 0.55, 0.5, 1.05, 1.05, 0.95);
    for (let k = 0; k < 3; k++) nrm.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
