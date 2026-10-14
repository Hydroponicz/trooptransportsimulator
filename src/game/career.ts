export const RANKS = [
  { name: 'Warrant Officer 1', short: 'WO1', xp: 0 },
  { name: 'Chief Warrant Officer 2', short: 'CW2', xp: 1200 },
  { name: 'Chief Warrant Officer 3', short: 'CW3', xp: 3500 },
  { name: 'Chief Warrant Officer 4', short: 'CW4', xp: 8000 },
  { name: 'Chief Warrant Officer 5', short: 'CW5', xp: 15000 },
  { name: 'Master Army Aviator', short: 'MAA', xp: 26000 },
];

export type UpgradeId = 'engine' | 'armor' | 'fuel' | 'flares';

export const UPGRADES: { id: UpgradeId; name: string; levels: { cost: number; desc: string }[] }[] = [
  {
    id: 'engine',
    name: 'T55-L-714A Engines',
    levels: [
      { cost: 30000, desc: '+6% maximum rotor thrust' },
      { cost: 55000, desc: '+12% maximum rotor thrust' },
      { cost: 90000, desc: '+18% maximum rotor thrust' },
    ],
  },
  {
    id: 'armor',
    name: 'Ballistic Armor Kit',
    levels: [
      { cost: 35000, desc: '−20% damage taken, +350 kg' },
      { cost: 70000, desc: '−40% damage taken, +700 kg' },
    ],
  },
  {
    id: 'fuel',
    name: 'Extended Range Fuel',
    levels: [
      { cost: 20000, desc: '+30% fuel capacity' },
      { cost: 45000, desc: '+60% fuel capacity' },
    ],
  },
  {
    id: 'flares',
    name: 'Countermeasure Dispensers',
    levels: [
      { cost: 12000, desc: '+16 flares' },
      { cost: 26000, desc: '+32 flares' },
    ],
  },
];

export interface Stats {
  deliveries: number;
  troopsMoved: number;
  cargoKg: number;
  distanceKm: number;
  flightTime: number;
  crashes: number;
  butterLandings: number;
  earned: number;
}

import type { CampaignData } from '../battle/campaign';

export interface SaveData {
  version: 1;
  seed: number;
  money: number;
  xp: number;
  upgrades: Record<UpgradeId, number>;
  stats: Stats;
  sas: number;
  /** Keyboard control feel. */
  controlMode?: 'virtual' | 'direct';
  /** The state of the war along the front. */
  campaign?: CampaignData;
}

const KEY = 'tts-career-v1';

export class Career {
  constructor(public data: SaveData) {}

  static fresh(seed = Math.floor(Math.random() * 1e9)): Career {
    return new Career({
      version: 1,
      seed,
      money: 8000,
      xp: 0,
      upgrades: { engine: 0, armor: 0, fuel: 0, flares: 0 },
      stats: { deliveries: 0, troopsMoved: 0, cargoKg: 0, distanceKm: 0, flightTime: 0, crashes: 0, butterLandings: 0, earned: 0 },
      sas: 1,
    });
  }

  static load(): Career | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as SaveData;
      if (d.version !== 1) return null;
      const f = Career.fresh(d.seed);
      return new Career({ ...f.data, ...d, upgrades: { ...f.data.upgrades, ...d.upgrades }, stats: { ...f.data.stats, ...d.stats } });
    } catch {
      return null;
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable: progress lives for this session only */
    }
  }

  get rank(): number {
    let r = 0;
    RANKS.forEach((k, i) => {
      if (this.data.xp >= k.xp) r = i;
    });
    return r;
  }

  get rankName() {
    return RANKS[this.rank].name;
  }

  /** Progress toward the next rank (0..1), or 1 at max. */
  get rankProgress(): number {
    const r = this.rank;
    if (r >= RANKS.length - 1) return 1;
    return (this.data.xp - RANKS[r].xp) / (RANKS[r + 1].xp - RANKS[r].xp);
  }

  /** Adds XP; returns true on promotion. */
  addXp(n: number): boolean {
    const before = this.rank;
    this.data.xp += Math.max(0, Math.round(n));
    return this.rank > before;
  }

  spend(n: number): boolean {
    if (this.data.money < n) return false;
    this.data.money -= n;
    return true;
  }
}
