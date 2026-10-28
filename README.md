# Space Life Simulation

An interactive, Conway's Game of Life-style sandbox for the cosmos. Start with a blank canvas, add elements, and watch real physics turn drifting gas into stars, planets, supernovae and black holes.

> **Status:** in development. The full build spec is in [`space-life-sim.md`](./space-life-sim.md).

## Idea

Nothing is scripted. The only random inputs are the **spawn position, direction and speed** of each cluster you add. After that, everything follows physical rules: gravity, thermodynamics, fusion and stellar evolution.

## Features

- **Blank canvas start.** Add elements one cluster at a time.
- **Element buttons:** H, He, C, O, Si, Fe. Hover a button to see the full name.
- **Cluster spawning.** Gases appear as small clusters of atoms with slow random drift.
- **Range-limited gravity.** Attraction reaches farther for more massive bodies.
- **Emergent objects:** gas giants, brown dwarfs, stars, white dwarfs, neutron stars and black holes.
- **Time controls:** Pause, 1x, 5x, 20x, 100x.
- **Clean glassmorphism UI.** Small rounded glass buttons on the right edge, with the canvas taking most of the screen.

## Physics

| Area | Model |
|---|---|
| Gravity | Newtonian `F = Gm₁m₂/r²` with softening and a mass-scaled range |
| Gas behavior | Ideal gas law, collision heating, radiative cooling |
| Collapse | Jeans mass criterion, angular momentum conservation, accretion disks |
| Chemistry | H₂ formation when cold, ionization to plasma when hot |
| Object formation | Planet (< ~13 M_J), brown dwarf (~13 to 80 M_J), star (≥ ~0.08 M☉) |
| Fusion | H → He → C → O → Ne → Si → Fe, stopping at iron |
| Stellar death | White dwarf (< ~8 M☉), supernova above that, then neutron star or black hole |
| Black holes | Event horizon at `r = 2GM/c²`, mass grows on absorption |

Real ratios and thresholds are used, with scaled constants and compressed timescales so the simulation runs in real time.

## Tech Stack

- **three.js** (WebGL) for rendering
- Vanilla JS (or React for UI only; the canvas stays outside React's render loop)
- Spatial hashing or an octree for fast range-limited gravity
- Built with **Google AI Studio** using the `gemini-4-argon` model

## Getting Started

The build steps depend on how the project is generated. Once the code is in this repo, this section will document them. A typical Vite-based flow looks like:

```bash
git clone <your-repo-url>
cd space-life-sim
npm install
npm run dev
```

## Roadmap

- [ ] Core particle and gravity engine
- [ ] Thermodynamics and gas collapse
- [ ] Fusion chain and stellar evolution
- [ ] Supernovae and remnants
- [ ] Glassmorphism UI and time controls
- [ ] Goals and achievements ("form your first star")
- [ ] Sandbox tools (delete, grab, throw)
- [ ] Save and share a seed
- [ ] Planetary systems with orbits

## Contributing

Issues and pull requests are welcome. Please keep new physics rules grounded in real science and document the source of any formula you add.

## License

Add a license of your choice (for example MIT) before publishing.
