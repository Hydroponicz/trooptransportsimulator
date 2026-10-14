import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RNG } from '../util/noise';
import { chainlinkTexture } from '../util/textures';
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
    let last: THREE.Vector3[] | null = null;
    walk(pi, spacing, spacing * 0.5, (f) => {
      const { x, z } = side(f, off);
      const y = terrain.heightAt(x, z);
      if (y < 1 || nearSite(x, z, 15) || !clearOfOthers(x, z, pi, 6) || onBridge(x, z)) {
        last = null;
        return;
      }
      // Crossarm across the road direction: local +X = road normal.
      const nx = -f.tz;
      const nz = f.tx;
      props.add(lattice ? 'lattice' : 'woodpole', x, y, z, Math.atan2(-nz, nx));
      const pts = attach.map(([ax, ay]) => new THREE.Vector3(x + nx * ax, y + ay, z + nz * ax));
      if (last) for (let k = 0; k < pts.length; k++) catenary(last[k], pts[k]);
      last = pts;
    });
  });
  if (wire.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x232323 })));
  }

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
  const fenceRun = (pi: number, sd: number, inRun: (f: Frame) => boolean) => {
    const spec = ROAD_SPEC[roads.classes[pi]];
    const o = (spec.hw + spec.shoulder + 3.2) * sd;
    let prev: { x: number; y: number; z: number } | null = null;
    walk(pi, 3, 0, (f) => {
      const p = side(f, o);
      const y = terrain.heightAt(p.x, p.z);
      const ok = inRun(f) && y > 1 && !onBridge(f.x, f.z) && !onBridge(p.x, p.z) && !nearSite(p.x, p.z, 4) && clearOfOthers(p.x, p.z, pi, 5);
      if (!ok) {
        prev = null;
        return;
      }
      const here = { x: p.x, y, z: p.z };
      // Outriggers lean away from the road.
      const away = { x: -f.tz * sd, z: f.tx * sd };
      props.add('fencepost', p.x, y, p.z, Math.atan2(away.x, away.z) + Math.PI);
      if (prev) fenceSeg(prev, here, away);
      prev = here;
    });
  };
  roads.paths.forEach((path, pi) => {
    const cls = roads.classes[pi];
    if (cls === 'track') return;
    for (const sd of [1, -1]) fenceRun(pi, sd, (f) => hubDist(f.x, f.z) < 380);
    // Depots and compounds: a few 150–300 m stretches out on the main roads.
    if (cls === 'main') {
      const n = Math.floor(path.length / 120);
      for (let k = 0; k < n; k++) {
        const start = rng.range(0.15, 0.85) * path.length * 7;
        const len = rng.range(150, 300);
        const sd = rng.chance(0.5) ? 1 : -1;
        let s = 0;
        fenceRun(pi, sd, () => {
          s += 3;
          return s > start && s < start + len;
        });
      }
    }
  });
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
