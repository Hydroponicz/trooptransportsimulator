import { approach, clamp } from './util/math';

export type Action =
  | 'engine'
  | 'ramp'
  | 'hook'
  | 'flares'
  | 'camera'
  | 'sas'
  | 'terminal'
  | 'map'
  | 'pause'
  | 'help'
  | 'lookBack'
  | 'vehicle';

const KEYMAP: Record<string, Action> = {
  KeyI: 'engine',
  KeyR: 'ramp',
  KeyH: 'hook',
  KeyF: 'flares',
  KeyC: 'camera',
  KeyT: 'sas',
  Tab: 'terminal',
  KeyM: 'map',
  KeyP: 'pause',
  Escape: 'pause',
  F1: 'help',
  KeyB: 'lookBack',
  KeyG: 'vehicle',
};

/**
 * Standard gamepad buttons. GTA-style: A ramp/doors, B hook/horn, X flares,
 * Y get in/out, View camera, Menu pause, D-pad engine / assist / map /
 * terminal, L3 horn (LB/RB yaw in the air, RB handbrake on the ground,
 * R3 look back).
 */
const PADMAP_GTA: Record<number, Action> = { 0: 'ramp', 1: 'hook', 2: 'flares', 3: 'vehicle', 8: 'camera', 9: 'pause', 10: 'hook', 12: 'engine', 13: 'sas', 14: 'map', 15: 'terminal' };
/** The original simulator layout. */
const PADMAP_SIM: Record<number, Action> = { 0: 'ramp', 1: 'hook', 2: 'engine', 3: 'camera', 4: 'flares', 5: 'sas', 9: 'terminal', 8: 'map', 10: 'vehicle' };

/**
 * 'gta': W/S (triggers) climb and descend with the collective flown for you,
 * A/D (bumpers) yaw, arrows / numpad (left stick) pitch and roll, right stick
 * camera. 'sim': W/S/A/D cyclic, Q/E pedals, Shift/Ctrl collective lever,
 * right stick cyclic.
 */
export type Scheme = 'gta' | 'sim';

/** Gamepad state this frame (deadzoned sticks, triggers 0..1), when one is in use. */
export interface PadState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  lb: boolean;
  rb: boolean;
  l3: boolean;
  r3: boolean;
}

/**
 * The controller to read: a standard-mapped one (Xbox and PlayStation pads
 * are; other USB devices such as headsets, wheels or RGB keyboards can also
 * show up as "gamepads", often first in the list), and of those the one used
 * most recently. Browsers only list a controller after a button on it has
 * been pressed while the page has focus.
 */
export function activePad(): Gamepad | null {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  const live = pads.filter((p): p is Gamepad => !!p && p.connected);
  if (!live.length) return null;
  const std = live.filter((p) => p.mapping === 'standard');
  return (std.length ? std : live).reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
}

