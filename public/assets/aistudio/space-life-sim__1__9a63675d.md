# Space Life Simulation: Build Spec

**Target:** Google AI Studio, model `gemini-4-argon`
**Stack:** three.js (WebGL), vanilla JS or React, single-page web app
**Runtime AI:** none required. Argon is the code-generating model only.
**Framework rule:** keep the three.js canvas and simulation loop **outside React's render loop**. Prefer vanilla JS. If React is used, only the UI (buttons, time bar) is React, and the canvas must never re-render on state changes.

---

## 1. Concept

An interactive, Conway's Game of Life-style space simulation. The canvas starts **blank**. The player adds elements with small buttons. Each element drifts slowly, attracts others through gravity, and combines with them. Stars, brown dwarfs, gas giants, white dwarfs, neutron stars and black holes **emerge from the physics**, not from scripted events or dice rolls.

**Randomness rule:** the only random inputs are the **spawn position, initial direction and initial speed** of each cluster. After that, everything is deterministic physics. Seed the RNG so a run can be replayed.

---

## 2. UI

- The canvas fills the whole viewport. It is the dominant element.
- A slim **vertical button panel** floats on the **right edge**, over the canvas, and takes no layout space.
- **Buttons:** small, circular or rounded-square, **glassmorphism** (translucent fill, `backdrop-filter: blur`, 1px light border, soft shadow, subtle hover glow).
- **Labels:** element symbol only (`H`, `He`, `C`, `O`, `Si`, `Fe`). The **full name appears as a tooltip on hover**.
- **Time controls:** a small glass bar at the bottom center with Pause, 1x, 5x, 20x and 100x.
- **Optional extras:** a subtle info readout (particle count, simulated time) in a corner, and a "Reset" glass button.
- **Look:** dark space background, minimal chrome, no clutter. Camera supports orbit, pan and zoom.
- **Responsive:** the panel must stay usable on mobile.

---

## 3. Spawning

Clicking an element button places a **cluster**, not a single atom.

- Cluster size: a small group (about 5 to 12 particles) with a tight random spread.
- Position: random within the visible canvas volume.
- Velocity: random direction, **very low speed**, just enough for clusters to eventually reach ones placed later. Scale this relative to the gravity strength so drifting bodies actually meet.
- Gases (H, He) spawn as diffuse clusters. Heavier elements (C, O, Si, Fe) spawn as denser clumps or dust grains.

---

## 4. Elements

| Button | Element | Role |
|---|---|---|
| H | Hydrogen | Main fuel for stars, forms H₂ when cold |
| He | Helium | Inert at low temperature, fusion product |
| C | Carbon | Dust and fusion product |
| O | Oxygen | Dust, planet and ocean building block |
| Si | Silicon | Rocky planet material |
| Fe | Iron | Dense core, ends the fusion chain |

Each particle tracks: position, velocity, mass, composition, temperature, and phase.

---

## 5. Physics Rules

All rules should follow real science. Use real **ratios, thresholds and formulas**, with scaled constants (see section 6).

### 5.1 Gravity
- Newtonian: `F = G·m₁·m₂ / r²`, with a small softening term to avoid singularities.
- **Range-limited:** gravity acts only within a cutoff radius that **scales with the mass** of the body. More massive bodies reach farther.

### 5.2 Thermodynamics
- Temperature is the mean kinetic energy of a cluster.
- Collisions conserve momentum and energy.
- Compression heats gas (ideal gas law, `PV = NkT`).
- Gas radiates energy away and cools, which allows further collapse.

### 5.3 Collapse and Pressure
- Thermal pressure resists gravity.
- A cloud collapses only when its mass exceeds the **Jeans mass**, which depends on temperature and density.
- **Angular momentum is conserved.** Collapsing clouds spin up and flatten into **accretion disks**.

### 5.4 Chemistry and Ionization
- Cold hydrogen atoms bond into H₂ (using real bond energies).
- Very hot gas ionizes into **plasma** (hydrogen ionization at 13.6 eV).

### 5.5 Object Formation by Mass
Thresholds are expressed as mass ratios (Jupiter masses `M_J`, solar masses `M☉`):

