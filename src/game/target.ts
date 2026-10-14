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
}
