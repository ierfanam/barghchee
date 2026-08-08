const fs = require('fs');
let content = fs.readFileSync('human-avatar.ts', 'utf8');

// Add roomMesh to the class
content = content.replace(
  "private bulbLight!: THREE.PointLight;",
  "private bulbLight!: THREE.PointLight;\n  private roomMesh?: THREE.Mesh;"
);

// Update camera and add background in initScene
const initSceneOld = `    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 1.0, 8.0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 1.0, 0); 
    this.controls.minDistance = 1;
    this.controls.maxDistance = 15;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.2; 

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.05);
    this.scene.add(ambient);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
    rimLight.position.set(2, 2, -2);
    this.scene.add(rimLight);

    this.buildBulb();`;

const initSceneNew = `    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
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

    this.buildBulb();`;

content = content.replace(initSceneOld, initSceneNew);

// Make the bulb light reach further (from 15 to 50) and a bit warmer
content = content.replace(
  "this.bulbLight = new THREE.PointLight(0xfffcf0, 0, 15);",
  "this.bulbLight = new THREE.PointLight(0xffebd6, 0, 40);"
);

// Scale up the light intensity multiplier because the room is large
content = content.replace(
  "this.bulbLight.intensity = this.currentIntensity * 3;",
  "this.bulbLight.intensity = this.currentIntensity * 15;"
);

// Change the tube emissive color to warmer white
content = content.replace(
  "emissive: 0xfffcf0,",
  "emissive: 0xfff0d0,"
);

// Increase overall group Y position to move it higher
content = content.replace(
  "group.position.y = 0.3;",
  "group.position.y = 1.2;"
);

fs.writeFileSync('human-avatar.ts', content);
