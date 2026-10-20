import * as THREE from 'three'

/**
 * 表示空間で効かせる最終調整。媒体ごとに強さを変える。
 * グレイン / 色収差 / ヴィネット / ポスタライズ / 彩度 / リフト / 色被り
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.0 },
    uChroma: { value: 0.0 },
    uVignette: { value: 0.0 },
    uPosterize: { value: 0.0 },
    uSaturation: { value: 1.0 },
    uLift: { value: 0.0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    /** 転移演出用：0=通常 1=真っ白 / -1=真っ黒 */
    uFade: { value: 0.0 },
    /** グリッチ量（レンダリングバグの出口用） */
    uGlitch: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uGrain;
    uniform float uChroma;
    uniform float uVignette;
    uniform float uPosterize;
    uniform float uSaturation;
    uniform float uLift;
    uniform vec3 uTint;
    uniform float uFade;
    uniform float uGlitch;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;

      // --- グリッチ：横方向のずれ ---
      if (uGlitch > 0.001) {
        float band = floor(uv.y * 48.0);
        float n = hash(vec2(band, floor(uTime * 14.0)));
        float amt = step(1.0 - uGlitch * 0.55, n) * (n - 0.5) * 0.14 * uGlitch;
        uv.x = fract(uv.x + amt);
      }

      // --- 色収差 ---
      vec2 dir = uv - 0.5;
      float d = length(dir);
      float ca = uChroma * (0.35 + d * d * 2.2) + uGlitch * 0.004;
      vec3 col;
      if (ca > 0.00001) {
        col.r = texture2D(tDiffuse, uv + dir * ca).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - dir * ca).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // --- 彩度 / リフト / 色被り ---
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col += uLift;
      col *= uTint;

      // --- ポスタライズ ---
      if (uPosterize > 1.5) {
        col = floor(col * uPosterize + 0.5) / uPosterize;
      }

      // --- ヴィネット ---
      col *= 1.0 - uVignette * smoothstep(0.25, 0.95, d * 1.35);

      // --- グレイン ---
      if (uGrain > 0.0001) {
        float g = hash(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
        col += g * uGrain;
      }

      // --- 転移フェード ---
      if (uFade > 0.0) col = mix(col, vec3(1.0), uFade);
      else if (uFade < 0.0) col = mix(col, vec3(0.0), -uFade);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
}
