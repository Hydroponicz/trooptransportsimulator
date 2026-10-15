import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Articulated soldiers: loading scenes, base staff, the helicopter crew and
 * the infantry fighting along the front all use this one model.
 *
 * Bodies are posed by joint angles (forward kinematics); the hands are put on
 * the rifle by two-bone arm IK, so weapon handling stays glued together while
 * the rifle moves between carry positions. Every body part is one
 * InstancedMesh (a detailed set up close, a cheap set far away), so hundreds
 * of soldiers cost a few dozen draw calls.
 *
 * Local frame: feet at y = 0, facing −Z, right = +X.
 */

/** Joint angles (radians), weapon placement and hand use. Everything blends smoothly. */
export interface Joints {
  /** Pelvis height above the feet (0.92 standing). */
  hip: number;
  /** Whole-body pitch about the hips (+π/2 = prone, face down; −π/2 = on the back). */
  body: number;
  /** Torso lean forward. */
  lean: number;
  /** Torso twist (yaw) relative to the pelvis. */
  twist: number;
  /** Pelvis roll (weight shift / walking sway). */
  sway: number;
  /** Pelvis yaw (rotates with the stride). */
  pelvisYaw: number;
  /** Hips: forward swing and outward spread. */
  thighL: number;
  thighR: number;
  thighOutL: number;
  thighOutR: number;
  /** Knees bend (positive = foot goes back). */
  kneeL: number;
  kneeR: number;
  /** Foot pitch relative to the pelvis (0 = flat when upright, + = toes up). */
  ankleL: number;
  ankleR: number;
  /** Shoulders: forward raise, outward raise and twist. Overridden by IK when gripping. */
  armL: number;
  armR: number;
  armOutL: number;
  armOutR: number;
  armYawL: number;
  armYawR: number;
  elbowL: number;
  elbowR: number;
  /** Head pitch (+ = look up), yaw and roll (+ = tilt left). */
  head: number;
  headYaw: number;
  headRoll: number;
  /** Rifle placement in the chest frame (position and YXZ Euler). */
  gx: number;
  gy: number;
  gz: number;
  gp: number;
  gyaw: number;
  groll: number;
  /** How much each hand is on the rifle (0..1). */
  gripL: number;
  gripR: number;
  /** Set by a pose that needs the hand for something else. */
  freeL: number;
  freeR: number;
  /** 1 when seated (a held rifle is cradled). */
  seat: number;
}

/** How the rifle is carried. `hands` is the low ready. */
export type RifleCarry = 'sling' | 'hands' | 'back' | 'none' | 'aim' | 'cradle';

/** `medstaff` and `staff` are base personnel; `enemy` is the opposing infantry. */
export type Outfit = 'infantry' | 'crew' | 'patient' | 'medic' | 'medstaff' | 'staff' | 'enemy';

export interface SoldierInstance {
  /** World matrix of the soldier's feet/root. Write this each frame. */
  matrix: THREE.Matrix4;
  joints: Joints;
  rifle: RifleCarry;
  outfit: Outfit;
  skin: THREE.Color;
  visible: boolean;
  /** World-space points for the hands (e.g. a mounted gun's grips); overrides the arm pose. */
  hands?: { r: THREE.Vector3; l: THREE.Vector3 } | null;
}

export function standJoints(): Joints {
  return {
    hip: 0.92, body: 0, lean: 0, twist: 0, sway: 0, pelvisYaw: 0,
    thighL: 0, thighR: 0, thighOutL: 0.03, thighOutR: 0.03, kneeL: 0.04, kneeR: 0.04, ankleL: 0, ankleR: 0,
    armL: 0.08, armR: 0.08, armOutL: 0.12, armOutR: 0.12, armYawL: 0, armYawR: 0, elbowL: 0.18, elbowR: 0.18,
    head: 0, headYaw: 0, headRoll: 0,
    gx: 0, gy: 0, gz: 0, gp: 0, gyaw: 0, groll: 0, gripL: 0, gripR: 0, freeL: 0, freeR: 0, seat: 0,
  };
}

/** Reset a target to standing, in place. */
function stand(out: Joints) {
  return Object.assign(out, standJoints());
}

/** Move `cur` toward `target` (exponential, per-joint). */
export function blendJoints(cur: Joints, target: Joints, dt: number, rate = 9) {
  const k = 1 - Math.exp(-dt * rate);
  for (const key in cur) {
    const kk = key as keyof Joints;
    cur[kk] += (target[kk] - cur[kk]) * k;
  }
}

const clamp = THREE.MathUtils.clamp;
/** Smooth pseudo-noise in [-1, 1] for idle motion. */
const wobble = (t: number) => Math.sin(t) * 0.6 + Math.sin(t * 2.37 + 1.3) * 0.3 + Math.sin(t * 5.1 + 0.7) * 0.1;

// ---------------------------------------------------------------- Weapon

interface GunPose {
  x: number;
  y: number;
  z: number;
  p: number;
  yaw: number;
  roll: number;
}

/** Rifle-local points: butt, pistol grip, handguard. The rifle points along −Z. */
const BUTT = new THREE.Vector3(0, -0.005, 0.375);
const GRIP_R = new THREE.Vector3(0, -0.085, 0.078);
const GRIP_L = new THREE.Vector3(0, -0.01, -0.235);

/** A shouldered pose: put the butt at `butt` (chest frame) and point the muzzle by pitch/yaw. */
function shouldered(butt: [number, number, number], p: number, yaw: number, roll = 0): GunPose {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p, yaw, roll, 'YXZ'));
  const o = new THREE.Vector3(...butt).sub(BUTT.clone().applyQuaternion(q));
  return { x: o.x, y: o.y, z: o.z, p, yaw, roll };
}

/** A slung pose: butt at `butt`, muzzle pointing along `dir` (chest frame), rolled about the barrel. */
function slung(butt: [number, number, number], dir: [number, number, number], roll: number): GunPose {
  const d = new THREE.Vector3(...dir).normalize();
  const p = Math.asin(d.y);
  // Ry(yaw) turns −Z toward (−sin, −cos).
  const yaw = Math.atan2(-d.x, -d.z);
  return shouldered(butt, p, yaw, roll);
}

