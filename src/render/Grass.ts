import * as THREE from 'three'
import { TERRAIN_MAP_GLSL, type TerrainMap } from '../gen/terrain'
import { mulberry32 } from '../gen/textures'

/**
 * 草。1枚の InstancedBufferGeometry を視点のまわりに「巻き取って」使う。
 *
 * 草はパッチ内のローカル座標だけを持ち、頂点シェーダーで
 *   世界座標 = ローカル + round((視点 - ローカル) / パッチ) * パッチ
 * と折り返すので、どこまで歩いてもメモリと描画コストが一定になる。
 * 高さ・生える／生えないの判定・色ムラは、地形と同じパックテクスチャから読む。
 * → 近くの草と遠くの地面の色が食い違わない。
 *
 * 材質は MeshStandardMaterial を onBeforeCompile で拡張している。
 * 影・霧・環境マップ・トーンマップを地形と完全に共有させるため
 * （ここを自前シェーダーにすると、途端に「ゲームの草」に見える）。
 */
export interface GrassOptions {
  map: TerrainMap
  /** 折り返しの一辺（m）。フェード終端の2倍以上にする */
  patch: number
  /** 1平方メートルあたりの本数 */
  density: number
  /** 草丈の範囲（m） */
  minHeight: number
  maxHeight: number
  width: number
  fadeStart: number
  fadeEnd: number
  colorDark: number
  colorLight: number
  colorDry: number
  windDir: THREE.Vector2
  wind: number
  seed?: number
  /** 逆光で葉が透ける量 */
  translucency?: number
  sunDir?: THREE.Vector3
  sunColor?: number
}

function bladeGeometry() {
  // 4段・8頂点・6三角形。position.z は先へ向かうお辞儀（草丈でスケールする）
  const rows = [
    { y: 0.0, w: 1.0, z: 0.0 },
    { y: 0.4, w: 0.84, z: 0.05 },
    { y: 0.75, w: 0.54, z: 0.15 },
    { y: 1.0, w: 0.06, z: 0.3 },
  ]
  const pos: number[] = []
  const uv: number[] = []
  for (const r of rows) {
    pos.push(-r.w * 0.5, r.y, r.z, r.w * 0.5, r.y, r.z)
    uv.push(0, r.y, 1, r.y)
  }
  const idx: number[] = []
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

export class GrassField {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshStandardMaterial
  private uniforms: Record<string, THREE.IUniform>
  private time = 0

  constructor(opts: GrassOptions) {
    const count = Math.floor(opts.patch * opts.patch * opts.density)
    const geo = bladeGeometry()
    geo.instanceCount = count

    const local = new Float32Array(count * 2)
    const rot = new Float32Array(count)
    const size = new Float32Array(count * 2)
    const phase = new Float32Array(count)
    const rand = new Float32Array(count)
    const rnd = mulberry32(opts.seed ?? 4242)

    for (let i = 0; i < count; i++) {
      local[i * 2] = rnd() * opts.patch
      local[i * 2 + 1] = rnd() * opts.patch
      rot[i] = rnd() * Math.PI * 2
      const t = rnd()
      size[i * 2] = opts.width * (0.7 + rnd() * 0.6)
      size[i * 2 + 1] = opts.minHeight + (opts.maxHeight - opts.minHeight) * (t * t * 0.6 + rnd() * 0.4)
      phase[i] = rnd() * Math.PI * 2
      rand[i] = rnd()
    }

    geo.setAttribute('iLocal', new THREE.InstancedBufferAttribute(local, 2))
    geo.setAttribute('iRot', new THREE.InstancedBufferAttribute(rot, 1))
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 2))
    geo.setAttribute('iPhase', new THREE.InstancedBufferAttribute(phase, 1))
    geo.setAttribute('iRand', new THREE.InstancedBufferAttribute(rand, 1))
    // 視錐台カリングは頂点シェーダー側でやる
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.uniforms = {
      uTerrainMap: { value: opts.map.texture },
      uTerrainInfo: {
        value: new THREE.Vector4(opts.map.size, opts.map.res, opts.map.minH, opts.map.maxH),
      },
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
      uViewDir: { value: new THREE.Vector2(0, -1) },
      uPatch: { value: opts.patch },
      uFade: { value: new THREE.Vector2(opts.fadeStart, opts.fadeEnd) },
      uWind: { value: opts.wind },
      uWindDir: { value: opts.windDir.clone().normalize() },
      uGrassDark: { value: new THREE.Color(opts.colorDark) },
      uGrassLight: { value: new THREE.Color(opts.colorLight) },
      uGrassDry: { value: new THREE.Color(opts.colorDry) },
      uTrans: { value: opts.translucency ?? 0.8 },
      uSunDirF: { value: (opts.sunDir ?? new THREE.Vector3(0, 1, 0)).clone().normalize() },
      uSunColorF: { value: new THREE.Color(opts.sunColor ?? 0xffffff) },
    }

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    })

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${TERRAIN_MAP_GLSL}
attribute vec2 iLocal;
attribute float iRot;
attribute vec2 iSize;
attribute float iPhase;
attribute float iRand;
uniform float uTime;
uniform vec3 uEye;
uniform vec2 uViewDir;
uniform float uPatch;
uniform vec2 uFade;
uniform float uWind;
uniform vec2 uWindDir;
varying float vBladeT;
varying float vMacro;
varying float vRand;
`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `
// ---- 草：折り返し・地形吸着・風 ----
vec2 gCell = floor((uEye.xz - iLocal) / uPatch + 0.5);
vec2 gPos = iLocal + gCell * uPatch;
vec3 gTer = sampleTerrain(gPos);

