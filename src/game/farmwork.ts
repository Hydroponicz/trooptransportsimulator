import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { Effects } from '../fx/effects';
import { buildVehicle, type VehicleModel } from '../vehicles/models';
import { merge, part } from '../world/props';
import { Crop, FIELD_U, FIELD_V, type Farm } from '../world/farms';

type Tool = 'combine' | 'plough' | 'sprayer' | 'mower';

interface Job {
  farm: Farm;
  cx: number;
  cz: number;
  tool: Tool;
  m: VehicleModel;
  /** Working width: one pass covers this much of the plot. */
  width: number;
  speed: number;
  /** Distance travelled along the lawnmower pattern. */
  d: number;
  h: number;
  pitch: number;
  roll: number;
  dustT: number;
}

/** How far out from the camera machines are put to work, and dropped. */
const WORK_RANGE = 2600;
const DROP_RANGE = 3200;
/** Plot margins left for the headland. */
const HEAD = 6;

const _v = new THREE.Vector3();

/**
 * Farm machinery at work on the plots near the camera: combines cutting the
 * wheat and barley, tractors ploughing, spraying the row crops and mowing
 * hay, each running up and down its plot in passes the width of its
 * implement and turning on the headland. Only on farms well away from the
 * fighting.
 */
export class FarmWork {
  group = new THREE.Group();
  private jobs: Job[] = [];
  private checkT = 0;

  constructor(
    private world: World,
    private effects: Effects,
  ) {}

  private toolFor(kind: Crop): Tool | null {
    if (kind === Crop.Wheat || kind === Crop.Barley) return 'combine';
    if (kind === Crop.Plough) return 'plough';
    if (kind === Crop.Green || kind === Crop.Rapeseed || kind === Crop.Sunflower) return 'sprayer';
    if (kind === Crop.Hay) return 'mower';
    return null;
  }

  private spawn(farm: Farm, cx: number, cz: number, tool: Tool, seed: number): Job {
    const colours = [0xb8352c, 0x2f5a9a, 0x3f7a3a, 0xd8a02a];
    const m = tool === 'combine' ? buildVehicle('combine', seed % 2 ? 0x3f7a3a : 0xb8352c) : buildVehicle('tractor', colours[seed % colours.length]);
    if (tool !== 'combine') m.body.add(implement(tool));
    this.group.add(m.group);
    const width = tool === 'combine' ? 6 : tool === 'plough' ? 3.6 : tool === 'sprayer' ? 12 : 3;
    const speed = tool === 'combine' ? 1.7 : tool === 'plough' ? 2.0 : tool === 'sprayer' ? 3.4 : 2.8;
    // Start part-way through the work so machines aren't all at the same corner.
    const d = (seed % 97) * 13.7;
    return { farm, cx, cz, tool, m, width, speed, d, h: 0, pitch: 0, roll: 0, dustT: 0 };
  }

  /** Position (plot coordinates) and heading along the pattern after travelling d metres. */
  private along(j: Job, d: number) {
    const W = j.width;
    const pass = FIELD_U - 2 * HEAD;
    const turn = (Math.PI * W) / 2;
    const passes = Math.max(1, Math.floor((FIELD_V - 2 * HEAD) / W));
    const cycle = pass + turn;
    let k = Math.floor(d / cycle);
    const rem = d - k * cycle;
    k %= passes * 2;
    // Down the plot and back up, then start again from the first pass.
    const p = k < passes ? k : passes * 2 - 1 - k;
    const dir = k % 2 === 0 ? 1 : -1;
    const v0 = HEAD + W / 2 + p * W;
    const vDir = k < passes ? 1 : -1;
    if (rem < pass) {
      const u = dir > 0 ? HEAD + rem : FIELD_U - HEAD - rem;
      return { u, v: v0, du: dir, dv: 0 };
    }
    // Headland turn: a half circle onto the next pass.
    const a = (rem - pass) / (W / 2);
    const uEnd = dir > 0 ? FIELD_U - HEAD : HEAD;
    const r = W / 2;
    const cv = v0 + vDir * r;
    const u = uEnd + dir * Math.sin(a) * r;
    const v = cv - vDir * Math.cos(a) * r;
    return { u, v, du: dir * Math.cos(a), dv: vDir * Math.sin(a) };
  }

