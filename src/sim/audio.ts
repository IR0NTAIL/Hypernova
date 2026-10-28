import { ElementSymbol } from './constants';

/**
 * Light, Soothing Ambient Web Audio Synthesizer for Hypernova.
 * Uses pure sine harmonics, gentle low-pass filtering, soft attacks,
 * and a delicate stereo delay tail inspired by ambient space music.
 */
class CosmicAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private muted = false;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        this.ctx = ctx;

        // Master output with gentle ceiling
        const master = ctx.createGain();
        master.gain.value = 0.65;
        master.connect(ctx.destination);
        this.masterGain = master;

        // Soft ambient delay/reverb network for airy tail
        const delayA = ctx.createDelay(1.0);
        const delayB = ctx.createDelay(1.0);
        delayA.delayTime.value = 0.28;
        delayB.delayTime.value = 0.43;

        const fbA = ctx.createGain();
        const fbB = ctx.createGain();
        fbA.gain.value = 0.28;
        fbB.gain.value = 0.24;

        const dampFilter = ctx.createBiquadFilter();
        dampFilter.type = 'lowpass';
        dampFilter.frequency.value = 1100;

        const send = ctx.createGain();
        send.gain.value = 0.35;

        send.connect(dampFilter);
        dampFilter.connect(delayA);
        delayA.connect(fbA);
        fbA.connect(delayB);
        delayB.connect(fbB);
        fbB.connect(dampFilter);

        delayA.connect(master);
        delayB.connect(master);
        this.reverbSend = send;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.65, this.ctx.currentTime, 0.05);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  /**
   * Soft, weightless glass-harp pentatonic chime when placing an element cluster.
   */
  public playSpawnCluster(element: ElementSymbol, scale = 1): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    // Serene Lydian/Pentatonic frequencies (C4 - E5 range, warm and unhurried)
    const freqMap: Record<ElementSymbol, number> = {
      H: 523.25, // C5 — pure, light airy tone
      He: 493.88, // B4 — gentle major-7th shimmer
      C: 440.0, // A4 — warm pastoral sixth
      O: 392.0, // G4 — calm open fifth
      Si: 329.63, // E4 — soft major third
      Fe: 293.66, // D4 — tranquil resonant root/ninth
    };

    const baseFreq = freqMap[element] || 440;

    const osc = ctx.createOscillator();
    const harmonicOsc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    // Pure sine waves only — zero harshness
    osc.type = 'sine';
    harmonicOsc.type = 'sine';

    osc.frequency.setValueAtTime(baseFreq, now);
    // Subtle 2nd-harmonic airy overtone at very low level
    harmonicOsc.frequency.setValueAtTime(baseFreq * 1.5, now);

    const harmonicGain = ctx.createGain();
    harmonicGain.gain.setValueAtTime(0.18, now);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1200, now);

    const peakGain = Math.min(0.045, 0.028 * Math.pow(scale, 0.15));
    env.gain.setValueAtTime(0.0001, now);
    // Soft 80ms fade-in so there is never a percussive click
    env.gain.linearRampToValueAtTime(peakGain, now + 0.08);
    // Long, soothing 1.3s exponential release
    env.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);

    osc.connect(filter);
    harmonicOsc.connect(harmonicGain);
    harmonicGain.connect(filter);
    filter.connect(env);

    env.connect(this.masterGain);
    if (this.reverbSend) {
      env.connect(this.reverbSend);
    }

    osc.start(now);
    harmonicOsc.start(now);
    osc.stop(now + 1.4);
    harmonicOsc.stop(now + 1.4);
  }

  /**
   * Warm, meditative ambient pad swell when a star ignites.
   */
  public playStarIgnition(massSolar: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const rootFreq = Math.max(174.61, Math.min(261.63, 220 / Math.pow(massSolar, 0.15)));
    // Soothing major-add9 voicing (Root, Major 3rd, Perfect 5th, Major 9th)
    const ratios = [1, 1.25, 1.5, 2.25];

    ratios.forEach((r, idx) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(rootFreq * r, now);

      const voiceGain = 0.018 / (1 + idx * 0.45);
      env.gain.setValueAtTime(0.0001, now);
      // Slow, breathing 0.45s swell
      env.gain.linearRampToValueAtTime(voiceGain, now + 0.45);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);

      osc.connect(env);
      env.connect(this.masterGain!);
      if (this.reverbSend) {
        env.connect(this.reverbSend);
      }

      osc.start(now);
      osc.stop(now + 2.5);
    });
  }

  /**
   * Serene, deep singing-bowl harmonic bloom when a supernova or remnant forms
   * (replaces harsh sawtooth bass with warm, low-passed sine chords).
   */
  public playSupernova(isBlackHole: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const base = isBlackHole ? 130.81 : 146.83; // C3 or D3 warm fundamental
    const chord = [base, base * 1.5, base * 2.0, base * 2.5];

    chord.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const env = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.96, now + 2.8);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, now);

      const voiceGain = 0.022 / (1 + idx * 0.4);
      env.gain.setValueAtTime(0.0001, now);
      // Gentle 0.3s bloom
      env.gain.linearRampToValueAtTime(voiceGain, now + 0.32);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 2.8);

      osc.connect(filter);
      filter.connect(env);
      env.connect(this.masterGain!);
      if (this.reverbSend) {
        env.connect(this.reverbSend);
      }

      osc.start(now);
      osc.stop(now + 2.9);
    });
  }
}

export const cosmicAudio = new CosmicAudioEngine();
