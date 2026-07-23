/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
const vs = `precision highp float;

in vec3 position;
out vec2 vPosition;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {
  vPosition = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;

const fs = `precision highp float;

out vec4 fragmentColor;
in vec2 vPosition;

uniform vec2 resolution;
uniform float time;
uniform float rand;
uniform float intensity; // Reactive to audio state

// Simplex noise-like utility
vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 p){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
           -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(p + dot(p, C.yy) );
  vec2 x0 = p -   i + dot(i, C.xx) ;
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 pVal = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
  + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
    dot(x12.zw,x12.zw)), 0.0);
  m = m*m ;
  m = m*m ;
  vec3 x = 2.0 * fract(pVal * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 a0 = x - floor(x + 0.5);
  vec3 g = sin(time * 0.1) * 0.1 + h - a0 * 1.5;
  m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 gVec = vec3(0.0);
  gVec.x = a0.x  * x0.x  + g.x  * x0.y;
  gVec.y = a0.y  * x12.x + g.y  * x12.y;
  gVec.z = a0.z  * x12.z + g.z  * x12.w;
  return 130.0 * dot(m, gVec);
}

void main() {
  float aspectRatio = resolution.x / resolution.y; 
  vec2 uv = gl_FragCoord.xy / resolution;
  
  // Base Glacier White (سفید یخچالی بسیار تمیز و باکلاس)
  vec3 glacierWhite = vec3(0.95, 0.97, 0.99);
  vec3 coolSilver = vec3(0.88, 0.91, 0.94);
  vec3 liquidBlue = vec3(0.78, 0.85, 0.95);
  vec3 activePink = vec3(0.96, 0.84, 0.91); // Very subtle warm glow when active

  // Dynamic flow coordinates
  vec2 flowUv1 = uv * 1.8 + vec2(time * 0.015, time * 0.008);
  vec2 flowUv2 = uv * 2.2 - vec2(time * 0.01, -time * 0.012);

  // Layered noise for organic morphing highlights
  float n1 = snoise(flowUv1);
  float n2 = snoise(flowUv2 + n1 * 0.3);
  
  // Create smooth, organic swirling mask
  float mixFactor = smoothstep(-0.6, 0.8, n2);
  
  // Blend base Glacier colors
  vec3 color = mix(glacierWhite, coolSilver, mixFactor * 0.7);
  
  // Add a soft, breathing blue/cyan dynamic light glow from the center
  vec2 centeredUv = uv - 0.5;
  centeredUv.x *= aspectRatio;
  float distToCenter = length(centeredUv);
  
  // Soft focus spotlight
  float spotGlow = smoothstep(0.8, 0.0, distToCenter);
  color = mix(color, liquidBlue, spotGlow * (0.15 + intensity * 0.1));

  // Add high-frequency subtle paper/frost grain for premium tactile depth
  float grainNoise = (fract(sin(dot(uv, vec2(12.9898 + rand, 78.233))) * 43758.5453));
  color += vec3(grainNoise) * 0.018;

  // Vignette to frame the volumetric 3D model
  float vignette = smoothstep(1.5, 0.5, distToCenter);
  color *= mix(0.93, 1.0, vignette);

  fragmentColor = vec4(color, 1.0);
}
`;

export {fs, vs};
