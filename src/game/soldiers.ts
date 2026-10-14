import * as THREE from 'three';

/**
 * Articulated soldiers for loading scenes and the helicopter crew.
 *
 * Each body is posed by joint angles (forward kinematics) and every body
 * part is one InstancedMesh, so dozens of soldiers cost a dozen draw calls.
 * Local frame: feet at y = 0, facing −Z, right = +X.
 */

/** Joint angles (radians) and a few switches. All blend smoothly. */
export interface Joints {
  /** Pelvis height above the feet (0.92 standing). */
  hip: number;
  /** Whole-body pitch about the hips (lying down = ±π/2). */
  body: number;
  /** Torso lean forward. */
  lean: number;
  /** Torso twist (yaw). */
  twist: number;
  thighL: number;
  thighR: number;
  /** Knees bend (positive = foot goes back). */
  kneeL: number;
  kneeR: number;
  /** Shoulders: forward raise, and sideways (out from the body). */
  armL: number;
  armR: number;
  armOutL: number;
  armOutR: number;
  elbowL: number;
  elbowR: number;
  head: number;
  headYaw: number;
}

export type RifleCarry = 'sling' | 'hands' | 'back' | 'none';

export type Outfit = 'infantry' | 'crew' | 'patient' | 'medic';

export interface SoldierInstance {
  /** World matrix of the soldier's feet/root. Write this each frame. */
  matrix: THREE.Matrix4;
  joints: Joints;
  rifle: RifleCarry;
  outfit: Outfit;
  skin: THREE.Color;
  visible: boolean;
}

export function standJoints(): Joints {
  return { hip: 0.92, body: 0, lean: 0, twist: 0, thighL: 0, thighR: 0, kneeL: 0, kneeR: 0, armL: 0.08, armR: 0.08, armOutL: 0.12, armOutR: 0.12, elbowL: 0.15, elbowR: 0.15, head: 0, headYaw: 0 };
}

/** Move `cur` toward `target` (exponential, per-joint). */
export function blendJoints(cur: Joints, target: Joints, dt: number, rate = 9) {
  const k = 1 - Math.exp(-dt * rate);
  for (const key in cur) {
    const kk = key as keyof Joints;
    cur[kk] += (target[kk] - cur[kk]) * k;
  }
}

// ---------------------------------------------------------------- Poses

/** Walking or running gait. `phase` advances with distance; `speed` in m/s. */
export function gait(out: Joints, phase: number, speed: number) {
  const run = THREE.MathUtils.clamp((speed - 2) / 3, 0, 1);
  const amp = 0.45 + run * 0.35;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  out.hip = 0.92 - Math.abs(c) * (0.03 + run * 0.04) - run * 0.05;
  out.body = 0;
  out.lean = 0.05 + run * 0.18;
  out.twist = s * 0.08;
  out.thighL = s * amp;
  out.thighR = -s * amp;
  // Knee bends most as the leg swings through.
  out.kneeL = Math.max(0, -c) * (0.6 + run * 0.6) + 0.08;
  out.kneeR = Math.max(0, c) * (0.6 + run * 0.6) + 0.08;
  out.armL = -s * (0.35 + run * 0.4);
  out.armR = s * (0.35 + run * 0.4);
  out.armOutL = 0.1;
  out.armOutR = 0.1;
  out.elbowL = 0.3 + run * 0.9;
  out.elbowR = 0.3 + run * 0.9;
  out.head = out.lean * 0.6;
  out.headYaw = 0;
  return out;
}

/** Holding a rifle at the ready on top of a gait or stance. */
export function rifleArms(out: Joints) {
  out.armR = 0.55;
  out.armOutR = 0.25;
  out.elbowR = 1.25;
  out.armL = 0.95;
  out.armOutL = -0.12;
  out.elbowL = 0.75;
  return out;
}

export function crouch(out: Joints) {
  Object.assign(out, standJoints());
  out.hip = 0.55;
  out.thighL = 1.3;
  out.thighR = 0.55;
  out.kneeL = 1.9;
  out.kneeR = 1.55;
  out.lean = 0.35;
  out.head = 0.25;
  return rifleArms(out);
}

