import {
  BodyClass,
  Composition,
  computeGravityCutoffRadius,
  computeSchwarzschildRadius,
  ElementSymbol,
  ELEMENTS,
  ELEMENT_ORDER,
  FusionStage,
  MASS_THRESHOLDS,
  MatterPhase,
  SIM_UNITS,
  TEMP_THRESHOLDS,
} from './constants';
import { SeededRNG } from './rng';
import { SpatialHashGrid } from './spatialHash';
import { cosmicAudio } from './audio';

export interface SimParticle {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  mass: number; // In M☉_sim
  temperature: number; // Kelvin
  density: number; // Local mass density
  phase: MatterPhase;
  composition: Composition;
  cutoffRadius: number;
  age: number;
  alive: boolean;
}

export interface CelestialBody {
  id: number;
  name: string;
  type: BodyClass;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  spinX: number; // Angular momentum vector L
  spinY: number;
  spinZ: number;
  mass: number; // Current mass in M☉_sim
  peakMass: number; // Peak progenitor mass in M☉_sim
  radius: number; // Visual/physical radius in sim units
  cutoffRadius: number; // Range-limited gravity reach
  temperature: number; // Surface / effective blackbody temperature (K)
  coreTemperature: number; // Core temperature driving fusion (K)
  luminosity: number; // Scaled L/L☉
  jeansRatio: number; // Ratio M / M_Jeans (>1 means gravitationally bound/collapsing)
  phase: MatterPhase;
  fusionStage: FusionStage;
  composition: Composition;
  accretionDiskMass: number;
  accretionDiskRadius: number;
  age: number;
  alive: boolean;
}

export interface SupernovaShockwave {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  maxRadius: number;
  speed: number;
  colorHex: string;
  isSupernova: boolean; // true = Supernova, false = Planetary Nebula
  age: number;
  maxAge: number;
}

export interface CosmicEventLog {
  id: number;
  timeMyr: number;
  title: string;
  detail: string;
  category: 'star' | 'supernova' | 'black_hole' | 'remnant' | 'planet';
  bodyId?: number;
  x: number;
  y: number;
  z: number;
}

export interface RecordedSpawnAction {
  step: number;
  element: ElementSymbol;
  clusterMultiplier: number;
}

export function createEmptyComposition(): Composition {
  return { H: 0, He: 0, C: 0, O: 0, Si: 0, Fe: 0 };
}

export function normalizeComposition(comp: Composition): Composition {
  const sum = comp.H + comp.He + comp.C + comp.O + comp.Si + comp.Fe;
  if (sum <= 1e-9) {
    return { H: 1, He: 0, C: 0, O: 0, Si: 0, Fe: 0 };
  }
  const inv = 1.0 / sum;
  comp.H *= inv;
  comp.He *= inv;
  comp.C *= inv;
  comp.O *= inv;
  comp.Si *= inv;
  comp.Fe *= inv;
  return comp;
}

export function computeMeanMolecularWeight(comp: Composition, phase: MatterPhase): number {
  // Ionized plasma has free electrons, halving mean molecular weight; cold H2 doubles H mass
  const hWeight = phase === 'molecular_h2' ? 2.016 : phase === 'plasma' ? 0.5 : 1.008;
  const invMu =
    comp.H / hWeight +
    comp.He / 4.0 +
    comp.C / 12.0 +
    comp.O / 16.0 +
    comp.Si / 28.0 +
    comp.Fe / 56.0;
  return invMu > 0 ? 1.0 / invMu : 1.0;
}

export class SpaceSimulation {
  public rng: SeededRNG;
  public particles: SimParticle[] = [];
  public bodies: CelestialBody[] = [];
  public shockwaves: SupernovaShockwave[] = [];
  public events: CosmicEventLog[] = [];
  public recordedActions: RecordedSpawnAction[] = [];

  public stepCount = 0;
  public simTimeMyr = 0; // Simulated time in Millions of Years
  public timeScale = 1; // 0 (Pause), 1, 5, 20, 100
  public clusterMultiplier = 1; // 1x (Standard cluster), 4x (Dense cloud), 12x (Giant molecular cloud)

  private nextEntityId = 1;
  private nextBodyNumber = 1;
  private spatialGrid = new SpatialHashGrid(12.0);
  private neighborScratch: number[] = [];

  constructor(seed = 'HYPERNOVA-2026') {
    this.rng = new SeededRNG(seed);
  }

  public reset(newSeed?: string): void {
    const seedToUse = newSeed !== undefined ? newSeed : this.rng.getSeedString();
    this.rng.setSeed(seedToUse);
    this.particles = [];
    this.bodies = [];
    this.shockwaves = [];
    this.events = [];
    this.recordedActions = [];
    this.stepCount = 0;
    this.simTimeMyr = 0;
    this.nextEntityId = 1;
    this.nextBodyNumber = 1;
  }

