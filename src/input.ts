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
  KeyE: 'engine',
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
      if (k('ArrowUp') || k('Numpad8') || k('KeyI')) tp += 1;
      if (k('ArrowDown') || k('Numpad2') || k('KeyK')) tp -= 1;
      if (k('ArrowRight') || k('Numpad6') || k('KeyL')) tr += 1;
      if (k('ArrowLeft') || k('Numpad4') || k('KeyJ')) tr -= 1;
      if (k('KeyD')) ty += 1;
      if (k('KeyA')) ty -= 1;
      const fine = k('ShiftLeft') || k('ShiftRight');
      const rate = fine ? 0.12 : 0.45;
      if (k('KeyW') || k('PageUp')) dc += rate;
      if (k('KeyS') || k('PageDown')) dc -= rate;
    }

    // Keyboard: ramp deflection in/out for smooth control.
    const sIn = 2.2;
    const sOut = 4.5;
    const ramp = (cur: number, tgt: number) => approach(cur, tgt, (tgt === 0 || Math.sign(tgt) !== Math.sign(cur) ? sOut : sIn) * dt);
    this.pitch = ramp(this.pitch, tp);
    this.roll = ramp(this.roll, tr);
    this.yaw = ramp(this.yaw, ty);
    this.collective = clamp(this.collective + dc * dt, 0, 1);

    // Gamepad overrides when present and touched.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (gp && this.enabled) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const lx = dz(gp.axes[0] ?? 0);
      const ly = dz(gp.axes[1] ?? 0);
      const rx = dz(gp.axes[2] ?? 0);
      const ry = dz(gp.axes[3] ?? 0);
      const lt = gp.buttons[6]?.value ?? 0;
      const rt = gp.buttons[7]?.value ?? 0;
      if (Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) + lt + rt > 0.05) this.usingPad = true;
      if (this.usingPad) {
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
