import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Helper to generate a procedural radial glow texture for the avatar aura.
 */
function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.2, 'rgba(56, 189, 248, 0.9)');
  grad.addColorStop(0.5, 'rgba(99, 102, 241, 0.45)');
  grad.addColorStop(0.8, 'rgba(168, 85, 247, 0.15)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

/**
 * Helper to generate a soft circular particle texture.
 */
function createParticleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.3, 'rgba(56, 189, 248, 0.85)');
  grad.addColorStop(0.7, 'rgba(99, 102, 241, 0.35)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

@customElement('gdm-human-avatar')
export class GdmHumanAvatar extends LitElement {
  @property({type: String}) aiState: 'idle' | 'listening' | 'processing' | 'speaking' = 'idle';

  private _outputNode!: AudioNode;
  private outputAnalyserCtx?: AnalyserNode;
  private outputFreqData?: Uint8Array;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    if (node && node.context) {
      try {
        this.outputAnalyserCtx = node.context.createAnalyser();
        this.outputAnalyserCtx.fftSize = 256;
        this.outputAnalyserCtx.smoothingTimeConstant = 0.8;
        this.outputFreqData = new Uint8Array(this.outputAnalyserCtx.frequencyBinCount);
        node.connect(this.outputAnalyserCtx);
      } catch (e) {
        console.warn('Output analyser connect error:', e);
      }
    }
  }
  get outputNode() { return this._outputNode; }

  private _inputNode!: AudioNode;
  private inputAnalyserCtx?: AnalyserNode;
  private inputFreqData?: Uint8Array;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    if (node && node.context) {
      try {
        this.inputAnalyserCtx = node.context.createAnalyser();
        this.inputAnalyserCtx.fftSize = 256;
        this.inputAnalyserCtx.smoothingTimeConstant = 0.8;
        this.inputFreqData = new Uint8Array(this.inputAnalyserCtx.frequencyBinCount);
        node.connect(this.inputAnalyserCtx);
      } catch (e) {
        console.warn('Input analyser connect error:', e);
      }
    }
  }
  get inputNode() { return this._inputNode; }

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private animFrameId = 0;

  // Avatar Model Components
  private avatarGroup = new THREE.Group();
  private logoGroup = new THREE.Group();
  private logoFrontMaterial!: THREE.MeshStandardMaterial;
  private logoBackMaterial!: THREE.MeshStandardMaterial;
  private auraSprite!: THREE.Sprite;
  private auraMaterial!: THREE.SpriteMaterial;
  private innerRing!: THREE.Mesh;
  private outerRing!: THREE.Mesh;
  private gyroRing!: THREE.Mesh;
  private pulseRing!: THREE.Mesh;
  private particles!: THREE.Points;
  private coreLight!: THREE.PointLight;
  private keyLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;

  // Dynamic animation and audio states
  private currentAudioLevel = 0;
  private targetAudioLevel = 0;
  private pulseProgress = 0;
  private targetTilt = { x: 0, y: 0 };
  private currentTilt = { x: 0, y: 0 };

  // Pointer interaction
  private pointerDownPos = { x: 0, y: 0, time: 0 };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      z-index: 5;
      pointer-events: none;
    }
    .canvas-container {
      width: 100%;
      height: 100%;
      pointer-events: auto;
      cursor: grab;
    }
    .canvas-container:active {
      cursor: grabbing;
    }
  `;

  firstUpdated() {
    this.initScene();
    this.renderLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.renderer?.dispose();
  }

  private initScene() {
    const container = this.shadowRoot!.querySelector('.canvas-container') as HTMLElement;
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    // Camera setup - Centered directly on the model avatar core
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 0, 5.2);

    // Controls setup
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 2.8;
    this.controls.maxDistance = 8.5;
    this.controls.minPolarAngle = Math.PI * 0.2;
    this.controls.maxPolarAngle = Math.PI * 0.8;
    this.controls.enablePan = false;

    // Ambient & Directional Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambientLight);

    this.keyLight = new THREE.DirectionalLight(0x38bdf8, 2.2);
    this.keyLight.position.set(3, 4, 4);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0xa855f7, 2.5);
    this.rimLight.position.set(-3, -2, -3);
    this.scene.add(this.rimLight);

    // PointLight at the center of the avatar body
    this.coreLight = new THREE.PointLight(0x38bdf8, 3.5, 12);
    this.coreLight.position.set(0, 0, 0.5);
    this.scene.add(this.coreLight);

    // Build the AI Model Body using logo.png
    this.buildModelAvatar();

    // Event listeners
    window.addEventListener('resize', this.onResize);
    window.addEventListener('mousemove', this.onMouseMove);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
  }

  private buildModelAvatar() {
    this.avatarGroup = new THREE.Group();
    this.scene.add(this.avatarGroup);

    this.logoGroup = new THREE.Group();
    this.avatarGroup.add(this.logoGroup);

    // 1. Load logo.png texture
    const textureLoader = new THREE.TextureLoader();
    const logoTexture = textureLoader.load('/logo.png');
    logoTexture.colorSpace = THREE.SRGBColorSpace;
    logoTexture.minFilter = THREE.LinearMipmapLinearFilter;
    logoTexture.magFilter = THREE.LinearFilter;

    // 2. Front and Back Logo Plates
    const plateGeo = new THREE.PlaneGeometry(2.5, 2.5);

    this.logoFrontMaterial = new THREE.MeshStandardMaterial({
      map: logoTexture,
      transparent: true,
      alphaTest: 0.02,
      roughness: 0.25,
      metalness: 0.35,
      emissive: 0x38bdf8,
      emissiveMap: logoTexture,
      emissiveIntensity: 0.3,
      side: THREE.FrontSide,
    });

    this.logoBackMaterial = new THREE.MeshStandardMaterial({
      map: logoTexture,
      transparent: true,
      alphaTest: 0.02,
      roughness: 0.25,
      metalness: 0.35,
      emissive: 0x38bdf8,
      emissiveMap: logoTexture,
      emissiveIntensity: 0.3,
      side: THREE.FrontSide,
    });

    const frontMesh = new THREE.Mesh(plateGeo, this.logoFrontMaterial);
    frontMesh.position.z = 0.03;
    this.logoGroup.add(frontMesh);

    const backMesh = new THREE.Mesh(plateGeo, this.logoBackMaterial);
    backMesh.position.z = -0.03;
    backMesh.rotation.y = Math.PI; // Face backwards
    this.logoGroup.add(backMesh);

    // 3. Cybernetic Bezel / Metallic Frame Ring around Logo
    const bezelGeo = new THREE.TorusGeometry(1.38, 0.05, 24, 80);
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.85,
      roughness: 0.15,
      emissive: 0x1e293b,
      emissiveIntensity: 0.4
    });
    const bezel = new THREE.Mesh(bezelGeo, bezelMat);
    this.logoGroup.add(bezel);

    // 4. Subtle Glass Reflection Shield
    const glassGeo = new THREE.CircleGeometry(1.36, 64);
    const glassMat = new THREE.MeshPhysicalMaterial({
      roughness: 0.1,
      transmission: 0.6,
      transparent: true,
      opacity: 0.3,
      metalness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      color: 0xffffff
    });
    const glassShield = new THREE.Mesh(glassGeo, glassMat);
    glassShield.position.z = 0.045;
    this.logoGroup.add(glassShield);

    // 5. Soft Radial Glow Aura Sprite behind Logo
    const glowTexture = createGlowTexture();
    this.auraMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.auraSprite = new THREE.Sprite(this.auraMaterial);
    this.auraSprite.scale.set(4.2, 4.2, 1.0);
    this.auraSprite.position.set(0, 0, -0.15);
    this.logoGroup.add(this.auraSprite);

    // 6. Orbital Energy Reactor Rings (Multi-Axis)
    const innerRingGeo = new THREE.TorusGeometry(1.65, 0.022, 16, 90);
    const innerRingMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x00f0ff,
      emissiveIntensity: 2.2,
      roughness: 0.2,
      metalness: 0.8
    });
    this.innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    this.innerRing.rotation.x = Math.PI / 6;
    this.logoGroup.add(this.innerRing);

    const outerRingGeo = new THREE.TorusGeometry(1.95, 0.018, 16, 90);
    const outerRingMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.8,
      roughness: 0.2,
      metalness: 0.8
    });
    this.outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    this.outerRing.rotation.y = Math.PI / 4;
    this.logoGroup.add(this.outerRing);

    const gyroRingGeo = new THREE.TorusGeometry(2.25, 0.014, 16, 90);
    const gyroRingMat = new THREE.MeshStandardMaterial({
      color: 0x818cf8,
      emissive: 0x818cf8,
      emissiveIntensity: 1.5,
      roughness: 0.3,
      metalness: 0.7
    });
    this.gyroRing = new THREE.Mesh(gyroRingGeo, gyroRingMat);
    this.gyroRing.rotation.x = -Math.PI / 5;
    this.logoGroup.add(this.gyroRing);

    // 7. Pulse Ripple Wave Ring (expands on vocal amplitude)
    const pulseGeo = new THREE.RingGeometry(1.3, 1.38, 64);
    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.pulseRing = new THREE.Mesh(pulseGeo, pulseMat);
    this.pulseRing.position.z = 0.01;
    this.logoGroup.add(this.pulseRing);

    // 8. Electrical Energy Spark Particles
    const particleCount = 140;
    const particleGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const particleData: Array<{ radius: number; speed: number; angle: number; y: number; phi: number }> = [];

    const c1 = new THREE.Color(0x38bdf8); // Cyan
    const c2 = new THREE.Color(0xf59e0b); // Gold
    const c3 = new THREE.Color(0xa855f7); // Purple

    for (let i = 0; i < particleCount; i++) {
      const radius = 1.7 + Math.random() * 1.5;
      const angle = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI * 0.75;
      const y = Math.sin(phi) * radius;
      const rPlane = Math.cos(phi) * radius;

      positions[i * 3] = Math.cos(angle) * rPlane;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * rPlane;

      const mix = Math.random();
      const pColor = mix < 0.6 ? c1 : (mix < 0.85 ? c2 : c3);
      colors[i * 3] = pColor.r;
      colors[i * 3 + 1] = pColor.g;
      colors[i * 3 + 2] = pColor.b;

      particleData.push({
        radius,
        speed: 0.003 + Math.random() * 0.007,
        angle,
        y,
        phi
      });
    }

    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    particleGeo.userData = { particleData };

    const particleMat = new THREE.PointsMaterial({
      size: 0.08,
      map: createParticleTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.particles = new THREE.Points(particleGeo, particleMat);
    this.avatarGroup.add(this.particles);
  }

  private onMouseMove = (e: MouseEvent) => {
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.targetTilt.y = x * 0.28;
    this.targetTilt.x = -y * 0.20;
  };

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY, time: Date.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    const duration = Date.now() - this.pointerDownPos.time;
    // If it's a click / tap (not a drag to orbit)
    if (dist < 12 && duration < 600) {
      this.dispatchEvent(new CustomEvent('click-avatar', {
        bubbles: true,
        composed: true
      }));
    }
  };

  private onResize = () => {
    if (!this.renderer || !this.camera) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private renderLoop = () => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);

    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    if (this.controls) {
      this.controls.update();
    }

    // 1. Calculate Real-Time Audio Reactivity
    let rawAudio = 0;
    if (this.aiState === 'listening' && this.inputAnalyserCtx && this.inputFreqData) {
      this.inputAnalyserCtx.getByteFrequencyData(this.inputFreqData);
      let sum = 0;
      for (let i = 0; i < this.inputFreqData.length; i++) {
        sum += this.inputFreqData[i];
      }
      rawAudio = (sum / this.inputFreqData.length) / 255.0;
    } else if (this.aiState === 'speaking' && this.outputAnalyserCtx && this.outputFreqData) {
      this.outputAnalyserCtx.getByteFrequencyData(this.outputFreqData);
      let sum = 0;
      for (let i = 0; i < this.outputFreqData.length; i++) {
        sum += this.outputFreqData[i];
      }
      rawAudio = (sum / this.outputFreqData.length) / 255.0;
    } else if (this.aiState === 'processing') {
      rawAudio = (Math.sin(elapsed * 5) * 0.15 + 0.15);
    }

    this.targetAudioLevel = rawAudio;
    this.currentAudioLevel += (this.targetAudioLevel - this.currentAudioLevel) * 0.18;

    // 2. Smooth Mouse Parallax Tilt
    this.currentTilt.x += (this.targetTilt.x - this.currentTilt.x) * 0.06;
    this.currentTilt.y += (this.targetTilt.y - this.currentTilt.y) * 0.06;

    // 3. Avatar Core Hover and Breathing Animation
    const hoverY = Math.sin(elapsed * 1.6) * 0.08;
    this.logoGroup.position.y = hoverY;
    this.logoGroup.rotation.x = this.currentTilt.x;
    this.logoGroup.rotation.y = this.currentTilt.y;

    // Audio-responsive Core Scale
    const baseScale = 1.0 + this.currentAudioLevel * 0.22;
    this.logoGroup.scale.set(baseScale, baseScale, baseScale);

    // 4. Color and Lighting Transitions based on aiState
    let targetEmissiveColor = 0x38bdf8;
    let targetLightColor = 0x38bdf8;
    let baseIntensity = 0.3;
    let lightIntensity = 2.5;
    let spinMultiplier = 1.0;

    switch (this.aiState) {
      case 'listening':
        targetEmissiveColor = 0x00f0ff;
        targetLightColor = 0x00f0ff;
        baseIntensity = 0.5 + this.currentAudioLevel * 1.8;
        lightIntensity = 3.5 + this.currentAudioLevel * 8.0;
        spinMultiplier = 1.8;
        break;
      case 'processing':
        targetEmissiveColor = 0xa855f7;
        targetLightColor = 0xc084fc;
        baseIntensity = 0.6 + Math.sin(elapsed * 6) * 0.3;
        lightIntensity = 4.0 + Math.sin(elapsed * 6) * 2.0;
        spinMultiplier = 2.8;
        break;
      case 'speaking':
        targetEmissiveColor = 0xf59e0b;
        targetLightColor = 0xfbbf24;
        baseIntensity = 0.6 + this.currentAudioLevel * 2.4;
        lightIntensity = 4.5 + this.currentAudioLevel * 12.0;
        spinMultiplier = 2.2;
        break;
      case 'idle':
      default:
        targetEmissiveColor = 0x38bdf8;
        targetLightColor = 0x38bdf8;
        baseIntensity = 0.3 + Math.sin(elapsed * 2) * 0.1;
        lightIntensity = 2.0 + Math.sin(elapsed * 2) * 0.6;
        spinMultiplier = 1.0;
        break;
    }

    if (this.logoFrontMaterial && this.logoBackMaterial) {
      this.logoFrontMaterial.emissive.setHex(targetEmissiveColor);
      this.logoFrontMaterial.emissiveIntensity = baseIntensity;
      this.logoBackMaterial.emissive.setHex(targetEmissiveColor);
      this.logoBackMaterial.emissiveIntensity = baseIntensity;
    }

    if (this.coreLight) {
      this.coreLight.color.setHex(targetLightColor);
      this.coreLight.intensity = lightIntensity;
    }

    if (this.auraMaterial && this.auraSprite) {
      this.auraMaterial.color.setHex(targetLightColor);
      const auraScale = 4.2 + this.currentAudioLevel * 2.0 + Math.sin(elapsed * 1.8) * 0.2;
      this.auraSprite.scale.set(auraScale, auraScale, 1.0);
      this.auraMaterial.opacity = 0.6 + this.currentAudioLevel * 0.4;
    }

    // 5. Spin Multi-Axis Reactor Rings
    if (this.innerRing) {
      this.innerRing.rotation.z += delta * 0.8 * spinMultiplier;
      this.innerRing.rotation.y += delta * 0.5 * spinMultiplier;
    }
    if (this.outerRing) {
      this.outerRing.rotation.z -= delta * 0.6 * spinMultiplier;
      this.outerRing.rotation.x += delta * 0.7 * spinMultiplier;
    }
    if (this.gyroRing) {
      this.gyroRing.rotation.y += delta * 0.4 * spinMultiplier;
      this.gyroRing.rotation.x -= delta * 0.3 * spinMultiplier;
    }

    // 6. Pulse Wave Expansion
    if (this.pulseRing) {
      if (this.currentAudioLevel > 0.08) {
        this.pulseProgress += delta * 2.5;
        if (this.pulseProgress > 1.0) this.pulseProgress = 0;
      } else {
        this.pulseProgress += delta * 0.8;
        if (this.pulseProgress > 1.0) this.pulseProgress = 0;
      }

      const pulseScale = 1.0 + this.pulseProgress * 0.8;
      this.pulseRing.scale.set(pulseScale, pulseScale, 1.0);
      const pulseMat = this.pulseRing.material as THREE.MeshBasicMaterial;
      pulseMat.color.setHex(targetLightColor);
      pulseMat.opacity = Math.max(0, (1.0 - this.pulseProgress) * 0.6 * (0.3 + this.currentAudioLevel * 2));
    }

    // 7. Update Orbiting Energy Spark Particles
    if (this.particles) {
      const geo = this.particles.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
      const positions = posAttr.array as Float32Array;
      const pData = geo.userData.particleData as Array<{ radius: number; speed: number; angle: number; y: number; phi: number }>;

      const speedFactor = 1.0 + this.currentAudioLevel * 3.0;

      for (let i = 0; i < pData.length; i++) {
        const p = pData[i];
        p.angle += p.speed * speedFactor;

        const rPlane = Math.cos(p.phi) * p.radius;
        positions[i * 3] = Math.cos(p.angle) * rPlane;
        positions[i * 3 + 1] = p.y + Math.sin(elapsed * 2 + i) * 0.05;
        positions[i * 3 + 2] = Math.sin(p.angle) * rPlane;
      }
      posAttr.needsUpdate = true;
    }

    // 8. Render Frame
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  render() {
    return html`
      <div class="canvas-container"></div>
    `;
  }
}
