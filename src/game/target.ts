import type * as THREE from 'three';

/**
 * Whatever the player is in — the helicopter or the Humvee — as seen by enemy
 * fire, battles and air strikes.
 */
export interface PlayerTarget {
  readonly kind: 'air' | 'ground';
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  /** Height above the ground under it. */
  readonly agl: number;
  readonly groundSpeed: number;
  readonly destroyed: boolean;
  /** Hit volume: a capsule along the body's Z axis. */
  readonly hitHalfLength: number;
  readonly hitRadius: number;
  damage(amount: number, source: string): void;
  /** Crew-served guns that shoot back. */
  readonly doorGuns?: readonly DoorGunPort[];
}

/** One crew-served gun. The battle says what it is shooting at; the vehicle turns the gun onto it. */
export interface DoorGunPort {
  /** Muzzle (follows the gun as it swivels) and the opening's outward direction, in the body frame. */
  readonly muzzle: THREE.Vector3;
  readonly out: THREE.Vector3;
  /** World point the gunner is engaging, or null; refreshed every frame (aimAge resets to 0). */
  aim: THREE.Vector3 | null;
  aimAge: number;
  /** A burst is going out. */
  firing: boolean;
  /** The barrel is laid on the aim point (no firing until it is). */
  onTarget: boolean;
}
