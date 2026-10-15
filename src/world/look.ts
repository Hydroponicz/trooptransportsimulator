import * as THREE from 'three';

/**
 * The look of the world: one place for the atmosphere and colour grade.
 *
 * Importing this module patches three's shader chunks (before anything
 * compiles) so that every fogged material gets aerial perspective instead of
 * flat distance fog: an exponential height fog (thick in the valleys, thin
 * over the peaks, so distant ranges stay readable as blue silhouettes) whose
 * colour warms toward the sun. Tone mapping gets a light grade on top of
 * ACES: a touch more saturation and an S-curve for contrast.
 */

/** Sun direction (towards the sun). Fixed: a sunny early afternoon. */
export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.42).normalize();
/** Blue haze at the horizon (fog colour, and the sky right at the horizon). */
export const HAZE = new THREE.Color(0xa7bdd3);
/** Haze looking toward the sun: warm, bright. */
export const SUN_HAZE = new THREE.Color(0xe9dcc0);
export const SKY_TOP = new THREE.Color(0x2e64b4);
export const SUN_COLOR = new THREE.Color(0xfff0d8);

/**
 * Fog parameters, carried in THREE.Fog's near/far uniforms:
 * near = scale height of the haze (m), far = 1 / density at sea level.
 */
export const FOG_SCALE_HEIGHT = 520;
export const FOG_RANGE = 11000;

const v3 = (v: THREE.Vector3) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
const c3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

const chunks = THREE.ShaderChunk as unknown as Record<string, string>;

chunks.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif
`;

chunks.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // Camera-to-vertex vector in world axes (view space rotated back).
  vFogRay = vec3(dot(viewMatrix[0].xyz, mvPosition.xyz), dot(viewMatrix[1].xyz, mvPosition.xyz), dot(viewMatrix[2].xyz, mvPosition.xyz));
#endif
`;

chunks.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  /** Optical depth of exponential height fog along the ray from the camera. */
  float worldFog(vec3 ray, out vec3 dir) {
    float dist = length(ray);
    dir = ray / max(dist, 1e-3);
    #ifdef FOG_EXP2
      return 1.0 - exp(- fogDensity * fogDensity * dist * dist);
    #else
      float b = 1.0 / fogNear;
      float a = 1.0 / fogFar;
      float k = b * ray.y;
      float shape = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
      float od = a * exp(-b * max(cameraPosition.y, -50.0)) * dist * shape;
      return 1.0 - exp(-od);
    #endif
  }
#endif
`;

chunks.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogDir;
  float fogFactor = worldFog(vFogRay, fogDir);
  float fogSun = pow(max(dot(fogDir, ${v3(SUN_DIR)}), 0.0), 6.0);
  vec3 fogTint = mix(fogColor, ${c3(SUN_HAZE)}, fogSun * 0.65);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogTint, fogFactor);
#endif
`;

chunks.tonemapping_pars_fragment = chunks.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
  vec3 c = ACESFilmicToneMapping( color );
  // Grade: a little more colour, and a gentle S-curve for contrast.
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = clamp( mix( vec3( l ), c, 1.07 ), 0.0, 1.0 );
  c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.28 );
  return c;
}`,
);
