import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Facility, FacilityKind, Site, SiteKind } from '../world/sites';
import type { ActorKind, CabinLayout, CargoGroup, CargoManager, Destination, Source } from './cargo';
import { SlingLoad, type SlingModel, type SlingSystem } from './sling';
import type { LandingRating } from '../heli/heli';
import type { Roads } from '../world/roads';
import type { Effects, SmokeEmitter } from '../fx/effects';
import type { Terrain } from '../world/terrain';
import { clamp } from '../util/math';
import { WORLD_SCALE } from '../world/terrain';
import type { Town } from '../world/towns';
import type { Rooftop, Rooftops } from './rooftops';
import type { InsertPoint, Insertions } from './insertion';

/**
 * How far jobs reach (m). They grow with the map, so a bigger theater means
 * longer hauls, but are capped so a job stays a sitting's work: about ten
 * minutes' flying for a delivery, five for an insertion, half an hour's
 * driving for a road job.
 */
const AIR_PICKUP_MAX = Math.min(3800 * WORLD_SCALE, 12000);
const AIR_TRIP_MAX = Math.min(5200 * WORLD_SCALE, 24000);
const INSERT_MAX = Math.min(5000 * WORLD_SCALE, 15000);
const ROAD_REACH = Math.min(3700 * WORLD_SCALE, 20000);
const ROAD_TRIP_MAX = Math.min(5400 * WORLD_SCALE, 30000);

export type CargoKind = 'troops' | 'pallets' | 'casualties' | 'sling';

/** Anything that can carry a contract: the helicopter or a ground vehicle. */
export interface Carrier {
  readonly kind: 'air' | 'ground';
  readonly pos: THREE.Vector3;
  readonly loadable: boolean;
  readonly rampDown: boolean;
  readonly onGround: boolean;
  readonly loadFactor: number;
  readonly roll: number;
  readonly pitch: number;
  readonly vel: THREE.Vector3;
  /** World height of the gear contact plane (skids or wheels). */
  readonly gearBottom: number;
  rampEndWorld(out: THREE.Vector3): THREE.Vector3;
  cabinWorld(out: THREE.Vector3): THREE.Vector3;
  /** Body frame and layout that loaded people and cargo ride in. */
  readonly cabinFrame: THREE.Object3D;
  readonly cabinLayout: CabinLayout;
}

export interface CargoType {
  id: string;
  name: string;
  kind: CargoKind;
  actor?: ActorKind;
  sling?: SlingModel;
  unitMass: number;
  min: number;
  max: number;
  payMult: number;
  fragility: number;
  minRank: number;
  urgent?: boolean;
  from: SiteKind[];
  to: SiteKind[];
  /** 'enemy' = destination/pickup must be across the line, 'friendly' = must not. */
  side?: 'enemy' | 'friendly';
  weight: number;
  icon: string;
  desc: string;
}

/** Jobs done by road in the Humvee. */
export const GROUND_CARGO: CargoType[] = [
  { id: 'g_fireteam', name: 'Fire Team Transport', kind: 'troops', actor: 'soldier', unitMass: 115, min: 2, max: 4, payMult: 1, fragility: 0.6, minRank: 0, from: ['base', 'fob', 'cop'], to: ['base', 'fob', 'cop'], weight: 4, icon: '🚙', desc: 'Drive a fire team to its new post.' },
  { id: 'g_supply', name: 'Supply Run', kind: 'pallets', actor: 'pallet', unitMass: 600, min: 1, max: 1, payMult: 1.1, fragility: 0.8, minRank: 0, from: ['base', 'fob'], to: ['fob', 'cop'], weight: 3, icon: '🚙', desc: 'Crates of rations and spares. Stick to the roads, the bumps break things.' },
  { id: 'g_casevac', name: 'Ground CASEVAC', kind: 'casualties', actor: 'casualty', unitMass: 190, min: 1, max: 2, payMult: 1.5, fragility: 2, minRank: 0, urgent: true, from: ['cop', 'fob'], to: ['base', 'fob'], weight: 2, icon: '🚑', desc: 'Lightly wounded, stable for road transport. Drive smooth.' },
  { id: 'g_escort', name: 'Officer Transport', kind: 'troops', actor: 'soldier', unitMass: 110, min: 1, max: 2, payMult: 1.35, fragility: 1.3, minRank: 0, from: ['base', 'fob', 'cop'], to: ['base', 'fob', 'cop'], weight: 2, icon: '🎖️', desc: 'Brass on a site visit. A comfortable ride is appreciated.' },
];