| Mass | Outcome |
|---|---|
| < ~13 M_J | Gas giant or planet |
| ~13 to 80 M_J (up to ~0.08 M☉) | Brown dwarf |
| ≥ ~0.08 M☉ with core ≥ ~10⁷ K | **Star** (hydrogen fusion begins) |

### 5.6 Fusion Chain
Fusion starts only when the core reaches the required temperature and density.

1. **H → He** (proton-proton chain, CNO cycle in massive stars)
2. **He → C** (triple-alpha, ~10⁸ K)
3. **C → O → Ne → Si → Fe**
4. **Stop at iron.** Fusing it consumes energy.

### 5.7 Stellar Equilibrium and Lifetime
- A stable star balances gravity against radiation and gas pressure.
- Massive stars burn faster. Lifetime scales roughly as `M^-2.5`.

### 5.8 Stellar Death
- **Below ~8 M☉:** red giant, then **white dwarf**. A white dwarf cannot exceed the Chandrasekhar limit (~1.4 M☉).
- **Above ~8 M☉:** core collapse and **supernova**, which scatters heavy elements back into space as new gas and dust.
- **Remnant core:** neutron star up to ~2 to 3 M☉, **black hole** above that.

### 5.9 Black Holes
- Event horizon at the Schwarzschild radius `r = 2GM/c²` (scaled).
- Anything crossing the horizon is absorbed and adds to the black hole's mass.
- Render gravitational lensing or a simple accretion glow if performance allows.

### 5.10 Conservation Laws
Momentum, angular momentum and mass-energy must be conserved in every merge, collision and explosion.

---

## 6. Scaling

Real cosmic distances and timescales cannot run in real time. Keep the **laws and ratios real** and use **scaled constants**:

- Define simulation units (`G`, `c`, mass unit = 1 `M☉_sim`) and derive every threshold from them.
- Keep temperature and mass thresholds as real ratios.
- Compress timescales (a star's lifetime may take minutes of real time at 1x). Let the time controls speed it up.
- Do **not** hardcode literal SI values into the simulation loop.

---

## 7. Architecture and Performance

- Fixed-timestep physics loop, separate from rendering. Use a stable integrator (velocity Verlet or leapfrog).
- Because gravity is range-limited, use a **spatial hash grid or octree** so only nearby bodies are checked. Avoid O(n²) pair checks.
- Aggregate dense, bound particles into **bodies** (planets, stars, remnants) with tracked mass and composition. Keep loose gas as lightweight particles.
- Render particles with `THREE.Points` or `InstancedMesh`, and use shader-based glow for stars. Color stars by temperature (blackbody: red, orange, yellow, white, blue).
- Target 60 FPS with a few thousand particles. Add a particle cap and merge nearby low-mass particles when the cap is near.

---

## 8. Visual Language

| Object | Look |
|---|---|
| Gas | Faint soft particles, tinted by composition |
| Protostar | Dim, warm glow inside a collapsing cloud |
| Star | Bright emissive core with glow, colored by temperature |
| Brown dwarf | Dark, faint red-magenta |
| Gas giant / planet | Small solid sphere |
| White dwarf | Small, intense white-blue |
| Neutron star | Tiny, bright, optional pulse |
| Black hole | Black sphere with a thin glowing accretion ring |
| Supernova | Bright expanding shell that fades into scattered gas |

---

## 9. Acceptance Criteria

1. The app opens to a blank canvas with glass buttons on the right.
2. Clicking an element spawns a small cluster with slow random drift.
3. Clusters attract each other only within a mass-dependent range.
4. Enough hydrogen collapses, heats, ignites and becomes a star by physics alone.
5. Massive stars die in supernovae and leave remnants, including black holes.
6. Time controls work (Pause, 1x, 5x, 20x, 100x) without breaking the simulation.
7. Runs smoothly with a few thousand particles.
8. The only randomness is initial position, direction and speed.

---

## 10. Out of Scope (for now)

- Biological life, civilizations, or scoring systems.
- Realistic SI-scale distances.
- Multiplayer or saving to a server.

## 11. Future Ideas

- Goals or achievements ("form your first star", "create a black hole").
- Sandbox tools (delete, grab, throw bodies).
- Save and share a seed.
- Planetary systems with orbits and habitable zones.
