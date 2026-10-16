import type { World } from '../world/worldgen';
import { HALF, WORLD_SIZE } from '../world/terrain';
import type { Site } from '../world/sites';

/** Overview image size (bigger on a big map, so roads and towns still read). */
const IMG = WORLD_SIZE > 30000 ? 2048 : 1024;
/** Heights for the overview's relief are sampled this many pixels apart (then interpolated). */
const HSTEP = WORLD_SIZE > 30000 ? 4 : 2;
/** The minimap's own detailed relief: this many pixels, covering this many metres. */
const MINI_IMG = 384;
const MINI_SPAN = 4800;

export const SITE_COLOR: Record<string, string> = { base: '#6fb0ff', fob: '#8fe08f', cop: '#f2e9a6', lz: '#ffffff' };

export interface SectorMarker {
  x: number;
  z: number;
  name: string;
  control: number;
  active: boolean;
}

export interface AirMarker {
  x: number;
  z: number;
  heading: number;
  friendly: boolean;
}

export interface MapMarker {
  x: number;
  z: number;
  color: string;
  label?: string;
}

/** Pre-rendered shaded relief of the whole theater, plus overlays. */
export class MapRenderer {
  img: HTMLCanvasElement;

  constructor(private world: World) {
    this.img = document.createElement('canvas');
    this.img.width = IMG;
    this.img.height = IMG;
    const g = this.img.getContext('2d')!;
    const data = g.createImageData(IMG, IMG);
    const t = world.terrain;
    const px = WORLD_SIZE / IMG;
    // Heights on a coarser grid, worked out directly (no terrain tiles are built for the map).
    const HN = IMG / HSTEP + 2;
    const H = new Float32Array(HN * HN);
    for (let j = 0; j < HN; j++) for (let i = 0; i < HN; i++) H[j * HN + i] = t.groundAt(-HALF + i * HSTEP * px, -HALF + j * HSTEP * px);
    const hAt = (fi: number, fj: number) => {
      const i = Math.min(HN - 2, Math.floor(fi));
      const j = Math.min(HN - 2, Math.floor(fj));
      const u = fi - i;
      const v = fj - j;
      const a = H[j * HN + i] + (H[j * HN + i + 1] - H[j * HN + i]) * u;
      const b = H[(j + 1) * HN + i] + (H[(j + 1) * HN + i + 1] - H[(j + 1) * HN + i]) * u;
      return a + (b - a) * v;
    };
    for (let j = 0; j < IMG; j++) {
      for (let i = 0; i < IMG; i++) {
        const x = -HALF + (i + 0.5) * px;
        const z = -HALF + (j + 0.5) * px;
        const fi = (i + 0.5) / HSTEP;
        const fj = (j + 0.5) / HSTEP;
        const h = hAt(fi, fj);
        // Slope over a pixel (from the interpolated grid), scaled to match the old per-pixel shading.
        const hx = hAt(fi + 1 / HSTEP, fj) - h;
        const hz = hAt(fi, fj + 1 / HSTEP) - h;
        const shade = Math.max(0.55, Math.min(1.3, 1 + (-hx * 0.6 - hz * 0.4) * 0.06 * (1024 / IMG) * (WORLD_SIZE / 14400)));
        let r: number, gg: number, b: number;
        if (h < 0.3) {
          r = 52;
          gg = 84;
          b = 98;
        } else {
          const k = Math.min(1, h / 320);
          r = 78 + k * 80;
          gg = 96 + k * 50;
          b = 58 + k * 60;
        }
        r *= shade;
        gg *= shade;
        b *= shade;
        if (world.front.side(x, z) > 0) {
          r = r * 0.75 + 60;
          gg *= 0.7;
          b *= 0.7;
        }
        const o = (j * IMG + i) * 4;
        data.data[o] = r;
        data.data[o + 1] = gg;
        data.data[o + 2] = b;
        data.data[o + 3] = 255;
      }
    }
    g.putImageData(data, 0, 0);
    // Roads.
    world.roads.paths.forEach((p, pi) => {
      const cls = world.roads.classes[pi];
      g.strokeStyle = cls === 'main' ? 'rgba(235, 225, 200, 0.9)' : cls === 'secondary' ? 'rgba(215, 195, 150, 0.8)' : 'rgba(190, 160, 110, 0.65)';
      g.lineWidth = cls === 'main' ? 2.2 : cls === 'secondary' ? 1.6 : 1.1;
      g.beginPath();
      p.forEach((v, k) => {
        const a = (v.x + HALF) / px;
        const c = (v.y + HALF) / px;
        if (k) g.lineTo(a, c);
        else g.moveTo(a, c);
      });
      g.stroke();
    });
    // Front line.
    g.strokeStyle = 'rgba(255, 70, 50, 0.95)';
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath();
    for (let z = -HALF; z <= HALF; z += 40) {
      const a = (world.front.x(z) + HALF) / px;
      const c = (z + HALF) / px;
      if (z === -HALF) g.moveTo(a, c);
      else g.lineTo(a, c);
    }
    g.stroke();
    g.setLineDash([]);
  }

