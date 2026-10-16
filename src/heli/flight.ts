import * as THREE from 'three';
import { approach, clamp, smoothstep } from '../util/math';

export const G = 9.81;

export interface FlightEnv {
  /** Ground height, or the top of a structure (a roof) no higher than `y` when given. */
  surfaceAt(x: number, z: number, y?: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3, y?: number): THREE.Vector3;
  wind: THREE.Vector3;
}

/** Normalized pilot inputs. pitch +1 = stick forward, roll +1 = right, yaw +1 = right pedal. */
export interface FlightInput {
  collective: number;
  pitch: number;
  roll: number;
  yaw: number;
}

export const SAS_NAMES = ['RATE (manual)', 'ATTITUDE HOLD', 'HOVER HOLD'];

/** What makes one airframe fly differently from another. */
export interface FlightSpec {
  emptyMass: number;
  fuelCapacity: number;
  /** Rotor thrust at full collective and RPM, sea level (kg). */
  maxThrustKg: number;
  /** Pitch, yaw, roll inertia (kg m²) at `refMass`, scaled with mass. */
  inertia: [number, number, number];
  refMass: number;
  /** Quadratic fuselage drag along body x, y, z. */
  drag: [number, number, number];
  /** Fuel flow scale (1 = the Chinook's twin turbines). */
  fuelBurn: number;
  /** Control rate and authority scale (1 = Chinook). */
  agility: number;
  /** Gear contact plane, wheel or skid contact points, hull scrape points (body frame). */
  gearY: number;
  wheels: THREE.Vector3[];
  hull: THREE.Vector3[];
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Rigid-body tandem-rotor flight model.
 * Linear state in world frame, angular velocity in body frame.
 */
export class FlightModel {
  constructor(public spec: FlightSpec) {
    this.setSpec(spec);
  }

  /** Change airframe (aircraft swap): mass, tanks and handling. */
  setSpec(spec: FlightSpec) {
    this.spec = spec;
    this.emptyMass = spec.emptyMass;
    this.fuelCapacity = spec.fuelCapacity;
    this.fuel = Math.min(this.fuel, spec.fuelCapacity);
  }

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  angVel = new THREE.Vector3();

  emptyMass = 10400;
  extraMass = 0;
  fuelCapacity = 2400;
  fuel = 2400;
  payload = 0;
  thrustScale = 1;

  engineOn = false;
  engineSpool = 0;
  rpm = 0;
  sas = 1;
  input: FlightInput = { collective: 0, pitch: 0, roll: 0, yaw: 0 };
  /**
   * Assisted climb (the GTA-style controls): `climb` (-1..1) asks for a rate
   * of climb or descent and the collective is flown for you; let go and it
   * holds the altitude. Descents slow down near the ground, and on the
   * ground with nothing held the lever goes down so the aircraft sits.
   */
  assist = false;
  climb = 0;
  private holdY: number | null = null;

  // Telemetry.
  thrust = 0;
  torquePct = 0;
  agl = 0;
  airspeed = 0;
  groundSpeed = 0;
  vs = 0;
  vrs = 0;
  etl = 0;
  ige = 0;
  loadFactor = 1;
  contacts = 0;
  hullContact = 0;
  pitch = 0;
  roll = 0;
  heading = 0;
  settled = false;
  /** Called on first wheel contact with the (negative) vertical speed. */
  onTouchdown: ((vs: number) => void) | null = null;
  /** Called when the hull itself hits the ground hard. */
  onHullImpact: ((speed: number) => void) | null = null;

  private settleTimer = 0;
  private prevContacts = 0;
  private prevVel = new THREE.Vector3();
  private buffetPhase = 0;

  get mass() {
    return this.emptyMass + this.extraMass + this.fuel + this.payload;
  }

  get maxThrust() {
    return this.spec.maxThrustKg * G * this.thrustScale;
  }

  get landed() {
    return this.contacts >= 3 && this.vel.lengthSq() < 0.5;
  }

  /** Inertia (body x = pitch, y = yaw, z = roll), scaled with mass. */
  inertia(out: THREE.Vector3) {
    const s = this.mass / this.spec.refMass;
    const I = this.spec.inertia;
    return out.set(I[0] * s, I[1] * s, I[2] * s);
  }

  /** Apply a world-space impulse at a world-space point. */
  applyImpulse(J: THREE.Vector3, point: THREE.Vector3) {
    const m = this.mass;
    this.vel.addScaledVector(J, 1 / m);
    _qi.copy(this.quat).invert();
    const r = _v1.copy(point).sub(this.pos).applyQuaternion(_qi);
    const jb = _v2.copy(J).applyQuaternion(_qi);
    const t = r.cross(jb);
    const I = this.inertia(_v3);
    this.angVel.x += t.x / I.x;
    this.angVel.y += t.y / I.y;
    this.angVel.z += t.z / I.z;
    if (J.lengthSq() > 1) this.settled = false;
  }

