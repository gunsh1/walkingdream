import * as THREE from 'three'

/**
 * 晴天の空。
 *
 * three の Sky（Preetham）は絶対的な明るさを制御しづらく、
 * 太陽光と釣り合わせられない＝空だけ白く飛ぶ。
 * ここでは「日向の白い面 = 1.0」を基準にした線形の放射輝度を直接指定する。
 * 実際の晴天では、天頂の空は日向の白より一桁暗い。だから青が濃く見える。
 */
export interface SkyDomeOptions {
  sunDir: THREE.Vector3
  /** 天頂の色（リニア、日向の白=1.0 基準） */
  zenith: THREE.Vector3
  /** 地平線の色 */
  horizon: THREE.Vector3
  /** 地平線より下（地面からの照り返し） */
  ground: THREE.Vector3
  /** 太陽まわりのにじみの色と強さ */
  sunTint: THREE.Vector3
  /** 天頂→地平線の切り替わりの鋭さ。大きいほど青が広い */
  falloff?: number
  radius?: number
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // 常に最奥
}
`

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunTint;
uniform vec3 uSunDir;
uniform float uFalloff;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float t = pow(1.0 - clamp(y, 0.0, 1.0), uFalloff);
  vec3 col = mix(uZenith, uHorizon, t);

  // 太陽のまわりの前方散乱と、太陽そのもの
  float c = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunTint * (pow(c, 7.0) * 0.28 + pow(c, 60.0) * 0.7);
  col += uSunTint * smoothstep(0.99965, 0.99992, c) * 120.0;

  // 地平線より下は地面の照り返しへ
  col = mix(uGround, col, smoothstep(-0.035, 0.015, y));
  gl_FragColor = vec4(col, 1.0);
}
`

export class SkyDome {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  constructor(opts: SkyDomeOptions) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: opts.zenith.clone() },
        uHorizon: { value: opts.horizon.clone() },
        uGround: { value: opts.ground.clone() },
        uSunTint: { value: opts.sunTint.clone() },
        uSunDir: { value: opts.sunDir.clone().normalize() },
        uFalloff: { value: opts.falloff ?? 5.5 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    const r = opts.radius ?? 1000
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), this.material)
    this.mesh.name = 'sky'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
  }

  /** 空そのものを環境光にする */
  makeEnvironment(renderer: THREE.WebGLRenderer) {
    const pmrem = new THREE.PMREMGenerator(renderer)
    const scene = new THREE.Scene()
    const probe = new THREE.Mesh(new THREE.SphereGeometry(20, 32, 20), this.material)
    scene.add(probe)
    const rt = pmrem.fromScene(scene, 0, 1, 60)
    pmrem.dispose()
    probe.geometry.dispose()
    return rt.texture
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
