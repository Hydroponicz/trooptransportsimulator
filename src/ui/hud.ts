import * as THREE from 'three';
import type { Game } from '../game';
import { fmtDist, fmtMoney, fmtTime, clamp } from '../util/math';
import { RANKS } from '../game/career';
import { SAS_NAMES } from '../heli/flight';
import { CAM_LABEL } from '../camera';
import { noun, siteRisk } from '../game/missions';
import type { MapMarker } from './map';
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

  toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
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

  markers(game: Game): MapMarker[] {
    const m = game.missions.active;
    if (!m) return [];
    const t = m.target;
    return [{ x: t.x, z: t.z, color: '#ff9a2e', label: m.phase === 'pickup' ? `PICKUP ${m.c.from.name}` : `DROP ${m.c.to.name}` }];
  }

  update(dt: number, game: Game) {
    const fm = game.heli.fm;
    this.bigTextTimer -= dt;
    if (this.bigTextTimer <= 0) this.els.bigtext.classList.remove('show');
    this.drawCanvas(game);

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
      const dist = Math.hypot(tgt.x - fm.pos.x, tgt.z - fm.pos.z);
      let obj = '';
      if (m.phase === 'pickup') {
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
      const eta = fm.groundSpeed > 5 ? fmtTime(dist / fm.groundSpeed) : '--:--';
      e['m-stats'].innerHTML =
        `<span>DIST ${fmtDist(dist)}</span><span>ETA ${eta}</span>` +
        `<span class="${tl < 0 ? 'bad' : tl < 60 ? 'warn' : ''}">${tl < 0 ? 'LATE ' + fmtTime(-tl) : 'TIME ' + fmtTime(tl)}</span>` +
        `<span class="${cond < 70 ? 'bad' : cond < 95 ? 'warn' : ''}">CARGO ${cond}%</span>`;
    }

    // Warnings.
    const w: string[] = [];
    const caution: string[] = [];
    if (game.threats.missileWarning) w.push('MISSILE');
    if (fm.vrs > 0.4) w.push('VORTEX RING');
    if (fm.engineOn && fm.engineSpool > 0.99 && fm.rpm < 0.93) w.push('LOW ROTOR RPM');
    if (fm.torquePct > 105) w.push('OVERTORQUE');
    if (fm.vs < -6 && fm.agl < 40 && fm.agl > 1) w.push('SINK RATE');
    if (game.heli.hp < 30) w.push('DAMAGE');
    if (fm.fuel < fm.fuelCapacity * 0.15) caution.push('LOW FUEL');
    if (game.threats.underFire > 0) caution.push('UNDER FIRE');
    if (fm.torquePct > 95 && fm.torquePct <= 105) caution.push('HIGH TORQUE');
    if (Math.abs(fm.pos.x) > 3050 || Math.abs(fm.pos.z) > 3050) caution.push('LEAVING AO');
    const html = w.map((x) => `<div>${x}</div>`).join('') + caution.map((x) => `<div class="caution">${x}</div>`).join('');
    if (e.warnings.innerHTML !== html) e.warnings.innerHTML = html;

    const ramp = game.heli.rampT > 0.97 ? 'DOWN' : game.heli.rampT < 0.03 ? 'UP' : 'MOVING';
    e['status-line'].innerHTML =
      `SAS <b>${SAS_NAMES[fm.sas]}</b><br>CAM <b>${CAM_LABEL[game.cam.mode]}</b><br>RAMP <b>${ramp}</b> · HOOK <b>${hk ? 'LOADED' : 'EMPTY'}</b>` +
      `<br>WIND <b>${String(Math.round(((Math.atan2(-game.wind.x, game.wind.z) * 180) / Math.PI + 360) % 360)).padStart(3, '0')}° ${(game.wind.length() * 1.944).toFixed(0)}kt</b>`;

    this.mini.save();
    this.mini.beginPath();
    this.mini.arc(100, 100, 100, 0, Math.PI * 2);
    this.mini.clip();
    game.map.drawMini(this.mini, 200, fm.pos.x, fm.pos.z, fm.heading, 1500, this.markers(game));
    this.mini.restore();

    if (game.mapOpen) {
      this.bigT -= 1 / 12;
      if (this.bigT <= 0) {
        this.bigT = 0.25;
        game.map.drawBig(this.big, 900, fm.pos.x, fm.pos.z, fm.heading, this.markers(game));
      }
    }
  }

  private project(p: THREE.Vector3, cam: THREE.Camera, W: number, H: number): { x: number; y: number; behind: boolean } {
    const v = this.tmp.copy(p).project(cam);
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
    const hdg = (fm.heading * 180) / Math.PI;
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
      const brg = (Math.atan2(t.x - fm.pos.x, -(t.z - fm.pos.z)) * 180) / Math.PI;
      let d = brg - hdg;
      d = ((d + 540) % 360) - 180;
      const x = cx + clamp(d / 40, -1, 1) * (tapeW / 2);
      g.fillStyle = '#ff9a2e';
      g.fillRect(x - 4, 31, 8, 6);
    }

    // World markers: objective + nearby sites.
    const near = game.world.sites
      .map((s) => ({ s, d: Math.hypot(s.x - fm.pos.x, s.z - fm.pos.z) }))
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
      const dist = Math.hypot(t.x - fm.pos.x, t.z - fm.pos.z);
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

    // Hover / drift indicator (also shows the sling load under the hook).
    const R = 62;
    const ix = W / 2;
    const iy = H - 140;
    const show = fm.agl < 80 && fm.groundSpeed < 25;
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
    g.textAlign = 'start';
  }
}
