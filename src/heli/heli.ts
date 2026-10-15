import * as THREE from 'three';
import { clamp, smoothstep } from '../util/math';
import type { CabinLayout } from '../game/cargo';
import type { DoorGunPort, PlayerTarget } from '../game/target';
import { buildChinook, CABIN, AFT_HUB, FRONT_HUB, GEAR_Y, HOOK_POS, HULL_POINTS, ROTOR_RADIUS, type ChinookParts } from './chinookModel';
import { FlightModel, type FlightEnv } from './flight';
import type { World } from '../world/worldgen';

export type LandingRating = 'BUTTER' | 'SMOOTH' | 'FIRM' | 'HARD' | 'VERY HARD';

export interface HeliEvents {
  onLanding(rating: LandingRating, vs: number): void;
  onDamage(amount: number, source: string): void;
  onCrash(reason: string): void;
}

const _p = new THREE.Vector3();
const _qi = new THREE.Quaternion();

export class Heli implements PlayerTarget {
  readonly kind = 'air' as const;
  fm = new FlightModel();
  parts: ChinookParts;
  hp = 100;
  armor = 0;
  crashed = false;
  crashReason = '';
  rampOpen = false;
  rampT = 0;
  flares = 30;
  maxFlares = 30;
  overtorqueTime = 0;
  lastLanding: LandingRating | null = null;
  private rotorAngle = 0;
  private strobeT = 0;
  private spawnGrace = 1;
  private rimPoints: THREE.Vector3[] = [];

