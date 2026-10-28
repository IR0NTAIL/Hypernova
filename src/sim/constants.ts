export type ElementSymbol = 'H' | 'He' | 'C' | 'O' | 'Si' | 'Fe';

export type Composition = Record<ElementSymbol, number>;

export type MatterPhase =
  | 'molecular_h2'
  | 'gas'
  | 'dust'
  | 'plasma'
  | 'solid'
  | 'degenerate'
  | 'singularity';

export type BodyClass =
  | 'rocky_planet'
  | 'gas_giant'
  | 'brown_dwarf'
  | 'protostar'
  | 'main_sequence_star'
  | 'red_giant'
  | 'white_dwarf'
  | 'neutron_star'
  | 'black_hole';

export type FusionStage =
  | 'None'
  | 'Gravitational Contraction'
  | 'Deuterium Flash (Brown Dwarf)'
  | 'H → He (Proton-Proton / CNO)'
  | 'He → C, O (Triple-Alpha)'
  | 'C → O, Ne, Si (Carbon Burning)'
  | 'Si → Fe (Silicon Burning)'
  | 'Iron Core Catastrophe'
  | 'Electron Degenerate (White Dwarf)'
  | 'Neutron Degenerate (Pulsar)'
  | 'Relativistic Singularity';

export interface ElementSpec {
  symbol: ElementSymbol;
  name: string;
  atomicMass: number;
  role: string;
  colorHex: string;
  colorRGB: [number, number, number];
  isGas: boolean;
  defaultTempK: number;
  baseParcelMassSim: number; // In solar masses (M☉_sim)
  clusterSpread: number; // Spatial radius of spawned cluster
}

/**
 * SCALED ASTROPHYSICAL CONSTANTS
 * All laws, mass ratios, and temperature thresholds use real astrophysical ratios
 * derived from fundamental simulation units so no raw SI values are hardcoded in loops.
 */
export const SIM_UNITS = {
  // Fundamental mass unit: 1.0 = 1 Solar Mass (M☉)
  M_SUN: 1.0,
  // Real ratio: 1 Jupiter Mass (M_J) ≈ 0.000954588 M☉
  M_JUPITER: 0.000954588,
  // Scaled gravitational constant in simulation space-time units
  G: 48.0,
  // Scaled speed of light (used for Schwarzschild radius r_s = 2GM/c^2 and E=mc^2)
  C: 110.0,
  // Gravitational softening length to prevent 1/r^2 numerical singularities
  SOFTENING: 0.65,
  // Base gravitational range cutoff and mass scaling factor
  BASE_CUTOFF_RADIUS: 18.0,
  MASS_CUTOFF_SCALE: 26.0,
  // Ideal gas & radiative constants in scaled simulation units
  KB_OVER_MH: 0.00018,
  RADIATIVE_COOLING_RATE: 0.045,
  COMPRESSIVE_HEATING_FACTOR: 2400.0,
  // Fixed physics sub-step (seconds)
  FIXED_DT: 0.016,
  // Particle cap before automatic co-moving low-mass parcel merging
  MAX_PARTICLES: 2800,
};

/**
 * OBJECT FORMATION & STELLAR EVOLUTION MASS THRESHOLDS (Derived from M_SUN & M_JUPITER)
 */
export const MASS_THRESHOLDS = {
  // Minimum mass to condense a discrete planetary body (~0.8 M_J or rocky protoplanet)
  MIN_PLANET: 0.8 * SIM_UNITS.M_JUPITER,
  // < ~13 M_J -> Gas Giant or Rocky Planet
  BROWN_DWARF_MIN: 13.0 * SIM_UNITS.M_JUPITER, // ~0.0124 M☉
  // ~13 M_J to ~80 M_J (~0.08 M☉) -> Brown Dwarf; >= 0.08 M☉ -> Star
  STAR_MIN: 0.08 * SIM_UNITS.M_SUN, // ~83.8 M_J
  // CNO cycle dominance in stars > 1.3 M☉
  CNO_STAR_MASS: 1.3 * SIM_UNITS.M_SUN,
  // Chandrasekhar Limit (~1.4 M☉): maximum mass of a White Dwarf
  CHANDRASEKHAR_LIMIT: 1.4 * SIM_UNITS.M_SUN,
  // Tolman-Oppenheimer-Volkoff Limit (~2.6 M☉): maximum mass of a Neutron Star before Black Hole collapse
  TOV_NEUTRON_LIMIT: 2.6 * SIM_UNITS.M_SUN,
  // Minimum initial stellar mass for Core-Collapse Supernova (~8 M☉)
  SUPERNOVA_PROGENITOR_MIN: 8.0 * SIM_UNITS.M_SUN,
};

/**
 * REAL ASTROPHYSICAL TEMPERATURE THRESHOLDS (Kelvin)
 */
