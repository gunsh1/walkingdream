import * as THREE from 'three'

/**
 * 平面の水。1ワールドにつき水面は1レベルという前提。
 *  - 反射：鏡像カメラで半解像度 RT に描画
 *  - 屈折：水を隠したシーンを半解像度 RT に描画（深度テクスチャ付き）
 *  - 波紋：512x512 の ping-pong RT で波動方程式。足が水を切るたびにインパルスを注入
 */

const MAX_IMPULSES = 8

const RIPPLE_STEP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uDamping;
uniform float uSpeed;
uniform int uImpulseCount;
uniform vec3 uImpulses[${MAX_IMPULSES}]; // xy = uv, z = 強さ
varying vec2 vUv;

void main() {
  vec2 s = texture2D(uPrev, vUv).rg;
  float h = s.r;
  float hPrev = s.g;

  float l = texture2D(uPrev, vUv + vec2(-uTexel.x, 0.0)).r;
  float r = texture2D(uPrev, vUv + vec2( uTexel.x, 0.0)).r;
  float u = texture2D(uPrev, vUv + vec2(0.0, -uTexel.y)).r;
  float d = texture2D(uPrev, vUv + vec2(0.0,  uTexel.y)).r;

  float lap = (l + r + u + d) - 4.0 * h;
  float next = (2.0 * h - hPrev + uSpeed * lap) * uDamping;

  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    if (i >= uImpulseCount) break;
    vec3 imp = uImpulses[i];
    float dist = length((vUv - imp.xy) / uTexel) ;
    next += imp.z * exp(-dist * dist / 6.0);
  }

  // 端は固定して反射させない
  float edge = step(2.0 * uTexel.x, vUv.x) * step(2.0 * uTexel.y, vUv.y)
             * step(vUv.x, 1.0 - 2.0 * uTexel.x) * step(vUv.y, 1.0 - 2.0 * uTexel.y);
  next *= edge;

  gl_FragColor = vec4(next, h, 0.0, 1.0);
}
`

const WATER_VERT = /* glsl */ `
uniform mat4 uTextureMatrix;
uniform vec2 uAreaMin;
uniform vec2 uAreaSize;
varying vec4 vReflectCoord;
varying vec3 vWorldPos;
varying vec2 vRippleUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vRippleUv = (wp.xz - uAreaMin) / uAreaSize;
  vReflectCoord = uTextureMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uReflect;
uniform sampler2D uRefract;
uniform sampler2D uDepth;
uniform sampler2D uRipple;
uniform vec2 uResolution;
uniform vec2 uRippleTexel;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uAbsorption;
uniform float uDistortion;
uniform float uReflectivity;
uniform float uRippleStrength;
uniform float uWaveStrength;
uniform float uFoamWidth;
uniform float uSpecular;

varying vec4 vReflectCoord;
varying vec3 vWorldPos;
varying vec2 vRippleUv;

float linearEyeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