export function sit(out: Joints) {
  Object.assign(out, standJoints());
  out.hip = 0.47;
  out.thighL = 1.45;
  out.thighR = 1.45;
  out.kneeL = 1.35;
  out.kneeR = 1.35;
  out.lean = -0.06;
  // Hands resting on the rifle between the knees.
  out.armL = 0.55;
  out.armR = 0.55;
  out.armOutL = -0.05;
  out.armOutR = -0.05;
  out.elbowL = 0.9;
  out.elbowR = 0.9;
  return out;
}

/** Seated, reaching down to buckle the lap belt. */
export function buckle(out: Joints, t: number) {
  sit(out);
  out.lean = 0.35;
  out.head = -0.35;
  out.armL = 0.3 + Math.sin(t * 7) * 0.08;
  out.armR = 0.3 - Math.sin(t * 7) * 0.08;
  out.armOutL = -0.25;
  out.armOutR = -0.25;
  out.elbowL = 1.2;
  out.elbowR = 1.2;
  return out;
}

/** Carrying a litter by its handles (arms down, slightly forward). */
export function litterCarry(out: Joints, phase: number, speed: number, front: boolean) {
  gait(out, phase, Math.min(speed, 1.8));
  out.armL = front ? -0.25 : 0.25;
  out.armR = front ? -0.25 : 0.25;
  out.armOutL = 0.05;
  out.armOutR = 0.05;
  out.elbowL = 0.25;
  out.elbowR = 0.25;
  out.lean = 0.12;
  return out;
}

/** Lifting a litter up onto a rack. */
export function litterLift(out: Joints, t: number) {
  Object.assign(out, standJoints());
  const k = THREE.MathUtils.clamp(t, 0, 1);
  out.armL = 0.3 + k * 1.1;
  out.armR = 0.3 + k * 1.1;
  out.elbowL = 0.4 + (1 - k) * 0.4;
  out.elbowR = 0.4 + (1 - k) * 0.4;
  out.lean = 0.1;
  return out;
}

/** Pushing a pallet jack: leaning in, arms forward on the handle. */
export function push(out: Joints, phase: number, speed: number) {
  gait(out, phase, Math.min(speed, 1.6));
  out.lean = 0.3;
  out.armL = 1.05;
  out.armR = 1.05;
  out.armOutL = -0.08;
  out.armOutR = -0.08;
  out.elbowL = 0.35;
  out.elbowR = 0.35;
  out.head = 0.15;
  return out;
}

/** Pulling the jack backwards out from under a pallet. */
export function pull(out: Joints, phase: number) {
  gait(out, -phase, 1.0);
  out.lean = -0.08;
  out.armL = 0.9;
  out.armR = 0.9;
  out.elbowL = 0.6;
  out.elbowR = 0.6;
  return out;
}

/** Kneeling at a tie-down, hauling on a strap. */
export function strap(out: Joints, t: number) {
  Object.assign(out, standJoints());
  out.hip = 0.5;
  out.thighL = 1.4;
  out.thighR = -0.1;
  out.kneeL = 1.7;
  out.kneeR = 2.0;
  out.lean = 0.45;
  const pullS = Math.max(0, Math.sin(t * 4));
  out.armL = 1.0 - pullS * 0.6;
  out.armR = 0.7 - pullS * 0.5;
  out.elbowL = 0.4 + pullS * 1.0;
  out.elbowR = 0.6 + pullS * 1.0;
  out.armOutL = -0.1;
  out.head = -0.1;
  return out;
}

/** Throwing a strap over a crate (standing, arms high). */
export function throwOver(out: Joints, t: number) {
  Object.assign(out, standJoints());
  const k = Math.sin(Math.min(1, t) * Math.PI);
  out.armL = 0.6 + k * 1.6;
  out.armR = 0.6 + k * 1.6;
  out.elbowL = 0.5 - k * 0.3;
  out.elbowR = 0.5 - k * 0.3;
  out.lean = -0.1 + k * 0.2;
  out.head = 0.25 * k;
  return out;
}

