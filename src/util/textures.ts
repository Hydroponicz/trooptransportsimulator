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