/** Where the rifle sits for each way of carrying it (chest frame). */
const GUN = {
  // On the back: butt behind the right shoulder, muzzle down past the left hip.
  back: slung([0.17, 0.48, 0.33], [-0.42, -0.9, 0.04], Math.PI / 2),
  // Patrol sling: hanging diagonally across the front, muzzle down and to the left.
  sling: slung([0.17, 0.26, -0.13], [-0.55, -0.62, -0.5], 0.45),
  // Low ready: stock in the shoulder, muzzle down at the ground ahead.
  ready: shouldered([0.14, 0.42, -0.05], -0.62, 0.16),
  // Shouldered and level: cheek on the stock.
  aim: shouldered([0.13, 0.46, -0.06], 0.02, 0.05),
  // Seated: muzzle up between the knees.
  cradle: { x: 0.0, y: -0.03, z: -0.36, p: 1.28, yaw: 0, roll: 0 },
  // Prone: the body lies along chest +Y, so the rifle points that way.
  prone: shouldered([0.13, 0.44, -0.16], 1.5, 0.06),
} satisfies Record<string, GunPose>;

/**
 * Apply a rifle carry on top of a pose: where the rifle goes and which hands
 * hold it. Call after the pose function, before blending.
 */
export function hold(out: Joints, carry: RifleCarry) {
  let g: GunPose = GUN.back;
  let grip = 0;
  if (carry === 'sling') (g = GUN.sling), (grip = 1);
  else if (carry === 'hands' || carry === 'aim' || carry === 'cradle') {
    grip = 1;
    if (out.body > 1) g = GUN.prone;
    else if (carry === 'cradle' || out.seat > 0.5) g = GUN.cradle;
    else g = carry === 'aim' ? GUN.aim : GUN.ready;
    // Both hands busy: the rifle hangs on its sling.
    if (out.freeL > 0.5 && out.freeR > 0.5) g = GUN.sling;
  }
  out.gx = g.x;
  out.gy = g.y;
  out.gz = g.z;
  out.gp = g.p;
  out.gyaw = g.yaw;
  out.groll = g.roll;
  out.gripL = grip * (1 - out.freeL);
  out.gripR = grip * (1 - out.freeR);
  if (carry === 'aim' && out.body < 1 && out.freeR < 0.5) {
    // Cheek weld: head down and over onto the stock.
    out.head = Math.min(out.head, -0.22);
    out.headYaw *= 0.2;
    out.headRoll = -0.16;
    out.twist *= 0.3;
  }
  return out;
}

// ---------------------------------------------------------------- Poses

/**
 * Walking or running. `phase` advances with distance (≈ 2.6 rad per metre);
 * `tactical` (0..1) is the crouched, smooth combat walk with the weapon up.
 */
export function gait(out: Joints, phase: number, speed: number, tactical = 0) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const run = clamp((speed - 2.2) / 2.5, 0, 1);
  // Short shuffling steps when slow, full strides at pace.
  const k = clamp(speed / 1.5, 0.25, 1);
  const amp = (0.38 + run * 0.42) * k;
  const kneeAmp = (0.75 + run * 1.0) * k;
  const crouchK = tactical * 0.3;
  out.body = 0;
  out.hip = 0.92 - tactical * 0.07 - run * 0.05 + (run > 0.5 ? -0.035 : 0.022 * (1 - tactical * 0.6)) * Math.cos(2 * phase) * k;
  out.pelvisYaw = -0.12 * s * k * (1 - tactical * 0.6);
  out.sway = 0.03 * c * k;
  out.lean = 0.04 + run * 0.2 + tactical * 0.14;
  out.twist = 0.2 * s * k * (1 - tactical * 0.85) * (1 - run * 0.4);
  // Legs: thigh swings; knee flexes in early swing and absorbs heel strike; foot rolls heel to toe.
  out.thighL = 0.04 + s * amp + crouchK * 0.5;
  out.thighR = 0.04 - s * amp + crouchK * 0.5;
  out.thighOutL = out.thighOutR = 0.03;
  const swingL = Math.max(0, Math.cos(phase + 0.45));
  const swingR = Math.max(0, Math.cos(phase + Math.PI + 0.45));
  out.kneeL = 0.1 + crouchK + kneeAmp * swingL * swingL + 0.12 * Math.max(0, s) * k;
  out.kneeR = 0.1 + crouchK + kneeAmp * swingR * swingR + 0.12 * Math.max(0, -s) * k;
  out.ankleL = 0.22 * s * k + 0.18 * swingL - 0.1 * run * Math.max(0, -s);
  out.ankleR = -0.22 * s * k + 0.18 * swingR - 0.1 * run * Math.max(0, s);
  // Arms swing against the legs (used only by hands that aren't on the rifle).
  const swing = (0.3 + run * 0.45) * k;
  out.armL = -s * swing + run * 0.15;
  out.armR = s * swing + run * 0.15;
  out.armOutL = out.armOutR = 0.1;
  out.armYawL = out.armYawR = 0;
  out.elbowL = 0.25 + run * 1.15 + Math.max(0, s) * 0.2;
  out.elbowR = 0.25 + run * 1.15 + Math.max(0, -s) * 0.2;
  // Eyes stay level and pointed ahead.
  out.head = out.lean * 0.8;
  out.headYaw = -(out.pelvisYaw + out.twist) * 0.8;
  out.headRoll = -out.sway * 0.5;
  out.freeL = out.freeR = 0;
  out.seat = 0;
  return out;
}

/** Standing at ease: breathing, weight shifting from leg to leg, looking around. */
export function idle(out: Joints, t: number, seed = 0) {
  stand(out);
  const w = Math.sin(t * 0.35 + seed);
  out.sway = 0.035 * w;
  out.hip = 0.915 - 0.008 * Math.abs(w);
  // The unweighted leg relaxes at the knee.
  out.kneeL = 0.05 + 0.1 * Math.max(0, -w);
  out.kneeR = 0.05 + 0.1 * Math.max(0, w);
  out.thighL = 0.04 * Math.max(0, -w);
  out.thighR = 0.04 * Math.max(0, w);
  out.ankleL = -out.thighL + out.kneeL;
  out.ankleR = -out.thighR + out.kneeR;
  out.thighOutL = 0.06;
  out.thighOutR = 0.06;
  // Breathing.
  out.lean = 0.015 * Math.sin(t * 1.55 + seed * 3);
  // Looking about: slow drifts with the occasional glance.
  out.headYaw = 0.55 * wobble(t * 0.27 + seed * 7);
  out.head = 0.08 * wobble(t * 0.19 + seed * 3) - 0.03;
  out.twist = out.headYaw * 0.2;
  out.headRoll = 0.04 * wobble(t * 0.13 + seed);
  out.armL = 0.06 + 0.03 * Math.sin(t * 1.55 + seed * 3);
  out.armR = 0.06 + 0.03 * Math.sin(t * 1.55 + seed * 3 + 0.4);
  return out;
}