export const CARGO: CargoType[] = [
  { id: 'squad', name: 'Infantry Squad', kind: 'troops', actor: 'soldier', unitMass: 115, min: 6, max: 12, payMult: 1, fragility: 0.6, minRank: 0, from: ['base', 'fob'], to: ['fob', 'cop', 'lz'], side: 'friendly', weight: 5, icon: '🪖', desc: 'Move a rifle squad forward.' },
  { id: 'rotation', name: 'Troop Rotation', kind: 'troops', actor: 'soldier', unitMass: 115, min: 8, max: 16, payMult: 0.9, fragility: 0.5, minRank: 0, from: ['cop', 'fob'], to: ['base', 'fob'], weight: 3, icon: '🔄', desc: 'Bring a worn-out unit back for rest.' },
  { id: 'platoon', name: 'Infantry Platoon', kind: 'troops', actor: 'soldier', unitMass: 115, min: 20, max: 30, payMult: 1.35, fragility: 0.6, minRank: 1, from: ['base', 'fob'], to: ['fob', 'cop'], weight: 3, icon: '🪖', desc: 'A full platoon reinforcing the line. Heavy.' },
  { id: 'ammo', name: 'Ammunition Pallets', kind: 'pallets', actor: 'pallet', unitMass: 950, min: 2, max: 4, payMult: 1.25, fragility: 1.3, minRank: 0, from: ['base', 'fob'], to: ['cop', 'fob'], weight: 4, icon: '💥', desc: 'Artillery and small-arms resupply. Handle gently.' },
  { id: 'supplies', name: 'Rations & Water', kind: 'pallets', actor: 'pallet', unitMass: 650, min: 2, max: 5, payMult: 1, fragility: 0.5, minRank: 0, from: ['base', 'fob'], to: ['cop', 'fob', 'lz'], side: 'friendly', weight: 4, icon: '📦', desc: 'Keep the outposts fed.' },
  { id: 'casevac', name: 'Casualty Evacuation', kind: 'casualties', actor: 'casualty', unitMass: 190, min: 2, max: 4, payMult: 1.7, fragility: 2.2, minRank: 0, urgent: true, from: ['cop', 'lz'], to: ['base', 'fob'], weight: 3, icon: '🚑', desc: 'Wounded need surgery inside the golden hour. Fly fast, fly smooth.' },
  { id: 'recon', name: 'Recon Team Insertion', kind: 'troops', actor: 'soldier', unitMass: 125, min: 4, max: 6, payMult: 2.4, fragility: 0.5, minRank: 2, from: ['base', 'fob'], to: ['lz'], side: 'enemy', weight: 2, icon: '🎯', desc: 'Covert insertion behind enemy lines. Expect ground fire.' },
  { id: 'extract', name: 'Hot Extraction', kind: 'troops', actor: 'soldier', unitMass: 120, min: 4, max: 8, payMult: 2.2, fragility: 0.7, minRank: 2, urgent: true, from: ['lz'], to: ['fob', 'base'], side: 'enemy', weight: 2, icon: '🔥', desc: 'A team is pinned down. Get in, get them, get out.' },
  { id: 'container', name: 'Supply Container', kind: 'sling', sling: 'container', unitMass: 2400, min: 1, max: 1, payMult: 1.3, fragility: 0.8, minRank: 0, from: ['base', 'fob'], to: ['cop', 'fob'], weight: 3, icon: '🔗', desc: 'Sling-load a 20ft container.' },
  { id: 'generator', name: 'Generator Set', kind: 'sling', sling: 'generator', unitMass: 1800, min: 1, max: 1, payMult: 1.2, fragility: 1.2, minRank: 0, from: ['base', 'fob'], to: ['cop', 'lz'], side: 'friendly', weight: 2, icon: '🔗', desc: 'Power for a forward position. Fragile.' },
  { id: 'm777', name: 'M777 Howitzer', kind: 'sling', sling: 'howitzer', unitMass: 4200, min: 1, max: 1, payMult: 1.8, fragility: 1, minRank: 1, from: ['base', 'fob'], to: ['cop', 'fob'], weight: 2, icon: '🔗', desc: 'Reposition a 155mm gun. Heavy external load.' },
  { id: 'vehicle', name: 'Light Utility Vehicle', kind: 'sling', sling: 'vehicle', unitMass: 2600, min: 1, max: 1, payMult: 1.4, fragility: 0.9, minRank: 1, from: ['base', 'fob'], to: ['cop', 'lz', 'fob'], side: 'friendly', weight: 2, icon: '🔗', desc: 'Sling a utility vehicle forward.' },
  { id: 'bladder', name: 'Fuel Bladder', kind: 'sling', sling: 'bladder', unitMass: 3200, min: 1, max: 1, payMult: 1.6, fragility: 1.6, minRank: 1, from: ['base', 'fob'], to: ['cop', 'lz'], side: 'friendly', weight: 2, icon: '⛽', desc: '3,200 kg of fuel in a rubber bag. Do not drop it.' },
  { id: 'recovery', name: 'Vehicle Recovery', kind: 'sling', sling: 'vehicle', unitMass: 2600, min: 1, max: 1, payMult: 1.7, fragility: 0.6, minRank: 2, from: ['cop', 'lz'], to: ['base', 'fob'], weight: 1, icon: '🛠️', desc: 'Recover a damaged vehicle from the front.' },
];

/**
 * Special-forces rooftop insertion: a team put onto the roof of a city
 * building from a hover (off the Little Bird's benches, or down the
 * Chinook's ramp onto the roof edge). Generated separately: see generate().
 */
export const SF_ROOF: CargoType = {
  id: 'sf_roof',
  name: 'Rooftop Insertion (SF)',
  kind: 'troops',
  actor: 'soldier',
  unitMass: 130,
  min: 4,
  max: 6,
  payMult: 1.7,
  fragility: 0.4,
  minRank: 0,
  urgent: true,
  from: ['base', 'fob'],
  to: ['lz'],
  weight: 0,
  icon: '🏢',
  desc: 'Put a special-forces team on a rooftop. No landing: hover low and steady over the roof and they go off the Little Bird\'s benches, or back the Chinook\'s ramp onto the roof edge. Tight window, and in a battle zone you take fire while you hold the hover.',
};

/**
 * Fast-rope insertion: troops slide down ropes from a hover into a town
 * square, a park, a street junction, a position behind the line or a
 * landing zone. Any of the three aircraft (with room for the team).
 */
export const FAST_ROPE: CargoType = {
  id: 'fastrope',
  name: 'Fast-Rope Insertion',
  kind: 'troops',
  actor: 'soldier',
  unitMass: 120,
  min: 4,
  max: 10,
  payMult: 1.5,
  fragility: 0.5,
  minRank: 0,
  urgent: true,
  from: ['base', 'fob'],
  to: ['lz'],
  weight: 0,
  icon: '🪢',
  desc: 'Get a team on the ground where there is no room to land: hover 5–20 m up over the smoke, steady, and they slide down the ropes. Hold the hover until the last man is down.',
};

/** Can this aircraft fly this contract (seats, litters, pallets, hook rating)? */
export function fitsAircraft(
  c: Contract,
  af: { seats: number; litters: number; pallets: boolean; slingKg: number; rotorRadius?: number; rotorHubs?: THREE.Vector3[]; hitHalfLength?: number },
): boolean {
  if (c.mode !== 'air') return true;
  // A roof has to have room for the rotors (and the fuselage) over it.
  if (c.roof && af.rotorRadius) {
    const R = af.rotorRadius;
    const along = Math.max((af.hitHalfLength ?? 0) + 1, ...(af.rotorHubs ?? []).map((h) => Math.abs(h.z) + R));
    if (c.roof.along < along + 0.5 || c.roof.across < R + 0.5) return false;
  }
  switch (c.type.kind) {
    case 'troops':
      return c.count <= af.seats;
    case 'casualties':
      return c.count <= af.litters;
    case 'pallets':
      return af.pallets;
    default:
      return c.mass <= af.slingKg;
  }
}