/** Short controller name for messages ("Xbox 360 Controller (XInput STANDARD GAMEPAD)" → "Xbox 360 Controller"). */
export function padName(p: Gamepad): string {
  return p.id.replace(/\s*\(.*$/, '').trim() || p.id;
}

/** Keyboard, mouse and gamepad into smoothed flight controls + discrete actions. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  private padRest = new Map<string, number[]>();
  scheme: Scheme = 'gta';
  collective = 0;
  /** GTA-style climb command, -1..1. */
  climb = 0;
  /** The connected gamepad's state while it is the active device, else null. */
  pad: PadState | null = null;
  pitch = 0;
  roll = 0;
  yaw = 0;
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  dragging = false;
  usingPad = false;
  /**
   * 'virtual': keys push a simulated spring-centred stick with inertia and a
   * soft centre (expo). 'direct': keys ramp straight to full deflection.
   */
  controlMode: 'virtual' | 'direct' = 'virtual';
  /** Raw virtual stick position (before the response curve), for the HUD. */
  stick = { x: 0, y: 0, pedal: 0 };
  private stickVel = { x: 0, y: 0, pedal: 0 };
  /** When false, flight keys are ignored (menus open). */
  enabled = true;
  /**
   * While a game is running, keys are caught in the capture phase and not
   * passed on, so page overlays (e.g. the Vercel preview toolbar, which opens
   * on Ctrl) never see the flight controls.
   */
  active = false;

  /**
   * Mouse look in fullscreen: while playing, the cursor is captured (hidden)
   * and every movement turns the camera. Holding left Alt, or any menu or
   * dialog being open, releases it. Set by the game each frame.
   */
  lookAllowed = false;
  private lockRetry = 0;

  constructor(private el: HTMLElement) {
    const swallow = (e: KeyboardEvent) => {
      if (this.active) e.stopPropagation();
    };
    window.addEventListener('keydown', (e) => {
      swallow(e);
      if (e.code === 'Tab' || e.code === 'F1' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      // Left Alt shows the cursor: don't let it also open the browser's menu bar.
      if (e.code === 'AltLeft') {
        e.preventDefault();
        if (this.locked) document.exitPointerLock();
      }
      // Ctrl is collective-down, so stop Ctrl+<flight key> browser shortcuts (save, bookmark, select all…).
      // Ctrl+W can only be captured in fullscreen with keyboard lock; see fullscreen.ts.
      if (e.ctrlKey && this.enabled && /^(Key[WASDQEHRFTCMIB]|Space)$/.test(e.code)) e.preventDefault();
      if (!e.repeat && KEYMAP[e.code]) this.pressed.add(KEYMAP[e.code]);
      this.keys.add(e.code);
      this.usingPad = false;
    }, { capture: true });
    window.addEventListener(
      'keyup',
      (e) => {
        swallow(e);
        this.keys.delete(e.code);
        // Alt released: take the cursor back (still within the key press's user activation).
        if (e.code === 'AltLeft') {
          e.preventDefault();
          this.keys.delete('AltLeft');
          if (this.wantLock()) this.lock();
        }
      },
      { capture: true },
    );
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) this.dragging = true;
      if (this.wantLock() && !this.locked) this.lock();
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (this.dragging || document.pointerLockElement) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    el.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  key(code: string) {
    return this.keys.has(code);
  }

  private get locked() {
    return document.pointerLockElement === this.el;
  }

  private wantLock() {
    return this.lookAllowed && !!document.fullscreenElement && !this.keys.has('AltLeft') && document.hasFocus();
  }

  private lock() {
    this.lockRetry = performance.now() + 1500;
    try {
      const r = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      /* not allowed right now (no user gesture yet): the next click or key press will do it */
    }
  }

  /** Capture or release the cursor for mouse look (call every frame). */
  updatePointer() {
    const want = this.wantLock();
    if (want && !this.locked && performance.now() > this.lockRetry) {
      // Browsers grant the lock during a user gesture (some also in fullscreen without one):
      // keep trying every so often; a refusal is harmless and the next click will do it.
      this.lock();
    } else if (!want && this.locked) document.exitPointerLock();
  }

  /** Consume a one-shot action. */
  take(a: Action): boolean {
    const had = this.pressed.has(a);
    this.pressed.delete(a);
    return had;
  }

  clearActions() {
    this.pressed.clear();
  }

  update(dt: number) {
    const k = (c: string) => this.keys.has(c);
    let tp = 0;
    let tr = 0;
    let ty = 0;
    let dc = 0;
    let climb = 0;
    const gta = this.scheme === 'gta';
    if (this.enabled && gta) {
      // W/S climb / descend, A/D (or Q/E) yaw, arrows / numpad pitch and roll.
      if (k('ArrowUp') || k('Numpad8')) tp += 1;
      if (k('ArrowDown') || k('Numpad5') || k('Numpad2')) tp -= 1;
      if (k('ArrowRight') || k('Numpad6')) tr += 1;
      if (k('ArrowLeft') || k('Numpad4')) tr -= 1;
      if (k('KeyD') || k('KeyE')) ty += 1;
      if (k('KeyA') || k('KeyQ')) ty -= 1;
      if (k('KeyW') || k('ShiftLeft') || k('ShiftRight') || k('PageUp')) climb += 1;
      if (k('KeyS') || k('ControlLeft') || k('ControlRight') || k('PageDown')) climb -= 1;
    } else if (this.enabled) {
      // W/S pitch, A/D roll (arrows as alternates), Q/E yaw, Shift/Ctrl collective.
      if (k('KeyW') || k('ArrowUp') || k('Numpad8')) tp += 1;
      if (k('KeyS') || k('ArrowDown') || k('Numpad2')) tp -= 1;
      if (k('KeyD') || k('ArrowRight') || k('Numpad6')) tr += 1;
      if (k('KeyA') || k('ArrowLeft') || k('Numpad4')) tr -= 1;
      if (k('KeyE')) ty += 1;
      if (k('KeyQ')) ty -= 1;
      const rate = 0.4;
      if (k('ShiftLeft') || k('ShiftRight') || k('Space') || k('PageUp')) dc += rate;
      if (k('ControlLeft') || k('ControlRight') || k('PageDown')) dc -= rate;
    }
    this.climb = climb;

    if (this.controlMode === 'virtual') {
      // A held key pushes the stick like a hand would: steady force against a
      // centring spring, with mass and damping, so it moves smoothly and
      // drifts back to centre when released.
      const axis = (k: 'x' | 'y' | 'pedal', key: number) => {
        const push = 10; // hand force
        const spring = key !== 0 ? 4 : 18; // centring spring (softer while held)
        const damping = 8.5;
        const target = key * 1.15; // slightly past the stop so holding reaches full
        const acc = (target - this.stick[k]) * (key !== 0 ? push : 0) - this.stick[k] * spring * (key !== 0 ? 0.25 : 1) - this.stickVel[k] * damping;
        this.stickVel[k] += acc * dt;
        this.stick[k] = clamp(this.stick[k] + this.stickVel[k] * dt, -1, 1);
        if (Math.abs(this.stick[k]) >= 1 && Math.sign(this.stickVel[k]) === Math.sign(this.stick[k])) this.stickVel[k] = 0;
        if (key === 0 && Math.abs(this.stick[k]) < 0.002 && Math.abs(this.stickVel[k]) < 0.01) this.stick[k] = this.stickVel[k] = 0;
      };
      axis('y', tp);
      axis('x', tr);
      axis('pedal', ty);
      // Soft centre: small deflections give fine control, full stick still reaches 1.
      const expo = (v: number, e: number) => (1 - e) * v + e * v * v * v;
      this.pitch = expo(this.stick.y, 0.55);
      this.roll = expo(this.stick.x, 0.55);
      this.yaw = expo(this.stick.pedal, 0.4);
    } else {
      // Direct: ramp deflection in/out.
      const sIn = 1.5;
      const sOut = 4.5;
      const ramp = (cur: number, tgt: number) => approach(cur, tgt, (tgt === 0 || Math.sign(tgt) !== Math.sign(cur) ? sOut : sIn) * dt);
      this.pitch = ramp(this.pitch, tp);
      this.roll = ramp(this.roll, tr);
      this.yaw = ramp(this.yaw, ty);
      this.stick.x = this.roll;
      this.stick.y = this.pitch;
      this.stick.pedal = this.yaw;
    }
    this.collective = clamp(this.collective + dc * dt, 0, 1);

    // Gamepad: only takes over once the player actually moves it, and
    // keyboard flight keys always win while held.
    const kbFlight = tp !== 0 || tr !== 0 || ty !== 0 || dc !== 0 || climb !== 0;
    if (kbFlight) this.usingPad = false;
    const gp = activePad();
    if (gp && this.enabled) {
      // Standard pads (Xbox, PlayStation) rest at 0 by definition, so their sticks are
      // never calibrated: taking the first reading as "centre" turned a stick that was
      // being wiggled when the pad was found into a permanent deflection (a spinning
      // camera). Other devices may report triggers or throttles as axes resting at
      // full ±1; only those are taken as offsets.
      let base = this.padRest.get(gp.id);
      if (!base) {
        base = gp.axes.slice(0, 4).map((v) => (gp.mapping !== 'standard' && Math.abs(v) > 0.99 ? v : 0));
        this.padRest.set(gp.id, base);
      }
      const raw = (i: number) => (gp.axes[i] ?? 0) - (base![i] ?? 0);
      // Round deadzone per stick (Microsoft's recommended Xbox values: ~24% left, ~26% right),
      // rescaled so the output still starts at 0 and reaches 1.
      const stickXY = (ix: number, iy: number, dz: number): [number, number] => {
        const x = raw(ix);
        const y = raw(iy);
        const m = Math.hypot(x, y);
        if (m < dz) return [0, 0];
        const k = Math.min(1, (m - dz) / (1 - dz)) / m;
        return [clamp(x * k, -1, 1), clamp(y * k, -1, 1)];
      };
      const [lx, ly] = stickXY(0, 1, 0.24);
      const [rx, ry] = stickXY(2, 3, 0.26);
      const lt = gp.mapping === 'standard' ? (gp.buttons[6]?.value ?? 0) : 0;
      const rt = gp.mapping === 'standard' ? (gp.buttons[7]?.value ?? 0) : 0;
      const moved = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(rx), Math.abs(ry), lt, rt) > 0.25;
      const btn = (i: number) => !!gp.buttons[i]?.pressed;
      if (moved && !kbFlight) this.usingPad = true;
      this.pad = this.usingPad ? { lx, ly, rx, ry, lt, rt, lb: btn(4), rb: btn(5), l3: btn(10), r3: btn(11) } : null;
      if (this.usingPad && !kbFlight && gta) {
        // Left stick cyclic, triggers climb / descend, bumpers yaw; the right stick is the camera.
        const curve = (v: number) => v * Math.abs(v) ** 0.4;
        this.pitch = curve(-ly);
        this.roll = curve(lx);
        this.yaw = (btn(5) ? 1 : 0) - (btn(4) ? 1 : 0);
        this.stick.x = lx;
        this.stick.y = -ly;
        this.stick.pedal = this.yaw;
        this.stickVel.x = this.stickVel.y = this.stickVel.pedal = 0;
        this.climb = clamp(rt - lt, -1, 1);
        // Camera: about 2.5 rad/s across, 1.8 up and down at full deflection (in mouse pixels).
        this.mouseDX += rx * Math.abs(rx) * 500 * dt;
        this.mouseDY += ry * Math.abs(ry) * 450 * dt;
      } else if (this.usingPad && !kbFlight) {
        this.pitch = -ry * Math.abs(ry) ** 0.4;
        this.roll = rx * Math.abs(rx) ** 0.4;
        this.yaw = lx;
        this.stick.x = rx;
        this.stick.y = -ry;
        this.stick.pedal = lx;
        this.stickVel.x = this.stickVel.y = this.stickVel.pedal = 0;
        this.collective = clamp(this.collective + (-ly * 0.5 + (rt - lt) * 0.5) * dt, 0, 1);
      }
      const map = gta ? PADMAP_GTA : PADMAP_SIM;
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i] && map[i]) {
          this.pressed.add(map[i]);
          this.usingPad = true;
        }
        this.padPrev[i] = b.pressed;
      });
      if (!gta) {
        // D-pad up/down for fine collective.
        if (gp.buttons[12]?.pressed) this.collective = clamp(this.collective + 0.1 * dt, 0, 1);
        if (gp.buttons[13]?.pressed) this.collective = clamp(this.collective - 0.1 * dt, 0, 1);
      }
    } else {
      this.pad = null;
      // Menus open: keep the button state current so the press that closes one
      // isn't read as a fresh in-game press next frame.
      if (gp) gp.buttons.forEach((b, i) => (this.padPrev[i] = b.pressed));
    }
    if (!this.usingPad) this.pad = null;
  }

  consumeMouse(): [number, number, number] {
    const r: [number, number, number] = [this.mouseDX, this.mouseDY, this.wheel];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    return r;
  }
}
