import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BodyClass,
  ELEMENTS,
  ELEMENT_ORDER,
  SIM_UNITS,
  temperatureToBlackbodyRGB,
} from './constants';
import { CelestialBody, SpaceSimulation } from './physics';

// Detect Software WebGL (SwiftShader / llvmpipe / Basic Render) from renderer string
export const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

// Pre-allocated module-scope scratch objects to guarantee Zero GC inside the render loop
const _dummyObj = new THREE.Object3D();
const _tempColor = new THREE.Color();
const _tempVec3 = new THREE.Vector3();
const _spinAxis = new THREE.Vector3(0, 1, 0);
const _upVec = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

interface BodyVisualRecord {
  group: THREE.Group;
  type: BodyClass;
  coreMesh: THREE.Mesh;
  coronaMesh: THREE.Mesh;
  diskMesh: THREE.Mesh;
  accentGroup: THREE.Group;
  glowSprite: THREE.Sprite;
  cutoffRing: THREE.LineLoop;
  pointLight?: THREE.PointLight;
}

interface ShockwaveVisualRecord {
  group: THREE.Group;
  outerShell: THREE.Mesh;
  innerRing: THREE.Mesh;
}

export class SpaceSceneRenderer {
  private container: HTMLElement;
  private sim: SpaceSimulation;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  private frameId = 0;
  private disposed = false;
  private lastTimestamp = 0;
  private physicsAccumulator = 0;

  // Visual toggles
  public showGravityCutoffRings = false;
  public selectedBodyId: number | null = null;
  private cameraFocusTarget = new THREE.Vector3(0, 0, 0);
  private isTrackingSelected = false;

  // Callbacks to notify UI at throttled intervals (never re-rendering canvas)
  private onTelemetryTick?: () => void;
  private onBodySelect?: (bodyId: number | null) => void;
  private telemetryTimer = 0;

  // Procedural textures
  private particleGlowTex!: THREE.CanvasTexture;
  private starGranulationTex!: THREE.CanvasTexture;
  private planetBandsTex!: THREE.CanvasTexture;
  private accretionDiskTex!: THREE.CanvasTexture;

  // Particle cloud buffers (THREE.Points) & Dust grain InstancedMesh
  private pointsGeometry!: THREE.BufferGeometry;
  private pointsPositions!: Float32Array;
  private pointsColors!: Float32Array;
  private pointsSizes!: Float32Array;
  private pointsCloud!: THREE.Points;

  private dustInstancedMesh!: THREE.InstancedMesh;

  // Background deep-field starlight (subtle parallax reference)
  private backgroundStars!: THREE.Points;

  // Body & Shockwave visual caches
  private bodyVisuals = new Map<number, BodyVisualRecord>();
  private shockwaveVisuals = new Map<number, ShockwaveVisualRecord>();

  // Raycasting for clicking celestial bodies
  private raycaster = new THREE.Raycaster();
  private pointerDownPos = new THREE.Vector2();

  constructor(
    container: HTMLElement,
    sim: SpaceSimulation,
    onTelemetryTick?: () => void,
    onBodySelect?: (bodyId: number | null) => void
  ) {
    this.container = container;
    this.sim = sim;
    this.onTelemetryTick = onTelemetryTick;
    this.onBodySelect = onBodySelect;

    // 1. Scene & Deep Space Atmosphere
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x03050a);
    this.scene.fog = new THREE.FogExp2(0x03050a, 0.0022);