/** Holding a rifle at the ready on top of a gait or stance (the hands come from `hold`). */
export function rifleArms(out: Joints) {
  out.freeL = 0;
  out.freeR = 0;
  return out;
}

/** Taking a knee (right knee down), weapon up. */
export function kneel(out: Joints) {
  stand(out);
  out.hip = 0.56;
  out.thighL = 1.3;
  out.thighOutL = 0.12;
  out.kneeL = 1.42;
  out.ankleL = 0.0;
  out.thighR = -0.08;
  out.thighOutR = 0.06;
  out.kneeR = 1.58;
  // Rear foot on its toes.
  out.ankleR = -0.9;
  out.lean = 0.2;
  out.head = 0.1;
  out.sway = -0.03;
  return out;
}

/** Hunched down by the rotors: a knee down and the head low. */
export function crouch(out: Joints) {
  kneel(out);
  out.lean = 0.38;
  out.head = 0.28;
  return out;
}

export function sit(out: Joints) {
  stand(out);
  out.hip = 0.47;
  out.thighL = 1.45;
  out.thighR = 1.45;
  out.thighOutL = 0.12;
  out.thighOutR = 0.12;
  out.kneeL = 1.35;
  out.kneeR = 1.35;
  out.ankleL = -0.1;
  out.ankleR = -0.1;
  out.lean = -0.06;
  out.seat = 1;
  // Free-arm fallback: hands resting on the knees.
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
  out.freeL = out.freeR = 1;
  return out;
}

/** Carrying a litter by its handles (arms down, slightly forward). */
export function litterCarry(out: Joints, phase: number, speed: number, front: boolean) {
  gait(out, phase, Math.min(speed, 1.8), 0.3);
  out.armL = front ? -0.25 : 0.25;
  out.armR = front ? -0.25 : 0.25;
  out.armOutL = 0.05;
  out.armOutR = 0.05;
  out.elbowL = 0.25;
  out.elbowR = 0.25;
  out.lean = 0.12;
  out.twist = 0;
  out.freeL = out.freeR = 1;
  return out;
}

/** Lifting a litter up onto a rack. */
export function litterLift(out: Joints, t: number) {
  stand(out);
  const k = clamp(t, 0, 1);
  out.armL = 0.3 + k * 1.1;
  out.armR = 0.3 + k * 1.1;
  out.elbowL = 0.4 + (1 - k) * 0.4;
  out.elbowR = 0.4 + (1 - k) * 0.4;
  out.lean = 0.1;
  out.kneeL = out.kneeR = 0.25 * (1 - k);
  out.hip = 0.92 - 0.06 * (1 - k);
  out.freeL = out.freeR = 1;
  return out;
}

/** Pushing a pallet jack: leaning in, arms forward on the handle. */
export function push(out: Joints, phase: number, speed: number) {
  gait(out, phase, Math.min(speed, 1.6));
  out.lean = 0.32;
  out.twist = 0;
  out.armL = 1.05;
  out.armR = 1.05;
  out.armOutL = -0.08;
  out.armOutR = -0.08;
  out.elbowL = 0.35;
  out.elbowR = 0.35;
  out.head = 0.2;
  out.freeL = out.freeR = 1;
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
  out.freeL = out.freeR = 1;
  return out;
}

/** Kneeling at a tie-down, hauling on a strap. */
export function strap(out: Joints, t: number) {
  kneel(out);
  out.lean = 0.45;
  const pullS = Math.max(0, Math.sin(t * 4));
  out.armL = 1.0 - pullS * 0.6;
  out.armR = 0.7 - pullS * 0.5;
  out.elbowL = 0.4 + pullS * 1.0;
  out.elbowR = 0.6 + pullS * 1.0;
  out.armOutL = -0.1;
  out.head = -0.1;
  out.twist = 0.15 * pullS;
  out.freeL = out.freeR = 1;
  return out;
}

/** Throwing a strap over a crate (standing, arms high). */
export function throwOver(out: Joints, t: number) {
  stand(out);
  const k = Math.sin(Math.min(1, t) * Math.PI);
  out.armL = 0.6 + k * 1.6;
  out.armR = 0.6 + k * 1.6;
  out.elbowL = 0.5 - k * 0.3;
  out.elbowR = 0.5 - k * 0.3;
  out.lean = -0.1 + k * 0.2;
  out.head = 0.25 * k;
  out.freeL = out.freeR = 1;
  return out;
}

/** Crew chief marshalling people aboard. */
export function wave(out: Joints, t: number) {
  idle(out, t * 0.6, 2);
  out.armR = 1.6 + Math.sin(t * 3) * 0.5;
  out.armOutR = 0.5;
  out.elbowR = 0.6 + Math.sin(t * 3) * 0.4;
  out.armL = 0.2;
  out.headYaw = Math.sin(t * 0.7) * 0.3;
  out.freeR = 1;
  out.freeL = 1;
  return out;
}

/** Lying flat on a litter (feet toward −Z when body = −π/2 → face up). */
export function lying(out: Joints, t: number) {
  stand(out);
  out.body = -Math.PI / 2;
  out.hip = 0.13;
  out.armL = 0.1;
  out.armR = 0.4 + Math.sin(t * 0.8) * 0.05;
  out.armOutL = 0.1;
  out.armOutR = 0.2;
  out.elbowR = 1.0;
  out.thighR = 0.15;
  out.kneeR = 0.3;
  out.head = -0.2 + Math.sin(t * 0.3) * 0.05;
  out.headYaw = Math.sin(t * 0.21) * 0.3;
  // Laboured breathing.
  out.lean = 0.02 * Math.sin(t * 2.2);
  out.freeL = out.freeR = 1;
  return out;
}