  private siteDot(g: CanvasRenderingContext2D, s: Site, x: number, y: number, scale: number, label: boolean) {
    const r = s.kind === 'base' ? 6 : s.kind === 'fob' ? 5 : s.kind === 'cop' ? 4 : 3;
    g.fillStyle = SITE_COLOR[s.kind];
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.beginPath();
    if (s.kind === 'lz') g.arc(x, y, r * scale, 0, Math.PI * 2);
    else g.rect(x - r * scale, y - r * scale, r * 2 * scale, r * 2 * scale);
    g.fill();
    g.stroke();
    if (label) {
      g.font = `${Math.round(11 * scale)}px ui-monospace, monospace`;
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 3;
      g.strokeText(s.name, x + r * scale + 4, y + 4);
      g.fillText(s.name, x + r * scale + 4, y + 4);
    }
  }

  private heliArrow(g: CanvasRenderingContext2D, x: number, y: number, heading: number, s: number) {
    g.save();
    g.translate(x, y);
    g.rotate(heading);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -9 * s);
    g.lineTo(6 * s, 7 * s);
    g.lineTo(0, 3 * s);
    g.lineTo(-6 * s, 7 * s);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  /** The minimap's detailed relief round (miniX, miniZ), and the one being drawn a few rows a frame. */
  private mini: HTMLCanvasElement | null = null;
  private miniX = 0;
  private miniZ = 0;
  private miniNext: { c: HTMLCanvasElement; data: ImageData; x: number; z: number; row: number; cur?: Float32Array; next?: Float32Array } | null = null;

