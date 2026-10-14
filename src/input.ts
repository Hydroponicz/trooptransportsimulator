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
  | 'lookBack';

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
};

// Standard gamepad buttons.
const PADMAP: Record<number, Action> = { 0: 'ramp', 1: 'hook', 2: 'engine', 3: 'camera', 4: 'flares', 5: 'sas', 9: 'terminal', 8: 'map' };

/** Keyboard, mouse and gamepad into smoothed flight controls + discrete actions. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  private padRest = new Map<string, number[]>();
  collective = 0;
  pitch = 0;
  roll = 0;
  yaw = 0;
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  dragging = false;
  usingPad = false;
  /** When false, flight keys are ignored (menus open). */
  enabled = true;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'F1' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      // Ctrl is collective-down, so stop Ctrl+<flight key> browser shortcuts (save, bookmark, select all…).
      // Ctrl+W can only be captured in fullscreen with keyboard lock; see fullscreen.ts.
      if (e.ctrlKey && this.enabled && /^(Key[WASDQEHRFTCMIB]|Space)$/.test(e.code)) e.preventDefault();
      if (!e.repeat && KEYMAP[e.code]) this.pressed.add(KEYMAP[e.code]);
      this.keys.add(e.code);
      this.usingPad = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) this.dragging = true;
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
    if (this.enabled) {
      // W/S pitch, A/D roll (arrows as alternates), Q/E yaw, Space/Shift collective.
      if (k('KeyW') || k('ArrowUp') || k('Numpad8')) tp += 1;
      if (k('KeyS') || k('ArrowDown') || k('Numpad2')) tp -= 1;
      if (k('KeyD') || k('ArrowRight') || k('Numpad6')) tr += 1;
      if (k('KeyA') || k('ArrowLeft') || k('Numpad4')) tr -= 1;
      if (k('KeyE')) ty += 1;
      if (k('KeyQ')) ty -= 1;
      const rate = 0.4;
      if (k('Space') || k('PageUp')) dc += rate;
      if (k('ControlLeft') || k('ControlRight') || k('ShiftLeft') || k('ShiftRight') || k('PageDown')) dc -= rate;
    }

    // Keyboard: ramp deflection in/out for smooth control.
    const sIn = 1.5;
    const sOut = 4.5;
    const ramp = (cur: number, tgt: number) => approach(cur, tgt, (tgt === 0 || Math.sign(tgt) !== Math.sign(cur) ? sOut : sIn) * dt);
    this.pitch = ramp(this.pitch, tp);
    this.roll = ramp(this.roll, tr);
    this.yaw = ramp(this.yaw, ty);
    this.collective = clamp(this.collective + dc * dt, 0, 1);

    // Gamepad: only takes over once the player actually moves it, and
    // keyboard flight keys always win while held.
    const kbFlight = tp !== 0 || tr !== 0 || ty !== 0 || dc !== 0;
    if (kbFlight) this.usingPad = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (gp && this.enabled) {
      // Calibrate against the device's resting state: some devices report
      // triggers or throttles as axes resting at -1, which must not read as input.
      let base = this.padRest.get(gp.id);
      if (!base) {
        base = gp.axes.slice(0, 4);
        this.padRest.set(gp.id, base);
      }
      const axis = (i: number) => {
        const v = (gp.axes[i] ?? 0) - (base![i] ?? 0);
        const a = Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
        return clamp(a, -1, 1);
      };
      const lx = axis(0);
      const ly = axis(1);
      const rx = axis(2);
      const ry = axis(3);
      const lt = gp.mapping === 'standard' ? (gp.buttons[6]?.value ?? 0) : 0;
      const rt = gp.mapping === 'standard' ? (gp.buttons[7]?.value ?? 0) : 0;
      const moved = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(rx), Math.abs(ry), lt, rt) > 0.25;
      if (moved && !kbFlight) this.usingPad = true;
      if (this.usingPad && !kbFlight) {
        this.pitch = -ry * Math.abs(ry) ** 0.4;
        this.roll = rx * Math.abs(rx) ** 0.4;
        this.yaw = lx;
        this.collective = clamp(this.collective + (-ly * 0.5 + (rt - lt) * 0.5) * dt, 0, 1);
      }
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i] && PADMAP[i]) this.pressed.add(PADMAP[i]);
        this.padPrev[i] = b.pressed;
      });
      // D-pad up/down for fine collective.
      if (gp.buttons[12]?.pressed) this.collective = clamp(this.collective + 0.1 * dt, 0, 1);
      if (gp.buttons[13]?.pressed) this.collective = clamp(this.collective - 0.1 * dt, 0, 1);
    }
  }

  consumeMouse(): [number, number, number] {
    const r: [number, number, number] = [this.mouseDX, this.mouseDY, this.wheel];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    return r;
  }
}
