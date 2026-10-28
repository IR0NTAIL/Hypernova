/**
 * Deterministic Seeded Pseudo-Random Number Generator (Mulberry32 + FNV-1a string hash).
 * Spec Rule: The only random inputs are the spawn position, initial direction, and initial speed
 * of each cluster. After that, everything is deterministic physics.
 */
export class SeededRNG {
  private state: number;
  private initialSeedString: string;

  constructor(seed: string | number = 'HYPERNOVA-2026') {
    this.initialSeedString = String(seed);
    this.state = SeededRNG.hashSeed(this.initialSeedString);
  }

  public static hashSeed(seed: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0 || 0x6d2b79f5;
  }

  public setSeed(seed: string | number): void {
    this.initialSeedString = String(seed);
    this.state = SeededRNG.hashSeed(this.initialSeedString);
  }

  public getSeedString(): string {
    return this.initialSeedString;
  }

  public getState(): number {
    return this.state;
  }

  public setState(state: number): void {
    this.state = state >>> 0;
  }

  /** Returns a deterministic float in [0, 1) */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns a deterministic float in [min, max) */
  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Returns a deterministic integer in [min, max] inclusive */
  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Returns a deterministic point inside a 3D unit sphere */
  public insideUnitSphere(): { x: number; y: number; z: number } {
    const theta = this.range(0, Math.PI * 2);
    const u = this.range(-1, 1);
    const r = Math.cbrt(this.next());
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    return {
      x: r * s * Math.cos(theta),
      y: r * u,
      z: r * s * Math.sin(theta),
    };
  }

  /** Returns a deterministic unit direction vector on the 3D sphere */
  public unitDirection(): { x: number; y: number; z: number } {
    const theta = this.range(0, Math.PI * 2);
    const u = this.range(-1, 1);
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    return {
      x: s * Math.cos(theta),
      y: u,
      z: s * Math.sin(theta),
    };
  }
}
