import * as THREE from 'three';

export const FOG_COLOR = new THREE.Color(0xc4c7bb);
export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.42).normalize();

/** Sky dome, sun, ambient light and haze. (River water is in water.ts.) */
export class Environment {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    scene.fog = new THREE.Fog(FOG_COLOR, 900, 7500);
    scene.background = FOG_COLOR;

    this.hemi = new THREE.HemisphereLight(0xc9dcf2, 0x5d5440, 1.25);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d4, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 10;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    // Soft bounce light from the opposite side so shadowed faces keep their shape.
    const fill = new THREE.DirectionalLight(0xc8d4e0, 0.55);
    fill.position.set(-SUN_DIR.x, 0.4, -SUN_DIR.z);
    scene.add(fill);

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x4f7fb8) },
        horizon: { value: FOG_COLOR.clone() },
        sunDir: { value: SUN_DIR },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          col += vec3(1.0, 0.86, 0.6) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);
  }

  /** Keep the shadow frustum centered on the area of interest. */
  follow(target: THREE.Vector3, cameraPos: THREE.Vector3) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 400);
    this.sky.position.copy(cameraPos);
  }
}
