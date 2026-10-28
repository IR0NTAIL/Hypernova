import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  BodyClass,
  ElementSymbol,
  ELEMENTS,
  ELEMENT_ORDER,
  SIM_UNITS,
} from './sim/constants';
import { CelestialBody, CosmicEventLog, SpaceSimulation } from './sim/physics';
import { isSoftwareGl, SpaceSceneRenderer } from './sim/renderer';
import { cosmicAudio } from './sim/audio';
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Eye,
  EyeOff,
  Compass,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Info,
  X,
  Hash,
} from 'lucide-react';

interface TelemetrySnapshot {
  particleCount: number;
  bodyCount: number;
  simTimeMyr: number;
  timeScale: number;
  clusterMultiplier: number;
  seed: string;
  bodies: CelestialBody[];
  events: CosmicEventLog[];
}

interface GeminiAnalysisReport {
  headline: string;
  thermodynamicState: string;
  nucleosynthesisAndFate: string;
  recommendedExperiment: string;
}

const BODY_CLASS_LABELS: Record<BodyClass, string> = {
  rocky_planet: 'Rocky Planet',
  gas_giant: 'Gas Giant',
  brown_dwarf: 'Brown Dwarf',
  protostar: 'Protostar',
  main_sequence_star: 'Main Sequence Star',
  red_giant: 'Red Giant / Supergiant',
  white_dwarf: 'White Dwarf',
  neutron_star: 'Neutron Star (Pulsar)',
  black_hole: 'Black Hole',
};

const TIME_MULTIPLIERS = [
  { label: 'Pause', value: 0 },
  { label: '1x', value: 1 },
  { label: '5x', value: 5 },
  { label: '20x', value: 20 },
  { label: '100x', value: 100 },
];

