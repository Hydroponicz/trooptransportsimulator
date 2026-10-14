import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RNG } from '../util/noise';
import { chainlinkTexture, gravelTexture } from '../util/textures';
import type { Frontline } from './frontline';
import type { Props } from './props';
import { ROAD_SPEC, type Roads } from './roads';
import type { Site } from './sites';
import type { Terrain } from './terrain';
import type { Town } from './towns';

const MSR_NAMES = ['TAMPA', 'JACKSON', 'IRISH', 'MICHIGAN', 'SANTA FE', 'DOVER', 'BOSTON'];
const ASR_NAMES = ['BRONZE', 'COPPER', 'NICKEL', 'COBALT', 'IRON', 'ZINC', 'TIN', 'LEAD', 'SILVER', 'CHROME'];

interface Frame {
  x: number;
  z: number;
  /** Unit tangent along the road. */
  tx: number;
  tz: number;
  /** Road surface height. */
  y: number;
  i: number;
}

/**
 * Everything along the roads: power lines, guard rails, chain-link fences,
 * reflector posts, street lights, direction signs, checkpoints and wrecks.
 */
export function buildRoadside(
  roads: Roads,
  terrain: Terrain,
  sites: Site[],
  towns: Town[],
  front: Frontline,
  props: Props,
  rng: RNG,
): THREE.Group {
  const group = new THREE.Group();
  const nearSite = (x: number, z: number, m: number) =>
    sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m) || towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + m);
  const hubDist = (x: number, z: number) =>
    Math.min(...sites.filter((s) => s.kind === 'base' || s.kind === 'fob').map((s) => Math.hypot(s.x - x, s.z - z) - s.radius));
  /** Is (x, z) clear of roads other than `pi` (by `m` metres past their shoulders)? */
  const clearOfOthers = (x: number, z: number, pi: number, m: number) => roads.distanceExcept(x, z, pi) > m;

  // Walk a road at a fixed spacing (metres), yielding interpolated frames.
  const walk = (pi: number, step: number, from = 0, fn: (f: Frame) => void) => {
    const path = roads.paths[pi];
    const h = roads.heights[pi];
    let acc = from;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const len = a.distanceTo(b);
      while (acc <= len) {
        const t = acc / len;
        const tl = len || 1;
        fn({ x: a.x + (b.x - a.x) * t, z: a.y + (b.y - a.y) * t, tx: (b.x - a.x) / tl, tz: (b.y - a.y) / tl, y: h[i] + (h[i + 1] - h[i]) * t, i });
        acc += step;
      }
      acc -= len;
    }
  };
  const side = (f: Frame, o: number) => ({ x: f.x - f.tz * o, z: f.z + f.tx * o });
  const onBridge = (x: number, z: number) => roads.bridgeHeightAt(x, z) > -1e9;

  // ---------------------------------------------------------------- Guard rails
  const beams: THREE.BufferGeometry[] = [];
  const beamGeo = new THREE.BoxGeometry(1, 0.34, 0.08);
  const placeBeam = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const g = beamGeo.clone();
    g.scale(len + 0.05, 1, 1);
    g.rotateZ(Math.atan2(b.y - a.y, len));
    g.rotateY(Math.atan2(-(b.z - a.z), b.x - a.x));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.7, (a.z + b.z) / 2);
    beams.push(g);
  };
  roads.paths.forEach((path, pi) => {
    const spec = ROAD_SPEC[roads.classes[pi]];
    const o = spec.hw + spec.shoulder + 0.35;
    for (const sd of [1, -1]) {
      let prev: { x: number; y: number; z: number } | null = null;
      walk(pi, 2.5, 0, (f) => {
        const p = side(f, o * sd);
        const out = side(f, (o + 4) * sd);
        // Embankment drop on this side, or the outside of a tight curve.
        const drop = f.y - terrain.heightAt(out.x, out.z);
        const i = f.i;
        let turn = 0;
        if (i > 1 && i + 2 < path.length) {
          const a = path[i - 1];
          const b = path[i + 1];
          const c = path[i + 2];
          const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
          turn = cross / (a.distanceTo(b) * b.distanceTo(c) || 1);
        }
        const outside = turn * sd < -0.09;
        const want = (drop > 1.6 || outside) && !onBridge(f.x, f.z) && !nearSite(p.x, p.z, 8) && clearOfOthers(p.x, p.z, pi, 4);
        if (!want) {
          prev = null;
          return;
        }
        const here = { x: p.x, y: f.y, z: p.z };
        props.add('railpost', p.x, f.y, p.z, Math.atan2(-f.tz, f.tx));
        if (prev) {
          placeBeam(prev, here);
          roads.addRail({ x0: prev.x, z0: prev.z, x1: here.x, z1: here.z, y0: prev.y + 0.75, y1: here.y + 0.75 });
        }
        prev = here;
      });
    }
  });
  if (beams.length) {
    const g = mergeGeometries(beams.map((b) => b.toNonIndexed()), false)!;
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xa9adae }));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------------------------------------------------------------- Chain-link fences
  // Along the approaches to bases and FOBs, plus the odd compound beside main roads.
  const fenceQuads: number[] = [];
  const fenceUV: number[] = [];
  const barbs: number[] = [];
  const FH = 2.1;
  const fenceSeg = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, lean: { x: number; z: number }) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const q = [a.x, a.y, a.z, b.x, b.y, b.z, b.x, b.y + FH, b.z, a.x, a.y + FH, a.z];
    const tri = [0, 1, 2, 0, 2, 3];
    for (const k of tri) fenceQuads.push(q[k * 3], q[k * 3 + 1], q[k * 3 + 2]);
    const uv = [0, 0, len, 0, len, FH, 0, FH];
    for (const k of tri) fenceUV.push(uv[k * 2], uv[k * 2 + 1]);
    // Three strands of barbed wire on the outriggers.
    for (const h of [0.1, 0.25, 0.4]) {
      const ox = lean.x * h * 0.9;
      const oz = lean.z * h * 0.9;
      barbs.push(a.x + ox, a.y + FH + 0.1 + h, a.z + oz, b.x + ox, b.y + FH + 0.1 + h, b.z + oz);
    }
  };
  // A fence line between two points, posts every ~3 m, following the ground.
  // `lean` is the outward direction for the barbed-wire outriggers.
  const fenceLine = (x0: number, z0: number, x1: number, z1: number, lean: { x: number; z: number }) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 3));
    let prev: { x: number; y: number; z: number } | null = null;
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const z = z0 + ((z1 - z0) * k) / n;
      const here = { x, y: terrain.heightAt(x, z), z };
      props.add('fencepost', x, here.y, z, Math.atan2(lean.x, lean.z) + Math.PI);
      if (prev) fenceSeg(prev, here, lean);
      prev = here;
    }
  };
  // Gravel hardstanding for yards (and the driveway in from the road).
  const lotPos: number[] = [];
  const lotUV: number[] = [];
  const lot = (corner: { x: number; z: number }, u: { x: number; z: number }, v: { x: number; z: number }, L: number, D: number) => {
    const nu = Math.max(2, Math.ceil(L / 8));
    const nv = Math.max(2, Math.ceil(D / 8));
    const P = (i: number, j: number) => {
      const x = corner.x + u.x * (L * i) / nu + v.x * (D * j) / nv;
      const z = corner.z + u.z * (L * i) / nu + v.z * (D * j) / nv;
      return [x, terrain.heightAt(x, z) + 0.06, z];
    };
    // Wind the triangles so they face up whichever way u and v point.
    const order = v.z * u.x - v.x * u.z > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
        for (const k of order) {
          lotPos.push(...q[k]);
          lotUV.push(q[k][0] / 4, q[k][2] / 4);
        }
      }
  };

  const yards: { x: number; z: number; r: number }[] = [];
  // Industrial yards: a few fenced depots set back from the paved roads,
  // with containers, tanks, a shed and trucks inside.
  roads.paths.forEach((path, pi) => {
    const cls = roads.classes[pi];
    if (cls === 'track' || path.length < 60) return;
    const spec = ROAD_SPEC[cls];
    const outer = spec.hw + spec.shoulder;
    const attempts = Math.floor((path.length * 7) / 1800) + 1;
    let lastAt = -1e9;
    for (let k = 0; k < attempts * 4 && attempts > 0; k++) {
      if (!rng.chance(0.35)) continue;
      const i = rng.int(10, path.length - 11);
      if (Math.abs(i - lastAt) * 7 < 900) continue;
      const p = path[i];
      const a = path[i - 8];
      const b = path[i + 8];
      const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      // Needs a fairly straight stretch.
      if (tl < 16 * 7 * 0.93) continue;
      const t = { x: (b.x - a.x) / tl, z: (b.y - a.y) / tl };
      const sd = rng.chance(0.5) ? 1 : -1;
      const n = { x: -t.z * sd, z: t.x * sd };
      const L = rng.range(70, 120);
      const D = rng.range(36, 56);
      const off0 = outer + 5;
      const at = (u: number, v: number) => ({ x: p.x + t.x * u + n.x * v, z: p.y + t.z * u + n.z * v });
      // The footprint must be dry, fairly flat, clear of sites, the front and other roads.
      let ok = Math.abs(p.x - front.x(p.y)) > 700;
      let lo = Infinity;
      let hi = -Infinity;
      for (let u = -L / 2; ok && u <= L / 2; u += 8)
        for (let v = off0; ok && v <= off0 + D; v += 8) {
          const q = at(u, v);
          const y = terrain.heightAt(q.x, q.z);
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
          if (y < 1.5 || nearSite(q.x, q.z, 40) || roads.distance(q.x, q.z) < off0 - 1.5 || onBridge(q.x, q.z)) ok = false;
        }
      if (!ok || hi - lo > 5) continue;
      lastAt = i;
      yards.push({ x: at(0, off0 + D / 2).x, z: at(0, off0 + D / 2).z, r: Math.hypot(L, D) / 2 + 6 });
      const F0 = at(-L / 2, off0);
      const F1 = at(L / 2, off0);
      const B0 = at(-L / 2, off0 + D);
      const B1 = at(L / 2, off0 + D);
      const gw = 10;
      const G0 = at(-gw / 2, off0);
      const G1 = at(gw / 2, off0);
      const back = { x: -n.x, z: -n.z };
      fenceLine(F0.x, F0.z, G0.x, G0.z, back);
      fenceLine(G1.x, G1.z, F1.x, F1.z, back);
      fenceLine(B0.x, B0.z, B1.x, B1.z, n);
      fenceLine(F0.x, F0.z, B0.x, B0.z, { x: -t.x, z: -t.z });
      fenceLine(F1.x, F1.z, B1.x, B1.z, t);
      lot(at(-L / 2 + 2, off0 + 1), t, n, L - 4, D - 2);
      lot(at(-gw / 2, outer - 0.5), t, n, gw, off0 - outer + 1.5);
      // Contents.
      const along = Math.atan2(-t.z, t.x);
      const put = (name: Parameters<Props['add']>[0], u: number, v: number, rot = along, color?: number) => {
        const q = at(u, v);
        props.add(name, q.x, terrain.heightAt(q.x, q.z), q.z, rot, 1, color);
      };
      const colors = [0x6b6f4a, 0x8a7d5a, 0x7a4a32, 0x4f5a5e, 0x8c3b2a, 0x3f5f7a];
      const rows = D > 46 ? 2 : 1;
      for (let r = 0; r < rows; r++)
        for (let u = -L / 2 + 8; u < L / 2 - 20; u += 7.2) {
          if (rng.chance(0.2)) continue;
          put('container', u + 3, off0 + D - 6 - r * 9, along, rng.pick(colors));
          if (rng.chance(0.3)) put('container', u + 3, off0 + D - 6 - r * 9, along, rng.pick(colors));
        }
      const kind = rng.int(0, 2);
      if (kind === 0) for (let q = 0; q < 3; q++) put('tank', L / 2 - 10, off0 + 10 + q * 7);
      else put('building', L / 2 - 12, off0 + 12, along + Math.PI / 2);
      put('truck', -L / 2 + 10, off0 + 10, along + Math.PI / 2);
      if (rng.chance(0.6)) put('truck', -L / 2 + 15, off0 + 10, along + Math.PI / 2);
      for (let q = 0; q < 4; q++) put('crates', rng.range(-L / 2 + 6, L / 2 - 6), rng.range(off0 + 16, off0 + D - 18), rng.range(0, 3));
      for (let q = 0; q < 6; q++) put('barrel', rng.range(-8, 8) + L / 4, off0 + 6 + rng.range(0, 4), 0);
    }
  });
  if (lotPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lotPos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(lotUV, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8f8676, map: gravelTexture(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    m.receiveShadow = true;
    group.add(m);
  }
  if (fenceQuads.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fenceQuads, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(fenceUV, 2));
    g.computeVertexNormals();
    // Alpha-to-coverage (with MSAA) fades the mesh with distance instead of turning it into a solid sheet.
    const mat = new THREE.MeshLambertMaterial({ map: chainlinkTexture(), alphaTest: 0.04, alphaToCoverage: true, side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, mat);
    group.add(m);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(barbs, 3));
    group.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0x4a4c4c })));
  }

  // ---------------------------------------------------------------- Reflector posts and street lights
  roads.paths.forEach((_, pi) => {
    const cls = roads.classes[pi];
    const spec = ROAD_SPEC[cls];
    if (cls !== 'track')
      walk(pi, cls === 'main' ? 30 : 40, 10, (f) => {
        for (const sd of [1, -1]) {
          const p = side(f, (spec.hw + spec.shoulder + 0.6) * sd);
          if (onBridge(f.x, f.z) || nearSite(p.x, p.z, 0) || !clearOfOthers(p.x, p.z, pi, 2)) continue;
          props.add('delineator', p.x, Math.max(f.y, terrain.heightAt(p.x, p.z)), p.z, Math.atan2(-f.tz, f.tx));
        }
      });
    let n = 0;
    walk(pi, 38, 19, (f) => {
      n++;
      if (cls === 'track' || hubDist(f.x, f.z) > 420) return;
      const sd = n % 2 ? 1 : -1;
      const p = side(f, (spec.hw + spec.shoulder + 1.4) * sd);
      if (nearSite(p.x, p.z, 2) || !clearOfOthers(p.x, p.z, pi, 3)) return;
      const y = onBridge(f.x, f.z) ? f.y : terrain.heightAt(p.x, p.z);
      // Arm (+X) points back over the road.
      props.add('streetlight', p.x, y, p.z, Math.atan2(f.tx * sd, f.tz * sd));
    });
  });

  // ---------------------------------------------------------------- Direction signs
  const signs: { x: number; y: number; z: number; rot: number; route: string; to: string; km: number; main: boolean }[] = [];
  let msr = 0;
  let asr = 0;
  const siteAt = (x: number, z: number) => {
    const s = sites.find((q) => Math.hypot(q.x - x, q.z - z) < q.radius + 30);
    if (s) return s.name;
    // Supply routes end at the junction outside a site's gate.
    const g = roads.gates.find((q) => q.junction.distanceTo(new THREE.Vector2(x, z)) < 15);
    if (g) return g.site;
    const t = towns.find((q) => Math.hypot(q.x - x, q.z - z) < q.r + 60);
    return t ? t.name : null;
  };
  roads.paths.forEach((path, pi) => {
    const cls = roads.classes[pi];
    const route = cls === 'main' ? `MSR ${MSR_NAMES[msr++ % MSR_NAMES.length]}` : cls === 'secondary' ? `ASR ${ASR_NAMES[asr++ % ASR_NAMES.length]}` : 'SUPPLY TRACK';
    const spec = ROAD_SPEC[cls];
    let total = 0;
    for (let i = 1; i < path.length; i++) total += path[i].distanceTo(path[i - 1]);
    const A = path[0];
    const B = path[path.length - 1];
    const ends = [
      { at: 0, dir: 1, to: siteAt(B.x, B.y) },
      { at: path.length - 1, dir: -1, to: siteAt(A.x, A.y) },
    ];
    for (const e of ends) {
      if (!e.to) continue;
      // Access roads link a site to its own junction: no sign needed.
      if (siteAt(A.x, A.y) === siteAt(B.x, B.y)) continue;
      // Walk out of the site (and away from roads running alongside) and put the sign up.
      const o = spec.hw + spec.shoulder + 2.6;
      let i = e.at;
      let x = 0;
      let z = 0;
      let tx = 0;
      let tz = 0;
      let found = false;
      for (let tries = 0; tries < 80; tries++) {
        i += e.dir;
        if (i < 1 || i > path.length - 2) break;
        const p = path[i];
        const q = path[i + e.dir];
        const tl = p.distanceTo(q) || 1;
        tx = (q.x - p.x) / tl;
        tz = (q.y - p.y) / tl;
        // Right-hand side of the direction of travel.
        x = p.x + tz * o;
        z = p.y - tx * o;
        if (!nearSite(path[i].x, path[i].y, 25) && clearOfOthers(x, z, pi, 2) && !onBridge(x, z) && terrain.heightAt(x, z) > 1) {
          found = true;
          break;
        }
      }
      if (!found) continue;
      let walked = 0;
      for (let k = Math.min(i, e.at); k < Math.max(i, e.at); k++) walked += path[k + 1].distanceTo(path[k]);
      const y = terrain.heightAt(x, z);
      // Face the oncoming driver: sign front (+Z) points back along -travel.
      const rot = Math.atan2(-tx, -tz);
      signs.push({ x, y, z, rot, route, to: e.to.toUpperCase(), km: (total - walked) / 1000, main: cls === 'main' });
      props.add('signpost', x, y, z, rot);
    }
  });
  if (signs.length) group.add(signBoards(signs));
  group.userData.signs = signs;
  group.userData.yards = yards;

  // ---------------------------------------------------------------- Checkpoints and wrecks near the front
  roads.paths.forEach((path, pi) => {
    const spec = ROAD_SPEC[roads.classes[pi]];
    const o = spec.hw + spec.shoulder;
    let lastCp = -1e9;
    let s = 0;
    walk(pi, 7, 0, (f) => {
      s += 7;
      const fd = Math.abs(f.x - front.x(f.z));
      if (onBridge(f.x, f.z) || nearSite(f.x, f.z, 20) || !clearOfOthers(f.x, f.z, pi, 10)) return;
      // Checkpoint: barriers on both shoulders, sandbags and a hesco either side.
      if (fd > 350 && fd < 1500 && s - lastCp > 1400 && rng.chance(0.04)) {
        lastCp = s;
        const along = Math.atan2(-f.tz, f.tx);
        for (const sd of [1, -1]) {
          for (const k of [-6, 6]) {
            const p = side({ ...f, x: f.x + f.tx * k, z: f.z + f.tz * k }, (o + 1.2) * sd);
            props.add('jersey', p.x, terrain.heightAt(p.x, p.z), p.z, along);
          }
          const sb = side(f, (o + 4) * sd);
          props.add('sandbag', sb.x, terrain.heightAt(sb.x, sb.z), sb.z, along);
          const hb = side({ ...f, x: f.x + f.tx * 10, z: f.z + f.tz * 10 }, (o + 5.5) * sd);
          props.add('hesco', hb.x, terrain.heightAt(hb.x, hb.z), hb.z, along);
        }
        const bp = side({ ...f, x: f.x - f.tx * 12, z: f.z - f.tz * 12 }, o + 6);
        props.add('barrel', bp.x, terrain.heightAt(bp.x, bp.z), bp.z, 0);
      }
      // Burned-out vehicles pushed off the road.
      if (fd < 1100 && rng.chance(0.012)) {
        const sd = rng.chance(0.5) ? 1 : -1;
        const p = side(f, (o + rng.range(3, 7)) * sd);
        const y = terrain.heightAt(p.x, p.z);
        if (y > 1) props.add('wreck', p.x, y, p.z, Math.atan2(-f.tz, f.tx) + rng.range(-0.6, 0.6));
      }
    });
  });

  // ---------------------------------------------------------------- Power lines
  const wire: number[] = [];
  const catenary = (a: THREE.Vector3, b: THREE.Vector3) => {
    const span = a.distanceTo(b);
    const sag = Math.min(6, span * 0.04);
    const N = 10;
    let prev = a.clone();
    for (let k = 1; k <= N; k++) {
      const t = k / N;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      wire.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
  };
  roads.paths.forEach((_, pi) => {
    const cls = roads.classes[pi];
    if (cls === 'track') return;
    const lattice = cls === 'main';
    const spec = ROAD_SPEC[cls];
    const off = spec.hw + spec.shoulder + (lattice ? 16 : 6);
    const spacing = lattice ? 130 : 55;
    // Attach points relative to the structure (x across the road, y up).
    const attach = lattice ? [[-4.4, 17.8], [4.4, 17.8], [-3.4, 13.8], [3.4, 13.8], [0, 24.4]] : [[-1.1, 9.75], [1.1, 9.75], [0, 10.85]];
    // Candidate tower spots; ones in a river valley, under a viaduct or on
    // another road are skipped and the wires span over them instead.
    type Spot = { x: number; z: number; y: number; nx: number; nz: number; ok: boolean; stop: boolean };
    const spots: Spot[] = [];
    walk(pi, spacing, spacing * 0.5, (f) => {
      const { x, z } = side(f, off);
      const y = terrain.heightAt(x, z);
      const stop = nearSite(x, z, 15);
      const nearJunction = [...roads.junctionPads, ...roads.gates.map((q) => q.junction)].some((j) => Math.hypot(j.x - x, j.y - z) < 35);
      const inYard = yards.some((q) => Math.hypot(q.x - x, q.z - z) < q.r);
      const ok = !stop && !nearJunction && !inYard && y > 1.5 && y > f.y - 4 && !onBridge(x, z) && !onBridge(f.x, f.z) && clearOfOthers(x, z, pi, 6);
      spots.push({ x, z, y, nx: -f.tz, nz: f.tx, ok, stop });
    });
    const maxSpan = lattice ? 520 : 170;
    // Group placeable towers into runs that are wired together.
    const runs: Spot[][] = [];
    let run: Spot[] = [];
    for (const sp of spots) {
      if (sp.stop) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      if (!sp.ok) continue;
      const prev = run[run.length - 1];
      if (prev && Math.hypot(sp.x - prev.x, sp.z - prev.z) > maxSpan) {
        runs.push(run);
        run = [];
      }
      run.push(sp);
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      let last: THREE.Vector3[] | null = null;
      r.forEach((sp, k) => {
        // Towers either side of a long span (a river crossing) stand taller.
        const span = Math.max(
          k > 0 ? Math.hypot(sp.x - r[k - 1].x, sp.z - r[k - 1].z) : 0,
          k + 1 < r.length ? Math.hypot(sp.x - r[k + 1].x, sp.z - r[k + 1].z) : 0,
        );
        const tall = 1 + Math.min(0.6, Math.max(0, (span - spacing * 1.4) / (spacing * 2.5)));
        // Crossarm across the road direction: local +X = road normal.
        props.add(lattice ? 'lattice' : 'woodpole', sp.x, sp.y, sp.z, Math.atan2(-sp.nz, sp.nx), [1, tall, 1]);
        const pts = attach.map(([ax, ay]) => new THREE.Vector3(sp.x + sp.nx * ax, sp.y + ay * tall, sp.z + sp.nz * ax));
        if (last) for (let q = 0; q < pts.length; q++) catenary(last[q], pts[q]);
        last = pts;
      });
    }
  });
  if (wire.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x232323 })));
  }

  // ---------------------------------------------------------------- Entry control points
  // At each site gate: guard towers either side, T-walls funnelling the road
  // through the wire, and jersey barriers on the shoulders outside.
  for (const g of roads.gates) {
    const o = ROAD_SPEC.main.hw + ROAD_SPEC.main.shoulder;
    const nx = -g.dz;
    const nz = g.dx;
    const along = Math.atan2(-g.dz, g.dx);
    const at = (u: number, v: number) => ({ x: g.x + g.dx * u + nx * v, z: g.z + g.dz * u + nz * v });
    const put = (name: Parameters<Props['add']>[0], u: number, v: number, rot = along) => {
      const q = at(u, v);
      props.add(name, q.x, terrain.heightAt(q.x, q.z), q.z, rot);
    };
    for (const sd of [1, -1]) {
      put('tower', -4, sd * (o + 6.5));
      put('sandbag', 2, sd * (o + 4.5), along + Math.PI / 2);
      for (let u = -8; u <= 24; u += 1.6) put('twall', u, sd * (o + 2.4));
      for (const u of [36, 48, 60]) put('jersey', u + (sd > 0 ? 0 : 6), sd * (o + 1.2));
    }
  }

  return group;
}