export const TEMP_THRESHOLDS = {
  CMB_FLOOR: 2.7, // Cosmic Microwave Background minimum temperature
  H2_MOLECULAR_MAX: 2400, // Cold hydrogen bonds into H₂ below ~2,400 K
  DUST_SUBLIMATION: 1500, // Silicate/Carbon dust sublimates into gas
  HYDROGEN_IONIZATION: 15800, // 13.6 eV ionization -> Plasma state
  DEUTERIUM_FUSION: 1.0e6, // 10^6 K in Brown Dwarfs / Protostars
  HYDROGEN_FUSION: 1.0e7, // 10^7 K core temperature ignites H → He main sequence
  HELIUM_FUSION: 1.0e8, // 10^8 K ignites Triple-Alpha He → C, O
  CARBON_FUSION: 5.5e8, // ~6×10^8 K ignites C → O, Ne, Si in massive stars
  SILICON_FUSION: 1.8e9, // ~2×10^9 K ignites Si → Fe prior to core collapse
};

/**
 * ELEMENT TABLE (Spec Section 4)
 */
export const ELEMENTS: Record<ElementSymbol, ElementSpec> = {
  H: {
    symbol: 'H',
    name: 'Hydrogen',
    atomicMass: 1.008,
    role: 'Main fuel for stars, forms H₂ when cold',
    colorHex: '#60A5FA',
    colorRGB: [0.38, 0.65, 0.98],
    isGas: true,
    defaultTempK: 120,
    baseParcelMassSim: 0.0045, // A 9-particle cluster is ~0.04 M☉; 2 clusters = 0.08 M☉ (Star threshold!)
    clusterSpread: 3.4,
  },
  He: {
    symbol: 'He',
    name: 'Helium',
    atomicMass: 4.0026,
    role: 'Inert at low temperature, fusion product',
    colorHex: '#FBBF24',
    colorRGB: [0.98, 0.75, 0.14],
    isGas: true,
    defaultTempK: 160,
    baseParcelMassSim: 0.0055,
    clusterSpread: 3.1,
  },
  C: {
    symbol: 'C',
    name: 'Carbon',
    atomicMass: 12.011,
    role: 'Dust and fusion product',
    colorHex: '#A78BFA',
    colorRGB: [0.65, 0.55, 0.98],
    isGas: false,
    defaultTempK: 90,
    baseParcelMassSim: 0.003,
    clusterSpread: 1.9,
  },
  O: {
    symbol: 'O',
    name: 'Oxygen',
    atomicMass: 15.999,
    role: 'Dust, planet and ocean building block',
    colorHex: '#34D399',
    colorRGB: [0.2, 0.83, 0.6],
    isGas: false,
    defaultTempK: 95,
    baseParcelMassSim: 0.0032,
    clusterSpread: 1.9,
  },
  Si: {
    symbol: 'Si',
    name: 'Silicon',
    atomicMass: 28.085,
    role: 'Rocky planet material',
    colorHex: '#FB923C',
    colorRGB: [0.98, 0.57, 0.24],
    isGas: false,
    defaultTempK: 85,
    baseParcelMassSim: 0.0035,
    clusterSpread: 1.6,
  },
  Fe: {
    symbol: 'Fe',
    name: 'Iron',
    atomicMass: 55.845,
    role: 'Dense core, ends the fusion chain',
    colorHex: '#F87171',
    colorRGB: [0.97, 0.44, 0.44],
    isGas: false,
    defaultTempK: 80,
    baseParcelMassSim: 0.0042,
    clusterSpread: 1.35,
  },
};

export const ELEMENT_ORDER: ElementSymbol[] = ['H', 'He', 'C', 'O', 'Si', 'Fe'];

/**
 * Computes the mass-dependent gravitational cutoff radius:
 * More massive bodies reach significantly farther across space.
 */
export function computeGravityCutoffRadius(massSim: number): number {
  return (
    SIM_UNITS.BASE_CUTOFF_RADIUS +
    SIM_UNITS.MASS_CUTOFF_SCALE * Math.cbrt(Math.max(0.0001, massSim / SIM_UNITS.M_SUN))
  );
}

/**
 * Computes the scaled Schwarzschild event horizon radius r_s = 2GM/c^2
 * with a visual minimum so stellar-mass black holes remain clearly observable.
 */
export function computeSchwarzschildRadius(massSim: number): number {
  const rawRs = (2 * SIM_UNITS.G * massSim) / (SIM_UNITS.C * SIM_UNITS.C);
  return Math.max(0.65, rawRs * 45.0);
}

/**
 * Converts stellar surface temperature (Kelvin) into realistic Planckian blackbody RGB [0..1]
 * From M-type red (2,600K) -> K-type orange (4,200K) -> G-type yellow (5,800K) -> A-type white (9,500K) -> O-type blue (30,000K+)
 */
export function temperatureToBlackbodyRGB(tempK: number): [number, number, number] {
  const t = Math.max(1200, Math.min(40000, tempK)) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    if (t <= 19) {
      b = 0;
    } else {
      b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    }
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  return [
    Math.max(0, Math.min(255, r)) / 255,
    Math.max(0, Math.min(255, g)) / 255,
    Math.max(0, Math.min(255, b)) / 255,
  ];
}