  private assistCollective(dt: number, up: THREE.Vector3, vay: number, hs: number, density: number): number {
    const c = this.climb;
    let target = 0;
    if (this.rpm < 0.85 || (this.contacts >= 2 && c <= 0.05)) {
      this.holdY = null;
    } else {
      let vsDes: number;
      if (Math.abs(c) > 0.05) {
        // Down: no faster than the vortex ring allows at low speed, easing off toward the ground.
        const maxDown = Math.min(hs < 10 ? 5 : 7, 1.2 + Math.max(0, this.agl - 1) * 0.35);
        vsDes = c > 0 ? c * 7.5 : c * maxDown;
        this.holdY = null;
      } else {
        // Hold where the climb or descent stops (allowing for the overshoot).
        if (this.holdY === null) this.holdY = this.pos.y + this.vel.y * 0.6;
        vsDes = clamp((this.holdY - this.pos.y) * 0.8, -3, 3);
      }
      // Vertical acceleration wanted, plus what the rotor's own vertical damping takes away.
      const aDes = clamp((vsDes - this.vel.y) * 1.5, -4, 4) + 0.26 * vay * this.rpm;
      const unit = this.maxThrust * this.rpm * this.rpm * (1 + 0.18 * this.ige) * (1 + 0.12 * this.etl) * density * (1 - 0.28 * this.vrs);
      target = clamp((this.mass * (G + aDes)) / (unit * Math.max(0.5, up.y)), 0, 0.92);
    }
    // The lever moves at a hand's pace.
    return approach(this.input.collective, target, dt * 1.2);
  }

