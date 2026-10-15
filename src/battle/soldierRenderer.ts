import * as THREE from 'three';
import type { Side } from './campaign';
import {
  SoldierRenderer as BodyRenderer,
  blendJoints,
  dead,
  dig,
  gait,
  hold,
  idle,
  kneel,
  prone,
  randomSkin,
  rootMatrix,
  standJoints,
  type Joints,
  type RifleCarry,
  type SoldierInstance,
} from '../game/soldiers';

export type Pose = 'stand' | 'run' | 'kneel' | 'prone' | 'dead' | 'dig';

export interface SoldierView {
  pos: THREE.Vector3;
  heading: number;
  pose: Pose;
  phase: number;
  side: Side;
  /** Extra vertical offset (negative = standing in a trench). */
  sink: number;
  /** Firing this moment (brings the rifle up to the shoulder). */
  aiming: boolean;
}

/** Per-soldier animation state, kept between frames so poses blend instead of snapping. */
interface Anim {
  inst: SoldierInstance;
  target: Joints;
  seed: number;
  /** Which way they fell. */
  fall: number;
  /** Seconds since last aiming: soldiers keep the rifle up briefly between shots. */
  sinceAim: number;
}

const _pos = new THREE.Vector3();

/** Battlefield infantry for both sides, drawn with the same articulated model as everyone else. */
export class SoldierRenderer {
  group: THREE.Group;
  private bodies: BodyRenderer;
  private anims = new WeakMap<SoldierView, Anim>();
  private list: SoldierInstance[] = [];
  private time = 0;

  constructor(capacity: number) {
    this.bodies = new BodyRenderer(capacity);
    // Battlefields are big: only the soldiers right by the camera get full detail.
    this.bodies.detailRange = 45;
    this.group = this.bodies.group;
  }

  private anim(s: SoldierView): Anim {
    let a = this.anims.get(s);
    if (!a) {
      const joints = standJoints();
      a = {
        inst: { matrix: new THREE.Matrix4(), joints, rifle: 'hands', outfit: s.side === 'blue' ? 'infantry' : 'enemy', skin: randomSkin(Math.random), visible: true },
        target: standJoints(),
        seed: Math.random() * 10,
        fall: Math.random(),
        sinceAim: 99,
      };
      // Start in the right pose rather than blending in from standing.
      this.pose(s, a);
      Object.assign(joints, a.target);
      this.anims.set(s, a);
    }
    return a;
  }

  private pose(s: SoldierView, a: Anim) {
    const t = this.time;
    let carry: RifleCarry = 'hands';
    const aim = s.aiming || a.sinceAim < 1.2;
    switch (s.pose) {
      case 'run':
        gait(a.target, s.phase, 3.4, 0.75);
        break;
      case 'kneel':
        kneel(a.target);
        if (aim) carry = 'aim';
        break;
      case 'prone':
        prone(a.target, t + a.seed);
        break;
      case 'dead':
        dead(a.target, a.fall);
        carry = 'none';
        break;
      case 'dig':
        dig(a.target, s.phase);
        carry = 'back';
        break;
      default:
        idle(a.target, t, a.seed);
        if (aim) carry = 'aim';
    }
    a.inst.rifle = carry;
    hold(a.target, carry);
  }

  render(views: SoldierView[], dt = 1 / 60, camPos?: THREE.Vector3) {
    this.time += dt;
    this.list.length = 0;
    for (const s of views) {
      const a = this.anim(s);
      a.sinceAim = s.aiming ? 0 : a.sinceAim + dt;
      this.pose(s, a);
      // Falling is quick; everything else eases.
      blendJoints(a.inst.joints, a.target, dt, s.pose === 'dead' ? 6 : 8);
      rootMatrix(a.inst.matrix, _pos.set(s.pos.x, s.pos.y + s.sink, s.pos.z), s.heading);
      this.list.push(a.inst);
    }
    this.bodies.render(this.list, camPos);
  }
}
