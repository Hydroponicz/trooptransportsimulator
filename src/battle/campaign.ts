import type { RNG } from '../util/noise';
import type { Contract } from '../game/missions';
import { clamp } from '../util/math';
import { WORLD_SCALE } from '../world/terrain';

export type Side = 'blue' | 'red';
export const SIDES: Side[] = ['blue', 'red'];
export const enemyOf = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');

/** 600 m sectors along the whole front. */
export const SECTOR_COUNT = Math.round((6000 * WORLD_SCALE) / 600);
const Z0 = -3000 * WORLD_SCALE;
const Z1 = 3000 * WORLD_SCALE;
/** Bumped when the sector layout changes; older saved campaigns start fresh. */
export const CAMPAIGN_VERSION = 2;
const SECTOR_LEN = (Z1 - Z0) / SECTOR_COUNT;

type PerSide = { blue: number; red: number };

/**
 * Persistent state of one stretch of the front. Numbers are the "truth":
 * the visible battle spawns units from them and writes losses back.
 */
export interface SectorState {
  id: number;
  name: string;
  zc: number;
  /** Infantry (soldiers). */
  inf: PerSide;
  /** Armored vehicles (tanks + APCs), fractional while regenerating. */
  armor: PerSide;
  /** Fortification level 0..1 (trench depth, sandbags, wire). */
  fort: PerSide;
  /** Ammunition supply multiplier (~0.5..1.5) — affects fire rate and accuracy. */
  ammo: PerSide;
  /** Artillery support level. */
  arty: PerSide;
}

export interface CampaignData {
  version: number;
  sectors: SectorState[];
}

const INF_CAP = 70;
const ARMOR_CAP = 6;

export class Campaign {
  private acc = 0;
  /** Sector ids currently simulated in detail; skipped by the abstract sim. */
  active = new Set<number>();

  constructor(
    public data: CampaignData,
    private rng: RNG,
  ) {}

  static fresh(rng: RNG): Campaign {
    const sectors: SectorState[] = [];
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const r = (a: number, b: number) => Math.round(rng.range(a, b) * 100) / 100;
      sectors.push({
        id: i,
        name: `Sector ${String.fromCharCode(65 + i)}`,
        zc: Z0 + SECTOR_LEN * (i + 0.5),
        inf: { blue: Math.round(rng.range(32, 46)), red: Math.round(rng.range(32, 46)) },
        armor: { blue: r(2, 4), red: r(2, 4) },
        fort: { blue: r(0.3, 0.65), red: r(0.3, 0.65) },
        ammo: { blue: 1, red: 1 },
        arty: { blue: 1, red: 1 },
      });
    }
    return new Campaign({ version: CAMPAIGN_VERSION, sectors }, rng);
  }

  get sectors() {
    return this.data.sectors;
  }

  sectorAt(z: number): SectorState {
    const i = clamp(Math.floor((z - Z0) / SECTOR_LEN), 0, SECTOR_COUNT - 1);
    return this.data.sectors[i];
  }

  span(s: SectorState): [number, number] {
    return [s.zc - SECTOR_LEN / 2, s.zc + SECTOR_LEN / 2];
  }

  power(s: SectorState, side: Side): number {
    return s.inf[side] * (0.7 + 0.3 * s.ammo[side]) + s.armor[side] * 7 + s.arty[side] * 4;
  }

  /** −1 (enemy dominates) … +1 (friendly dominates). */
  control(s: SectorState): number {
    const b = this.power(s, 'blue');
    const r = this.power(s, 'red');
    return (b - r) / Math.max(1, b + r);
  }

  status(s: SectorState): string {
    const c = this.control(s);
    if (c > 0.35) return 'Friendly advantage';
    if (c > 0.1) return 'Holding';
    if (c > -0.1) return 'Contested';
    if (c > -0.35) return 'Under pressure';
    return 'Collapsing';
  }

  tick(dt: number) {
    for (const s of this.data.sectors) {
      for (const side of ['blue', 'red'] as Side[]) {
        // Slow trickle of replacements and repairs on both sides.
        s.inf[side] = Math.min(INF_CAP, s.inf[side] + dt / 55);
        s.armor[side] = Math.min(ARMOR_CAP, s.armor[side] + dt / 500);
        s.fort[side] = Math.min(1, s.fort[side] + dt / 2400);
        // Ammo drifts back toward normal supply.
        s.ammo[side] += (1 - s.ammo[side]) * Math.min(1, dt / 900);
      }
    }
    this.acc += dt;
    while (this.acc >= 6) {
      this.acc -= 6;
      for (const s of this.data.sectors) if (!this.active.has(s.id)) this.abstractFight(s, 6);
    }
  }

  /** Off-screen sectors grind on as numbers. */
  private abstractFight(s: SectorState, dt: number) {
    const pb = this.power(s, 'blue');
    const pr = this.power(s, 'red');
    const lossB = pr * 0.0011 * dt * this.rng.range(0.4, 1.6) * (1 - s.fort.blue * 0.45);
    const lossR = pb * 0.0011 * dt * this.rng.range(0.4, 1.6) * (1 - s.fort.red * 0.45);
    s.inf.blue = Math.max(0, s.inf.blue - lossB);
    s.inf.red = Math.max(0, s.inf.red - lossR);
    if (this.rng.chance(0.004 * dt)) s.armor.blue = Math.max(0, s.armor.blue - 1);
    if (this.rng.chance(0.004 * dt)) s.armor.red = Math.max(0, s.armor.red - 1);
  }

  casualty(id: number, side: Side, kind: 'inf' | 'armor') {
    const s = this.data.sectors[id];
    if (kind === 'inf') s.inf[side] = Math.max(0, s.inf[side] - 1);
    else s.armor[side] = Math.max(0, s.armor[side] - 1);
  }

  /** The player's deliveries feed the war. Returns a short report, if it mattered. */
  applyDelivery(c: Contract): string | null {
    const to = c.to;
    if (to.enemySide && c.type.id !== 'recon') return null;
    if (to.frontDist < -1600) return null;
    const s = this.sectorAt(to.z);
    const t = c.type;
    if (t.id === 'recon') {
      s.arty.blue = Math.min(3, s.arty.blue + 0.4);
      return `${s.name}: recon team is spotting for the guns — friendly artillery more effective`;
    }
    if (t.kind === 'troops' && t.id !== 'rotation') {
      s.inf.blue = Math.min(INF_CAP, s.inf.blue + c.count);
      return `${s.name} reinforced: +${c.count} infantry`;
    }
    if (t.id === 'ammo') {
      s.ammo.blue = Math.min(1.6, s.ammo.blue + 0.15 * c.count);
      return `${s.name} resupplied with ammunition — firepower up`;
    }
    if (t.id === 'supplies' || t.id === 'container' || t.id === 'generator' || t.id === 'bladder') {
      s.fort.blue = Math.min(1, s.fort.blue + 0.12);
      return `${s.name}: supplies delivered — fortifications improving`;
    }
    if (t.id === 'm777') {
      s.arty.blue = Math.min(3, s.arty.blue + 1);
      return `${s.name}: M777 in position — artillery support increased`;
    }
    if (t.id === 'vehicle') {
      s.armor.blue = Math.min(ARMOR_CAP, s.armor.blue + 1);
      return `${s.name}: vehicle delivered — armor strength up`;
    }
    return null;
  }
}
