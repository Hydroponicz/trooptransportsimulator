import type { World } from '../world/worldgen';
import { pointAt, type Route } from '../game/gps';
import { HALF, WORLD_SIZE } from '../world/terrain';
import type { Site } from '../world/sites';

/** Map tiles: pixels a side, tiles across the theater at level 0, levels of detail, how many to keep. */
const TPX = 256;
const TOP = 4;
const LEVELS = 7;
const KEEP_TILES = 160;

interface MapTile {
  c: HTMLCanvasElement | null;
  data: ImageData | null;
  row: number;
  cur: Float32Array | null;
  next: Float32Array | null;
  used: number;
}

const tileKey = (l: number, tx: number, tz: number) => (tz << 16) | (tx << 4) | l;
const levelOf = (key: number) => key & 0xf;

/** In a river's channel (the shallows at the banks dip below the waterline only here and there). */
function river(T: World['terrain'], x: number, z: number, h: number) {
  const r = T.river(x, z, h);
  return r.dist < r.width;
}
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

/** The GPS route to draw, from how far along it the vehicle has got. */
export interface RouteDraw {
  route: Route;
  progress: number;
  /** Where the vehicle is (for the dashed leg onto the road). */
  x: number;
  z: number;
}

export interface MapMarker {
  x: number;
  z: number;
  color: string;
  label?: string;
}

/**
 * The theater map, drawn from tiles at several levels of detail like a web
 * map: level 0 covers the theater in 4 × 4 tiles of 256 px, and each level
 * down halves the tile. Tiles are shaded relief worked out from the ground
 * heights (and the rivers), a few rows a frame, the coarse level as soon as
 * the game starts and finer ones while the map is open, a coarser tile
 * standing in until a finer one is ready. Roads, places, the front and the
 * markers are drawn over them.
 */
export class MapRenderer {
  private tiles = new Map<number, MapTile>();
  private queue: number[] = [];
  private frame = 0;

  constructor(private world: World) {
    for (let tz = 0; tz < TOP; tz++) for (let tx = 0; tx < TOP; tx++) this.queue.push(tileKey(0, tx, tz));
  }

