/**
 * Gamepad control of the menus: the main menu, pause and other dialogs, and
 * the base terminal. D-pad or left stick moves between buttons, A presses,
 * B backs out, Menu (Start) resumes or closes, LB / RB switch terminal tabs,
 * right stick scrolls. In flight the game reads the pad itself (input.ts).
 */

/** Overlays, topmost first. */
const LAYERS = ['dialog', 'terminal', 'menu'];
/** Buttons B (back) and Menu press in a dialog, the first that exists. */
const BACK_ACTS = ['resume', 'close', 'cancel', 'back', 'no', 'ok'];

let prev: boolean[] = [];
let layer: HTMLElement | null = null;
let shownAt = 0;
let current: HTMLElement | null = null;
/** Where focus was, so it can come back when an overlay redraws its buttons (the terminal does on every click). */
let lastIdx = -1;
let wantTab = false;
let repeatAt = 0;
let lastDir = '';
let last = performance.now();

/** Shown and laid out (overlays are position: fixed, so offsetParent can't tell). */
function visible(el: HTMLElement) {
  return !el.classList.contains('hidden') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function topLayer(): HTMLElement | null {
  for (const id of LAYERS) {
    const el = document.getElementById(id);
    if (el && visible(el)) return el;
  }
  return null;
}

function buttons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, select, a[href]')).filter(
    (b) => !(b as HTMLButtonElement).disabled && visible(b),
  );
}

function focus(el: HTMLElement | null) {
  current?.classList.remove('pad-focus');
  current = el;
  if (!el) return;
  el.classList.add('pad-focus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** The nearest button in a direction from the current one (spatial navigation). */
function move(list: HTMLElement[], dx: number, dy: number) {
  if (!current || !list.includes(current)) return focus(list.find((b) => b.classList.contains('primary')) ?? list[0] ?? null);
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const b of list) {
    if (b === current) continue;
    const q = b.getBoundingClientRect();
    const ox = q.left + q.width / 2 - cx;
    const oy = q.top + q.height / 2 - cy;
    const along = ox * dx + oy * dy;
    if (along <= 4) continue;
    const across = Math.abs(ox * dy - oy * dx);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best) focus(best);
}

function backButton(root: HTMLElement): HTMLElement | null {
  for (const a of BACK_ACTS) {
    const b = root.querySelector<HTMLElement>(`button[data-act="${a}"]`);
    if (b && visible(b)) return b;
  }
  return null;
}

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const gp = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((p) => p && p.connected) : null;
  const top = topLayer();
  if (top !== layer) {
    layer = top;
    shownAt = now;
    current?.classList.remove('pad-focus');
    current = null;
    lastIdx = -1;
  }
  if (!gp) return;
  const down = gp.buttons.map((b) => b.pressed);
  const was = prev;
  const pressed = (i: number) => down[i] && !was[i];
  prev = down;
  if (!layer) return;
  // A press that opened this overlay mustn't also act inside it.
  const settled = now - shownAt > 250;
  const list = buttons(layer);
  if ((!current || !list.includes(current)) && (wantTab || lastIdx >= 0) && list.length) {
    const tab = wantTab ? list.find((b) => b.dataset.act === 'tab' && b.classList.contains('on')) : null;
    focus(tab ?? list[Math.min(lastIdx, list.length - 1)]);
    wantTab = false;
  }
  if (current) lastIdx = list.indexOf(current);
  // Direction: D-pad or left stick, with key-repeat.
  const ax = gp.axes[0] ?? 0;
  const ay = gp.axes[1] ?? 0;
  let dir = '';
  if (down[12] || ay < -0.6) dir = 'u';
  else if (down[13] || ay > 0.6) dir = 'd';
  else if (down[14] || ax < -0.6) dir = 'l';
  else if (down[15] || ax > 0.6) dir = 'r';
  if (!current || !list.includes(current)) {
    // Focus appears on the first input from the pad (that input only shows it).
    if (down.some(Boolean) || dir) {
      move(list, 0, 0);
      lastDir = dir;
      repeatAt = now + 380;
    }
    return;
  }

  if (dir && (dir !== lastDir || now > repeatAt)) {
    repeatAt = now + (dir !== lastDir ? 380 : 120);
    move(list, dir === 'l' ? -1 : dir === 'r' ? 1 : 0, dir === 'u' ? -1 : dir === 'd' ? 1 : 0);
  }
  lastDir = dir;

  // Right stick scrolls the overlay.
  const ry = gp.axes[3] ?? 0;
  if (Math.abs(ry) > 0.2) {
    let s: HTMLElement | null = current;
    while (s && s !== layer && !(s.scrollHeight > s.clientHeight + 4 && getComputedStyle(s).overflowY !== 'visible')) s = s.parentElement;
    (s ?? layer).scrollBy(0, ry * 900 * dt);
  }

  if (!settled) return;
  if (pressed(0)) current.click();
  if (pressed(1) || pressed(9)) {
    const b = backButton(layer);
    if (b) b.click();
  }
  // LB / RB: previous / next terminal tab.
  if (layer.id === 'terminal' && (pressed(4) || pressed(5))) {
    const tabs = Array.from(layer.querySelectorAll<HTMLElement>('button[data-act="tab"]'));
    const i = tabs.findIndex((t) => t.classList.contains('on'));
    const t = tabs[(i + (pressed(5) ? 1 : -1) + tabs.length) % tabs.length];
    if (t) {
      t.click();
      wantTab = true;
    }
  }
}

export function startPadNav() {
  requestAnimationFrame(tick);
}
