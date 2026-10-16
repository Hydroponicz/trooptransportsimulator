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
import { FarmWork } from './game/farmwork';
import { Campaign, CAMPAIGN_VERSION, SECTOR_COUNT } from './battle/campaign';
import { Battle } from './battle/battle';
import { AirOps } from './battle/air';
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
import { activePad, padName } from './input';
import { AIRFRAMES, type AircraftId } from './heli/airframe';
import { battleZone, Rooftops } from './game/rooftops';
import { Insertions } from './game/insertion';
import { AutoScaler, loadSetting, lower, PROFILES, resolve, saveSetting, type GraphicsSetting, type Quality } from './graphics';

const STEP = 1 / 120;

const QNAME: Record<Quality, string> = { high: 'High', medium: 'Medium', low: 'Low' };

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
  farmWork: FarmWork;
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
  /** Graphics: the saved choice, the preset in use, and Auto's resolution scaler. */
  graphics: GraphicsSetting = loadSetting();
  quality: Quality = resolve(this.graphics);
  private antialias = PROFILES[this.quality].antialias;
  private autoScale = new AutoScaler();

  constructor(
    public career: Career,
    container: HTMLElement,
    progress: (m: string) => void,
  ) {
    this.rng = new RNG(career.data.seed ^ 0xabcdef);
    // Antialiasing can only be chosen when the context is made, so it follows the setting at launch.
    this.renderer = new THREE.WebGLRenderer({ antialias: this.antialias, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // ACES plus the grade in world/look.ts.
    this.renderer.toneMapping = THREE.CustomToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.domElement.className = 'gl';
    container.prepend(this.renderer.domElement);

    this.world = generateWorld(career.data.seed, progress);
    this.scene.add(this.world.group);
    this.grass = new Grass(this.world.terrain, this.world.roads, this.world.colliders, this.world.farmland, this.world.towns, this.world.yards);
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
    this.cargo.colliders = this.world.colliders;
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
    this.farmWork = new FarmWork(this.world, this.effects);
    this.scene.add(this.farmWork.group);

    const wa = this.rng.range(0, Math.PI * 2);
    const ws = this.rng.range(1.5, 5);
    this.windBase.set(Math.sin(wa) * ws, 0, Math.cos(wa) * ws);
    this.wind.copy(this.windBase);

    const terrain = this.world.terrain;
    this.flightEnv = {
      // Roofs and other flat structure tops below the gear count as ground (rooftop landings).
      surfaceAt: (x, z, y) => {
        const t = terrain.surfaceAt(x, z);
        return y === undefined ? t : Math.max(t, this.world.colliders.topAt(x, z, y));
      },
      normalAt: (x, z, o, y) => {
        if (y !== undefined && this.world.colliders.topAt(x, z, y) > terrain.surfaceAt(x, z)) return o.set(0, 1, 0);
        return terrain.heightAt(x, z) < WATER_LEVEL ? o.set(0, 1, 0) : terrain.normalAt(x, z, o);
      },
      wind: this.wind,
    };

    this.effects.env = {
      ground: (x, z) => terrain.surfaceAt(x, z),
      ceiling: (x, z) => this.world.colliders.ceilingAt(x, z),
      solid: (p) => this.world.colliders.hit(p, 0, true),
    };

    this.missions.rooftops = new Rooftops(this.world);
    this.missions.insertions = new Insertions(
      this.world,
      (t) => battleZone(this.world, t),
      (z) => this.battle?.campaign.sectorAt(z).name ?? 'Front line',
    );
    this.missions.towns = this.world.towns;
    this.missions.battleZone = (t) => battleZone(this.world, t);
    this.heli.setAirframe(AIRFRAMES[career.data.aircraft ?? 'chinook']);
    this.heli.fm.sas = career.data.sas;
    this.input.controlMode = career.data.controlMode ?? 'virtual';
    if (!career.data.controls) {
      // First run with the GTA-style controls: they fly best with hover hold.
      career.data.controls = 'gta';
      career.data.sas = this.heli.fm.sas = 2;
    }
    this.input.scheme = career.data.controls;
    this.applyUpgrades();
    this.respawn(true);
    window.addEventListener('resize', () => this.resize());
    this.applyGraphics();
    // Say when the browser hands over (or loses) a controller, so it's clear whether it is seen at all.
    window.addEventListener('gamepadconnected', (e) => {
      const p = e.gamepad;
      this.toast(`Controller connected: ${padName(p)}${p.mapping === 'standard' ? '' : ' (non-standard layout: buttons may be mixed up)'}`, 'good');
    });
    window.addEventListener('gamepaddisconnected', (e) => this.toast(`Controller disconnected: ${padName(e.gamepad)}`, 'bad'));
    // Leaving fullscreen mid-flight drops the keyboard lock, so Ctrl+W could
    // close the tab again. Pause and offer a one-click way back.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.running && !this.paused && !this.terminal.dialogOpen) this.togglePause();
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const auto = this.graphics === 'auto' ? this.autoScale.scale : 1;
    const cap = Math.min(window.devicePixelRatio, PROFILES[this.quality].pixelRatio);
    // Auto's dynamic resolution, but never below 60% of a CSS pixel.
    this.renderer.setPixelRatio(Math.max(Math.min(cap, 0.6), cap * auto));
    this.renderer.setSize(w, h);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.effects.setView(h * this.renderer.getPixelRatio(), this.cam.camera.fov, this.scene.fog as THREE.Fog);
  }

  /** Pick a graphics setting (saved), or re-apply the current preset to the renderer and world. */
  setGraphics(s: GraphicsSetting) {
    this.graphics = s;
    saveSetting(s);
    this.quality = resolve(s);
    this.autoScale.reset();
    this.applyGraphics();
  }

  private applyGraphics() {
    const p = PROFILES[this.quality];
    const r = this.renderer;
    const type = p.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (r.shadowMap.type !== type) {
      r.shadowMap.type = type;
      // The shadow filter is compiled into the shaders.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    const sh = this.env.sun.shadow;
    if (sh.mapSize.x !== p.shadowMap) {
      sh.mapSize.set(p.shadowMap, p.shadowMap);
      sh.map?.dispose();
      sh.map = null;
    }
    const sc = sh.camera;
    sc.left = sc.bottom = -p.shadowBox;
    sc.right = sc.top = p.shadowBox;
    sc.updateProjectionMatrix();
    this.world.shadows.radius = p.casterRadius;
    this.world.shadows.invalidate();
    this.grass.setQuality(p.grassRange, p.grassDensity, p.cropRange);
    this.world.culler.scales.lod = p.lodScale;
    this.world.culler.scales.clutter = p.clutterScale;
    this.world.culler.scales.far = p.farScale;
    this.effects.density = p.smoke;
    this.effects.smoke.collideRange = 450 * p.smoke;
    this.env.setCloudQuality(p.cloudSteps);
    this.world.culler.update(this.cam.camera.position, true);
    this.resize();
  }

  /**
   * Change aircraft at a hangar: the new one is wheeled out onto the same
   * spot, fuelled to the same fraction, engines off.
   */
  switchAircraft(id: AircraftId): string | null {
    const h = this.heli;
    const af = AIRFRAMES[id];
    if (h.airframe === af) return null;
    if (this.mode !== 'fly' || !h.onGround || h.fm.groundSpeed > 0.5) return 'Land and stop first';
    if (this.missions.active) return 'Finish or abandon your contract first';
    const frac = h.fm.fuel / h.fm.fuelCapacity;
    const at = h.fm.pos.clone();
    const heading = h.fm.heading;
    h.setAirframe(af);
    this.applyUpgrades();
    h.spawn(at, heading);
    h.fm.fuel = frac * h.fm.fuelCapacity;
    h.flares = h.maxFlares;
    this.input.collective = 0;
    this.career.data.aircraft = id;
    this.career.save();
    this.cam.snap();
    this.toast(`${af.name} ready — ${id === 'littlebird' ? 'six operators on the pods, no cargo hook or ramp' : 'cabin for 30, ramp and cargo hook'}`, 'good');
    return null;
  }

  applyUpgrades() {
    const u = this.career.data.upgrades;
    const fm = this.heli.fm;
    const af = this.heli.airframe;
    fm.thrustScale = 1 + 0.06 * u.engine;
    this.heli.armor = 0.2 * u.armor;
    // Armor plate weighs in proportion to the airframe it covers.
    fm.extraMass = 350 * u.armor * (af.flight.emptyMass / 10400);
    const frac = fm.fuel / fm.fuelCapacity;
    fm.fuelCapacity = af.flight.fuelCapacity * (1 + 0.3 * u.fuel);
    fm.fuel = Math.min(fm.fuelCapacity, frac * fm.fuelCapacity);
    this.heli.maxFlares = Math.round(af.maxFlares * (1 + 0.53 * u.flares));
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
      this.toast(this.input.pad ? 'Driving the Humvee — RT accelerate, LT brake / reverse, left stick steer, RB handbrake, A rear doors, Y back to the helicopter' : 'Driving the Humvee — W/S throttle, A/D steer, Space handbrake, R rear doors, G back to the helicopter', 'good');
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

  private compiled = false;

  start() {
    this.running = true;
    this.input.active = true;
    this.hud.show(true);
    this.audio.init();
    this.last = performance.now();
    this.toast(this.input.scheme === 'gta' ? `Welcome to ${this.world.base.name}. Hold W (RT on a controller) to start the engines and lift off.` : `Welcome to ${this.world.base.name}. Press [I] to start the engines.`, 'good');
    this.toast('Open the base terminal with [Tab] to pick up a contract.');
    if (!this.compiled) {
      // The ground round the player, all of it, before the first frame.
      this.world.terrain.stream(this.heli.fm.pos, Infinity);
      this.world.rivers.update(0, Infinity);
      // Build every shader now rather than the first time something (smoke, fire) appears mid-flight.
      this.compiled = true;
      this.renderer.compile(this.scene, this.cam.camera);
    }
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
    const raw = (now - this.last) / 1000;
    const dt = Math.max(0, Math.min(0.1, raw));
    if (this.graphics === 'auto' && this.running && !document.hidden) {
      const act = this.autoScale.sample(raw);
      if (act === 'scale') this.resize();
      else if (act === 'lower' && lower(this.quality)) {
        this.quality = lower(this.quality)!;
        this.autoScale.reset();
        this.applyGraphics();
      }
    }
    this.last = Math.max(this.last, now);
    this.input.update(dt);
    this.handleActions();
    const modal = this.paused || this.terminal.isOpen || this.terminal.dialogOpen;
    this.input.enabled = !modal;
    // Fullscreen mouse look while playing; menus and dialogs get the cursor back.
    this.input.lookAllowed = this.running && !modal;
    this.input.updatePointer();
    if (!modal && dt > 0) this.simulate(dt);
    const mouse = this.input.consumeMouse();
    this.cam.lookBack = this.input.key('KeyB') || !!this.input.pad?.r3;
    this.humvee.setInteriorView(this.mode === 'drive' && this.cam.mode === 'cockpit');
    if (this.mode === 'drive') this.cam.updateGround(modal ? 0 : dt, this.humvee, this.world.terrain, mouse);
    else this.cam.update(modal ? 0 : dt, this.heli, this.world.terrain, mouse);
    this.env.follow(this.playerPos, this.cam.camera.position);
    this.world.shadows.update(this.playerPos);
    this.world.terrain.updateLod(this.cam.camera.position);
    this.world.rivers.update(dt);
    {
      // Rotor downwash flattens the grass when the helicopter is low with the rotors turning.
      const fm = this.heli.fm;
      const wash = this.mode === 'fly' && fm.rpm > 0.3 && !this.heli.crashed ? fm.rpm * (0.55 + 0.45 * fm.input.collective) : 0;
      this.grass.update(dt, this.cam.camera.position, wash > 0 ? fm.pos : null, Math.min(1, wash));
    }
    this.env.update(dt, this.renderer);
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
      if (!h.airframe.hasRamp) this.toast('No ramp on the Little Bird: the team climbs on and hops off the benches, with you landed or in a low, steady hover', 'info');
      else {
        h.rampOpen = !h.rampOpen;
        this.audio.click();
      }
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
    const hookPressed = inp.take('hook');
    if (hookPressed && !h.airframe.hasHook) this.toast('The Little Bird has no cargo hook', 'bad');
    else if (hookPressed) {
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
        <p style="opacity:.75;font-size:13px">${this.padStatus()}</p>
        <div class="actions" style="justify-content:flex-start;flex-wrap:wrap">
          ${document.fullscreenElement ? '' : '<button class="primary" data-act="fsresume">Back to fullscreen</button>'}
          <button class="${document.fullscreenElement ? 'primary' : ''}" data-act="resume">Resume</button>
          <button data-act="vol">Volume: ${Math.round(this.audio.volume * 100)}%</button>
          <button data-act="scheme" title="GTA-style: W/S climb, A/D turn, arrows tilt, triggers climb on a controller. Sim: the original stick, pedals and collective lever">Controls: ${this.input.scheme === 'gta' ? 'GTA-style' : 'Sim'}</button>
          <button data-act="ctl">Keyboard: ${this.input.controlMode === 'virtual' ? 'Virtual stick' : 'Direct'}</button>
          <button data-act="gfx" title="Auto picks a level for this computer and lowers the resolution if the frame rate drops">Graphics: ${this.graphics === 'auto' ? `Auto (${QNAME[this.quality]})` : QNAME[this.quality]}</button>
          ${document.fullscreenElement ? '<button data-act="fs">Exit fullscreen</button>' : ''}
          <button data-act="quit">Save &amp; quit to menu</button>
        </div>
        ${PROFILES[this.quality].antialias !== this.antialias ? '<p style="opacity:.7">Antialiasing changes apply the next time the game is loaded.</p>' : ''}`,
        {
          resume: () => {
            this.terminal.closeDialog();
            this.paused = false;
          },
          scheme: () => {
            const gta = this.input.scheme !== 'gta';
            this.input.scheme = this.career.data.controls = gta ? 'gta' : 'sim';
            // Take over the lever where the assist left it, or hand it to the assist.
            this.input.collective = this.heli.fm.input.collective;
            if (gta && this.heli.fm.sas < 2) this.career.data.sas = this.heli.fm.sas = 2;
            this.career.save();
            this.paused = false;
            this.togglePause();
          },
          ctl: () => {
            this.input.controlMode = this.input.controlMode === 'virtual' ? 'direct' : 'virtual';
            this.career.data.controlMode = this.input.controlMode;
            this.career.save();
            this.paused = false;
            this.togglePause();
          },
          gfx: () => {
            const order: GraphicsSetting[] = ['auto', 'high', 'medium', 'low'];
            this.setGraphics(order[(order.indexOf(this.graphics) + 1) % order.length]);
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
    this.env.setWind(this.wind);

    const driving = this.mode === 'drive';
    // GTA-style: the climb command flies the collective (flight.ts); sim: the lever is the player's.
    const gta = inp.scheme === 'gta';
    fm.assist = gta && !driving;
    fm.climb = driving ? 0 : inp.climb;
    if (!gta || driving) fm.input.collective = driving ? 0 : inp.collective;
    if (fm.assist && inp.climb > 0.3 && !fm.engineOn && fm.fuel > 0 && !h.crashed) {
      fm.engineOn = true;
      this.toast('Engines starting — wait for 100% rotor RPM', 'info');
    }
    fm.input.pitch = driving ? 0 : inp.pitch;
    fm.input.roll = driving ? 0 : inp.roll;
    fm.input.yaw = driving ? 0 : inp.yaw;
    const v = this.humvee;
    if (driving) {
      // W / RT: accelerate. S / LT: brake, then reverse when stopped. Space / RB: handbrake.
      const pad = inp.pad;
      const gas = Math.max(inp.key('KeyW') || inp.key('ArrowUp') ? 1 : 0, pad?.rt ?? 0);
      const rev = Math.max(inp.key('KeyS') || inp.key('ArrowDown') ? 1 : 0, pad?.lt ?? 0);
      const steerKey = (inp.key('KeyD') || inp.key('ArrowRight') ? 1 : 0) - (inp.key('KeyA') || inp.key('ArrowLeft') ? 1 : 0);
      const steerIn = steerKey || (pad?.lx ?? 0);
      let throttle = 0;
      let brake = 0;
      if (gas > 0.05) {
        if (v.speed < -1) brake = gas;
        else throttle = gas;
      } else if (rev > 0.05) {
        if (v.speed > 1) brake = rev;
        else throttle = -rev;
      }
      if (v.destroyed) (throttle = 0), (brake = 1);
      v.input.throttle = throttle;
      v.input.brake = brake;
      v.input.steer += (steerIn - v.input.steer) * Math.min(1, dt * 6);
      v.input.handbrake = inp.key('Space') || !!pad?.rb || (gas <= 0.05 && rev <= 0.05 && v.groundSpeed < 0.5);
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
      rampDown: carrier.rampDown,
      crew: {
        frame: h.parts.exterior,
        chiefSeat: h.airframe.cabin.crewChief,
        gunners: h.airframe.cabin.gunners,
        guns: h.parts.doorGuns,
        pilots: h.airframe.cabin.pilots,
        hidePilot: this.mode === 'fly' && this.cam.mode === 'cockpit',
        hinge: h.airframe.cabin.hinge,
        rampT: h.rampT,
        marshalling: carrier === h && (lc.canLoad || lc.canUnload),
        visible: !h.crashed && h.root.visible && h.parts.root.visible,
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
      this.farmWork.update(dt, this.cam.camera.position);
    }
    this.updateEffects(dt);
    this.effects.update(dt, this.cam.camera);
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
    const ground = this.flightEnv.surfaceAt(fm.pos.x, fm.pos.z, fm.pos.y);
    const thrustRatio = fm.thrust / (fm.mass * 9.81);
    const washH = 32;
    const af = h.airframe;
    // Twin rotors wash a longer patch: treat them as one bigger disc.
    e.downwash.radius = af.rotorRadius * (af.rotorHubs.length > 1 ? 1.35 : 1);
    e.downwash.vi = af.id === 'chinook' ? 20 : af.id === 'blackhawk' ? 17 : 12;
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
          y: this.flightEnv.surfaceAt(x, z, fm.pos.y) + 0.4,
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

  private padStatus(): string {
    const p = activePad();
    if (!p) return 'Controller: none detected. Press any button on it while the game is focused; if nothing shows up, this browser is not passing the controller through (it works in Chrome and Edge).';
    return `Controller: ${padName(p)}${p.mapping === 'standard' ? '' : ' (non-standard layout: buttons may be mixed up)'}`;
  }

  /** A button name for a prompt, for the keyboard or the controller and the control scheme in use. */
  private kb(a: 'ramp' | 'hook' | 'terminal' | 'vehicle' | 'sas' | 'engine'): string {
    const pad = this.input.usingPad;
    const gta = this.input.scheme === 'gta';
    const K = !pad
      ? { ramp: 'R', hook: 'H', terminal: 'Tab', vehicle: 'G', sas: 'T', engine: 'I' }
      : gta
        ? { ramp: 'A', hook: 'B', terminal: 'D-pad →', vehicle: 'Y', sas: 'D-pad ↓', engine: 'D-pad ↑' }
        : { ramp: 'A', hook: 'B', terminal: 'Start', vehicle: 'L3', sas: 'RB', engine: 'X' };
    return `<kbd>${K[a]}</kbd>`;
  }

  private liftHint(): string {
    if (this.input.scheme === 'gta') return `Hold ${this.input.usingPad ? '<kbd>RT</kbd>' : '<kbd>W</kbd>'} to lift off`;
    return this.input.usingPad ? 'Raise collective (left stick up / <kbd>RT</kbd>) to lift off' : 'Raise collective <kbd>Shift</kbd> to lift off';
  }

  private updatePrompt() {
    if (this.mode === 'drive') return this.hud.setPrompt(this.drivePrompt());
    const h = this.heli;
    const fm = h.fm;
    const m = this.missions.active;
    let p = '';
    if (h.crashed) p = '';
    else if (!fm.engineOn && fm.rpm < 0.05) p = this.input.scheme === 'gta' ? `${this.liftHint().replace('lift off', 'start the engines')}` : `Press ${this.kb('engine')} to start engines`;
    else if (fm.engineOn && fm.engineSpool < 0.99) p = `Engines spooling… NR ${(fm.rpm * 100).toFixed(0)}%`;
    else if (m && m.phase === 'pickup' && m.internal && m.group) {
      const near = Math.hypot(fm.pos.x - m.c.from.pads[m.c.fromPad].x, fm.pos.z - m.c.from.pads[m.c.fromPad].z) < 90;
      if (near && fm.contacts >= 3) {
        if (!h.rampDown) p = h.rampOpen ? 'Ramp lowering…' : `Press ${this.kb('ramp')} to lower the ramp`;
        else if (m.group.aboard < m.group.total) p = `Loading ${m.group.aboard}/${m.group.total} — hold position`;
      } else if (near) p = 'Land near the troops';
    } else if (m && m.c.ropeAt && (m.phase === 'transit' || m.phase === 'dropoff') && Math.hypot(fm.pos.x - m.c.ropeAt.x, fm.pos.z - m.c.ropeAt.z) < 200) {
      // Fast rope: talk the pilot into the hover.
      const r = m.c.ropeAt;
      const g = m.group;
      const h2 = h.gearBottom - r.y;
      const d = Math.hypot(fm.pos.x - r.x, fm.pos.z - r.z);
      if (m.phase === 'dropoff' && g) p = `Fast rope: ${g.unloadedCount}/${g.total} down — hold the hover (${h2.toFixed(0)} m)`;
      else if (d > r.r + 3) p = `Over the smoke: ${d.toFixed(0)} m to go (room: ${r.r.toFixed(0)} m)`;
      else if (h2 > 20) p = `Fast rope: come down, ${h2.toFixed(0)} m — ropes at 20 m and below`;
      else if (h2 < 3) p = `Fast rope: too low, ${h2.toFixed(1)} m — climb to 5–20 m`;
      else p = `Fast rope: ${h2.toFixed(0)} m — hold it steady`;
    } else if (m && m.c.roof && (m.phase === 'transit' || m.phase === 'dropoff') && Math.hypot(fm.pos.x - m.c.roof.x, fm.pos.z - m.c.roof.z) < 150) {
      // Rooftop insertion: talk the pilot into the hover.
      const r = m.c.roof;
      const g = m.group;
      if (m.phase === 'dropoff' && g) p = `Team going off ${g.unloadedCount}/${g.total} — hold the hover`;
      else if (h.airframe.hasRamp && !h.rampDown) p = h.rampOpen ? 'Ramp lowering…' : `Press ${this.kb('ramp')} to lower the ramp, then back it onto the roof edge`;
      else if (h.airframe.hasRamp) p = `Back the ramp onto the roof — ramp end ${Math.max(0, h.rampEndWorld(new THREE.Vector3()).y - r.y).toFixed(1)} m above it, hold steady`;
      else p = `Low hover over the roof — skids ${Math.max(0, h.gearBottom - r.y).toFixed(1)} m above it (under 2.5), hold steady`;
    } else if (m && m.phase === 'transit' && m.internal && h.rampOpen && fm.contacts === 0 && fm.groundSpeed > 15) p = `Ramp is down — press ${this.kb('ramp')} to raise it`;
    else if (m && m.phase === 'transit' && m.internal) {
      const d = Math.hypot(fm.pos.x - m.dropPos.x, fm.pos.z - m.dropPos.z);
      if (d < 70 && fm.contacts >= 3 && !h.rampDown) p = h.rampOpen ? 'Ramp lowering…' : `Press ${this.kb('ramp')} to lower the ramp and unload`;
      else if (d < 70 && fm.contacts >= 3 && !h.loadable) p = 'Come to a full stop to unload';
    } else if (m && m.phase === 'dropoff') p = 'Unloading — hold position';
    if (!p && this.slingTargetRel) {
      const st = this.slingTargetRel;
      p = st.ok ? `Press ${this.kb('hook')} to hook the load` : 'Position the hook over the load (see drift display)';
    }
    if (!p && this.sling.hooked) {
      const l = this.sling.hooked;
      if (l.onGround && m && m.load === l && Math.hypot(l.pos.x - m.dropPos.x, l.pos.z - m.dropPos.z) < 22) p = `Load is down in the zone — press ${this.kb('hook')} to release`;
      else if (l.onGround && this.sling.tension < l.mass * 3) p = `Load on the ground — press ${this.kb('hook')} to release, or lift`;
    }
    if (!p && fm.contacts >= 3 && fm.rpm > 0.97 && fm.input.collective < 0.3 && h.rampT < 0.03 && !m) {
      p = this.currentSite && this.currentSite.kind !== 'lz' ? `Press ${this.kb('terminal')} for the ${this.currentSite.name} terminal` : this.liftHint();
    }
    if (!p && fm.contacts >= 3 && fm.rpm > 0.97 && fm.input.collective < 0.3 && m && m.phase === 'transit') {
      p = h.rampT > 0.03 ? `Press ${this.kb('ramp')} to raise the ramp` : this.liftHint();
    }
    if (!p && m && m.c.mode === 'ground' && fm.contacts >= 3) p = this.vehiclesTogether() ? `Road job: press ${this.kb('vehicle')} to get in your Humvee` : 'Road job: your Humvee is parked elsewhere';
    if (!p && !fm.engineOn && fm.rpm > 0.05 && fm.contacts >= 3 && this.currentSite && this.currentSite.kind !== 'lz')
      p = `Press ${this.kb('terminal')} for the ${this.currentSite.name} terminal`;
    this.hud.setPrompt(p);
  }

  private drivePrompt(): string {
    const v = this.humvee;
    const m = this.missions.active;
    if (v.flipped || v.stalled) return `Press ${this.kb('sas')} to recover the vehicle`;
    if (m && m.c.mode === 'air' && m.phase !== 'complete' && m.phase !== 'failed') {
      if (this.vehiclesTogether() && v.groundSpeed < 0.5) return `This is a helicopter job — press ${this.kb('vehicle')} to get back in the helicopter`;
      return 'Your active job needs the helicopter (🚁 AIR)';
    }
    if (m && m.c.mode === 'ground') {
      const g = m.group;
      if (m.phase === 'pickup' && g) {
        const d = v.rampEndWorld(new THREE.Vector3()).setY(0).distanceTo(new THREE.Vector3(m.pickupPos.x, 0, m.pickupPos.z));
        if (d < 30) {
          if (v.groundSpeed > 0.6) return 'Stop here next to the green smoke';
          if (!v.rampDown) return `Press ${this.kb('ramp')} to open the rear doors`;
          if (g.aboard < g.total) return `Loading ${g.aboard}/${g.total} — hold position`;
        } else if (d < 120) return `Pull up beside the green smoke (${Math.round(d)} m)`;
      } else if (m.phase === 'transit') {
        const d = Math.hypot(m.dropPos.x - v.pos.x, m.dropPos.z - v.pos.z);
        if (d < 30 && v.groundSpeed > 0.6) return 'Stop by the smoke to unload';
        if (d < 30 && !v.rampDown) return `Press ${this.kb('ramp')} to open the rear doors and unload`;
        if (d >= 30 && d < 120) return `Pull up beside the smoke (${Math.round(d)} m)`;
        if (v.rampDown && v.groundSpeed > 3) return `Rear doors are open — ${this.kb('ramp')} to close them`;
      } else if (m.phase === 'dropoff') return 'Unloading — hold position';
    }
    if (v.groundSpeed < 0.5 && this.heli.onGround && this.vehiclesTogether()) return `Press ${this.kb('vehicle')} to get back in the helicopter`;
    const site = this.siteUnderPlayer();
    if (site && site.kind !== 'lz' && v.groundSpeed < 0.5) return `Press ${this.kb('terminal')} for the ${site.name} terminal`;
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
    // On whatever it came down on: the ground, or a roof.
    this.wreckSmoke = this.effects.addEmitter(fm.pos.clone().setY(this.flightEnv.surfaceAt(fm.pos.x, fm.pos.z, fm.pos.y) + 1), 'burning', 8);
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
