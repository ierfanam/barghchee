/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

/**
 * High-quality volumetric interactive 3D AI core visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private controls!: OrbitControls;
  
  // The core objects
  private logoGroup!: THREE.Group;
  private logoMesh!: THREE.Mesh;
  private logoGlow!: THREE.Mesh;
  private pulseRing!: THREE.Mesh;
  private particles!: THREE.Points;
  private particlesGeometry!: THREE.BufferGeometry;

  private clock = new THREE.Clock();

  // Mouse interaction state for camera parallax
  private targetMouse = new THREE.Vector2(0, 0);
  private currentMouse = new THREE.Vector2(0, 0);

  private _outputNode!: AudioNode;
  private _inputNode!: AudioNode;

  @property({type: String}) aiState: 'idle' | 'listening' | 'processing' | 'speaking' = 'idle';

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      cursor: pointer;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('mousemove', this.handleMouseMove);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('mousemove', this.handleMouseMove);
  }

  private handleMouseMove = (e: MouseEvent) => {
    // Map mouse position to -1 to 1 coordinates
    this.targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  };

  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020205); // Deep pitch black with a hint of blue
    scene.fog = new THREE.FogExp2(0x020205, 0.05);
    this.scene = scene;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    this.renderer = renderer;

    // --- Dynamic Environment Map for Realistic Glass Reflections ---
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    
    // Create a procedural env scene with glowing lights
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x000000);
    const envLight1 = new THREE.PointLight(0xff0055, 10, 20);
    envLight1.position.set(5, 5, 5);
    envScene.add(envLight1);
    const envLight2 = new THREE.PointLight(0x00aaff, 10, 20);
    envLight2.position.set(-5, -5, -5);
    envScene.add(envLight2);
    const envLight3 = new THREE.PointLight(0xffffff, 5, 20);
    envLight3.position.set(0, 5, -5);
    envScene.add(envLight3);
    
    const envCamera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    envCamera.position.z = 1;
    const renderTarget = pmremGenerator.fromScene(envScene);
    scene.environment = renderTarget.texture;

    // --- Logo Group ---
    this.logoGroup = new THREE.Group();
    scene.add(this.logoGroup);

    // --- Texture Loading ---
    const textureLoader = new THREE.TextureLoader();
    // Using Tavanir's official logo as it represents the Electricity Distribution Companies
    const logoTexture = textureLoader.load('https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Tavanir_logo.png/512px-Tavanir_logo.png');
    logoTexture.colorSpace = THREE.SRGBColorSpace;
    logoTexture.minFilter = THREE.LinearMipmapLinearFilter;
    logoTexture.magFilter = THREE.LinearFilter;

    // --- 3D Logo Coin (Cylinder) ---
    const coinGeometry = new THREE.CylinderGeometry(1.5, 1.5, 0.2, 64);
    // Rotate to face front
    coinGeometry.rotateX(Math.PI / 2);

    const coinMaterialFaces = new THREE.MeshPhysicalMaterial({
      map: logoTexture,
      transparent: true,
      alphaTest: 0.1,
      metalness: 0.8,
      roughness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      emissive: 0xffffff,
      emissiveMap: logoTexture,
      emissiveIntensity: 0.5,
    });

    const coinMaterialEdge = new THREE.MeshPhysicalMaterial({
      color: 0x0a192f,
      metalness: 0.9,
      roughness: 0.1,
      clearcoat: 1.0,
    });

    // Materials array: [edge, front face, back face]
    this.logoMesh = new THREE.Mesh(coinGeometry, [coinMaterialEdge, coinMaterialFaces, coinMaterialFaces]);
    this.logoGroup.add(this.logoMesh);

    // --- Outer Glow Ring ---
    const glowGeometry = new THREE.TorusGeometry(1.6, 0.05, 16, 100);
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: 0x00aaff,
      emissive: 0x00aaff,
      emissiveIntensity: 2.0,
    });
    this.logoGlow = new THREE.Mesh(glowGeometry, glowMaterial);
    this.logoGroup.add(this.logoGlow);

    // --- Pulse Ring ---
    const pulseGeometry = new THREE.TorusGeometry(1.6, 0.1, 16, 100);
    const pulseMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.pulseRing = new THREE.Mesh(pulseGeometry, pulseMaterial);
    this.logoGroup.add(this.pulseRing);

    // --- Particle Swarm (Data Stream) ---
    const particleCount = 3000;
    this.particlesGeometry = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    const particleColors = new Float32Array(particleCount * 3);
    const particleVelocities = [];

    const color1 = new THREE.Color(0x646cff);
    const color2 = new THREE.Color(0xff0055);

    for (let i = 0; i < particleCount; i++) {
      // Random spherical distribution
      const r = 2.5 + Math.random() * 3.0;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      particlePositions[i * 3] = x;
      particlePositions[i * 3 + 1] = y;
      particlePositions[i * 3 + 2] = z;

      // Mix colors
      const mixedColor = color1.clone().lerp(color2, Math.random());
      particleColors[i * 3] = mixedColor.r;
      particleColors[i * 3 + 1] = mixedColor.g;
      particleColors[i * 3 + 2] = mixedColor.b;

      // Orbit velocities
      particleVelocities.push({
        angle: theta,
        radius: r,
        speed: 0.002 + Math.random() * 0.005,
        yOffset: y
      });
    }

    this.particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    this.particlesGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    this.particlesGeometry.userData.velocities = particleVelocities;

    const particlesMaterial = new THREE.PointsMaterial({
      size: 0.03,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(this.particlesGeometry, particlesMaterial);
    scene.add(this.particles);

    // Lighting setup
    const mainLight = new THREE.PointLight(0x646cff, 50, 20);
    mainLight.position.set(0, 0, 0);
    scene.add(mainLight);

    const rimLight1 = new THREE.SpotLight(0xffcc00, 100);
    rimLight1.position.set(5, 5, 5);
    rimLight1.lookAt(0, 0, 0);
    scene.add(rimLight1);

    const rimLight2 = new THREE.SpotLight(0x00ffff, 100);
    rimLight2.position.set(-5, -5, -5);
    rimLight2.lookAt(0, 0, 0);
    scene.add(rimLight2);

    // Camera
    const camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    camera.position.set(0, 0, 10.0);
    this.camera = camera;

    // OrbitControls setup
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.enableZoom = false;

    // Post processing for cinematic look
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5, // Bloom strength (intense glow)
      0.5, // Radius
      0.1  // Threshold
    );

    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    this.composer = composer;

    const onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      
      const w = window.innerWidth;
      const h = window.innerHeight;
      
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };

    window.addEventListener('resize', onWindowResize);
    onWindowResize();

    this.animation();
  }

  private animation() {
    requestAnimationFrame(() => this.animation());

    const elapsedTime = this.clock.getElapsedTime();

    if (this.inputAnalyser) this.inputAnalyser.update();
    if (this.outputAnalyser) this.outputAnalyser.update();

    // Calculate Real-time Audio Volumetrics
    let userVol = 0;
    if (this.inputAnalyser && this.inputAnalyser.data) {
      let sum = 0;
      const len = this.inputAnalyser.data.length;
      for (let i = 0; i < len; i++) sum += this.inputAnalyser.data[i];
      userVol = sum / len / 255.0;
    }

    let modelVol = 0;
    if (this.outputAnalyser && this.outputAnalyser.data) {
      let sum = 0;
      const len = this.outputAnalyser.data.length;
      for (let i = 0; i < len; i++) sum += this.outputAnalyser.data[i];
      modelVol = sum / len / 255.0;
    }

    const combinedVolume = Math.max(userVol, modelVol);

    if (this.controls) {
      this.controls.update();
    }

    this.currentMouse.x += (this.targetMouse.x - this.currentMouse.x) * 0.05;
    this.currentMouse.y += (this.targetMouse.y - this.currentMouse.y) * 0.05;

    // Parallax on the entire group
    this.logoGroup.position.x = this.currentMouse.x * 0.5;
    this.logoGroup.position.y = this.currentMouse.y * 0.5;

    // Rotations
    // Idle rotation
    this.logoGroup.rotation.y = Math.sin(elapsedTime * 0.5) * 0.2 + (this.currentMouse.x * 0.2);
    this.logoGroup.rotation.x = Math.sin(elapsedTime * 0.3) * 0.1 + (-this.currentMouse.y * 0.2);

    // Scale slightly based on volume
    const baseScale = 1.0 + combinedVolume * 0.15;
    this.logoGroup.scale.setScalar(THREE.MathUtils.lerp(this.logoGroup.scale.x, baseScale, 0.1));

    // Update Particles
    const particlePositions = this.particlesGeometry.attributes.position.array as Float32Array;
    const velocities = this.particlesGeometry.userData.velocities;
    const activeSpeedMultiplier = 1.0 + combinedVolume * 10.0; // Particles speed up dramatically when speaking

    for (let i = 0; i < velocities.length; i++) {
      const v = velocities[i];
      v.angle += v.speed * activeSpeedMultiplier;
      
      // Calculate new position orbiting the center
      const x = v.radius * Math.cos(v.angle);
      const z = v.radius * Math.sin(v.angle);
      const y = v.yOffset + Math.sin(elapsedTime * 2.0 + v.angle) * 0.2; // Slight vertical wave

      particlePositions[i * 3] = x + this.currentMouse.x * 0.5;
      particlePositions[i * 3 + 1] = y + this.currentMouse.y * 0.5;
      particlePositions[i * 3 + 2] = z;
    }
    this.particlesGeometry.attributes.position.needsUpdate = true;
    this.particles.rotation.y = elapsedTime * 0.05;

    // State Colors & Emissive Logic
    const glowMat = this.logoGlow.material as THREE.MeshStandardMaterial;
    const faceMat = (this.logoMesh.material as THREE.MeshPhysicalMaterial[])[1];
    const pulseMat = this.pulseRing.material as THREE.MeshBasicMaterial;

    if (this.aiState === 'listening') {
      glowMat.emissive.setHex(0x10b981); // Emerald Green
      glowMat.emissiveIntensity = 2.0 + Math.sin(elapsedTime * 5.0) * 1.0;
      faceMat.emissiveIntensity = 0.5;
      
      this.pulseRing.scale.setScalar(THREE.MathUtils.lerp(this.pulseRing.scale.x, 1.0, 0.1));
      pulseMat.opacity = THREE.MathUtils.lerp(pulseMat.opacity, 0, 0.1);
    } else if (this.aiState === 'processing') {
      glowMat.emissive.setHex(0x3b82f6); // Blue
      glowMat.emissiveIntensity = 3.0 + Math.cos(elapsedTime * 10.0) * 2.0;
      faceMat.emissiveIntensity = 0.8;
      this.logoGroup.rotation.y += 0.05; // Spin faster when processing
      
      this.pulseRing.scale.setScalar(THREE.MathUtils.lerp(this.pulseRing.scale.x, 1.0, 0.1));
      pulseMat.opacity = THREE.MathUtils.lerp(pulseMat.opacity, 0, 0.1);
    } else if (this.aiState === 'speaking') {
      glowMat.emissive.setHex(0xf59e0b); // Amber/Gold
      glowMat.emissiveIntensity = 2.0 + modelVol * 15.0; // High reactivity
      faceMat.emissiveIntensity = 0.5 + modelVol * 2.0;
      
      // Synchronize pulse ring with model output volume
      const pulseScale = 1.0 + modelVol * 2.5; // Expand based on volume
      this.pulseRing.scale.setScalar(THREE.MathUtils.lerp(this.pulseRing.scale.x, pulseScale, 0.3));
      
      const pulseOpacity = Math.min(1.0, Math.max(0, modelVol * 1.5 - 0.1));
      pulseMat.opacity = THREE.MathUtils.lerp(pulseMat.opacity, pulseOpacity, 0.3);
      pulseMat.color.setHex(0xf59e0b); // Match gold color
    } else {
      glowMat.emissive.setHex(0x0a192f); // Default dark blue
      glowMat.emissiveIntensity = 1.0;
      faceMat.emissiveIntensity = 0.2;
      
      this.pulseRing.scale.setScalar(THREE.MathUtils.lerp(this.pulseRing.scale.x, 1.0, 0.1));
      pulseMat.opacity = THREE.MathUtils.lerp(pulseMat.opacity, 0, 0.1);
    }

    this.composer.render();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    
    this.canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('click-orb', {bubbles: true, composed: true}));
    });

    this.init();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}