  /**
   * Spec Section 3: Clicking an element button places a cluster (5 to 12 particles)
   * with a tight random spread, random position within the visible volume, and
   * very low random velocity scaled to gravity so clusters naturally meet.
   *
   * Rule: The ONLY random inputs are spawn position, initial direction, and initial speed
   * drawn deterministically from this.rng.
   */
  public spawnElementCluster(
    element: ElementSymbol,
    overrideMultiplier?: number,
    recordAction = true
  ): void {
    const spec = ELEMENTS[element];
    const mult = overrideMultiplier ?? this.clusterMultiplier;

    if (recordAction) {
      this.recordedActions.push({
        step: this.stepCount,
        element,
        clusterMultiplier: mult,
      });
    }

    // Enforce particle cap cleanly before adding new particles
    if (this.particles.length > SIM_UNITS.MAX_PARTICLES - 20) {
      this.compactLowMassParticles();
    }

    // Cluster size: 6 to 12 particles deterministically from RNG
    const count = this.rng.int(6, 12);

    // Compute current center of mass of existing system (if any) so new clusters are placed
    // within gravitational reach of the active cosmic nursery
    let comX = 0;
    let comY = 0;
    let comZ = 0;
    let totalMass = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      comX += b.x * b.mass;
      comY += b.y * b.mass;
      comZ += b.z * b.mass;
      totalMass += b.mass;
    }
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      comX += p.x * p.mass;
      comY += p.y * p.mass;
      comZ += p.z * p.mass;
      totalMass += p.mass;
    }
    if (totalMass > 0) {
      comX /= totalMass;
      comY /= totalMass;
      comZ /= totalMass;
    }

    // Spawn cluster center within visible volume (radius ~14 units around origin/COM)
    // so neighboring clusters are within range-limited gravity cutoff (~20-35 units)
    const posOffset = this.rng.insideUnitSphere();
    const spawnRadius = totalMass > 0 ? 11.5 : 8.5;
    const clusterX = comX * 0.55 + posOffset.x * spawnRadius;
    const clusterY = comY * 0.55 + posOffset.y * (spawnRadius * 0.45); // Slightly flatter galactic plane
    const clusterZ = comZ * 0.55 + posOffset.z * spawnRadius;

    // Random initial direction and very low initial drift speed scaled to G_SIM
    const randDir = this.rng.unitDirection();
    const baseSpeed = this.rng.range(0.35, 0.95);

    // Subtle inward + tangential drift so drifting clusters meet and conserve angular momentum
    const toCenterX = comX - clusterX;
    const toCenterY = comY - clusterY;
    const toCenterZ = comZ - clusterZ;
    const distToCenter = Math.hypot(toCenterX, toCenterY, toCenterZ) || 1;
    const inwardX = toCenterX / distToCenter;
    const inwardY = toCenterY / distToCenter;
    const inwardZ = toCenterZ / distToCenter;

    // Tangential vector (cross product with +Y)
    const tangX = -inwardZ;
    const tangZ = inwardX;

    const clusterVx =
      randDir.x * baseSpeed * 0.45 + inwardX * baseSpeed * 0.4 + tangX * baseSpeed * 0.35;
    const clusterVy = randDir.y * baseSpeed * 0.3 + inwardY * baseSpeed * 0.3;
    const clusterVz =
      randDir.z * baseSpeed * 0.45 + inwardZ * baseSpeed * 0.4 + tangZ * baseSpeed * 0.35;

    // Gases (H, He) spawn as diffuse clusters; heavier elements (C, O, Si, Fe) as denser clumps
    const spread = spec.clusterSpread * (1 + Math.log10(Math.max(1, mult)) * 0.25);
    const parcelMass = spec.baseParcelMassSim * mult;

    for (let i = 0; i < count; i++) {
      const localPos = this.rng.insideUnitSphere();
      const localVel = this.rng.insideUnitSphere();
      const px = clusterX + localPos.x * spread;
      const py = clusterY + localPos.y * spread * 0.7;
      const pz = clusterZ + localPos.z * spread;

      // Internal thermal/turbulent micro-velocity + gentle cluster spin
      const relX = px - clusterX;
      const relZ = pz - clusterZ;
      const spinSpeed = 0.14;

      const comp = createEmptyComposition();
      comp[element] = 1.0;

      const temp = spec.defaultTempK * this.rng.range(0.9, 1.12);
      const phase = this.determineParticlePhase(comp, temp);
      const pMass = parcelMass * this.rng.range(0.85, 1.15);

      this.particles.push({
        id: this.nextEntityId++,
        x: px,
        y: py,
        z: pz,
        vx: clusterVx + localVel.x * 0.18 - relZ * spinSpeed,
        vy: clusterVy + localVel.y * 0.12,
        vz: clusterVz + localVel.z * 0.18 + relX * spinSpeed,
        ax: 0,
        ay: 0,
        az: 0,
        mass: pMass,
        temperature: temp,
        density: pMass / ((4 / 3) * Math.PI * Math.pow(spread, 3)),
        phase,
        composition: comp,
        cutoffRadius: computeGravityCutoffRadius(pMass),
        age: 0,
        alive: true,
      });
    }

    cosmicAudio.playSpawnCluster(element, mult);
  }

  /**
   * Chemistry & Ionization rules (Spec 5.4):
   * - Cold hydrogen bonds into H₂ (< 2400 K)
   * - Very hot gas ionizes into plasma (> 15,800 K, ~13.6 eV Boltzmann tail)
   * - Heavy elements (C, O, Si, Fe) below sublimation temperature form dust grains
   */
  public determineParticlePhase(comp: Composition, tempK: number): MatterPhase {
    if (tempK >= TEMP_THRESHOLDS.HYDROGEN_IONIZATION) {
      return 'plasma';
    }
    const heavyFraction = comp.C + comp.O + comp.Si + comp.Fe;
    if (heavyFraction > 0.45 && tempK < TEMP_THRESHOLDS.DUST_SUBLIMATION) {
      return 'dust';
    }
    if (comp.H > 0.6 && tempK < TEMP_THRESHOLDS.H2_MOLECULAR_MAX) {
      return 'molecular_h2';
    }
    return 'gas';
  }

  /**
   * Advances the physics simulation by one fixed timestep dt using Velocity Verlet / Leapfrog.
   */
  public stepPhysics(dt = SIM_UNITS.FIXED_DT): void {
    this.stepCount++;
    // 1 second of sim time at 1x corresponds to ~0.45 Myr of cosmic evolution
    this.simTimeMyr += dt * 0.45;

    const halfDt = 0.5 * dt;

    // 1. First half-step velocity kick & full position drift (Velocity Verlet)
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.alive) continue;
      b.vx += b.ax * halfDt;
      b.vy += b.ay * halfDt;
      b.vz += b.az * halfDt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.age += dt;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.vx += p.ax * halfDt;
      p.vy += p.ay * halfDt;
      p.vz += p.az * halfDt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.age += dt;
    }

    // 2. Compute new accelerations, thermodynamics, Jeans collapse, and accretion disks
    this.computeForcesAndThermodynamics(dt);

    // 3. Second half-step velocity kick
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.alive) continue;
      b.vx += b.ax * halfDt;
      b.vy += b.ay * halfDt;
      b.vz += b.az * halfDt;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.vx += p.ax * halfDt;
      p.vy += p.ay * halfDt;
      p.vz += p.az * halfDt;
    }

    // 4. Process body-body mergers, black hole horizon absorption, particle accretion, and condensation
    this.processMergersAndCondensation();

    // 5. Evolve stellar interiors: Fusion chain (H -> He -> C -> O -> Si -> Fe) & Stellar Death
    this.evolveStellarInteriors(dt);

    // 6. Update expanding supernova / planetary nebula shockwaves
    this.updateShockwaves(dt);

    // 7. Prune dead particles/bodies
    this.pruneDeadEntities();
  }

  private computeForcesAndThermodynamics(dt: number): void {
    const G = SIM_UNITS.G;
    const epsSq = SIM_UNITS.SOFTENING * SIM_UNITS.SOFTENING;

    // Reset accelerations
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      b.ax = 0;
      b.ay = 0;
      b.az = 0;
      b.accretionDiskMass = 0;
    }

    this.spatialGrid.clear();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.ax = 0;
      p.ay = 0;
      p.az = 0;
      p.density = p.mass * 0.08;
      this.spatialGrid.insert(i, p.x, p.y, p.z);
    }

    // A. Body-Body Newtonian Gravity (Range-limited by max(cutoff_i, cutoff_j))
    const nBodies = this.bodies.length;
    for (let i = 0; i < nBodies; i++) {
      const bi = this.bodies[i];
      if (!bi.alive) continue;
      for (let j = i + 1; j < nBodies; j++) {
        const bj = this.bodies[j];
        if (!bj.alive) continue;

        const dx = bj.x - bi.x;
        const dy = bj.y - bi.y;
        const dz = bj.z - bi.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const maxCutoff = Math.max(bi.cutoffRadius, bj.cutoffRadius);

        if (distSq < maxCutoff * maxCutoff) {
          const dist = Math.sqrt(distSq);
          // Smooth falloff near cutoff edge so forces are C1 continuous
          const cutoffRatio = dist / maxCutoff;
          const taper = 1.0 - cutoffRatio * cutoffRatio;
          const invR3 = (G * taper) / Math.pow(distSq + epsSq, 1.5);

          const fx = dx * invR3;
          const fy = dy * invR3;
          const fz = dz * invR3;

          bi.ax += fx * bj.mass;
          bi.ay += fy * bj.mass;
          bi.az += fz * bj.mass;

          bj.ax -= fx * bi.mass;
          bj.ay -= fy * bi.mass;
          bj.az -= fz * bi.mass;
        }
      }
    }

    // B. Body-Particle Gravity, Accretion Disk Flattening & Stellar Radiative Heating
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;

      for (let j = 0; j < nBodies; j++) {
        const b = this.bodies[j];
        if (!b.alive) continue;

        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const dz = b.z - p.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const cutoff = Math.max(b.cutoffRadius, p.cutoffRadius);

        if (distSq < cutoff * cutoff) {
          const dist = Math.sqrt(distSq) || 0.001;
          const cutoffRatio = dist / cutoff;
          const taper = 1.0 - cutoffRatio * cutoffRatio;
          const invR3 = (G * taper) / Math.pow(distSq + epsSq * 0.6, 1.5);

          const gx = dx * invR3;
          const gy = dy * invR3;
          const gz = dz * invR3;

          p.ax += gx * b.mass;
          p.ay += gy * b.mass;
          p.az += gz * b.mass;

          // Newton's 3rd law back-reaction onto the body
          b.ax -= gx * p.mass;
          b.ay -= gy * p.mass;
          b.az -= gz * p.mass;

          // Accretion disk flattening (Spec 5.3: Angular momentum is conserved;
          // collapsing clouds spin up and flatten into accretion disks around massive bodies)
          const diskZone = b.radius * 5.5;
          if (dist < diskZone && dist > b.radius * 1.05) {
            b.accretionDiskMass += p.mass;
            const spinMag = Math.hypot(b.spinX, b.spinY, b.spinZ);
            // Default spin axis is +Y if body has tiny initial spin
            const sx = spinMag > 1e-5 ? b.spinX / spinMag : 0;
            const sy = spinMag > 1e-5 ? b.spinY / spinMag : 1;
            const sz = spinMag > 1e-5 ? b.spinZ / spinMag : 0;

            // Project relative vector (p - b) onto spin axis
            const relX = -dx;
            const relY = -dy;
            const relZ = -dz;
            const heightAlongAxis = relX * sx + relY * sy + relZ * sz;
            const relVx = p.vx - b.vx;
            const relVy = p.vy - b.vy;
            const relVz = p.vz - b.vz;
            const velAlongAxis = relVx * sx + relVy * sy + relVz * sz;

            // Viscous settling toward the equatorial plane + gentle Keplerian spin alignment
            const settleForce = -heightAlongAxis * 2.4 - velAlongAxis * 1.8;
            p.ax += sx * settleForce;
            p.ay += sy * settleForce;
            p.az += sz * settleForce;
          }

          // Radiative heating from stars & remnants
          if (b.luminosity > 0.01) {
            const radFlux = (b.luminosity * 180.0) / (distSq + 2.0);
            p.temperature += radFlux * dt;
          }
        }
      }
    }

    // C. Particle-Particle Range-Limited Gravity, Ideal Gas Pressure, Compressive Heating & Cooling
    const queryRadius = 14.0;
    for (let i = 0; i < this.particles.length; i++) {
      const pi = this.particles[i];
      if (!pi.alive) continue;

      this.spatialGrid.queryRadius(pi.x, pi.y, pi.z, queryRadius, this.neighborScratch);
      let localVelocityDiv = 0;
      let localCloudMass = pi.mass;

      for (let k = 0; k < this.neighborScratch.length; k++) {
        const j = this.neighborScratch[k];
        if (j <= i) continue;
        const pj = this.particles[j];
        if (!pj.alive) continue;

        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const dz = pj.z - pi.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const maxCutoff = Math.min(queryRadius, Math.max(pi.cutoffRadius, pj.cutoffRadius));

        if (distSq < maxCutoff * maxCutoff && distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const cutoffRatio = dist / maxCutoff;
          const taper = 1.0 - cutoffRatio * cutoffRatio;

          // Newtonian attraction
          const gravMag = (G * taper) / (distSq + epsSq * 0.45);

          // Ideal gas thermal pressure resistance (Spec 5.3: Thermal pressure resists gravity;
          // cloud collapses only when mass exceeds Jeans mass)
          let pressureRepel = 0;
          if (dist < 2.8) {
            const meanTemp = 0.5 * (pi.temperature + pj.temperature);
            const mu = computeMeanMolecularWeight(pi.composition, pi.phase);
            // Jeans criterion check: cold or heavy-element dust has very low thermal pressure
            const soundSpeedSq = (SIM_UNITS.KB_OVER_MH * meanTemp) / mu;
            const overlap = 1.0 - dist / 2.8;
            pressureRepel = soundSpeedSq * overlap * 1.4;

            // Track local density & velocity convergence (compression heating PV = NkT)
            const kernel = overlap * overlap;
            pi.density += pj.mass * kernel;
            pj.density += pi.mass * kernel;
            localCloudMass += pj.mass;

            const dvx = pj.vx - pi.vx;
            const dvy = pj.vy - pi.vy;
            const dvz = pj.vz - pi.vz;
            const rDotV = (dx * dvx + dy * dvy + dz * dvz) / dist;
            if (rDotV < 0) {
              // Compressing gas heats up!
              localVelocityDiv += -rDotV * kernel;
              // Viscous inelastic damping in colliding gas/dust streams
              const damp = 0.35 * kernel;
              const dampFx = (dx / dist) * rDotV * damp;
              const dampFy = (dy / dist) * rDotV * damp;
              const dampFz = (dz / dist) * rDotV * damp;
              pi.ax += dampFx;
              pi.ay += dampFy;
              pi.az += dampFz;
              pj.ax -= dampFx;
              pj.ay -= dampFy;
              pj.az -= dampFz;
            }
          }

          const netForceOverDist = (gravMag - pressureRepel) / dist;
          const fx = dx * netForceOverDist;
          const fy = dy * netForceOverDist;
          const fz = dz * netForceOverDist;

          pi.ax += fx * pj.mass;
          pi.ay += fy * pj.mass;
          pi.az += fz * pj.mass;

          pj.ax -= fx * pi.mass;
          pj.ay -= fy * pi.mass;
          pj.az -= fz * pi.mass;
        }
      }

      // Apply adiabatic compression heating + radiative cooling (Spec 5.2)
      if (localVelocityDiv > 0) {
        const compressionHeat =
          localVelocityDiv * SIM_UNITS.COMPRESSIVE_HEATING_FACTOR * (1 + localCloudMass * 4.0) * dt;
        pi.temperature += compressionHeat;
      }

      // Radiative cooling allows clouds to shed thermal energy and collapse below Jeans threshold
      const cooling =
        SIM_UNITS.RADIATIVE_COOLING_RATE *
        (pi.temperature - TEMP_THRESHOLDS.CMB_FLOOR) *
        dt *
        (1.0 + (pi.composition.C + pi.composition.O) * 1.5); // Metal line cooling!
      pi.temperature = Math.max(TEMP_THRESHOLDS.CMB_FLOOR, pi.temperature - cooling);

      // Update chemical/ionization phase (H2 molecular vs atomic gas vs dust vs ionized plasma)
      pi.phase = this.determineParticlePhase(pi.composition, pi.temperature);
    }
  }

  /**
   * Handles:
   * 1. Black Hole Event Horizon absorption & Body-Particle accretion
   * 2. Body-Body gravitational mergers (conserving mass, momentum, angular momentum, energy)
   * 3. Jeans Mass instability condensation of dense particle clouds into CelestialBodies
   */
  private processMergersAndCondensation(): void {
    // 1. Body-Particle Accretion (including Black Hole Event Horizon capture)
    for (let j = 0; j < this.bodies.length; j++) {
      const b = this.bodies[j];
      if (!b.alive) continue;

      const captureRadius =
        b.type === 'black_hole'
          ? Math.max(b.radius * 1.35, computeSchwarzschildRadius(b.mass) * 1.25)
          : b.radius * 1.2;
      const captureSq = captureRadius * captureRadius;

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (!p.alive) continue;

        const dx = p.x - b.x;
        const dy = p.y - b.y;
        const dz = p.z - b.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq <= captureSq) {
          this.absorbParticleIntoBody(b, p);
        }
      }
    }

    // 2. Body-Body Mergers
    for (let i = 0; i < this.bodies.length; i++) {
      const bi = this.bodies[i];
      if (!bi.alive) continue;

      for (let j = i + 1; j < this.bodies.length; j++) {
        const bj = this.bodies[j];
        if (!bj.alive) continue;

        const dx = bj.x - bi.x;
        const dy = bj.y - bi.y;
        const dz = bj.z - bi.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const mergeDist = (bi.radius + bj.radius) * 0.85;

        if (distSq <= mergeDist * mergeDist) {
          // More massive body (or Black Hole / Neutron Star) absorbs the other
          const primaryFirst =
            bi.type === 'black_hole' ||
            (bj.type !== 'black_hole' && bi.mass >= bj.mass);
          if (primaryFirst) {
            this.mergeTwoBodies(bi, bj);
          } else {
            this.mergeTwoBodies(bj, bi);
            break;
          }
        }
      }
    }

    // 3. Jeans Collapse & Protoplanetary Condensation from Dense Bound Particle Clusters
    this.spatialGrid.clear();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.alive) {
        this.spatialGrid.insert(i, p.x, p.y, p.z);
      }
    }

    const condenseRadius = 2.15;
    for (let i = 0; i < this.particles.length; i++) {
      const seed = this.particles[i];
      if (!seed.alive) continue;

      this.spatialGrid.queryRadius(
        seed.x,
        seed.y,
        seed.z,
        condenseRadius,
        this.neighborScratch
      );

      if (this.neighborScratch.length < 4) continue;

      // Gather bound co-moving neighbors
      const clusterIndices: number[] = [];
      let totalMass = 0;
      let meanTemp = 0;
      for (let k = 0; k < this.neighborScratch.length; k++) {
        const idx = this.neighborScratch[k];
        const cand = this.particles[idx];
        if (!cand.alive) continue;
        const dx = cand.x - seed.x;
        const dy = cand.y - seed.y;
        const dz = cand.z - seed.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq <= condenseRadius * condenseRadius) {
          clusterIndices.push(idx);
          totalMass += cand.mass;
          meanTemp += cand.temperature * cand.mass;
        }
      }

      if (clusterIndices.length < 4 || totalMass < MASS_THRESHOLDS.MIN_PLANET) continue;
      meanTemp /= totalMass;

      // Compute Jeans Mass M_Jeans ∝ (T / mu)^(3/2) * rho^(-1/2)
      const mu = computeMeanMolecularWeight(seed.composition, seed.phase);
      const volume = (4 / 3) * Math.PI * Math.pow(condenseRadius, 3);
      const rho = totalMass / volume;
      const jeansMass =
        0.0022 *
        Math.pow(Math.max(10, meanTemp) / (150 * mu), 1.5) *
        Math.pow(Math.max(0.0001, rho), -0.5);

      const heavyFrac =
        seed.composition.C + seed.composition.O + seed.composition.Si + seed.composition.Fe;

      // Condense if cloud mass exceeds Jeans Mass OR if rocky dust grains coagulate
      if (totalMass >= jeansMass || (heavyFrac > 0.4 && clusterIndices.length >= 5)) {
        this.condenseParticlesIntoBody(clusterIndices, jeansMass);
      }
    }
  }

  private absorbParticleIntoBody(b: CelestialBody, p: SimParticle): void {
    const newMass = b.mass + p.mass;
    const invMass = 1.0 / newMass;

    // Relative position and velocity for angular momentum & kinetic heating conservation
    const rx = p.x - b.x;
    const ry = p.y - b.y;
    const rz = p.z - b.z;
    const dvx = p.vx - b.vx;
    const dvy = p.vy - b.vy;
    const dvz = p.vz - b.vz;

    // Conservation of angular momentum: L_new = L_body + m_p * (r × dv)
    b.spinX += p.mass * (ry * dvz - rz * dvy);
    b.spinY += p.mass * (rz * dvx - rx * dvz);
    b.spinZ += p.mass * (rx * dvy - ry * dvx);

    // Conservation of linear momentum
    b.x = (b.x * b.mass + p.x * p.mass) * invMass;
    b.y = (b.y * b.mass + p.y * p.mass) * invMass;
    b.z = (b.z * b.mass + p.z * p.mass) * invMass;
    b.vx = (b.vx * b.mass + p.vx * p.mass) * invMass;
    b.vy = (b.vy * b.mass + p.vy * p.mass) * invMass;
    b.vz = (b.vz * b.mass + p.vz * p.mass) * invMass;

    // Blend chemical composition by mass
    for (const el of ELEMENT_ORDER) {
      b.composition[el] = (b.composition[el] * b.mass + p.composition[el] * p.mass) * invMass;
    }
    normalizeComposition(b.composition);

    // Inelastic collision kinetic energy + gravitational potential release heats the core
    const relSpeedSq = dvx * dvx + dvy * dvy + dvz * dvz;
    const gravHeat = (SIM_UNITS.G * b.mass * p.mass) / Math.max(0.4, b.radius);
    const deltaTemp = (relSpeedSq * 18000 + gravHeat * 4.2e6) * (p.mass * invMass);

    b.temperature = (b.temperature * b.mass + p.temperature * p.mass) * invMass + deltaTemp * 0.08;
    b.coreTemperature += deltaTemp;

    b.mass = newMass;
    if (newMass > b.peakMass) b.peakMass = newMass;

    p.alive = false;
    this.updateBodyClassificationAndRadius(b);
  }

  private mergeTwoBodies(primary: CelestialBody, secondary: CelestialBody): void {
    const newMass = primary.mass + secondary.mass;
    const invMass = 1.0 / newMass;

    const rx = secondary.x - primary.x;
    const ry = secondary.y - primary.y;
    const rz = secondary.z - primary.z;
    const dvx = secondary.vx - primary.vx;
    const dvy = secondary.vy - primary.vy;
    const dvz = secondary.vz - primary.vz;

    // Total angular momentum = L1 + L2 + r × (mu_reduced * dv)
    const reducedMass = (primary.mass * secondary.mass) * invMass;
    primary.spinX += secondary.spinX + reducedMass * (ry * dvz - rz * dvy);
    primary.spinY += secondary.spinY + reducedMass * (rz * dvx - rx * dvz);
    primary.spinZ += secondary.spinZ + reducedMass * (rx * dvy - ry * dvx);

    // Center of mass & linear momentum conservation
    primary.x = (primary.x * primary.mass + secondary.x * secondary.mass) * invMass;
    primary.y = (primary.y * primary.mass + secondary.y * secondary.mass) * invMass;
    primary.z = (primary.z * primary.mass + secondary.z * secondary.mass) * invMass;
    primary.vx = (primary.vx * primary.mass + secondary.vx * secondary.mass) * invMass;
    primary.vy = (primary.vy * primary.mass + secondary.vy * secondary.mass) * invMass;
    primary.vz = (primary.vz * primary.mass + secondary.vz * secondary.mass) * invMass;

    for (const el of ELEMENT_ORDER) {
      primary.composition[el] =
        (primary.composition[el] * primary.mass + secondary.composition[el] * secondary.mass) *
        invMass;
    }
    normalizeComposition(primary.composition);

    const impactEnergy = 0.5 * reducedMass * (dvx * dvx + dvy * dvy + dvz * dvz);
    const virialBoost = (SIM_UNITS.G * primary.mass * secondary.mass) / Math.max(0.5, primary.radius);
    primary.coreTemperature =
      Math.max(primary.coreTemperature, secondary.coreTemperature) +
      (impactEnergy * 5e5 + virialBoost * 3.5e6) * invMass;

    primary.mass = newMass;
    if (newMass > primary.peakMass) primary.peakMass = newMass;
    secondary.alive = false;

    this.updateBodyClassificationAndRadius(primary);
  }

  private condenseParticlesIntoBody(indices: number[], jeansMass: number): void {
    let totalMass = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let avgTemp = 0;
    const comp = createEmptyComposition();

    for (let k = 0; k < indices.length; k++) {
      const p = this.particles[indices[k]];
      totalMass += p.mass;
      cx += p.x * p.mass;
      cy += p.y * p.mass;
      cz += p.z * p.mass;
      vx += p.vx * p.mass;
      vy += p.vy * p.mass;
      vz += p.vz * p.mass;
      avgTemp += p.temperature * p.mass;
      for (const el of ELEMENT_ORDER) {
        comp[el] += p.composition[el] * p.mass;
      }
    }

    const invM = 1.0 / totalMass;
    cx *= invM;
    cy *= invM;
    cz *= invM;
    vx *= invM;
    vy *= invM;
    vz *= invM;
    avgTemp *= invM;
    normalizeComposition(comp);

    // Conserve spin angular momentum L = sum m_i (r_i × v_i_rel)
    let spinX = 0;
    let spinY = 0;
    let spinZ = 0;
    let kineticThermalized = 0;

    for (let k = 0; k < indices.length; k++) {
      const p = this.particles[indices[k]];
      const rx = p.x - cx;
      const ry = p.y - cy;
      const rz = p.z - cz;
      const dvx = p.vx - vx;
      const dvy = p.vy - vy;
      const dvz = p.vz - vz;
      spinX += p.mass * (ry * dvz - rz * dvy);
      spinY += p.mass * (rz * dvx - rx * dvz);
      spinZ += p.mass * (rx * dvy - ry * dvx);
      kineticThermalized += 0.5 * p.mass * (dvx * dvx + dvy * dvy + dvz * dvz);
      p.alive = false;
    }

    const bodyNum = this.nextBodyNumber++;
    const virialCoreTemp =
      avgTemp * 12 +
      totalMass * 8.5e7 +
      (kineticThermalized / totalMass) * 5e4;

    const newBody: CelestialBody = {
      id: this.nextEntityId++,
      name: `Object-${bodyNum}`,
      type: 'rocky_planet',
      x: cx,
      y: cy,
      z: cz,
      vx,
      vy,
      vz,
      ax: 0,
      ay: 0,
      az: 0,
      spinX,
      spinY,
      spinZ,
      mass: totalMass,
      peakMass: totalMass,
      radius: 0.5,
      cutoffRadius: computeGravityCutoffRadius(totalMass),
      temperature: Math.max(avgTemp, 350),
      coreTemperature: virialCoreTemp,
      luminosity: 0,
      jeansRatio: totalMass / Math.max(1e-5, jeansMass),
      phase: 'solid',
      fusionStage: 'None',
      composition: comp,
      accretionDiskMass: 0,
      accretionDiskRadius: 2.2,
      age: 0,
      alive: true,
    };

    this.updateBodyClassificationAndRadius(newBody, true);
    this.bodies.push(newBody);
  }

  /**
   * Applies Object Formation by Mass & Remnant Thresholds (Spec 5.5, 5.8, 5.9):
   * - < ~13 M_J: Gas giant or rocky planet
   * - ~13 to 80 M_J (up to ~0.08 M☉): Brown dwarf
   * - >= ~0.08 M☉ with core >= ~10^7 K: Star (hydrogen fusion begins)
   * - White Dwarf > 1.4 M☉ (Chandrasekhar limit) -> collapses/detonates
   * - Neutron Star > 2.6 M☉ (TOV limit) -> Black Hole
   */
  private updateBodyClassificationAndRadius(b: CelestialBody, isNewlyCreated = false): void {
    const prevType = b.type;
    b.cutoffRadius = computeGravityCutoffRadius(b.mass);

    // 1. Check Black Hole
    if (b.type === 'black_hole') {
      b.radius = computeSchwarzschildRadius(b.mass);
      b.phase = 'singularity';
      b.fusionStage = 'Relativistic Singularity';
      b.temperature = 25000;
      b.luminosity = Math.min(25, b.accretionDiskMass * 120 + 0.5);
      b.accretionDiskRadius = b.radius * 4.2;
      return;
    }

    // 2. Check Neutron Star exceeding TOV limit (~2.6 M☉) -> Black Hole!
    if (b.type === 'neutron_star') {
      if (b.mass >= MASS_THRESHOLDS.TOV_NEUTRON_LIMIT) {
        b.type = 'black_hole';
        b.name = `BH-${b.id}`;
        b.radius = computeSchwarzschildRadius(b.mass);
        b.phase = 'singularity';
        b.fusionStage = 'Relativistic Singularity';
        this.logCosmicEvent(
          'Black Hole Formed',
          `${b.name} exceeded the TOV limit (${b.mass.toFixed(2)} M☉) and collapsed within its Schwarzschild horizon.`,
          'black_hole',
          b
        );
        cosmicAudio.playSupernova(true);
        return;
      }
      b.radius = 0.42;
      b.phase = 'degenerate';
      b.fusionStage = 'Neutron Degenerate (Pulsar)';
      b.temperature = 28000;
      b.luminosity = 1.8;
      return;
    }

    // 3. Check White Dwarf exceeding Chandrasekhar limit (~1.4 M☉)
    if (b.type === 'white_dwarf') {
      if (b.mass >= MASS_THRESHOLDS.CHANDRASEKHAR_LIMIT) {
        this.triggerSupernova(b, true);
        return;
      }
      b.radius = 0.52;
      b.phase = 'degenerate';
      b.fusionStage = 'Electron Degenerate (White Dwarf)';
      b.temperature = 16500;
      b.luminosity = 0.45;
      return;
    }

    // 4. Normal hydrostatic bodies (Planets, Brown Dwarfs, Protostars, Stars)
    // Virial core temperature scales with G * M / R
    const virialFloor = b.mass * 1.35e8;
    if (b.coreTemperature < virialFloor) {
      b.coreTemperature = virialFloor;
    }

    const heavyFrac = b.composition.C + b.composition.O + b.composition.Si + b.composition.Fe;

    if (b.mass < MASS_THRESHOLDS.BROWN_DWARF_MIN) {
      // < 13 M_J: Planet or Gas Giant
      if (heavyFrac >= 0.35) {
        b.type = 'rocky_planet';
        b.phase = 'solid';
        b.radius = Math.max(0.36, 0.58 * Math.cbrt(b.mass / 0.005));
        b.temperature = Math.max(180, Math.min(1800, b.temperature));
      } else {
        b.type = 'gas_giant';
        b.phase = 'gas';
        b.radius = Math.max(0.5, 0.82 * Math.cbrt(b.mass / 0.008));
        b.temperature = Math.max(140, Math.min(1400, b.temperature));
      }
      b.fusionStage = 'None';
      b.luminosity = 0;
      if (isNewlyCreated || prevType !== b.type) {
        b.name = `${b.type === 'rocky_planet' ? 'Terra' : 'Jovian'}-${b.id}`;
      }
    } else if (b.mass < MASS_THRESHOLDS.STAR_MIN) {
      // 13 to 80 M_J (up to 0.08 M☉): Brown Dwarf
      b.type = 'brown_dwarf';
      b.phase = 'gas';
      b.radius = 0.88;
      b.temperature = 1650 + (b.mass / MASS_THRESHOLDS.STAR_MIN) * 900;
      b.fusionStage = 'Deuterium Flash (Brown Dwarf)';
      b.luminosity = 0.04;
      if (prevType !== 'brown_dwarf') {
        b.name = `BD-${b.id}`;
        this.logCosmicEvent(
          'Brown Dwarf Condensed',
          `${b.name} reached ${(b.mass / SIM_UNITS.M_JUPITER).toFixed(1)} M_J (sub-stellar deuterium regime).`,
          'planet',
          b
        );
      }
    } else {
      // >= 0.08 M☉: Protostar or Main Sequence / Evolved Star
      const hasFuel = b.composition.H > 0.04 || b.composition.He > 0.04 || b.mass >= 8.0;
      if (b.coreTemperature >= TEMP_THRESHOLDS.HYDROGEN_FUSION && hasFuel) {
        if (b.type !== 'red_giant') {
          b.type = 'main_sequence_star';
        }
        b.phase = 'plasma';
        if (
          prevType !== 'main_sequence_star' &&
          prevType !== 'red_giant'
        ) {
          b.name = `Star-${b.id}`;
          this.logCosmicEvent(
            'Star Ignited',
            `${b.name} (${b.mass.toFixed(2)} M☉) reached ${(b.coreTemperature / 1e6).toFixed(1)}M K core and ignited hydrogen fusion.`,
            'star',
            b
          );
          cosmicAudio.playStarIgnition(b.mass);
        }
      } else {
        b.type = 'protostar';
        b.phase = 'gas';
        b.radius = 1.15;
        b.temperature = 2600;
        b.fusionStage = 'Gravitational Contraction';
        b.luminosity = 0.25;
        b.name = `Protostar-${b.id}`;
      }
    }
  }

  /**
   * Spec 5.6, 5.7, 5.8:
   * - Fusion Chain: 1. H -> He, 2. He -> C, 3. C -> O -> Ne -> Si -> Fe, 4. Stop at Iron.
   * - Stellar Equilibrium & Lifetime: Massive stars burn faster (Lifetime ∝ M^-2.5, so burn rate ∝ M^2.5).
   * - Stellar Death:
   *   - Below ~8 M☉: Red Giant -> Planetary Nebula + White Dwarf (< 1.4 M☉).
   *   - Above ~8 M☉: Core collapse & Supernova scattering heavy elements -> Neutron Star (<= 2.6 M☉) or Black Hole (> 2.6 M☉).
   */
  private evolveStellarInteriors(dt: number): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.alive) continue;

      // Protostar gravitational Kelvin-Helmholtz contraction heats the core toward 10^7 K
      if (b.type === 'protostar') {
        b.coreTemperature += dt * 4.5e6 * Math.pow(b.mass / 0.08, 1.5);
        if (b.coreTemperature >= TEMP_THRESHOLDS.HYDROGEN_FUSION) {
          this.updateBodyClassificationAndRadius(b);
        }
        continue;
      }

      if (b.type !== 'main_sequence_star' && b.type !== 'red_giant') {
        continue;
      }

      // Stellar burn rate scales so lifetime τ ∝ M^-2.5:
      // At 1 M☉, τ is comfortable; at 10 M☉, it burns markedly faster.
      // Clamp extreme high-mass scaling slightly so 100x time control remains smooth.
      const massRatio = Math.max(0.08, b.mass / SIM_UNITS.M_SUN);
      const lifetimeRate = 0.0085 * Math.pow(Math.min(14.0, massRatio), 2.15) * dt;

      // 1. Hydrogen Burning: H -> He (pp-chain & CNO cycle)
      if (b.composition.H > 0.06) {
        b.type = 'main_sequence_star';
        b.fusionStage = 'H → He (Proton-Proton / CNO)';
        const dH = Math.min(b.composition.H - 0.05, lifetimeRate * 0.85);
        b.composition.H -= dH;
        b.composition.He += dH;

        // Effective surface temperature follows Main Sequence mass-temperature relation (2,900K M-dwarf to 34,000K O-star)
        b.temperature = Math.min(
          36000,
          2850 * Math.pow(massRatio / 0.08, 0.52)
        );
        b.radius = Math.min(3.4, 0.95 * Math.pow(massRatio, 0.55));
        b.luminosity = Math.min(30, Math.pow(massRatio, 2.2));

        // As H depletes in the core, core contracts and heats toward 10^8 K
        const hDepletion = 1.0 - b.composition.H;
        b.coreTemperature = Math.max(
          b.coreTemperature,
          TEMP_THRESHOLDS.HYDROGEN_FUSION * (1.0 + hDepletion * 9.5) * Math.pow(massRatio, 0.45)
        );
      }
      // 2. Helium Burning: He -> C, O (Triple-Alpha at ~10^8 K) -> Red Giant / Supergiant phase
      else if (b.composition.He > 0.08) {
        b.coreTemperature = Math.max(b.coreTemperature, TEMP_THRESHOLDS.HELIUM_FUSION * 1.15);
        b.type = 'red_giant';
        b.fusionStage = 'He → C, O (Triple-Alpha)';

        const dHe = Math.min(b.composition.He - 0.06, lifetimeRate * 1.35);
        b.composition.He -= dHe;
        b.composition.C += dHe * 0.62;
        b.composition.O += dHe * 0.38;

        // Envelope expands and cools to Red Giant / Red Supergiant (~3,200 - 4,200 K)
        b.temperature = b.mass >= MASS_THRESHOLDS.SUPERNOVA_PROGENITOR_MIN ? 4100 : 3350;
        b.radius = Math.min(4.8, 1.85 * Math.pow(massRatio, 0.45));
        b.luminosity = Math.min(40, 4.0 * Math.pow(massRatio, 1.8));
      }
      // 3. Post-Helium Evolution: Branches at 8 M☉ (Spec 5.8)
      else if (b.peakMass < MASS_THRESHOLDS.SUPERNOVA_PROGENITOR_MIN && b.mass < MASS_THRESHOLDS.SUPERNOVA_PROGENITOR_MIN) {
        // Low/Intermediate-mass star (< 8 M☉): sheds Planetary Nebula and becomes a White Dwarf
        this.transformToWhiteDwarf(b);
      } else {
        // Massive Star (>= 8 M☉): Carbon -> Oxygen/Silicon -> Iron Core Collapse!
        if (b.composition.C + b.composition.O > 0.14 && b.composition.Si < 0.28) {
          b.coreTemperature = Math.max(b.coreTemperature, TEMP_THRESHOLDS.CARBON_FUSION * 1.2);
          b.fusionStage = 'C → O, Ne, Si (Carbon Burning)';
          const dCO = Math.min(0.12, lifetimeRate * 2.2);
          const takeC = Math.min(b.composition.C, dCO * 0.65);
          const takeO = Math.min(b.composition.O, dCO * 0.35);
          b.composition.C -= takeC;
          b.composition.O -= takeO;
          b.composition.Si += takeC + takeO;
          b.temperature = 14000;
        } else {
          // Silicon Burning: Si -> Fe (End of exothermic fusion chain!)
          b.coreTemperature = Math.max(b.coreTemperature, TEMP_THRESHOLDS.SILICON_FUSION * 1.25);
          b.fusionStage = 'Si → Fe (Silicon Burning)';
          const dSi = Math.min(b.composition.Si, lifetimeRate * 2.8);
          b.composition.Si -= dSi;
          b.composition.Fe += dSi;
          b.temperature = 22000;

          // Stop at Iron: once Iron core builds up, radiation pressure vanishes -> Core-Collapse Supernova!
          if (b.composition.Fe >= 0.16 || b.composition.Si <= 0.03) {
            b.fusionStage = 'Iron Core Catastrophe';
            this.triggerSupernova(b, false);
          }
        }
      }

      normalizeComposition(b.composition);
    }
  }

  /**
   * Below ~8 M☉: Red Giant expels outer envelope as a Planetary Nebula and leaves a White Dwarf (< 1.4 M☉).
   */
  private transformToWhiteDwarf(b: CelestialBody): void {
    const initialMass = b.mass;
    const remnantMass = Math.min(
      MASS_THRESHOLDS.CHANDRASEKHAR_LIMIT * 0.92,
      Math.max(0.45, initialMass * 0.52)
    );
    const ejectedMass = Math.max(0.05, initialMass - remnantMass);

    // Scatter planetary nebula gas shell (enriched in He, C, O) conserving momentum
    this.ejectStellarEnvelopeParticles(b, ejectedMass, 14, 2.2, false);

    b.mass = remnantMass;
    b.type = 'white_dwarf';
    b.name = `WD-${b.id}`;
    b.radius = 0.52;
    b.temperature = 18500;
    b.coreTemperature = 4.0e7;
    b.phase = 'degenerate';
    b.fusionStage = 'Electron Degenerate (White Dwarf)';
    b.composition = normalizeComposition({
      H: 0.02,
      He: 0.18,
      C: 0.45,
      O: 0.33,
      Si: 0.02,
      Fe: 0,
    });

    this.shockwaves.push({
      id: this.nextEntityId++,
      x: b.x,
      y: b.y,
      z: b.z,
      radius: b.radius * 1.2,
      maxRadius: 16.0,
      speed: 7.5,
      colorHex: '#38BDF8',
      isSupernova: false,
      age: 0,
      maxAge: 2.2,
    });

    this.logCosmicEvent(
      'White Dwarf Remnant',
      `${b.name} shed a planetary nebula and stabilized via electron degeneracy at ${b.mass.toFixed(2)} M☉.`,
      'remnant',
      b
    );
  }

  /**
   * Above ~8 M☉ (or White Dwarf > 1.4 M☉): Core-Collapse Supernova!
   * Scatters newly synthesized heavy elements (C, O, Si, Fe) back into space
   * and leaves a Neutron Star (up to ~2.6 M☉) or Black Hole (above ~2.6 M☉).
   */
  public triggerSupernova(b: CelestialBody, isTypeIa = false): void {
    const progenitorMass = Math.max(b.mass, b.peakMass);

    if (isTypeIa) {
      // Type Ia Supernova disrupts the White Dwarf or leaves a compact Neutron Star if merger was massive
      const ejectaMass = b.mass;
      this.ejectStellarEnvelopeParticles(b, ejectaMass, 24, 6.2, true);
      b.alive = false;
      this.shockwaves.push({
        id: this.nextEntityId++,
        x: b.x,
        y: b.y,
        z: b.z,
        radius: 1.0,
        maxRadius: 34.0,
        speed: 18.0,
        colorHex: '#60A5FA',
        isSupernova: true,
        age: 0,
        maxAge: 2.5,
      });
      this.logCosmicEvent(
        'Type Ia Supernova',
        `White dwarf ${b.name} exceeded the 1.4 M☉ Chandrasekhar limit and detonated completely.`,
        'supernova',
        b
      );
      cosmicAudio.playSupernova(false);
      return;
    }

    // Core-collapse remnant mass (~26% of progenitor)
    const remnantMass = b.mass * 0.27;
    const ejectaMass = b.mass - remnantMass;

    // Scatter heavy elements (C, O, Si, Fe + H, He) outward symmetrically so net momentum is conserved
    this.ejectStellarEnvelopeParticles(b, ejectaMass, 30, 6.8, true);

    b.mass = remnantMass;
    b.peakMass = remnantMass;

    if (remnantMass > MASS_THRESHOLDS.TOV_NEUTRON_LIMIT || progenitorMass >= 14.0) {
      // Black Hole remnant!
      b.type = 'black_hole';
      b.name = `BH-${b.id}`;
      b.mass = Math.max(3.1, remnantMass);
      b.radius = computeSchwarzschildRadius(b.mass);
      b.phase = 'singularity';
      b.fusionStage = 'Relativistic Singularity';
      b.temperature = 28000;
      b.luminosity = 4.5;
      this.logCosmicEvent(
        'Hypernova & Black Hole',
        `Massive star (${progenitorMass.toFixed(1)} M☉) collapsed into Black Hole ${b.name} (${b.mass.toFixed(2)} M☉).`,
        'black_hole',
        b
      );
      cosmicAudio.playSupernova(true);
    } else {
      // Neutron Star remnant!
      b.type = 'neutron_star';
      b.name = `Pulsar-${b.id}`;
      b.mass = Math.max(1.45, Math.min(2.5, remnantMass));
      b.radius = 0.42;
      b.phase = 'degenerate';
      b.fusionStage = 'Neutron Degenerate (Pulsar)';
      b.temperature = 30000;
      b.luminosity = 2.0;
      this.logCosmicEvent(
        'Supernova & Neutron Star',
        `Massive star (${progenitorMass.toFixed(1)} M☉) detonated in a supernova, leaving Neutron Star ${b.name} (${b.mass.toFixed(2)} M☉).`,
        'supernova',
        b
      );
      cosmicAudio.playSupernova(false);
    }

    b.cutoffRadius = computeGravityCutoffRadius(b.mass);

    this.shockwaves.push({
      id: this.nextEntityId++,
      x: b.x,
      y: b.y,
      z: b.z,
      radius: 1.4,
      maxRadius: 42.0,
      speed: 22.0,
      colorHex: b.type === 'black_hole' ? '#F59E0B' : '#A78BFA',
      isSupernova: true,
      age: 0,
      maxAge: 2.8,
    });
  }

  /**
   * Symmetrically ejects pairs of antipodal gas/dust parcels so linear momentum and mass are strictly conserved.
   */
  private ejectStellarEnvelopeParticles(
    b: CelestialBody,
    totalEjectaMass: number,
    numParticles: number,
    ejectSpeed: number,
    isSupernova: boolean
  ): void {
    const pairs = Math.max(4, Math.floor(numParticles / 2));
    const parcelMass = totalEjectaMass / (pairs * 2);

    // Fibonacci sphere directions for deterministic, zero-RNG antipodal symmetry
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < pairs; i++) {
      const y = 1 - (i / Math.max(1, pairs - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * i + b.id * 0.7;
      const dx = Math.cos(theta) * r;
      const dy = y;
      const dz = Math.sin(theta) * r;

      const shellComposition: Composition = isSupernova
        ? normalizeComposition({
            H: 0.14,
            He: 0.2,
            C: 0.18,
            O: 0.2,
            Si: 0.15,
            Fe: 0.13,
          })
        : normalizeComposition({
            H: 0.45,
            He: 0.32,
            C: 0.14,
            O: 0.09,
            Si: 0,
            Fe: 0,
          });

      const startDist = b.radius * 1.45;
      const speed = ejectSpeed * (0.85 + (i % 3) * 0.15);
      const temp = isSupernova ? 24000 : 8500;

      for (const sign of [1, -1]) {
        this.particles.push({
          id: this.nextEntityId++,
          x: b.x + dx * sign * startDist,
          y: b.y + dy * sign * startDist,
          z: b.z + dz * sign * startDist,
          vx: b.vx + dx * sign * speed,
          vy: b.vy + dy * sign * speed,
          vz: b.vz + dz * sign * speed,
          ax: 0,
          ay: 0,
          az: 0,
          mass: parcelMass,
          temperature: temp,
          density: parcelMass * 0.05,
          phase: this.determineParticlePhase(shellComposition, temp),
          composition: { ...shellComposition },
          cutoffRadius: computeGravityCutoffRadius(parcelMass),
          age: 0,
          alive: true,
        });
      }
    }
  }

  private updateShockwaves(dt: number): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += dt;
      sw.radius += sw.speed * dt;
      if (sw.age >= sw.maxAge || sw.radius >= sw.maxRadius) {
        this.shockwaves.splice(i, 1);
      }
    }
  }

  private pruneDeadEntities(): void {
    let writeIdx = 0;
    for (let i = 0; i < this.particles.length; i++) {
      if (this.particles[i].alive) {
        this.particles[writeIdx++] = this.particles[i];
      }
    }
    this.particles.length = writeIdx;

    let bodyWrite = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      if (this.bodies[i].alive) {
        this.bodies[bodyWrite++] = this.bodies[i];
      }
    }
    this.bodies.length = bodyWrite;
  }

  /**
   * Spec Section 7: Add a particle cap and merge nearby low-mass particles when the cap is near.
   */
  private compactLowMassParticles(): void {
    this.spatialGrid.clear();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.alive) this.spatialGrid.insert(i, p.x, p.y, p.z);
    }

    for (let i = 0; i < this.particles.length; i++) {
      const pi = this.particles[i];
      if (!pi.alive) continue;
      this.spatialGrid.queryRadius(pi.x, pi.y, pi.z, 3.5, this.neighborScratch);
      for (let k = 0; k < this.neighborScratch.length; k++) {
        const j = this.neighborScratch[k];
        if (j <= i) continue;
        const pj = this.particles[j];
        if (!pj.alive) continue;

        // Merge pi and pj conserving mass, momentum, temperature, and composition
        const m = pi.mass + pj.mass;
        const inv = 1.0 / m;
        pi.x = (pi.x * pi.mass + pj.x * pj.mass) * inv;
        pi.y = (pi.y * pi.mass + pj.y * pj.mass) * inv;
        pi.z = (pi.z * pi.mass + pj.z * pj.mass) * inv;
        pi.vx = (pi.vx * pi.mass + pj.vx * pj.mass) * inv;
        pi.vy = (pi.vy * pi.mass + pj.vy * pj.mass) * inv;
        pi.vz = (pi.vz * pi.mass + pj.vz * pj.mass) * inv;
        pi.temperature = (pi.temperature * pi.mass + pj.temperature * pj.mass) * inv;
        for (const el of ELEMENT_ORDER) {
          pi.composition[el] = (pi.composition[el] * pi.mass + pj.composition[el] * pj.mass) * inv;
        }
        pi.mass = m;
        pi.cutoffRadius = computeGravityCutoffRadius(m);
        pj.alive = false;
        break;
      }
    }
    this.pruneDeadEntities();
  }

  private logCosmicEvent(
    title: string,
    detail: string,
    category: CosmicEventLog['category'],
    b: CelestialBody
  ): void {
    this.events.unshift({
      id: this.nextEntityId++,
      timeMyr: this.simTimeMyr,
      title,
      detail,
      category,
      bodyId: b.id,
      x: b.x,
      y: b.y,
      z: b.z,
    });
    if (this.events.length > 25) {
      this.events.length = 25;
    }
  }
}
