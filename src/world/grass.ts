import * as THREE from 'three';
import type { Terrain } from './terrain';
import type { Roads } from './roads';
import type { ColliderSet } from './colliders';
import { WATER_LEVEL } from './terrain';
import { Crop, CROP_COLOR, ROW_SPACING, type Farmland } from './farms';
import type { Street, Town } from './towns';

/** Grass and crops are laid out in square cells around the camera. */
const CELL = 16;
/** Wild grass is drawn out to this distance; tufts shrink into the ground over the last quarter. */
const RANGE = 120;
/** Crops (bigger, denser) only this far out; beyond it the ground shader's rows carry the look. */
const CROP_RANGE = 110;
/** Inside this, crops use the full plant models; beyond it a sparser, chunkier version. */
const CROP_NEAR = 50;
const PER_CELL = 70;
/** Crop rows are laid in segments this long. */
const SEG = 4;
/** Hidden when the camera is this high above the ground. */
const MAX_AGL = 170;

const _v = new THREE.Vector3();
const _c = new THREE.Color();
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

/** Kinds of instanced plant: wild grass tufts, then row-crop segments. */
const LAYERS = ['grass', 'cereal', 'rape', 'sunflower', 'beet'] as const;
type Layer = (typeof LAYERS)[number];

interface CellData {
  m: Record<Layer, THREE.Matrix4[]>;
  c: Record<Layer, THREE.Color[]>;
}

/**
 * Plants around the camera: tufts of grass and wildflowers on open ground,
 * and on the farm plots the crop itself (wheat and barley, rapeseed in
 * flower, sunflowers, rows of beet) laid along the same rows the ground
 * shader draws. One instanced mesh per kind, refilled from cached cells as
 * the camera moves. Everything sways in the wind and is flattened and
 * whipped about by rotor downwash.
 */
export class Grass {
  mesh = new THREE.Group();
  /** One mesh per layer, plus a far version of each crop ('cereal:far' and so on). */
  private meshes: Record<string, THREE.InstancedMesh> = {};
  private cells = new Map<string, CellData>();
  private streets = new Map<number, Street[]>();
  private plazas: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  private key = '';
  private uniforms = { time: { value: 0 }, wash: { value: new THREE.Vector4(0, -1e5, 0, 0) }, lift: { value: 1 } };

  constructor(
    private terrain: Terrain,
    private roads: Roads,
    private colliders: ColliderSet,
    private farmland: Farmland,
    towns: Town[] = [],
  ) {
    // Town squares and streets (bucketed) so plants can keep off them.
    this.plazas = towns.filter((t) => t.plaza).map((t) => ({ ...t.plaza!, rot: t.rot }));
    for (const t of towns)
      for (const st of t.streets) {
        const x0 = Math.min(st.ax, st.bx) - st.w;
        const x1 = Math.max(st.ax, st.bx) + st.w;
        const z0 = Math.min(st.az, st.bz) - st.w;
        const z1 = Math.max(st.az, st.bz) + st.w;
        for (let gx = Math.floor(x0 / 50); gx <= Math.floor(x1 / 50); gx++)
          for (let gz = Math.floor(z0 / 50); gz <= Math.floor(z1 / 50); gz++) {
            const k = gx * 100003 + gz;
            let arr = this.streets.get(k);
            if (!arr) this.streets.set(k, (arr = []));
            arr.push(st);
          }
      }
    const span = Math.ceil(RANGE / CELL) * 2 + 1;
    const geos: Record<string, THREE.BufferGeometry> = {
      grass: tuftGeometry(),
      cereal: cerealRow(80, 0.03),
      'cereal:far': cerealRow(30, 0.07),
      rape: rapeRow(44, 1),
      'rape:far': rapeRow(18, 2),
      sunflower: sunflowerRow(6),
      'sunflower:far': sunflowerRow(3),
      beet: beetRow(9),
      'beet:far': beetRow(5),
    };
    for (const [l, geo] of Object.entries(geos)) {
      const cap = l === 'grass' ? span * span * PER_CELL : l.endsWith(':far') ? 9000 : 3000;
      const m = new THREE.InstancedMesh(geo, this.material(l === 'grass' ? RANGE : CROP_RANGE), cap);
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes[l] = m;
      this.mesh.add(m);
    }
  }