/** Lying prone behind the rifle. */
export function prone(out: Joints, t = 0) {
  stand(out);
  out.body = Math.PI / 2;
  out.hip = 0.16;
  out.thighL = 0.05;
  out.thighR = 0.1;
  out.thighOutL = 0.2;
  out.thighOutR = 0.15;
  out.kneeL = 0.1;
  out.kneeR = 0.45;
  out.ankleL = -1.3;
  out.ankleR = -1.1;
  // Head up to look along the ground.
  out.head = 1.0 + 0.05 * Math.sin(t * 0.5);
  out.headYaw = 0.15 * wobble(t * 0.3);
  return out;
}

/** Killed: crumpled on the ground. `v` (0..1) picks a variation. */
export function dead(out: Joints, v: number) {
  stand(out);
  const up = v > 0.5;
  out.body = up ? -Math.PI / 2 : Math.PI / 2;
  out.hip = 0.14;
  out.armL = up ? 2.2 : 2.6;
  out.armOutL = 0.6;
  out.armR = up ? 0.3 : 1.8;
  out.armOutR = 0.9;
  out.elbowL = 0.4;
  out.elbowR = 1.2;
  out.thighL = 0.2 + v * 0.3;
  out.kneeL = 0.6;
  out.thighOutR = 0.25;
  out.head = up ? -0.3 : 0.4;
  out.headYaw = (v - 0.5) * 1.6;
  out.freeL = out.freeR = 1;
  return out;
}

/** Digging in with an entrenching tool. */
export function dig(out: Joints, phase: number) {
  stand(out);
  const s = Math.sin(phase);
  out.hip = 0.82;
  out.thighL = 0.35;
  out.kneeL = 0.5;
  out.thighR = -0.1;
  out.kneeR = 0.2;
  out.ankleL = 0.15;
  out.lean = 0.55 + s * 0.2;
  out.twist = -0.25 + s * 0.15;
  out.armL = 1.0 + s * 0.6;
  out.armR = 0.7 + s * 0.6;
  out.elbowL = 0.6;
  out.elbowR = 0.9;
  out.head = 0.3;
  out.freeL = out.freeR = 1;
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
  out.headYaw = Math.sin(t * 0.4) * 0.25 + 0.08 * wobble(t * 1.3);
  out.freeL = out.freeR = 1;
  return out;
}

/** Standing salute, right hand to the brim of the helmet. */
export function salute(out: Joints) {
  stand(out);
  out.armR = 1.25;
  out.armOutR = 1.05;
  out.elbowR = 2.25;
  out.armL = 0.02;
  out.armOutL = 0.06;
  out.head = -0.05;
  out.freeR = 1;
  out.freeL = 1;
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
  out.freeL = out.freeR = 1;
  return out;
}

// ---------------------------------------------------------------- Geometry

type Part =
  | 'pelvis' | 'torso' | 'vest' | 'pouches' | 'pack'
  | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'bootL' | 'bootR'
  | 'uArmL' | 'uArmR' | 'fArmL' | 'fArmR' | 'handL' | 'handR'
  | 'head' | 'eyewear' | 'helmet' | 'rifle';

const PARTS: Part[] = ['pelvis', 'torso', 'vest', 'pouches', 'pack', 'thighL', 'thighR', 'shinL', 'shinR', 'bootL', 'bootR', 'uArmL', 'uArmR', 'fArmL', 'fArmR', 'handL', 'handR', 'head', 'eyewear', 'helmet', 'rifle'];

const THIGH = 0.44;
const SHIN = 0.44;
const UARM = 0.29;
const FARM = 0.27;
/** Shoulder joints in the chest frame. */
const SHOULDER_X = 0.205;
const SHOULDER_Y = 0.47;

/** A primitive with a shade factor (vertex colour) and a transform. */
type Prim = [THREE.BufferGeometry, number, number, number, number, number?, number?, number?, number?, number?, number?];