  /** Keep a detailed relief round the player for the minimap: redrawn (a few rows a frame) when they've moved on. */
  private updateMini(hx: number, hz: number) {
    const far = !this.mini || Math.max(Math.abs(hx - this.miniX), Math.abs(hz - this.miniZ)) > MINI_SPAN * 0.2;
    if (far && !this.miniNext) {
      const c = document.createElement('canvas');
      c.width = c.height = MINI_IMG;
      this.miniNext = { c, data: c.getContext('2d')!.createImageData(MINI_IMG, MINI_IMG), x: hx, z: hz, row: 0 };
    }
    const n = this.miniNext;
    if (!n) return;
    const t = this.world.terrain;
    const px = MINI_SPAN / MINI_IMG;
    // One height per pixel (plus a row and column beyond, for the shading), a few rows a frame.
    const W = MINI_IMG + 1;
    const rowH = (j: number, out: Float32Array) => {
      const z = n.z - MINI_SPAN / 2 + (j + 0.5) * px;
      for (let i = 0; i < W; i++) out[i] = t.heightIfReady(n.x - MINI_SPAN / 2 + (i + 0.5) * px, z);
    };
    n.cur ??= new Float32Array(W);
    n.next ??= new Float32Array(W);
    if (n.row === 0) rowH(0, n.cur);
    for (let k = 0; k < 4 && n.row < MINI_IMG; k++, n.row++) {
      const j = n.row;
      rowH(j + 1, n.next);
      const z = n.z - MINI_SPAN / 2 + (j + 0.5) * px;
      for (let i = 0; i < MINI_IMG; i++) {
        const x = n.x - MINI_SPAN / 2 + (i + 0.5) * px;
        const h = n.cur[i];
        const ddx = n.cur[i + 1] - h;
        const ddz = n.next[i] - h;
        const shade = Math.max(0.55, Math.min(1.3, 1 + (-ddx * 0.6 - ddz * 0.4) * 0.06 * (px / 14)));
        let r: number, gg: number, b: number;
        if (h < 0.3) [r, gg, b] = [52, 84, 98];
        else {
          const kk = Math.min(1, h / 320);
          [r, gg, b] = [78 + kk * 80, 96 + kk * 50, 58 + kk * 60];
        }
        if (this.world.front.side(x, z) > 0) [r, gg, b] = [r * 0.75 + 60, gg * 0.7, b * 0.7];
        const o = (j * MINI_IMG + i) * 4;
        n.data.data[o] = r * shade;
        n.data.data[o + 1] = gg * shade;
        n.data.data[o + 2] = b * shade;
        n.data.data[o + 3] = 255;
      }
      [n.cur, n.next] = [n.next, n.cur];
    }
    if (n.row < MINI_IMG) return;
    const g = n.c.getContext('2d')!;
    g.putImageData(n.data, 0, 0);
    // Roads near it.
    const toP = (x: number, z: number): [number, number] => [(x - (n.x - MINI_SPAN / 2)) / px, (z - (n.z - MINI_SPAN / 2)) / px];
    this.world.roads.paths.forEach((p, pi) => {
      const half = MINI_SPAN / 2 + 50;
      if (!p.some((v) => Math.abs(v.x - n.x) < half && Math.abs(v.y - n.z) < half)) return;
      const cls = this.world.roads.classes[pi];
      g.strokeStyle = cls === 'main' ? 'rgba(235, 225, 200, 0.9)' : cls === 'secondary' ? 'rgba(215, 195, 150, 0.8)' : 'rgba(190, 160, 110, 0.65)';
      g.lineWidth = cls === 'main' ? 2.4 : cls === 'secondary' ? 1.8 : 1.2;
      g.beginPath();
      p.forEach((v, k) => {
        const [a, c] = toP(v.x, v.y);
        if (k) g.lineTo(a, c);
        else g.moveTo(a, c);
      });
      g.stroke();
    });
    this.mini = n.c;
    this.miniX = n.x;
    this.miniZ = n.z;
    this.miniNext = null;
  }

