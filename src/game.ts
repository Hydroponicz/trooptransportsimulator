import * as THREE from 'three';
import { generateWorld, type World } from './world/worldgen';
import { Environment } from './world/environment';
import { Heli, type LandingRating } from './heli/heli';
import { CameraRig } from './camera';
import { Input } from './input';
import { AudioEngine } from './audio';
import { Effects } from './fx/effects';
import { CargoManager } from './game/cargo';
import { SlingSystem } from './game/sling';
import { MissionSystem, siteRisk, type Payout } from './game/missions';
import { Threats } from './game/threats';
import { Traffic } from './game/traffic';
import { Campaign } from './battle/campaign';
import { Battle } from './battle/battle';
import { Career, RANKS } from './game/career';
import { Hud } from './ui/hud';
import { MapRenderer } from './ui/map';
import { Terminal } from './ui/terminal';
import { RNG } from './util/noise';
import { clamp, fmtMoney, smoothstep } from './util/math';
import { SAS_NAMES, type FlightEnv } from './heli/flight';
import type { Site } from './world/sites';
import { WATER_LEVEL } from './world/terrain';
import { enterFullscreen, toggleFullscreen } from './fullscreen';

const STEP = 1 / 120;

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  world: World;
  env: Environment;
  heli: Heli;
  cam: CameraRig;
  input: Input;
  audio: AudioEngine;
  effects: Effects;
  cargo: CargoManager;
  sling: SlingSystem;
  missions: MissionSystem;
  threats: Threats;
  traffic: Traffic;
  battle: Battle;
  hud: Hud;
  map: MapRenderer;
  terminal: Terminal;
  rng: RNG;
  wind = new THREE.Vector3();
  private windBase = new THREE.Vector3();
  time = 0;
  paused = false;
  mapOpen = false;
  currentSite: Site | null = null;
  slingTargetRel: { f: number; r: number; h: number; ok: boolean } | null = null;
  private acc = 0;
  private last = performance.now();
  private flightEnv: FlightEnv;
  private crashTimer = -1;
  private wreckSmoke: ReturnType<Effects['addEmitter']> | null = null;
  private dustAcc = 0;
  private lastPos = new THREE.Vector3();
  private running = false;
  private saveT = 0;
  onQuit: (() => void) | null = null;

  constructor(
    public career: Career,
    container: HTMLElement,
    progress: (m: string) => void,
  ) {
    this.rng = new RNG(career.data.seed ^ 0xabcdef);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.className = 'gl';
    container.prepend(this.renderer.domElement);

    this.world = generateWorld(career.data.seed, progress);
    this.scene.add(this.world.group);
    this.env = new Environment(this.scene);
    progress('Fueling aircraft');

    this.input = new Input(this.renderer.domElement);
    this.audio = new AudioEngine();
    this.effects = new Effects(this.rng.fork());
    this.scene.add(this.effects.group);
    this.cam = new CameraRig(window.innerWidth / window.innerHeight);

    this.heli = new Heli(this.world, {
      onLanding: (r, v) => this.onLanding(r, v),
      onDamage: (a, src) => this.onDamage(a, src),
      onCrash: (reason) => this.onCrash(reason),
    });
    this.scene.add(this.heli.root);

    this.cargo = new CargoManager(this.world.terrain, this.rng.fork());
    this.scene.add(this.cargo.group);
    this.sling = new SlingSystem(this.world.terrain);
    this.scene.add(this.sling.group);
    this.hud = new Hud();
    this.map = new MapRenderer(this.world);
    this.terminal = new Terminal(this);

    this.threats = new Threats(this.world, this.rng.fork(), this.effects, this.audio, {
      onHit: (d) => {
        this.missions.onHit();
        this.cam.shake = Math.min(1.5, this.cam.shake + d * 0.08);
      },
      toast: (m, k) => this.toast(m, k),
    });
    this.scene.add(this.threats.group);

    const campaign = career.data.campaign ? new Campaign(career.data.campaign, this.rng.fork()) : Campaign.fresh(this.rng.fork());
    career.data.campaign = campaign.data;
    this.battle = new Battle(this.world, campaign, this.effects, this.audio, this.threats, this.rng.fork(), {
      radio: (from, msg) => {
        this.hud.radio(from, msg);
        this.audio.radio();
      },
      onHeliHit: (d) => {
        this.missions.onHit();
        this.cam.shake = Math.min(1.5, this.cam.shake + d * 0.08);
      },
    });
    this.scene.add(this.battle.group);

    this.missions = new MissionSystem(this.world.sites, this.rng.fork(), this.cargo, this.sling, this.effects, this.world.terrain, {
      toast: (m, k) => this.toast(m, k),
      radio: (from, msg) => {
        this.hud.radio(from, msg);
        this.audio.radio();
      },
      complete: (p) => this.onComplete(p),
      failed: (reason) => {
        this.hud.bigText('CONTRACT FAILED', reason, 3.5);
        this.toast(reason, 'bad');
      },
      payloadChanged: (kg) => {
        this.heli.fm.payload = Math.max(0, this.heli.fm.payload + kg);
      },
      hotZone: (site, on) => this.threats.setHotZone(site, on),
    });

    for (const s of this.world.smokeSpots) this.effects.addEmitter(s, 'burning', 3);
    this.traffic = new Traffic(this.world, this.rng.fork(), this.effects);
    this.scene.add(this.traffic.group);

    const wa = this.rng.range(0, Math.PI * 2);
    const ws = this.rng.range(1.5, 5);
    this.windBase.set(Math.sin(wa) * ws, 0, Math.cos(wa) * ws);
    this.wind.copy(this.windBase);

    const terrain = this.world.terrain;
    this.flightEnv = {
      surfaceAt: (x, z) => terrain.surfaceAt(x, z),
      normalAt: (x, z, o) => (terrain.heightAt(x, z) < WATER_LEVEL ? o.set(0, 1, 0) : terrain.normalAt(x, z, o)),
      wind: this.wind,
    };

    this.heli.fm.sas = career.data.sas;
    this.input.controlMode = career.data.controlMode ?? 'virtual';
    this.applyUpgrades();
    this.respawn(true);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    // Leaving fullscreen mid-flight drops the keyboard lock, so Ctrl+W could
    // close the tab again. Pause and offer a one-click way back.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.running && !this.paused && !this.terminal.dialogOpen) this.togglePause();
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.effects.setView(h * this.renderer.getPixelRatio(), this.cam.camera.fov, this.scene.fog as THREE.Fog);
  }

  applyUpgrades() {
    const u = this.career.data.upgrades;
    const fm = this.heli.fm;
    fm.thrustScale = 1 + 0.06 * u.engine;
    this.heli.armor = 0.2 * u.armor;
    fm.extraMass = 350 * u.armor;
    const frac = fm.fuel / fm.fuelCapacity;
    fm.fuelCapacity = 2400 * (1 + 0.3 * u.fuel);
    fm.fuel = Math.min(fm.fuelCapacity, frac * fm.fuelCapacity);
    this.heli.maxFlares = 30 + 16 * u.flares;
  }

  respawn(initial = false) {
    const base = this.world.base;
    const pad = base.pads[0];
    this.heli.spawn(pad, base.rot + Math.PI / 2);
    this.heli.hp = initial ? 100 : 100;
    this.heli.fm.fuel = this.heli.fm.fuelCapacity;
    this.heli.flares = this.heli.maxFlares;
    this.input.collective = 0;
    this.cam.snap();
    this.effects.removeEmitter(this.wreckSmoke);
    this.wreckSmoke = null;
    this.crashTimer = -1;
    this.lastPos.copy(this.heli.fm.pos);
  }

  toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
    this.hud.toast(msg, kind);
  }

  start() {
    this.running = true;
    this.input.active = true;
    this.hud.show(true);
    this.audio.init();
    this.last = performance.now();
    this.toast(`Welcome to ${this.world.base.name}. Press [I] to start the engines.`, 'good');
    this.toast('Open the base terminal with [Tab] to pick up a contract.');
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.input.active = false;
    this.audio.setMissileWarning(false);
    void this.audio.ctx?.suspend();
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.input.update(dt);
    this.handleActions();
    const modal = this.paused || this.terminal.isOpen || this.terminal.dialogOpen;
    this.input.enabled = !modal;
    if (!modal) this.simulate(dt);
    const mouse = this.input.consumeMouse();
    this.cam.lookBack = this.input.key('KeyB');
    this.cam.update(modal ? 0 : dt, this.heli, this.world.terrain, mouse);
    this.env.follow(this.heli.fm.pos, this.cam.camera.position);
    this.audio.update(
      {
        rpm: this.heli.fm.rpm,
        collective: this.heli.fm.input.collective,
        airspeed: this.heli.fm.airspeed,
        engine: this.heli.fm.engineSpool,
        inside: this.cam.mode === 'cockpit',
        vrs: this.heli.fm.vrs,
        rampMoving: this.heli.rampT > 0.01 && this.heli.rampT < 0.99,
        distance: this.heli.crashed ? 9999 : this.cam.camera.position.distanceTo(this.heli.fm.pos),
      },
      dt,
    );
    this.hud.update(dt, this);
    this.renderer.render(this.scene, this.cam.camera);
  }

  private handleActions() {
    const inp = this.input;
    const h = this.heli;
    if (this.terminal.dialogOpen) {
      inp.clearActions();
      return;
    }
    if (inp.take('pause')) {
      if (this.terminal.isOpen) this.terminal.close();
      else if (this.mapOpen) this.toggleMap();
      else this.togglePause();
    }
    if (this.paused) {
      inp.clearActions();
      return;
    }
    if (inp.take('terminal')) {
      if (this.terminal.isOpen) this.terminal.close();
      else if ((this.currentSite = this.siteUnderHeli()) && this.currentSite.kind !== 'lz') this.terminal.open(this.currentSite);
      else this.toast('Land at a base or outpost to use the terminal', 'bad');
    }
    if (this.terminal.isOpen) {
      inp.clearActions();
      return;
    }
    if (inp.take('map')) this.toggleMap();
    if (inp.take('camera')) {
      this.cam.next();
      this.audio.click();
    }
    if (h.crashed) {
      inp.clearActions();
      return;
    }
    if (inp.take('engine')) {
      const fm = h.fm;
      if (fm.fuel <= 0) this.toast('No fuel', 'bad');
      else {
        fm.engineOn = !fm.engineOn;
        this.toast(fm.engineOn ? 'Engines starting — wait for 100% rotor RPM' : 'Engines shutting down', 'info');
      }
    }
    if (inp.take('ramp')) {
      h.rampOpen = !h.rampOpen;
      this.audio.click();
    }
    if (inp.take('sas')) {
      h.fm.sas = (h.fm.sas + 1) % 3;
      this.career.data.sas = h.fm.sas;
      this.toast(`Stability assist: ${SAS_NAMES[h.fm.sas]}`);
    }
    if (inp.take('flares')) {
      if (this.threats.dropFlares(h)) this.cam.shake += 0.2;
      else if (h.flares <= 0) this.toast('Flares depleted', 'bad');
    }
    if (inp.take('hook')) {
      if (this.sling.hooked) {
        const l = this.sling.release();
        this.audio.clunk();
        if (l) this.toast(l.onGround ? 'Load released' : 'Load released in flight!', l.onGround ? 'info' : 'bad');
      } else {
        const r = this.sling.tryHook(h);
        if (r.ok) this.audio.clunk();
        this.toast(r.msg, r.ok ? 'good' : 'bad');
      }
    }
    inp.take('help');
    inp.take('lookBack');
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.terminal.dialog(
        `<h2>Paused</h2><div class="sub">${this.world.base.name} theater · seed ${this.career.data.seed}</div>
        ${document.fullscreenElement ? '' : '<p style="color:#ffcf4a">You are not in fullscreen. Outside fullscreen the browser may treat Ctrl+W / Ctrl+Q as close-tab / quit.</p>'}
        <div class="actions" style="justify-content:flex-start;flex-wrap:wrap">
          ${document.fullscreenElement ? '' : '<button class="primary" data-act="fsresume">Back to fullscreen</button>'}
          <button class="${document.fullscreenElement ? 'primary' : ''}" data-act="resume">Resume</button>
          <button data-act="vol">Volume: ${Math.round(this.audio.volume * 100)}%</button>
          <button data-act="ctl">Keyboard: ${this.input.controlMode === 'virtual' ? 'Virtual stick' : 'Direct'}</button>
          ${document.fullscreenElement ? '<button data-act="fs">Exit fullscreen</button>' : ''}
          <button data-act="quit">Save &amp; quit to menu</button>
        </div>`,
        {
          resume: () => {
            this.terminal.closeDialog();
            this.paused = false;
          },
          ctl: () => {
            this.input.controlMode = this.input.controlMode === 'virtual' ? 'direct' : 'virtual';
            this.career.data.controlMode = this.input.controlMode;
            this.career.save();
            this.paused = false;
            this.togglePause();
          },
          vol: () => {
            const v = this.audio.volume >= 1 ? 0 : Math.round((this.audio.volume + 0.2) * 10) / 10;
            this.audio.setVolume(v);
            this.paused = false;
            this.togglePause();
          },
          fsresume: () => {
            void enterFullscreen();
            this.terminal.closeDialog();
            this.paused = false;
          },
          fs: () => {
            void toggleFullscreen().then(() => {
              this.paused = false;
              this.togglePause();
            });
          },
          quit: () => {
            this.career.save();
            this.terminal.closeDialog();
            this.paused = false;
            this.onQuit?.();
          },
        },
      );
    } else this.terminal.closeDialog();
  }

  toggleMap() {
    this.mapOpen = !this.mapOpen;
    document.getElementById('mapview')!.classList.toggle('hidden', !this.mapOpen);
  }

  private simulate(dt: number) {
    this.time += dt;
    const h = this.heli;
    const fm = h.fm;
    const inp = this.input;

    // Wind with gusts.
    const gust = 1 + 0.35 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.11 + 1);
    this.wind.copy(this.windBase).multiplyScalar(gust);
    this.effects.wind.copy(this.wind);

    fm.input.collective = inp.collective;
    fm.input.pitch = inp.pitch;
    fm.input.roll = inp.roll;
    fm.input.yaw = inp.yaw;

    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      h.physicsStep(STEP, this.flightEnv);
      this.sling.step(STEP, h);
    }
    h.checkCollisions();
    h.update(dt, this.cam.mode === 'cockpit');
    this.sling.render(h);

    // Where are we?
    this.currentSite = this.siteUnderHeli();

    this.missions.update(dt, h);
    const lc = this.missions.loadContext(h);
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    this.cargo.update(dt, {
      canLoad: lc.canLoad,
      canUnload: lc.canUnload,
      rampEnd: h.rampEndWorld(tmpA),
      cabin: h.cabinWorld(tmpB),
      heliPos: fm.pos,
      rotorsTurning: fm.rpm > 0.3,
    });
    this.threats.update(dt, h, this.cam.camera.position);
    this.battle.update(dt, h, this.cam.camera.position);
    this.traffic.update(dt, this.cam.camera.position);
    this.updateEffects(dt);
    this.effects.update(dt, this.cam.camera.position);
    this.updateDecor(dt);
    this.updatePrompt();
    this.updateSlingGuide();

    // Stats.
    if (!h.crashed && fm.contacts === 0) {
      this.career.data.stats.flightTime += dt;
      this.career.data.stats.distanceKm += fm.pos.distanceTo(this.lastPos) / 1000;
    }
    this.lastPos.copy(fm.pos);
    this.saveT += dt;
    if (this.saveT > 30) {
      this.saveT = 0;
      this.career.save();
    }

    // Crash sequence.
    if (this.crashTimer >= 0) {
      this.crashTimer += dt;
      if (this.crashTimer > 3 && !this.terminal.dialogOpen) this.showCrashDialog();
    }
  }

  /** The site we're parked at, if any. */
  siteUnderHeli(): Site | null {
    const fm = this.heli.fm;
    if (fm.contacts < 3 || this.heli.crashed) return null;
    for (const s of this.world.sites) if (Math.hypot(s.x - fm.pos.x, s.z - fm.pos.z) < s.radius + 25) return s;
    return null;
  }

  private updateEffects(dt: number) {
    const h = this.heli;
    const fm = h.fm;
    const e = this.effects;
    const ground = this.world.terrain.surfaceAt(fm.pos.x, fm.pos.z);
    const thrustRatio = fm.thrust / (fm.mass * 9.81);
    const washH = 32;
    e.downwash.active = fm.rpm > 0.3 && !h.crashed;
    e.downwash.x = fm.pos.x;
    e.downwash.y = fm.pos.y;
    e.downwash.z = fm.pos.z;
    e.downwash.ground = ground;
    e.downwash.strength = clamp(thrustRatio, 0, 1.3) * fm.rpm;

    // Rotor-wash brownout.
    const agl = fm.pos.y - ground;
    if (e.downwash.active && agl < washH) {
      const inten = clamp(thrustRatio * 1.1, 0, 1.2) * fm.rpm * (1 - agl / washH);
      this.dustAcc += inten * 90 * dt;
      const water = this.world.terrain.heightAt(fm.pos.x, fm.pos.z) < WATER_LEVEL + 0.1;
      while (this.dustAcc >= 1) {
        this.dustAcc -= 1;
        const a = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(3, 14);
        const x = fm.pos.x + Math.cos(a) * r + fm.vel.x * 0.2;
        const z = fm.pos.z + Math.sin(a) * r + fm.vel.z * 0.2;
        const sp = this.rng.range(8, 18) * inten;
        e.smoke.emit({
          x,
          y: this.world.terrain.surfaceAt(x, z) + 0.4,
          z,
          vx: Math.cos(a) * sp + this.wind.x,
          vy: this.rng.range(0.5, 3),
          vz: Math.sin(a) * sp + this.wind.z,
          life: this.rng.range(1.4, 3),
          size0: 2,
          size1: this.rng.range(7, 12),
          r: water ? 0.85 : 0.63,
          g: water ? 0.88 : 0.57,
          b: water ? 0.9 : 0.45,
          alpha: (water ? 0.45 : 0.32) * Math.min(1, inten + 0.2),
          drag: 1.1,
          buoyancy: 0.4,
          wash: 0.4,
        });
      }
    }

    // Damage smoke and fire from the engines.
    if (!h.crashed && h.hp < 55 && fm.engineSpool > 0.1) {
      const p = h.parts.exhaustL.getWorldPosition(new THREE.Vector3());
      if (this.rng.chance(dt * (60 - h.hp))) {
        e.smoke.emit({
          x: p.x,
          y: p.y,
          z: p.z,
          vx: fm.vel.x * 0.5,
          vy: 1,
          vz: fm.vel.z * 0.5,
          life: 3,
          size0: 1.5,
          size1: 7,
          r: 0.12,
          g: 0.12,
          b: 0.11,
          alpha: 0.6,
          drag: 0.8,
        });
      }
      if (h.hp < 25 && this.rng.chance(dt * 30))
        e.fire.emit({ x: p.x, y: p.y, z: p.z, vx: fm.vel.x * 0.8, vy: 1, vz: fm.vel.z * 0.8, life: 0.4, size0: 2, size1: 1, r: 1.8, g: 0.8, b: 0.2, alpha: 1, fadeIn: 0.02 });
    }

    // Camera shake: translational-lift shudder, VRS buffet.
    const etlShudder = fm.etl > 0.1 && fm.etl < 0.9 && fm.contacts === 0 ? 0.12 : 0;
    this.cam.shake = Math.max(this.cam.shake, etlShudder + fm.vrs * 0.6 + (fm.torquePct > 100 ? 0.1 : 0));
  }

  private updateDecor(dt: number) {
    const w = this.wind;
    const sp = w.length();
    for (const ws of this.world.windsocks) {
      const pivot = ws.userData.pivot as THREE.Object3D;
      if (pivot.type === 'Mesh') {
        // Flag cloth.
        pivot.rotation.y = Math.atan2(-w.z, w.x) + Math.sin(this.time * 6 + ws.position.x) * 0.15;
      } else {
        pivot.rotation.y = Math.atan2(w.x, w.z) + Math.sin(this.time * 2.3 + ws.position.z) * 0.08;
        pivot.rotation.x = (1 - smoothstep(0, 8, sp)) * 1.1;
      }
    }
    void dt;
  }

  private updatePrompt() {
    const h = this.heli;
    const fm = h.fm;
    const m = this.missions.active;
    let p = '';
    if (h.crashed) p = '';
    else if (!fm.engineOn && fm.rpm < 0.05) p = 'Press <kbd>I</kbd> to start engines';
    else if (fm.engineOn && fm.engineSpool < 0.99) p = `Engines spooling… NR ${(fm.rpm * 100).toFixed(0)}%`;
    else if (m && m.phase === 'pickup' && m.internal && m.group) {
      const near = Math.hypot(fm.pos.x - m.c.from.pads[m.c.fromPad].x, fm.pos.z - m.c.from.pads[m.c.fromPad].z) < 90;
      if (near && fm.contacts >= 3) {
        if (!h.rampDown) p = h.rampOpen ? 'Ramp lowering…' : 'Press <kbd>R</kbd> to lower the ramp';
        else if (m.group.aboard < m.group.total) p = `Loading ${m.group.aboard}/${m.group.total} — hold position`;
      } else if (near) p = 'Land near the troops';
    } else if (m && m.phase === 'transit' && m.internal && h.rampOpen && fm.contacts === 0 && fm.groundSpeed > 15) p = 'Ramp is down — press <kbd>R</kbd> to raise it';
    else if (m && m.phase === 'transit' && m.internal) {
      const d = Math.hypot(fm.pos.x - m.dropPos.x, fm.pos.z - m.dropPos.z);
      if (d < 70 && fm.contacts >= 3 && !h.rampDown) p = h.rampOpen ? 'Ramp lowering…' : 'Press <kbd>R</kbd> to lower the ramp and unload';
      else if (d < 70 && fm.contacts >= 3 && !h.loadable) p = 'Come to a full stop to unload';
    } else if (m && m.phase === 'dropoff') p = 'Unloading — hold position';
    if (!p && this.slingTargetRel) {
      const st = this.slingTargetRel;
      p = st.ok ? 'Press <kbd>H</kbd> to hook the load' : 'Position the hook over the load (see drift display)';
    }
    if (!p && this.sling.hooked) {
      const l = this.sling.hooked;
      if (l.onGround && m && m.load === l && Math.hypot(l.pos.x - m.dropPos.x, l.pos.z - m.dropPos.z) < 22) p = 'Load is down in the zone — press <kbd>H</kbd> to release';
      else if (l.onGround && this.sling.tension < l.mass * 3) p = 'Load on the ground — press <kbd>H</kbd> to release, or lift';
    }
    if (!p && fm.contacts >= 3 && fm.rpm > 0.97 && fm.input.collective < 0.3 && h.rampT < 0.03 && !m) {
      p = this.currentSite && this.currentSite.kind !== 'lz' ? `Press <kbd>Tab</kbd> for the ${this.currentSite.name} terminal` : 'Raise collective <kbd>Shift</kbd> to lift off';
    }
    if (!p && fm.contacts >= 3 && fm.rpm > 0.97 && fm.input.collective < 0.3 && m && m.phase === 'transit') {
      p = h.rampT > 0.03 ? 'Press <kbd>R</kbd> to raise the ramp' : 'Raise collective <kbd>Shift</kbd> to lift off';
    }
    if (!p && !fm.engineOn && fm.rpm > 0.05 && fm.contacts >= 3 && this.currentSite && this.currentSite.kind !== 'lz')
      p = `Press <kbd>Tab</kbd> for the ${this.currentSite.name} terminal`;
    this.hud.setPrompt(p);
  }

  private updateSlingGuide() {
    this.slingTargetRel = null;
    if (this.sling.hooked || this.heli.crashed) return;
    const st = this.sling.hookStatus(this.heli);
    if (!st.load || st.horiz > 28) return;
    const hook = this.heli.hookWorld(new THREE.Vector3());
    const dx = st.load.pos.x - hook.x;
    const dz = st.load.pos.z - hook.z;
    const hd = this.heli.fm.heading;
    const fx = Math.sin(hd);
    const fz = -Math.cos(hd);
    const f = dx * fx + dz * fz;
    const r = dx * -fz + dz * fx;
    const ok = st.horiz <= 3.5 && st.height >= 0.6 && st.height <= 10.5 && this.heli.fm.groundSpeed < 2.5;
    this.slingTargetRel = { f, r, h: st.height, ok };
  }

  private onLanding(r: LandingRating, v: number) {
    this.missions.onLanding(r, v);
    this.audio.thud(Math.min(1.2, v / 3));
    this.cam.shake = Math.min(2, this.cam.shake + v * 0.25);
    const color = r === 'BUTTER' ? '🧈 BUTTER' : r;
    if (r === 'BUTTER') this.career.data.stats.butterLandings++;
    if (r !== 'FIRM') this.hud.bigText(color, `${v.toFixed(2)} m/s touchdown`, 1.8);
  }

  private onDamage(a: number, src: string) {
    if (a > 3) this.toast(`${src}: −${a.toFixed(0)}% hull`, 'bad');
  }

  private onCrash(reason: string) {
    const fm = this.heli.fm;
    this.effects.explosion(fm.pos, 2.2);
    this.audio.explosion(this.cam.camera.position.distanceTo(fm.pos), 2);
    this.audio.setMissileWarning(false);
    this.wreckSmoke = this.effects.addEmitter(fm.pos.clone().setY(this.world.terrain.surfaceAt(fm.pos.x, fm.pos.z) + 1), 'burning', 8);
    this.heli.root.visible = false;
    this.cam.shake = 2;
    this.hud.bigText('CRASHED', reason, 3);
    this.career.data.stats.crashes++;
    this.missions.fail('Aircraft lost');
    if (this.sling.hooked) this.sling.release();
    this.crashTimer = 0;
  }

  private showCrashDialog() {
    const fee = Math.min(this.career.data.money, 10000);
    this.terminal.dialog(
      `<h2>Aircraft lost</h2><div class="sub">${this.heli.crashReason}</div>
      <p>The crew made it out. A replacement airframe is waiting at ${this.world.base.name}.</p>
      <table><tr><td>Recovery &amp; insurance deductible</td><td class="neg">−${fmtMoney(fee)}</td></tr></table>
      <div class="actions"><button class="primary" data-act="ok">Return to ${this.world.base.name}</button></div>`,
      {
        ok: () => {
          this.career.data.money -= fee;
          this.career.save();
          this.terminal.closeDialog();
          this.threats.clearHotZones();
          this.heli.fm.payload = 0;
          this.respawn();
        },
      },
    );
  }

  private onComplete(p: Payout) {
    const c = this.career;
    c.data.money += p.total;
    c.data.stats.earned += p.total;
    c.data.stats.deliveries++;
    if (p.contract.type.kind === 'troops' || p.contract.type.kind === 'casualties') c.data.stats.troopsMoved += p.contract.count;
    c.data.stats.cargoKg += p.contract.mass;
    const promoted = c.addXp(p.xp) ? RANKS[c.rank].name : null;
    const warReport = this.battle.campaign.applyDelivery(p.contract);
    c.save();
    this.audio.cash();
    const hot = siteRisk(p.contract.to) >= 2;
    // Let the player enjoy the unload for a moment before the summary.
    setTimeout(() => {
      this.terminal.payout(p, promoted, () => {
        if (promoted) this.hud.bigText('PROMOTED', promoted, 3);
        else if (hot) this.toast('Get out of there — the LZ is still hot!', 'bad');
        if (warReport) {
          this.hud.radio('Brigade TOC', warReport);
          this.audio.radio();
        }
      });
    }, 900);
  }
}
