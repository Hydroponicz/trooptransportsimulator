import * as THREE from 'three';
import { Noise2D } from './noise';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Tileable grayscale ground detail, multiplied over terrain vertex colors. */
export function groundDetailTexture(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  const img = g.createImageData(S, S);
  const n = new Noise2D(1234);
  const tile = (x: number, y: number, f: number) => {
    // Blend four offset samples so the result tiles seamlessly.
    const u = x / S;
    const v = y / S;
    const a = n.noise(x * f, y * f);
    const b = n.noise((x - S) * f, y * f);
    const cc = n.noise(x * f, (y - S) * f);
    const d = n.noise((x - S) * f, (y - S) * f);
    return (a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 0.86 + 0.07 * tile(x, y, 0.03) + 0.05 * tile(x, y, 0.12) + (Math.random() - 0.5) * 0.08;
      const b = Math.max(0, Math.min(255, v * 255));
      const i = (y * S + x) * 4;
      img.data[i] = b;
      img.data[i + 1] = b;
      img.data[i + 2] = b * 0.97;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Helipad marking: gravel disc, painted ring and an "H". */
export function padTexture(label = 'H', ring = '#e8e2c8'): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#6f6656';
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 1800; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (S / 2 - 4);
    const s = 40 + Math.random() * 60;
    g.fillStyle = `rgb(${s + 50},${s + 45},${s + 35})`;
    g.fillRect(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 2, 2);
  }
  g.strokeStyle = ring;
  g.lineWidth = 10;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 18, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = ring;
  g.font = 'bold 140px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, S / 2, S / 2 + 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Motion-blurred rotor disc. */
export function rotorDiscTexture(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  const grad = g.createRadialGradient(S / 2, S / 2, 6, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(20,20,18,0.0)');
  grad.addColorStop(0.15, 'rgba(25,25,22,0.55)');
  grad.addColorStop(0.85, 'rgba(25,25,22,0.35)');
  grad.addColorStop(0.95, 'rgba(60,60,50,0.55)');
  grad.addColorStop(1, 'rgba(25,25,22,0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // Faint blade streaks.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * Math.PI * 2;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.arc(S / 2, S / 2, S / 2, a0 + 0.5, a0 + 1.7);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round sprite for particles. */
export function softSpriteTexture(): THREE.Texture {
  const S = 64;
  const [c, g] = canvas(S, S);
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

/** Puffy smoke sprite with some internal structure. */
export function smokeSpriteTexture(): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S, S);
  const n = new Noise2D(77);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2);
      const dy = (y - S / 2) / (S / 2);
      const r = Math.sqrt(dx * dx + dy * dy);
      const nn = n.fbm(x * 0.05, y * 0.05, 3) * 0.5 + 0.5;
      const a = Math.max(0, 1 - r) ** 1.5 * (0.55 + 0.6 * nn);
      const v = 200 + 55 * nn;
      const i = (y * S + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/**
 * Road surface, u across the carriageway (0..1), v along it (one tile = 12 m).
 * main: dark asphalt with edge lines and a dashed centre line.
 * secondary: worn, patched asphalt with a faded centre line.
 * track: compacted gravel with wheel ruts.
 */
export function roadTexture(kind: 'main' | 'secondary' | 'track' | 'plain' | 'plainworn'): THREE.Texture {
  const W = 256;
  const H = 512;
  const [c, g] = canvas(W, H);
  const base = kind === 'main' || kind === 'plain' ? [64, 66, 68] : kind === 'secondary' || kind === 'plainworn' ? [92, 90, 85] : [139, 123, 94];
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const grain = (Math.random() - 0.5) * (kind === 'track' ? 34 : 18);
      img.data[i] = base[0] + grain;
      img.data[i + 1] = base[1] + grain;
      img.data[i + 2] = base[2] + grain * 0.9;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  // Draw a shape twice, wrapped vertically, so the texture tiles along the road.
  const wrap = (fn: (dy: number) => void) => {
    fn(0);
    fn(-H);
    fn(H);
  };
  const blotch = (n: number, color: string, w0: number, w1: number, h0: number, h1: number) => {
    for (let k = 0; k < n; k++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const w = w0 + Math.random() * (w1 - w0);
      const h = h0 + Math.random() * (h1 - h0);
      g.fillStyle = color;
      wrap((dy) => {
        g.beginPath();
        g.ellipse(x, y + dy, w / 2, h / 2, 0, 0, Math.PI * 2);
        g.fill();
      });
    }
  };
  // Wheel tracks: darker, polished bands in each lane.
  const band = (u: number, w: number, color: string) => {
    g.fillStyle = color;
    g.fillRect(u * W - (w * W) / 2, 0, w * W, H);
  };
  if (kind === 'track') {
    blotch(60, 'rgba(110,96,70,0.35)', 10, 40, 20, 90);
    blotch(40, 'rgba(170,155,120,0.25)', 8, 30, 20, 60);
    for (const u of [0.22, 0.38, 0.62, 0.78]) band(u, 0.07, 'rgba(92,78,55,0.45)');
    band(0.5, 0.08, 'rgba(96,110,60,0.18)');
    // Pebbles.
    for (let k = 0; k < 900; k++) {
      const v = 120 + Math.random() * 90;
      g.fillStyle = `rgba(${v},${v * 0.95},${v * 0.85},0.8)`;
      const x = Math.random() * W;
      const y = Math.random() * H;
      g.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  } else {
    const worn = kind === 'secondary' || kind === 'plainworn';
    blotch(worn ? 50 : 25, 'rgba(40,40,40,0.18)', 10, 50, 20, 120);
    blotch(worn ? 30 : 12, 'rgba(150,150,145,0.12)', 10, 40, 20, 90);
    const plain = kind === 'plain' || kind === 'plainworn';
    if (!plain) for (const u of [0.15, 0.35, 0.65, 0.85]) band(u, 0.08, 'rgba(30,30,32,0.18)');
    if (worn) {
      // Patch repairs.
      for (let k = 0; k < 3; k++) {
        g.fillStyle = `rgba(${70 + Math.random() * 10},${70 + Math.random() * 10},70,0.55)`;
        const x = Math.random() * W * 0.8;
        const y = Math.random() * H;
        const w = 20 + Math.random() * 40;
        const h = 30 + Math.random() * 60;
        wrap((dy) => g.fillRect(x, y + dy, w, h));
      }
      // Crumbling edges.
      for (let k = 0; k < 500; k++) {
        const side = Math.random() < 0.5;
        const x = side ? Math.random() * 10 : W - Math.random() * 10;
        g.fillStyle = 'rgba(138,129,114,0.9)';
        g.fillRect(x, Math.random() * H, 2 + Math.random() * 3, 2 + Math.random() * 4);
      }
    }
    // Cracks.
    g.strokeStyle = 'rgba(25,25,25,0.55)';
    g.lineWidth = 1;
    for (let k = 0; k < (worn ? 22 : 8); k++) {
      let x = Math.random() * W;
      let y = Math.random() * H;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 8; s++) {
        x += (Math.random() - 0.5) * 18;
        y += (Math.random() - 0.3) * 14;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // Markings.
    const paint = (u: number, w: number, color: string, from: number, to: number, alpha: number) => {
      for (let y = Math.floor(from * H); y < to * H; y++) {
        if (Math.random() > alpha) continue;
        g.fillStyle = color;
        g.fillRect(u * W - (w * W) / 2, y, w * W, 1);
      }
    };
    if (plain) {
      // Junction asphalt: no markings.
    } else if (!worn) {
      paint(0.03, 0.016, 'rgba(235,235,225,0.95)', 0, 1, 0.93);
      paint(0.97, 0.016, 'rgba(235,235,225,0.95)', 0, 1, 0.93);
      paint(0.5, 0.016, 'rgba(240,240,232,0.95)', 0, 0.3, 0.95);
    } else {
      paint(0.5, 0.016, 'rgba(225,215,170,0.6)', 0, 0.25, 0.6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = kind === 'plain' || kind === 'plainworn' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Light gravel speckle, multiplied over shoulder vertex colors. */
export function gravelTexture(): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S, S);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 200 + Math.random() * 55 - (Math.random() < 0.08 ? 70 : 0);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v * 0.96;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Chain-link mesh with a transparent background (tile = 1 m × 1 m). */
export function chainlinkTexture(): THREE.Texture {
  const S = 64;
  const [c, g] = canvas(S, S);
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(150,152,148,1)';
  g.lineWidth = 1.6;
  const n = 8;
  for (let k = -n; k <= 2 * n; k++) {
    const o = (k * S) / n;
    g.beginPath();
    g.moveTo(o, 0);
    g.lineTo(o + S, S);
    g.stroke();
    g.beginPath();
    g.moveTo(o + S, 0);
    g.lineTo(o, S);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Billowing smoke puffs, four variants in a 2×2 atlas. Each is a cluster of
 * overlapping round billows roughened with noise: RGB holds the surface
 * normal (x right, y up, z toward the viewer, 0..1) for lighting, A the
 * density. Kept as raw data so the colour isn't premultiplied away at the
 * thin edges.
 */
export function smokeAtlasTexture(): THREE.Texture {
  const C = 256;
  const S = C * 2;
  const data = new Uint8Array(S * S * 4);
  const n = new Noise2D(4177);
  let seed = 91;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const h = new Float32Array(C * C);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * C;
    const oy = Math.floor(cell / 2) * C;
    // Billows: [x, y, z, r] in cell units (-1..1).
    const bl: number[][] = [[0, -0.05, 0, 0.5]];
    const count = 7 + cell * 2;
    for (let k = 0; k < count; k++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.12 + rnd() * 0.24;
      const d = rnd() * (0.9 - r) * 0.85;
      bl.push([Math.cos(a) * d, Math.sin(a) * d, (rnd() - 0.5) * 0.2, r]);
    }
    for (let y = 0; y < C; y++)
      for (let x = 0; x < C; x++) {
        const px = (x + 0.5) / C * 2 - 1;
        const py = (y + 0.5) / C * 2 - 1;
        let top = 0;
        for (const [bx, by, bz, br] of bl) {
          const d2 = (px - bx) ** 2 + (py - by) ** 2;
          if (d2 < br * br) top = Math.max(top, bz + Math.sqrt(br * br - d2));
        }
        const rr = Math.hypot(px, py);
        const edge = Math.max(0, Math.min(1, (0.98 - rr) / 0.18));
        const nz = n.fbm(px * 3.1 + cell * 7, py * 3.1, 4) * 0.5 + n.fbm(px * 9 + cell * 3, py * 9, 2) * 0.18;
        h[y * C + x] = Math.max(0, top * (1 + nz * 0.55)) * edge;
      }
    for (let y = 0; y < C; y++)
      for (let x = 0; x < C; x++) {
        const v = h[y * C + x];
        const hx = h[y * C + Math.min(C - 1, x + 1)] - h[y * C + Math.max(0, x - 1)];
        const hy = h[Math.min(C - 1, y + 1) * C + x] - h[Math.max(0, y - 1) * C + x];
        // Gradient over 2 px in cell units: 2 / (C/2).
        const s = C / 4;
        let nx = -hx * s;
        let ny = -hy * s;
        let nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        const a = Math.min(1, Math.pow(Math.min(1, v / 0.42), 0.8));
        const i = ((oy + y) * S + ox + x) * 4;
        data[i] = (nx * 0.5 + 0.5) * 255;
        data[i + 1] = (ny * 0.5 + 0.5) * 255;
        data[i + 2] = (nz * 0.5 + 0.5) * 255;
        data[i + 3] = a * 255;
      }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable 3D cloud noise (64³): R is Perlin-Worley (soft value noise carved
 * by inverted cellular noise: the billowy shape of cumulus), G a higher
 * frequency cellular fbm for eroding the edges into wisps.
 */
export function cloudNoiseTexture(): THREE.Data3DTexture {
  const S = 64;
  const data = new Uint8Array(S * S * S * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Value-noise lattices with wrap-around for each period.
  const lattice = (P: number) => {
    const a = new Float32Array(P * P * P);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return a;
  };
  const value = (lat: Float32Array, P: number, x: number, y: number, z: number) => {
    const fx = x * P;
    const fy = y * P;
    const fz = z * P;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const sz = tz * tz * (3 - 2 * tz);
    const at = (i: number, j: number, k: number) => lat[(((k % P) + P) % P) * P * P + (((j % P) + P) % P) * P + (((i % P) + P) % P)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(at(ix, iy, iz), at(ix + 1, iy, iz), sx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), sx), sy),
      l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), sx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), sx), sy),
      sz,
    );
  };
  const points = (F: number) => {
    const a = new Float32Array(F * F * F * 3);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return a;
  };
  /** 1 at a feature point, falling to 0 a cell away (wrapping). */
  const worley = (pts: Float32Array, F: number, x: number, y: number, z: number) => {
    const fx = x * F;
    const fy = y * F;
    const fz = z * F;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const cz = Math.floor(fz);
    let best = 9;
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const X = cx + i;
          const Y = cy + j;
          const Z = cz + k;
          const w = ((((Z % F) + F) % F) * F * F + (((Y % F) + F) % F) * F + (((X % F) + F) % F)) * 3;
          const dx = X + pts[w] - fx;
          const dy = Y + pts[w + 1] - fy;
          const dz = Z + pts[w + 2] - fz;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) best = d;
        }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const L = [4, 8, 16, 32].map((P) => [lattice(P), P] as const);
  const W = [4, 8, 16, 32].map((F) => [points(F), F] as const);
  for (let z = 0; z < S; z++)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const w = z / S;
        const perlin = value(L[0][0], 4, u, v, w) * 0.55 + value(L[1][0], 8, u, v, w) * 0.28 + value(L[2][0], 16, u, v, w) * 0.17;
        const wLow = worley(W[0][0], 4, u, v, w) * 0.625 + worley(W[1][0], 8, u, v, w) * 0.25 + worley(W[2][0], 16, u, v, w) * 0.125;
        // Perlin-Worley: remap the soft noise with the cellular as its floor.
        const pw = Math.max(0, Math.min(1, (perlin - (wLow - 1)) / (1 - (wLow - 1)) - 0.25) / 0.75);
        const wHigh = worley(W[1][0], 8, u, v, w) * 0.5 + worley(W[2][0], 16, u, v, w) * 0.3 + worley(W[3][0], 32, u, v, w) * 0.2;
        const i = (z * S * S + y * S + x) * 2;
        data[i] = Math.max(0, Math.min(255, pw * 255));
        data[i + 1] = Math.max(0, Math.min(255, wHigh * 255));
      }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGFormat;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
