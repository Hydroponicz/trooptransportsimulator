import * as THREE from 'three';
import type { Heli } from './heli/heli';
import { COCKPIT_POS, HOOK_POS } from './heli/chinookModel';
import { clamp, damp } from './util/math';
import type { Terrain } from './world/terrain';

export type CamMode = 'chase' | 'cockpit' | 'hook' | 'orbit';
export const CAM_MODES: CamMode[] = ['chase', 'cockpit', 'hook', 'orbit'];
export const CAM_LABEL: Record<CamMode, string> = { chase: 'Chase', cockpit: 'Cockpit', hook: 'Hook / belly', orbit: 'Cinematic' };

export class CameraRig {
  mode: CamMode = 'chase';
  camera: THREE.PerspectiveCamera;
  private yawOff = 0;
  private pitchOff = 0.2;
  private dist = 32;
  private idle = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private heading = 0;
  private orbitA = 0;
  private lookYaw = 0;
  private lookPitch = -0.05;
  shake = 0;
  lookBack = false;
  private initialized = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.5, 14000);
  }

  next() {
    this.mode = CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length];
    this.lookYaw = 0;
    this.lookPitch = -0.05;
  }

  snap() {
    this.initialized = false;
  }

  update(dt: number, heli: Heli, terrain: Terrain, mouse: [number, number, number]) {
    const fm = heli.fm;
    const cam = this.camera;
    const [mx, my, wheel] = mouse;
    const hp = fm.pos;

    if (this.mode === 'chase' || this.mode === 'orbit') {
      if (mx || my) this.idle = 0;
      else this.idle += dt;
      this.yawOff -= mx * 0.005;
      this.pitchOff = clamp(this.pitchOff + my * 0.004, -0.2, 1.4);
      this.dist = clamp(this.dist * (1 + wheel * 0.1), 14, 120);
      if (this.idle > 2.5 && this.mode === 'chase') {
        this.yawOff = damp(this.yawOff, 0, 1.2, dt);
        this.pitchOff = damp(this.pitchOff, 0.2, 1.2, dt);
      }
      // Follow the direction of travel at speed, the nose at hover.
      const hs = fm.groundSpeed;
      const travel = Math.atan2(fm.vel.x, -fm.vel.z);
      let want = fm.refHeading;
      if (hs > 12) {
        let d = travel - fm.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        want = fm.heading + d * clamp((hs - 12) / 25, 0, 0.6);
      }
      let dh = want - this.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.heading += dh * (1 - Math.exp(-3 * dt));
      if (!this.initialized) this.heading = fm.refHeading;
      if (this.mode === 'orbit') this.orbitA += dt * 0.12;
      const yaw = this.heading + this.yawOff + (this.lookBack ? Math.PI : 0) + this.orbitA * (this.mode === 'orbit' ? 1 : 0);
      const d = this.mode === 'orbit' ? this.dist * 1.6 : this.dist;
      const elev = this.pitchOff;
      const target = new THREE.Vector3(
        hp.x - Math.sin(yaw) * Math.cos(elev) * d,
        hp.y + 4 + Math.sin(elev) * d,
        hp.z + Math.cos(yaw) * Math.cos(elev) * d,
      );
      const minY = terrain.surfaceAt(target.x, target.z) + 2;
      if (target.y < minY) target.y = minY;
      const lookT = hp.clone().add(new THREE.Vector3(0, 3, 0)).addScaledVector(fm.vel, 0.15);
      if (!this.initialized) {
        this.pos.copy(target);
        this.look.copy(lookT);
        this.initialized = true;
      }
      // Spring lag sells speed and weight.
      this.pos.x = damp(this.pos.x, target.x, 5, dt);
      this.pos.y = damp(this.pos.y, target.y, 4, dt);
      this.pos.z = damp(this.pos.z, target.z, 5, dt);
      this.look.lerp(lookT, 1 - Math.exp(-10 * dt));
      cam.position.copy(this.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      cam.near = 0.5;
      cam.fov = damp(cam.fov, 60 + clamp(hs / 80, 0, 1) * 10, 2, dt);
    } else if (this.mode === 'cockpit') {
      if (mx || my) {
        this.lookYaw = clamp(this.lookYaw - mx * 0.004, -2.6, 2.6);
        this.lookPitch = clamp(this.lookPitch - my * 0.004, -1.2, 0.9);
      }
      const yawL = this.lookBack ? Math.PI * 0.7 : this.lookYaw;
      heli.worldPoint(COCKPIT_POS, cam.position);
      const q = fm.quat.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.lookPitch, yawL, 0, 'YXZ')));
      cam.quaternion.copy(q);
      cam.near = 0.1;
      cam.fov = damp(cam.fov, 70, 4, dt);
      this.initialized = false;
    } else {
      // Belly camera looking down the hook.
      heli.worldPoint(HOOK_POS.clone().add(new THREE.Vector3(0, -0.3, -1.2)), cam.position);
      const yawQ = heli.yawQuat(new THREE.Quaternion());
      cam.quaternion.copy(yawQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 + 0.12));
      cam.near = 0.2;
      cam.fov = damp(cam.fov, 75, 4, dt);
      this.initialized = false;
    }

    if (this.shake > 0.001) {
      const s = this.shake;
      cam.rotateX((Math.random() - 0.5) * s * 0.02);
      cam.rotateY((Math.random() - 0.5) * s * 0.02);
      cam.rotateZ((Math.random() - 0.5) * s * 0.015);
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    cam.updateProjectionMatrix();
  }
}
