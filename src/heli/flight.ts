import * as THREE from 'three';
import { clamp, smoothstep } from '../util/math';
import { GEAR_Y, HULL_POINTS, WHEELS } from './chinookModel';

export const G = 9.81;

export interface FlightEnv {
  surfaceAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
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
    return 25000 * G * this.thrustScale;
  }

  get landed() {
    return this.contacts >= 3 && this.vel.lengthSq() < 0.5;
  }

  /** Inertia (body x = pitch, y = yaw, z = roll), scaled with mass. */
  inertia(out: THREE.Vector3) {
    const s = this.mass / 12500;
    return out.set(2.6e5 * s, 2.4e5 * s, 6.5e4 * s);
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
    const ground = env.surfaceAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y + GEAR_Y - ground;

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
    if (this.engineSpool > 0.02 && fuelOk) this.fuel = Math.max(0, this.fuel - (0.25 + 1.1 * inp.collective) * this.engineSpool * dt);
    this.torquePct = (inp.collective / 0.9) * 100 * drive;

    // --- Rotor thrust ---------------------------------------------------
    this.ige = clamp(1 - this.agl / 18, 0, 1) ** 1.5;
    this.etl = smoothstep(5, 16, hs);
    this.vrs = smoothstep(-6.5, -11, va.y) * (1 - smoothstep(5, 10, hs)) * smoothstep(0.15, 0.4, inp.collective);
    const density = 1 - clamp(this.pos.y, 0, 3000) * 0.00007;
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
      -28 * Math.abs(vaBody.x) * vaBody.x - m * 0.05 * vaBody.x * this.rpm,
      -22 * Math.abs(vaBody.y) * vaBody.y,
      -7 * Math.abs(vaBody.z) * vaBody.z - m * 0.025 * vaBody.z * this.rpm,
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
        const af = (0.025 * this.rpm * wf + (7 * Math.abs(wf) * wf) / m) / G;
        const ar = (0.05 * this.rpm * wr + (28 * Math.abs(wr) * wr) / m) / G;
        tp += Math.atan(af) * trimF;
        tr -= Math.atan(ar) * trimF;
      }
      if (this.sas === 2 && Math.abs(inp.pitch) < 0.05 && Math.abs(inp.roll) < 0.05 && this.groundSpeed < 15) {
        const hf = _v3.set(fwd.x, 0, fwd.z).normalize();
        const vf = this.vel.dot(hf);
        const hr = new THREE.Vector3(right.x, 0, right.z).normalize();
        const vr = this.vel.dot(hr);
        tp = clamp(vf * 0.05, -0.18, 0.18);
        tr = clamp(-vr * 0.05, -0.18, 0.18);
      }
      wDes.x = clamp(1.6 * (tp - this.pitch), -0.42, 0.42);
      wDes.z = clamp(-1.7 * (tr - this.roll), -0.6, 0.6);
    } else {
      wDes.x = -inp.pitch * 0.45 - this.pitch * 0.12;
      wDes.z = -inp.roll * 0.7 + this.roll * 0.12;
    }
    // Yaw about the world vertical: pedals, coordinated turns and weathervaning.
    let yawW = -inp.yaw * 0.55 * (1 - 0.45 * hsF);
    yawW += ((-G * Math.tan(clamp(this.roll, -1.1, 1.1))) / Math.max(hs, 12)) * hsF * (this.sas >= 1 ? 1 : 0.6);
    yawW += -clamp(vaBody.x / Math.max(hs, 8), -1, 1) * 0.7 * hsF;
    const worldUpB = _v3.copy(UP).applyQuaternion(_qi);
    wDes.addScaledVector(worldUpB, yawW);

    const hoverRatio = T / (m * G);
    const auth = this.rpm * this.rpm * clamp(0.18 + hoverRatio * 0.9, 0.18, 1.15);
    const iscale = Math.sqrt(m / 12500);
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
      const h = env.surfaceAt(px, pz);
      const d = h - py;
      if (d <= 0) return;
      env.normalAt(px, pz, _n);
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
    for (const wl of WHEELS) doContact(wl, true);
    for (const hp of HULL_POINTS) doContact(hp, false);
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