  /** North-up local map centered on the helicopter. */
  drawMini(g: CanvasRenderingContext2D, size: number, hx: number, hz: number, heading: number, range: number, markers: MapMarker[], air: AirMarker[] = []) {
    g.fillStyle = '#222';
    g.fillRect(0, 0, size, size);
    this.updateMini(hx, hz);
    if (this.mini && range * 2 <= MINI_SPAN) {
      const px = MINI_SPAN / MINI_IMG;
      const srcSize = (range * 2) / px;
      g.drawImage(this.mini, (hx - (this.miniX - MINI_SPAN / 2)) / px - srcSize / 2, (hz - (this.miniZ - MINI_SPAN / 2)) / px - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    } else {
      const px = WORLD_SIZE / IMG;
      const srcSize = (range * 2) / px;
      g.drawImage(this.img, (hx + HALF) / px - srcSize / 2, (hz + HALF) / px - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    }
    const toS = (x: number, z: number): [number, number] => [((x - hx) / (range * 2) + 0.5) * size, ((z - hz) / (range * 2) + 0.5) * size];
    for (const t of this.world.towns) {
      const [x, y] = toS(t.x, t.z);
      const r = (t.r / (range * 2)) * size;
      g.fillStyle = t.contested ? 'rgba(90,80,70,0.75)' : 'rgba(200,190,170,0.6)';
      g.fillRect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
    }
    for (const s of this.world.sites) {
      const [x, y] = toS(s.x, s.z);
      if (x < -20 || y < -20 || x > size + 20 || y > size + 20) continue;
      this.siteDot(g, s, x, y, 0.8, false);
    }
    for (const a of air) {
      const [x, y] = toS(a.x, a.z);
      if (x < 0 || y < 0 || x > size || y > size) continue;
      g.save();
      g.translate(x, y);
      g.rotate(a.heading);
      g.fillStyle = a.friendly ? '#7fb6ff' : '#ff6a5a';
      g.beginPath();
      g.moveTo(0, -6);
      g.lineTo(5, 5);
      g.lineTo(0, 2);
      g.lineTo(-5, 5);
      g.closePath();
      g.fill();
      g.restore();
    }
    for (const m of markers) {
      let [x, y] = toS(m.x, m.z);
      const cx = size / 2;
      const dx = x - cx;
      const dy = y - cx;
      const d = Math.hypot(dx, dy);
      const lim = size / 2 - 10;
      if (d > lim) {
        x = cx + (dx / d) * lim;
        y = cx + (dy / d) * lim;
      }
      g.fillStyle = m.color;
      g.strokeStyle = '#000';
      g.beginPath();
      g.moveTo(x, y - 7);
      g.lineTo(x + 6, y);
      g.lineTo(x, y + 7);
      g.lineTo(x - 6, y);
      g.closePath();
      g.fill();
      g.stroke();
    }
    this.heliArrow(g, size / 2, size / 2, heading, 1);
    // Range ring.
    g.strokeStyle = 'rgba(157,255,157,0.25)';
    g.beginPath();
    g.arc(size / 2, size / 2, size / 4, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(157,255,157,0.7)';
    g.font = '10px ui-monospace, monospace';
    g.fillText('N', size / 2 - 3, 12);
  }

  drawBig(g: CanvasRenderingContext2D, size: number, hx: number, hz: number, heading: number, markers: MapMarker[], sectors: SectorMarker[] = []) {
    g.drawImage(this.img, 0, 0, size, size);
    const toS = (x: number, z: number): [number, number] => [((x + HALF) / WORLD_SIZE) * size, ((z + HALF) / WORLD_SIZE) * size];
    // Grid (1 km; 5 km on a big map).
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    const step = WORLD_SIZE > 30000 ? 5000 : 1000;
    for (let k = -HALF; k <= HALF; k += step) {
      const [a] = toS(k, 0);
      g.beginPath();
      g.moveTo(a, 0);
      g.lineTo(a, size);
      g.stroke();
      g.beginPath();
      g.moveTo(0, a);
      g.lineTo(size, a);
      g.stroke();
    }
    // Front sectors: control bar (blue = friendly share), letter, and a pulse if fighting is live.
    for (const sm of sectors) {
      const [x, y] = toS(sm.x, sm.z);
      const w = 30;
      const share = (sm.control + 1) / 2;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x - w / 2 - 2, y - 4, w + 4, 8);
      g.fillStyle = '#5aa0ff';
      g.fillRect(x - w / 2, y - 2, w * share, 4);
      g.fillStyle = '#ff5a46';
      g.fillRect(x - w / 2 + w * share, y - 2, w * (1 - share), 4);
      g.font = 'bold 10px ui-monospace, monospace';
      g.fillStyle = '#fff';
      g.fillText(sm.name.replace('Sector ', ''), x + w / 2 + 6, y + 4);
      if (sm.active) {
        g.strokeStyle = 'rgba(255,200,80,0.9)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 13, 0, Math.PI * 2);
        g.stroke();
      }
    }
    for (const t of this.world.towns) {
      const [x, y] = toS(t.x, t.z);
      const r = (t.r / WORLD_SIZE) * size;
      g.fillStyle = t.contested ? 'rgba(70,62,55,0.85)' : 'rgba(215,205,185,0.75)';
      g.fillRect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
      g.font = 'italic 11px ui-monospace, monospace';
      g.fillStyle = t.contested ? '#ffb39a' : '#f0e8d0';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 3;
      g.strokeText(t.name, x - r, y + r + 12);
      g.fillText(t.name, x - r, y + r + 12);
    }
    for (const s of this.world.sites) {
      const [x, y] = toS(s.x, s.z);
      this.siteDot(g, s, x, y, size / 700, true);
    }
    for (const m of markers) {
      const [x, y] = toS(m.x, m.z);
      g.strokeStyle = m.color;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 12, 0, Math.PI * 2);
      g.stroke();
      if (m.label) {
        g.font = 'bold 13px ui-monospace, monospace';
        g.fillStyle = m.color;
        g.fillText(m.label, x + 15, y - 10);
      }
    }
    const [x, y] = toS(hx, hz);
    this.heliArrow(g, x, y, heading, 1.4);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '12px ui-monospace, monospace';
    g.fillText('1 km grid', 10, size - 10);
  }
}