/** Crew chief marshalling people aboard. */
export function wave(out: Joints, t: number) {
  Object.assign(out, standJoints());
  out.armR = 1.6 + Math.sin(t * 3) * 0.5;
  out.armOutR = 0.5;
  out.elbowR = 0.6 + Math.sin(t * 3) * 0.4;
  out.armL = 0.2;
  out.headYaw = Math.sin(t * 0.7) * 0.3;
  return out;
}

/** Lying flat on a litter (feet toward −Z when body = −π/2 → face up). */
export function lying(out: Joints, t: number) {
  Object.assign(out, standJoints());
  // Face up, head toward +Z, legs toward −Z.
  out.body = -Math.PI / 2;
  out.hip = 0.13;
  out.armL = 0.1;
  out.armR = 0.4 + Math.sin(t * 0.8) * 0.05;
  out.armOutL = 0.1;
  out.armOutR = 0.2;
  out.elbowR = 1.0;
  out.thighR = 0.15;
  out.kneeR = 0.3;
  out.head = -0.2;
  return out;
}

/** Door gunner hunched over the gun. */
export function gunner(out: Joints, t: number) {
  sit(out);
  out.lean = 0.25;
  out.armL = 1.25;
  out.armR = 1.15;
  out.elbowL = 0.5;
  out.elbowR = 0.6;
  out.headYaw = Math.sin(t * 0.4) * 0.25;
  return out;
}

/** Seated at the controls: right hand on the cyclic, left on the collective, eyes scanning. */
export function fly(out: Joints, t: number) {
  sit(out);
  out.hip = 0.4;
  out.thighL = 1.3;
  out.thighR = 1.3;
  out.kneeL = 1.0;
  out.kneeR = 1.0;
  out.lean = -0.12;
  out.armR = 0.75;
  out.armOutR = -0.12;
  out.elbowR = 0.75;
  out.armL = 0.35;
  out.armOutL = 0.22;
  out.elbowL = 0.55;
  out.headYaw = Math.sin(t * 0.23) * 0.45 + Math.sin(t * 0.71) * 0.12;
  out.head = Math.sin(t * 0.17) * 0.08;
  return out;
}

// ---------------------------------------------------------------- Rendering

type Part =
  | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'bootL' | 'bootR'
  | 'pelvis' | 'torso' | 'vest' | 'pouches' | 'pack'
  | 'uArmL' | 'uArmR' | 'fArmL' | 'fArmR' | 'handL' | 'handR'
  | 'head' | 'helmet' | 'rifle';

const PARTS: Part[] = ['thighL', 'thighR', 'shinL', 'shinR', 'bootL', 'bootR', 'pelvis', 'torso', 'vest', 'pouches', 'pack', 'uArmL', 'uArmR', 'fArmL', 'fArmR', 'handL', 'handR', 'head', 'helmet', 'rifle'];

const THIGH = 0.44;
const SHIN = 0.44;
const UARM = 0.29;
const FARM = 0.27;

function capsule(r: number, len: number, down: number) {
  return new THREE.CapsuleGeometry(r, len, 3, 8).translate(0, -down, 0);
}