float gDist = distance(gPos, uEye.xz);
float gFade = 1.0 - smoothstep(uFade.x, uFade.y, gDist);
// 生えない場所は、個体ごとの乱数でディザして境界を散らす
gFade *= step(iRand * 0.85, gTer.y);
// 視野の後ろは潰す（足元は残す）
vec2 gTo = (gDist > 0.001) ? (gPos - uEye.xz) / gDist : vec2(0.0, -1.0);
float gBehind = step(-0.35, dot(gTo, uViewDir));
gFade *= max(gBehind, 1.0 - smoothstep(1.5, 4.5, gDist));

float gT = uv.y;
float gSway = sin(uTime * 1.7 + iPhase + gPos.x * 0.35 + gPos.y * 0.27);
float gGust = 0.5 + 0.5 * sin(uTime * 0.42 + gPos.x * 0.033 + gPos.y * 0.027);
float gBend = uWind * (0.3 + 0.7 * gGust) * (0.55 + 0.45 * gSway) * gT * gT;

float gC = cos(iRot);
float gS = sin(iRot);
vec3 gBl = vec3(position.x * iSize.x, position.y * iSize.y, position.z * iSize.y);
vec3 gRot = vec3(gBl.x * gC - gBl.z * gS, gBl.y, gBl.x * gS + gBl.z * gC);
gRot.xz += uWindDir * gBend * iSize.y;
gRot.y -= 0.42 * gBend * gBend * iSize.y;
gRot *= gFade;
vec3 gWorld = vec3(gPos.x, gTer.x - 0.035, gPos.y) + gRot;

vBladeT = gT;
vMacro = gTer.z;
vRand = iRand;

vec3 gN = normalize(vec3(position.x * 1.7, 0.55, 1.0));
vec3 objectNormal = vec3(gN.x * gC - gN.z * gS, gN.y, gN.x * gS + gN.z * gC);
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gWorld;')

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uGrassDark;
uniform vec3 uGrassLight;
uniform vec3 uGrassDry;
uniform float uTrans;
uniform vec3 uSunDirF;
uniform vec3 uSunColorF;
varying float vBladeT;
varying float vMacro;
varying float vRand;
`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  vec3 gCol = mix(uGrassDark, uGrassLight, vMacro);
  gCol = mix(gCol, uGrassDry, vRand * vRand * 0.26);
  // 根元は光が届かない
  gCol *= mix(0.52, 1.1, pow(vBladeT, 0.6));
  diffuseColor.rgb *= gCol;
}
`,
        )
        // 葉は薄いので光を透かす。これが無いと逆光側がただの黒い毛になる。
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
{
  float back = max(0.0, dot(-normal, uSunDirF));
  float thin = mix(0.35, 1.0, vBladeT);
  reflectedLight.directDiffuse += diffuseColor.rgb * uSunColorF * (pow(back, 1.6) * uTrans * thin);
}
`,
        )
    }
    // onBeforeCompile を変えたので再コンパイルさせる
    this.material.customProgramCacheKey = () => 'grass'

    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'grass'
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
  }

  update(dt: number, eye: THREE.Vector3, viewDir: THREE.Vector3) {
    this.time += dt
    this.uniforms.uTime.value = this.time
    ;(this.uniforms.uEye.value as THREE.Vector3).copy(eye)
    const d = this.uniforms.uViewDir.value as THREE.Vector2
    d.set(viewDir.x, viewDir.z)
    if (d.lengthSq() > 1e-6) d.normalize()
  }

  setWind(strength: number) {
    this.uniforms.uWind.value = strength
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
