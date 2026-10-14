import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Site, SiteKind } from '../world/sites';
import type { ActorKind, CargoGroup, CargoManager } from './cargo';
import { SlingLoad, type SlingModel, type SlingSystem } from './sling';
import type { Heli, LandingRating } from '../heli/heli';
import type { Effects, SmokeEmitter } from '../fx/effects';
import type { Terrain } from '../world/terrain';
import { clamp } from '../util/math';

export type CargoKind = 'troops' | 'pallets' | 'casualties' | 'sling';

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

export interface Contract {
  id: number;
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
  landing: LandingRating | null = null;
  setDownImpact = 0;
  hits = 0;
  calledPickup = false;
  calledDrop = false;
  constructor(readonly c: Contract) {}
  get timeLeft() {
    return this.c.timeLimit - this.elapsed;
  }
  get internal() {
    return this.c.type.kind !== 'sling';
  }
  get pickupPos(): THREE.Vector3 {
    return this.internal ? this.c.from.waits[this.c.fromPad] : this.c.from.pads[this.c.fromPad];
  }
  get dropPos(): THREE.Vector3 {
    return this.c.to.pads[this.c.toPad];
  }
  /** Where the player should currently be heading. */
  get target(): THREE.Vector3 {
    return this.phase === 'pickup' ? this.c.from.pads[this.c.fromPad] : this.dropPos;
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
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    private sites: Site[],
    private rng: RNG,
    private cargo: CargoManager,
    private sling: SlingSystem,
    private effects: Effects,
    private terrain: Terrain,
    private hooks: MissionHooks,
  ) {
    cargo.onBoard = (g) => {
      if (this.active?.group === g) this.hooks.payloadChanged(g.unitMass);
      if (this.active?.group === g) {
        const n = g.aboard;
        if (n === g.total) this.hooks.toast(`All ${noun(this.active.c.type, n)} aboard — raise the ramp [R] and fly to ${this.active.c.to.name}`, 'good');
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
        const cands = this.sites.filter((s) => s !== site && t.from.includes(s.kind) && sideOk(t, s) && dist2(s, site) < 3800);
        if (!cands.length) continue;
        from = rng.pick(cands);
      }
      const tos = this.sites.filter((s) => s !== from && t.to.includes(s.kind) && sideOk(t, s) && dist2(s, from) > 700 && dist2(s, from) < 5200);
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
      });
    }
    out.sort((a, b) => a.type.minRank - b.type.minRank || a.pay - b.pay);
    void rank;
    return out;
  }

  accept(c: Contract) {
    this.abandon(true);
    const m = new Mission(c);
    this.active = m;
    for (const [, b] of this.boards) b.list = b.list.filter((x) => x !== c);
    if (siteRisk(c.from) >= 2) this.hooks.hotZone(c.from, true);
    if (siteRisk(c.to) >= 2) this.hooks.hotZone(c.to, true);
    this.hooks.toast(`Contract accepted: ${c.type.name} → ${c.to.name}`, 'good');
    const what = c.type.kind === 'sling' ? `one ${c.type.name.toLowerCase()}, ${(c.mass / 1000).toFixed(1)} tonnes external` : `${c.count} ${noun(c.type, c.count)}, ${(c.mass / 1000).toFixed(1)} tonnes`;
    this.hooks.radio(
      `${c.from.name} Ops`,
      `${CALLSIGN}, tasking: ${what} at ${c.from.name}${c.from.pads.length > 1 ? ` pad ${c.fromPad + 1}` : ''}, for ${c.to.name}.${c.type.urgent ? ' Priority urgent.' : ''}${siteRisk(c.to) >= 2 ? ' Be advised, destination is hot.' : ''}`,
    );
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
      // Leave people that already got off walking around for a bit.
      const g = m.group;
      setTimeout(() => this.cargo.remove(g), m.phase === 'complete' ? 12000 : 0);
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
  private wear(m: Mission, heli: Heli, dt: number) {
    const carrying = (m.group && m.group.aboard > 0) || (m.load && this.sling.hooked === m.load);
    if (!carrying) return;
    const f = m.c.type.fragility;
    const fm = heli.fm;
    const nz = fm.loadFactor;
    const over = Math.max(0, nz - 1.45) + Math.max(0, 0.55 - nz);
    const bank = Math.max(0, Math.abs(fm.roll) - 0.7) + Math.max(0, Math.abs(fm.pitch) - 0.5);
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

  update(dt: number, heli: Heli) {
    const m = this.active;
    if (!m) return;
    m.elapsed += dt;
    const c = m.c;
    const hp = heli.fm.pos;
    const dPickup = Math.hypot(hp.x - c.from.pads[c.fromPad].x, hp.z - c.from.pads[c.fromPad].z);
    const dDrop = Math.hypot(hp.x - m.dropPos.x, hp.z - m.dropPos.z);

    // Spawn the cargo when the player gets close enough to see it.
    if (!m.spawned && m.phase === 'pickup' && dPickup < 2500) {
      m.spawned = true;
      const pad = c.from.pads[c.fromPad];
      if (m.internal) {
        m.group = this.cargo.spawnWaiting(c.type.actor!, c.count, c.type.unitMass, c.from.waits[c.fromPad], pad);
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
      const hot = siteRisk(c.to) >= 2;
      this.hooks.radio(
        c.to.name,
        hot
          ? `${CALLSIGN}, LZ is HOT, taking fire from the east! Red smoke is out. Make it quick.`
          : `${CALLSIGN}, ${c.to.name}. LZ is cold, yellow smoke is out. Cleared to land.`,
      );
    }
    if (m.phase === 'pickup' && !m.pickupSmoke && dPickup < 1800) {
      const sp = m.internal ? c.from.waits[c.fromPad] : c.from.pads[c.fromPad];
      m.pickupSmoke = this.effects.addEmitter(this.tmp.copy(sp).add(new THREE.Vector3(m.internal ? 6 : 14, 0.3, 0)), 'green');
    }
    if (m.phase !== 'pickup' && !m.dropSmoke && dDrop < 1800) {
      this.effects.removeEmitter(m.pickupSmoke);
      m.pickupSmoke = null;
      const hot = siteRisk(c.to) >= 2;
      m.dropSmoke = this.effects.addEmitter(this.tmp.copy(m.dropPos).add(new THREE.Vector3(16, 0.3, 4)), hot ? 'red' : 'yellow');
    }

    this.wear(m, heli, dt);

    if (m.phase === 'pickup') {
      if (m.internal && m.group) {
        const rampEnd = heli.rampEndWorld(this.tmp);
        const close = Math.hypot(rampEnd.x - c.from.waits[c.fromPad].x, rampEnd.z - c.from.waits[c.fromPad].z) < 75;
        if (m.group.allAboard) {
          m.phase = 'transit';
        } else if (close && heli.loadable && !heli.rampDown && heli.fm.contacts >= 3 && Math.random() < dt * 0.4) {
          this.hooks.toast('Lower the ramp [R] to load', 'info');
        }
      } else if (m.load && this.sling.hooked === m.load) {
        m.phase = 'transit';
        this.hooks.toast(`Load hooked. Deliver to ${c.to.name} — set it down inside the smoke`, 'good');
      }
    } else if (m.phase === 'transit') {
      if (m.internal && m.group) {
        if (heli.loadable && heli.rampDown && dDrop < 70) {
          m.phase = 'dropoff';
          const rally = this.tmp2.copy(m.dropPos);
          const dir = this.tmp.copy(heli.rampEndWorld(this.tmp)).sub(hp).setY(0).normalize();
          rally.addScaledVector(dir, 34);
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
  loadContext(heli: Heli): { canLoad: boolean; canUnload: boolean } {
    const m = this.active;
    if (!m || !m.group) return { canLoad: false, canUnload: false };
    const c = m.c;
    const rampEnd = heli.rampEndWorld(this.tmp);
    const ok = heli.loadable && heli.rampDown;
    const canLoad = m.phase === 'pickup' && ok && Math.hypot(rampEnd.x - c.from.waits[c.fromPad].x, rampEnd.z - c.from.waits[c.fromPad].z) < 75;
    const canUnload = m.phase === 'dropoff' && ok;
    return { canLoad, canUnload };
  }

  private finish(m: Mission) {
    m.phase = 'complete';
    const c = m.c;
    const lines: PayoutLine[] = [{ label: `${c.type.name} — ${c.from.name} → ${c.to.name}`, amount: c.pay }];
    const frac = m.timeLeft / c.timeLimit;
    if (frac > 0.35) lines.push({ label: c.type.urgent ? 'Golden-hour bonus' : 'Early delivery', amount: Math.round(c.pay * (c.type.urgent ? 0.25 : 0.12)) });
    if (m.timeLeft < 0) lines.push({ label: `Late by ${Math.ceil(-m.timeLeft)}s`, amount: -Math.round(c.pay * Math.min(0.5, -m.timeLeft / c.timeLimit)) });
    const cond = Math.round(m.condition);
    if (cond < 100) lines.push({ label: `Cargo condition ${cond}%`, amount: -Math.round(c.pay * (1 - cond / 100) * 0.9) });
    if (cond >= 99) lines.push({ label: 'Smooth ride', amount: Math.round(c.pay * 0.1) });
    if (m.internal) {
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