function rifleGeo() {
  const parts = [
    new THREE.BoxGeometry(0.05, 0.09, 0.62).translate(0, 0, -0.05), // receiver + barrel
    new THREE.BoxGeometry(0.035, 0.035, 0.3).translate(0, 0.015, -0.5), // barrel
    new THREE.BoxGeometry(0.05, 0.16, 0.06).translate(0, -0.1, -0.08), // magazine
    new THREE.BoxGeometry(0.05, 0.13, 0.2).translate(0, -0.03, 0.3), // stock
    new THREE.BoxGeometry(0.04, 0.05, 0.12).translate(0, 0.08, -0.05), // optic
  ];
  const g = new THREE.BufferGeometry();
  const merged = parts.map((p) => p.toNonIndexed());
  const pos: number[] = [];
  const nor: number[] = [];
  for (const m of merged) {
    pos.push(...(m.getAttribute('position').array as Float32Array));
    nor.push(...(m.getAttribute('normal').array as Float32Array));
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

const GEO: Record<Part, THREE.BufferGeometry> = {
  thighL: capsule(0.085, THIGH - 0.12, THIGH / 2),
  thighR: capsule(0.085, THIGH - 0.12, THIGH / 2),
  shinL: capsule(0.068, SHIN - 0.12, SHIN / 2),
  shinR: capsule(0.068, SHIN - 0.12, SHIN / 2),
  bootL: new THREE.BoxGeometry(0.12, 0.11, 0.27).translate(0, -SHIN - 0.02, -0.05),
  bootR: new THREE.BoxGeometry(0.12, 0.11, 0.27).translate(0, -SHIN - 0.02, -0.05),
  pelvis: new THREE.BoxGeometry(0.32, 0.2, 0.2),
  torso: new THREE.BoxGeometry(0.36, 0.5, 0.22).translate(0, 0.27, 0),
  vest: new THREE.BoxGeometry(0.42, 0.36, 0.3).translate(0, 0.3, 0),
  pouches: new THREE.BoxGeometry(0.36, 0.11, 0.07).translate(0, 0.17, -0.18),
  pack: new THREE.BoxGeometry(0.32, 0.4, 0.17).translate(0, 0.33, 0.23),
  uArmL: capsule(0.056, UARM - 0.1, UARM / 2),
  uArmR: capsule(0.056, UARM - 0.1, UARM / 2),
  fArmL: capsule(0.05, FARM - 0.1, FARM / 2),
  fArmR: capsule(0.05, FARM - 0.1, FARM / 2),
  handL: new THREE.BoxGeometry(0.08, 0.1, 0.09).translate(0, -FARM - 0.04, 0),
  handR: new THREE.BoxGeometry(0.08, 0.1, 0.09).translate(0, -FARM - 0.04, 0),
  head: new THREE.SphereGeometry(0.105, 10, 8).scale(0.95, 1.1, 1).translate(0, 0.13, 0),
  helmet: new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.16, 0.005),
  rifle: rifleGeo(),
};

/** Base colours; the instance colour multiplies these per outfit. */
const COLOR: Record<Part, number> = {
  thighL: 0x6e6a4c, thighR: 0x6e6a4c, shinL: 0x6e6a4c, shinR: 0x6e6a4c,
  bootL: 0x3a3226, bootR: 0x3a3226,
  pelvis: 0x6a6648, torso: 0x77714f, vest: 0x58583f, pouches: 0x4c4c36, pack: 0x4f4c38,
  uArmL: 0x77714f, uArmR: 0x77714f, fArmL: 0x77714f, fArmR: 0x77714f,
  handL: 0x2d2a22, handR: 0x2d2a22,
  head: 0xffffff, helmet: 0x5f5d44, rifle: 0x1c1c1a,
};

const OUTFIT: Record<Outfit, Partial<Record<Part, number>>> = {
  infantry: {},
  medic: { helmet: 0x5f5d44 },
  // Flight suit and flight helmet.
  crew: { thighL: 0x56603e, thighR: 0x56603e, shinL: 0x56603e, shinR: 0x56603e, pelvis: 0x56603e, torso: 0x5a6442, uArmL: 0x5a6442, uArmR: 0x5a6442, fArmL: 0x5a6442, fArmR: 0x5a6442, vest: 0x4a5236, helmet: 0x7a7d6a },
  patient: { torso: 0x7a7458, vest: 0x77714f, helmet: 0xe8e4dc },
};

const _base = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();

function local(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _t.compose(_v.set(x, y, z), _q, _one);
  return out.multiplyMatrices(parent, _t);
}

/** Draws any number of articulated soldiers with one InstancedMesh per body part. */
export class SoldierRenderer {
  group = new THREE.Group();
  private meshes = {} as Record<Part, THREE.InstancedMesh>;

  constructor(private capacity = 96) {
    for (const p of PARTS) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const m = new THREE.InstancedMesh(GEO[p], mat, capacity);
      m.castShadow = p !== 'pouches' && p !== 'handL' && p !== 'handR';
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      // Instance colours carry the outfit colours.
      m.setColorAt(0, _c.setHex(COLOR[p]));
      this.group.add(m);
      this.meshes[p] = m;
    }
  }

  render(list: SoldierInstance[]) {
    let n = 0;
    const M = {
      pelvis: new THREE.Matrix4(), chest: new THREE.Matrix4(), thighL: new THREE.Matrix4(), thighR: new THREE.Matrix4(),
      shinL: new THREE.Matrix4(), shinR: new THREE.Matrix4(), uArmL: new THREE.Matrix4(), uArmR: new THREE.Matrix4(),
      fArmL: new THREE.Matrix4(), fArmR: new THREE.Matrix4(), head: new THREE.Matrix4(), rifle: new THREE.Matrix4(),
    };
    for (const s of list) {
      if (!s.visible || n >= this.capacity) continue;
      const j = s.joints;
      // Pelvis: height, whole-body pitch (lying), then the torso hangs off it.
      _base.copy(s.matrix);
      local(M.pelvis, _base, 0, j.hip, 0, -j.body);
      local(M.chest, M.pelvis, 0, 0.08, 0, -j.lean, j.twist);
      local(M.thighL, M.pelvis, -0.1, -0.04, 0, j.thighL);
      local(M.thighR, M.pelvis, 0.1, -0.04, 0, j.thighR);
      local(M.shinL, M.thighL, 0, -THIGH, 0, -j.kneeL);
      local(M.shinR, M.thighR, 0, -THIGH, 0, -j.kneeR);
      local(M.uArmL, M.chest, -0.235, 0.48, 0, j.armL, 0, -j.armOutL);
      local(M.uArmR, M.chest, 0.235, 0.48, 0, j.armR, 0, j.armOutR);
      local(M.fArmL, M.uArmL, 0, -UARM, 0, j.elbowL);
      local(M.fArmR, M.uArmR, 0, -UARM, 0, j.elbowR);
      local(M.head, M.chest, 0, 0.55, 0, j.head, j.headYaw);
      const set = (p: Part, m: THREE.Matrix4) => this.meshes[p].setMatrixAt(n, m);
      set('pelvis', M.pelvis);
      set('torso', M.chest);
      set('vest', s.outfit === 'patient' ? ZERO : M.chest);
      set('pouches', s.outfit === 'patient' || s.outfit === 'crew' ? ZERO : M.chest);
      set('pack', s.outfit === 'infantry' || s.outfit === 'medic' ? M.chest : ZERO);
      set('thighL', M.thighL);
      set('thighR', M.thighR);
      set('shinL', M.shinL);
      set('shinR', M.shinR);
      set('bootL', M.shinL);
      set('bootR', M.shinR);
      set('uArmL', M.uArmL);
      set('uArmR', M.uArmR);
      set('fArmL', M.fArmL);
      set('fArmR', M.fArmR);
      set('handL', M.fArmL);
      set('handR', M.fArmR);
      set('head', M.head);
      set('helmet', M.head);
      // Rifle: in the hands (along the right forearm), slung across the chest, or on the back.
      if (s.rifle === 'hands') set('rifle', local(M.rifle, M.chest, 0.08, 0.16, -0.3, -0.45, 0.1));
      else if (s.rifle === 'sling') set('rifle', local(M.rifle, M.chest, 0.02, 0.24, -0.2, 0.25, 0, 0.95));
      else if (s.rifle === 'back') set('rifle', local(M.rifle, M.chest, 0.05, 0.3, 0.33, 0.1, 0, 2.2));
      else set('rifle', ZERO);
      // Colours: outfit tint, skin tone on the head.
      const outfit = OUTFIT[s.outfit];
      for (const p of PARTS) {
        if (p === 'head') this.meshes[p].setColorAt(n, s.skin);
        else this.meshes[p].setColorAt(n, _c.setHex(outfit[p] ?? COLOR[p]));
      }
      n++;
    }
    for (const p of PARTS) {
      const m = this.meshes[p];
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

const SKINS = [0xc69c7a, 0xb08a6a, 0x8d6a4f, 0x6b4a35, 0xd9b08f, 0x9c7656];
export function randomSkin(rnd: () => number): THREE.Color {
  return new THREE.Color(SKINS[Math.floor(rnd() * SKINS.length)]);
}

/** Root matrix from a position and heading (heading 0 faces −Z, like the old actors). */
export function rootMatrix(out: THREE.Matrix4, pos: THREE.Vector3, heading: number) {
  _q.setFromAxisAngle(_v.set(0, 1, 0), heading);
  return out.compose(pos, _q, _one);
}