// 小さな環境波（常時ゆれている分）
vec3 waveNormal(vec2 p, float t) {
  float a = sin(p.x * 2.7 + t * 0.9) * cos(p.y * 2.1 - t * 0.7);
  float b = sin(p.x * 5.3 - t * 1.3 + 1.7) * cos(p.y * 4.7 + t * 1.1);
  float c = sin((p.x + p.y) * 9.1 + t * 2.1);
  float dx = a * 0.55 + b * 0.28 + c * 0.09;
  float dz = (cos(p.x * 2.7 + t * 0.9) * 0.5 + sin(p.y * 4.7 + t * 1.1) * 0.3);
  return vec3(dx, 0.0, dz);
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution;

  // --- 法線 ---
  float hl = texture2D(uRipple, vRippleUv - vec2(uRippleTexel.x, 0.0)).r;
  float hr = texture2D(uRipple, vRippleUv + vec2(uRippleTexel.x, 0.0)).r;
  float hu = texture2D(uRipple, vRippleUv - vec2(0.0, uRippleTexel.y)).r;
  float hd = texture2D(uRipple, vRippleUv + vec2(0.0, uRippleTexel.y)).r;
  vec3 rippleN = vec3((hl - hr) * uRippleStrength, 0.0, (hu - hd) * uRippleStrength);
  vec3 waveN = waveNormal(vWorldPos.xz, uTime) * uWaveStrength;
  vec3 N = normalize(vec3(0.0, 1.0, 0.0) + rippleN + waveN);

  vec3 V = normalize(cameraPosition - vWorldPos);

  // --- 屈折と水深 ---
  vec2 offset = N.xz * uDistortion;
  float rawDepth = texture2D(uDepth, screenUv + offset).x;
  float sceneEye = linearEyeDepth(rawDepth);
  float fragEye = linearEyeDepth(gl_FragCoord.z);
  float waterDepth = sceneEye - fragEye;
  if (waterDepth < 0.0) {
    // 水より手前に物がある：歪ませない
    offset = vec2(0.0);
    rawDepth = texture2D(uDepth, screenUv).x;
    sceneEye = linearEyeDepth(rawDepth);
    waterDepth = max(0.0, sceneEye - fragEye);
  }
  vec3 refr = texture2D(uRefract, screenUv + offset).rgb;

  float absorb = 1.0 - exp(-waterDepth * uAbsorption);
  vec3 tint = mix(uShallow, uDeep, clamp(absorb, 0.0, 1.0));
  vec3 underwater = mix(refr * mix(vec3(1.0), tint, 0.55), tint, absorb * 0.85);

  // --- 反射 ---
  vec2 refUv = vReflectCoord.xy / max(vReflectCoord.w, 0.0001);
  refUv += N.xz * uDistortion * 1.6;
  vec3 refl = texture2D(uReflect, clamp(refUv, 0.002, 0.998)).rgb;

  float fresnel = uReflectivity + (1.0 - uReflectivity) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  fresnel = clamp(fresnel, 0.0, 1.0);
  vec3 color = mix(underwater, refl, fresnel);

  // --- 岸のあわ ---
  float foam = 1.0 - smoothstep(0.0, uFoamWidth, waterDepth);
  float rippleFoam = clamp(abs(texture2D(uRipple, vRippleUv).r) * 14.0, 0.0, 1.0);
  color = mix(color, uFoam, foam * 0.55 + rippleFoam * 0.18);

  // --- ハイライト ---
  vec3 H = normalize(normalize(uSunDir) + V);
  float spec = pow(max(dot(N, H), 0.0), 190.0) * uSpecular;
  color += uSunColor * spec;

  gl_FragColor = vec4(color, 1.0);
}
`

export interface WaterOptions {
  level: number
  /** 水面の XZ 範囲 */
  min: THREE.Vector2
  max: THREE.Vector2
  shallow: number
  deep: number
  foam: number
  sunDir: THREE.Vector3
  sunColor: number
  absorption?: number
  distortion?: number
  reflectivity?: number
  rippleStrength?: number
  waveStrength?: number
  foamWidth?: number
  specular?: number
  /** 反射・屈折 RT の解像度倍率 */
  rtScale?: number
  /**
   * 水面の形。省略すると min..max の矩形。
   * 穴の開いた水面を作りたい時は、ワールド XZ 座標系（y=0平面上）の
   * ジオメトリを渡す。メッシュは (0, level, 0) に置かれる。
   */
  geometry?: THREE.BufferGeometry
}

export class Water {
  readonly mesh: THREE.Mesh
  readonly level: number
  private material: THREE.ShaderMaterial
  private rtReflect: THREE.WebGLRenderTarget
  private rtRefract: THREE.WebGLRenderTarget
  private depthTexture: THREE.DepthTexture
  private rtScale: number

  private ripplesA: THREE.WebGLRenderTarget
  private ripplesB: THREE.WebGLRenderTarget
  private rippleMat: THREE.ShaderMaterial
  private rippleScene: THREE.Scene
  private rippleCam: THREE.OrthographicCamera
  private rippleSize = 512
  private pendingImpulses: number[] = []
  private impulseCount = 0

  private reflectCam = new THREE.PerspectiveCamera()
  private textureMatrix = new THREE.Matrix4()
  private areaMin: THREE.Vector2
  private areaSize: THREE.Vector2
  private accum = 0

  constructor(renderer: THREE.WebGLRenderer, opts: WaterOptions) {
    this.level = opts.level
    this.rtScale = opts.rtScale ?? 0.5
    this.areaMin = opts.min.clone()
    this.areaSize = new THREE.Vector2(opts.max.x - opts.min.x, opts.max.y - opts.min.y)

    const size = renderer.getSize(new THREE.Vector2())
    const rw = Math.max(2, Math.floor(size.x * this.rtScale))
    const rh = Math.max(2, Math.floor(size.y * this.rtScale))

    this.depthTexture = new THREE.DepthTexture(rw, rh)
    this.depthTexture.type = THREE.UnsignedIntType
    this.depthTexture.format = THREE.DepthFormat
    this.depthTexture.minFilter = THREE.NearestFilter
    this.depthTexture.magFilter = THREE.NearestFilter

    this.rtRefract = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture: this.depthTexture,
      type: THREE.HalfFloatType,
    })
    this.rtReflect = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
    })

    // --- 波紋シミュレーション ---
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    }
    this.ripplesA = new THREE.WebGLRenderTarget(this.rippleSize, this.rippleSize, rtOpts)
    this.ripplesB = new THREE.WebGLRenderTarget(this.rippleSize, this.rippleSize, rtOpts)
    this.rippleMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: new THREE.Vector2(1 / this.rippleSize, 1 / this.rippleSize) },
        uDamping: { value: 0.985 },
        uSpeed: { value: 0.32 },
        uImpulseCount: { value: 0 },
        uImpulses: { value: Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector3()) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: RIPPLE_STEP_FRAG,
      depthTest: false,
      depthWrite: false,
    })
    this.rippleScene = new THREE.Scene()
    this.rippleScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.rippleMat))
    this.rippleCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // --- 水面メッシュ ---
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uReflect: { value: this.rtReflect.texture },
        uRefract: { value: this.rtRefract.texture },
        uDepth: { value: this.depthTexture },
        uRipple: { value: this.ripplesA.texture },
        uResolution: { value: new THREE.Vector2(size.x, size.y) },
        uRippleTexel: { value: new THREE.Vector2(1 / this.rippleSize, 1 / this.rippleSize) },
        uTextureMatrix: { value: this.textureMatrix },
        uAreaMin: { value: this.areaMin },
        uAreaSize: { value: this.areaSize },
        uTime: { value: 0 },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
        uShallow: { value: new THREE.Color(opts.shallow) },
        uDeep: { value: new THREE.Color(opts.deep) },
        uFoam: { value: new THREE.Color(opts.foam) },
        uSunDir: { value: opts.sunDir.clone().normalize() },
        uSunColor: { value: new THREE.Color(opts.sunColor) },
        uAbsorption: { value: opts.absorption ?? 1.1 },
        uDistortion: { value: opts.distortion ?? 0.035 },
        uReflectivity: { value: opts.reflectivity ?? 0.09 },
        uRippleStrength: { value: opts.rippleStrength ?? 6.0 },
        uWaveStrength: { value: opts.waveStrength ?? 0.014 },
        uFoamWidth: { value: opts.foamWidth ?? 0.14 },
        uSpecular: { value: opts.specular ?? 1.2 },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
    })

    let geo: THREE.BufferGeometry
    let cx = 0
    let cz = 0
    if (opts.geometry) {
      geo = opts.geometry
    } else {
      geo = new THREE.PlaneGeometry(this.areaSize.x, this.areaSize.y, 1, 1)
      geo.rotateX(-Math.PI / 2)
      cx = this.areaMin.x + this.areaSize.x / 2
      cz = this.areaMin.y + this.areaSize.y / 2
    }
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.position.set(cx, opts.level, cz)
    this.mesh.renderOrder = 1
    this.mesh.name = 'water'
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
    this.mesh.updateMatrixWorld(true)
  }

  /** ワールド座標に波紋を立てる */
  splash(x: number, z: number, strength: number) {
    if (this.impulseCount >= MAX_IMPULSES) return
    const u = (x - this.areaMin.x) / this.areaSize.x
    const v = (z - this.areaMin.y) / this.areaSize.y
    if (u < 0 || u > 1 || v < 0 || v > 1) return
    this.pendingImpulses.push(u, v, strength)
    this.impulseCount++
  }

  setSize(width: number, height: number) {
    const rw = Math.max(2, Math.floor(width * this.rtScale))
    const rh = Math.max(2, Math.floor(height * this.rtScale))
    this.rtRefract.setSize(rw, rh)
    this.rtReflect.setSize(rw, rh)
    this.depthTexture.image.width = rw
    this.depthTexture.image.height = rh
    this.depthTexture.needsUpdate = true
    this.material.uniforms.uResolution.value.set(width, height)
  }

  /** 本描画の前に呼ぶ。scene から水面を一時的に隠して2回描く。 */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number) {
    this.accum += dt
    this.material.uniforms.uTime.value = this.accum
    this.material.uniforms.uNear.value = camera.near
    this.material.uniforms.uFar.value = camera.far

    this.stepRipples(renderer, dt)

    const prevTarget = renderer.getRenderTarget()
    const wasVisible = this.mesh.visible
    this.mesh.visible = false

    // 屈折（水を除いた通常視点）
    renderer.setRenderTarget(this.rtRefract)
    renderer.clear()
    renderer.render(scene, camera)

    // 反射（鏡像カメラ）
    this.updateReflectCamera(camera)
    renderer.setRenderTarget(this.rtReflect)
    renderer.clear()
    const prevShadow = renderer.shadowMap.enabled
    renderer.shadowMap.enabled = false
    renderer.render(scene, this.reflectCam)
    renderer.shadowMap.enabled = prevShadow

    renderer.setRenderTarget(prevTarget)
    this.mesh.visible = wasVisible
  }

  private stepRipples(renderer: THREE.WebGLRenderer, dt: number) {
    // 固定ステップで回す（フレームレートに依存させない）
    const steps = dt > 0.032 ? 2 : 1
    const impulses = this.rippleMat.uniforms.uImpulses.value as THREE.Vector3[]
    for (let s = 0; s < steps; s++) {
      const count = s === 0 ? this.impulseCount : 0
      for (let i = 0; i < count; i++) {
        impulses[i].set(
          this.pendingImpulses[i * 3],
          this.pendingImpulses[i * 3 + 1],
          this.pendingImpulses[i * 3 + 2],
        )
      }
      this.rippleMat.uniforms.uImpulseCount.value = count
      this.rippleMat.uniforms.uPrev.value = this.ripplesA.texture
      const prevTarget = renderer.getRenderTarget()
      renderer.setRenderTarget(this.ripplesB)
      renderer.render(this.rippleScene, this.rippleCam)
      renderer.setRenderTarget(prevTarget)
      const t = this.ripplesA
      this.ripplesA = this.ripplesB
      this.ripplesB = t
    }
    this.material.uniforms.uRipple.value = this.ripplesA.texture
    this.pendingImpulses.length = 0
    this.impulseCount = 0
  }

  private updateReflectCamera(camera: THREE.PerspectiveCamera) {
    const c = this.reflectCam
    c.copy(camera)
    c.position.set(camera.position.x, 2 * this.level - camera.position.y, camera.position.z)
    // 向きの Y 成分だけ反転
    const target = new THREE.Vector3()
    camera.getWorldDirection(target)
    target.add(camera.position)
    c.up.set(0, 1, 0)
    c.lookAt(target.x, 2 * this.level - target.y, target.z)
    c.updateMatrixWorld(true)
    c.updateProjectionMatrix()

    // world -> reflection texture uv
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    this.textureMatrix.multiply(c.projectionMatrix)
    this.textureMatrix.multiply(c.matrixWorldInverse)
    this.material.uniforms.uTextureMatrix.value = this.textureMatrix
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.rtReflect.dispose()
    this.rtRefract.dispose()
    this.ripplesA.dispose()
    this.ripplesB.dispose()
    this.rippleMat.dispose()
    this.depthTexture.dispose()
  }
}
