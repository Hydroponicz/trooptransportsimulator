import { clamp } from './util/math';

export interface AudioParams {
  rpm: number;
  collective: number;
  airspeed: number;
  engine: number;
  inside: boolean;
  vrs: number;
  rampMoving: boolean;
  distance: number;
}

/** All sound is synthesized with WebAudio; no assets required. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private tone!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private rotors: { amp: GainNode; lfo: OscillatorNode; depth: GainNode; filter: BiquadFilterNode }[] = [];
  private body!: { amp: GainNode; lfo: OscillatorNode; depth: GainNode };
  private whine!: { osc: OscillatorNode; rush: GainNode; rushFilter: BiquadFilterNode; gain: GainNode };
  private wind!: { gain: GainNode; filter: BiquadFilterNode };
  private hyd!: { gain: GainNode };
  private missileWarn: { osc: OscillatorNode; gain: GainNode } | null = null;
  private warnT = 0;
  volume = 0.8;

  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 9000;
    this.tone.connect(this.master);
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Narrow pulse train = one blade passing.
    const N = 40;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 1; n < N; n++) real[n] = Math.sin(n * Math.PI * 0.12) / n;
    const pulse = ctx.createPeriodicWave(real, imag);

    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(0, Math.random() * 1.5);
      return s;
    };

    // Two rotors, slightly detuned so their slaps drift in and out of phase.
    for (let i = 0; i < 2; i++) {
      const src = noise();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = i ? 210 : 160;
      filter.Q.value = 0.9;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.setPeriodicWave(pulse);
      lfo.frequency.value = 0.01;
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth).connect(amp.gain);
      lfo.start();
      src.connect(filter).connect(amp).connect(this.tone);
      this.rotors.push({ amp, lfo, depth, filter });
    }
    // Low body thump.
    {
      const src = noise();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 110;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.setPeriodicWave(pulse);
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth).connect(amp.gain);
      lfo.start();
      src.connect(f).connect(amp).connect(this.tone);
      this.body = { amp, lfo, depth };
    }
    // Turbines: a low, filtered rumble plus a soft band of air rush.
    // (No pure high tones — a steady sine up in the kHz range is fatiguing.)
    {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      lp.Q.value = 0.3;
      const rush = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 0.4;
      const rushGain = ctx.createGain();
      rushGain.gain.value = 0;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(lp).connect(gain).connect(this.tone);
      rush.connect(bp).connect(rushGain).connect(this.tone);
      osc.start();
      this.whine = { osc, rush: rushGain, rushFilter: bp, gain };
    }
    // Wind.
    {
      const src = noise();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      this.wind = { gain, filter };
    }
    // Ramp hydraulics.
    {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 68;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 300;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(f).connect(gain).connect(this.tone);
      osc.start();
      this.hyd = { gain };
    }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  update(p: AudioParams, dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const smooth = 0.08;
    const att = clamp(1 / (1 + Math.max(0, p.distance - 30) / 60), 0.05, 1);
    const bladeHz = 11.25 * p.rpm;
    const load = clamp(p.collective, 0, 1);
    const slap = (0.35 + 0.9 * load ** 1.4 + p.vrs * 0.8) * p.rpm;
    this.rotors.forEach((r, i) => {
      r.lfo.frequency.setTargetAtTime(Math.max(0.01, bladeHz * (i ? 1.004 : 1)), t, smooth);
      r.amp.gain.setTargetAtTime(0.1 * p.rpm * att, t, smooth);
      r.depth.gain.setTargetAtTime(0.32 * slap * att, t, smooth);
      r.filter.frequency.setTargetAtTime((i ? 200 : 150) + load * 120, t, smooth);
    });
    this.body.lfo.frequency.setTargetAtTime(Math.max(0.01, bladeHz), t, smooth);
    this.body.amp.gain.setTargetAtTime(0.25 * p.rpm * att, t, smooth);
    this.body.depth.gain.setTargetAtTime(0.9 * slap * att, t, smooth);
    this.whine.osc.frequency.setTargetAtTime(35 + 70 * p.engine, t, 0.3);
    this.whine.gain.gain.setTargetAtTime((0.02 + 0.012 * load) * p.engine * att, t, 0.2);
    this.whine.rushFilter.frequency.setTargetAtTime(400 + 700 * p.engine, t, 0.3);
    this.whine.rush.gain.setTargetAtTime(0.035 * p.engine * att, t, 0.2);
    this.wind.gain.gain.setTargetAtTime(clamp(p.airspeed / 80, 0, 1) ** 2 * (p.inside ? 0.12 : 0.35), t, 0.2);
    this.wind.filter.frequency.setTargetAtTime(300 + p.airspeed * 25, t, 0.2);
    this.hyd.gain.gain.setTargetAtTime(p.rampMoving ? 0.06 : 0, t, 0.1);
    this.tone.frequency.setTargetAtTime(p.inside ? 1400 : 9000, t, 0.1);
    this.warnT += dt;
  }

  private burst(opts: { delay?: number; dur: number; gain: number; type: BiquadFilterType; f0: number; f1?: number; q?: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.Q.value = opts.q ?? 0.7;
    f.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1) f.frequency.exponentialRampToValueAtTime(opts.f1, t0 + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t0, Math.random());
    s.stop(t0 + opts.dur + 0.05);
  }

  private beep(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** Distant booms arrive late: sound travels at 343 m/s. */
  explosion(distance: number, big = 1) {
    const g = clamp(1.4 / (1 + distance / 250), 0.02, 1.2) * big;
    const delay = Math.min(distance / 343, 8);
    this.burst({ delay, dur: 2.2, gain: g, type: 'lowpass', f0: distance > 800 ? 300 : 900, f1: 60 });
    this.burst({ delay, dur: 0.4, gain: g * 0.6, type: 'lowpass', f0: 2000, f1: 200 });
  }

  gunshot(distance: number, heavy: boolean) {
    const g = clamp(0.5 / (1 + distance / 150), 0.01, 0.4) * (heavy ? 1.5 : 1);
    this.burst({ delay: Math.min(distance / 343, 6), dur: heavy ? 0.18 : 0.08, gain: g, type: 'bandpass', f0: heavy ? 500 : 1400, q: 0.8 });
  }

  hit() {
    this.beep(900 + Math.random() * 300, 0.1, 0.1, 'triangle');
    this.burst({ dur: 0.1, gain: 0.25, type: 'bandpass', f0: 1500, q: 0.7 });
  }

  clunk() {
    this.burst({ dur: 0.25, gain: 0.5, type: 'lowpass', f0: 400, f1: 80 });
    this.beep(140, 0.2, 0.3, 'square');
  }

  thud(strength: number) {
    this.burst({ dur: 0.35, gain: clamp(strength, 0.1, 1.2), type: 'lowpass', f0: 300, f1: 50 });
  }

  /** Squelch break + crackle when a radio call comes in. */
  radio() {
    this.burst({ dur: 0.12, gain: 0.18, type: 'bandpass', f0: 2200, q: 1.5 });
    this.beep(1000, 0.06, 0.04, 'sine', 0.02);
    this.burst({ delay: 0.12, dur: 0.5, gain: 0.05, type: 'bandpass', f0: 1800, q: 2 });
  }

  click() {
    this.beep(700, 0.04, 0.06, 'sine');
  }

  beepOk() {
    this.beep(880, 0.12, 0.15);
    this.beep(1320, 0.18, 0.15, 'sine', 0.1);
  }

  cash() {
    this.beep(1318, 0.12, 0.2, 'triangle');
    this.beep(1760, 0.35, 0.22, 'triangle', 0.09);
    this.burst({ delay: 0.02, dur: 0.12, gain: 0.12, type: 'bandpass', f0: 2500, q: 0.7 });
  }

  warning() {
    if (this.warnT < 0.6) return;
    this.warnT = 0;
    this.beep(620, 0.18, 0.08, 'triangle');
    this.beep(480, 0.18, 0.08, 'triangle', 0.22);
  }

  flare() {
    this.burst({ dur: 0.3, gain: 0.3, type: 'bandpass', f0: 3000, f1: 800 });
  }

  setMissileWarning(on: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (on && !this.missileWarn) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 820;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 7;
      const lg = ctx.createGain();
      lg.gain.value = 0.035;
      lfo.connect(lg).connect(gain.gain);
      osc.connect(gain).connect(this.master);
      osc.start();
      lfo.start();
      this.missileWarn = { osc, gain };
    } else if (!on && this.missileWarn) {
      this.missileWarn.osc.stop();
      this.missileWarn.gain.disconnect();
      this.missileWarn = null;
    }
  }
}
