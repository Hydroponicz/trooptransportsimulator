import * as THREE from 'three';
import type { Side } from './campaign';

export type Pose = 'stand' | 'run' | 'kneel' | 'prone' | 'dead' | 'dig';

export interface SoldierView {
  pos: THREE.Vector3;
  heading: number;
  pose: Pose;
  phase: number;
  side: Side;
  /** Extra vertical offset (negative = standing in a trench). */
  sink: number;
  /** Firing flash this frame (raises the rifle to the shoulder). */
  aiming: boolean;
}

type PartId = 'legL' | 'legR' | 'torso' | 'pack' | 'head' | 'helmet' | 'armL' | 'armR' | 'rifle';
const PARTS: PartId[] = ['legL', 'legR', 'torso', 'pack', 'head', 'helmet', 'armL', 'armR', 'rifle'];

const GEO: Record<PartId, THREE.BufferGeometry> = {
  legL: new THREE.BoxGeometry(0.2, 0.85, 0.22).translate(0, -0.42, 0),
  legR: new THREE.BoxGeometry(0.2, 0.85, 0.22).translate(0, -0.42, 0),
  torso: new THREE.BoxGeometry(0.5, 0.65, 0.3),
  pack: new THREE.BoxGeometry(0.42, 0.5, 0.22),
  head: new THREE.BoxGeometry(0.24, 0.26, 0.26),
  helmet: new THREE.SphereGeometry(0.19, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
  armL: new THREE.BoxGeometry(0.14, 0.6, 0.16).translate(0, -0.28, 0),
  armR: new THREE.BoxGeometry(0.14, 0.6, 0.16).translate(0, -0.28, 0),
  rifle: new THREE.BoxGeometry(0.07, 0.12, 0.95),
};

const COLORS: Record<Side, Record<PartId, number>> = {
  blue: { legL: 0x5f6146, legR: 0x5f6146, torso: 0x6d6a4c, pack: 0x4a4935, head: 0xb08a6a, helmet: 0x55573e, armL: 0x6d6a4c, armR: 0x6d6a4c, rifle: 0x1e1e1c },
  red: { legL: 0x8a7a58, legR: 0x8a7a58, torso: 0x9a8862, pack: 0x6b5d42, head: 0xa98466, helmet: 0x4e4a3a, armL: 0x9a8862, armR: 0x9a8862, rifle: 0x2a2620 },
};

const _base = new THREE.Matrix4();
const _pose = new THREE.Matrix4();
const _part = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function partMatrix(out: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return out.compose(_v.set(x, y, z), _q, _s);
}

/** All battlefield infantry for both sides in 18 instanced draw calls. */
export class SoldierRenderer {
  group = new THREE.Group();
  private meshes: Record<Side, Record<PartId, THREE.InstancedMesh>>;

  constructor(private capacity: number) {
    const mk = (side: Side) => {
      const out = {} as Record<PartId, THREE.InstancedMesh>;
      for (const p of PARTS) {
        const m = new THREE.InstancedMesh(GEO[p], new THREE.MeshLambertMaterial({ color: COLORS[side][p] }), capacity);
        m.castShadow = p === 'torso' || p === 'legL' || p === 'legR';
        m.frustumCulled = false;
        m.count = 0;
        this.group.add(m);
        out[p] = m;
      }
      return out;
    };
    this.meshes = { blue: mk('blue'), red: mk('red') };
  }

  render(list: SoldierView[]) {
    const idx = { blue: 0, red: 0 };
    for (const s of list) {
      const i = idx[s.side];
      if (i >= this.capacity) continue;
      idx[s.side]++;
      _q.setFromAxisAngle(_v.set(0, 1, 0), s.heading);
      _base.compose(_v.set(s.pos.x, s.pos.y + s.sink, s.pos.z), _q, _s);
      // Whole-body pose.
      let legSwing = 0;
      // Arm angles: positive raises the arm forward (toward −Z).
      let armL = 0;
      let armR = 0.4;
      let rifleHidden = false;
      let lean = 0;
      switch (s.pose) {
        case 'run':
          legSwing = Math.sin(s.phase) * 0.75;
          armL = legSwing * 0.6;
          armR = 0.9;
          lean = 0.15;
          _pose.identity();
          break;
        case 'kneel':
          _pose.makeTranslation(0, -0.42, 0);
          armR = s.aiming ? 1.45 : 0.7;
          armL = s.aiming ? 1.3 : 0.4;
          break;
        case 'prone':
          // Face down, lying forward along −Z.
          _pose.makeTranslation(0, 0.22, 0).multiply(_m.makeRotationX(-Math.PI / 2));
          armL = 2.8;
          armR = 2.9;
          break;
        case 'dead':
          _pose.makeTranslation(0, 0.18, 0).multiply(_m.makeRotationX(Math.PI / 2)).multiply(_m.makeRotationZ(0.4));
          armL = 2.2;
          armR = 0.3;
          rifleHidden = true;
          break;
        case 'dig':
          _pose.identity();
          lean = 0.45 + Math.sin(s.phase) * 0.2;
          armL = 1.2 + Math.sin(s.phase) * 0.8;
          armR = 1.2 + Math.sin(s.phase) * 0.8;
          rifleHidden = true;
          break;
        default:
          _pose.identity();
          armR = s.aiming ? 1.45 : 0.4;
          armL = s.aiming ? 1.3 : 0;
      }
      if (s.pose === 'run' || s.pose === 'dig') _pose.multiply(_m.makeRotationX(-lean));
      _base.multiply(_pose);
      const set = (p: PartId, local: THREE.Matrix4) => this.meshes[s.side][p].setMatrixAt(i, _m.multiplyMatrices(_base, local));
      set('legL', partMatrix(_part, -0.12, 0.88, 0, legSwing));
      set('legR', partMatrix(_part, 0.12, 0.88, 0, -legSwing));
      set('torso', partMatrix(_part, 0, 1.2, 0, 0));
      set('pack', partMatrix(_part, 0, 1.25, 0.25, 0));
      set('head', partMatrix(_part, 0, 1.68, 0, 0));
      set('helmet', partMatrix(_part, 0, 1.76, 0, 0));
      set('armL', partMatrix(_part, -0.33, 1.48, 0, armL));
      set('armR', partMatrix(_part, 0.33, 1.48, 0, armR));
      if (rifleHidden) this.meshes[s.side].rifle.setMatrixAt(i, ZERO);
      else set('rifle', s.aiming || s.pose === 'prone' ? partMatrix(_part, 0.16, 1.42, -0.45, 0) : partMatrix(_part, 0.12, 1.15, -0.3, 0.5));
    }
    for (const side of ['blue', 'red'] as Side[])
      for (const p of PARTS) {
        const m = this.meshes[side][p];
        m.count = idx[side];
        m.visible = idx[side] > 0;
        m.instanceMatrix.needsUpdate = true;
      }
  }
}
