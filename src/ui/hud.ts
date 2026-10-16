import * as THREE from 'three';
import { PLAY_HALF } from '../world/terrain';
import type { Game } from '../game';
import { fmtDist, fmtMoney, fmtTime, clamp } from '../util/math';
import { RANKS } from '../game/career';
import { SAS_NAMES } from '../heli/flight';
import { noun, siteRisk } from '../game/missions';
import type { MapMarker, RouteDraw } from './map';
import type { Maneuver } from '../game/gps';
import { SITE_COLOR } from './map';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private canvas = $('hud') as HTMLCanvasElement;
  private g = this.canvas.getContext('2d')!;
  private mini = ($('minimap') as HTMLCanvasElement).getContext('2d')!;
  private big = ($('bigmap') as HTMLCanvasElement).getContext('2d')!;
  private els: Record<string, HTMLElement> = {};
  private domT = 0;
  private bigT = 0;
  private bigTextTimer = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    for (const id of [
      'hud-money', 'hud-rank', 'hud-xp', 'h-ias', 'h-ralt', 'h-vs', 'h-gs', 'h-hdg', 'h-coll', 'h-nr', 'h-trq', 'h-fuel', 'h-gw', 'h-hull',
      'h-flr', 'h-load', 'm-title', 'm-obj', 'm-stats', 'warnings', 'status-line', 'prompt', 'bigtext', 'toasts',
    ])
      this.els[id] = $(id);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  show(on: boolean) {
    $('hud-dom').classList.toggle('hidden', !on);
    this.canvas.classList.toggle('hidden', !on);
  }

  private recentToasts = new Map<string, number>();

  toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
    // Don't stack identical messages.
    const now = performance.now();
    if (now - (this.recentToasts.get(msg) ?? -1e9) < 4000) return;
    this.recentToasts.set(msg, now);
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    this.els.toasts.prepend(el);
    while (this.els.toasts.children.length > 4) this.els.toasts.lastChild!.remove();
    setTimeout(() => el.remove(), 5000);
  }

  radio(from: string, msg: string) {
    const box = document.getElementById('radio')!;
    const el = document.createElement('div');
    el.className = 'radio-msg';
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector('b')!.textContent = from;
    el.querySelector('span')!.textContent = msg;
    box.append(el);
    while (box.children.length > 3) box.firstChild!.remove();
    setTimeout(() => el.classList.add('old'), 12000);
    setTimeout(() => el.remove(), 16000);
  }

  bigText(main: string, sub = '', secs = 2.2) {
    this.els.bigtext.innerHTML = `${main}${sub ? `<small>${sub}</small>` : ''}`;
    this.els.bigtext.classList.add('show');
    this.bigTextTimer = secs;
  }

  setPrompt(html: string) {
    if (this.els.prompt.innerHTML !== html) this.els.prompt.innerHTML = html;
  }

  /** Draw the theater map again on the next update (after a zoom or pan). */
  redrawMap() {
    this.bigT = 0;
  }

  markers(game: Game): MapMarker[] {
    const out: MapMarker[] = [];
    const w = game.waypoint;
    if (w) out.push({ x: w.x, z: w.z, color: '#4fd1ff', label: 'WAYPOINT' });
    const m = game.missions.active;
    if (!m) return out;
    const t = m.target;
    out.push({ x: t.x, z: t.z, color: '#ff9a2e', label: m.phase === 'pickup' ? `PICKUP ${m.c.from.name}` : `DROP ${m.c.to.name}` });
    return out;
  }

  /** The GPS route to draw on the maps (while driving). */
  private routeDraw(game: Game): RouteDraw | undefined {
    const r = game.gps.route;
    if (!r || game.mode !== 'drive') return undefined;
    return { route: r, progress: game.gps.progress, x: game.playerPos.x, z: game.playerPos.z };
  }

  /** What the GPS is taking the player to. */
  private gpsLabel(game: Game): string {
    if (game.waypoint) return 'your waypoint';
    const m = game.missions.active;
    if (m?.c.mode === 'ground') return m.targetSite.name;
    return 'the helicopter';
  }

  private gpsArrow = (document.getElementById('gps-arrow') as HTMLCanvasElement | null)?.getContext('2d') ?? null;

  /** The satnav panel above the minimap: next turn, how far to it, and what's left. */
  private updateGpsPanel(game: Game) {
    const panel = $('gps-panel');
    const gps = game.gps;
    const on = game.mode === 'drive' && !!gps.destination;
    panel.classList.toggle('hidden', !on);
    if (!on) return;
    const e = this.els;
    const g = this.gpsArrow;
    const r = gps.route;
    let dist = '';
    let instr = '';
    let total = '';
    let draw: Maneuver | 'arrive' | 'none' = 'none';
    if (!r) {
      instr = 'No road route';
    } else if (gps.recalculating) {
      instr = 'Recalculating…';
    } else {
      const next = gps.next;
      const left = gps.remaining;
      if (next) {
        draw = next;
        dist = fmtDist(Math.max(0, next.s - gps.progress));
        instr = MANEUVER_TEXT[next.kind];
        const then = gps.after(next);
        if (then) instr += `, then ${MANEUVER_TEXT[then.kind].toLowerCase()}`;
      } else {
        draw = 'arrive';
        dist = fmtDist(left);
        instr = `Arrive at ${this.gpsLabel(game)}`;
      }
      const v = Math.max(8, game.humvee.groundSpeed);
      total = `${fmtDist(left)} · ${fmtTime(left / v)}`;
      if (gps.progress < 1 && gps.offRoute > 40) instr = `Head for the road (${fmtDist(gps.offRoute)})`;
    }
    (e['gps-dist'] ??= $('gps-dist')).textContent = dist;
    (e['gps-instr'] ??= $('gps-instr')).textContent = instr;
    (e['gps-total'] ??= $('gps-total')).textContent = total;
    if (g) drawTurnIcon(g, 64, draw);
  }

  update(dt: number, game: Game) {
    const fm = game.heli.fm;
    this.bigTextTimer -= dt;
    if (this.bigTextTimer <= 0) this.els.bigtext.classList.remove('show');
    this.drawCanvas(game);
    // The theater map: right away after a zoom or pan, otherwise a few times a second.
    if (game.mapOpen) {
      this.bigT -= dt;
      if (this.bigT <= 0) {
        this.bigT = 0.25;
        game.map.drawBig(this.big, 900, game.playerPos.x, game.playerPos.z, game.playerHeading, this.markers(game), game.battle.sectorInfo().map((i) => ({ x: i.x, z: i.z, name: i.s.name, control: i.control, active: i.active })), this.routeDraw(game), !!game.input.pad);
      }
    }

    this.domT -= dt;
    if (this.domT > 0) return;
    this.domT = 1 / 12;
    const e = this.els;
    const c = game.career;
    e['hud-money'].textContent = fmtMoney(c.data.money);
    const r = c.rank;
    e['hud-rank'].textContent = `${RANKS[r].name}${r < RANKS.length - 1 ? ` · ${c.data.xp}/${RANKS[r + 1].xp} XP` : ''}`;
    (e['hud-xp'] as HTMLElement).style.width = `${c.rankProgress * 100}%`;

    const hsKt = Math.hypot(fm.vel.x - game.wind.x, fm.vel.z - game.wind.z) * 1.944;
    e['h-ias'].textContent = hsKt.toFixed(0);
    e['h-ralt'].textContent = fm.agl < 300 ? Math.max(0, fm.agl).toFixed(fm.agl < 10 ? 1 : 0) : '---';
    e['h-vs'].textContent = (fm.vs >= 0 ? '+' : '') + fm.vs.toFixed(1);
    e['h-vs'].className = fm.vs < -5 && fm.agl < 60 ? 'bad' : fm.vs < -3 ? 'warn' : '';
    e['h-gs'].textContent = (fm.groundSpeed * 1.944).toFixed(0);
    e['h-hdg'].textContent = String(Math.round(((fm.heading * 180) / Math.PI + 360) % 360)).padStart(3, '0');
    (e['h-coll'] as HTMLElement).style.height = `${fm.input.collective * 100}%`;
    e['h-nr'].textContent = (fm.rpm * 100).toFixed(0);
    e['h-nr'].className = fm.engineOn && fm.rpm < 0.95 && fm.rpm > 0.5 && fm.engineSpool > 0.99 ? 'bad' : '';
    e['h-trq'].textContent = fm.torquePct.toFixed(0);
    e['h-trq'].className = fm.torquePct > 105 ? 'bad' : fm.torquePct > 95 ? 'warn' : '';
    e['h-fuel'].textContent = fm.fuel.toFixed(0);
    e['h-fuel'].className = fm.fuel < fm.fuelCapacity * 0.15 ? 'bad' : fm.fuel < fm.fuelCapacity * 0.3 ? 'warn' : '';
    e['h-gw'].textContent = (fm.mass + (game.sling.hooked ? game.sling.hooked.mass : 0)).toFixed(0);
    e['h-hull'].textContent = game.heli.hp.toFixed(0);
    e['h-hull'].className = game.heli.hp < 30 ? 'bad' : game.heli.hp < 60 ? 'warn' : '';
    e['h-flr'].textContent = String(game.heli.flares);
    const hk = game.sling.hooked;
    e['h-load'].textContent = hk ? `↓${(game.sling.tension / 9.81 / 1000).toFixed(1)}t` : fm.payload > 0 ? `${(fm.payload / 1000).toFixed(1)}t` : '—';

    // Mission panel.
    const m = game.missions.active;
    if (!m) {
      e['m-title'].textContent = 'No active contract';
      e['m-obj'].textContent = game.currentSite
        ? `At ${game.currentSite.name}. Open the terminal [Tab] to find work.`
        : 'Fly to a base or outpost and open the terminal [Tab] to find work.';
      e['m-stats'].innerHTML = '';
    } else {
      const ct = m.c;
      e['m-title'].textContent = `${ct.type.icon} ${ct.type.name}${ct.type.kind !== 'sling' ? ` ×${ct.count}` : ''} — ${fmtMoney(ct.pay)}`;
      const tgt = m.target;
      const pp = game.playerPos;
      const roadLeft = game.mode === 'drive' && game.gps.route ? game.gps.remaining : Infinity;
      const dist = isFinite(roadLeft) ? roadLeft : Math.hypot(tgt.x - pp.x, tgt.z - pp.z);
      const ground = ct.mode === 'ground';
      let obj = '';
      if (ground && game.mode !== 'drive') {
        obj = `Road job: get in your Humvee [G]${!game.vehiclesTogether() ? ' (it is parked elsewhere — check the map)' : ''}.`;
      } else if (!ground && game.mode === 'drive' && (m.phase === 'pickup' || m.phase === 'transit')) {
        obj = `Helicopter job: drive back to the helicopter and press [G] to switch. The Humvee can't carry this load.`;
      } else if (ground && m.phase === 'pickup') {
        const g = m.group;
        obj = g && g.aboard > 0 ? `Loading at ${ct.from.name}: ${g.aboard}/${g.total} aboard` : `Drive to the green smoke by the road at ${ct.from.name}, stop beside it and open the rear doors [R].`;
      } else if (ground && m.phase === 'transit') {
        obj = `Drive to ${ct.to.name} (${fmtDist(ct.route ?? dist)} by road). Stop by the yellow smoke, open the rear doors [R].`;
      } else if (m.phase === 'pickup') {
        if (ct.type.kind === 'sling') obj = `Hook the ${ct.type.name} at ${ct.from.name}. Hover with the hook over it, 2–9 m up, press [H].`;
        else {
          const g = m.group;
          obj = g && g.aboard > 0
            ? `Loading at ${ct.from.name}: ${g.aboard}/${g.total} ${noun(ct.type, g.total)} aboard`
            : `Land at ${ct.from.name} near the green smoke, lower the ramp [R].`;
        }
      } else if (m.phase === 'transit') {
        obj = ct.type.kind === 'sling'
          ? `Deliver to ${ct.to.name}. Set the load down inside the smoke and release [H].`
          : `Fly to ${ct.to.name}. Land by the ${siteRisk(ct.to) >= 2 ? 'red' : 'yellow'} smoke and lower the ramp.`;
      } else if (m.phase === 'dropoff') {
        obj = `Unloading at ${ct.to.name}… hold steady.`;
      }
      e['m-obj'].textContent = obj;
      const tl = m.timeLeft;
      const cond = Math.round(m.condition);
      const spd = game.mode === 'drive' ? game.humvee.groundSpeed : fm.groundSpeed;
      const eta = spd > 4 ? fmtTime((dist * (game.mode === 'drive' && !isFinite(roadLeft) ? 1.3 : 1)) / spd) : '--:--';
      e['m-stats'].innerHTML =
        `<span>DIST ${fmtDist(dist)}</span><span>ETA ${eta}</span>` +
        `<span class="${tl < 0 ? 'bad' : tl < 60 ? 'warn' : ''}">${tl < 0 ? 'LATE ' + fmtTime(-tl) : 'TIME ' + fmtTime(tl)}</span>` +
        `<span class="${cond < 70 ? 'bad' : cond < 95 ? 'warn' : ''}">CARGO ${cond}%</span>`;
    }

    // Driving panel vs flight instruments.
    const driving = game.mode === 'drive';
    $('flight-panel').classList.toggle('hidden', driving);
    $('sys-panel').classList.toggle('hidden', driving);
    $('drive-panel').classList.toggle('hidden', !driving);
    if (driving) {
      const v = game.humvee;
      $('d-speed').textContent = Math.abs(v.speed * 3.6).toFixed(0);
      $('d-gear').textContent = v.stalled ? 'STALL' : v.input.handbrake && v.groundSpeed < 0.5 ? 'P' : v.speed < -0.5 ? 'R' : 'D';
      $('d-doors').textContent = v.doorT > 0.95 ? 'OPEN' : v.doorT < 0.05 ? 'SHUT' : '…';
      $('d-load').textContent = v.payload > 0 ? `${v.payload.toFixed(0)} kg` : '—';
      $('d-hull').textContent = v.hp.toFixed(0);
      $('d-hull').className = v.hp < 40 ? 'bad' : v.hp < 70 ? 'warn' : '';
    }

    // Warnings.
    const w: string[] = [];
    const caution: string[] = [];
    if (driving) {
      if (game.threats.missileWarning) w.push('MISSILE');
      if (game.humvee.flipped) w.push('OVERTURNED');
      if (game.humvee.waterDepth > 0.5) caution.push('DEEP WATER');
      const html = w.map((x) => `<div>${x}</div>`).join('') + caution.map((x) => `<div class="caution">${x}</div>`).join('');
      if (e.warnings.innerHTML !== html) e.warnings.innerHTML = html;
    } else {
    if (game.threats.missileWarning) w.push('MISSILE');
    if (fm.vrs > 0.4) w.push('VORTEX RING');
    if (fm.engineOn && fm.engineSpool > 0.99 && fm.rpm < 0.93) w.push('LOW ROTOR RPM');
    if (fm.torquePct > 105) w.push('OVERTORQUE');
    if (fm.vs < -6 && fm.agl < 40 && fm.agl > 1) w.push('SINK RATE');
    if (game.heli.rotorWarn && game.mode === 'fly') w.push('ROTOR CLEARANCE');
    if (game.heli.hp < 30) w.push('DAMAGE');
    if (fm.fuel < fm.fuelCapacity * 0.15) caution.push('LOW FUEL');
    if (game.threats.underFire > 0) caution.push('UNDER FIRE');
    if (fm.torquePct > 95 && fm.torquePct <= 105) caution.push('HIGH TORQUE');
    if (Math.abs(fm.pos.x) > PLAY_HALF - 50 || Math.abs(fm.pos.z) > PLAY_HALF - 50) caution.push('LEAVING AO');
    const html = w.map((x) => `<div>${x}</div>`).join('') + caution.map((x) => `<div class="caution">${x}</div>`).join('');
    if (e.warnings.innerHTML !== html) e.warnings.innerHTML = html;
    }

    const ramp = game.heli.rampT > 0.97 ? 'DOWN' : game.heli.rampT < 0.03 ? 'UP' : 'MOVING';
    e['status-line'].innerHTML =
      (driving ? 'VEHICLE <b>HUMVEE</b><br>CAM' : `${game.heli.airframe.short.toUpperCase()} · SAS <b>${SAS_NAMES[fm.sas]}</b><br>CAM`) + ` <b>${game.cam.label}</b><br>` + (driving || game.heli.airframe.hasRamp ? `RAMP <b>${ramp}</b> · HOOK <b>${hk ? 'LOADED' : 'EMPTY'}</b>` : `BENCHES <b>${game.cargo.groups.reduce((n, g) => n + g.aboard, 0)}/${game.heli.airframe.seats}</b>`) +
      `<br>WIND <b>${String(Math.round(((Math.atan2(-game.wind.x, game.wind.z) * 180) / Math.PI + 360) % 360)).padStart(3, '0')}° ${(game.wind.length() * 1.944).toFixed(0)}kt</b>`;

    this.mini.save();
    this.mini.beginPath();
    this.mini.arc(100, 100, 100, 0, Math.PI * 2);
    this.mini.clip();
    // Driving with a route: a closer, heading-up view like a satnav, zooming out with speed.
    const rd = this.routeDraw(game);
    const range = rd ? clamp(320 + game.humvee.groundSpeed * 16, 320, 900) : 1500;
    game.map.drawMini(this.mini, 200, game.playerPos.x, game.playerPos.z, game.playerHeading, range, this.markers(game), game.air.jets.filter((j) => j.mesh.visible).map((j) => ({ x: j.pos.x, z: j.pos.z, heading: Math.atan2(j.dir.x, -j.dir.z), friendly: j.side === 'blue' })), rd, !!rd);
    this.mini.restore();
    this.updateGpsPanel(game);

  }

  private project(p: THREE.Vector3, cam: THREE.Camera, W: number, H: number): { x: number; y: number; behind: boolean } {
    // Far targets (past the camera's far plane, a dozen km out) would project as if behind
    // the camera: project a point in the same direction, well inside it, instead.
    const c = cam.position;
    const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
    if (d > 2000) this.tmp.set(c.x + ((p.x - c.x) / d) * 2000, c.y + ((p.y - c.y) / d) * 2000, c.z + ((p.z - c.z) / d) * 2000);
    else this.tmp.copy(p);
    const v = this.tmp.project(cam);
    const behind = v.z > 1;
    let x = (v.x * 0.5 + 0.5) * W;
    let y = (-v.y * 0.5 + 0.5) * H;
    if (behind) {
      x = W - x;
      y = H - y;
    }
    return { x, y, behind };
  }

  private drawCanvas(game: Game) {
    const g = this.g;
    const W = window.innerWidth;
    const H = window.innerHeight;
    g.clearRect(0, 0, W, H);
    const fm = game.heli.fm;
    const cam = game.cam.camera;
    const green = 'rgba(157,255,157,0.9)';
    g.lineWidth = 1.5;
    g.font = '12px ui-monospace, Menlo, monospace';

    // Heading tape.
    const hdg = (game.playerHeading * 180) / Math.PI;
    const pp = game.playerPos;
    const tapeW = Math.min(420, W * 0.5);
    const cx = W / 2;
    g.strokeStyle = green;
    g.fillStyle = green;
    g.textAlign = 'center';
    for (let d = Math.floor(hdg - 40); d <= hdg + 40; d++) {
      if (d % 5) continue;
      const x = cx + ((d - hdg) / 40) * (tapeW / 2);
      const big = d % 10 === 0;
      g.beginPath();
      g.moveTo(x, 18);
      g.lineTo(x, big ? 30 : 25);
      g.stroke();
      if (d % 30 === 0) {
        const n = ((d % 360) + 360) % 360;
        const lbl = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : String(n / 10);
        g.fillText(lbl, x, 44);
      }
    }
    g.beginPath();
    g.moveTo(cx, 14);
    g.lineTo(cx - 6, 6);
    g.lineTo(cx + 6, 6);
    g.closePath();
    g.fill();
    // Objective bearing bug on the tape.
    const m = game.missions.active;
    if (m) {
      const t = m.target;
      const brg = (Math.atan2(t.x - pp.x, -(t.z - pp.z)) * 180) / Math.PI;
      let d = brg - hdg;
      d = ((d + 540) % 360) - 180;
      const x = cx + clamp(d / 40, -1, 1) * (tapeW / 2);
      g.fillStyle = '#ff9a2e';
      g.fillRect(x - 4, 31, 8, 6);
    }

    // World markers: objective + nearby sites.
    const near = game.world.sites
      .map((s) => ({ s, d: Math.hypot(s.x - pp.x, s.z - pp.z) }))
      .filter((o) => o.d < 2200 && o.d > 120 && o.s !== m?.targetSite)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    const used: [number, number][] = [];
    for (const { s, d } of near) {
      const p = this.project(this.tmp.set(s.x, s.y + 25, s.z), cam, W, H);
      if (p.behind || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
      if (used.some(([x, y]) => Math.abs(x - p.x) < 150 && Math.abs(y - p.y) < 16)) continue;
      used.push([p.x, p.y]);
      g.fillStyle = SITE_COLOR[s.kind];
      g.globalAlpha = 0.85 - (d / 2200) * 0.45;
      g.fillText(`${s.name} · ${fmtDist(d)}`, p.x, p.y);
      g.globalAlpha = 1;
    }
    if (m) {
      const t = m.target;
      const p = this.project(this.tmp.set(t.x, t.y + 3, t.z), cam, W, H);
      const dist = Math.hypot(t.x - pp.x, t.z - pp.z);
      const margin = 40;
      const off = p.behind || p.x < margin || p.x > W - margin || p.y < margin || p.y > H - margin;
      g.strokeStyle = '#ff9a2e';
      g.fillStyle = '#ff9a2e';
      if (!off) {
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(p.x, p.y - 10);
        g.lineTo(p.x + 10, p.y);
        g.lineTo(p.x, p.y + 10);
        g.lineTo(p.x - 10, p.y);
        g.closePath();
        g.stroke();
        g.fillText(`${m.phase === 'pickup' ? 'PICKUP' : 'DROP'} ${m.targetSite.name} · ${fmtDist(dist)}`, p.x, p.y - 16);
      } else {
        const ang = Math.atan2(p.y - H / 2, p.x - W / 2);
        const ex = W / 2 + Math.cos(ang) * (Math.min(W, H) / 2 - 60);
        const ey = H / 2 + Math.sin(ang) * (Math.min(W, H) / 2 - 60);
        g.save();
        g.translate(ex, ey);
        g.rotate(ang);
        g.beginPath();
        g.moveTo(14, 0);
        g.lineTo(-6, -9);
        g.lineTo(-6, 9);
        g.closePath();
        g.fill();
        g.restore();
        g.fillText(fmtDist(dist), ex, ey - 16);
      }
    }

    // GPS: the next turn, floating over its junction once it's close.
    if (game.mode === 'drive') {
      const next = game.gps.next;
      const ahead = next ? next.s - game.gps.progress : Infinity;
      if (next && ahead < 350 && !game.gps.recalculating) {
        const y = game.world.terrain.heightIfReady(next.x, next.z);
        const p = this.project(this.tmp.set(next.x, (isFinite(y) ? y : game.humvee.pos.y) + 6, next.z), cam, W, H);
        if (!p.behind && p.x > 0 && p.x < W && p.y > 0 && p.y < H) {
          const sz = clamp(64 - ahead / 10, 34, 60);
          g.save();
          g.globalAlpha = 0.9;
          g.fillStyle = 'rgba(160, 20, 15, 0.75)';
          g.beginPath();
          g.arc(p.x, p.y, sz * 0.62, 0, Math.PI * 2);
          g.fill();
          g.translate(p.x - sz / 2, p.y - sz / 2);
          drawTurnIcon(g, sz, next, false);
          g.restore();
          g.fillStyle = '#fff';
          g.fillText(fmtDist(ahead), p.x, p.y + sz * 0.62 + 14);
        }
      }
    }

    // Hover / drift indicator (also shows the sling load under the hook).
    const R = 62;
    const ix = W / 2;
    const iy = H - 140;
    const show = game.mode === 'fly' && fm.agl < 80 && fm.groundSpeed < 25;
    if (show) {
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(157,255,157,0.5)';
      g.beginPath();
      g.arc(ix, iy, R, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(ix, iy, R / 2, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(ix - R - 6, iy);
      g.lineTo(ix + R + 6, iy);
      g.moveTo(ix, iy - R - 6);
      g.lineTo(ix, iy + R + 6);
      g.stroke();
      // Ground velocity in the heading frame: up = forward.
      const h = fm.heading;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const vf = fm.vel.x * fx + fm.vel.z * fz;
      const vr = fm.vel.x * -fz + fm.vel.z * fx;
      const sc = R / 10;
      const vx = clamp(vr * sc, -R, R);
      const vy = clamp(-vf * sc, -R, R);
      g.strokeStyle = green;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(ix, iy);
      g.lineTo(ix + vx, iy + vy);
      g.stroke();
      g.fillStyle = green;
      g.beginPath();
      g.arc(ix + vx, iy + vy, 4, 0, Math.PI * 2);
      g.fill();
      // Vertical speed bar.
      const vsH = clamp(fm.vs / 5, -1, 1) * R;
      g.fillStyle = fm.vs < -2.5 ? '#ffcf4a' : green;
      g.fillRect(ix + R + 14, iy - Math.max(0, vsH), 6, Math.abs(vsH));
      g.textAlign = 'left';
      g.fillText(`${fm.vs.toFixed(1)}`, ix + R + 24, iy + 4);
      g.textAlign = 'center';
      g.fillStyle = 'rgba(157,255,157,0.7)';
      g.fillText('DRIFT 10 m/s', ix, iy + R + 18);
      // Sling target relative to hook.
      const st = game.slingTargetRel;
      if (st) {
        const lx = clamp(st.r * (R / 8), -R, R);
        const ly = clamp(-st.f * (R / 8), -R, R);
        g.strokeStyle = st.ok ? '#6fff6f' : '#ff9a2e';
        g.lineWidth = 2;
        g.strokeRect(ix + lx - 7, iy + ly - 7, 14, 14);
        g.fillStyle = st.ok ? '#6fff6f' : '#ff9a2e';
        g.fillText(`LOAD ${st.h.toFixed(1)} m below`, ix, iy - R - 12);
      }
    }
    if (game.mode === 'fly') this.drawStick(game, ix, iy, R);
    g.textAlign = 'start';
  }

  /** Small stick/pedal position display, like a control-position indicator. */
  private drawStick(game: Game, ix: number, iy: number, R: number) {
    const g = this.g;
    const st = game.input.stick;
    const S = 34;
    const cx = ix - R - 70;
    const cy = iy;
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(157,255,157,0.45)';
    g.strokeRect(cx - S, cy - S, S * 2, S * 2);
    g.beginPath();
    g.moveTo(cx - S, cy);
    g.lineTo(cx + S, cy);
    g.moveTo(cx, cy - S);
    g.lineTo(cx, cy + S);
    g.stroke();
    // Stick forward = up on the display.
    g.fillStyle = 'rgba(157,255,157,0.95)';
    g.beginPath();
    g.arc(cx + st.x * S, cy - st.y * S, 4.5, 0, Math.PI * 2);
    g.fill();
    // Pedals.
    g.strokeStyle = 'rgba(157,255,157,0.45)';
    g.strokeRect(cx - S, cy + S + 8, S * 2, 6);
    g.fillRect(cx + st.pedal * S - 2, cy + S + 6, 4, 10);
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(157,255,157,0.7)';
    g.fillText(game.input.controlMode === 'virtual' ? 'STICK' : 'STICK (DIRECT)', cx, cy - S - 6);
  }
}

const MANEUVER_TEXT: Record<Maneuver['kind'], string> = {
  straight: 'Continue straight',
  'slight-left': 'Keep left',
  'slight-right': 'Keep right',
  left: 'Turn left',
  right: 'Turn right',
  'sharp-left': 'Sharp left',
  'sharp-right': 'Sharp right',
};

/** A satnav turn arrow (or a destination flag) on a small square canvas. */
export function drawTurnIcon(g: CanvasRenderingContext2D, size: number, m: Maneuver | 'arrive' | 'none', clear = true) {
  if (clear) g.clearRect(0, 0, size, size);
  if (m === 'none') return;
  const s = size / 64;
  g.save();
  g.scale(s, s);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (m === 'arrive') {
    // Chequered flag.
    g.fillStyle = '#fff';
    g.fillRect(20, 10, 4, 44);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 3; j++) {
        g.fillStyle = (i + j) % 2 ? '#222' : '#fff';
        g.fillRect(24 + i * 6, 10 + j * 6, 6, 6);
      }
    g.restore();
    return;
  }
  const turn = Math.max(-2.6, Math.min(2.6, m.turn));
  const mx = 32;
  const my = 36;
  const len = 20;
  const ex = mx + Math.sin(turn) * len;
  const ey = my - Math.cos(turn) * len;
  const path = () => {
    g.beginPath();
    g.moveTo(mx, 58);
    g.lineTo(mx, my);
    g.lineTo(ex, ey);
  };
  path();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 11;
  g.stroke();
  path();
  g.strokeStyle = '#fff';
  g.lineWidth = 7;
  g.stroke();
  // Head.
  g.translate(ex, ey);
  g.rotate(turn);
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(9, 3);
  g.lineTo(-9, 3);
  g.closePath();
  g.fillStyle = '#fff';
  g.fill();
  g.restore();
}
