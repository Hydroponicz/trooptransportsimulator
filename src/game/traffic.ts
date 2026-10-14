import * as THREE from 'three';
import { buildProto } from '../world/props';
import type { World } from '../world/worldgen';
import type { RNG } from '../util/noise';
import type { Effects } from '../fx/effects';

interface Vehicle {
  mesh: THREE.Mesh;
  pathIndex: number;
  path: THREE.Vector2[];
  s: number;
  dir: number;
  speed: number;
  pause: number;
}

/** Supply trucks shuttling up and down the roads. */
export class Traffic {
  group = new THREE.Group();
  private vehicles: Vehicle[] = [];
  private dustT = 0;

  constructor(
    private world: World,
    private rng: RNG,
    private effects: Effects,
  ) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const truck = buildProto('truck');
    const hmmwv = buildProto('hmmwv');
    world.roads.paths.forEach((path, pathIndex) => {
      const n = path.length > 200 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const mesh = new THREE.Mesh(rng.chance(0.6) ? truck : hmmwv, mat);
        mesh.castShadow = true;
        this.group.add(mesh);
        this.vehicles.push({ mesh, pathIndex, path, s: rng.range(0, path.length - 1), dir: rng.chance(0.5) ? 1 : -1, speed: rng.range(7, 11), pause: 0 });
      }
    });
  }

  update(dt: number, camPos: THREE.Vector3) {
    const t = this.world.terrain;
    this.dustT -= dt;
    const dust = this.dustT <= 0;
    if (dust) this.dustT = 0.15;
    for (const v of this.vehicles) {
      if (v.pause > 0) {
        v.pause -= dt;
        continue;
      }
      const seg = 7; // road samples are ~7 m apart
      v.s += (v.dir * v.speed * dt) / seg;
      if (v.s >= v.path.length - 1 || v.s <= 0) {
        v.s = Math.max(0, Math.min(v.path.length - 1.001, v.s));
        v.dir *= -1;
        v.pause = this.rng.range(8, 25);
      }
      const i = Math.floor(v.s);
      const f = v.s - i;
      const a = v.path[i];
      const b = v.path[Math.min(i + 1, v.path.length - 1)];
      const x = a.x + (b.x - a.x) * f;
      const z = a.y + (b.y - a.y) * f;
      const y = this.world.roads.heightOn(v.pathIndex, v.s) + 0.15;
      void t;
      v.mesh.position.set(x, y, z);
      const dx = (b.x - a.x) * v.dir;
      const dz = (b.y - a.y) * v.dir;
      // Vehicle models face −Z.
      v.mesh.rotation.y = Math.atan2(-dx, -dz);
      if (dust && v.mesh.position.distanceToSquared(camPos) < 1200 * 1200) {
        this.effects.smoke.emit({
          x: x - (dx / 7) * 3,
          y: y + 0.6,
          z: z - (dz / 7) * 3,
          vy: 0.6,
          life: 2.5,
          size0: 2,
          size1: 6,
          r: 0.62,
          g: 0.56,
          b: 0.44,
          alpha: 0.28,
          drag: 1,
          wash: 0.5,
        });
      }
    }
  }
}