  constructor(
    private world: World,
    private events: HeliEvents,
  ) {
    this.parts = buildChinook();
    for (const hub of [FRONT_HUB, AFT_HUB])
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        this.rimPoints.push(new THREE.Vector3(hub.x + Math.cos(a) * ROTOR_RADIUS * 0.97, hub.y - 0.25, hub.z + Math.sin(a) * ROTOR_RADIUS * 0.97));
      }
    this.fm.onTouchdown = (vs) => this.touchdown(vs);
    this.fm.onHullImpact = (s) => {
      if (this.spawnGrace > 0 || this.crashed) return;
      if (s > 7) this.crash('Hull impact');
      else this.damage((s - 2.5) * 6, 'Hull strike');
    };
  }

  get root() {
    return this.parts.root;
  }

  /** Put the helicopter on the ground at a spot, engines off, fully repaired. */
  spawn(at: THREE.Vector3, heading: number) {
    const fm = this.fm;
    fm.pos.set(at.x, this.world.terrain.surfaceAt(at.x, at.z) - GEAR_Y + 0.02, at.z);
    fm.vel.set(0, 0, 0);
    fm.angVel.set(0, 0, 0);
    fm.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    fm.engineOn = false;
    fm.engineSpool = 0;
    fm.rpm = 0;
    fm.input.collective = 0;
    fm.payload = 0;
    this.crashed = false;
    this.rampOpen = false;
    this.rampT = 0;
    this.spawnGrace = 1.5;
    this.overtorqueTime = 0;
    this.parts.root.visible = true;
    this.syncTransform();
  }

  physicsStep(dt: number, env: FlightEnv) {
    if (this.crashed) return;
    this.fm.step(dt, env);
  }

  private touchdown(vs: number) {
    if (this.spawnGrace > 0 || this.crashed) return;
    const v = -vs;
    const lateral = this.fm.groundSpeed;
    let rating: LandingRating;
    if (v > 6.5) return this.crash('Impact with terrain');
    if (v < 0.5) rating = 'BUTTER';
    else if (v < 1.2) rating = 'SMOOTH';
    else if (v < 2.2) rating = 'FIRM';
    else if (v < 3.5) rating = 'HARD';
    else rating = 'VERY HARD';
    if (lateral > 7 && rating !== 'VERY HARD') rating = 'HARD';
    if (v >= 2.2) this.damage((v - 2.2) * (v >= 3.5 ? 10 : 6), 'Hard landing');
    this.lastLanding = rating;
    this.events.onLanding(rating, v);
  }

  damage(amount: number, source: string) {
    if (this.crashed || amount <= 0) return;
    const a = amount * (1 - this.armor);
    this.hp = Math.max(0, this.hp - a);
    this.events.onDamage(a, source);
    if (this.hp <= 0) this.crash(source === 'Missile' ? 'Shot down by missile' : 'Airframe destroyed');
  }

  crash(reason: string) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.hp = 0;
    this.events.onCrash(reason);
  }

  worldPoint(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).applyQuaternion(this.fm.quat).add(this.fm.pos);
  }

  /** Rotor strikes, trees and structures. */
  checkCollisions() {
    if (this.crashed || this.spawnGrace > 0) return;
    const { terrain, vegetation, colliders } = this.world;
    const fm = this.fm;
    if (fm.rpm > 0.25) {
      for (const rp of this.rimPoints) {
        this.worldPoint(rp, _p);
        if (_p.y < terrain.surfaceAt(_p.x, _p.z) + 0.2) return this.crash('Rotor strike: terrain');
        if (vegetation.hit(_p)) return this.crash('Rotor strike: trees');
        if (colliders.hit(_p)) return this.crash('Rotor strike: structure');
      }
    }
    const speed = fm.vel.length();
    for (const hp of HULL_POINTS) {
      this.worldPoint(hp, _p);
      if (colliders.hit(_p, 0.1)) {
        if (speed > 5) return this.crash('Collision with structure');
        this.damage(4, 'Structure scrape');
        fm.vel.multiplyScalar(-0.4);
        return;
      }
      if (speed > 8 && vegetation.hit(_p)) return this.crash('Flew into trees');
    }
    if (fm.contacts > 0 && (Math.abs(fm.roll) > 0.75 || Math.abs(fm.pitch) > 0.6) && fm.rpm > 0.3) this.crash('Dynamic rollover');
  }

  update(dt: number, cockpitView: boolean) {
    const fm = this.fm;
    this.spawnGrace = Math.max(0, this.spawnGrace - dt);
    if (!this.crashed) {
      // Overtorque stresses the drivetrain.
      if (fm.torquePct > 105) {
        this.overtorqueTime += dt;
        if (this.overtorqueTime > 3) this.damage((fm.torquePct - 105) * 0.04 * dt, 'Overtorque');
      } else this.overtorqueTime = Math.max(0, this.overtorqueTime - dt);
      if (fm.fuel <= 0 && fm.engineOn) fm.engineOn = false;
    }
    // Ramp.
    this.rampT = clamp(this.rampT + (this.rampOpen ? dt : -dt) / 3.2, 0, 1);
    const e = smoothstep(0, 1, this.rampT);
    this.parts.ramp.rotation.x = -1.3 + e * (1.3 + 0.2);
    this.parts.rearOpening.visible = false;
    // Cabin lights: bright with the ramp open, dim night lighting otherwise.
    this.parts.cabinLight.intensity = 5 + e * 7;

    // Rotors: CCW forward, CW aft (seen from above), 225 RPM at 100%.
    this.rotorAngle += fm.rpm * 23.6 * dt;
    this.parts.frontRotor.rotation.y = this.rotorAngle;
    this.parts.aftRotor.rotation.y = -this.rotorAngle + 0.5;
    const blur = smoothstep(0.35, 0.75, fm.rpm);
    this.parts.bladeMat.opacity = 1 - blur * 0.85;
    this.parts.bladeMat.depthWrite = blur < 0.5;
    this.parts.discMat.opacity = blur * 0.55;
    // Blade coning under load.
    const cone = -0.025 + fm.input.collective * fm.rpm * 0.06;
    for (const b of [...this.parts.frontBlades, ...this.parts.aftBlades]) b.rotation.z = cone;

    // Anti-collision strobe.
    this.strobeT += dt;
    const on = fm.engineSpool > 0.05 && this.strobeT % 1.1 < 0.09;
    this.parts.strobeMat.color.setHex(on ? 0xffffff : 0x551010);
    this.syncTransform();
    this.updateDoorGuns(dt);
  }

  /**
   * Swing each door gun toward what its gunner is engaging, at the rate a man
   * can traverse a pintle mount; scan the ground slowly when there's nothing.
   */
  private updateDoorGuns(dt: number) {
    this.gunT += dt;
    const t = this.gunT;
    const fm = this.fm;
    _qi.copy(fm.quat).invert();
    this.parts.doorGuns.forEach((m, i) => {
      const port = this.doorGuns[i];
      const lay = this.gunLay[i];
      port.aimAge += dt;
      if (port.aimAge > 0.5) port.firing = false;
      const parent = m.mount.parent!;
      parent.updateWorldMatrix(true, false);
      let yaw: number;
      let pitch: number;
      const engaged = !!port.aim && port.aimAge < 0.5 && !this.crashed;
      if (engaged) {
        _p.copy(port.aim!);
        parent.worldToLocal(_p).sub(m.mount.position);
        yaw = Math.atan2(-_p.x, -_p.z) - m.baseYaw;
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        pitch = Math.atan2(_p.y, Math.hypot(_p.x, _p.z));
      } else {
        // Scanning: a slow sweep across the arc, barrel a little down.
        yaw = 0.55 * Math.sin(t * 0.21 + i * 2.1) + 0.15 * Math.sin(t * 0.67 + i);
        pitch = -0.28 + 0.1 * Math.sin(t * 0.33 + i * 1.3);
      }
      yaw = clamp(yaw, -1.3, 1.3);
      pitch = clamp(pitch, -1.05, 0.35);
      const rate = (engaged ? 2.4 : 0.5) * dt;
      lay.yaw += clamp(yaw - lay.yaw, -rate, rate);
      lay.pitch += clamp(pitch - lay.pitch, -rate, rate);
      port.onTarget = engaged && Math.abs(yaw - lay.yaw) < 0.06 && Math.abs(pitch - lay.pitch) < 0.06;
      // Firing: the gun shudders on its mount and the muzzle flashes.
      let jy = 0;
      let jp = 0;
      if (port.firing) {
        jy = (Math.random() - 0.5) * 0.025;
        jp = Math.random() * 0.03;
        lay.flashT -= dt;
        if (lay.flashT <= 0) lay.flashT = 0.085;
        m.flash.visible = lay.flashT > 0.045;
        m.flash.scale.setScalar(0.7 + Math.random() * 0.6);
        m.flash.rotation.z = Math.random() * Math.PI;
      } else m.flash.visible = false;
      m.mount.rotation.y = m.baseYaw + lay.yaw + jy;
      m.mount.rotation.x = lay.pitch + jp;
      m.mount.updateMatrixWorld(true);
      // Rounds leave from the real muzzle (body frame, for the battle's tracers).
      m.muzzle.getWorldPosition(_p);
      port.muzzle.copy(_p.sub(fm.pos).applyQuaternion(_qi));
    });
  }

  syncTransform() {
    this.parts.root.position.copy(this.fm.pos);
    this.parts.root.quaternion.copy(this.fm.quat);
  }

  /** Where people walk to in order to board. */
  rampEndWorld(out: THREE.Vector3) {
    return this.parts.rampEnd.getWorldPosition(out);
  }
  cabinWorld(out: THREE.Vector3) {
    return this.parts.cabinPoint.getWorldPosition(out);
  }
  get cabinFrame(): THREE.Object3D {
    return this.parts.exterior;
  }
  get cabinLayout(): CabinLayout {
    return CABIN;
  }
  /** Computed from physics state (not the scene graph) so it's exact during substeps. */
  hookWorld(out: THREE.Vector3) {
    return out.copy(HOOK_POS).applyQuaternion(this.fm.quat).add(this.fm.pos);
  }
  hookVelocity(out: THREE.Vector3) {
    const r = HOOK_POS.clone().applyQuaternion(this.fm.quat);
    const w = this.fm.angVel.clone().applyQuaternion(this.fm.quat);
    return out.crossVectors(w, r).add(this.fm.vel);
  }

  /** Heading-only rotation, handy for cameras. */
  yawQuat(out: THREE.Quaternion) {
    return out.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.fm.heading);
  }

  get pos() {
    return this.fm.pos;
  }
  // PlayerTarget: what enemy fire and battles aim at.
  get vel() {
    return this.fm.vel;
  }
  get quat() {
    return this.fm.quat;
  }
  get agl() {
    return this.fm.agl;
  }
  get groundSpeed() {
    return this.fm.groundSpeed;
  }
  get destroyed() {
    return this.crashed;
  }
  readonly hitHalfLength = 7;
  readonly hitRadius = 2.3;
  /** Right door gun and left window gun, pointing out through their openings. */
  readonly doorGuns: DoorGunPort[] = CABIN.gunners.map((g) => {
    const sx = Math.sign(g.pos.x);
    return { muzzle: new THREE.Vector3(sx * 2.7, g.pos.y + 1.0, g.pos.z), out: new THREE.Vector3(sx, 0, 0), aim: null, aimAge: 99, firing: false, onTarget: false };
  });
  /** Each gun's traverse and elevation relative to straight out of its opening. */
  private gunLay = CABIN.gunners.map(() => ({ yaw: 0, pitch: -0.2, flashT: 0 }));
  private gunT = 0;
  get onGround() {
    return this.fm.contacts >= 3;
  }
  get loadFactor() {
    return this.fm.loadFactor;
  }
  get roll() {
    return this.fm.roll;
  }
  get pitch() {
    return this.fm.pitch;
  }

  get rampDown() {
    return this.rampT > 0.97;
  }

  /** On the ground, stable, and slow enough for loading. */
  get loadable() {
    return !this.crashed && this.fm.contacts >= 3 && this.fm.groundSpeed < 0.8 && Math.abs(this.fm.vs) < 0.5;
  }
}

