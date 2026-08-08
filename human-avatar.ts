import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
      this.outputAnalyserCtx = node.context.createAnalyser();
      this.outputAnalyserCtx.fftSize = 512;
      this.outputFreqData = new Uint8Array(this.outputAnalyserCtx.frequencyBinCount);
      node.connect(this.outputAnalyserCtx);
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
      this.inputAnalyserCtx = node.context.createAnalyser();
      this.inputAnalyserCtx.fftSize = 512;
      this.inputFreqData = new Uint8Array(this.inputAnalyserCtx.frequencyBinCount);
      node.connect(this.inputAnalyserCtx);
    }
  }
  get inputNode() { return this._inputNode; }

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private animFrameId = 0;

  private bulbMaterial!: THREE.MeshStandardMaterial;
  private bulbLight!: THREE.PointLight;
  private roomMesh?: THREE.Mesh;
  
  private currentIntensity = 0;

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
      cursor: pointer;
    }
  `;

  constructor() {
    super();
  }

  firstUpdated() {
    this.initScene();
    this.renderLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    this.renderer?.dispose();
  }

  private initScene() {
    const container = this.shadowRoot!.querySelector('.canvas-container') as HTMLElement;
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 1.0, 5.0); // zoomed in

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 1.5, 0); // look higher at the bulb
    this.controls.minDistance = 2;
    this.controls.maxDistance = 10;
    
    // limit rotation so they don't see distortion at poles
    this.controls.minPolarAngle = Math.PI / 3;
    this.controls.maxPolarAngle = Math.PI / 1.8;
    this.controls.minAzimuthAngle = -Math.PI / 4;
    this.controls.maxAzimuthAngle = Math.PI / 4;

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.02); // very dark when off
    this.scene.add(ambient);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.05);
    rimLight.position.set(2, 2, -2);
    this.scene.add(rimLight);

    // Nostalgic Room Background
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load('/room.jpg', (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        
        // Large sphere to act as a room
        const roomGeo = new THREE.SphereGeometry(25, 64, 32);
        const roomMat = new THREE.MeshStandardMaterial({
            map: texture,
            side: THREE.BackSide,
            roughness: 1.0,
            metalness: 0.0
        });
        this.roomMesh = new THREE.Mesh(roomGeo, roomMat);
        // rotate so the center of the image is at front (-z)
        this.roomMesh.rotation.y = -Math.PI / 2;
        this.scene.add(this.roomMesh);
    });

    this.buildBulb();

    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
  }

  private onPointerDown = (e: PointerEvent) => {
    this.dispatchEvent(new CustomEvent('click-avatar', {
      bubbles: true,
      composed: true
    }));
  }

  private buildBulb() {
    const group = new THREE.Group();

    // 1. Cord from ceiling
    const cordLength = 8.0;
    const cordGeo = new THREE.CylinderGeometry(0.012, 0.012, cordLength, 16);
    const cordMat = new THREE.MeshStandardMaterial({ 
        color: 0x222222, 
        roughness: 0.9,
        metalness: 0.0
    });
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.y = 0.78 + cordLength / 2;
    group.add(cord);

    // 2. Socket (سرپیچ)
    const socketGroup = new THREE.Group();
    
    const gripGeo = new THREE.CylinderGeometry(0.02, 0.03, 0.08, 16);
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    const grip = new THREE.Mesh(gripGeo, gripMat);
    grip.position.y = 0.74; // 0.70 to 0.78
    socketGroup.add(grip);

    const capGeo = new THREE.CylinderGeometry(0.03, 0.10, 0.15, 32);
    const socketMat = new THREE.MeshStandardMaterial({ 
        color: 0xf5f5f5, 
        roughness: 0.2,
        metalness: 0.1
    });
    const cap = new THREE.Mesh(capGeo, socketMat);
    cap.position.y = 0.625; // 0.55 to 0.70
    socketGroup.add(cap);

    const bodyGeo = new THREE.CylinderGeometry(0.10, 0.10, 0.25, 32);
    const body = new THREE.Mesh(bodyGeo, socketMat);
    body.position.y = 0.425; // 0.30 to 0.55
    socketGroup.add(body);

    // Socket ribs
    const ribGeo = new THREE.TorusGeometry(0.102, 0.005, 16, 32);
    const ribMat = new THREE.MeshStandardMaterial({ color: 0xeaeaea, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
        const rib = new THREE.Mesh(ribGeo, ribMat);
        rib.rotation.x = Math.PI / 2;
        rib.position.y = 0.35 + i * 0.05;
        socketGroup.add(rib);
    }
    group.add(socketGroup);

    // 3. Bulb Base (Ballast)
    const baseGroup = new THREE.Group();

    // Neck (inside socket)
    const baseNeckGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.10, 32);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const baseNeck = new THREE.Mesh(baseNeckGeo, baseMat);
    baseNeck.position.y = 0.30; // 0.25 to 0.35
    baseGroup.add(baseNeck);

    // Taper
    const baseTaperGeo = new THREE.CylinderGeometry(0.07, 0.13, 0.10, 32);
    const baseTaper = new THREE.Mesh(baseTaperGeo, baseMat);
    baseTaper.position.y = 0.20; // 0.15 to 0.25
    baseGroup.add(baseTaper);

    // Body
    const baseBodyGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.15, 32);
    const baseBody = new THREE.Mesh(baseBodyGeo, baseMat);
    baseBody.position.y = 0.075; // 0.0 to 0.15
    baseGroup.add(baseBody);

    group.add(baseGroup);

    // 4. Spiral CFL Tube
    const cflHelix = new THREE.Curve<THREE.Vector3>();
    cflHelix.getPoint = function(t: number, optionalTarget = new THREE.Vector3()) {
        const turns = 4.5;
        const radius = 0.10; 
        const height = 0.6;
        const startY = 0.0;
        
        if (t < 0.48) {
            const p = t / 0.48; 
            const angle = p * Math.PI * 2 * turns;
            const y = startY - p * height;
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        } else if (t > 0.52) {
            const p = (t - 0.52) / 0.48; 
            const y = startY - height + p * height;
            const angle = (1 - p) * Math.PI * 2 * turns + Math.PI;
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        } else {
            const p = (t - 0.48) / 0.04; 
            const angle = p * Math.PI;
            const y = startY - height - Math.sin(angle) * 0.02; 
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        }
    };
    
    const tubeGeo = new THREE.TubeGeometry(cflHelix as any, 300, 0.025, 32, false);
    
    this.bulbMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xfff0d0,
        emissiveIntensity: 0,
        roughness: 0.1,
        transparent: true,
        opacity: 0.95
    });

    const tube = new THREE.Mesh(tubeGeo, this.bulbMaterial);
    group.add(tube);
    
    // Scale up the entire bulb more as requested
    group.scale.set(1.9, 1.9, 1.9);

    // Adjust group position to keep it centered in view
    group.position.y = 1.2;

    this.bulbLight = new THREE.PointLight(0xffebd6, 0, 40);
    this.bulbLight.position.set(0, -0.3, 0); 
    group.add(this.bulbLight);

    this.scene.add(group);
  }

  private onResize = () => {
    if (!this.renderer) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private renderLoop = () => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);
    
    if (this.controls) this.controls.update();

    let targetInt = 0;
    const isOn = this.aiState !== 'idle';

    if (isOn) {
        // Base intensity of the bulb when it's just on
        targetInt = 0.2; 

        let volume = 0;
        
        if (this.aiState === 'listening' && this.inputAnalyserCtx && this.inputFreqData) {
            this.inputAnalyserCtx.getByteFrequencyData(this.inputFreqData);
            let sum = 0;
            for (let i = 0; i < this.inputFreqData.length; i++) {
                sum += this.inputFreqData[i];
            }
            volume = (sum / this.inputFreqData.length) / 255.0;
        } else if (this.aiState === 'speaking' && this.outputAnalyserCtx && this.outputFreqData) {
            this.outputAnalyserCtx.getByteFrequencyData(this.outputFreqData);
            let sum = 0;
            for (let i = 0; i < this.outputFreqData.length; i++) {
                sum += this.outputFreqData[i];
            }
            volume = (sum / this.outputFreqData.length) / 255.0;
        } else if (this.aiState === 'processing') {
            // Pulse gently while processing
            volume = Math.sin(this.clock.getElapsedTime() * 4) * 0.1 + 0.1;
        }

        // A 100W bulb is very bright, so when there is sound we boost heavily
        targetInt += volume * 4.0;
    }

    // Smooth out intensity changes
    this.currentIntensity += (targetInt - this.currentIntensity) * 0.15;

    if (this.bulbMaterial) {
        this.bulbMaterial.emissiveIntensity = this.currentIntensity;
    }
    if (this.bulbLight) {
        this.bulbLight.intensity = this.currentIntensity * 15; 
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  render() {
    return html`
      <div class="canvas-container"></div>
    `;
  }
}