  step(dt: number, env: FlightEnv) {
    const m = this.mass;
    const q = this.quat;
    _qi.copy(q).invert();
    const inp = this.input;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    this.roll = Math.atan2(-right.y, up.y);
    this.heading = Math.atan2(fwd.x, -fwd.z);

    // --- Air data -------------------------------------------------------
    const va = _v1.copy(this.vel).sub(env.wind);
    const vaBody = va.clone().applyQuaternion(_qi);
    const hs = Math.hypot(va.x, va.z);
    this.airspeed = va.length();
    this.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.vs = this.vel.y;
    // Height above whatever is below the gear: the ground, or a roof.
    const ground = env.surfaceAt(this.pos.x, this.pos.z, this.pos.y + this.spec.gearY + 0.6);
    this.agl = this.pos.y + this.spec.gearY - ground;

    // --- Engines & rotor RPM ------------------------------------------
    const fuelOk = this.fuel > 0;
    this.engineSpool = clamp(this.engineSpool + (this.engineOn && fuelOk ? dt / 9 : -dt / 12), 0, 1);
    const drive = this.engineSpool * this.engineSpool * (3 - 2 * this.engineSpool);
    const droop = Math.max(0, inp.collective - 0.93) * 1.8 * drive;
    const rpmTarget = drive * (1 - droop);
    if (this.rpm < rpmTarget) {
      this.rpm = Math.min(rpmTarget, this.rpm + dt * 0.35);
    } else {
      // Not driven: blade inertia, with descent airflow windmilling the rotor (autorotation).
      const airborne = this.contacts === 0 ? 1 : 0;
      const windmill = clamp(-va.y * 0.035, 0, 0.45) * airborne + smoothstep(20, 50, hs) * 0.06 * airborne;
      const decay = 0.035 + 0.3 * inp.collective;
      this.rpm = Math.max(rpmTarget, this.rpm + (windmill * (1.06 - this.rpm) * 2.2 - decay * this.rpm) * dt);
    }
    this.rpm = clamp(this.rpm, 0, 1.1);
    if (this.engineSpool > 0.02 && fuelOk) this.fuel = Math.max(0, this.fuel - (0.25 + 1.1 * inp.collective) * this.spec.fuelBurn * this.engineSpool * dt);
    this.torquePct = (inp.collective / 0.9) * 100 * drive;

    // --- Rotor thrust ---------------------------------------------------
    this.ige = clamp(1 - this.agl / 18, 0, 1) ** 1.5;
    this.etl = smoothstep(5, 16, hs);
    this.vrs = smoothstep(-6.5, -11, va.y) * (1 - smoothstep(5, 10, hs)) * smoothstep(0.15, 0.4, inp.collective);
    const density = 1 - clamp(this.pos.y, 0, 3000) * 0.00007;
    if (this.assist) inp.collective = this.assistCollective(dt, up, va.y, hs, density);
    const T =
      inp.collective * this.maxThrust * this.rpm * this.rpm * (1 + 0.18 * this.ige) * (1 + 0.12 * this.etl) * density * (1 - 0.28 * this.vrs);
    this.thrust = T;
    const tdir = _v2
      .copy(up)
      .addScaledVector(fwd, inp.pitch * 0.05)
      .addScaledVector(right, inp.roll * 0.05)
      .normalize();

    const F = new THREE.Vector3().addScaledVector(tdir, T);
    F.y -= m * G;
    // Fuselage drag (body frame, quadratic) + rotor damping.
    const db = new THREE.Vector3(
      -this.spec.drag[0] * Math.abs(vaBody.x) * vaBody.x - m * 0.05 * vaBody.x * this.rpm,
      -this.spec.drag[1] * Math.abs(vaBody.y) * vaBody.y,
      -this.spec.drag[2] * Math.abs(vaBody.z) * vaBody.z - m * 0.025 * vaBody.z * this.rpm,
    ).applyQuaternion(q);
    F.add(db);
    F.y -= m * 0.26 * va.y * this.rpm;

    // --- Control laws -> desired body rates ---------------------------
    const wDes = new THREE.Vector3();
    const hsF = smoothstep(12, 30, hs);
    if (this.sas >= 1) {
      let tp = -inp.pitch * 0.44;
      let tr = inp.roll * 0.52;
      // Wind trim: lean into the wind so a hands-off hover doesn't get blown away.
      // Fades out with airspeed, where wind only bends the ground track.
      const trimF = 1 - smoothstep(12, 25, hs);
      if (trimF > 0) {
        const hfw = _v3.set(fwd.x, 0, fwd.z).normalize();
        const wf = env.wind.x * hfw.x + env.wind.z * hfw.z;
        const wr = env.wind.x * -hfw.z + env.wind.z * hfw.x;
        const af = (0.025 * this.rpm * wf + (this.spec.drag[2] * Math.abs(wf) * wf) / m) / G;
        const ar = (0.05 * this.rpm * wr + (this.spec.drag[0] * Math.abs(wr) * wr) / m) / G;
        tp += Math.atan(af) * trimF;
        tr -= Math.atan(ar) * trimF;
      }
      // Hover hold below 15 m/s; with the assisted (GTA-style) controls, letting go of the stick
      // also slows the aircraft to a hover from any speed, nose up a little at most.
      if (this.sas === 2 && Math.abs(inp.pitch) < 0.05 && Math.abs(inp.roll) < 0.05 && (this.groundSpeed < 15 || this.assist)) {
        const hf = _v3.set(fwd.x, 0, fwd.z).normalize();
        const vf = this.vel.dot(hf);
        const hr = new THREE.Vector3(right.x, 0, right.z).normalize();
        const vr = this.vel.dot(hr);
        tp = clamp(vf * 0.05, -0.18, 0.18);
        tr = clamp(-vr * 0.05, -0.18, 0.18);
      }
      const ag = this.spec.agility;
      wDes.x = clamp(1.6 * ag * (tp - this.pitch), -0.42 * ag, 0.42 * ag);
      wDes.z = clamp(-1.7 * ag * (tr - this.roll), -0.6 * ag, 0.6 * ag);
    } else {
      wDes.x = -inp.pitch * 0.45 - this.pitch * 0.12;
      wDes.z = -inp.roll * 0.7 + this.roll * 0.12;
    }
    // Yaw about the world vertical: pedals, coordinated turns and weathervaning.
    let yawW = -inp.yaw * 0.55 * this.spec.agility * (1 - 0.45 * hsF);
    yawW += ((-G * Math.tan(clamp(this.roll, -1.1, 1.1))) / Math.max(hs, 12)) * hsF * (this.sas >= 1 ? 1 : 0.6);
    yawW += -clamp(vaBody.x / Math.max(hs, 8), -1, 1) * 0.7 * hsF;
    const worldUpB = _v3.copy(UP).applyQuaternion(_qi);
    wDes.addScaledVector(worldUpB, yawW);

    const hoverRatio = T / (m * G);
    const auth = this.rpm * this.rpm * clamp(0.18 + hoverRatio * 0.9, 0.18, 1.15);
    const iscale = Math.sqrt(m / this.spec.refMass) / this.spec.agility;
    const aMax = [1.5 * auth / iscale, 1.0 * auth / iscale, 2.0 * auth / iscale];
    const kR = 4.5;
    const w = this.angVel;
    const alpha = new THREE.Vector3(
      clamp((wDes.x - w.x) * kR, -aMax[0], aMax[0]),
      clamp((wDes.y - w.y) * kR, -aMax[1], aMax[1]),
      clamp((wDes.z - w.z) * kR, -aMax[2], aMax[2]),
    );
    // Vortex-ring buffeting.
    if (this.vrs > 0.05) {
      this.buffetPhase += dt * 9;
      alpha.x += Math.sin(this.buffetPhase * 1.7) * this.vrs * 0.7;
      alpha.z += Math.sin(this.buffetPhase * 2.3 + 1) * this.vrs * 0.9;
    }

    // --- Ground contact -------------------------------------------------
    const contactTorque = new THREE.Vector3();
    const omegaW = w.clone().applyQuaternion(q);
    let contacts = 0;
    let hull = 0;
    let worstVn = 0;
    const k = (m * G) / (4 * 0.09);
    const c = 2 * 0.55 * Math.sqrt((k * m) / 4);
    const mw = m / 4;
    const doContact = (local: THREE.Vector3, isWheel: boolean) => {
      const r = local.clone().applyQuaternion(q);
      const px = this.pos.x + r.x;
      const py = this.pos.y + r.y;
      const pz = this.pos.z + r.z;
      const h = env.surfaceAt(px, pz, py + 0.6);
      const d = h - py;
      if (d <= 0) return;
      env.normalAt(px, pz, _n, py + 0.6);
      const vp = new THREE.Vector3().crossVectors(omegaW, r).add(this.vel);
      const vn = vp.dot(_n);
      const kk = isWheel ? k : k * 2.5;
      const Fn = Math.max(0, kk * d - c * vn);
      const f = _n.clone().multiplyScalar(Fn);
      const vt = vp.addScaledVector(_n, -vn);
      const rollDir = fwd.clone().addScaledVector(_n, -fwd.dot(_n)).normalize();
      const latDir = new THREE.Vector3().crossVectors(_n, rollDir);
      const vr = vt.dot(rollDir);
      const vl = vt.dot(latDir);
      const muR = isWheel ? 0.35 : 0.6;
      const muL = isWheel ? 0.75 : 0.6;
      const gain = (mw / dt) * 0.3;
      f.addScaledVector(rollDir, -Math.sign(vr) * Math.min(muR * Fn, Math.abs(vr) * gain));
      f.addScaledVector(latDir, -Math.sign(vl) * Math.min(muL * Fn, Math.abs(vl) * gain));
      F.add(f);
      contactTorque.add(r.cross(f));
      if (isWheel) contacts++;
      else hull++;
      worstVn = Math.min(worstVn, vn);
    };
    for (const wl of this.spec.wheels) doContact(wl, true);
    for (const hp of this.spec.hull) doContact(hp, false);
    this.contacts = contacts;
    this.hullContact = hull;
    if (contacts > 0 && this.prevContacts === 0) this.onTouchdown?.(this.vel.y);
    if (hull > 0 && worstVn < -2.5) this.onHullImpact?.(-worstVn);
    this.prevContacts = contacts;

    // --- Settling on the ground (avoids creep/jitter when parked) ------
    const restful = contacts >= 3 && inp.collective < 0.3 && this.vel.lengthSq() < 0.04 && w.lengthSq() < 0.003;
    this.settleTimer = restful ? this.settleTimer + dt : 0;
    if (this.settleTimer > 0.4) this.settled = true;
    if (!restful && (inp.collective >= 0.3 || contacts < 3)) this.settled = false;

    // --- Integrate ------------------------------------------------------
    this.prevVel.copy(this.vel);
    if (this.settled) {
      this.vel.set(0, 0, 0);
      this.angVel.set(0, 0, 0);
    } else {
      this.vel.addScaledVector(F, dt / m);
      this.pos.addScaledVector(this.vel, dt);
      const I = this.inertia(_v3);
      const tb = contactTorque.applyQuaternion(_qi);
      w.x += (alpha.x + tb.x / I.x) * dt;
      w.y += (alpha.y + tb.y / I.y) * dt;
      w.z += (alpha.z + tb.z / I.z) * dt;
      const wl = w.length();
      if (wl > 1e-7) {
        _q.setFromAxisAngle(_v2.copy(w).divideScalar(wl), wl * dt);
        q.multiply(_q).normalize();
      }
    }
    const acc = _v2.copy(this.vel).sub(this.prevVel).divideScalar(dt);
    acc.y += G;
    this.loadFactor = acc.dot(up) / G;
  }
}