export default function App() {
  // Stable refs so the Three.js canvas and simulation loop NEVER re-render on React state updates
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<SpaceSimulation | null>(null);
  const rendererRef = useRef<SpaceSceneRenderer | null>(null);

  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    particleCount: 0,
    bodyCount: 0,
    simTimeMyr: 0,
    timeScale: 1,
    clusterMultiplier: 1,
    seed: 'HYPERNOVA-2026',
    bodies: [],
    events: [],
  });

  const [selectedBodyId, setSelectedBodyId] = useState<number | null>(null);
  const [hoveredElement, setHoveredElement] = useState<ElementSymbol | null>(null);
  const [showCutoffRings, setShowCutoffRings] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedInput, setSeedInput] = useState('HYPERNOVA-2026');

  // Gemini Astrophysical Analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [geminiReport, setGeminiReport] = useState<GeminiAnalysisReport | null>(null);
  const [geminiError, setGeminiError] = useState<string | null>(null);

  const syncTelemetryFromSim = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    setTelemetry({
      particleCount: sim.particles.length,
      bodyCount: sim.bodies.length,
      simTimeMyr: sim.simTimeMyr,
      timeScale: sim.timeScale,
      clusterMultiplier: sim.clusterMultiplier,
      seed: sim.rng.getSeedString(),
      bodies: sim.bodies.map((b) => ({
        ...b,
        composition: { ...b.composition },
      })),
      events: [...sim.events],
    });
  }, []);

  // Initialize deterministic simulation and Three.js scene once
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const sim = new SpaceSimulation('HYPERNOVA-2026');
    simRef.current = sim;

    const sceneRenderer = new SpaceSceneRenderer(
      container,
      sim,
      () => {
        syncTelemetryFromSim();
      },
      (bodyId) => {
        setSelectedBodyId(bodyId);
      }
    );
    rendererRef.current = sceneRenderer;

    return () => {
      sceneRenderer.dispose();
      rendererRef.current = null;
      simRef.current = null;
    };
  }, [syncTelemetryFromSim]);

  // Keyboard shortcuts (Space = Pause/Play, 1-5 = Time controls, H = Hide HUD, R = Reset)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const sim = simRef.current;
      if (!sim) return;

      if (e.code === 'Space') {
        e.preventDefault();
        sim.timeScale = sim.timeScale === 0 ? 1 : 0;
        syncTelemetryFromSim();
      } else if (e.key === '1') {
        sim.timeScale = 1;
        syncTelemetryFromSim();
      } else if (e.key === '2') {
        sim.timeScale = 5;
        syncTelemetryFromSim();
      } else if (e.key === '3') {
        sim.timeScale = 20;
        syncTelemetryFromSim();
      } else if (e.key === '4') {
        sim.timeScale = 100;
        syncTelemetryFromSim();
      } else if (e.key.toLowerCase() === 'h') {
        setHudCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [syncTelemetryFromSim]);

  const handleSpawnElement = (el: ElementSymbol) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.spawnElementCluster(el);
    syncTelemetryFromSim();
  };

  const handleSetTimeScale = (scale: number) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.timeScale = scale;
    syncTelemetryFromSim();
  };

  const handleSetClusterMultiplier = (mult: number) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.clusterMultiplier = mult;
    syncTelemetryFromSim();
  };

  const handleReset = (customSeed?: string) => {
    const sim = simRef.current;
    const renderer = rendererRef.current;
    if (!sim) return;
    sim.reset(customSeed);
    setSelectedBodyId(null);
    setGeminiReport(null);
    setGeminiError(null);
    if (renderer) {
      renderer.selectedBodyId = null;
      renderer.focusOnPosition(0, 0, 0, null);
    }
    syncTelemetryFromSim();
  };

  const handleToggleCutoffRings = () => {
    const next = !showCutoffRings;
    setShowCutoffRings(next);
    if (rendererRef.current) {
      rendererRef.current.showGravityCutoffRings = next;
    }
  };

  const handleToggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    cosmicAudio.setMuted(next);
  };

  const handleApplySeed = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = seedInput.trim() || 'HYPERNOVA-2026';
    setSeedInput(clean);
    handleReset(clean);
    setShowSeedModal(false);
  };

  const handleQuickExperiment = (preset: 'star' | 'supernova' | 'planetary') => {
    const sim = simRef.current;
    if (!sim) return;
    if (preset === 'star') {
      // Spawn 3 dense Hydrogen clusters + 1 Helium cluster so Jeans collapse ignites a Main Sequence Star
      sim.spawnElementCluster('H', 4);
      sim.spawnElementCluster('H', 4);
      sim.spawnElementCluster('H', 4);
      sim.spawnElementCluster('He', 1);
    } else if (preset === 'supernova') {
      // Spawn a massive primordial cloud (> 10 M☉) that collapses into a massive O-star, fuses to Fe, and goes Supernova
      for (let i = 0; i < 6; i++) {
        sim.spawnElementCluster('H', 12);
      }
      sim.spawnElementCluster('He', 4);
      sim.spawnElementCluster('C', 4);
    } else if (preset === 'planetary') {
      // Spawn a central star cloud surrounded by heavy element dust (C, O, Si, Fe)
      sim.spawnElementCluster('H', 4);
      sim.spawnElementCluster('H', 4);
      sim.spawnElementCluster('C', 1);
      sim.spawnElementCluster('O', 1);
      sim.spawnElementCluster('Si', 1);
      sim.spawnElementCluster('Fe', 1);
    }
    syncTelemetryFromSim();
  };

  const selectedBody =
    selectedBodyId !== null
      ? telemetry.bodies.find((b) => b.id === selectedBodyId) || null
      : null;

  const handleAnalyzeWithGemini = async (mode: 'body' | 'system') => {
    setIsAnalyzing(true);
    setGeminiError(null);
    try {
      const payload = {
        mode,
        selectedBody: selectedBody
          ? {
              ...selectedBody,
              massSolar: selectedBody.mass / SIM_UNITS.M_SUN,
              massJupiter: selectedBody.mass / SIM_UNITS.M_JUPITER,
            }
          : null,
        systemSummary: {
          simTimeMyr: telemetry.simTimeMyr,
          seed: telemetry.seed,
          particleCount: telemetry.particleCount,
          bodyCount: telemetry.bodyCount,
          bodies: telemetry.bodies.slice(0, 8).map((b) => ({
            name: b.name,
            type: BODY_CLASS_LABELS[b.type],
            massSolar: Number((b.mass / SIM_UNITS.M_SUN).toFixed(3)),
            coreTempK: Math.round(b.coreTemperature),
            fusionStage: b.fusionStage,
          })),
          recentEvents: telemetry.events.slice(0, 5).map((ev) => ev.title),
        },
      };

      const res = await fetch('/api/gemini/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to analyze astrophysical state.');
      }
      setGeminiReport(data);
    } catch (err: unknown) {
      setGeminiError(
        err instanceof Error ? err.message : 'Unable to reach astrophysical analysis service.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Glassmorphic surface helper (uses solid/translucent rgba without backdrop-filter on software WebGL)
  const glassSurfaceClass = isSoftwareGl
    ? 'bg-[#0b101e]/90 border border-white/15 shadow-lg'
    : 'bg-[#0b101e]/65 backdrop-blur-md border border-white/15 shadow-[0_8px_32px_rgba(0,0,0,0.45)]';

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#03050a] select-none">
      {/* 1. Full-Viewport Three.js WebGL Canvas Container (Isolated from React Re-renders) */}
      <div
        ref={canvasMountRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* 2. Subtle Top-Left Info Readout & Reset / Seed Controls (Spec Section 2) */}
      {!hudCollapsed && (
        <div className="pointer-events-none fixed top-4 left-4 z-20 flex flex-col items-start gap-2.5 max-w-[calc(100vw-5.5rem)]">
          <div className="flex flex-wrap items-center gap-2">
            {/* Brand & Live Telemetry Pill */}
            <div
              className={`pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-2xl w-fit ${glassSurfaceClass}`}
            >
              <div className="flex items-center gap-2">
                {/* Custom inline SVG Hypernova emblem */}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="text-sky-400 shrink-0"
                >
                  <circle cx="12" cy="12" r="4" fill="currentColor" />
                  <ellipse
                    cx="12"
                    cy="12"
                    rx="10"
                    ry="3.8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    transform="rotate(-24 12 12)"
                    strokeOpacity="0.75"
                  />
                  <path
                    d="M12 2V5M12 19V22M2 12H5M19 12H22"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeOpacity="0.55"
                  />
                </svg>
                <span className="text-sm sm:text-base font-semibold tracking-tight text-white whitespace-nowrap">
                  Hypernova
                </span>
              </div>

              <span className="text-white/20" aria-hidden="true">
                |
              </span>

              {/* Subtle telemetry readout (particle count, bodies, simulated cosmic time) */}
              <div className="flex items-center gap-2 text-xs text-slate-300 font-mono-tabular whitespace-nowrap">
                <span title="Loose gas and dust parcels">
                  {telemetry.particleCount} ptcl
                </span>
                <span className="text-white/25" aria-hidden="true">
                  ·
                </span>
                <span title="Condensed celestial bodies">
                  {telemetry.bodyCount} {telemetry.bodyCount === 1 ? 'body' : 'bodies'}
                </span>
                <span className="text-white/25" aria-hidden="true">
                  ·
                </span>
                <span title="Simulated cosmic time in Millions of Years">
                  {telemetry.simTimeMyr.toFixed(1)} Myr
                </span>
              </div>
            </div>

            {/* Dedicated Glass Action Buttons (Reset, Seed, Physics Guide) */}
            <div
              className={`pointer-events-auto flex items-center gap-1 p-1.5 rounded-2xl w-fit ${glassSurfaceClass}`}
            >
              <button
                onClick={() => handleReset()}
                title="Reset simulation canvas"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-slate-200 hover:text-white bg-white/[0.06] hover:bg-white/[0.14] border border-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
              <button
                onClick={() => setShowSeedModal(true)}
                title={`Deterministic RNG Seed: ${telemetry.seed}`}
                className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Hash className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setShowGuideModal(true)}
                title="Astrophysics Rules & Thresholds"
                className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Empty Canvas Prompt Hint (disappears as soon as the player adds their first element cluster) */}
          {telemetry.particleCount === 0 && telemetry.bodyCount === 0 && (
            <div
              className={`pointer-events-auto px-4 py-3 rounded-2xl text-xs text-slate-300 leading-relaxed max-w-md ${glassSurfaceClass}`}
            >
              <p className="text-white font-medium mb-1">
                Blank Cosmic Volume — Seed: <span className="font-mono-tabular text-sky-300">{telemetry.seed}</span>
              </p>
              <p className="text-slate-300/90 mb-2.5">
                Click elements on the right (<strong className="text-sky-300">H</strong>,{' '}
                <strong className="text-amber-300">He</strong>,{' '}
                <strong className="text-violet-300">C</strong>,{' '}
                <strong className="text-emerald-300">O</strong>,{' '}
                <strong className="text-orange-300">Si</strong>,{' '}
                <strong className="text-red-300">Fe</strong>) to inject drifting clusters, or launch a preset cloud:
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => handleQuickExperiment('star')}
                  className="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/30 text-sky-200 font-medium transition-colors cursor-pointer whitespace-nowrap"
                >
                  Ignite Protostar Cloud
                </button>
                <button
                  onClick={() => handleQuickExperiment('supernova')}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/30 text-amber-200 font-medium transition-colors cursor-pointer whitespace-nowrap"
                >
                  Supernova Progenitor
                </button>
                <button
                  onClick={() => handleQuickExperiment('planetary')}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/30 text-emerald-200 font-medium transition-colors cursor-pointer whitespace-nowrap"
                >
                  Protoplanetary Disk
                </button>
              </div>
            </div>
          )}

          {/* Condensed Bodies Quick Selector Strip (when bodies emerge) */}
          {telemetry.bodies.length > 0 && (
            <div
              className={`pointer-events-auto flex items-center gap-1.5 px-3 py-2 rounded-2xl overflow-x-auto max-w-full ${glassSurfaceClass}`}
            >
              <span className="text-[11px] text-slate-400 shrink-0 mr-1">Bodies:</span>
              {telemetry.bodies.slice(0, 6).map((b) => {
                const isSel = b.id === selectedBodyId;
                return (
                  <button
                    key={b.id}
                    onClick={() => {
                      setSelectedBodyId(b.id);
                      rendererRef.current?.focusOnPosition(b.x, b.y, b.z, b.id);
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-mono-tabular transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                      isSel
                        ? 'bg-sky-500/30 text-white border border-sky-400/50'
                        : 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white border border-transparent'
                    }`}
                  >
                    {b.name} · {b.mass >= 0.05 ? `${b.mass.toFixed(2)} M☉` : `${(b.mass / SIM_UNITS.M_JUPITER).toFixed(1)} Mj`}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3. Right-Edge Slim Vertical Element Button Panel (Spec Section 2 & 4) */}
      <div className="pointer-events-none fixed right-4 top-1/2 -translate-y-1/2 z-20 flex items-center gap-3">
        {/* Hover Tooltip showing full element name, atomic mass, and astrophysical role */}
        {hoveredElement && (
          <div
            className={`px-3.5 py-2.5 rounded-xl text-right transition-opacity duration-150 ${glassSurfaceClass}`}
          >
            <div className="text-sm font-semibold text-white whitespace-nowrap">
              {ELEMENTS[hoveredElement].name}{' '}
              <span className="text-xs font-mono-tabular text-slate-400">
                ({ELEMENTS[hoveredElement].atomicMass} u)
              </span>
            </div>
            <div className="text-xs text-slate-300 whitespace-nowrap mt-0.5">
              {ELEMENTS[hoveredElement].role}
            </div>
            <div className="text-[11px] font-mono-tabular text-sky-300/90 mt-1">
              Spawns {telemetry.clusterMultiplier === 1 ? 'diffuse cluster' : `${telemetry.clusterMultiplier}x dense cloud`}
            </div>
          </div>
        )}

        {/* Slim vertical glass panel of element buttons: H, He, C, O, Si, Fe */}
        <div
          className={`pointer-events-auto flex flex-col items-center gap-2 p-2 rounded-2xl ${glassSurfaceClass}`}
        >
          {ELEMENT_ORDER.map((symbol) => {
            const spec = ELEMENTS[symbol];
            return (
              <button
                key={symbol}
                onClick={() => handleSpawnElement(symbol)}
                onMouseEnter={() => setHoveredElement(symbol)}
                onMouseLeave={() =>
                  setHoveredElement((prev) => (prev === symbol ? null : prev))
                }
                aria-label={`${spec.name} (${spec.symbol}) — ${spec.role}`}
                className="group relative w-11 h-11 rounded-xl flex items-center justify-center font-semibold text-base tracking-tight text-white bg-white/[0.06] hover:bg-white/[0.15] active:scale-95 border border-white/15 transition-all duration-150 cursor-pointer"
                style={{
                  boxShadow:
                    hoveredElement === symbol
                      ? `0 0 18px ${spec.colorHex}55, inset 0 0 8px ${spec.colorHex}33`
                      : '0 2px 10px rgba(0,0,0,0.3)',
                }}
              >
                <span className="relative z-10">{spec.symbol}</span>
                {/* Subtle bottom color bar indicating element identity */}
                <span
                  className="absolute bottom-1.5 left-3 right-3 h-0.5 rounded-full opacity-75 group-hover:opacity-100 transition-opacity"
                  style={{ backgroundColor: spec.colorHex }}
                />
              </button>
            );
          })}

          <div className="w-7 h-px bg-white/10 my-0.5" />

          {/* Cluster Yield Multiplier button (1x, 4x, 12x) for forming massive stars & black holes effortlessly */}
          <button
            onClick={() => {
              const next =
                telemetry.clusterMultiplier === 1
                  ? 4
                  : telemetry.clusterMultiplier === 4
                  ? 12
                  : 1;
              handleSetClusterMultiplier(next);
            }}
            title="Cluster Density Multiplier (1x standard cluster, 4x dense cloud, 12x giant molecular cloud)"
            className="w-11 h-8 rounded-lg flex items-center justify-center text-xs font-mono-tabular font-medium text-sky-300 bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 transition-colors cursor-pointer"
          >
            {telemetry.clusterMultiplier}x
          </button>
        </div>
      </div>

      {/* 4. Selected Celestial Body Telemetry & Gemini Inspector (Top-Right / Floating Left of Element Bar) */}
      {selectedBody && !hudCollapsed && (
        <div
          className={`pointer-events-auto fixed top-4 right-20 z-20 w-80 p-4 rounded-2xl text-xs ${glassSurfaceClass}`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="text-[11px] font-medium text-sky-300">
                {BODY_CLASS_LABELS[selectedBody.type]}
              </div>
              <h2 className="text-base font-semibold text-white">
                {selectedBody.name}
              </h2>
            </div>
            <button
              onClick={() => {
                setSelectedBodyId(null);
                if (rendererRef.current) {
                  rendererRef.current.selectedBodyId = null;
                }
              }}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Close inspector"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 py-2 border-y border-white/10 font-mono-tabular">
            <div>
              <div className="text-[11px] text-slate-400">Mass</div>
              <div className="text-white font-medium">
                {selectedBody.mass >= 0.05
                  ? `${selectedBody.mass.toFixed(3)} M☉`
                  : `${(selectedBody.mass / SIM_UNITS.M_JUPITER).toFixed(1)} M_J`}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Core Temp</div>
              <div className="text-white font-medium">
                {selectedBody.coreTemperature >= 1e6
                  ? `${(selectedBody.coreTemperature / 1e6).toFixed(1)}M K`
                  : `${Math.round(selectedBody.coreTemperature).toLocaleString()} K`}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Surface Temp</div>
              <div className="text-white font-medium">
                {Math.round(selectedBody.temperature).toLocaleString()} K
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Gravity Reach</div>
              <div className="text-white font-medium">
                {selectedBody.cutoffRadius.toFixed(1)} u
              </div>
            </div>
          </div>

          <div className="mt-2.5">
            <div className="text-[11px] text-slate-400 mb-0.5">Active Process</div>
            <div className="text-xs font-medium text-amber-300">
              {selectedBody.fusionStage}
            </div>
          </div>

          {/* Element Composition Breakdown */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Composition</span>
              <span className="font-mono-tabular">
                H {(selectedBody.composition.H * 100).toFixed(0)}% · He{' '}
                {(selectedBody.composition.He * 100).toFixed(0)}% · Z{' '}
                {(
                  (selectedBody.composition.C +
                    selectedBody.composition.O +
                    selectedBody.composition.Si +
                    selectedBody.composition.Fe) *
                  100
                ).toFixed(0)}
                %
              </span>
            </div>
            <div className="w-full h-2 rounded-full overflow-hidden flex bg-white/10">
              {ELEMENT_ORDER.map((el) => {
                const pct = selectedBody.composition[el] * 100;
                if (pct < 0.5) return null;
                return (
                  <div
                    key={el}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: ELEMENTS[el].colorHex,
                    }}
                    title={`${ELEMENTS[el].name}: ${pct.toFixed(1)}%`}
                  />
                );
              })}
            </div>
          </div>

          {/* Gemini Astrophysical Telemetry Analysis Button */}
          <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center justify-between gap-2">
            <button
              onClick={() => handleAnalyzeWithGemini('body')}
              disabled={isAnalyzing}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/30 text-sky-200 font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {isAnalyzing ? 'Analyzing Telemetry...' : 'Spectroscopic Analysis'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Gemini Astrophysical Report Card */}
      {geminiReport && !hudCollapsed && (
        <div
          className={`pointer-events-auto fixed bottom-20 left-4 z-20 w-80 sm:w-96 p-4 rounded-2xl text-xs ${glassSurfaceClass}`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="text-[11px] text-sky-300 font-medium">
                Astrophysical Telemetry Report
              </div>
              <h3 className="text-sm font-semibold text-white">
                {geminiReport.headline}
              </h3>
            </div>
            <button
              onClick={() => setGeminiReport(null)}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-slate-300 leading-relaxed mb-2">
            {geminiReport.thermodynamicState}
          </p>
          <p className="text-slate-300 leading-relaxed mb-2.5">
            {geminiReport.nucleosynthesisAndFate}
          </p>
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-sky-200">
            <span className="font-semibold text-white">Next Experiment: </span>
            {geminiReport.recommendedExperiment}
          </div>
        </div>
      )}

      {geminiError && !hudCollapsed && (
        <div
          className={`pointer-events-auto fixed bottom-20 left-4 z-20 w-80 p-3 rounded-xl text-xs text-red-200 ${glassSurfaceClass}`}
        >
          <div className="flex items-center justify-between">
            <span>{geminiError}</span>
            <button
              onClick={() => setGeminiError(null)}
              className="p-1 hover:bg-white/10 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 5. Bottom-Center Glass Time Controls Bar (Spec Section 2: Pause, 1x, 5x, 20x, 100x) */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5">
        {/* Collapse / Expand HUD toggle tab */}
        <button
          onClick={() => setHudCollapsed((prev) => !prev)}
          title="Toggle HUD visibility (Shortcut: H)"
          className={`pointer-events-auto flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-medium text-slate-300 hover:text-white transition-colors cursor-pointer ${glassSurfaceClass}`}
        >
          {hudCollapsed ? (
            <>
              <ChevronUp className="w-3 h-3" />
              <span>Show HUD</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" />
              <span>Hide HUD</span>
            </>
          )}
        </button>

        {!hudCollapsed && (
          <div
            className={`pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl ${glassSurfaceClass}`}
          >
            {TIME_MULTIPLIERS.map((item) => {
              const active = telemetry.timeScale === item.value;
              return (
                <button
                  key={item.label}
                  onClick={() => handleSetTimeScale(item.value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono-tabular font-medium transition-all cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {item.value === 0 ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : item.value === 1 && active ? (
                    <Play className="w-3.5 h-3.5" />
                  ) : null}
                  <span>{item.label}</span>
                </button>
              );
            })}

            <div className="w-px h-5 bg-white/15 mx-1" />

            {/* Toggle Gravity Range Cutoff Rings */}
            <button
              onClick={handleToggleCutoffRings}
              title="Toggle mass-dependent gravity cutoff radius rings"
              className={`p-2 rounded-xl text-xs transition-colors cursor-pointer ${
                showCutoffRings
                  ? 'bg-sky-500/25 text-sky-300 border border-sky-400/40'
                  : 'text-slate-300 hover:text-white hover:bg-white/10'
              }`}
            >
              {showCutoffRings ? (
                <Eye className="w-4 h-4" />
              ) : (
                <EyeOff className="w-4 h-4" />
              )}
            </button>

            {/* Recenter Camera */}
            <button
              onClick={() => rendererRef.current?.focusOnPosition(0, 0, 0, null)}
              title="Recenter camera on cosmic origin"
              className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Compass className="w-4 h-4" />
            </button>

            {/* System-wide Gemini Astrophysical Briefing */}
            <button
              onClick={() => handleAnalyzeWithGemini('system')}
              disabled={isAnalyzing}
              title="Generate Astrophysical System Analysis"
              className="p-2 rounded-xl text-sky-300 hover:text-white hover:bg-sky-500/20 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
            </button>

            {/* Mute / Unmute Procedural Cosmic Synth */}
            <button
              onClick={handleToggleMute}
              title={isMuted ? 'Unmute cosmic audio' : 'Mute cosmic audio'}
              className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {isMuted ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* 6. Seed Configuration Modal (Deterministic Replay) */}
      {showSeedModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div
            className={`w-full max-w-md p-6 rounded-2xl ${glassSurfaceClass}`}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">
                Deterministic RNG Seed
              </h2>
              <button
                onClick={() => setShowSeedModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              In Hypernova, the only random inputs are the initial position, direction, and drift speed of each spawned cluster. Setting the same seed guarantees identical deterministic physics.
            </p>
            <form onSubmit={handleApplySeed} className="flex flex-col gap-3">
              <input
                type="text"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="Enter seed string..."
                className="w-full px-3.5 py-2 rounded-xl bg-black/40 border border-white/15 text-sm font-mono-tabular text-white focus:outline-none focus:border-sky-400"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSeedModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-sky-500 hover:bg-sky-400 text-slate-950 cursor-pointer"
                >
                  Apply Seed & Reset
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 7. Astrophysics Reference Modal */}
      {showGuideModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div
            className={`w-full max-w-lg p-6 rounded-2xl max-h-[85vh] overflow-y-auto ${glassSurfaceClass}`}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white">
                Hypernova Astrophysical Rules
              </h2>
              <button
                onClick={() => setShowGuideModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <div>
                <h3 className="text-white font-semibold mb-1">
                  1. Range-Limited Gravity & Jeans Collapse
                </h3>
                <p>
                  Bodies attract within a cutoff radius scaling with{' '}
                  <span className="font-mono-tabular text-sky-300">M^(1/3)</span>. Thermal gas pressure resists collapse until a cloud exceeds its Jeans Mass, spinning up and flattening into an accretion disk via conservation of angular momentum.
                </p>
              </div>

              <div>
                <h3 className="text-white font-semibold mb-1">
                  2. Emergent Object Thresholds
                </h3>
                <ul className="space-y-1 font-mono-tabular">
                  <li>
                    · &lt; 13 M_J: Gas Giant or Rocky Silicate-Iron Planet
                  </li>
                  <li>
                    · 13 to 80 M_J (up to 0.08 M☉): Brown Dwarf
                  </li>
                  <li>
                    · ≥ 0.08 M☉ with Core ≥ 10⁷ K: Main Sequence Star
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-white font-semibold mb-1">
                  3. Nucleosynthesis & Stellar Death
                </h3>
                <p>
                  Stars fuse <span className="font-mono-tabular text-sky-300">H → He → C → O → Si → Fe</span> with lifetime scaling as{' '}
                  <span className="font-mono-tabular text-amber-300">M^-2.5</span>. Fusion stops at Iron. Stars below 8 M☉ shed a planetary nebula and leave a White Dwarf (&lt; 1.4 M☉ Chandrasekhar limit). Stars above 8 M☉ detonate in a Core-Collapse Supernova, leaving a pulsing Neutron Star (≤ 2.6 M☉) or a Black Hole (&gt; 2.6 M☉).
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
