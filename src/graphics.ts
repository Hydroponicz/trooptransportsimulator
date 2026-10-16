/** Graphics quality presets, the saved choice, and a guess at what the GPU can manage. */

export type Quality = 'high' | 'medium' | 'low';
export type GraphicsSetting = 'auto' | Quality;

export interface Profile {
  /** Cap on the device pixel ratio the scene renders at. */
  pixelRatio: number;
  antialias: boolean;
  shadowMap: number;
  /** Soft (PCF soft) or plain PCF shadow edges. */
  softShadows: boolean;
  /** Half-width of the sun's shadow box round the player, metres. */
  shadowBox: number;
  /** Trees and buildings within this distance of the shadow box centre cast shadows. */
  casterRadius: number;
  grassRange: number;
  grassDensity: number;
  /** 0 hides crop plants (the ground shader's rows still show the fields). */
  cropRange: number;
  /** Scale on the distance where trees and buildings swap to their far stand-ins. */
  lodScale: number;
  /** Scale on how far small props (posts, crates, barrels...) stay drawn. */
  clutterScale: number;
  /** Scale on how far buildings, forests and roadside stay drawn. */
  farScale: number;
  /** Scale on smoke emission and how far from the camera smoke flows round buildings. */
  smoke: number;
  /** Steps marched through the cloud layer per sky texel (0 = flat painted clouds). */
  cloudSteps: number;
}

export const PROFILES: Record<Quality, Profile> = {
  high: {
    pixelRatio: 1.5,
    antialias: true,
    shadowMap: 2048,
    softShadows: true,
    shadowBox: 90,
    casterRadius: 170,
    grassRange: 120,
    grassDensity: 1,
    cropRange: 110,
    lodScale: 1,
    clutterScale: 1,
    farScale: 1,
    smoke: 1,
    cloudSteps: 48,
  },
  medium: {
    pixelRatio: 1,
    antialias: true,
    shadowMap: 1024,
    softShadows: false,
    shadowBox: 70,
    casterRadius: 120,
    grassRange: 85,
    grassDensity: 0.6,
    cropRange: 70,
    lodScale: 0.6,
    clutterScale: 0.7,
    farScale: 0.85,
    smoke: 0.75,
    cloudSteps: 28,
  },
  low: {
    pixelRatio: 0.75,
    antialias: false,
    shadowMap: 1024,
    softShadows: false,
    shadowBox: 35,
    // Only the aircraft, vehicles and people cast.
    casterRadius: 0,
    grassRange: 60,
    grassDensity: 0.35,
    cropRange: 0,
    lodScale: 0.38,
    clutterScale: 0.5,
    farScale: 0.7,
    smoke: 0.5,
    cloudSteps: 0,
  },
};

const KEY = 'tts.graphics';

export function loadSetting(): GraphicsSetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'auto' || v === 'high' || v === 'medium' || v === 'low') return v;
  } catch {
    // Storage blocked: use the default.
  }
  return 'auto';
}

export function saveSetting(s: GraphicsSetting) {
  try {
    localStorage.setItem(KEY, s);
  } catch {
    // Not saved; it still applies for this session.
  }
}

let gpuName: string | null = null;

/** The GPU's name as WebGL reports it ('' if hidden). */
export function gpu(): string {
  if (gpuName !== null) return gpuName;
  gpuName = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // No WebGL info: treat as unknown.
  }
  return gpuName;
}

/** A starting preset for this machine: integrated and software GPUs start lower. */
export function detectQuality(): Quality {
  const g = gpu().toLowerCase();
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 'low';
  if (mobile || /mali|adreno|powervr|apple gpu|videocore/.test(g)) return 'low';
  if (/nvidia|geforce|quadro|rtx|gtx/.test(g)) return 'high';
  if (/intel/.test(g)) {
    if (/\barc\b/.test(g) && !/arc\(tm\) graphics|arc graphics/.test(g)) return 'high';
    if (/iris.*xe|xe graphics|arc\(tm\) graphics|arc graphics/.test(g)) return 'medium';
    return 'low';
  }
  if (/amd|radeon|ati /.test(g)) {
    // "AMD Radeon(TM) Graphics", "Radeon Vega 8": the integrated parts in Ryzen laptops.
    if (/vega|radeon\(tm\) graphics|radeon graphics|\d{3}m\b/.test(g)) return 'medium';
    return 'high';
  }
  if (/apple m\d/.test(g)) return 'medium';
  return 'medium';
}

export const resolve = (s: GraphicsSetting): Quality => (s === 'auto' ? detectQuality() : s);

const LOWER: Record<Quality, Quality | null> = { high: 'medium', medium: 'low', low: null };

/**
 * Auto mode at runtime: watches the frame rate and lowers the render
 * resolution (down to 70%) when it sags, raising it again when there is
 * headroom; if it is still slow at the lowest resolution, steps the preset
 * down one level.
 */
export class AutoScaler {
  scale = 1;
  private acc = 0;
  private frames = 0;
  private slowAtMin = 0;
  private goodFor = 0;

  /**
   * Feed each frame's real time (seconds). Returns 'scale' when the
   * resolution should change, 'lower' when the preset should drop, else null.
   */
  sample(dt: number): 'scale' | 'lower' | null {
    // Stalls (tab switch, loading) say nothing about rendering speed.
    if (dt <= 0 || dt > 0.25) return null;
    this.acc += dt;
    this.frames++;
    if (this.acc < 2) return null;
    const fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    if (fps < 45) {
      this.goodFor = 0;
      if (this.scale > 0.7) {
        this.scale = Math.max(0.7, Math.round((this.scale - 0.1) * 100) / 100);
        return 'scale';
      }
      if (fps < 35 && ++this.slowAtMin >= 3) {
        this.slowAtMin = 0;
        return 'lower';
      }
      return null;
    }
    this.slowAtMin = 0;
    if (fps > 57 && this.scale < 1 && ++this.goodFor >= 3) {
      this.goodFor = 0;
      this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
      return 'scale';
    }
    return null;
  }

  reset() {
    this.scale = 1;
    this.acc = this.frames = this.slowAtMin = this.goodFor = 0;
  }
}

export const lower = (q: Quality) => LOWER[q];
