import * as THREE from 'three';
import './world/look';
import { generateWorld, type World } from './world/worldgen';
import { Environment } from './world/environment';
import { Grass } from './world/grass';
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
import { Campaign, CAMPAIGN_VERSION, SECTOR_COUNT } from './battle/campaign';
import { Battle } from './battle/battle';
import { AirOps } from './battle/air';
import { CABIN } from './heli/chinookModel';
import * as soldierKit from './game/soldiers';
import type { PlayerTarget } from './game/target';
import { Humvee, type GroundEnv } from './vehicles/humvee';
import type { Carrier } from './game/missions';
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
  grass: Grass;
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
  air: AirOps;
  /** Soldier poses and renderer, for tools and tests poking at the running game. */
  readonly soldierKit = soldierKit;
  humvee: Humvee;
  /** Flying the helicopter or driving the Humvee. */
  mode: 'fly' | 'drive' = 'fly';
  private groundEnv!: GroundEnv;
  private vehicleSound: ReturnType<AudioEngine['vehicle']> = null;
  private flipT = 0;
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
    // ACES plus the grade in world/look.ts.
    this.renderer.toneMapping = THREE.CustomToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.domElement.className = 'gl';
    container.prepend(this.renderer.domElement);

    this.world = generateWorld(career.data.seed, progress);
    this.scene.add(this.world.group);
    this.grass = new Grass(this.world.terrain, this.world.roads, this.world.colliders);
    this.scene.add(this.grass.mesh);
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

    // A campaign saved for the old, smaller map has the wrong sectors: start a new one.
    const saved = career.data.campaign;
    const campaign = saved && saved.version === CAMPAIGN_VERSION && saved.sectors.length === SECTOR_COUNT ? new Campaign(saved, this.rng.fork()) : Campaign.fresh(this.rng.fork());
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
    this.air = new AirOps(this.world, this.battle, this.effects, this.audio, this.rng.fork(), {
      radio: (from, msg) => {
        this.hud.radio(from, msg);
        this.audio.radio();
      },
    });
    this.scene.add(this.air.group);

    this.missions = new MissionSystem(this.world.sites, this.rng.fork(), this.cargo, this.sling, this.effects, this.world.terrain, this.world.roads, {
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
        if (this.missions.active?.c.mode === 'ground') this.humvee.payload = Math.max(0, this.humvee.payload + kg);
        else this.heli.fm.payload = Math.max(0, this.heli.fm.payload + kg);
      },
      hotZone: (site, on) => this.threats.setHotZone(site, on),
    });

    // The player's Humvee waits at the main base motor pool.
    const terrainG = this.world.terrain;
    const roads = this.world.roads;
    this.groundEnv = {
      // On a road, the graded road surface is the ground (terrain triangles can poke through it).
      surfaceAt: (x, z, y) => {
        const r = roads.surfaceAt(x, z, y);
        const t = terrainG.heightAt(x, z);
        return r > -1e9 && t < r + 2 ? r : Math.max(t, r);
      },
      normalAt: (x, z, o, y) => (roads.surfaceAt(x, z, y) > terrainG.heightAt(x, z) + 0.05 ? o.set(0, 1, 0) : terrainG.normalAt(x, z, o)),
      waterDepth: (x, z, y) => (roads.surfaceAt(x, z, y) > -1e9 ? 0 : Math.max(0, WATER_LEVEL - terrainG.heightAt(x, z))),
      grip: (x, z, y) => (roads.surfaceAt(x, z, y) > -1e9 ? 1.0 : 0.8),
      blocked: (pt) => !!this.world.colliders.hit(pt, 0, true) || this.world.vegetation.hit(pt) || roads.bridgeRail(pt) || !!this.traffic?.hit(pt),
    };
    this.humvee = new Humvee();
    this.humvee.onImpact = (sp) => {
      this.humvee.damage((sp - 4) * 3, 'Collision');
      this.audio.thud(Math.min(1.2, sp / 8));
      this.cam.shake = Math.min(1.5, this.cam.shake + sp * 0.05);
    };
    this.humvee.onDamage = (a, src) => {
      if (src !== 'Collision') this.audio.hit();
      this.onDamage(a, src);
    };
    this.humvee.onDestroyed = (reason) => this.onHumveeDestroyed(reason);
    this.scene.add(this.humvee.group);
    this.parkHumvee();

    for (const s of this.world.smokeSpots) this.effects.addEmitter(s, 'burning', 3);
    this.traffic = new Traffic(this.world, this.rng.fork(), this.effects);
    this.traffic.onHonk = (at) => this.audio.horn(Math.max(0.05, 1 - at.distanceTo(this.cam.camera.position) / 250), true);
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
    this.mode = 'fly';
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

  /** Motor pool spot at the main base. */
  parkHumvee() {
    const b = this.world.base;
    // At the base's roadside stop, where road jobs load.
    const stop = this.world.roads.curbside(b.x, b.z, b.radius);
    this.humvee.repair();
    if (stop) {
      this.humvee.place(stop.road, stop.heading, this.groundEnv);
      return;
    }
    const lx = 10;
    const lz = 40;
    const at = new THREE.Vector3(b.x + lx * Math.cos(b.rot) + lz * Math.sin(b.rot), 0, b.z - lx * Math.sin(b.rot) + lz * Math.cos(b.rot));
    this.humvee.place(at, b.rot + Math.PI / 2, this.groundEnv);
    this.humvee.hp = 100;
  }

  /** What enemies see and shoot at. */
  get player(): PlayerTarget {
    return this.mode === 'drive' ? this.humvee : this.heli;
  }

  /** Whatever the player is currently in. */
  get carrier(): Carrier {
    return this.mode === 'drive' ? this.humvee : this.heli;
  }
  get playerPos(): THREE.Vector3 {
    return this.mode === 'drive' ? this.humvee.pos : this.heli.fm.pos;
  }
  get playerHeading(): number {
    return this.mode === 'drive' ? this.humvee.heading : this.heli.fm.heading;
  }

  /** G: hop between the helicopter and the Humvee. */
  /** Close enough to swap vehicles: within 140 m, or both inside the same base. */
  vehiclesTogether(): boolean {
    const a = this.heli.fm.pos;
    const b = this.humvee.pos;
    if (a.distanceTo(b) < 140) return true;
    return this.world.sites.some((s) => s.kind !== 'lz' && Math.hypot(a.x - s.x, a.z - s.z) < s.radius + 20 && Math.hypot(b.x - s.x, b.z - s.z) < s.radius + 20);
  }

  private switchVehicle() {
    const h = this.heli;
    const v = this.humvee;
    if (this.mode === 'fly') {
      if (!h.onGround || h.fm.groundSpeed > 1) return this.toast('Land first to get out of the helicopter', 'bad');
      const d = h.fm.pos.distanceTo(v.pos);
      if (!this.vehiclesTogether()) return this.toast(`Your Humvee is ${Math.round(d)} m away${this.siteNameNear(v.pos)}`, 'bad');
      this.mode = 'drive';
      this.input.collective = 0;
      h.fm.input.collective = 0;
      h.rampOpen = false;
      this.cam.snap();
      this.toast('Driving the Humvee — W/S throttle, A/D steer, Space handbrake, R rear doors, G back to the helicopter', 'good');
    } else {
      if (v.groundSpeed > 2) return this.toast('Stop the vehicle first', 'bad');
      const d = v.pos.distanceTo(h.fm.pos);
      if (!this.vehiclesTogether()) return this.toast(`Drive back to your helicopter (${Math.round(d)} m)`, 'bad');
      this.mode = 'fly';
      v.input = { throttle: 0, brake: 0, steer: 0, handbrake: true };
      v.doorsOpen = false;
      this.cam.snap();
      this.toast('Back in the helicopter', 'good');
    }
    this.audio.clunk();
  }

  private siteNameNear(p: THREE.Vector3): string {
    let best: Site | null = null;
    let bd = Infinity;
    for (const s of this.world.sites) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bd) (bd = d), (best = s);
    }
    return best && bd < best.radius + 200 ? ` at ${best.name}` : '';
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
    const loop = (ts: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame(ts);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.input.active = false;
    this.audio.setMissileWarning(false);
    void this.audio.ctx?.suspend();
  }

  /** `now` is the vsync-aligned rAF timestamp, steadier than reading the clock. */
  private frame(now = performance.now()) {
    // The first rAF timestamp can precede the start time: never step backwards.
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = Math.max(this.last, now);
    this.input.update(dt);
    this.handleActions();
    const modal = this.paused || this.terminal.isOpen || this.terminal.dialogOpen;
    this.input.enabled = !modal;
    if (!modal && dt > 0) this.simulate(dt);
    const mouse = this.input.consumeMouse();
    this.cam.lookBack = this.input.key('KeyB');
    this.humvee.setInteriorView(this.mode === 'drive' && this.cam.mode === 'cockpit');
    if (this.mode === 'drive') this.cam.updateGround(modal ? 0 : dt, this.humvee, this.world.terrain, mouse);
    else this.cam.update(modal ? 0 : dt, this.heli, this.world.terrain, mouse);
    this.env.follow(this.playerPos, this.cam.camera.position);
    this.world.terrain.updateLod(this.cam.camera.position);
    this.world.rivers.update(dt);
    {
      // Rotor downwash flattens the grass when the helicopter is low with the rotors turning.
      const fm = this.heli.fm;
      const wash = this.mode === 'fly' && fm.rpm > 0.3 && !this.heli.crashed ? fm.rpm * (0.55 + 0.45 * fm.input.collective) : 0;
      this.grass.update(dt, this.cam.camera.position, wash > 0 ? fm.pos : null, Math.min(1, wash));
    }
    this.env.update(dt);
    this.world.culler.update(this.cam.camera.position);
    this.vehicleSound ??= this.audio.vehicle();
    {
      const v = this.humvee;
      const gear = Math.min(3, Math.floor(Math.abs(v.speed) / 8.5));
      const rpm = this.mode === 'drive' && !v.stalled ? Math.min(1, 0.25 + 0.75 * ((Math.abs(v.speed) - gear * 8.5) / 8.5) * 0.85 + v.engineLoad * 0.15) : 0;
      this.vehicleSound?.update(rpm, v.engineLoad, this.cam.camera.position.distanceTo(v.pos), this.cam.mode === 'cockpit' && this.mode === 'drive');
    }
    this.audio.update(
      {
        rpm: this.heli.fm.rpm,
        collective: this.heli.fm.input.collective,
        airspeed: this.heli.fm.airspeed,
        engine: this.heli.fm.engineSpool,
        inside: this.cam.mode === 'cockpit' && this.mode === 'fly',
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
      else if ((this.currentSite = this.siteUnderPlayer()) && this.currentSite.kind !== 'lz') this.terminal.open(this.currentSite);
      else this.toast(this.mode === 'drive' ? 'Stop at a base or outpost to use the terminal' : 'Land at a base or outpost to use the terminal', 'bad');
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
    if (h.crashed || (this.mode === 'drive' && this.humvee.destroyed)) {
      inp.clearActions();
      return;
    }
    if (inp.take('vehicle')) this.switchVehicle();
    if (this.mode === 'drive') {
      const v = this.humvee;
      if (inp.take('ramp')) {
        v.doorsOpen = !v.doorsOpen;
        this.audio.click();
      }
      if (inp.take('sas')) this.recoverHumvee();
      if (inp.take('hook')) this.audio.horn();
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

    const driving = this.mode === 'drive';
    fm.input.collective = driving ? 0 : inp.collective;
    fm.input.pitch = driving ? 0 : inp.pitch;
    fm.input.roll = driving ? 0 : inp.roll;
    fm.input.yaw = driving ? 0 : inp.yaw;
    const v = this.humvee;
    if (driving) {
      // W/S: throttle; S brakes first, then reverses. Space: handbrake.
      const fwdKey = inp.key('KeyW') || inp.key('ArrowUp');
      const backKey = inp.key('KeyS') || inp.key('ArrowDown');
      const steerKey = (inp.key('KeyD') || inp.key('ArrowRight') ? 1 : 0) - (inp.key('KeyA') || inp.key('ArrowLeft') ? 1 : 0);
      let throttle = 0;
      let brake = 0;
      if (fwdKey) {
        if (v.speed < -1) brake = 1;
        else throttle = 1;
      } else if (backKey) {
        if (v.speed > 1) brake = 1;
        else throttle = -1;
      }
      if (v.destroyed) (throttle = 0), (brake = 1);
      v.input.throttle = throttle;
      v.input.brake = brake;
      v.input.steer += (steerKey - v.input.steer) * Math.min(1, dt * 6);
      v.input.handbrake = inp.key('Space') || (!fwdKey && !backKey && v.groundSpeed < 0.5);
    }

    // Substep the whole frame (never more than STEP each) so the simulation advances
    // exactly as far as the frame does: a fixed-step accumulator without render
    // interpolation made the aircraft jump 0–2 steps per frame and shimmer.
    const steps = Math.ceil(dt / STEP - 1e-6);
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      h.physicsStep(sub, this.flightEnv);
      this.sling.step(sub, h);
      v.step(sub, this.groundEnv);
    }
    v.update(dt);
    // Stuck on its roof or side: offer a recovery.
    this.flipT = driving && v.flipped ? this.flipT + dt : 0;
    if (this.flipT > 2.5 && Math.floor(this.flipT * 2) !== Math.floor((this.flipT - dt) * 2)) this.toast('Vehicle overturned — press T to recover it', 'bad');
    if (driving && v.stalled && Math.random() < dt * 0.3) this.toast('Engine flooded — press T to recover the vehicle', 'bad');
    h.checkCollisions();
    h.update(dt, this.cam.mode === 'cockpit');
    this.sling.render(h);

    // Where are we?
    this.currentSite = this.siteUnderPlayer();

    const carrier = this.carrier;
    this.missions.update(dt, carrier);
    const lc = this.missions.loadContext(carrier);
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    this.cargo.update(dt, {
      canLoad: lc.canLoad,
      canUnload: lc.canUnload,
      rampEnd: carrier.rampEndWorld(tmpA),
      cabin: carrier.cabinWorld(tmpB),
      heliPos: fm.pos,
      rotorsTurning: fm.rpm > 0.3,
      frame: carrier.cabinFrame,
      layout: carrier.cabinLayout,
      camPos: this.cam.camera.position,
      underFire: this.threats.underFire > 0,
      crew: {
        frame: h.parts.exterior,
        chiefSeat: CABIN.crewChief,
        gunners: CABIN.gunners,
        guns: h.parts.doorGuns,
        pilots: CABIN.pilots,
        hidePilot: this.mode === 'fly' && this.cam.mode === 'cockpit',
        hinge: CABIN.hinge,
        rampT: h.rampT,
        marshalling: carrier === h && (lc.canLoad || lc.canUnload),
        visible: !h.crashed && h.parts.root.visible,
      },
    });
    // Enemy fire, the battles along the front and air strikes follow whatever the player is in.
    const player = this.player;
    this.threats.update(dt, player, this.cam.camera.position);
    this.battle.update(dt, player, this.cam.camera.position);
    this.air.update(dt, player, this.cam.camera.position);
    {
      const h = this.heli.fm;
      const ground = this.world.terrain.surfaceAt(h.pos.x, h.pos.z);
      this.traffic.update(dt, this.cam.camera.position, {
        humvee: this.humvee.pos,
        heli: !this.heli.crashed && h.pos.y - ground < 8 ? h.pos : undefined,
      });
    }
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

  /** The site we're parked at (helicopter landed or Humvee stopped), if any. */
  siteUnderPlayer(): Site | null {
    const c = this.carrier;
    if (!c.onGround || this.heli.crashed || (this.mode === 'drive' && this.humvee.groundSpeed > 1)) return null;
    const p = c.pos;
    for (const s of this.world.sites) if (Math.hypot(s.x - p.x, s.z - p.z) < s.radius + 25) return s;
    return null;
  }

  /** T while driving: put the Humvee back on its wheels on the nearest road. */
  private recoverHumvee() {
    const v = this.humvee;
    if (!v.flipped && !v.stalled && v.waterDepth < 0.8) return this.toast('Vehicle is fine — recovery is for when you are stuck or overturned');
    const fee = 400;
    this.career.data.money = Math.max(0, this.career.data.money - fee);
    // Nearest road sample.
    let best: THREE.Vector2 | null = null;
    let bd = Infinity;
    for (const path of this.world.roads.paths)
      for (const p of path) {
        const d = Math.hypot(p.x - v.pos.x, p.y - v.pos.z);
        if (d < bd) (bd = d), (best = p);
      }
    const at = best ? new THREE.Vector3(best.x, 0, best.y) : v.pos.clone();
    v.place(at, v.heading, this.groundEnv);
    this.toast(`Vehicle recovered (−$${fee})`, 'info');
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
    if (this.mode === 'drive') return this.hud.setPrompt(this.drivePrompt());
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
    if (!p && m && m.c.mode === 'ground' && fm.contacts >= 3) p = this.vehiclesTogether() ? 'Road job: press <kbd>G</kbd> to get in your Humvee' : 'Road job: your Humvee is parked elsewhere';
    if (!p && !fm.engineOn && fm.rpm > 0.05 && fm.contacts >= 3 && this.currentSite && this.currentSite.kind !== 'lz')
      p = `Press <kbd>Tab</kbd> for the ${this.currentSite.name} terminal`;
    this.hud.setPrompt(p);
  }

  private drivePrompt(): string {
    const v = this.humvee;
    const m = this.missions.active;
    if (v.flipped || v.stalled) return 'Press <kbd>T</kbd> to recover the vehicle';
    if (m && m.c.mode === 'air' && m.phase !== 'complete' && m.phase !== 'failed') {
      if (this.vehiclesTogether() && v.groundSpeed < 0.5) return 'This is a helicopter job — press <kbd>G</kbd> to get back in the helicopter';
      return 'Your active job needs the helicopter (🚁 AIR)';
    }
    if (m && m.c.mode === 'ground') {
      const g = m.group;
      if (m.phase === 'pickup' && g) {
        const d = v.rampEndWorld(new THREE.Vector3()).setY(0).distanceTo(new THREE.Vector3(m.pickupPos.x, 0, m.pickupPos.z));
        if (d < 30) {
          if (v.groundSpeed > 0.6) return 'Stop here next to the green smoke';
          if (!v.rampDown) return 'Press <kbd>R</kbd> to open the rear doors';
          if (g.aboard < g.total) return `Loading ${g.aboard}/${g.total} — hold position`;
        } else if (d < 120) return `Pull up beside the green smoke (${Math.round(d)} m)`;
      } else if (m.phase === 'transit') {
        const d = Math.hypot(m.dropPos.x - v.pos.x, m.dropPos.z - v.pos.z);
        if (d < 30 && v.groundSpeed > 0.6) return 'Stop by the smoke to unload';
        if (d < 30 && !v.rampDown) return 'Press <kbd>R</kbd> to open the rear doors and unload';
        if (d >= 30 && d < 120) return `Pull up beside the smoke (${Math.round(d)} m)`;
        if (v.rampDown && v.groundSpeed > 3) return 'Rear doors are open — <kbd>R</kbd> to close them';
      } else if (m.phase === 'dropoff') return 'Unloading — hold position';
    }
    if (v.groundSpeed < 0.5 && this.heli.onGround && this.vehiclesTogether()) return 'Press <kbd>G</kbd> to get back in the helicopter';
    const site = this.siteUnderPlayer();
    if (site && site.kind !== 'lz' && v.groundSpeed < 0.5) return `Press <kbd>Tab</kbd> for the ${site.name} terminal`;
    return '';
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

  private onHumveeDestroyed(reason: string) {
    const v = this.humvee;
    this.effects.explosion(v.pos.clone().setY(v.pos.y + 0.8), 1.4);
    this.audio.explosion(this.cam.camera.position.distanceTo(v.pos), 1.4);
    this.wreckSmoke = this.effects.addEmitter(v.pos.clone().setY(v.pos.y + 0.6), 'burning', 6);
    v.scorch();
    v.doorsOpen = false;
    this.cam.shake = 1.6;
    this.hud.bigText('VEHICLE DESTROYED', reason, 3);
    this.missions.fail('Vehicle lost');
    this.crashTimer = 0;
  }

  private showCrashDialog() {
    if (this.humvee.destroyed && !this.heli.crashed) return this.showVehicleLostDialog();
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

  private showVehicleLostDialog() {
    const fee = Math.min(this.career.data.money, 2500);
    this.terminal.dialog(
      `<h2>Vehicle lost</h2><div class="sub">Humvee knocked out</div>
      <p>The crew bailed out and was picked up. A replacement Humvee is waiting at the ${this.world.base.name} motor pool.</p>
      <table><tr><td>Recovery &amp; replacement deductible</td><td class="neg">−${fmtMoney(fee)}</td></tr></table>
      <div class="actions"><button class="primary" data-act="ok">Return to ${this.world.base.name}</button></div>`,
      {
        ok: () => {
          this.career.data.money -= fee;
          this.career.save();
          this.terminal.closeDialog();
          this.threats.clearHotZones();
          this.effects.removeEmitter(this.wreckSmoke);
          this.wreckSmoke = null;
          this.crashTimer = -1;
          this.humvee.repair();
          this.humvee.payload = 0;
          this.parkHumvee();
          this.cam.snap();
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