/** Merge primitives into one geometry with per-vertex shade (the instance colour tints it). */
function build(prims: Prim[]): THREE.BufferGeometry {
  const list = prims.map(([geo, shade, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1]) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
    const col = new Float32Array(g.getAttribute('position').count * 3).fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  return mergeGeometries(list, false)!;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, n = 10, open = false) => new THREE.CylinderGeometry(rt, rb, h, n, 1, open);
const sph = (r: number, w = 12, h = 8) => new THREE.SphereGeometry(r, w, h);
const cap = (r: number, len: number, down: number, seg = 10) => new THREE.CapsuleGeometry(r, len, 3, seg).translate(0, -down, 0);

function rifleDetail(): THREE.BufferGeometry {
  return build([
    [box(0.034, 0.06, 0.17), 0.95, 0, -0.022, 0.02], // lower receiver
    [box(0.034, 0.046, 0.21), 1, 0, 0.03, 0.0], // upper receiver
    [box(0.046, 0.052, 0.25), 0.9, 0, 0.026, -0.225], // rail handguard
    [box(0.02, 0.012, 0.44), 0.7, 0, 0.06, -0.13], // top rail
    [cyl(0.009, 0.009, 0.17, 6), 1, 0, 0.026, -0.43, Math.PI / 2], // barrel
    [cyl(0.013, 0.013, 0.05, 6), 0.8, 0, 0.026, -0.535, Math.PI / 2], // flash hider
    [box(0.012, 0.045, 0.014), 1, 0, 0.07, -0.33], // front sight post
    [cyl(0.019, 0.019, 0.11, 8), 0.85, 0, 0.1, -0.03, Math.PI / 2], // optic body
    [cyl(0.024, 0.019, 0.03, 8), 0.85, 0, 0.1, -0.095, Math.PI / 2], // objective bell
    [box(0.022, 0.03, 0.05), 0.7, 0, 0.075, -0.03], // optic mount
    [box(0.026, 0.13, 0.062), 0.75, 0, -0.105, -0.055, 0.22], // magazine (curved forward)
    [box(0.026, 0.05, 0.058), 0.75, 0, -0.18, -0.03, 0.4],
    [box(0.03, 0.09, 0.034), 0.85, 0, -0.07, 0.078, -0.35], // pistol grip
    [box(0.006, 0.012, 0.055), 0.6, 0, -0.055, 0.03], // trigger guard
    [cyl(0.014, 0.014, 0.16, 6), 0.9, 0, 0.022, 0.19, Math.PI / 2], // buffer tube
    [box(0.04, 0.085, 0.13), 0.95, 0, 0.0, 0.3], // stock
    [box(0.043, 0.11, 0.02), 0.5, 0, -0.005, 0.372], // butt pad
    [box(0.008, 0.024, 0.52), 0.55, -0.026, -0.03, 0.05], // sling
  ]);
}

function rifleSimple(): THREE.BufferGeometry {
  return build([
    [box(0.05, 0.08, 0.62), 1, 0, 0, -0.05],
    [box(0.03, 0.03, 0.2), 1, 0, 0.02, -0.46],
    [box(0.05, 0.14, 0.06), 0.8, 0, -0.1, -0.06],
    [box(0.045, 0.11, 0.18), 1, 0, -0.02, 0.29],
    [box(0.035, 0.04, 0.1), 0.85, 0, 0.07, -0.04],
  ]);
}

/** Up-close parts. */
function detailParts(): Record<Part, THREE.BufferGeometry> {
  const thigh = (side: number) =>
    build([
      [cap(0.087, THIGH - 0.13, THIGH / 2), 1, 0, 0, 0],
      [box(0.03, 0.13, 0.11), 0.86, side * 0.085, -THIGH * 0.52, 0], // cargo pocket
      [box(0.032, 0.03, 0.115), 0.8, side * 0.086, -THIGH * 0.52 + 0.075, 0], // pocket flap
    ]);
  const shin = () =>
    build([
      [cap(0.068, SHIN - 0.12, SHIN / 2), 1, 0, 0, 0],
      [box(0.095, 0.1, 0.05), 0.32, 0, -0.04, -0.068], // knee pad
      [box(0.1, 0.02, 0.055), 0.25, 0, -0.1, -0.06],
    ]);
  // Boot: the frame origin is the ankle.
  const boot = () =>
    build([
      [cyl(0.064, 0.06, 0.15, 10), 1, 0, 0.02, 0.0],
      [box(0.112, 0.075, 0.25), 1, 0, -0.045, -0.055],
      [box(0.106, 0.04, 0.07), 0.85, 0, -0.03, -0.175], // toe cap
      [box(0.118, 0.028, 0.27), 0.32, 0, -0.088, -0.058], // sole
      [box(0.112, 0.02, 0.06), 0.32, 0, -0.08, 0.06], // heel
    ]);
  const uArm = (side: number) =>
    build([
      [cap(0.057, UARM - 0.1, UARM / 2), 1, 0, 0, 0],
      [box(0.03, 0.08, 0.06), 0.82, side * 0.05, -0.1, 0.0], // shoulder pocket / patch
      [sph(0.068, 10, 6), 1, 0, -0.01, 0, 0, 0, 0, 1, 0.75, 1], // deltoid
    ]);
  const fArm = () =>
    build([
      [cap(0.05, FARM - 0.1, FARM / 2), 1, 0, 0, 0],
      [cyl(0.055, 0.055, 0.04, 10), 0.85, 0, -FARM + 0.05, 0], // cuff
    ]);
  // Gloved hand gripping: palm, curled fingers and thumb. Inner side is toward −X for the right hand.
  const hand = (side: number) =>
    build([
      [box(0.075, 0.085, 0.034), 1, 0, -FARM - 0.035, 0],
      [box(0.074, 0.038, 0.062), 0.92, 0, -FARM - 0.088, -0.018],
      [box(0.024, 0.055, 0.026), 0.95, -side * 0.042, -FARM - 0.04, -0.03, 0, 0, side * 0.4],
    ]);
  return {
    pelvis: build([
      [cyl(0.155, 0.165, 0.22, 12), 1, 0, 0, 0, 0, 0, 0, 1, 1, 0.74],
      [cyl(0.168, 0.168, 0.05, 12), 0.42, 0, 0.085, 0, 0, 0, 0, 1, 1, 0.78], // belt
      [box(0.05, 0.035, 0.012), 0.7, 0, 0.085, -0.13], // buckle
      [box(0.15, 0.1, 0.14), 1, 0, -0.1, 0],
      [box(0.07, 0.09, 0.05), 0.38, 0.15, 0.03, 0.04], // dump pouch on the belt
    ]),
    torso: build([
      [cyl(0.145, 0.155, 0.22, 12), 1, 0, 0.12, 0, 0, 0, 0, 1, 1, 0.72], // abdomen
      [cyl(0.19, 0.15, 0.3, 12), 1, 0, 0.35, 0, 0, 0, 0, 1, 1, 0.64], // chest, broad at the top
      [sph(0.08, 10, 6), 1, -0.185, 0.46, 0, 0, 0, 0, 1, 0.8, 1], // shoulders
      [sph(0.08, 10, 6), 1, 0.185, 0.46, 0, 0, 0, 0, 1, 0.8, 1],
      [cyl(0.075, 0.085, 0.06, 10), 0.92, 0, 0.51, 0], // collar
    ]),
    vest: build([
      [box(0.31, 0.33, 0.05), 1, 0, 0.32, -0.138], // front plate
      [box(0.31, 0.35, 0.05), 1, 0, 0.33, 0.138], // back plate
      [box(0.055, 0.2, 0.25), 0.9, -0.172, 0.24, 0], // cummerbund
      [box(0.055, 0.2, 0.25), 0.9, 0.172, 0.24, 0],
      [box(0.06, 0.03, 0.29), 0.85, -0.11, 0.505, 0], // shoulder straps
      [box(0.06, 0.03, 0.29), 0.85, 0.11, 0.505, 0],
      [box(0.09, 0.03, 0.03), 0.6, 0, 0.5, 0.168], // drag handle
      [box(0.3, 0.012, 0.012), 0.6, 0, 0.42, -0.166], // MOLLE rows
      [box(0.3, 0.012, 0.012), 0.6, 0, 0.36, -0.166],
    ]),
    pouches: build([
      [box(0.074, 0.12, 0.06), 1, -0.085, 0.24, -0.18], // triple mag pouch
      [box(0.074, 0.12, 0.06), 0.95, 0, 0.24, -0.18],
      [box(0.074, 0.12, 0.06), 1, 0.085, 0.24, -0.18],
      [box(0.24, 0.028, 0.065), 0.85, 0, 0.31, -0.182], // flaps
      [box(0.15, 0.08, 0.034), 0.92, 0, 0.405, -0.177], // admin pouch
      [box(0.07, 0.14, 0.06), 1, 0.19, 0.29, 0.07], // radio pouch
      [box(0.02, 0.2, 0.02), 0.3, 0.2, 0.43, 0.09], // radio antenna
      [box(0.07, 0.12, 0.07), 0.95, -0.19, 0.22, 0.06], // IFAK
    ]),
    pack: build([
      [box(0.26, 0.3, 0.12), 1, 0, 0.29, 0.225],
      [cyl(0.06, 0.06, 0.26, 10, false), 1, 0, 0.44, 0.225, 0, 0, Math.PI / 2], // rounded top
      [box(0.035, 0.15, 0.08), 0.9, -0.145, 0.25, 0.225], // side pockets
      [box(0.035, 0.15, 0.08), 0.9, 0.145, 0.25, 0.225],
      [box(0.21, 0.12, 0.035), 0.88, 0, 0.24, 0.295], // front pocket
      [box(0.27, 0.022, 0.13), 0.6, 0, 0.36, 0.225], // compression strap
    ]),
    thighL: thigh(-1),
    thighR: thigh(1),
    shinL: shin(),
    shinR: shin(),
    bootL: boot(),
    bootR: boot(),
    uArmL: uArm(-1),
    uArmR: uArm(1),
    fArmL: fArm(),
    fArmR: fArm(),
    handL: hand(-1),
    handR: hand(1),
    head: build([
      [cyl(0.05, 0.056, 0.09, 10), 1, 0, 0.02, 0.005], // neck
      [sph(0.1, 14, 10), 1, 0, 0.135, 0, 0, 0, 0, 0.92, 1.08, 1],
      [sph(0.075, 10, 6), 1, 0, 0.07, -0.035, 0, 0, 0, 1, 0.8, 1], // jaw
      [box(0.024, 0.042, 0.032), 0.95, 0, 0.12, -0.103], // nose
      [box(0.018, 0.045, 0.03), 0.92, -0.097, 0.13, 0.0], // ears
      [box(0.018, 0.045, 0.03), 0.92, 0.097, 0.13, 0.0],
      [box(0.026, 0.011, 0.012), 0.12, -0.035, 0.152, -0.094], // eyes
      [box(0.026, 0.011, 0.012), 0.12, 0.035, 0.152, -0.094],
      [box(0.036, 0.01, 0.012), 0.45, -0.035, 0.172, -0.094], // brows
      [box(0.036, 0.01, 0.012), 0.45, 0.035, 0.172, -0.094],
      [box(0.042, 0.007, 0.01), 0.55, 0, 0.076, -0.098], // mouth
    ]),
    eyewear: build([
      [box(0.155, 0.036, 0.014), 1, 0, 0.152, -0.108],
      [box(0.006, 0.012, 0.11), 1, -0.098, 0.155, -0.05],
      [box(0.006, 0.012, 0.11), 1, 0.098, 0.155, -0.05],
    ]),
    helmet: build([
      [new THREE.SphereGeometry(0.136, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), 1, 0, 0.158, 0.008, 0, 0, 0, 1, 0.95, 1.08],
      [cyl(0.138, 0.142, 0.032, 16, true), 0.82, 0, 0.152, 0.008, 0, 0, 0, 1, 1, 1.08], // rim
      [box(0.052, 0.05, 0.022), 0.3, 0, 0.225, -0.142, -0.25], // NVG shroud
      [box(0.016, 0.026, 0.13), 0.45, -0.135, 0.2, 0.0], // side rails
      [box(0.016, 0.026, 0.13), 0.45, 0.135, 0.2, 0.0],
      [box(0.075, 0.042, 0.032), 0.7, 0, 0.205, 0.148, 0.3], // counterweight pouch
      [box(0.008, 0.11, 0.012), 0.32, -0.088, 0.085, -0.02], // chin strap
      [box(0.008, 0.11, 0.012), 0.32, 0.088, 0.085, -0.02],
      [box(0.11, 0.008, 0.012), 0.32, 0, 0.03, -0.062],
      [box(0.2, 0.03, 0.012), 0.6, 0, 0.215, -0.142, -0.15], // band
    ]),
    rifle: rifleDetail(),
  };
}

/** Far-away parts: a few boxes and low-segment capsules. */
function simpleParts(): Partial<Record<Part, THREE.BufferGeometry>> {
  const c = (r: number, len: number, down: number) => build([[cap(r, len, down, 5), 1, 0, 0, 0]]);
  return {
    pelvis: build([[box(0.32, 0.22, 0.22), 1, 0, -0.02, 0]]),
    torso: build([[box(0.36, 0.52, 0.22), 1, 0, 0.27, 0]]),
    vest: build([[box(0.42, 0.36, 0.31), 1, 0, 0.3, 0]]),
    pack: build([[box(0.26, 0.34, 0.13), 1, 0, 0.3, 0.225]]),
    thighL: c(0.085, THIGH - 0.12, THIGH / 2),
    thighR: c(0.085, THIGH - 0.12, THIGH / 2),
    shinL: c(0.068, SHIN - 0.12, SHIN / 2),
    shinR: c(0.068, SHIN - 0.12, SHIN / 2),
    bootL: build([[box(0.11, 0.1, 0.26), 1, 0, -0.04, -0.05]]),
    bootR: build([[box(0.11, 0.1, 0.26), 1, 0, -0.04, -0.05]]),
    uArmL: c(0.056, UARM - 0.1, UARM / 2),
    uArmR: c(0.056, UARM - 0.1, UARM / 2),
    fArmL: c(0.05, FARM - 0.08, FARM / 2),
    fArmR: c(0.05, FARM - 0.08, FARM / 2),
    head: build([[sph(0.1, 7, 5), 1, 0, 0.13, 0, 0, 0, 0, 0.95, 1.1, 1]]),
    helmet: build([[new THREE.SphereGeometry(0.135, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), 1, 0, 0.16, 0.005]]),
    rifle: rifleSimple(),
  };
}

/** Base colours per part; outfits override some. */
const COLOR: Record<Part, number> = {
  pelvis: 0x6a6648, torso: 0x77714f, vest: 0x5b5b41, pouches: 0x55553c, pack: 0x55523c,
  thighL: 0x6e6a4c, thighR: 0x6e6a4c, shinL: 0x6e6a4c, shinR: 0x6e6a4c,
  bootL: 0x8a7458, bootR: 0x8a7458,
  uArmL: 0x77714f, uArmR: 0x77714f, fArmL: 0x77714f, fArmR: 0x77714f,
  handL: 0x6b5d45, handR: 0x6b5d45,
  head: 0xffffff, eyewear: 0x1c1c1c, helmet: 0x6a6849, rifle: 0x262624,
};

const OUTFIT: Record<Outfit, Partial<Record<Part, number>>> = {
  infantry: {},
  medic: {},
  // Flight suit, flight helmet, black gloves.
  crew: {
    pelvis: 0x56603e, thighL: 0x56603e, thighR: 0x56603e, shinL: 0x56603e, shinR: 0x56603e,
    torso: 0x5a6442, uArmL: 0x5a6442, uArmR: 0x5a6442, fArmL: 0x5a6442, fArmR: 0x5a6442,
    vest: 0x4a5236, helmet: 0x7a7d6a, handL: 0x2a2a28, handR: 0x2a2a28,
  },
  patient: { torso: 0x7a7458, vest: 0x77714f, helmet: 0xe8e4dc },
  // White medical vest with red-cross panels, soft cap.
  medstaff: { vest: 0xe6e3da, pouches: 0xb3201c, helmet: 0x8a7d5a },
  // Shirt-sleeve order: no armour, patrol cap.
  staff: { helmet: 0x5b5f40 },
  // The other side: tan uniform, dark green helmet and chest rig, black boots.
  enemy: {
    pelvis: 0x8a7a58, thighL: 0x8a7a58, thighR: 0x8a7a58, shinL: 0x8a7a58, shinR: 0x8a7a58,
    torso: 0x9a8862, uArmL: 0x9a8862, uArmR: 0x9a8862, fArmL: 0x9a8862, fArmR: 0x9a8862,
    vest: 0x4f5139, pouches: 0x46483a, pack: 0x6b5d42, helmet: 0x4e4f3a, bootL: 0x2c2620, bootR: 0x2c2620, handL: 0x3a342a, handR: 0x3a342a,
  },
};

/** Which parts each outfit wears. */
function wears(o: Outfit, p: Part): boolean {
  if (p === 'vest') return o !== 'patient' && o !== 'staff';
  if (p === 'pouches') return o !== 'patient' && o !== 'crew' && o !== 'staff';
  if (p === 'pack') return o === 'infantry' || o === 'medic' || o === 'enemy';
  if (p === 'eyewear') return o === 'infantry' || o === 'medic' || o === 'crew';
  return true;
}

// ---------------------------------------------------------------- Rendering

const _t = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _inv = new THREE.Matrix4();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function local(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _t.compose(_v.set(x, y, z), _q, _one);
  return out.multiplyMatrices(parent, _t);
}

/**
 * Two-bone arm IK: shoulder angles and elbow bend that put the hand on a
 * target given relative to the shoulder (chest frame). The upper arm is
 * rotated Y (swivel, chosen) then X then Z, matching the forward kinematics.
 */
const IK = { a: 0, yaw: 0, out: 0, elbow: 0 };
const _tv = new THREE.Vector3();
function solveArm(tx: number, ty: number, tz: number, side: number, swivel: number) {
  const U = UARM;
  const F = FARM + 0.035;
  _tv.set(tx, ty, tz).applyAxisAngle(_w.set(0, 1, 0), -swivel);
  const len = _tv.length() || 1;
  const d = clamp(len, Math.abs(U - F) + 0.02, U + F - 0.005);
  _tv.multiplyScalar(d / len);
  const inner = Math.acos(clamp((U * U + F * F - d * d) / (2 * U * F), -1, 1));
  const e = Math.PI - inner;
  // Hand position in the upper-arm frame after the elbow bend.
  const hy = -U - F * Math.cos(e);
  const hz = -F * Math.sin(e);
  const c = Math.asin(clamp(-_tv.x / hy, -1, 1));
  const a = Math.atan2(_tv.z, _tv.y) - Math.atan2(hz, hy * Math.cos(c));
  IK.a = a;
  IK.yaw = swivel;
  // The FK uses rz = −armOut on the left and +armOut on the right.
  IK.out = side < 0 ? -c : c;
  IK.elbow = e;
}

interface PartSet {
  meshes: Partial<Record<Part, THREE.InstancedMesh>>;
  n: number;
}

/**
 * Draws any number of articulated soldiers: one InstancedMesh per body part,
 * a detailed set for soldiers near the camera and a cheap one for the rest.
 */
export class SoldierRenderer {
  group = new THREE.Group();
  private sets: PartSet[] = [];
  private M = {
    pelvis: new THREE.Matrix4(), chest: new THREE.Matrix4(), thighL: new THREE.Matrix4(), thighR: new THREE.Matrix4(),
    shinL: new THREE.Matrix4(), shinR: new THREE.Matrix4(), footL: new THREE.Matrix4(), footR: new THREE.Matrix4(),
    uArmL: new THREE.Matrix4(), uArmR: new THREE.Matrix4(), fArmL: new THREE.Matrix4(), fArmR: new THREE.Matrix4(),
    head: new THREE.Matrix4(), gun: new THREE.Matrix4(), rifle: new THREE.Matrix4(),
  };
  /** Soldiers within this distance of the camera get the detailed model. */
  detailRange = 55;

  constructor(private capacity = 96) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const geos = [detailParts(), simpleParts()];
    geos.forEach((g, i) => {
      const set: PartSet = { meshes: {}, n: 0 };
      for (const p of PARTS) {
        const geo = g[p];
        if (!geo) continue;
        const m = new THREE.InstancedMesh(geo, material, capacity);
        m.castShadow = i === 0 && p !== 'pouches' && p !== 'eyewear' && p !== 'handL' && p !== 'handR';
        m.receiveShadow = i === 0;
        m.frustumCulled = false;
        m.count = 0;
        m.visible = false;
        m.setColorAt(0, _c.setHex(COLOR[p]));
        this.group.add(m);
        set.meshes[p] = m;
      }
      this.sets.push(set);
    });
  }

  render(list: SoldierInstance[], camPos?: THREE.Vector3) {
    const M = this.M;
    for (const set of this.sets) set.n = 0;
    for (const s of list) {
      if (!s.visible) continue;
      let set = this.sets[0];
      if (camPos) {
        const e = s.matrix.elements;
        const dx = e[12] - camPos.x;
        const dy = e[13] - camPos.y;
        const dz = e[14] - camPos.z;
        if (dx * dx + dy * dy + dz * dz > this.detailRange * this.detailRange) set = this.sets[1];
      }
      if (set.n >= this.capacity) continue;
      const n = set.n++;
      const j = s.joints;
      // Pelvis: height, whole-body pitch (prone / lying), stride yaw and sway; the torso hangs off it.
      local(M.pelvis, s.matrix, 0, j.hip, 0, -j.body, j.pelvisYaw, j.sway);
      local(M.chest, M.pelvis, 0, 0.08, 0, -j.lean, j.twist, -j.sway * 0.7);
      local(M.thighL, M.pelvis, -0.095, -0.04, 0, j.thighL, 0, -j.thighOutL);
      local(M.thighR, M.pelvis, 0.095, -0.04, 0, j.thighR, 0, j.thighOutR);
      local(M.shinL, M.thighL, 0, -THIGH, 0, -j.kneeL);
      local(M.shinR, M.thighR, 0, -THIGH, 0, -j.kneeR);
      // Feet: the joint gives pitch relative to the pelvis, so undo thigh and knee.
      local(M.footL, M.shinL, 0, -SHIN, 0, j.ankleL - j.thighL + j.kneeL);
      local(M.footR, M.shinR, 0, -SHIN, 0, j.ankleR - j.thighR + j.kneeR);
      local(M.head, M.chest, 0, 0.53, 0, j.head, j.headYaw, j.headRoll);

      // Rifle in the chest frame; hands go onto it by IK as far as they grip.
      _e.set(j.gp, j.gyaw, j.groll, 'YXZ');
      _q.setFromEuler(_e);
      M.gun.compose(_v.set(j.gx, j.gy, j.gz), _q, _one);
      let armL = j.armL;
      let outL = j.armOutL;
      let yawL = j.armYawL;
      let elL = j.elbowL;
      let armR = j.armR;
      let outR = j.armOutR;
      let yawR = j.armYawR;
      let elR = j.elbowR;
      if (j.gripR > 0.01) {
        _w.copy(GRIP_R).applyMatrix4(M.gun);
        solveArm(_w.x - SHOULDER_X, _w.y - SHOULDER_Y, _w.z, 1, -0.35);
        const k = j.gripR;
        armR += (IK.a - armR) * k;
        outR += (IK.out - outR) * k;
        yawR += (IK.yaw - yawR) * k;
        elR += (IK.elbow - elR) * k;
      }
      if (j.gripL > 0.01) {
        _w.copy(GRIP_L).applyMatrix4(M.gun);
        solveArm(_w.x + SHOULDER_X, _w.y - SHOULDER_Y, _w.z, -1, 0.25);
        const k = j.gripL;
        armL += (IK.a - armL) * k;
        outL += (IK.out - outL) * k;
        yawL += (IK.yaw - yawL) * k;
        elL += (IK.elbow - elL) * k;
      }
      if (s.hands) {
        // Reach for fixed points in the world: bring them into the chest frame first.
        _inv.copy(M.chest).invert();
        _w.copy(s.hands.r).applyMatrix4(_inv);
        solveArm(_w.x - SHOULDER_X, _w.y - SHOULDER_Y, _w.z, 1, -0.35);
        (armR = IK.a), (outR = IK.out), (yawR = IK.yaw), (elR = IK.elbow);
        _w.copy(s.hands.l).applyMatrix4(_inv);
        solveArm(_w.x + SHOULDER_X, _w.y - SHOULDER_Y, _w.z, -1, 0.25);
        (armL = IK.a), (outL = IK.out), (yawL = IK.yaw), (elL = IK.elbow);
      }
      local(M.uArmL, M.chest, -SHOULDER_X, SHOULDER_Y, 0, armL, yawL, -outL);
      local(M.uArmR, M.chest, SHOULDER_X, SHOULDER_Y, 0, armR, yawR, outR);
      local(M.fArmL, M.uArmL, 0, -UARM, 0, elL);
      local(M.fArmR, M.uArmR, 0, -UARM, 0, elR);
      M.rifle.multiplyMatrices(M.chest, M.gun);

      const frame: Record<Part, THREE.Matrix4> = {
        pelvis: M.pelvis, torso: M.chest, vest: M.chest, pouches: M.chest, pack: M.chest,
        thighL: M.thighL, thighR: M.thighR, shinL: M.shinL, shinR: M.shinR, bootL: M.footL, bootR: M.footR,
        uArmL: M.uArmL, uArmR: M.uArmR, fArmL: M.fArmL, fArmR: M.fArmR, handL: M.fArmL, handR: M.fArmR,
        head: M.head, eyewear: M.head, helmet: M.head, rifle: M.rifle,
      };
      const outfit = OUTFIT[s.outfit];
      for (const p of PARTS) {
        const mesh = set.meshes[p];
        if (!mesh) continue;
        const show = wears(s.outfit, p) && (p !== 'rifle' || s.rifle !== 'none');
        mesh.setMatrixAt(n, show ? frame[p] : ZERO);
        if (p === 'head') mesh.setColorAt(n, s.skin);
        else mesh.setColorAt(n, _c.setHex(outfit[p] ?? COLOR[p]));
      }
    }
    for (const set of this.sets)
      for (const p of PARTS) {
        const m = set.meshes[p];
        if (!m) continue;
        m.count = set.n;
        // No draw call at all when nobody's there.
        m.visible = set.n > 0;
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
