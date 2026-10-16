import * as THREE from 'three';
import { clamp, smoothstep } from '../util/math';
import type { CabinLayout } from '../game/cargo';
import type { DoorGunPort, PlayerTarget } from '../game/target';
import { CHINOOK, type Airframe, type AirframeParts, type AircraftId } from './airframe';
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
  /** The aircraft type being flown, and its scene parts (built once per type, kept for swaps). */
  airframe: Airframe = CHINOOK;
  fm = new FlightModel(CHINOOK.flight);
  parts: AirframeParts;
  /** Holds the current airframe's model (the scene keeps this one node across swaps). */
  readonly root = new THREE.Group();
  private built = new Map<AircraftId, AirframeParts>();
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
  /** Seconds until a structure scrape can hurt again (contact lasts many frames). */
  private scrapeT = 0;
  /** A rotor tip is within a metre and a half of a structure or trees. */
  rotorWarn = false;
  private rimPoints: THREE.Vector3[] = [];

  constructor(
    private world: World,
    private events: HeliEvents,
  ) {
    this.parts = this.partsFor(CHINOOK);
    this.root.add(this.parts.root);
    this.fitAirframe();
    this.fm.onTouchdown = (vs) => this.touchdown(vs);
    this.fm.onHullImpact = (s) => {
      if (this.spawnGrace > 0 || this.crashed) return;
      if (s > 7) this.crash('Hull impact');
      else this.damage((s - 2.5) * 6, 'Hull strike');
    };
  }

  private partsFor(af: Airframe): AirframeParts {
    let p = this.built.get(af.id);
    if (!p) this.built.set(af.id, (p = af.build()));
    return p;
  }

  /** Rotor rim, door guns and flares for the current airframe. */
  private fitAirframe() {
    const af = this.airframe;
    this.rimPoints = [];
    for (const hub of af.rotorHubs)
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        this.rimPoints.push(new THREE.Vector3(hub.x + Math.cos(a) * af.rotorRadius * 0.97, hub.y - 0.25, hub.z + Math.sin(a) * af.rotorRadius * 0.97));
      }
    // Right door gun and left window gun (Chinook), pointing out through their openings.
    this.doorGuns = af.cabin.gunners.map((g) => {
      const sx = Math.sign(g.pos.x);
      return { muzzle: new THREE.Vector3(sx * 2.7, g.pos.y + 1.0, g.pos.z), out: new THREE.Vector3(sx, 0, 0), aim: null, aimAge: 99, firing: false, onTarget: false };
    });
    this.gunLay = af.cabin.gunners.map(() => ({ yaw: 0, pitch: -0.2, flashT: 0 }));
    this.maxFlares = af.maxFlares;
    this.flares = Math.min(this.flares, this.maxFlares);
  }

  /** Change aircraft (on the ground at a hangar): new model, handling and cabin. Call spawn() after. */
  setAirframe(af: Airframe) {
    if (af === this.airframe) return;
    this.root.remove(this.parts.root);
    this.airframe = af;
    this.parts = this.partsFor(af);
    this.root.add(this.parts.root);
    this.fm.setSpec(af.flight);
    this.fitAirframe();
    this.rampOpen = false;
    this.rampT = 0;
  }

  /** Put the helicopter on the ground at a spot, engines off, fully repaired. */
  spawn(at: THREE.Vector3, heading: number) {
    const fm = this.fm;
    fm.pos.set(at.x, this.world.terrain.surfaceAt(at.x, at.z) - this.airframe.flight.gearY + 0.02, at.z);
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
    // Shown again after a crash (the game hides the whole aircraft node for the wreck).
    this.root.visible = true;
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
    this.rotorWarn = false;
    if (fm.rpm > 0.25) {
      for (const rp of this.rimPoints) {
        this.worldPoint(rp, _p);
        if (_p.y < terrain.surfaceAt(_p.x, _p.z) + 0.2) return this.crash('Rotor strike: terrain');
        if (vegetation.hit(_p)) return this.crash('Rotor strike: trees');
        if (colliders.hit(_p)) return this.crash('Rotor strike: structure');
        if (!this.rotorWarn && colliders.hit(_p, 1.5)) this.rotorWarn = true;
      }
    }
    const speed = fm.vel.length();
    for (const hp of this.airframe.flight.hull) {
      this.worldPoint(hp, _p);
      if (colliders.hit(_p, 0.1)) {
        if (speed > 5) return this.crash('Collision with structure');
        // A scrape: one knock per half second however long the contact lasts, bounced back off it.
        if (this.scrapeT <= 0) {
          this.damage(4, 'Structure scrape');
          this.scrapeT = 0.5;
        }
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
    this.scrapeT = Math.max(0, this.scrapeT - dt);
    if (!this.crashed) {
      // Overtorque stresses the drivetrain.
      if (fm.torquePct > 105) {
        this.overtorqueTime += dt;
        if (this.overtorqueTime > 3) this.damage((fm.torquePct - 105) * 0.04 * dt, 'Overtorque');
      } else this.overtorqueTime = Math.max(0, this.overtorqueTime - dt);
      if (fm.fuel <= 0 && fm.engineOn) fm.engineOn = false;
    }
    // Ramp (the Little Bird has none: its benches are always open).
    if (!this.airframe.hasRamp) this.rampOpen = false;
    this.rampT = clamp(this.rampT + (this.rampOpen ? dt : -dt) / 3.2, 0, 1);
    const e = smoothstep(0, 1, this.rampT);
    if (this.parts.ramp) this.parts.ramp.rotation.x = -1.3 + e * (1.3 + 0.2);
    // Cabin lights: bright with the ramp open, dim night lighting otherwise.
    if (this.parts.cabinLight) this.parts.cabinLight.intensity = 5 + e * 7;

    // Rotors (each at its own rate and sense), blades blurring into a disc as they spin up.
    this.rotorAngle += fm.rpm * dt;
    for (const r of this.parts.rotors) r.g.rotation[r.axis] = this.rotorAngle * r.rate + r.phase;
    const blur = smoothstep(0.35, 0.75, fm.rpm);
    this.parts.bladeMat.opacity = 1 - blur * 0.85;
    this.parts.bladeMat.depthWrite = blur < 0.5;
    this.parts.discMat.opacity = blur * 0.55;
    // Blade coning under load (main rotors).
    const cone = -0.025 + fm.input.collective * fm.rpm * 0.06;
    for (const r of this.parts.rotors) if (r.axis === 'y') for (const b of r.blades) b.rotation.z = cone;

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
    return this.airframe.cabin;
  }
  /** Computed from physics state (not the scene graph) so it's exact during substeps. */
  hookWorld(out: THREE.Vector3) {
    return out.copy(this.airframe.hookPos).applyQuaternion(this.fm.quat).add(this.fm.pos);
  }
  hookVelocity(out: THREE.Vector3) {
    const r = this.airframe.hookPos.clone().applyQuaternion(this.fm.quat);
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
  get hitHalfLength() {
    return this.airframe.hitHalfLength;
  }
  get hitRadius() {
    return this.airframe.hitRadius;
  }
  /** Door guns (the Chinook's right door gun and left window gun; none on a Little Bird). */
  doorGuns: DoorGunPort[] = [];
  /** Each gun's traverse and elevation relative to straight out of its opening. */
  private gunLay: { yaw: number; pitch: number; flashT: number }[] = [];
  private gunT = 0;
  get onGround() {
    return this.fm.contacts >= 3;
  }
  /** World height of the skids or wheels (level attitude). */
  get gearBottom() {
    return this.fm.pos.y + this.airframe.flight.gearY;
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

  /** Ramp fully down (always "open" on the Little Bird's benches). */
  get rampDown() {
    return !this.airframe.hasRamp || this.rampT > 0.97;
  }

  /** On the ground, stable, and slow enough for loading. */
  get loadable() {
    return !this.crashed && this.fm.contacts >= 3 && this.fm.groundSpeed < 0.8 && Math.abs(this.fm.vs) < 0.5;
  }
}