    // 2. Camera
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 900);
    this.camera.position.set(0, 26, 48);

    // 3. Renderer (following Three.js skill studio & software-WebGL standards)
    this.renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.appendChild(this.renderer.domElement);

    // 4. Studio Environment Map (RoomEnvironment + PMREMGenerator)
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 5. Balanced Warm/Cool Studio & Cosmic Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x1e1b4b, 0.55);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.1);
    keyLight.position.set(35, 50, 30);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    rimLight.position.set(-40, -25, -35);
    this.scene.add(rimLight);

    // 6. OrbitControls (supports smooth orbit, pan, and zoom)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.maxDistance = 260;
    this.controls.minDistance = 2.5;
    this.controls.target.set(0, 0, 0);

    // 7. Generate 100% Procedural CanvasTextures
    this.initProceduralTextures();

    // 8. Initialize Subtle Deep-Space Background Starfield & Reference Grid
    this.initDeepSpaceBackdrop();

    // 9. Initialize Gas Particle Cloud & Dust Grain InstancedMesh
    this.initParticleSystems();

    // 10. Event Listeners (Resize & Body Selection Raycasting)
    window.addEventListener('resize', this.handleResize);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);

    if (!isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.lastTimestamp = performance.now();
    this.startLoop();
  }

  private initProceduralTextures(): void {
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // A. Soft Radial Glow Texture for Gas Particles & Star Halos
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = 128;
    glowCanvas.height = 128;
    const gCtx = glowCanvas.getContext('2d')!;
    const grad = gCtx.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.22, 'rgba(255, 255, 255, 0.78)');
    grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.22)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    gCtx.fillStyle = grad;
    gCtx.fillRect(0, 0, 128, 128);
    this.particleGlowTex = new THREE.CanvasTexture(glowCanvas);
    this.particleGlowTex.colorSpace = THREE.SRGBColorSpace;
    this.particleGlowTex.anisotropy = maxAnisotropy;

    // B. Stellar Convection Granulation Texture
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 256;
    starCanvas.height = 128;
    const sCtx = starCanvas.getContext('2d')!;
    sCtx.fillStyle = '#d4d4d8';
    sCtx.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 420; i++) {
      const x = ((i * 73) % 256);
      const y = ((i * 41) % 128);
      const r = 3 + (i % 7) * 2.2;
      const shade = 190 + (i % 65);
      const cellGrad = sCtx.createRadialGradient(x, y, 0.5, x, y, r);
      cellGrad.addColorStop(0, `rgb(${shade}, ${shade}, ${shade})`);
      cellGrad.addColorStop(1, 'rgba(140, 140, 150, 0)');
      sCtx.fillStyle = cellGrad;
      sCtx.beginPath();
      sCtx.arc(x, y, r, 0, Math.PI * 2);
      sCtx.fill();
    }
    this.starGranulationTex = new THREE.CanvasTexture(starCanvas);
    this.starGranulationTex.wrapS = THREE.RepeatWrapping;
    this.starGranulationTex.wrapT = THREE.RepeatWrapping;
    this.starGranulationTex.colorSpace = THREE.SRGBColorSpace;
    this.starGranulationTex.anisotropy = maxAnisotropy;

    // C. Planetary / Brown Dwarf Atmospheric Band Texture
    const bandCanvas = document.createElement('canvas');
    bandCanvas.width = 256;
    bandCanvas.height = 128;
    const bCtx = bandCanvas.getContext('2d')!;
    for (let y = 0; y < 128; y++) {
      const wave =
        Math.sin(y * 0.25) * 0.5 +
        Math.cos(y * 0.62) * 0.3 +
        Math.sin(y * 0.11) * 0.2;
      const v = Math.floor(175 + wave * 65);
      bCtx.fillStyle = `rgb(${v}, ${Math.floor(v * 0.92)}, ${Math.floor(v * 0.86)})`;
      bCtx.fillRect(0, y, 256, 1);
    }
    this.planetBandsTex = new THREE.CanvasTexture(bandCanvas);
    this.planetBandsTex.colorSpace = THREE.SRGBColorSpace;
    this.planetBandsTex.anisotropy = maxAnisotropy;

    // D. Accretion Disk Concentric Ring Texture
    const diskCanvas = document.createElement('canvas');
    diskCanvas.width = 256;
    diskCanvas.height = 256;
    const dCtx = diskCanvas.getContext('2d')!;
    dCtx.clearRect(0, 0, 256, 256);
    for (let r = 36; r < 124; r += 2) {
      const norm = (r - 36) / (124 - 36);
      const alpha = Math.sin(norm * Math.PI) * (0.65 + 0.35 * Math.sin(r * 0.7));
      dCtx.strokeStyle = `rgba(255, ${Math.floor(230 - norm * 110)}, ${Math.floor(190 - norm * 140)}, ${alpha * 0.75})`;
      dCtx.lineWidth = 2.2;
      dCtx.beginPath();
      dCtx.arc(128, 128, r, 0, Math.PI * 2);
      dCtx.stroke();
    }
    this.accretionDiskTex = new THREE.CanvasTexture(diskCanvas);
    this.accretionDiskTex.colorSpace = THREE.SRGBColorSpace;
    this.accretionDiskTex.anisotropy = maxAnisotropy;
  }

  private initDeepSpaceBackdrop(): void {
    // Distant faint background stars at radius ~380 so the canvas starts visually blank in the foreground
    // while giving subtle 3D camera orbit depth feedback
    const starCount = 700;
    const pos = new Float32Array(starCount * 3);
    const col = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // Deterministic Fibonacci distribution at far distance
      const y = 1 - (i / (starCount - 1)) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.399963229728653;
      const dist = 320 + (i % 5) * 35;
      pos[i * 3] = Math.cos(theta) * radius * dist;
      pos[i * 3 + 1] = y * dist;
      pos[i * 3 + 2] = Math.sin(theta) * radius * dist;

      const brightness = 0.16 + (i % 7) * 0.04;
      col[i * 3] = brightness * 0.88;
      col[i * 3 + 1] = brightness * 0.93;
      col[i * 3 + 2] = brightness;
    }

    const bgGeo = new THREE.BufferGeometry();
    bgGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bgGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const bgMat = new THREE.PointsMaterial({
      size: 1.1,
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.backgroundStars = new THREE.Points(bgGeo, bgMat);
    this.scene.add(this.backgroundStars);
  }

  private initParticleSystems(): void {
    const maxP = SIM_UNITS.MAX_PARTICLES;
    this.pointsPositions = new Float32Array(maxP * 3);
    this.pointsColors = new Float32Array(maxP * 3);
    this.pointsSizes = new Float32Array(maxP);

    this.pointsGeometry = new THREE.BufferGeometry();
    this.pointsGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pointsPositions, 3)
    );
    this.pointsGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.pointsColors, 3)
    );
    this.pointsGeometry.setAttribute(
      'size',
      new THREE.BufferAttribute(this.pointsSizes, 1)
    );

    const pointsShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        pointTexture: { value: this.particleGlowTex },
        pixelRatio: { value: this.renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(size * pixelRatio * (190.0 / max(1.0, -mvPosition.z)), 2.5, 48.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D pointTexture;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(pointTexture, gl_PointCoord);
          if (tex.a < 0.03) discard;
          gl_FragColor = vec4(vColor * 1.25, tex.a * 0.88);
        }
      `,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      vertexColors: true,
    });

    this.pointsCloud = new THREE.Points(this.pointsGeometry, pointsShaderMat);
    this.pointsCloud.frustumCulled = false;
    this.scene.add(this.pointsCloud);

    // InstancedMesh for solid dust grains (C, O, Si, Fe)
    const dustGeo = new THREE.IcosahedronGeometry(0.15, 0);
    const dustMat = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.35,
    });
    this.dustInstancedMesh = new THREE.InstancedMesh(dustGeo, dustMat, maxP);
    this.dustInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dustInstancedMesh.frustumCulled = false;
    this.dustInstancedMesh.count = 0;
    this.scene.add(this.dustInstancedMesh);
  }

  /**
   * Builds a Composite 4-7 Part Procedural Model (THREE.Group) for each CelestialBody class.
   * Never uses a single primitive!
   */
  private createCompositeBodyVisual(b: CelestialBody): BodyVisualRecord {
    const group = new THREE.Group();

    // 1. Primary Silhouette: Core Photosphere / Planetary Body / Singularity Horizon
    const coreGeo = new THREE.SphereGeometry(1, 32, 32);
    let coreMat: THREE.Material;

    if (b.type === 'black_hole') {
      coreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    } else if (
      b.type === 'main_sequence_star' ||
      b.type === 'red_giant' ||
      b.type === 'white_dwarf'
    ) {
      coreMat = new THREE.MeshStandardMaterial({
        map: this.starGranulationTex,
        roughness: 0.3,
        metalness: 0.1,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: this.starGranulationTex,
        emissiveIntensity: 1.8,
      });
    } else if (b.type === 'neutron_star') {
      coreMat = new THREE.MeshPhysicalMaterial({
        color: 0xe0f2fe,
        emissive: 0x38bdf8,
        emissiveIntensity: 2.2,
        metalness: 0.92,
        roughness: 0.12,
        clearcoat: 1.0,
      });
    } else {
      // Planet, Gas Giant, Brown Dwarf, Protostar
      coreMat = new THREE.MeshPhysicalMaterial({
        map: this.planetBandsTex,
        roughness: b.type === 'rocky_planet' ? 0.72 : 0.38,
        metalness: b.type === 'rocky_planet' ? 0.32 : 0.08,
        clearcoat: b.type === 'gas_giant' || b.type === 'brown_dwarf' ? 0.45 : 0.1,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0.4,
      });
    }
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    group.add(coreMesh);

    // 2. Secondary Read: Atmospheric Limb / Chromosphere Corona / Black Hole Photon Sphere
    const coronaGeo = new THREE.SphereGeometry(1.18, 28, 28);
    const coronaMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const coronaMesh = new THREE.Mesh(coronaGeo, coronaMat);
    group.add(coronaMesh);

    // 3. Secondary Read: Flattened Accretion Disk / Protoplanetary Disk / Planetary Ring
    const diskGeo = new THREE.RingGeometry(1.35, 3.6, 48, 2);
    diskGeo.rotateX(Math.PI / 2);
    const diskMat = new THREE.MeshBasicMaterial({
      map: this.accretionDiskTex,
      color: 0xfbbf24,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const diskMesh = new THREE.Mesh(diskGeo, diskMat);
    group.add(diskMesh);

    // 4. Accent Details Group (Prominence Loops, Relativistic Jets, Einstein Lensing Ring, Diffraction Spikes)
    const accentGroup = new THREE.Group();
    this.populateBodyAccentParts(accentGroup, b.type);
    group.add(accentGroup);

    // 5. Volumetric Glow Billboard Sprite
    const spriteMat = new THREE.SpriteMaterial({
      map: this.particleGlowTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glowSprite = new THREE.Sprite(spriteMat);
    group.add(glowSprite);

    // 6. Range-Limited Gravity Cutoff Ring (toggleable diagnostic visual)
    const ringPts: THREE.Vector3[] = [];
    const segs = 64;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    const cutoffGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    const cutoffMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
    });
    const cutoffRing = new THREE.LineLoop(cutoffGeo, cutoffMat);
    cutoffRing.visible = this.showGravityCutoffRings;
    group.add(cutoffRing);

    this.scene.add(group);

    return {
      group,
      type: b.type,
      coreMesh,
      coronaMesh,
      diskMesh,
      accentGroup,
      glowSprite,
      cutoffRing,
    };
  }

  private populateBodyAccentParts(accentGroup: THREE.Group, type: BodyClass): void {
    // Clear existing children
    while (accentGroup.children.length > 0) {
      const child = accentGroup.children[0] as THREE.Mesh;
      child.geometry?.dispose();
      accentGroup.remove(child);
    }

    if (type === 'black_hole') {
      // Part A: Glowing Photon Ring hugging Schwarzschild shadow
      const photonGeo = new THREE.TorusGeometry(1.08, 0.055, 16, 64);
      const photonMat = new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        blending: THREE.AdditiveBlending,
      });
      accentGroup.add(new THREE.Mesh(photonGeo, photonMat));

      // Part B: Gravitational Lensing Einstein Ring (perpendicular warped halo)
      const lensGeo = new THREE.TorusGeometry(1.55, 0.12, 16, 64);
      const lensMat = new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const lensMesh = new THREE.Mesh(lensGeo, lensMat);
      accentGroup.add(lensMesh);

      // Part C & D: Relativistic Polar Jets along +/- Y spin axis
      const jetGeo = new THREE.ConeGeometry(0.32, 4.8, 20, 1, true);
      const jetMat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const topJet = new THREE.Mesh(jetGeo, jetMat);
      topJet.position.y = 2.6;
      const botJet = new THREE.Mesh(jetGeo.clone(), jetMat);
      botJet.rotation.x = Math.PI;
      botJet.position.y = -2.6;
      accentGroup.add(topJet, botJet);
    } else if (type === 'neutron_star') {
      // Pulsar Bipolar Relativistic Beams + Magnetospheric Dipole Arcs
      const beamGeo = new THREE.ConeGeometry(0.28, 6.2, 16, 1, true);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const beam1 = new THREE.Mesh(beamGeo, beamMat);
      beam1.position.y = 3.1;
      const beam2 = new THREE.Mesh(beamGeo.clone(), beamMat);
      beam2.rotation.x = Math.PI;
      beam2.position.y = -3.1;

      const dipoleGeo = new THREE.TorusGeometry(1.6, 0.035, 12, 48);
      const dipoleMat = new THREE.MeshBasicMaterial({
        color: 0x818cf8,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
      });
      const dipole1 = new THREE.Mesh(dipoleGeo, dipoleMat);
      const dipole2 = new THREE.Mesh(dipoleGeo.clone(), dipoleMat);
      dipole2.rotation.y = Math.PI / 2;

      accentGroup.add(beam1, beam2, dipole1, dipole2);
      accentGroup.rotation.z = 0.42; // Magnetic axis obliquity tilt for lighthouse pulse!
    } else if (type === 'main_sequence_star' || type === 'red_giant') {
      // Solar Prominence Magnetic Loops around equator
      for (let i = 0; i < 3; i++) {
        const loopGeo = new THREE.TorusGeometry(1.06, 0.03, 10, 36, Math.PI);
        const loopMat = new THREE.MeshBasicMaterial({
          color: 0xfde047,
          transparent: true,
          opacity: 0.45,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const loop = new THREE.Mesh(loopGeo, loopMat);
        loop.rotation.y = (i * Math.PI * 2) / 3;
        loop.rotation.z = (i - 1) * 0.35;
        accentGroup.add(loop);
      }
    } else if (type === 'protostar') {
      // Bipolar Herbig-Haro Outflow Jets + Dusty Infall Envelope
      const outflowGeo = new THREE.ConeGeometry(0.4, 3.2, 16, 1, true);
      const outflowMat = new THREE.MeshBasicMaterial({
        color: 0xfb923c,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const j1 = new THREE.Mesh(outflowGeo, outflowMat);
      j1.position.y = 1.8;
      const j2 = new THREE.Mesh(outflowGeo.clone(), outflowMat);
      j2.rotation.x = Math.PI;
      j2.position.y = -1.8;
      accentGroup.add(j1, j2);
    } else {
      // Planet / Gas Giant / Brown Dwarf / White Dwarf: Subtle Equatorial Ringlet & Polar Aurora
      const ringletGeo = new THREE.TorusGeometry(1.55, 0.025, 10, 48);
      ringletGeo.rotateX(Math.PI / 2);
      const ringletMat = new THREE.MeshStandardMaterial({
        color: type === 'brown_dwarf' ? 0xf43f5e : 0x94a3b8,
        roughness: 0.5,
        metalness: 0.4,
        transparent: true,
        opacity: type === 'rocky_planet' ? 0.18 : 0.45,
      });
      accentGroup.add(new THREE.Mesh(ringletGeo, ringletMat));
    }
  }

  private syncBodiesToScene(elapsedSec: number): void {
    const activeIds = new Set<number>();

    for (let i = 0; i < this.sim.bodies.length; i++) {
      const b = this.sim.bodies[i];
      if (!b.alive) continue;
      activeIds.add(b.id);

      let rec = this.bodyVisuals.get(b.id);
      if (!rec) {
        rec = this.createCompositeBodyVisual(b);
        this.bodyVisuals.set(b.id, rec);
      } else if (rec.type !== b.type) {
        // Rebuild composite parts when body evolves (e.g. Protostar -> Star -> Red Giant -> Supernova Remnant)
        this.scene.remove(rec.group);
        rec = this.createCompositeBodyVisual(b);
        this.bodyVisuals.set(b.id, rec);
      }

      rec.group.position.set(b.x, b.y, b.z);

      // Scale primary core & corona
      const r = Math.max(0.35, b.radius);
      rec.coreMesh.scale.setScalar(r);
      rec.coronaMesh.scale.setScalar(r * 1.22);

      // Align disk & spin axis with conserved angular momentum vector L
      const spinMag = Math.hypot(b.spinX, b.spinY, b.spinZ);
      if (spinMag > 1e-4) {
        _spinAxis.set(b.spinX / spinMag, b.spinY / spinMag, b.spinZ / spinMag);
        _quat.setFromUnitVectors(_upVec, _spinAxis);
        rec.diskMesh.quaternion.copy(_quat);
      }

      // Spin animation
      const spinRate =
        b.type === 'neutron_star'
          ? 14.0
          : b.type === 'black_hole'
          ? 5.0
          : Math.min(4.0, 0.8 + spinMag * 2.5);
      rec.coreMesh.rotation.y = elapsedSec * spinRate;
      rec.diskMesh.rotation.y = elapsedSec * spinRate * 0.7;
      if (b.type === 'neutron_star') {
        rec.accentGroup.rotation.y = elapsedSec * 16.0;
        rec.accentGroup.scale.setScalar(r * 1.4);
      } else {
        rec.accentGroup.rotation.y = elapsedSec * 0.9;
        rec.accentGroup.scale.setScalar(r);
      }

      // Color by Blackbody Temperature or Object Class (Spec Section 8)
      this.applyBodyVisualStyle(b, rec, r);

      // Update range-limited gravity cutoff ring
      rec.cutoffRing.visible =
        this.showGravityCutoffRings || this.selectedBodyId === b.id;
      const invGroupScale = 1.0;
      rec.cutoffRing.scale.setScalar(b.cutoffRadius * invGroupScale);
      const ringMat = rec.cutoffRing.material as THREE.LineBasicMaterial;
      ringMat.opacity = this.selectedBodyId === b.id ? 0.55 : 0.18;
      ringMat.color.setHex(this.selectedBodyId === b.id ? 0xfbbf24 : 0x38bdf8);
    }

    // Remove visuals for merged or destroyed bodies
    for (const [id, rec] of this.bodyVisuals.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(rec.group);
        this.bodyVisuals.delete(id);
      }
    }
  }

  private applyBodyVisualStyle(b: CelestialBody, rec: BodyVisualRecord, r: number): void {
    const coronaMat = rec.coronaMesh.material as THREE.MeshBasicMaterial;
    const diskMat = rec.diskMesh.material as THREE.MeshBasicMaterial;
    const spriteMat = rec.glowSprite.material as THREE.SpriteMaterial;

    if (b.type === 'main_sequence_star' || b.type === 'red_giant') {
      // Blackbody color by temperature: red -> orange -> yellow -> white -> blue
      const [br, bg, bb] = temperatureToBlackbodyRGB(b.temperature);
      _tempColor.setRGB(br, bg, bb);

      const coreMat = rec.coreMesh.material as THREE.MeshStandardMaterial;
      coreMat.color.copy(_tempColor);
      coreMat.emissive.copy(_tempColor);
      coreMat.emissiveIntensity = b.type === 'red_giant' ? 1.55 : 2.1;

      coronaMat.color.copy(_tempColor);
      coronaMat.opacity = 0.34;

      spriteMat.color.copy(_tempColor);
      spriteMat.opacity = 0.78;
      rec.glowSprite.scale.setScalar(r * 6.2);

      // Show circumstellar accretion disk if gas is actively orbiting/accreting
      rec.diskMesh.visible = b.accretionDiskMass > 0.002;
      rec.diskMesh.scale.setScalar(r * 1.4);
      diskMat.color.copy(_tempColor);
      diskMat.opacity = Math.min(0.65, b.accretionDiskMass * 18);
    } else if (b.type === 'protostar') {
      // Dim, warm amber-orange glow inside a collapsing cloud
      _tempColor.setHex(0xf97316);
      const coreMat = rec.coreMesh.material as THREE.MeshPhysicalMaterial;
      coreMat.color.setHex(0xfb923c);
      coreMat.emissive.setHex(0xea580c);
      coreMat.emissiveIntensity = 1.25;

      coronaMat.color.setHex(0xf97316);
      coronaMat.opacity = 0.28;

      spriteMat.color.setHex(0xfb923c);
      spriteMat.opacity = 0.55;
      rec.glowSprite.scale.setScalar(r * 5.0);

      rec.diskMesh.visible = true;
      rec.diskMesh.scale.setScalar(r * 1.45);
      diskMat.color.setHex(0xf59e0b);
      diskMat.opacity = 0.55;
    } else if (b.type === 'brown_dwarf') {
      // Dark, faint red-magenta
      const coreMat = rec.coreMesh.material as THREE.MeshPhysicalMaterial;
      coreMat.color.setHex(0x9f1239);
      coreMat.emissive.setHex(0xbe185d);
      coreMat.emissiveIntensity = 0.65;

      coronaMat.color.setHex(0xdb2777);
      coronaMat.opacity = 0.18;

      spriteMat.color.setHex(0xe11d48);
      spriteMat.opacity = 0.34;
      rec.glowSprite.scale.setScalar(r * 3.4);

      rec.diskMesh.visible = b.accretionDiskMass > 0.001;
      rec.diskMesh.scale.setScalar(r * 1.1);
    } else if (b.type === 'gas_giant' || b.type === 'rocky_planet') {
      // Solid sphere tinted by dominant element composition
      const c = b.composition;
      const pr =
        c.H * 0.45 + c.He * 0.9 + c.C * 0.55 + c.O * 0.25 + c.Si * 0.88 + c.Fe * 0.78;
      const pg =
        c.H * 0.68 + c.He * 0.75 + c.C * 0.5 + c.O * 0.8 + c.Si * 0.55 + c.Fe * 0.36;
      const pb =
        c.H * 0.95 + c.He * 0.35 + c.C * 0.85 + c.O * 0.7 + c.Si * 0.3 + c.Fe * 0.32;
      _tempColor.setRGB(
        Math.max(0.25, Math.min(1, pr)),
        Math.max(0.25, Math.min(1, pg)),
        Math.max(0.25, Math.min(1, pb))
      );

      const coreMat = rec.coreMesh.material as THREE.MeshPhysicalMaterial;
      coreMat.color.copy(_tempColor);
      coreMat.emissive.copy(_tempColor);
      coreMat.emissiveIntensity = 0.18;

      coronaMat.color.copy(_tempColor);
      coronaMat.opacity = b.type === 'gas_giant' ? 0.16 : 0.09;

      spriteMat.color.copy(_tempColor);
      spriteMat.opacity = 0.22;
      rec.glowSprite.scale.setScalar(r * 2.5);

      rec.diskMesh.visible = b.type === 'gas_giant' && b.mass > 0.003;
      rec.diskMesh.scale.setScalar(r * 0.95);
      diskMat.color.copy(_tempColor);
      diskMat.opacity = 0.35;
    } else if (b.type === 'white_dwarf') {
      // Small, intense white-blue
      const coreMat = rec.coreMesh.material as THREE.MeshStandardMaterial;
      coreMat.color.setHex(0xe0f2fe);
      coreMat.emissive.setHex(0xbae6fd);
      coreMat.emissiveIntensity = 2.6;

      coronaMat.color.setHex(0x38bdf8);
      coronaMat.opacity = 0.42;

      spriteMat.color.setHex(0x7dd3fc);
      spriteMat.opacity = 0.88;
      rec.glowSprite.scale.setScalar(r * 7.5);
      rec.diskMesh.visible = b.accretionDiskMass > 0.001;
    } else if (b.type === 'neutron_star') {
      // Tiny, bright cyan-violet pulsing remnant
      coronaMat.color.setHex(0x38bdf8);
      coronaMat.opacity = 0.48;

      spriteMat.color.setHex(0x60a5fa);
      spriteMat.opacity = 0.85;
      rec.glowSprite.scale.setScalar(r * 8.0);
      rec.diskMesh.visible = true;
      rec.diskMesh.scale.setScalar(r * 1.4);
      diskMat.color.setHex(0x38bdf8);
      diskMat.opacity = 0.45;
    } else if (b.type === 'black_hole') {
      // Black sphere with thin glowing relativistic accretion ring & lensing halo
      coronaMat.color.setHex(0xf97316);
      coronaMat.opacity = 0.32;

      rec.diskMesh.visible = true;
      rec.diskMesh.scale.setScalar(r * 1.55);
      diskMat.color.setHex(0xfb923c);
      diskMat.opacity = 0.88;

      spriteMat.color.setHex(0xf59e0b);
      spriteMat.opacity = 0.52;
      rec.glowSprite.scale.setScalar(r * 6.2);
    }
  }

  private syncParticlesToScene(): void {
    const particles = this.sim.particles;
    const count = Math.min(particles.length, SIM_UNITS.MAX_PARTICLES);
    let dustCount = 0;

    for (let i = 0; i < count; i++) {
      const p = particles[i];
      this.pointsPositions[i * 3] = p.x;
      this.pointsPositions[i * 3 + 1] = p.y;
      this.pointsPositions[i * 3 + 2] = p.z;

      // Blend color from element composition + thermal heating glow
      let r = 0;
      let g = 0;
      let b = 0;
      for (const el of ELEMENT_ORDER) {
        const frac = p.composition[el];
        if (frac > 0) {
          const rgb = ELEMENTS[el].colorRGB;
          r += rgb[0] * frac;
          g += rgb[1] * frac;
          b += rgb[2] * frac;
        }
      }

      // Hot plasma shifts toward white-blue/amber blackbody emission
      if (p.temperature > 2500) {
        const heatFactor = Math.min(0.75, (p.temperature - 2500) / 18000);
        const [tr, tg, tb] = temperatureToBlackbodyRGB(p.temperature);
        r = r * (1 - heatFactor) + tr * heatFactor;
        g = g * (1 - heatFactor) + tg * heatFactor;
        b = b * (1 - heatFactor) + tb * heatFactor;
      }

      this.pointsColors[i * 3] = r;
      this.pointsColors[i * 3 + 1] = g;
      this.pointsColors[i * 3 + 2] = b;

      // Gas is softer/larger; dust grains are compact and also rendered as 3D faceted grains
      const massScale = Math.cbrt(p.mass / 0.0045);
      this.pointsSizes[i] =
        p.phase === 'dust'
          ? 1.9 * massScale
          : p.phase === 'plasma'
          ? 4.2 * massScale
          : 3.3 * massScale;

      if (p.phase === 'dust' && dustCount < SIM_UNITS.MAX_PARTICLES) {
        _dummyObj.position.set(p.x, p.y, p.z);
        _dummyObj.rotation.set(p.id * 0.7, p.age * 1.4, p.id * 1.3);
        _dummyObj.scale.setScalar(Math.max(0.6, Math.min(1.8, massScale)));
        _dummyObj.updateMatrix();
        this.dustInstancedMesh.setMatrixAt(dustCount, _dummyObj.matrix);
        _tempColor.setRGB(r, g, b);
        this.dustInstancedMesh.setColorAt(dustCount, _tempColor);
        dustCount++;
      }
    }

    this.pointsGeometry.setDrawRange(0, count);
    this.pointsGeometry.attributes.position.needsUpdate = true;
    this.pointsGeometry.attributes.color.needsUpdate = true;
    this.pointsGeometry.attributes.size.needsUpdate = true;

    this.dustInstancedMesh.count = dustCount;
    this.dustInstancedMesh.instanceMatrix.needsUpdate = true;
    if (this.dustInstancedMesh.instanceColor) {
      this.dustInstancedMesh.instanceColor.needsUpdate = true;
    }
  }

  private syncShockwavesToScene(): void {
    const activeSwIds = new Set<number>();

    for (let i = 0; i < this.sim.shockwaves.length; i++) {
      const sw = this.sim.shockwaves[i];
      activeSwIds.add(sw.id);

      let rec = this.shockwaveVisuals.get(sw.id);
      if (!rec) {
        const group = new THREE.Group();
        const outerGeo = new THREE.SphereGeometry(1, 32, 32);
        const outerMat = new THREE.MeshBasicMaterial({
          color: sw.colorHex,
          transparent: true,
          opacity: 0.6,
          blending: THREE.AdditiveBlending,
          side: THREE.BackSide,
          depthWrite: false,
        });
        const outerShell = new THREE.Mesh(outerGeo, outerMat);

        const ringGeo = new THREE.TorusGeometry(0.95, 0.08, 16, 64);
        ringGeo.rotateX(Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const innerRing = new THREE.Mesh(ringGeo, ringMat);

        group.add(outerShell, innerRing);
        this.scene.add(group);
        rec = { group, outerShell, innerRing };
        this.shockwaveVisuals.set(sw.id, rec);
      }

      const progress = Math.min(1, sw.age / sw.maxAge);
      const fade = Math.pow(1 - progress, 1.6);
      rec.group.position.set(sw.x, sw.y, sw.z);
      rec.outerShell.scale.setScalar(sw.radius);
      rec.innerRing.scale.setScalar(sw.radius * 0.92);
      (rec.outerShell.material as THREE.MeshBasicMaterial).opacity = fade * 0.55;
      (rec.innerRing.material as THREE.MeshBasicMaterial).opacity = fade * 0.8;
    }

    for (const [id, rec] of this.shockwaveVisuals.entries()) {
      if (!activeSwIds.has(id)) {
        this.scene.remove(rec.group);
        (rec.outerShell.geometry as THREE.BufferGeometry).dispose();
        (rec.innerRing.geometry as THREE.BufferGeometry).dispose();
        this.shockwaveVisuals.delete(id);
      }
    }
  }

  public focusOnPosition(x: number, y: number, z: number, trackBodyId?: number | null): void {
    this.cameraFocusTarget.set(x, y, z);
    if (trackBodyId !== undefined) {
      this.selectedBodyId = trackBodyId;
      this.isTrackingSelected = trackBodyId !== null;
      this.onBodySelect?.(this.selectedBodyId);
    }
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.pointerDownPos.set(e.clientX, e.clientY);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    const moveDist = Math.hypot(
      e.clientX - this.pointerDownPos.x,
      e.clientY - this.pointerDownPos.y
    );
    // Only treat as a click if pointer didn't drag the camera
    if (moveDist > 6) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    // Find closest intersected CelestialBody
    let closestBody: CelestialBody | null = null;
    let closestDist = Infinity;

    for (let i = 0; i < this.sim.bodies.length; i++) {
      const b = this.sim.bodies[i];
      if (!b.alive) continue;
      _tempVec3.set(b.x, b.y, b.z);
      const hitRadius = Math.max(1.2, b.radius * 1.8);
      const distToRay = this.raycaster.ray.distanceToPoint(_tempVec3);
      if (distToRay <= hitRadius) {
        const camDist = this.camera.position.distanceTo(_tempVec3);
        if (camDist < closestDist) {
          closestDist = camDist;
          closestBody = b;
        }
      }
    }

    if (closestBody) {
      this.selectedBodyId = closestBody.id;
      this.isTrackingSelected = true;
      this.cameraFocusTarget.set(closestBody.x, closestBody.y, closestBody.z);
      this.onBodySelect?.(closestBody.id);
    } else if (this.selectedBodyId !== null) {
      this.selectedBodyId = null;
      this.isTrackingSelected = false;
      this.onBodySelect?.(null);
    }
  };

  private handleResize = (): void => {
    if (this.disposed) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || !gl.fenceSync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private startLoop(): void {
    const tick = () => {
      if (this.disposed) return;
      const now = performance.now();
      const rawDt = Math.min(0.05, (now - this.lastTimestamp) / 1000);
      this.lastTimestamp = now;

      // Advance fixed-timestep physics scaled by timeScale (Pause, 1x, 5x, 20x, 100x)
      if (this.sim.timeScale > 0) {
        // Sub-step safely so high time multipliers (20x, 100x) stay numerically rock-solid
        const maxSubSteps =
          this.sim.timeScale >= 100
            ? 18
            : this.sim.timeScale >= 20
            ? 8
            : this.sim.timeScale >= 5
            ? 4
            : 1;
        const stepMultiplier = this.sim.timeScale / maxSubSteps;
        const effectiveDt = SIM_UNITS.FIXED_DT * Math.min(2.2, stepMultiplier);

        for (let s = 0; s < maxSubSteps; s++) {
          this.sim.stepPhysics(effectiveDt);
        }
      }

      // Smoothly damp camera focus toward selected body if tracking
      if (this.isTrackingSelected && this.selectedBodyId !== null) {
        const tracked = this.sim.bodies.find((b) => b.id === this.selectedBodyId);
        if (tracked) {
          this.cameraFocusTarget.set(tracked.x, tracked.y, tracked.z);
          this.controls.target.x = THREE.MathUtils.damp(
            this.controls.target.x,
            this.cameraFocusTarget.x,
            6,
            rawDt
          );
          this.controls.target.y = THREE.MathUtils.damp(
            this.controls.target.y,
            this.cameraFocusTarget.y,
            6,
            rawDt
          );
          this.controls.target.z = THREE.MathUtils.damp(
            this.controls.target.z,
            this.cameraFocusTarget.z,
            6,
            rawDt
          );
        } else {
          this.isTrackingSelected = false;
        }
      }

      this.controls.update();

      // Sync simulation state to Three.js GPU buffers
      const elapsedSec = now * 0.001;
      this.syncParticlesToScene();
      this.syncBodiesToScene(elapsedSec);
      this.syncShockwavesToScene();

      this.renderer.render(this.scene, this.camera);

      // Notify UI overlay at ~10Hz so React state never bottlenecks 60fps WebGL loop
      this.telemetryTimer += rawDt;
      if (this.telemetryTimer >= 0.1) {
        this.telemetryTimer = 0;
        this.onTelemetryTick?.();
      }

      if (isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    this.frameId = requestAnimationFrame(tick);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