/** Green route signs: destination, distance and route name, drawn into one atlas. */
function signBoards(signs: { x: number; y: number; z: number; rot: number; route: string; to: string; km: number; main: boolean }[]): THREE.Mesh {
  const COLS = 4;
  const SW = 512;
  const SH = 150;
  const rows = Math.ceil(signs.length / COLS);
  const c = document.createElement('canvas');
  c.width = SW * COLS;
  c.height = THREE.MathUtils.ceilPowerOfTwo(SH * rows);
  const g = c.getContext('2d')!;
  const parts: THREE.BufferGeometry[] = [];
  signs.forEach((s, k) => {
    const ox = (k % COLS) * SW;
    const oy = Math.floor(k / COLS) * SH;
    g.fillStyle = s.main ? '#1c5a34' : '#245a6e';
    g.fillRect(ox, oy, SW, SH);
    g.strokeStyle = '#e9efe6';
    g.lineWidth = 6;
    g.strokeRect(ox + 8, oy + 8, SW - 16, SH - 16);
    g.fillStyle = '#f2f4ee';
    g.font = 'bold 26px sans-serif';
    g.textBaseline = 'top';
    g.fillText(s.route, ox + 24, oy + 20);
    const name = s.to;
    let fs = 52;
    g.font = `bold ${fs}px sans-serif`;
    while (g.measureText(name).width > SW - 215 && fs > 22) g.font = `bold ${--fs}px sans-serif`;
    g.fillText(name, ox + 24, oy + 62 + (52 - fs) / 2);
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'right';
    g.fillText(`${s.km.toFixed(1)} km`, ox + SW - 24, oy + 68);
    g.textAlign = 'left';
    // Arrow.
    g.font = 'bold 30px sans-serif';
    g.fillText('▲', ox + SW - 60, oy + 20);
    const pg = new THREE.PlaneGeometry(5.1, 1.5);
    const uv = pg.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = (ox + uv.getX(i) * SW) / c.width;
      const v = 1 - (oy + (1 - uv.getY(i)) * SH) / c.height;
      uv.setXY(i, u, v);
    }
    pg.rotateY(s.rot);
    pg.translate(s.x, s.y + 3.4, s.z);
    parts.push(pg);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const geo = mergeGeometries(parts, false)!;
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
}