export interface Contract {
  id: number;
  /** Rooftop insertion target (SF jobs). */
  roof?: Rooftop;
  /** Fast-rope insertion point. */
  ropeAt?: InsertPoint;
  type: CargoType;
  count: number;
  mass: number;
  from: Site;
  to: Site;
  fromPad: number;
  toPad: number;
  distance: number;
  pay: number;
  timeLimit: number;
  risk: number;
  xp: number;
  /** Which vehicle does the job. */
  mode: 'air' | 'ground';
  /** Road distance for ground jobs. */
  route?: number;
  /** Ground jobs: roadside spots where cargo waits and is dropped. */
  pickupAt?: THREE.Vector3;
  dropAt?: THREE.Vector3;
}

export type Phase = 'pickup' | 'transit' | 'dropoff' | 'complete' | 'failed';

export interface PayoutLine {
  label: string;
  amount: number;
}
export interface Payout {
  contract: Contract;
  lines: PayoutLine[];
  total: number;
  xp: number;
  condition: number;
  time: number;
}

export function siteRisk(s: Site): number {
  if (s.enemySide) return 3;
  if (s.frontDist > -700) return s.kind === 'lz' ? 2 : 1;
  if (s.kind === 'cop') return 1;
  return 0;
}

export class Mission {
  phase: Phase = 'pickup';
  elapsed = 0;
  condition = 100;
  group: CargoGroup | null = null;
  load: SlingLoad | null = null;
  pickupSmoke: SmokeEmitter | null = null;
  dropSmoke: SmokeEmitter | null = null;
  spawned = false;
  /** The receiving facility has been told (its helpers are on their way). */
  destSet = false;
  landing: LandingRating | null = null;
  setDownImpact = 0;
  hits = 0;
  calledPickup = false;
  /** Smoothed vertical load factor felt by the cargo. */
  nz = 1;
  calledDrop = false;
  constructor(readonly c: Contract) {}
  get timeLeft() {
    return this.c.timeLimit - this.elapsed;
  }
  get internal() {
    return this.c.type.kind !== 'sling';
  }
  /** Where the passengers or cargo wait. */
  get pickupPos(): THREE.Vector3 {
    if (this.c.pickupAt) return this.c.pickupAt;
    return this.internal ? this.c.from.waits[this.c.fromPad] : this.c.from.pads[this.c.fromPad];
  }
  get dropPos(): THREE.Vector3 {
    return this.c.dropAt ?? this.c.to.pads[this.c.toPad];
  }
  /** Where the player should currently be heading. */
  get target(): THREE.Vector3 {
    return this.phase === 'pickup' ? this.c.pickupAt ?? this.c.from.pads[this.c.fromPad] : this.dropPos;
  }
  get targetSite(): Site {
    return this.phase === 'pickup' ? this.c.from : this.c.to;
  }
}

export const CALLSIGN = 'Big Windy 2-1';

export interface MissionHooks {
  toast(msg: string, kind?: 'info' | 'good' | 'bad'): void;
  radio(from: string, msg: string): void;
  complete(p: Payout): void;
  failed(reason: string, m: Mission): void;
  payloadChanged(kg: number): void;
  hotZone(site: Site, on: boolean): void;
}

let nextId = 1;

