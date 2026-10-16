import * as THREE from 'three';
import type { CabinLayout, CrewStation } from '../game/cargo';
import type { FlightSpec } from './flight';
import {
  AFT_HUB,
  buildChinook,
  CABIN,
  CHINOOK_FLIGHT,
  COCKPIT_POS,
  FRONT_HUB,
  HOOK_POS,
  ROTOR_RADIUS,
  type DoorGunMount,
} from './chinookModel';
import { buildLittleBird, LITTLEBIRD_CABIN, LITTLEBIRD_FLIGHT, LB_COCKPIT_POS, LB_HUB, LB_ROTOR_RADIUS } from './littleBirdModel';

export type AircraftId = 'chinook' | 'littlebird';

/** A spinning rotor: its group turns about its own Y (main) or X (tail) axis. */
export interface RotorPart {
  g: THREE.Group;
  blades: THREE.Mesh[];
  axis: 'y' | 'x';
  /** Turn rate at 100% rotor RPM (rad/s), signed for direction. */
  rate: number;
  phase: number;
}

/** The scene parts the aircraft entity animates and the cargo and crew code ride in. */
export interface AirframeParts {
  root: THREE.Group;
  exterior: THREE.Group;
  rotors: RotorPart[];
  bladeMat: THREE.MeshStandardMaterial;
  discMat: THREE.MeshBasicMaterial;
  strobeMat: THREE.MeshBasicMaterial;
  /** Rear ramp (Chinook), or null. */
  ramp: THREE.Group | null;
  /** Where people walk to in order to board. */
  rampEnd: THREE.Object3D;
  cabinPoint: THREE.Object3D;
  hook: THREE.Object3D;
  exhaustL: THREE.Object3D;
  exhaustR: THREE.Object3D;
  cockpitInterior: THREE.Group;
  cabinLight: THREE.PointLight | null;
  doorGuns: DoorGunMount[];
}

/** Cabin layout plus the crew stations drawn in it. */
export interface AirframeCabin extends CabinLayout {
  crewChief: THREE.Vector3 | null;
  gunners: CrewStation[];
  pilots: CrewStation[];
}

export interface Airframe {
  id: AircraftId;
  name: string;
  short: string;
  flight: FlightSpec;
  build(): AirframeParts;
  rotorHubs: THREE.Vector3[];
  rotorRadius: number;
  hookPos: THREE.Vector3;
  cockpitPos: THREE.Vector3;
  cabin: AirframeCabin;
  /** For enemy fire: half length and radius of the target. */
  hitHalfLength: number;
  hitRadius: number;
  hasRamp: boolean;
  hasHook: boolean;
  /** Most passengers (seats). */
  seats: number;
  maxFlares: number;
  /** Chase-camera distance scale. */
  camScale: number;
  /** Price in the hangar (0 = issued). */
  price: number;
  minRank: number;
}

export const CHINOOK: Airframe = {
  id: 'chinook',
  name: 'CH-47 Chinook',
  short: 'Chinook',
  flight: CHINOOK_FLIGHT,
  build() {
    const p = buildChinook();
    return {
      root: p.root,
      exterior: p.exterior,
      // CCW forward, CW aft (seen from above), 225 RPM at 100%.
      rotors: [
        { g: p.frontRotor, blades: p.frontBlades, axis: 'y', rate: 23.6, phase: 0 },
        { g: p.aftRotor, blades: p.aftBlades, axis: 'y', rate: -23.6, phase: 0.5 },
      ],
      bladeMat: p.bladeMat,
      discMat: p.discMat,
      strobeMat: p.strobeMat,
      ramp: p.ramp,
      rampEnd: p.rampEnd,
      cabinPoint: p.cabinPoint,
      hook: p.hook,
      exhaustL: p.exhaustL,
      exhaustR: p.exhaustR,
      cockpitInterior: p.cockpitInterior,
      cabinLight: p.cabinLight,
      doorGuns: p.doorGuns,
    };
  },
  rotorHubs: [FRONT_HUB, AFT_HUB],
  rotorRadius: ROTOR_RADIUS,
  hookPos: HOOK_POS,
  cockpitPos: COCKPIT_POS,
  cabin: CABIN,
  hitHalfLength: 7,
  hitRadius: 2.3,
  hasRamp: true,
  hasHook: true,
  seats: CABIN.seats.length,
  maxFlares: 30,
  camScale: 1,
  price: 0,
  minRank: 0,
};

export const LITTLEBIRD: Airframe = {
  id: 'littlebird',
  name: 'MH-6 Little Bird',
  short: 'Little Bird',
  flight: LITTLEBIRD_FLIGHT,
  build: buildLittleBird,
  rotorHubs: [LB_HUB],
  rotorRadius: LB_ROTOR_RADIUS,
  hookPos: new THREE.Vector3(0, -1.1, 0),
  cockpitPos: LB_COCKPIT_POS,
  cabin: LITTLEBIRD_CABIN,
  hitHalfLength: 3,
  hitRadius: 1.2,
  hasRamp: false,
  hasHook: false,
  seats: LITTLEBIRD_CABIN.seats.length,
  maxFlares: 12,
  camScale: 0.55,
  price: 60000,
  minRank: 1,
};

export const AIRFRAMES: Record<AircraftId, Airframe> = { chinook: CHINOOK, littlebird: LITTLEBIRD };