  update(dt: number, camPos: THREE.Vector3) {
    if (dt <= 0) return;
    const F = this.world.farmland;
    const T = this.world.terrain;
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 1;
      // Retire machines far behind the camera; put farms near it to work.
      for (const j of [...this.jobs]) {
        if (Math.hypot(j.farm.x - camPos.x, j.farm.z - camPos.z) > DROP_RANGE + j.farm.r) {
          this.group.remove(j.m.group);
          this.jobs.splice(this.jobs.indexOf(j), 1);
        }
      }
      for (const f of F.farms) {
        if (!f.peaceful || Math.hypot(f.x - camPos.x, f.z - camPos.z) > WORK_RANGE + f.r) continue;
        if (this.jobs.some((j) => j.farm === f)) continue;
        // Two or three plots being worked per farm, picked the same way every time.
        let n = 0;
        for (let cz = -16; cz < 16 && n < 2 + (f.id % 2); cz++)
          for (let cx = -10; cx < 10 && n < 2 + (f.id % 2); cx++) {
            const seed = (f.id * 7919 + (cx + 10) * 131 + (cz + 16) * 17) >>> 0;
            if (seed % 9 !== 0) continue;
            const tool = this.toolFor(F.kindAt(f, cx, cz));
            if (!tool) continue;
            this.jobs.push(this.spawn(f, cx, cz, tool, seed));
            n++;
          }
      }
    }
    for (const j of this.jobs) {
      j.d += j.speed * dt;
      const a = this.along(j, j.d);
      const p = F.toWorld(j.farm, j.cx, j.cz, a.u, a.v, _v);
      const y = T.heightAt(p.x, p.z);
      // Heading: world direction of the plot vector (du, dv).
      const c = Math.cos(j.farm.rot);
      const s = Math.sin(j.farm.rot);
      const wx = a.du * c + a.dv * s;
      const wz = -a.du * s + a.dv * c;
      const h = Math.atan2(wx, wz);
      j.h = h;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      const L = 2;
      const yF = T.heightAt(p.x + fx * L, p.z + fz * L);
      const yB = T.heightAt(p.x - fx * L, p.z - fz * L);
      const yL = T.heightAt(p.x - fz, p.z + fx);
      const yR = T.heightAt(p.x + fz, p.z - fx);
      j.pitch += (Math.atan2(yF - yB, 2 * L) - j.pitch) * Math.min(1, dt * 4);
      j.roll += (Math.atan2(yR - yL, 2) - j.roll) * Math.min(1, dt * 4);
      const g = j.m.group;
      g.position.set(p.x, y, p.z);
      g.rotation.set(j.pitch, h + Math.PI, j.roll, 'YXZ');
      for (const w of j.m.wheels) w.spin.rotation.x -= (j.speed * dt) / w.r;
      const d2 = camPos.distanceToSquared(g.position);
      const far = d2 > 220 * 220;
      if (j.m.far.visible !== far) {
        j.m.far.visible = far;
        j.m.body.visible = !far;
        for (const w of j.m.wheels) w.pivot.visible = !far;
      }
      // Dust and chaff behind the work.
      j.dustT -= dt;
      if (j.dustT <= 0 && d2 < 1500 * 1500 && j.tool !== 'sprayer') {
        j.dustT = j.tool === 'combine' ? 0.12 : 0.2;
        const back = j.tool === 'combine' ? 4.5 : 3.5;
        const chaff = j.tool === 'combine' || j.tool === 'mower';
        this.effects.smoke.emit({
          x: p.x - fx * back + (Math.random() - 0.5) * 2,
          y: y + (j.tool === 'combine' ? 2.5 : 0.8),
          z: p.z - fz * back + (Math.random() - 0.5) * 2,
          vy: 0.5,
          life: chaff ? 3 : 4,
          size0: 2,
          size1: chaff ? 8 : 7,
          r: chaff ? 0.78 : 0.55,
          g: chaff ? 0.7 : 0.47,
          b: chaff ? 0.5 : 0.36,
          alpha: chaff ? 0.25 : 0.3,
          drag: 1,
          wash: 0.5,
        });
      }
    }
  }
}

/** Implements hitched behind a tractor (tractor faces −Z, so behind is +Z). */
function implement(tool: Tool): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  if (tool === 'plough') {
    parts.push(part(box(0.2, 0.2, 2.2), 0x3a3a3a, 0, 0.6, 2.6));
    parts.push(part(box(3.4, 0.2, 0.25), 0xb8352c, 0, 0.55, 3.6, 0, -0.5, 0));
    for (let i = 0; i < 4; i++) parts.push(part(new THREE.CylinderGeometry(0.35, 0.35, 0.06, 12), 0x8a8c86, -1.3 + i * 0.85, 0.35, 3.0 + i * 0.5, 0, 0, Math.PI / 2 + 0.3));
  } else if (tool === 'sprayer') {
    parts.push(part(new THREE.CylinderGeometry(0.7, 0.7, 1.6, 12), 0xf2f0ea, 0, 1.6, 1.6, 0, 0, Math.PI / 2));
    parts.push(part(box(12, 0.12, 0.12), 0x3a3a3a, 0, 1.2, 2.6));
    for (const sx of [-1, 1]) parts.push(part(box(0.08, 0.5, 0.08), 0x3a3a3a, sx * 5.5, 0.95, 2.6));
  } else {
    parts.push(part(box(2.8, 0.15, 0.6), 0x3a3a3a, 1.6, 0.35, 0.6));
    parts.push(part(box(2.6, 0.3, 0.8), 0xd8a02a, 1.7, 0.6, 0.6));
  }
  const m = new THREE.Mesh(merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.castShadow = true;
  return m;
}