  /** Work on the tiles wanted (most recently asked for first), a few milliseconds' worth. */
  update(budgetMs: number) {
    this.frame++;
    const deadline = performance.now() + budgetMs;
    while (this.queue.length && performance.now() < deadline) {
      const key = this.queue[0];
      const t = this.tile(key);
      if (this.stepTile(key, t, deadline)) this.queue.shift();
    }
    // Forget the least recently drawn fine tiles beyond what we keep.
    if (this.tiles.size > KEEP_TILES && this.frame % 60 === 0) {
      const old = [...this.tiles].filter(([k]) => levelOf(k) > 0).sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < old.length && this.tiles.size > KEEP_TILES; i++) this.tiles.delete(old[i][0]);
    }
  }

  private tile(key: number): MapTile {
    let t = this.tiles.get(key);
    if (!t) this.tiles.set(key, (t = { c: null, data: null, row: 0, cur: null, next: null, used: this.frame }));
    return t;
  }

  /** Shade more rows of a tile; true once it's done. */
  private stepTile(key: number, t: MapTile, deadline: number): boolean {
    if (t.c) return true;
    const l = levelOf(key);
    const tx = (key >> 4) & 0xfff;
    const tz = key >> 16;
    const size = WORLD_SIZE / (TOP << l);
    const px = size / TPX;
    const x0 = -HALF + tx * size;
    const z0 = -HALF + tz * size;
    const T = this.world.terrain;
    const W = TPX + 1;
    const rowH = (j: number, out: Float32Array) => {
      const z = z0 + (j + 0.5) * px;
      for (let i = 0; i < W; i++) out[i] = T.heightIfReady(x0 + (i + 0.5) * px, z);
    };
    if (!t.data) {
      t.data = new ImageData(TPX, TPX);
      t.cur = new Float32Array(W);
      t.next = new Float32Array(W);
      rowH(0, t.cur);
    }
    while (t.row < TPX) {
      const j = t.row;
      rowH(j + 1, t.next!);
      const z = z0 + (j + 0.5) * px;
      for (let i = 0; i < TPX; i++) {
        const x = x0 + (i + 0.5) * px;
        const h = t.cur![i];
        // Slope (per metre) lit from the north-west.
        const sx = (t.cur![i + 1] - h) / px;
        const sz = (t.next![i] - h) / px;
        const shade = Math.max(0.55, Math.min(1.3, 1 + (-sx * 0.6 - sz * 0.4) * 0.9));
        let r: number, g: number, b: number;
        const wet = h < 0.3 || (h < 6 && river(T, x, z, h));
        if (wet) [r, g, b] = [52, 84, 98];
        else {
          const k = Math.min(1, h / 320);
          [r, g, b] = [(78 + k * 80) * shade, (96 + k * 50) * shade, (58 + k * 60) * shade];
        }
        if (this.world.front.side(x, z) > 0) [r, g, b] = [r * 0.75 + 60, g * 0.7, b * 0.7];
        const o = (j * TPX + i) * 4;
        t.data.data[o] = r;
        t.data.data[o + 1] = g;
        t.data.data[o + 2] = b;
        t.data.data[o + 3] = 255;
      }
      [t.cur, t.next] = [t.next, t.cur];
      t.row++;
      if (performance.now() > deadline) return false;
    }
    const c = document.createElement('canvas');
    c.width = c.height = TPX;
    c.getContext('2d')!.putImageData(t.data, 0, 0);
    t.c = c;
    t.data = null;
    t.cur = t.next = null;
    return true;
  }

  /**
   * Draw the relief for a view (world rect x0, z0, span metres, onto size px):
   * from the finest level that suits the zoom, with coarser tiles standing in,
   * and ask for the missing ones (nearest the middle first).
   */
  private drawRelief(g: CanvasRenderingContext2D, x0: number, z0: number, span: number, size: number) {
    const mpp = span / size;
    const want = Math.max(0, Math.min(LEVELS - 1, Math.ceil(Math.log2(WORLD_SIZE / TOP / (mpp * TPX)))));
    const tsize = WORLD_SIZE / (TOP << want);
    const n = TOP << want;
    const a0 = Math.max(0, Math.floor((x0 + HALF) / tsize));
    const a1 = Math.min(n - 1, Math.floor((x0 + span + HALF) / tsize));
    const b0 = Math.max(0, Math.floor((z0 + HALF) / tsize));
    const b1 = Math.min(n - 1, Math.floor((z0 + span + HALF) / tsize));
    const missing: [number, number][] = [];
    for (let tz = b0; tz <= b1; tz++)
      for (let tx = a0; tx <= a1; tx++) {
        const dx = (-HALF + tx * tsize - x0) / mpp;
        const dz = (-HALF + tz * tsize - z0) / mpp;
        const dw = tsize / mpp;
        // This tile, or the nearest coarser one that's ready (the matching part of it).
        let drawn = false;
        for (let l = want; l >= 0 && !drawn; l--) {
          const sh = want - l;
          const key = tileKey(l, tx >> sh, tz >> sh);
          const t = this.tiles.get(key);
          if (!t?.c) continue;
          t.used = this.frame;
          const sub = TPX >> sh;
          g.drawImage(t.c, (tx & ((1 << sh) - 1)) * sub, (tz & ((1 << sh) - 1)) * sub, sub, sub, dx, dz, dw + 0.5, dw + 0.5);
          drawn = true;
        }
        if (!this.tiles.get(tileKey(want, tx, tz))?.c) missing.push([tx, tz]);
      }
    // Ask for the missing tiles, the middle of the view first.
    const cx = (x0 + span / 2 + HALF) / tsize;
    const cz = (z0 + span / 2 + HALF) / tsize;
    missing.sort((p, q) => Math.hypot(p[0] + 0.5 - cx, p[1] + 0.5 - cz) - Math.hypot(q[0] + 0.5 - cx, q[1] + 0.5 - cz));
    const keys = missing.map(([tx, tz]) => tileKey(want, tx, tz));
    this.queue = [...keys, ...this.queue.filter((k) => !keys.includes(k) && levelOf(k) === 0)];
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
  drawMini(g: CanvasRenderingContext2D, size: number, hx: number, hz: number, heading: number, range: number, markers: MapMarker[], air: AirMarker[] = [], route?: RouteDraw, headingUp = false) {
    g.fillStyle = '#222';
    g.fillRect(0, 0, size, size);
    // Heading-up (the GPS view while driving): turn the whole map round the centre.
    g.save();
    if (headingUp) {
      g.translate(size / 2, size / 2);
      g.rotate(-heading);
      g.translate(-size / 2, -size / 2);
    }
    this.updateMini(hx, hz);
    if (this.mini && range * 2 <= MINI_SPAN) {
      const px = MINI_SPAN / MINI_IMG;
      const srcSize = (range * 2) / px;
      g.drawImage(this.mini, (hx - (this.miniX - MINI_SPAN / 2)) / px - srcSize / 2, (hz - (this.miniZ - MINI_SPAN / 2)) / px - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    } else this.drawRelief(g, hx - range, hz - range, range * 2, size);
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
    if (route) this.drawRoute(g, route, toS, Math.max(2.5, size / 50));
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
    g.restore();
    this.heliArrow(g, size / 2, size / 2, headingUp ? 0 : heading, 1);
    // Range ring.
    g.strokeStyle = 'rgba(157,255,157,0.25)';
    g.beginPath();
    g.arc(size / 2, size / 2, size / 4, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(157,255,157,0.7)';
    g.font = '10px ui-monospace, monospace';
    const na = headingUp ? -heading : 0;
    const nr = size / 2 - 9;
    g.textAlign = 'center';
    g.fillText('N', size / 2 + Math.sin(na) * nr, size / 2 - Math.cos(na) * nr + 4);
    g.textAlign = 'left';
  }

  /** The GPS route still ahead: a bold line along the roads, dashed where it leaves them. */
  private drawRoute(g: CanvasRenderingContext2D, rd: RouteDraw, toS: (x: number, z: number) => [number, number], width: number) {
    const r = rd.route;
    const start = pointAt(r, rd.progress);
    const line = () => {
      g.beginPath();
      let [a, c] = toS(start.x, start.z);
      g.moveTo(a, c);
      for (let i = 0; i < r.cum.length; i++) {
        if (r.cum[i] <= rd.progress) continue;
        [a, c] = toS(r.pts[i * 2], r.pts[i * 2 + 1]);
        g.lineTo(a, c);
      }
    };
    g.lineJoin = 'round';
    g.lineCap = 'round';
    line();
    g.strokeStyle = 'rgba(60, 0, 0, 0.85)';
    g.lineWidth = width + 2.5;
    g.stroke();
    g.strokeStyle = '#ff3b30';
    g.lineWidth = width;
    g.stroke();
    // Off-road legs: from the vehicle to the road, and from the road to the destination.
    g.setLineDash([4, 4]);
    g.strokeStyle = '#ff3b30';
    g.lineWidth = Math.max(1.5, width * 0.5);
    g.beginPath();
    if (rd.progress < 1) {
      g.moveTo(...toS(rd.x, rd.z));
      g.lineTo(...toS(r.pts[0], r.pts[1]));
    }
    const end = pointAt(r, r.length);
    g.moveTo(...toS(end.x, end.z));
    g.lineTo(...toS(r.to.x, r.to.z));
    g.stroke();
    g.setLineDash([]);
    g.lineCap = 'butt';
  }

  /** World position of a point on the full map (u, v from 0 to 1 across it). */
  toWorld(u: number, v: number): { x: number; z: number } {
    const V = this.view;
    return { x: V.x - V.span / 2 + u * V.span, z: V.z - V.span / 2 + v * V.span };
  }

  /** The full map's view: centre and width shown (m). */
  view = { x: 0, z: 0, span: 16000 };

  /** Centre the full map on a point at a comfortable zoom (when it's opened). */
  centre(x: number, z: number) {
    this.view.x = x;
    this.view.z = z;
    this.view.span = Math.min(16000, WORLD_SIZE);
    this.clampView();
  }

  /** Zoom by a factor about a point given in the canvas's 0..1 coordinates (default its middle). */
  zoom(f: number, u = 0.5, v = 0.5) {
    const V = this.view;
    const wx = V.x + (u - 0.5) * V.span;
    const wz = V.z + (v - 0.5) * V.span;
    V.span = Math.min(WORLD_SIZE, Math.max(2500, V.span * f));
    V.x = wx - (u - 0.5) * V.span;
    V.z = wz - (v - 0.5) * V.span;
    this.clampView();
  }

  /** Pan by a fraction of the view's width. */
  pan(du: number, dv: number) {
    this.view.x += du * this.view.span;
    this.view.z += dv * this.view.span;
    this.clampView();
  }

  private clampView() {
    const V = this.view;
    const lim = Math.max(0, HALF - V.span / 2);
    V.x = Math.max(-lim, Math.min(lim, V.x));
    V.z = Math.max(-lim, Math.min(lim, V.z));
  }

  /**
   * The theater map at the current zoom: relief, roads, towns and sites, the
   * front's sectors, the objective and the helicopter. Names are placed most
   * important first (objective, base, cities, FOBs, then towns, outposts,
   * villages and landing zones as you zoom in), and a name that would overlap
   * one already placed is left out.
   */
  drawBig(g: CanvasRenderingContext2D, size: number, hx: number, hz: number, heading: number, markers: MapMarker[], sectors: SectorMarker[] = [], route?: RouteDraw, crosshair = false) {
    const V = this.view;
    const mpp = V.span / size;
    const x0 = V.x - V.span / 2;
    const z0 = V.z - V.span / 2;
    const toS = (x: number, z: number): [number, number] => [(x - x0) / mpp, (z - z0) / mpp];
    const inView = (x: number, z: number, m = 0) => x > x0 - m && x < x0 + V.span + m && z > z0 - m && z < z0 + V.span + m;
    g.fillStyle = '#1a1f1a';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = true;
    this.drawRelief(g, x0, z0, V.span, size);
    // Roads over the relief (main roads only when zoomed right out).
    {
      this.world.roads.paths.forEach((p, pi) => {
        const cls = this.world.roads.classes[pi];
        if (mpp > 40 && cls === 'track') return;
        if (!p.some((q) => inView(q.x, q.y, 200))) return;
        g.strokeStyle = cls === 'main' ? 'rgba(235, 225, 200, 0.95)' : cls === 'secondary' ? 'rgba(215, 195, 150, 0.85)' : 'rgba(190, 160, 110, 0.7)';
        g.lineWidth = Math.max(mpp > 40 ? 0.8 : 1, (cls === 'main' ? 9 : cls === 'secondary' ? 7 : 5) / mpp);
        g.beginPath();
        p.forEach((q, k) => {
          const [a, c] = toS(q.x, q.y);
          if (k) g.lineTo(a, c);
          else g.moveTo(a, c);
        });
        g.stroke();
      });
    }
    // Grid: the finest of 1, 2, 5, 10 km that leaves the lines well apart.
    const step = [1000, 2000, 5000, 10000].find((st) => st / mpp >= 70) ?? 10000;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let k = Math.ceil(x0 / step) * step; k <= x0 + V.span; k += step) {
      const [a] = toS(k, 0);
      g.beginPath();
      g.moveTo(a, 0);
      g.lineTo(a, size);
      g.stroke();
    }
    for (let k = Math.ceil(z0 / step) * step; k <= z0 + V.span; k += step) {
      const [, c] = toS(0, k);
      g.beginPath();
      g.moveTo(0, c);
      g.lineTo(size, c);
      g.stroke();
    }
    // Labels to place, most important first.
    const labels: { text: string; x: number; y: number; pri: number; color: string; font: string }[] = [];
    // Towns: their footprint, and a name if zoomed in enough for their size.
    for (const t of this.world.towns) {
      if (!inView(t.x, t.z, t.r + 200)) continue;
      const [x, y] = toS(t.x, t.z);
      const r = Math.max(2, t.r / mpp);
      g.fillStyle = t.contested ? 'rgba(70,62,55,0.85)' : 'rgba(215,205,185,0.75)';
      g.fillRect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
      const show = t.kind === 'city' || t.contested ? true : t.kind === 'town' ? mpp < 45 : mpp < 16;
      if (show)
        labels.push({
          text: t.name,
          x: x + r * 0.8 + 3,
          y: y + 4,
          pri: t.kind === 'city' ? 2 : t.contested ? 3 : t.kind === 'town' ? 5 : 7,
          color: t.contested ? '#ffb39a' : '#f0e8d0',
          font: t.kind === 'city' ? 'bold italic 13px ui-monospace, monospace' : 'italic 11px ui-monospace, monospace',
        });
    }
    // Front sectors: control bar (blue = friendly share), letter, and a ring if fighting is live.
    // Only as many as fit: every second, fifth... sector when zoomed out (the live ones always).
    const spacing = sectors.length > 1 ? Math.hypot(sectors[1].x - sectors[0].x, sectors[1].z - sectors[0].z) / mpp : 100;
    const every = Math.max(1, Math.ceil(46 / Math.max(1, spacing)));
    sectors.forEach((sm, i) => {
      if (!inView(sm.x, sm.z, 300) || (i % every !== 0 && !sm.active)) return;
      const [x, y] = toS(sm.x, sm.z);
      const w = 26;
      const share = (sm.control + 1) / 2;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x - w / 2 - 2, y - 4, w + 4, 8);
      g.fillStyle = '#5aa0ff';
      g.fillRect(x - w / 2, y - 2, w * share, 4);
      g.fillStyle = '#ff5a46';
      g.fillRect(x - w / 2 + w * share, y - 2, w * (1 - share), 4);
      labels.push({ text: sm.name.replace('Sector ', ''), x: x + w / 2 + 5, y: y + 4, pri: 4, color: '#fff', font: 'bold 10px ui-monospace, monospace' });
      if (sm.active) {
        g.strokeStyle = 'rgba(255,200,80,0.9)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 12, 0, Math.PI * 2);
        g.stroke();
      }
    });
    // Sites: always a dot; names as there's room.
    const pri: Record<string, number> = { base: 1, fob: 2, cop: 6, lz: 8 };
    for (const s of this.world.sites) {
      if (!inView(s.x, s.z, 50)) continue;
      const [x, y] = toS(s.x, s.z);
      const sc = s.kind === 'lz' && mpp > 20 ? 0.7 : 1;
      this.siteDot(g, s, x, y, sc, false);
      const show = s.kind === 'base' || (s.kind === 'fob' && mpp < 70) || (s.kind === 'cop' && mpp < 35) || (s.kind === 'lz' && mpp < 12);
      if (show) labels.push({ text: s.name, x: x + 8, y: y + 4, pri: pri[s.kind], color: '#fff', font: `${s.kind === 'base' ? 'bold ' : ''}11px ui-monospace, monospace` });
    }
    if (route) this.drawRoute(g, route, toS, Math.max(3, 10 / mpp));
    // The objective: ring, and its label above everything else.
    for (const m of markers) {
      let [x, y] = toS(m.x, m.z);
      const off = x < 0 || y < 0 || x > size || y > size;
      x = Math.max(14, Math.min(size - 14, x));
      y = Math.max(14, Math.min(size - 14, y));
      g.strokeStyle = m.color;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 12, 0, Math.PI * 2);
      g.stroke();
      if (m.label) labels.push({ text: `${m.label}${off ? ' ›' : ''}`, x: Math.min(x + 15, size - 8), y: y - 10, pri: 0, color: m.color, font: 'bold 13px ui-monospace, monospace' });
    }
    // Place the names: most important first, none over another.
    labels.sort((a, b) => a.pri - b.pri);
    const placed: [number, number, number, number][] = [];
    g.textAlign = 'left';
    for (const l of labels) {
      g.font = l.font;
      const w = g.measureText(l.text).width;
      let x = l.x;
      if (x + w > size - 4) x = size - 4 - w;
      const box: [number, number, number, number] = [x - 2, l.y - 12, x + w + 2, l.y + 4];
      if (l.pri > 0 && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 3;
      g.strokeText(l.text, x, l.y);
      g.fillStyle = l.color;
      g.fillText(l.text, x, l.y);
    }
    const [x, y] = toS(hx, hz);
    if (x > -20 && y > -20 && x < size + 20 && y < size + 20) this.heliArrow(g, x, y, heading, 1.4);
    // Controller crosshair (A drops a waypoint there).
    if (crosshair) {
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(size / 2 - 12, size / 2);
      g.lineTo(size / 2 - 4, size / 2);
      g.moveTo(size / 2 + 4, size / 2);
      g.lineTo(size / 2 + 12, size / 2);
      g.moveTo(size / 2, size / 2 - 12);
      g.lineTo(size / 2, size / 2 - 4);
      g.moveTo(size / 2, size / 2 + 4);
      g.lineTo(size / 2, size / 2 + 12);
      g.stroke();
    }
    // Scale and help.
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = '12px ui-monospace, monospace';
    g.fillText(`${step / 1000} km grid`, 10, size - 10);
  }

}