  private material(range: number) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms, { range: { value: range } });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float time;\nuniform vec4 wash;\nuniform float range;\nuniform float lift;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          {
            vec3 base = (instanceMatrix * vec4(position.x, 0.0, position.z, 1.0)).xyz;
            float h = position.y;
            // Grow out of the ground over most of the range (each plant at a slightly different
            // distance, so there is no visible ring), and settle away as the camera climbs.
            float jitter = fract(sin(dot(floor(base.xz * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
            float fade = smoothstep(range, range * (0.38 + 0.12 * jitter), distance(base.xz, cameraPosition.xz));
            transformed.y *= sqrt(fade) * lift;
            // Wind: a slow swell rolling across the field plus a quick flutter.
            float ph = dot(base.xz, vec2(0.11, 0.07));
            float sway = sin(time * 1.3 + ph) * 0.55 + sin(time * 3.7 + ph * 2.3) * 0.2;
            vec3 windW = vec3(0.12, 0.0, 0.05) * sway * h;
            // Rotor downwash: plants blown flat away from under the aircraft, thrashing.
            vec2 dw = base.xz - wash.xz;
            float dd = length(dw);
            float push = wash.w * smoothstep(28.0, 3.0, dd) * smoothstep(40.0, 8.0, wash.y - base.y);
            vec2 dir = dw / max(dd, 0.5);
            float thrash = 0.75 + 0.25 * sin(time * 17.0 + dd * 1.7);
            vec3 pushW = vec3(dir.x, 0.0, dir.y) * push * thrash * h * 1.1;
            // Into the instance's own frame: it is only turned about Y and scaled, so a transpose over the scale squared undoes it.
            mat3 im = mat3(instanceMatrix);
            transformed += transpose(im) * (windW + pushW) / dot(im[0], im[0]);
            transformed.y *= 1.0 - 0.55 * push;
          }`,
        );
      // Both faces take the up-facing normal: plants light like the ground they grow from (no dark back faces).
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;',
      );
    };
    return mat;
  }

  /** Call every frame. washAt/strength: rotor hub position and downwash strength (0..1). */
  update(dt: number, cam: THREE.Vector3, washAt: THREE.Vector3 | null, washStrength: number) {
    this.uniforms.time.value += dt;
    const w = this.uniforms.wash.value;
    if (washAt) w.set(washAt.x, washAt.y, washAt.z, washStrength);
    else w.w = 0;
    const agl = cam.y - this.terrain.heightAt(cam.x, cam.z);
    this.uniforms.lift.value = THREE.MathUtils.smoothstep(MAX_AGL - agl, 0, 70);
    this.mesh.visible = agl < MAX_AGL;
    if (!this.mesh.visible) return;
    const cx = Math.floor(cam.x / CELL);
    const cz = Math.floor(cam.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.key) return;
    this.key = key;
    const r = Math.ceil(RANGE / CELL);
    const n: Record<string, number> = {};
    for (const l of Object.keys(this.meshes)) n[l] = 0;
    const keep = new Set<string>();
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const d2 = (dx * dx + dz * dz) * CELL * CELL;
        if (d2 > (RANGE + CELL) * (RANGE + CELL)) continue;
        const k = `${cx + dx},${cz + dz}`;
        keep.add(k);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = this.fill(cx + dx, cz + dz)));
        const cropsHere = d2 < (CROP_RANGE + CELL) * (CROP_RANGE + CELL);
        const near = d2 < CROP_NEAR * CROP_NEAR;
        for (const l of LAYERS) {
          if (l !== 'grass' && !cropsHere) continue;
          const name = l === 'grass' || near ? l : `${l}:far`;
          const mesh = this.meshes[name];
          const ms = cell.m[l];
          for (let i = 0; i < ms.length && n[name] < mesh.instanceMatrix.count; i++, n[name]++) {
            mesh.setMatrixAt(n[name], ms[i]);
            mesh.setColorAt(n[name], cell.c[l][i]);
          }
        }
      }
    for (const k of this.cells.keys()) if (!keep.has(k)) this.cells.delete(k);
    for (const l of Object.keys(this.meshes)) {
      const mesh = this.meshes[l];
      mesh.count = n[l];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Is (x, z) clear ground for a plant (not water, a road, a steep bank or a building)? */
  private clear(x: number, z: number, y: number) {
    if (y < WATER_LEVEL + 0.8) return false;
    if (this.terrain.normalAt(x, z, _v).y < 0.82) return false;
    if (this.roads.distance(x, z) < 7) return false;
    for (const p of this.plazas) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (Math.abs(dx) > p.hw + p.hd || Math.abs(dz) > p.hw + p.hd) continue;
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      if (Math.abs(dx * c - dz * s) < p.hw && Math.abs(dx * s + dz * c) < p.hd) return false;
    }
    const sts = this.streets.get(Math.floor(x / 50) * 100003 + Math.floor(z / 50));
    if (sts)
      for (const st of sts) {
        const dx = st.bx - st.ax;
        const dz = st.bz - st.az;
        const t = Math.max(0, Math.min(1, ((x - st.ax) * dx + (z - st.az) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(x - st.ax - dx * t, z - st.az - dz * t) < st.w / 2 + 1) return false;
      }
    return !this.colliders.hit(_v.set(x, y + 0.5, z), 0.6);
  }

  /** One cell's plants: grass tufts on open ground and meadows, crop rows on the plots. */
  private fill(cx: number, cz: number): CellData {
    const rnd = rand(cx * 73856093 ^ cz * 19349663);
    const out: CellData = { m: {} as CellData['m'], c: {} as CellData['c'] };
    for (const l of LAYERS) {
      out.m[l] = [];
      out.c[l] = [];
    }
    const T = this.terrain;
    const F = this.farmland;
    for (let i = 0; i < PER_CELL; i++) {
      const x = (cx + rnd()) * CELL;
      const z = (cz + rnd()) * CELL;
      const field = F.fieldAt(x, z);
      // Crops and farmyards have their own cover; meadows grow long.
      if (field && field.kind !== Crop.Hay && field.kind !== Crop.Pasture) continue;
      const y = T.heightAt(x, z);
      if (rnd() < T.siteInfluence(x, z) * 0.75) continue;
      if (!this.clear(x, z, y)) continue;
      const s = (0.7 + rnd() * 0.7) * (field?.kind === Crop.Hay ? 1.35 : 1);
      _q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      out.m.grass.push(new THREE.Matrix4().compose(_v.set(x, y - 0.02, z), _q, _s.set(s, s * (0.8 + rnd() * 0.5), s)));
      // The land's own colour, a shade lighter at the blade, varied tuft to tuft; the odd clump of flowers.
      T.groundColor(x, z, _c).multiplyScalar(1.05 + rnd() * 0.25);
      const f = rnd();
      if (f < 0.04) _c.lerp(new THREE.Color(0xe8d24a), 0.6);
      else if (f < 0.06) _c.lerp(new THREE.Color(0xf2f0ea), 0.55);
      else if (f < 0.075) _c.lerp(new THREE.Color(0x8a6ac8), 0.5);
      out.c.grass.push(_c.clone());
    }
    // Crop rows: walk the plot's own grid of rows and segments over this cell.
    const probe = [
      [cx + 0.5, cz + 0.5],
      [cx, cz],
      [cx + 1, cz + 1],
    ].map(([a, b]) => F.fieldAt(a * CELL, b * CELL)).find((h) => h);
    if (!probe) return out;
    const f = probe.farm;
    const c = Math.cos(f.rot);
    const s = Math.sin(f.rot);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const dx = (cx + a) * CELL - f.x;
      const dz = (cz + b) * CELL - f.z;
      const u = dx * c - dz * s;
      const v = dx * s + dz * c;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    for (let V = Math.floor(v0 / ROW_SPACING) * ROW_SPACING + ROW_SPACING * 0.75; V < v1; V += ROW_SPACING)
      for (let U = Math.floor(u0 / SEG) * SEG + SEG / 2; U < u1; U += SEG) {
        const x = f.x + U * c + V * s;
        const z = f.z - U * s + V * c;
        if (Math.floor(x / CELL) !== cx || Math.floor(z / CELL) !== cz) continue;
        const hit = F.fieldAt(x, z);
        if (!hit || hit.farm !== f) continue;
        // Leave the headlands and margins clear.
        if (hit.u < 3 || hit.u > 92 || hit.v < 2.5 || hit.v > 57.5) continue;
        const layer: Layer | null =
          hit.kind === Crop.Wheat || hit.kind === Crop.Barley ? 'cereal' : hit.kind === Crop.Rapeseed ? 'rape' : hit.kind === Crop.Sunflower ? 'sunflower' : hit.kind === Crop.Green ? 'beet' : null;
        if (!layer) continue;
        const y = T.heightAt(x, z);
        if (!this.clear(x, z, y)) continue;
        // Rows run along u: the prop/plot yaw puts local X along u.
        _q.setFromAxisAngle(UP, f.rot + (rnd() < 0.5 ? 0 : Math.PI));
        const sc = 0.9 + rnd() * 0.2;
        out.m[layer].push(new THREE.Matrix4().compose(_v.set(x, y - 0.03, z), _q, _s.set(1, sc, 1)));
        const v = 0.9 + rnd() * 0.18;
        _c.setRGB(v, v, v);
        // Barley shares the cereal model: tint it from wheat to barley.
        if (hit.kind === Crop.Barley) _c.multiply(new THREE.Color(...CROP_COLOR[Crop.Barley].map((v, i) => v / CROP_COLOR[Crop.Wheat][i]) as [number, number, number]));
        out.c[layer].push(_c.clone());
      }
    return out;
  }
}

/** Build a geometry from triangles (absolute linear colours, up-facing normals). */
function tris(pos: number[], col: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** A thin upright blade from (x, z) to height h, leaning by (lx, lz). */
function blade(pos: number[], col: number[], x: number, z: number, h: number, lx: number, lz: number, w: number, a: number, base: number[], tip: number[]) {
  const px = -Math.sin(a) * w;
  const pz = Math.cos(a) * w;
  pos.push(x - px, 0, z - pz, x + px, 0, z + pz, x + lx, h, z + lz);
  col.push(...base, ...base, ...tip);
}

/** One tuft: sixteen narrow blades fanning out, darker at the root (tinted per instance). */
function tuftGeometry() {
  const rnd = rand(4242);
  const pos: number[] = [];
  const col: number[] = [];
  for (let b = 0; b < 16; b++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 0.25;
    const lean = 0.1 + rnd() * 0.25;
    blade(pos, col, Math.cos(a) * r, Math.sin(a) * r, 0.35 + rnd() * 0.4, Math.cos(a) * lean, Math.sin(a) * lean, 0.04 + rnd() * 0.03, a, [0.55, 0.55, 0.5], [1.05, 1.05, 0.95]);
  }
  return tris(pos, col);
}

const col = (k: Crop, m = 1) => CROP_COLOR[k].map((v) => v * m);

/** 4 m of ripe cereal: stalks with heavy ears, coloured to match the plot (n stalks, blade width w). */
function cerealRow(n: number, w: number) {
  const rnd = rand(77);
  const pos: number[] = [];
  const colr: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * SEG;
    const z = (rnd() - 0.5) * 1.4;
    const a = rnd() * Math.PI;
    const h = 0.85 + rnd() * 0.15;
    const lx = (rnd() - 0.5) * 0.12;
    const lz = (rnd() - 0.5) * 0.12;
    blade(pos, colr, x, z, h, lx, lz, w, a, col(Crop.Wheat, 0.5), col(Crop.Wheat, 1.0));
    // The ear: a narrow spindle at the top, nodding over.
    const nod = 0.08 + rnd() * 0.06;
    blade(pos, colr, x + lx, z + lz, 0.14, nod, 0, w * 1.5, a, col(Crop.Wheat, 1.05), col(Crop.Wheat, 1.2));
    for (let k = pos.length - 9; k < pos.length; k += 3) pos[k + 1] += h - 0.04;
  }
  return tris(pos, colr);
}

/** 4 m of rapeseed in flower: green stems topped with yellow (k: thickness factor for the far version). */
function rapeRow(n: number, k: number) {
  const rnd = rand(91);
  const pos: number[] = [];
  const colr: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * SEG;
    const z = (rnd() - 0.5) * 1.2;
    const a = rnd() * Math.PI;
    const h = 1.0 + rnd() * 0.3;
    blade(pos, colr, x, z, h, (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.15, 0.03 * k, a, col(Crop.Green, 0.6), col(Crop.Green, 1.1));
    const n0 = pos.length;
    for (let j = 0; j < 3; j++) {
      const b = rnd() * Math.PI * 2;
      blade(pos, colr, x, z, 0.22, Math.cos(b) * 0.15 * k, Math.sin(b) * 0.15 * k, 0.07 * k, b, col(Crop.Rapeseed, 0.9), col(Crop.Rapeseed, 1.25));
    }
    for (let j = n0; j < pos.length; j += 3) pos[j + 1] += h - 0.1;
  }
  return tris(pos, colr);
}

/** 4 m of sunflowers: tall stems, broad leaves, heads turned to the sun. */
function sunflowerRow(count: number) {
  const rnd = rand(55);
  const pos: number[] = [];
  const colr: number[] = [];
  const GREEN = col(Crop.Sunflower, 0.7);
  const LEAF = col(Crop.Sunflower, 1.0);
  for (let i = 0; i < count; i++) {
    const x = -SEG / 2 + (i + 0.5) * (SEG / count) + (rnd() - 0.5) * 0.2;
    const z = (rnd() - 0.5) * 0.3;
    const h = 1.6 + rnd() * 0.35;
    const big = 6 / count;
    blade(pos, colr, x, z, h, 0, 0, 0.035 * big, 0, GREEN, GREEN);
    blade(pos, colr, x, z, h, 0, 0, 0.035 * big, Math.PI / 2, GREEN, GREEN);
    for (let k = 0; k < 4; k++) {
      const b = rnd() * Math.PI * 2;
      const y = 0.5 + k * 0.28;
      const lx = Math.cos(b) * 0.38 * Math.sqrt(big);
      const lz = Math.sin(b) * 0.38 * Math.sqrt(big);
      pos.push(x, y, z, x + lx - lz * 0.4, y + 0.08, z + lz + lx * 0.4, x + lx + lz * 0.4, y - 0.06, z + lz - lx * 0.4);
      colr.push(...LEAF, ...LEAF, ...LEAF);
    }
    // Head: a ring of petals round a dark disc, facing east (+X) and tilted down a little.
    const cx = x + 0.08;
    const cy = h;
    const R = 0.22 * Math.sqrt(big);
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2;
      const a1 = ((k + 1) / 8) * Math.PI * 2;
      const P = (a: number, r: number) => [cx + Math.sin(a) * r * 0.25, cy + Math.cos(a) * r, z + Math.sin(a) * r];
      pos.push(...P(a0, R * 0.45), ...P(a0 + 0.2, R * 1.35), ...P(a1, R * 0.45));
      colr.push(0.85, 0.66, 0.05, 0.95, 0.75, 0.08, 0.85, 0.66, 0.05);
      pos.push(cx + 0.01, cy, z, ...P(a0, R * 0.5), ...P(a1, R * 0.5));
      colr.push(0.18, 0.11, 0.04, 0.24, 0.15, 0.05, 0.24, 0.15, 0.05);
    }
  }
  return tris(pos, colr);
}

/** 4 m of a leafy root crop (beet, potatoes): low rosettes along the row. */
function beetRow(count: number) {
  const rnd = rand(13);
  const pos: number[] = [];
  const colr: number[] = [];
  const big = Math.sqrt(9 / count);
  for (let i = 0; i < count; i++) {
    const x = -SEG / 2 + (i + 0.5) * (SEG / count);
    for (let k = 0; k < 7; k++) {
      const b = rnd() * Math.PI * 2;
      const len = (0.25 + rnd() * 0.15) * big;
      const lx = Math.cos(b) * len;
      const lz = Math.sin(b) * len;
      pos.push(x, 0, 0, x + lx - lz * 0.35, 0.3 + rnd() * 0.12, lz + lx * 0.35, x + lx + lz * 0.35, 0.25 + rnd() * 0.1, lz - lx * 0.35);
      colr.push(...col(Crop.Green, 0.6), ...col(Crop.Green, 1.25), ...col(Crop.Green, 1.15));
    }
  }
  return tris(pos, colr);
}