export class MissionSystem {
  boards = new Map<number, { time: number; list: Contract[] }>();
  active: Mission | null = null;
  /** Rooftop drop points and the towns to find them in (set by the game). */
  rooftops: Rooftops | null = null;
  insertions: Insertions | null = null;
  towns: Town[] = [];
  battleZone: (t: Town) => boolean = () => false;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    private sites: Site[],
    private rng: RNG,
    private cargo: CargoManager,
    private sling: SlingSystem,
    private effects: Effects,
    private terrain: Terrain,
    private roads: Roads,
    private hooks: MissionHooks,
  ) {
    cargo.onBoard = (g) => {
      if (this.active?.group === g) this.hooks.payloadChanged(g.unitMass);
      if (this.active?.group === g) {
        const n = g.aboard;
        if (n === g.total)
          this.hooks.toast(
            this.active.c.mode === 'ground'
              ? `${n === 1 ? 'The' : 'All'} ${noun(this.active.c.type, n)} ${n === 1 ? 'is' : 'are'} aboard — close the doors [R] and drive to ${this.active.c.to.name}`
              : `${n === 1 ? 'The' : 'All'} ${noun(this.active.c.type, n)} ${n === 1 ? 'is' : 'are'} aboard — raise the ramp [R] and fly to ${this.active.c.to.name}`,
            'good',
          );
        else if (n === 1 || n % 4 === 0) this.hooks.toast(`${n}/${g.total} ${noun(this.active.c.type, g.total)} aboard`);
      }
    };
    cargo.onUnboard = (g) => {
      if (this.active?.group === g) this.hooks.payloadChanged(-g.unitMass);
    };
    sling.onLoadImpact = (load, speed) => {
      const m = this.active;
      if (!m || m.load !== load) return;
      if (speed > 7.5) {
        load.destroyed = true;
        this.effects.explosion(load.pos, load.model === 'bladder' ? 1.6 : 0.9);
        this.fail('Sling load destroyed on impact');
      } else if (speed > 2.5) {
        m.condition = Math.max(0, m.condition - (speed - 2.5) * 9 * m.c.type.fragility);
        this.hooks.toast(`Load hit the ground hard (${speed.toFixed(1)} m/s)`, 'bad');
      }
    };
  }

  board(site: Site, rank: number, now: number): Contract[] {
    const b = this.boards.get(site.id);
    if (b && now - b.time < 240 && b.list.length >= 4) return b.list;
    const list = this.generate(site, rank);
    this.boards.set(site.id, { time: now, list });
    return list;
  }

  private generate(site: Site, rank: number): Contract[] {
    const out: Contract[] = [];
    const rng = this.rng;
    const dist2 = (a: Site, b: Site) => Math.hypot(a.x - b.x, a.z - b.z);
    const sideOk = (t: CargoType, s: Site) =>
      !t.side || s.kind !== 'lz' || (t.side === 'enemy' ? s.enemySide : !s.enemySide);
    for (let tries = 0; tries < 80 && out.length < 7; tries++) {
      // Weighted pick, biased toward jobs available at this site.
      const pool = CARGO.flatMap((t) => Array(t.weight * (t.from.includes(site.kind) ? 3 : 1)).fill(t) as CargoType[]);
      const t = rng.pick(pool);
      let from: Site;
      if (t.from.includes(site.kind) && sideOk(t, site) && rng.chance(0.85)) from = site;
      else {
        const cands = this.sites.filter((s) => s !== site && t.from.includes(s.kind) && sideOk(t, s) && dist2(s, site) < AIR_PICKUP_MAX);
        if (!cands.length) continue;
        from = rng.pick(cands);
      }
      const tos = this.sites.filter((s) => s !== from && t.to.includes(s.kind) && sideOk(t, s) && dist2(s, from) > 700 && dist2(s, from) < AIR_TRIP_MAX);
      if (!tos.length) continue;
      const to = rng.pick(tos);
      if (out.some((c) => c.type === t && c.to === to && c.from === from)) continue;
      const count = rng.int(t.min, t.max);
      const mass = count * t.unitMass;
      const distance = dist2(from, to);
      const leg0 = dist2(site, from);
      const risk = Math.max(siteRisk(from), siteRisk(to));
      const raw = (1500 + (distance / 1000) * 1300 + (leg0 / 1000) * 500) * t.payMult * (1 + 0.4 * risk) * (1 + mass / 15000);
      const pay = Math.round(raw / 50) * 50;
      const speed = t.urgent ? 48 : 34;
      const timeLimit = Math.round((leg0 + distance) / speed + (t.urgent ? 150 : 240) + (t.kind === 'sling' ? 60 : 0) + (t.kind === 'pallets' ? count * 15 : 0));
      out.push({
        id: nextId++,
        type: t,
        count,
        mass,
        from,
        to,
        fromPad: rng.int(0, from.pads.length - 1),
        toPad: rng.int(0, to.pads.length - 1),
        distance,
        pay,
        timeLimit,
        risk,
        xp: Math.round(pay / 45),
        mode: 'air',
      });
    }
    // Rooftop insertions from bases and FOBs into towns, battle zones first.
    if (this.rooftops && (site.kind === 'base' || site.kind === 'fob')) {
      const R = this.rooftops;
      const towns = this.towns.filter((t) => t.kind !== 'village' && Math.hypot(t.x - site.x, t.z - site.z) > 600 && Math.hypot(t.x - site.x, t.z - site.z) < INSERT_MAX && R.hasRoofs(t));
      const pool = towns.flatMap((t) => Array((this.battleZone(t) ? 4 : 1) * (t.kind === 'city' ? 2 : 1)).fill(t) as Town[]);
      for (let made = 0, tries = 0; made < 2 && tries < 6 && pool.length; tries++) {
        const t = rng.pick(pool);
        const roof = R.pick(t, () => rng.next());
        if (!roof || out.some((c) => c.roof?.town === t)) continue;
        const to = R.site(roof);
        const hot = this.battleZone(t);
        const count = rng.int(SF_ROOF.min, SF_ROOF.max);
        const distance = dist2(site, to);
        const risk = hot ? Math.max(2, siteRisk(to)) : Math.max(1, siteRisk(to));
        const pay = Math.round(((1800 + (distance / 1000) * 1400) * SF_ROOF.payMult * (1 + 0.4 * risk)) / 50) * 50;
        out.push({
          id: nextId++,
          type: SF_ROOF,
          roof,
          count,
          mass: count * SF_ROOF.unitMass,
          from: site,
          to,
          fromPad: rng.int(0, site.pads.length - 1),
          toPad: 0,
          distance,
          pay,
          // A tight window: fast cruise, a minute and a half to board and settle into the hover.
          timeLimit: Math.round(distance / 45 + 90),
          risk,
          xp: Math.round(pay / 40),
          mode: 'air',
        });
        made++;
      }
    }
    // Fast-rope insertions from bases and FOBs: into towns (battle zones first), behind the line, or LZs.
    if (this.insertions && (site.kind === 'base' || site.kind === 'fob')) {
      const I = this.insertions;
      const towns = this.towns.filter((t) => t.kind !== 'village' && t.spots?.length && Math.hypot(t.x - site.x, t.z - site.z) > 600 && Math.hypot(t.x - site.x, t.z - site.z) < INSERT_MAX);
      const townPool = towns.flatMap((t) => Array((this.battleZone(t) ? 4 : 1) * (t.kind === 'city' ? 2 : 1)).fill(t) as Town[]);
      const lzs = this.sites.filter((s) => s.kind === 'lz' && !s.enemySide && Math.hypot(s.x - site.x, s.z - site.z) < INSERT_MAX);
      for (let made = 0, tries = 0; made < 2 && tries < 8; tries++) {
        const roll = rng.next();
        let p: InsertPoint | null = null;
        if (roll < 0.5 && townPool.length) p = I.inTown(rng.pick(townPool), () => rng.next());
        else if (roll < 0.82) p = I.atFront(() => rng.next());
        else if (lzs.length) p = I.atLz(rng.pick(lzs));
        if (!p || out.some((c) => c.ropeAt && Math.hypot(c.ropeAt.x - p!.x, c.ropeAt.z - p!.z) < 400)) continue;
        const to = I.site(p);
        const count = rng.int(FAST_ROPE.min, FAST_ROPE.max);
        const distance = dist2(site, to);
        const risk = p.hot ? 3 : Math.max(1, siteRisk(to));
        const pay = Math.round(((1600 + (distance / 1000) * 1350) * FAST_ROPE.payMult * (1 + 0.35 * risk)) / 50) * 50;
        out.push({
          id: nextId++,
          type: FAST_ROPE,
          ropeAt: p,
          count,
          mass: count * FAST_ROPE.unitMass,
          from: site,
          to,
          fromPad: rng.int(0, site.pads.length - 1),
          toPad: 0,
          distance,
          pay,
          timeLimit: Math.round(distance / 45 + 100),
          risk,
          xp: Math.round(pay / 40),
          mode: 'air',
        });
        made++;
      }
    }
    // Road jobs from here, if this site is on the road network.
    if (site.kind !== 'lz') {
      let made = 0;
      const pool = GROUND_CARGO.filter((g) => g.from.includes(site.kind)).flatMap((g) => Array(g.weight).fill(g) as CargoType[]);
      for (let tries = 0; tries < 30 && made < 3 && pool.length; tries++) {
        const t = rng.pick(pool);
        const tos = this.sites.filter((s) => s !== site && !s.enemySide && t.to.includes(s.kind) && dist2(s, site) < ROAD_REACH);
        if (!tos.length) continue;
        const to = rng.pick(tos);
        if (out.some((c) => c.mode === 'ground' && c.to === to && c.type === t)) continue;
        const route = this.roads.route(site.x, site.z, to.x, to.z);
        if (route === null || route < 700 || route > ROAD_TRIP_MAX) continue;
        const a = this.roads.curbside(site.x, site.z, site.radius);
        const b = this.roads.curbside(to.x, to.z, to.radius);
        if (!a || !b) continue;
        const count = rng.int(t.min, t.max);
        const mass = count * t.unitMass;
        const risk = Math.max(siteRisk(site), siteRisk(to));
        const pay = Math.round(((1400 + (route / 1000) * 1500) * t.payMult * (1 + 0.4 * risk)) / 50) * 50;
        // Driving time at a sensible road speed (~38-45 km/h average), plus loading.
        const timeLimit = Math.round(route / (t.urgent ? 12.5 : 10.5) + (t.urgent ? 120 : 180) + (t.kind === 'pallets' ? count * 20 : 0));
        out.push({
          id: nextId++,
          type: t,
          count,
          mass,
          from: site,
          to,
          fromPad: rng.int(0, site.pads.length - 1),
          toPad: rng.int(0, to.pads.length - 1),
          distance: Math.hypot(site.x - to.x, site.z - to.z),
          pay,
          timeLimit,
          risk,
          xp: Math.round(pay / 45),
          mode: 'ground',
          route,
          pickupAt: a.wait,
          dropAt: b.wait,
        });
        made++;
      }
    }
    out.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'air' ? -1 : 1) || a.type.minRank - b.type.minRank || a.pay - b.pay);
    void rank;
    return out;
  }

  accept(c: Contract) {
    this.abandon(true);
    const m = new Mission(c);
    this.active = m;
    for (const [, b] of this.boards) b.list = b.list.filter((x) => x !== c);
    if (siteRisk(c.from) >= 2) this.hooks.hotZone(c.from, true);
    if (siteRisk(c.to) >= 2 || ((c.roof || c.ropeAt) && c.risk >= 2)) this.hooks.hotZone(c.to, true);
    this.hooks.toast(`Contract accepted: ${c.type.name} → ${c.to.name}`, 'good');
    const what = c.type.kind === 'sling' ? `one ${c.type.name.toLowerCase()}, ${(c.mass / 1000).toFixed(1)} tonnes external` : `${c.count} ${noun(c.type, c.count)}, ${(c.mass / 1000).toFixed(1)} tonnes`;
    this.hooks.radio(
      `${c.from.name} Ops`,
      `${CALLSIGN}, tasking: ${what} at ${c.from.name}${c.mode === 'ground' ? ', roadside by the green smoke' : c.from.pads.length > 1 ? ` pad ${c.fromPad + 1}` : ''}, for ${c.to.name}${c.mode === 'ground' ? ' by road' : ''}.${c.type.urgent ? ' Priority urgent.' : ''}${siteRisk(c.to) >= 2 ? ' Be advised, destination is hot.' : ''}`,
    );
  }

  /** A smoke spot 6 m further from the road than a roadside point. */
  /** The area on a site that a contract's cargo belongs to: hospital, ammo point, supply yard, HQ or barracks. */
  private facilityFor(site: Site, type: CargoType): Facility | null {
    const want: FacilityKind =
      type.kind === 'casualties' ? 'medical' : type.kind === 'pallets' ? (type.id === 'ammo' ? 'ammo' : 'supply') : type.id === 'g_escort' ? 'hq' : 'barracks';
    return site.facilities.find((f) => f.kind === want) ?? null;
  }

  /**
   * Waypoints through the site's nearest gate, outside first, when `p` is
   * beyond its perimeter wall (roadside drops for road jobs); otherwise none.
   */
  private gatePath(site: Site, p: THREE.Vector3): THREE.Vector3[] {
    const wall = site.kind === 'base' ? 165 : site.kind === 'fob' ? 100 : site.kind === 'cop' ? 56 : 0;
    if (!wall || Math.hypot(p.x - site.x, p.z - site.z) < wall - 6) return [];
    let gate: Roads['gates'][number] | null = null;
    let bd = Infinity;
    for (const g of this.roads.gates) {
      if (g.site !== site.name) continue;
      const d = Math.hypot(g.x - p.x, g.z - p.z);
      if (d < bd) (bd = d), (gate = g);
    }
    if (!gate) return [];
    // Walk along the road's edge on the side the vehicle stopped.
    const px = -gate.dz;
    const pz = gate.dx;
    const sgn = Math.sign((p.x - gate.x) * px + (p.z - gate.z) * pz) || 1;
    const at = (along: number) => {
      const x = gate!.x + gate!.dx * along + px * sgn * 3.2;
      const z = gate!.z + gate!.dz * along + pz * sgn * 3.2;
      return new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
    };
    return [at(14), at(-16)];
  }

  /** Where a delivered load goes, and who comes out to help with it. */
  private destinationFor(c: Contract, dropPos: THREE.Vector3): Destination | null {
    const f = this.facilityFor(c.to, c.type);
    if (!f) return null;
    const crew = f.kind === 'ammo' || f.kind === 'supply' ? c.to.facilities.find((x) => x.kind === 'barracks') ?? f : f;
    const helpers: Record<FacilityKind, Destination['helpers']> = { medical: 'medic', ammo: 'porter', supply: 'porter', hq: 'orderly', barracks: null };
    const via = this.gatePath(c.to, dropPos);
    // Helpers wait at the edge of the landing area (or beside the road), on the facility's side.
    const toward = via[0] ?? f.approach;
    const dir = new THREE.Vector3(toward.x - dropPos.x, 0, toward.z - dropPos.z);
    const span = dir.length();
    dir.divideScalar(span || 1);
    const meet = dropPos.clone().addScaledVector(dir, Math.min(span * 0.8, c.mode === 'ground' ? 6 : 19));
    return {
      door: f.door,
      approach: f.approach,
      area: f.area,
      yaw: f.yaw,
      exitDoor: crew.door,
      exitApproach: crew.approach,
      helpers: helpers[f.kind],
      via,
      key: `${c.to.id}:${f.kind}`,
      meet,
      meetDir: dir,
    };
  }

  /** Where a pickup musters from, if it can walk out from its facility before the player arrives. */
  private sourceFor(c: Contract, pickupPos: THREE.Vector3, eta: number): Source | undefined {
    const f = this.facilityFor(c.from, c.type);
    if (!f) return undefined;
    const start = f.area ?? f.door;
    const speed = c.type.actor === 'soldier' ? 2.6 : 1.6;
    const reach = Math.min(220, speed * eta * 0.8);
    if (Math.hypot(start.x - pickupPos.x, start.z - pickupPos.z) > reach) return undefined;
    return { door: f.door, approach: f.approach, area: f.area, via: this.gatePath(c.from, pickupPos).reverse() };
  }

  private besideRoad(p: THREE.Vector3): THREE.Vector3 {
    const out = this.tmp.copy(p);
    for (let k = 0; k < 8 && this.roads.distance(out.x, out.z) < 17; k++) {
      const e = 0.5;
      const gx = this.roads.distance(out.x + e, out.z) - this.roads.distance(out.x - e, out.z);
      const gz = this.roads.distance(out.x, out.z + e) - this.roads.distance(out.x, out.z - e);
      const gl = Math.hypot(gx, gz) || 1;
      out.x += (gx / gl) * 1.2;
      out.z += (gz / gl) * 1.2;
    }
    out.y = this.terrain.heightAt(out.x, out.z) + 0.3;
    return out;
  }

  abandon(silent = false) {
    const m = this.active;
    if (!m) return;
    this.cleanup(m);
    this.active = null;
    if (!silent) this.hooks.toast('Contract abandoned', 'bad');
  }

  private cleanup(m: Mission) {
    if (m.group) {
      if (m.group.aboard > 0) this.hooks.payloadChanged(-m.group.aboard * m.group.unitMass);
      // Delivered loads finish walking to their facility before they're cleaned up.
      if (m.phase === 'complete') this.cargo.retire(m.group);
      else this.cargo.remove(m.group);
    }
    if (m.load) {
      if (this.sling.hooked === m.load) this.sling.release();
      const l = m.load;
      setTimeout(() => this.sling.remove(l), m.phase === 'complete' ? 20000 : 0);
    }
    this.effects.removeEmitter(m.pickupSmoke);
    this.effects.removeEmitter(m.dropSmoke);
    this.hooks.hotZone(m.c.from, false);
    this.hooks.hotZone(m.c.to, false);
  }

  fail(reason: string) {
    const m = this.active;
    if (!m) return;
    m.phase = 'failed';
    this.cleanup(m);
    this.active = null;
    this.hooks.failed(reason, m);
  }

  /** Per-frame cargo condition: g-forces, bank, etc. */
  private wear(m: Mission, carrier: Carrier, dt: number) {
    const carrying = (m.group && m.group.aboard > 0) || (m.load && this.sling.hooked === m.load);
    if (!carrying) return;
    const f = m.c.type.fragility;
    m.nz += (carrier.loadFactor - m.nz) * Math.min(1, dt * 8);
    const nz = m.nz;
    const over = Math.max(0, nz - 1.45) + Math.max(0, 0.55 - nz);
    const bank = Math.max(0, Math.abs(carrier.roll) - 0.7) + Math.max(0, Math.abs(carrier.pitch) - 0.5);
    m.condition = clamp(m.condition - (over * 6 + bank * 4) * f * dt, 0, 100);
  }

  onHit() {
    const m = this.active;
    if (!m) return;
    m.hits++;
    m.condition = Math.max(0, m.condition - 1.2 * m.c.type.fragility);
  }

  onLanding(r: LandingRating, vs: number) {
    const m = this.active;
    if (!m) return;
    if (m.group && m.group.aboard > 0 && vs > 2.2) m.condition = Math.max(0, m.condition - (vs - 2.2) * 8 * m.c.type.fragility);
    m.landing = r;
  }

  update(dt: number, carrier: Carrier) {
    const m = this.active;
    if (!m) return;
    m.elapsed += dt;
    const c = m.c;
    const hp = carrier.pos;
    const dPickup = Math.hypot(hp.x - m.target.x, hp.z - m.target.z);
    const dDrop = Math.hypot(hp.x - m.dropPos.x, hp.z - m.dropPos.z);

    // Spawn the cargo when the player gets close enough to see it.
    if (!m.spawned && m.phase === 'pickup' && dPickup < 2500) {
      m.spawned = true;
      const pad = c.from.pads[c.fromPad];
      if (m.internal) {
        m.group = this.cargo.spawnWaiting(
          c.type.actor!,
          c.count,
          c.type.unitMass,
          m.pickupPos,
          c.pickupAt ? this.roads.curbside(c.from.x, c.from.z, c.from.radius)?.road ?? pad : pad,
          // Rough ETA: fast cruise by air, convoy speed by road.
          this.sourceFor(c, m.pickupPos, dPickup / (c.mode === 'ground' ? 14 : 55)),
        );
        // A hot pickup: the troops wait in a kneeling perimeter, weapons up.
        m.group.hostile = siteRisk(c.from) >= 2 || c.from.enemySide;
      } else {
        const load = new SlingLoad(c.type.sling!, c.mass);
        load.placeAt(pad, this.terrain, this.rng.range(0, Math.PI * 2));
        this.sling.add(load);
        m.load = load;
      }
    }
    if (m.phase === 'pickup' && !m.calledPickup && dPickup < 1500 && dPickup > 150) {
      m.calledPickup = true;
      this.hooks.radio(`${c.from.name} Ground`, `${CALLSIGN}, we have you in sight. ${m.internal ? 'Passengers are staged' : 'Load is rigged'}, popping green smoke.`);
    }
    if (m.phase === 'transit' && !m.calledDrop && dDrop < 1500) {
      m.calledDrop = true;
      const hot = siteRisk(c.to) >= 2 || ((!!c.roof || !!c.ropeAt) && c.risk >= 2);
      if (c.ropeAt)
        this.hooks.radio(
          'Team leader',
          hot
            ? `${CALLSIGN}, insertion point is marked with red smoke, we're taking fire down there. Hover five to twenty metres and hold it, ropes go out as soon as you're steady.`
            : `${CALLSIGN}, insertion point marked with yellow smoke. Hover five to twenty metres over it and hold steady for the ropes.`,
        );
      else if (c.roof) {
        // The heading with the most room over the roof (either way along it), to the nearest 10°.
        const deg = Math.round((((Math.atan2(Math.sin(c.roof.heading), -Math.cos(c.roof.heading)) * 180) / Math.PI + 360) % 360) / 10) * 10 % 360;
        const lineUp = `Roof's clear lined up on ${String(deg).padStart(3, '0')} or ${String((deg + 180) % 360).padStart(3, '0')}.`;
        this.hooks.radio(
          'Team leader',
          hot
            ? `${CALLSIGN}, target roof is marked with red smoke. Contact on the streets, they'll be shooting at you. Low hover, we go fast. ${lineUp}`
            : `${CALLSIGN}, target roof is marked with yellow smoke. Bring us to a low hover over it, we'll go off the side. No need to set down. ${lineUp}`,
        );
      }
      else {
        this.hooks.radio(
          c.to.name,
          hot
            ? `${CALLSIGN}, ${c.mode === 'ground' ? 'we are' : 'LZ is HOT,'} taking fire from the east! Red smoke is out${c.mode === 'ground' ? ' by the road' : ''}. Make it quick.`
            : c.mode === 'ground'
              ? `${CALLSIGN}, ${c.to.name}. Yellow smoke is out by the road — pull up beside it.`
              : `${CALLSIGN}, ${c.to.name}. LZ is cold, yellow smoke is out. Cleared to land.`,
        );
      }
    }
    if (m.phase === 'pickup' && !m.pickupSmoke && dPickup < 1800) {
      const sp = m.internal ? m.pickupPos : c.from.pads[c.fromPad];
      m.pickupSmoke = this.effects.addEmitter(c.mode === 'ground' ? this.besideRoad(sp) : this.tmp.copy(sp).add(new THREE.Vector3(m.internal ? 6 : 14, 0.3, 0)), 'green');
    }
    if (m.phase !== 'pickup' && !m.dropSmoke && dDrop < 1800) {
      this.effects.removeEmitter(m.pickupSmoke);
      m.pickupSmoke = null;
      const hot = siteRisk(c.to) >= 2;
      const at = c.ropeAt
        ? this.tmp.set(c.ropeAt.x, c.ropeAt.y + 0.3, c.ropeAt.z)
        : c.roof
        ? this.tmp.set(c.roof.x + c.roof.clear * 0.7, c.roof.y + 0.3, c.roof.z) // on the roof, at the edge of the clear patch
        : c.mode === 'ground'
          ? this.besideRoad(m.dropPos)
          : this.tmp.copy(m.dropPos).add(new THREE.Vector3(16, 0.3, 4));
      m.dropSmoke = this.effects.addEmitter(at, hot || ((c.roof || c.ropeAt) && c.risk >= 2) ? 'red' : 'yellow');
    }

    this.wear(m, carrier, dt);
    const rightVehicle = carrier.kind === c.mode;

    if (m.phase === 'pickup') {
      if (m.internal && m.group && rightVehicle) {
        const rampEnd = carrier.rampEndWorld(this.tmp);
        const close = Math.hypot(rampEnd.x - m.pickupPos.x, rampEnd.z - m.pickupPos.z) < (c.mode === 'ground' ? 30 : 75);
        if (m.group.allAboard) {
          m.phase = 'transit';
        } else if (close && carrier.loadable && !carrier.rampDown && carrier.onGround && Math.random() < dt * 0.4) {
          this.hooks.toast(c.mode === 'ground' ? 'Open the rear doors [R] to load' : 'Lower the ramp [R] to load', 'info');
        }
      } else if (m.load && this.sling.hooked === m.load) {
        m.phase = 'transit';
        this.hooks.toast(`Load hooked. Deliver to ${c.to.name} — set it down inside the smoke`, 'good');
      }
    } else if (m.phase === 'transit') {
      if (m.internal && m.group && !m.destSet && dDrop < (c.mode === 'ground' ? 250 : 800)) {
        // Inbound: the receiving facility sends its people out to meet the load.
        m.destSet = true;
        const dest = this.destinationFor(c, m.dropPos);
        if (dest) this.cargo.setDestination(m.group, dest);
      }
      if ((c.roof && m.timeLeft < -45) || (c.ropeAt && m.timeLeft < -60)) {
        this.fail('Insertion window missed: the team stood down');
        return;
      }
      if (c.ropeAt && m.group && rightVehicle && dDrop < 150 && !this.ropeReady(c.ropeAt, carrier) && Math.random() < dt * 0.25)
        this.hooks.toast(`Fast rope: hover over the smoke, 5–20 m up, under ${c.ropeAt.kind === 'street' || c.ropeAt.kind === 'plaza' ? 'a few' : 'ten'} metres from it, steady`, 'info');
      if (c.roof && m.group && rightVehicle && dDrop < 120 && !this.roofReady(c.roof, carrier) && Math.random() < dt * 0.25)
        this.hooks.toast(
          carrier.cabinLayout.sideBenches
            ? 'Hover low and steady over the roof: skids within 2 m of it, over the clear patch'
            : 'Lower the ramp and back it over the roof: ramp end on or just above the roof edge, hold steady',
          'info',
        );
      if (m.internal && m.group) {
        const ready = c.roof
          ? rightVehicle && this.roofReady(c.roof, carrier)
          : c.ropeAt
            ? rightVehicle && this.ropeReady(c.ropeAt, carrier)
            : rightVehicle && carrier.loadable && carrier.rampDown && dDrop < (c.mode === 'ground' ? 30 : 70);
        if (ready) {
          m.phase = 'dropoff';
          // Unloading into a hot zone: troops push out into a security perimeter.
          m.group.hostile = siteRisk(c.to) >= 2 || c.to.enemySide;
          if (!m.destSet) {
            m.destSet = true;
            const dest = this.destinationFor(c, m.dropPos);
            if (dest) this.cargo.setDestination(m.group, dest);
          }
          const rally = this.tmp2.copy(m.dropPos);
          if (c.ropeAt) {
            this.cargo.setRope(m.group, { x: c.ropeAt.x, z: c.ropeAt.z, r: c.ropeAt.r });
            this.hooks.toast('Ropes out — hold the hover…', 'info');
            return;
          }
          if (c.roof) {
            // On the roof: they fan out round the clear patch and take up a perimeter.
            this.cargo.setRoof(m.group, c.roof);
            this.hooks.toast('Team going off onto the roof — hold the hover…', 'info');
            return;
          }
          if (c.mode === 'ground') {
            // Walk off the road into the site.
            const dir = this.tmp.set(c.to.x - rally.x, 0, c.to.z - rally.z).normalize();
            rally.addScaledVector(dir, 18);
          } else {
            const dir = this.tmp.copy(carrier.rampEndWorld(this.tmp)).sub(hp).setY(0).normalize();
            rally.addScaledVector(dir, 34);
          }
          this.cargo.setRally(m.group, rally);
          this.hooks.toast('Unloading…', 'info');
        }
      } else if (m.load) {
        const l = m.load;
        const free = this.sling.hooked !== l;
        const dz = Math.hypot(l.pos.x - m.dropPos.x, l.pos.z - m.dropPos.z);
        if (free && l.onGround && l.vel.lengthSq() < 0.05 && !l.destroyed) {
          if (dz < 22) {
            m.setDownImpact = l.maxImpact;
            this.finish(m);
          }
        }
      }
    } else if (m.phase === 'dropoff' && m.group) {
      if (m.group.allOff) this.finish(m);
    }
  }

  /** Context for the cargo actors each frame. */
  loadContext(carrier: Carrier): { canLoad: boolean; canUnload: boolean } {
    const m = this.active;
    if (!m || !m.group || carrier.kind !== m.c.mode) return { canLoad: false, canUnload: false };
    const c = m.c;
    const rampEnd = carrier.rampEndWorld(this.tmp);
    const ok = carrier.loadable && carrier.rampDown;
    const canLoad = m.phase === 'pickup' && ok && Math.hypot(rampEnd.x - m.pickupPos.x, rampEnd.z - m.pickupPos.z) < (c.mode === 'ground' ? 30 : 75);
    const canUnload = m.phase === 'dropoff' && (c.roof ? this.roofReady(c.roof, carrier) : c.ropeAt ? this.ropeReady(c.ropeAt, carrier) : ok);
    return { canLoad, canUnload };
  }

  /**
   * Holding a fast-rope hover: slow and steady, within a few metres of the
   * point (its clear radius, plus a little), gear 3–20 m above the ground there.
   */
  ropeReady(p: InsertPoint, carrier: Carrier): boolean {
    if (carrier.kind !== 'air') return false;
    const v = carrier.vel;
    if (Math.hypot(v.x, v.z) > 2.5 || Math.abs(v.y) > 1.5) return false;
    if (Math.hypot(carrier.pos.x - p.x, carrier.pos.z - p.z) > p.r + 3) return false;
    const h = carrier.gearBottom - p.y;
    return h > 3 && h < 20;
  }

  /**
   * Holding a drop hover over the roof: slow and steady, and close enough for
   * the team to step off. Little Bird: over the clear patch with the skids no
   * more than ~2.5 m up. Chinook: ramp down, its end over the roof and at most
   * ~1.8 m above it (the body can hang off the edge).
   */
  roofReady(r: Rooftop, carrier: Carrier): boolean {
    if (carrier.kind !== 'air') return false;
    const v = carrier.vel;
    if (Math.hypot(v.x, v.z) > 2 || Math.abs(v.y) > 1.2) return false;
    if (carrier.cabinLayout.sideBenches) {
      const d = Math.hypot(carrier.pos.x - r.x, carrier.pos.z - r.z);
      const h = carrier.gearBottom - r.y;
      return d < Math.max(1, r.clear - 1.2) && h > -0.3 && h < 2.6;
    }
    if (!carrier.rampDown) return false;
    const e = carrier.rampEndWorld(this.tmp);
    const h = e.y - r.y;
    return Math.hypot(e.x - r.x, e.z - r.z) < r.clear + 0.5 && h > -0.5 && h < 1.8 && !!this.rooftops?.onRoof(r, e.x, e.z);
  }

  private finish(m: Mission) {
    m.phase = 'complete';
    const c = m.c;
    const lines: PayoutLine[] = [{ label: `${c.type.name} — ${c.from.name} → ${c.to.name}`, amount: c.pay }];
    const frac = m.timeLeft / c.timeLimit;
    if (frac > 0.35) lines.push({ label: c.roof || c.ropeAt ? 'Fast insertion' : c.type.urgent ? 'Golden-hour bonus' : 'Early delivery', amount: Math.round(c.pay * (c.type.urgent ? 0.25 : 0.12)) });
    if (m.timeLeft < 0) lines.push({ label: `Late by ${Math.ceil(-m.timeLeft)}s`, amount: -Math.round(c.pay * Math.min(0.5, -m.timeLeft / c.timeLimit)) });
    const cond = Math.round(m.condition);
    if (cond < 100) lines.push({ label: `Cargo condition ${cond}%`, amount: -Math.round(c.pay * (1 - cond / 100) * 0.9) });
    if (cond >= 99) lines.push({ label: 'Smooth ride', amount: Math.round(c.pay * 0.1) });
    if (c.ropeAt) {
      if (!m.landing) lines.push({ label: 'Fast-rope insertion, never touched down', amount: Math.round(c.pay * 0.12) });
    } else if (c.roof) {
      if (!m.landing) lines.push({ label: 'Hover insertion, never touched down', amount: Math.round(c.pay * 0.15) });
    } else if (m.internal) {
      if (m.landing === 'BUTTER') lines.push({ label: 'Butter landing', amount: 300 });
      else if (m.landing === 'SMOOTH') lines.push({ label: 'Smooth landing', amount: 150 });
    } else if (m.setDownImpact < 1.2) lines.push({ label: 'Precise set-down', amount: 300 });
    if (m.hits > 0) lines.push({ label: `Hazard pay (${m.hits} hits taken)`, amount: Math.min(2000, m.hits * 60) });
    const total = Math.max(0, lines.reduce((s, l) => s + l.amount, 0));
    this.hooks.radio(
      c.to.name,
      cond >= 95
        ? `Good drop, ${CALLSIGN}. Smooth ride — thanks for the lift.`
        : cond >= 70
          ? `${CALLSIGN}, delivery received. Bit rough on the way in.`
          : `${CALLSIGN}, we got it… what's left of it. Doc wants a word about your flying.`,
    );
    const xp = Math.round(c.xp * (0.5 + 0.5 * (cond / 100)) + (m.landing === 'BUTTER' ? 25 : 0));
    this.cleanup(m);
    this.active = null;
    this.hooks.complete({ contract: c, lines, total, xp, condition: cond, time: m.elapsed });
  }
}

export function noun(t: CargoType, n: number) {
  if (t.kind === 'troops') return n === 1 ? 'soldier' : 'soldiers';
  if (t.kind === 'casualties') return n === 1 ? 'casualty' : 'casualties';
  if (t.kind === 'pallets') return n === 1 ? 'pallet' : 'pallets';
  return 'load';
}
