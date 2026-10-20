import * as THREE from 'three'
import { SkyDome } from '../render/SkyDome'
import { World, type ExitSpec, type WorldMeta } from './World'
import { photorealStyle } from '../render/styles/photoreal'
import { GrassField } from '../render/Grass'
import {
  HeightFieldFn,
  TERRAIN_MAP_GLSL,
  buildRibbon,
  buildTerrainMap,
  buildTerrainMesh,
  type TerrainMap,
} from '../gen/terrain'
import { makeNoise2D, smoothstep01, smootherstep01 } from '../gen/noise'
import { dirtRoad, grassGroundMaps, paintedMetal, paintedWood, rainbowStrip } from '../gen/surfaces'
import { Batch, instances, mat4, rockGeometry } from '../gen/build'
import { mulberry32 } from '../gen/textures'
import type { AmbienceSpec } from '../core/Audio'
import type { Player } from '../core/Player'

// ---------------- 寸法 ----------------
const INNER = 320 // 近景の地形（1m 刻み）
const INNER_SEG = 256
const OUTER = 1600 // 地平線までの粗い地形（16m 刻み）
const OUTER_SEG = 100

const HILL_TOP = 34 // 丘の高さ（頂上は z = -60 付近）

const ROAD_W = 4.4 // 道幅
const ROAD_Z0 = 164 // 手前の端
const ROAD_Z1 = -60.2 // 穴の手前で途切れる
const FENCE_X = 4.3

const HOUSE_X = 0.4
const HOUSE_Z = -70.5

// 抜け穴：レンダリングが壊れて、家の手前5メートルだけ world が無い
const HOLE = { x: 0, z: -63, sx: 10.6, sz: 5 }

const SPAWN_Z = 128

// 仰角およそ33度。低めの斜光で影を伸ばしつつ、地面にも光を回す。
const SUN_DIR = new THREE.Vector3(-0.74, 0.545, -0.4).normalize()
const SUN_COLOR = 0xffeed2

const noise = makeNoise2D(20260823)

/** 道のことを考えない、素の地形 */
function baseHeight(x: number, z: number) {
  const t = (190 - z) / 250
  let h: number
  if (t <= 1) h = HILL_TOP * smootherstep01(t)
  else h = HILL_TOP * (1 - 0.9 * smootherstep01((t - 1) / 0.45))
  h *= Math.exp(-Math.pow(x / 300, 2) * 1.15)
  h += noise.fbm(x * 0.0035, z * 0.0035, 4) * 3.6
  h += noise.fbm(x * 0.018, z * 0.018, 3) * 0.85
  h += noise.fbm(x * 0.09, z * 0.09, 2) * 0.13
  return h
}

const HOUSE_GROUND = baseHeight(0, HOUSE_Z)

/** 道の帯を平らに削り、家の敷地をならした最終的な地形 */
function height(x: number, z: number) {
  const b = baseHeight(x, z)
  const c = baseHeight(0, z)
  // 道の切り通し（|x|<4 で完全に平ら、9m でなじむ）
  let k = smoothstep01((9 - Math.abs(x)) / 5)
  k *= smoothstep01((z + 90) / 20) * smoothstep01((178 - z) / 12)
  let h = b + (c - b) * k
  // 家の敷地
  const d = Math.max(Math.abs(x - HOUSE_X) / 9, Math.abs(z - HOUSE_Z) / 8)
  const pad = smoothstep01((1 - d) / 0.45)
  h = h + (HOUSE_GROUND - h) * pad
  return h
}

function grassMask(x: number, z: number) {
  // 道の上には生えない
  let m = smoothstep01((Math.abs(x) - 2.35) / 1.8)
  const along = smoothstep01((z + 62) / 8) * smoothstep01((170 - z) / 10)
  m = 1 - (1 - m) * along
  // 家の足元と穴のまわり
  if (Math.abs(x - HOUSE_X) < 5.8 && Math.abs(z - HOUSE_Z) < 4.6) m = 0
  if (Math.abs(x - HOLE.x) < HOLE.sx / 2 + 0.4 && Math.abs(z - HOLE.z) < HOLE.sz / 2 + 0.4) m = 0
  return m
}

function macroTint(x: number, z: number) {
  let v = 0.5 + 0.42 * noise.fbm(x * 0.009, z * 0.009, 3)
  v += 0.1 * noise.fbm(x * 0.055, z * 0.055, 2)
  return Math.max(0.22, Math.min(0.88, v))
}

const TURBINES: Array<[number, number]> = [
  [-118, -96],
  [-154, -78],
  [-193, -64],
  [-234, -56],
  [-279, -50],
  [-97, -132],
  [-136, -152],
  [-178, -170],
  [-226, -186],
  [-280, -200],
]

const TREES: Array<[number, number, number]> = [
  [86, -14, 1.0],
  [98, -26, 0.82],
  [78, -33, 1.15],
  [110, -44, 0.9],
  [92, -52, 1.05],
  [122, -60, 0.75],
  [70, -6, 0.68],
  [134, -30, 0.95],
]

export class HillHouse extends World {
  readonly meta: WorldMeta = {
    id: 'hill',
    title: '丘の上の家',
    caption: '道は、まっすぐ一本きり。',
  }
  readonly style = photorealStyle(this.pool)
  readonly ambience: AmbienceSpec = {
    noiseFreq: 620,
    noiseQ: 0.22,
    noiseGain: 0.1,
    padRoot: 55,
    padRatios: [1, 1.5, 2],
    padGain: 0.008,
    reverb: 0.35,
  }
  readonly spawn = { x: 0, y: height(0, SPAWN_Z), z: SPAWN_Z, yaw: 0 }
  readonly exit: ExitSpec = {
    kind: 'glitch',
    contains: (p: THREE.Vector3) =>
      Math.abs(p.x - HOLE.x) < HOLE.sx / 2 &&
      Math.abs(p.z - HOLE.z) < HOLE.sz / 2 &&
      p.y < HOUSE_GROUND - 1.2,
    tunnelTint: 0x000000,
  }
  surface = 'grass' as const
  fallInHeight = 46

  private grass: GrassField[] = []
  private rotors: THREE.Object3D[] = []
  private sun: THREE.DirectionalLight | null = null
  private sky: SkyDome | null = null
  private glitchMats: THREE.ShaderMaterial[] = []
  private shards: THREE.Object3D[] = []
  private elapsed = 0
  private map: TerrainMap | null = null;

  *build(renderer: THREE.WebGLRenderer) {
    const s = this.scene
    s.fog = new THREE.FogExp2(0xa9c6e0, 0.00155)

    // ============ 空と太陽 ============
    // 「日向の白い面 = 1.0」を基準にした線形の放射輝度。
    // 天頂の空はそれより一桁暗い ── これが青の濃さになる。
    this.sky = new SkyDome({
      sunDir: SUN_DIR,
      zenith: new THREE.Vector3(0.013, 0.058, 0.29),
      horizon: new THREE.Vector3(0.36, 0.40, 0.48),
      ground: new THREE.Vector3(0.08, 0.10, 0.08),
      sunTint: new THREE.Vector3(1.0, 0.8, 0.55),
      falloff: 5.0,
      radius: 1200,
    })
    s.add(this.sky.mesh)
    yield 'sky'

    s.environment = this.sky.makeEnvironment(renderer)
    s.environmentIntensity = 1
    yield 'environment'

    const sun = new THREE.DirectionalLight(SUN_COLOR, 4.2)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -55
    sun.shadow.camera.right = 55
    sun.shadow.camera.top = 55
    sun.shadow.camera.bottom = -55
    sun.shadow.camera.near = 20
    sun.shadow.camera.far = 300
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.06
    // three は camera の left/right/near/far を変えても射影行列を作り直さない。
    // これを忘れると影が既定の 10m 四方にしか焼かれない。
    sun.shadow.camera.updateProjectionMatrix()
    s.add(sun)
    s.add(sun.target)
    this.sun = sun
    // 空の青だけだと日陰が真っ青になる。草からの照り返しを足す。
    s.add(new THREE.HemisphereLight(0xa8c8e8, 0x4c6b2c, 0.45))

    // ============ 地形マップ（高さ・草マスク・色ムラ） ============
    const map = yield* buildTerrainMap({
      size: INNER,
      res: 768,
      minH: -6,
      maxH: HILL_TOP + 14,
      height,
      grassMask,
      macro: macroTint,
      rowsPerStep: 64,
    })
    this.map = map

    // ============ 地形 ============
    // テクスチャは「明暗のムラ」だけを持たせ、色は tint 側で決める。
    // 緑×緑を掛けると、途端に絵の具の緑になってしまう。
    const ground = grassGroundMaps({
      key: 'hill',
      dark: 0x9c9c92,
      light: 0xd8d8cc,
      dry: 0xe0d8b4,
    })
    // 近景の地形だけ法線マップを持たせる。斜光での起伏が写実の要。
    // uv は 0..1 が 320m なので、1.4m タイルになるよう repeat を合わせる。
    const groundNormal = ground.normal.clone()
    groundNormal.wrapS = groundNormal.wrapT = THREE.RepeatWrapping
    groundNormal.repeat.set(INNER / 1.6, INNER / 1.6)
    groundNormal.needsUpdate = true
    const terrainMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: ground.color,
      normalMap: groundNormal,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.96,
      metalness: 0,
    })
    this.pool.track(terrainMat)
    terrainMat.customProgramCacheKey = () => 'hillTerrain'
    terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTerrainMap = { value: map.texture }
      shader.uniforms.uTerrainInfo = {
        value: new THREE.Vector4(map.size, map.res, map.minH, map.maxH),
      }
      // 実際の芝のアルベドは暗い。明るく見えるのは日光のせい。
      shader.uniforms.uGrassDark = { value: new THREE.Color(0x4b6b2c) }
      shader.uniforms.uGrassLight = { value: new THREE.Color(0x76a33c) }
      shader.uniforms.uSoil = { value: new THREE.Color(0x4b4a2e) }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
${TERRAIN_MAP_GLSL}
uniform vec3 uGrassDark;
uniform vec3 uGrassLight;
uniform vec3 uSoil;
varying vec2 vWorldXZ;`,
        )
        .replace(
          '#include <map_fragment>',
          `
{
  // 3m と 19m の二重スケールで貼って、繰り返しの模様を消す
  float near3 = texture2D(map, vWorldXZ / 1.6).g;
  float far19 = texture2D(map, vWorldXZ / 17.3 + vec2(0.37, 0.11)).g;
  float shade = (0.66 + near3 * 0.62) * (0.74 + far19 * 0.44);
  vec3 t = sampleTerrain(vWorldXZ);
  vec3 tint = mix(uGrassDark, uGrassLight, t.z);
  // ごく暗いところだけ、根本の枯れ色が透ける
  tint = mix(uSoil, tint, smoothstep(0.16, 0.34, near3));
  diffuseColor.rgb *= tint * shade;
}`,
        )
    }

    const innerGeo = buildTerrainMesh(INNER, INNER_SEG, height, [HOLE])
    const inner = new THREE.Mesh(innerGeo, terrainMat)
    inner.receiveShadow = true
    inner.castShadow = true
    inner.matrixAutoUpdate = false
    inner.name = 'terrainInner'
    s.add(inner)
    yield 'terrain near'

    // 遠景は法線マップ不要（uv のスケールも合わない）
    const farMat = terrainMat.clone()
    farMat.normalMap = null
    farMat.customProgramCacheKey = () => 'hillTerrainFar'
    farMat.onBeforeCompile = terrainMat.onBeforeCompile
    this.pool.track(farMat)
    const outerGeo = buildTerrainMesh(OUTER, OUTER_SEG, height, [
      { x: 0, z: 0, sx: INNER, sz: INNER },
    ])
    const outer = new THREE.Mesh(outerGeo, farMat)
    outer.matrixAutoUpdate = false
    outer.name = 'terrainFar'
    s.add(outer)

    this.collision.heightField = new HeightFieldFn(
      height,
      { minX: -OUTER / 2, maxX: OUTER / 2, minZ: -OUTER / 2, maxZ: OUTER / 2 },
      [HOLE],
    )
    yield 'terrain far'

    // ============ 道 ============
    const road = dirtRoad({ key: 'hill', base: 0xd6c0a0, track: 0xa89070, verge: 0x8f8663 })
    road.color.wrapS = road.color.wrapT = THREE.RepeatWrapping
    road.normal.wrapS = road.normal.wrapT = THREE.RepeatWrapping
    const roadMat = new THREE.MeshStandardMaterial({
      map: road.color,
      normalMap: road.normal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.97,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.pool.track(roadMat)
    const roadGeo = buildRibbon({
      zStart: ROAD_Z0,
      zEnd: ROAD_Z1,
      segments: 260,
      width: ROAD_W,
      centerX: () => 0,
      height,
      lift: 0.015,
      crown: 0.05,
      across: 8,
      edgeWobble: 0.5,
      wobbleNoise: (t) => noise(t, 4.2),
    })
    const roadMesh = new THREE.Mesh(roadGeo, roadMat)
    roadMesh.receiveShadow = true
    roadMesh.matrixAutoUpdate = false
    s.add(roadMesh)
    yield 'road'

    // ============ 白い柵 ============
    this.buildFence()
    yield 'fence'

    // ============ 家 ============
    this.buildHouse()
    yield 'house'

    // ============ 風車と木 ============
    this.buildTurbines()
    this.buildTrees()
    yield 'turbines'

    // ============ 遠くの霧と虹 ============
    this.buildDistantAir()
    yield 'air'

    // ============ 抜け穴（レンダリングの破綻） ============
    this.buildGlitch()
    yield 'glitch'

    // ============ 草 ============
    // 1層だとフェード終端に丸い切れ目が見える。
    // 近景は密で短く、遠景は疎らで大きく ── 2層にして受け渡す。
    const grassCommon = {
      map,
      colorDark: 0x3f5c25,
      colorLight: 0x6f9c38,
      colorDry: 0x8a8149,
      windDir: new THREE.Vector2(0.82, 0.57),
      translucency: 0.7,
      sunDir: SUN_DIR,
      sunColor: SUN_COLOR,
    }
    this.grass.push(
      new GrassField({
        ...grassCommon,
        patch: 26,
        density: 75,
        minHeight: 0.09,
        maxHeight: 0.22,
        width: 0.022,
        fadeStart: 7,
        fadeEnd: 11,
        wind: 0.07,
        seed: 4242,
      }),
      new GrassField({
        ...grassCommon,
        patch: 64,
        density: 20,
        minHeight: 0.16,
        maxHeight: 0.38,
        width: 0.05,
        fadeStart: 12,
        fadeEnd: 26,
        wind: 0.11,
        seed: 909,
      }),
    )
    for (const g of this.grass) s.add(g.mesh)
    yield 'grass'

    this.buildProps()
    yield 'props'
  }

  // ------------------------------------------------------------------

  private buildFence() {
    const s = this.scene
    const woodTex = paintedWood({ key: 'fence', base: 0xf2efe7, grime: 0.16 })
    const mat = this.style.makeMaterial({
      kind: 'wall',
      color: 0xffffff,
      map: woodTex,
      roughness: 0.66,
    })

    const rails = new Batch(mat, 'fenceRails')
    const postTf: THREE.Matrix4[] = []
    const picketTf: THREE.Matrix4[] = []

    // 東側の一箇所だけ、柵が途切れていて野原に出られる
    const GATE_LO = 42
    const GATE_HI = 49

    for (const sideSign of [-1, 1]) {
      const fx = FENCE_X * sideSign
      let z = ROAD_Z0
      while (z > -60.8) {
        const zNext = z - 2.4
        const open = (zz: number) => sideSign > 0 && zz > GATE_LO && zz < GATE_HI
        // 支柱
        if (!open(z)) {
          const y = height(fx, z)
          postTf.push(mat4(fx, y + 0.56, z, 0, 1))
        }
        // 横桟と縦板
        if (!open(z) && !open(zNext) && zNext > -60.8) {
          const y0 = height(fx, z)
          const y1 = height(fx, zNext)
          const mid = (y0 + y1) / 2
          const slope = Math.atan2(y1 - y0, 2.4)
          for (const rh of [0.3, 0.78]) {
            const g = new THREE.BoxGeometry(0.04, 0.085, 2.42)
            const m = new THREE.Matrix4().makeRotationX(-slope)
            m.setPosition(fx, mid + rh, z - 1.2)
            rails.add(g, m)
            g.dispose()
          }
          for (let t = 0.08; t < 1; t += 0.0645) {
            const pz = z - 2.4 * t
            const py = y0 + (y1 - y0) * t
            picketTf.push(mat4(fx, py + 0.5, pz, 0, 1, 0))
          }
        }
        z = zNext
      }
    }

    const railMesh = rails.finish()
    if (railMesh) {
      railMesh.castShadow = true
      railMesh.receiveShadow = true
      s.add(railMesh)
    }

    const postGeo = new THREE.BoxGeometry(0.12, 1.12, 0.12)
    const capGeo = new THREE.ConeGeometry(0.105, 0.11, 4)
    capGeo.rotateY(Math.PI / 4)
    capGeo.translate(0, 0.615, 0)
    const postMerged = mergeTwo(postGeo, capGeo)
    const posts = instances(postMerged, mat, postTf, 'fencePosts')
    posts.castShadow = true
    posts.receiveShadow = true
    s.add(posts)

    // 縦板：先が尖っている
    const picketGeo = picketGeometry(0.088, 0.9, 0.022)
    const pickets = instances(picketGeo, mat, picketTf, 'pickets')
    pickets.castShadow = true
    pickets.receiveShadow = true
    s.add(pickets)

    // 柵の当たり判定（穴の区間だけ空いている）
    for (const sideSign of [-1, 1]) {
      const fx = FENCE_X * sideSign
      const segs: Array<[number, number]> = [
        [ROAD_Z0, HOLE.z + HOLE.sz / 2],
        [HOLE.z - HOLE.sz / 2, -60.8],
      ]
      for (const [za, zb] of segs) {
        if (sideSign > 0) {
          // 東側は門の分だけ切る
          this.addFenceCollider(fx, za, 49)
          this.addFenceCollider(fx, 42, zb)
        } else {
          this.addFenceCollider(fx, za, zb)
        }
      }
    }
  }

  private addFenceCollider(x: number, z0: number, z1: number) {
    const a = Math.max(z0, z1)
    const b = Math.min(z0, z1)
    if (a - b < 0.5) return
    // 地形が傾いているので数区間に割って階段状に置く
    const steps = Math.max(1, Math.ceil((a - b) / 12))
    for (let i = 0; i < steps; i++) {
      const za = a - ((a - b) * i) / steps
      const zb = a - ((a - b) * (i + 1)) / steps
      const y = Math.max(height(x, za), height(x, zb))
      this.collision.addBox({ x: x - 0.12, y: y - 1, z: zb }, { x: x + 0.12, y: y + 1.1, z: za })
    }
  }

  // ------------------------------------------------------------------

  private buildHouse() {
    const s = this.scene
    const g0 = HOUSE_GROUND
    const sidingTex = paintedWood({ key: 'siding', base: 0xf0ece2, grime: 0.13 })
    const trimTex = paintedWood({ key: 'trim', base: 0xfbf8f2, grime: 0.07 })
    const roofTex = paintedMetal({ key: 'roof', base: 0xc0301c })

    const siding = this.style.makeMaterial({ kind: 'wall', color: 0xffffff, map: sidingTex, roughness: 0.7 })
    const trim = this.style.makeMaterial({ kind: 'wall', color: 0xffffff, map: trimTex, roughness: 0.55 })
    const roofMat = this.style.makeMaterial({
      kind: 'metal',
      color: 0xffffff,
      map: roofTex,
      roughness: 0.44,
      metalness: 0.28,
    })
    const stone = this.style.makeMaterial({ kind: 'prop', color: 0x9a958c, roughness: 0.95 })
    const dark = this.style.makeMaterial({ kind: 'prop', color: 0x24262a, roughness: 0.6 })
    const glass = this.style.makeMaterial({ kind: 'glass', color: 0x1e2a30 })

    const wallB = new Batch(siding, 'houseWalls')
    const trimB = new Batch(trim, 'houseTrim')
    const roofB = new Batch(roofMat, 'houseRoof')
    const stoneB = new Batch(stone, 'houseBase')
    const darkB = new Batch(dark, 'houseDark')

    const X = HOUSE_X
    const Z = HOUSE_Z

    // --- 基礎 ---
    const plinth = 0.95
    stoneB.box(X, g0 + plinth / 2, Z, 10.2, plinth, 7.6)

    // 玄関までの階段
    for (let i = 0; i < 4; i++) {
      const sy = g0 + 0.12 + i * 0.24
      stoneB.box(X - 1.2, sy, Z + 3.8 + (3 - i) * 0.32, 2.3, 0.24, 0.34)
    }

    /** 下見板張り：本物の板を積む。影の線がそのまま質感になる */
    const clapboard = (
      cx: number,
      cz: number,
      w: number,
      d: number,
      y0: number,
      hgt: number,
      dir: 'x' | 'z',
    ) => {
      const bh = 0.235
      const n = Math.ceil(hgt / bh)
      for (let i = 0; i < n; i++) {
        const y = y0 + i * bh + bh / 2
        const hh = Math.min(bh, y0 + hgt - (y - bh / 2))
        if (hh <= 0.02) break
        // 下端がわずかに前へ出る（本物の下見板と同じ）
        const out = 0.028
        if (dir === 'z') wallB.box(cx, y, cz, w + out * 2, hh * 0.96, d)
        else wallB.box(cx, y, cz, w, hh * 0.96, d + out * 2)
      }
    }

    // --- 本体A：南に切妻を向けた、背の高い棟 ---
    const ax0 = X - 3.6
    const ax1 = X + 0.6
    const az0 = Z - 3.4
    const az1 = Z + 3.4
    const aw = ax1 - ax0
    const ad = az1 - az0
    const acx = (ax0 + ax1) / 2
    const acz = (az0 + az1) / 2
    const aBase = g0 + plinth
    const aWall = 4.4
    const aRidge = aBase + aWall + 2.7

    wallB.box(acx, aBase + aWall / 2, acz, aw, aWall, ad) // 芯
    clapboard(acx, az1 + 0.001, aw, 0.06, aBase, aWall, 'z')
    clapboard(acx, az0 - 0.001, aw, 0.06, aBase, aWall, 'z')
    clapboardSide(wallB, ax0 - 0.001, acz, 0.06, ad, aBase, aWall)
    clapboardSide(wallB, ax1 + 0.001, acz, 0.06, ad, aBase, aWall)

    // 切妻の三角（南北）
    const gableRows = 12
    for (let i = 0; i < gableRows; i++) {
      const t = i / gableRows
      const y = aBase + aWall + (aRidge - aBase - aWall) * t
      const w = aw * (1 - t)
      const hh = (aRidge - aBase - aWall) / gableRows
      wallB.box(acx, y + hh / 2, az1, w, hh, 0.16)
      wallB.box(acx, y + hh / 2, az0, w, hh, 0.16)
      wallB.box(acx, y + hh / 2, acz, w * 0.98, hh, ad)
    }

    // 屋根（南北方向の棟＝東西へ流れる2面）
    const aEave = 0.5
    const aSlopeLen = Math.hypot(aw / 2 + aEave, aRidge - (aBase + aWall))
    for (const sgn of [-1, 1]) {
      const g = new THREE.BoxGeometry(aSlopeLen, 0.14, ad + aEave * 2)
      const ang = Math.atan2(aRidge - (aBase + aWall), aw / 2 + aEave)
      const m = new THREE.Matrix4().makeRotationZ(-sgn * ang)
      m.setPosition(
        acx + (sgn * (aw / 2 + aEave)) / 2,
        (aRidge + aBase + aWall) / 2 + 0.05,
        acz,
      )
      roofB.add(g, m)
      g.dispose()
    }
    // 棟包み
    roofB.box(acx, aRidge + 0.1, acz, 0.22, 0.1, ad + aEave * 2)
    // 破風板
    for (const zz of [az0 - aEave, az1 + aEave]) {
      for (const sgn of [-1, 1]) {
        const ang = Math.atan2(aRidge - (aBase + aWall), aw / 2 + aEave)
        const g = new THREE.BoxGeometry(aSlopeLen, 0.2, 0.05)
        const m = new THREE.Matrix4().makeRotationZ(-sgn * ang)
        m.setPosition(acx + (sgn * (aw / 2 + aEave)) / 2, (aRidge + aBase + aWall) / 2 - 0.1, zz)
        trimB.add(g, m)
        g.dispose()
      }
    }
    // 尖塔（参考画像の黒い針）
    darkB.cylinder(acx, aRidge + 0.55, az1 + 0.05, 0.03, 0.09, 0.9, 8)
    darkB.cylinder(acx, aRidge + 1.06, az1 + 0.05, 0.005, 0.035, 0.24, 6)

    // --- 本体B：東の翼。赤い屋根の大きな面が南を向く ---
    const bx0 = X + 0.6
    const bx1 = X + 5.2
    const bz0 = Z - 2.6
    const bz1 = Z + 2.4
    const bw = bx1 - bx0
    const bd = bz1 - bz0
    const bcx = (bx0 + bx1) / 2
    const bcz = (bz0 + bz1) / 2
    const bBase = g0 + plinth
    const bWall = 3.5
    const bRidge = bBase + bWall + 1.7

    wallB.box(bcx, bBase + bWall / 2, bcz, bw, bWall, bd)
    clapboard(bcx, bz1 + 0.001, bw, 0.06, bBase, bWall, 'z')
    clapboardSide(wallB, bx1 + 0.001, bcz, 0.06, bd, bBase, bWall)

    const bEave = 0.45
    const bSlopeLen = Math.hypot(bd / 2 + bEave, bRidge - (bBase + bWall))
    for (const sgn of [-1, 1]) {
      const g = new THREE.BoxGeometry(bw + bEave * 2, 0.14, bSlopeLen)
      const ang = Math.atan2(bRidge - (bBase + bWall), bd / 2 + bEave)
      const m = new THREE.Matrix4().makeRotationX(sgn * ang)
      m.setPosition(bcx, (bRidge + bBase + bWall) / 2 + 0.05, bcz + (sgn * (bd / 2 + bEave)) / 2)
      roofB.add(g, m)
      g.dispose()
    }
    roofB.box(bcx, bRidge + 0.1, bcz, bw + bEave * 2, 0.1, 0.22)
    // 立ちはぜ（金属屋根の縦の継ぎ目）
    for (let i = 0; i <= 10; i++) {
      const xx = bx0 - bEave + ((bw + bEave * 2) * i) / 10
      for (const sgn of [-1, 1]) {
        const ang = Math.atan2(bRidge - (bBase + bWall), bd / 2 + bEave)
        const g = new THREE.BoxGeometry(0.05, 0.055, bSlopeLen)
        const m = new THREE.Matrix4().makeRotationX(sgn * ang)
        m.setPosition(xx, (bRidge + bBase + bWall) / 2 + 0.14, bcz + (sgn * (bd / 2 + bEave)) / 2)
        roofB.add(g, m)
        g.dispose()
      }
    }

    // 煙突
    stoneB.box(X + 3.4, bRidge + 0.5, Z - 0.4, 0.7, 2.2, 0.7)
    darkB.box(X + 3.4, bRidge + 1.65, Z - 0.4, 0.85, 0.12, 0.85)

    // --- 窓とドア ---
    const win = (wx: number, wy: number, wz: number, w: number, h: number, facing: 'z' | 'x') => {
      trimB.box(wx, wy, wz, (facing === 'z' ? w : 0.12) + 0.16, h + 0.16, facing === 'z' ? 0.12 : w + 0.16)
      const gg =
        facing === 'z'
          ? new THREE.BoxGeometry(w, h, 0.04)
          : new THREE.BoxGeometry(0.04, h, w)
      const gm = new THREE.Mesh(gg, glass)
      gm.position.set(wx, wy, wz + (facing === 'z' ? 0.03 : 0))
      s.add(gm)
      // 窓の桟
      trimB.box(wx, wy, wz + (facing === 'z' ? 0.06 : 0), facing === 'z' ? w : 0.05, 0.045, facing === 'z' ? 0.05 : w)
      trimB.box(wx, wy, wz + (facing === 'z' ? 0.06 : 0), facing === 'z' ? 0.045 : 0.05, h, facing === 'z' ? 0.05 : 0.045)
    }

    win(acx - 1.05, aBase + 2.15, az1 + 0.09, 0.95, 1.35, 'z')
    win(acx + 1.05, aBase + 2.15, az1 + 0.09, 0.95, 1.35, 'z')
    win(acx, aBase + aWall + 1.0, az1 + 0.12, 0.7, 0.8, 'z')
    win(ax0 - 0.07, aBase + 2.15, acz - 1.1, 0.95, 1.35, 'x')
    win(ax0 - 0.07, aBase + 2.15, acz + 1.1, 0.95, 1.35, 'x')
    win(bcx - 1.1, bBase + 1.9, bz1 + 0.09, 0.9, 1.2, 'z')
    win(bcx + 1.1, bBase + 1.9, bz1 + 0.09, 0.9, 1.2, 'z')

    // 玄関ドア（Aの南面）
    trimB.box(X - 1.2, aBase + 1.05, az1 + 0.1, 1.24, 2.24, 0.1)
    darkB.box(X - 1.2, aBase + 1.02, az1 + 0.14, 1.0, 2.05, 0.06)
    darkB.cylinder(X - 0.8, aBase + 1.05, az1 + 0.2, 0.03, 0.03, 0.12, 8)

    // 隅木（角の白い縦板）
    for (const [cx2, cz2] of [
      [ax0, az0],
      [ax0, az1],
      [ax1, az1],
      [bx1, bz0],
      [bx1, bz1],
    ]) {
      trimB.box(cx2, aBase + aWall / 2, cz2, 0.14, aWall, 0.14)
    }

    for (const b of [wallB, trimB, roofB, stoneB, darkB]) {
      const m = b.finish()
      if (!m) continue
      m.castShadow = true
      m.receiveShadow = true
      s.add(m)
    }

    // 当たり判定
    this.collision.addBox({ x: ax0, y: g0, z: az0 }, { x: bx1, y: aRidge, z: az1 })

    this.interactables.push({
      position: new THREE.Vector3(X - 1.2, aBase + 1.1, az1 + 0.2),
      radius: 12,
      fragment: '呼び鈴を押しても、たぶん誰も出てこない。',
    })
  }

  // ------------------------------------------------------------------

  private buildTurbines() {
    const s = this.scene
    const white = this.style.makeMaterial({
      kind: 'prop',
      color: 0xf3f2ee,
      roughness: 0.45,
      metalness: 0.05,
    })

    const towerGeo = new THREE.CylinderGeometry(1.35, 2.6, 84, 14, 1, true)
    towerGeo.translate(0, 42, 0)
    const towerTf: THREE.Matrix4[] = []

    for (const [tx, tz] of TURBINES) {
      const ty = height(tx, tz)
      towerTf.push(mat4(tx, ty, tz, 0, 1))

      // ナセルとローターは個別に回すので独立したメッシュ
      const hub = new THREE.Group()
      hub.position.set(tx, ty + 84, tz)
      // 道の方（南）を向く
      hub.rotation.y = Math.atan2(0 - tx, SPAWN_Z - tz) + Math.PI

      const nacelle = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.0, 9.5), white)
      nacelle.position.set(0, 0, -1.2)
      nacelle.castShadow = true
      hub.add(nacelle)

      const rotor = new THREE.Group()
      rotor.position.set(0, 0, 3.9)
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 14), white)
      cone.rotation.x = Math.PI / 2
      cone.position.z = 1.0
      rotor.add(cone)
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(bladeGeometry3(36), white)
        blade.rotation.z = (b * Math.PI * 2) / 3
        blade.castShadow = true
        rotor.add(blade)
      }
      hub.add(rotor)
      this.rotors.push(rotor)
      s.add(hub)

      this.collision.addBoxCS(tx, ty + 6, tz, 5, 12, 5)
    }
    const towers = instances(towerGeo, white, towerTf, 'turbineTowers')
    towers.castShadow = true
    s.add(towers)
  }

  private buildTrees() {
    const s = this.scene
    const rnd = mulberry32(66)
    const trunkMat = this.style.makeMaterial({ kind: 'organic', color: 0x51442f, roughness: 0.97 })
    const leafMat = this.style.makeMaterial({
      kind: 'organic',
      color: 0x37622a,
      roughness: 0.95,
      flatShading: true,
    })
    const trunks = new Batch(trunkMat, 'trunks')
    const leaves = new Batch(leafMat, 'leaves')
    for (const [tx, tz, sc] of TREES) {
      const ty = height(tx, tz)
      const th = 4.2 * sc
      trunks.cylinder(tx, ty + th / 2, tz, 0.22 * sc, 0.4 * sc, th, 8)
      for (let i = 0; i < 4; i++) {
        const g = rockGeometry(2.6 * sc * (0.65 + rnd() * 0.5), 1, 0.22, rnd)
        const m = new THREE.Matrix4().setPosition(
          tx + (rnd() - 0.5) * 2.4 * sc,
          ty + th + (0.4 + rnd() * 1.8) * sc,
          tz + (rnd() - 0.5) * 2.4 * sc,
        )
        leaves.add(g, m)
        g.dispose()
      }
      this.collision.addBoxCS(tx, ty + th / 2, tz, 0.8, th, 0.8)
    }
    const tm = trunks.finish()
    const lm = leaves.finish()
    if (tm) {
      tm.castShadow = true
      s.add(tm)
    }
    if (lm) {
      lm.castShadow = true
      lm.receiveShadow = true
      s.add(lm)
    }
  }

  private buildDistantAir() {
    const s = this.scene
    // 谷にたまった朝の靄
    const mistMat = new THREE.MeshBasicMaterial({
      color: 0xf6dfe6,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    })
    this.pool.track(mistMat)
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(240, 13)
      const m = new THREE.Mesh(g, mistMat)
      m.position.set(-200 - i * 22, 5 + i * 2.5, -205 - i * 34)
      m.rotation.y = 0.35
      m.renderOrder = 1
      s.add(m)
    }

    // 靄にかかった虹
    const bowMat = new THREE.MeshBasicMaterial({
      map: rainbowStrip(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.pool.track(bowMat)
    const bow = new THREE.Mesh(new THREE.TorusGeometry(52, 7.5, 2, 48, Math.PI * 0.85), bowMat)
    bow.position.set(-215, 6, -230)
    bow.rotation.z = -0.08
    bow.rotation.y = 0.4
    bow.renderOrder = 2
    s.add(bow)
  }

  // ------------------------------------------------------------------

  private buildGlitch() {
    const s = this.scene

    // 穴の下は世界がない
    const voidMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide,
      fog: false,
    })
    this.pool.track(voidMat)
    const box = new THREE.Mesh(new THREE.BoxGeometry(HOLE.sx, 300, HOLE.sz), voidMat)
    box.position.set(HOLE.x, HOUSE_GROUND - 150, HOLE.z)
    s.add(box)

    // 穴のふち：Zファイトを起こしている「壊れた面」
    const glitchMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 1 },
        uGrass: { value: new THREE.Color(0x6aa63f) },
        uRoad: { value: new THREE.Color(0xc9b493) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vW;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform float uAmount;
        uniform vec3 uGrass;
        uniform vec3 uRoad;
        varying vec2 vUv;
        varying vec3 vW;

        float hash(vec2 p) {
          p = fract(p * vec2(443.897, 441.423));
          p += dot(p, p.yx + 19.19);
          return fract((p.x + p.y) * p.x);
        }

        void main() {
          // 引き伸ばされた UV（テクスチャが破綻したときの見た目）
          vec2 st = vec2(vW.x * 0.02, vW.z * 3.5);
          float band = floor(vUv.y * 26.0);
          float flick = hash(vec2(band, floor(uTime * 20.0)));
          // Zファイト：2つの面が交互に勝つ
          float zf = step(0.5, fract(vW.x * 6.0 + vW.z * 6.0 + flick * 2.0));
          vec3 col = mix(uGrass, uRoad, zf);
          col *= 0.35 + 0.9 * fract(st.y);
          // 抜け落ちたポリゴン
          float drop = step(hash(vec2(band, 3.0)) , 0.42 * uAmount);
          float a = mix(0.9, 0.0, drop);
          a *= smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
          if (a < 0.02) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
    })
    this.glitchMats.push(glitchMat)

    const ring = 2.6
    const y = HOUSE_GROUND + 0.02
    const frames: Array<[number, number, number, number]> = [
      [HOLE.x, HOLE.z + HOLE.sz / 2 + ring / 2, HOLE.sx + ring * 2, ring],
      [HOLE.x, HOLE.z - HOLE.sz / 2 - ring / 2, HOLE.sx + ring * 2, ring],
      [HOLE.x - HOLE.sx / 2 - ring / 2, HOLE.z, ring, HOLE.sz],
      [HOLE.x + HOLE.sx / 2 + ring / 2, HOLE.z, ring, HOLE.sz],
    ]
    for (const [fx, fz, fw, fd] of frames) {
      const g = new THREE.PlaneGeometry(fw, fd)
      g.rotateX(-Math.PI / 2)
      const m = new THREE.Mesh(g, glitchMat)
      m.position.set(fx, y, fz)
      m.renderOrder = 3
      s.add(m)
    }

    // はがれて浮いているポリゴンの破片
    const shardMat = new THREE.MeshBasicMaterial({
      color: 0x6d9a3a,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.pool.track(shardMat)
    const rnd = mulberry32(1212)
    for (let i = 0; i < 14; i++) {
      const g = new THREE.PlaneGeometry(0.35 + rnd() * 1.1, 0.3 + rnd() * 0.9)
      const m = new THREE.Mesh(g, shardMat)
      m.position.set(
        HOLE.x + (rnd() - 0.5) * (HOLE.sx + 3),
        HOUSE_GROUND + 0.4 + rnd() * 3.2,
        HOLE.z + (rnd() - 0.5) * (HOLE.sz + 3),
      )
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3)
      m.userData.spin = (rnd() - 0.5) * 0.25
      this.shards.push(m)
      s.add(m)
    }
  }

  // ------------------------------------------------------------------

  private buildProps() {
    const s = this.scene
    const metal = this.style.makeMaterial({ kind: 'metal', color: 0x7a6a58, roughness: 0.72, metalness: 0.5 })
    const wood = this.style.makeMaterial({ kind: 'prop', color: 0x8a7355, roughness: 0.95 })

    // 郵便受け（歩き出してすぐ）
    const mb = new Batch(metal, 'mailbox')
    const my = height(FENCE_X + 0.5, 138)
    mb.box(FENCE_X + 0.55, my + 1.06, 138, 0.24, 0.3, 0.44)
    mb.cylinder(FENCE_X + 0.55, my + 1.21, 138, 0.12, 0.12, 0.44, 10)
    const mbm = mb.finish()!
    mbm.castShadow = true
    s.add(mbm)
    const post = new Batch(wood, 'mailboxPost')
    post.box(FENCE_X + 0.55, my + 0.45, 138, 0.09, 0.9, 0.09)
    const pm = post.finish()!
    pm.castShadow = true
    s.add(pm)
    this.interactables.push({
      position: new THREE.Vector3(FENCE_X + 0.55, my + 1.1, 138),
      radius: 4,
      fragment: '郵便受けの名前は、雨で読めなくなっている。',
    })

    // 途中の里程標
    const my2 = height(-FENCE_X - 0.6, 60)
    const stoneMat = this.style.makeMaterial({ kind: 'prop', color: 0xa8a196, roughness: 0.96 })
    const st = new Batch(stoneMat, 'marker')
    st.box(-FENCE_X - 0.7, my2 + 0.34, 60, 0.28, 0.68, 0.2)
    const stm = st.finish()!
    stm.castShadow = true
    s.add(stm)
    this.interactables.push({
      position: new THREE.Vector3(-FENCE_X - 0.7, my2 + 0.5, 60),
      radius: 4,
      fragment: 'あと少し、と言いながら、何度もこの坂を上った。',
    })

    // 門の外、野原へのきっかけ
    const gy = height(FENCE_X + 2.2, 45)
    this.interactables.push({
      position: new THREE.Vector3(FENCE_X + 2.2, gy + 1.1, 45),
      radius: 5,
      fragment: '柵の切れ目。ここから入っては、いけなかったはずだ。',
    })

    // 風車が見えるあたり
    this.interactables.push({
      position: new THREE.Vector3(-FENCE_X - 0.3, height(-FENCE_X, -20) + 1.3, -20),
      radius: 5,
      fragment: '風車の音は、遠くから聞こえるくらいが、ちょうどよかった。',
    })
  }

  // ------------------------------------------------------------------

  override waterLevelAt() {
    return null
  }

  override update(dt: number, player: Player) {
    this.elapsed += dt

    // 太陽（影のカメラ）をプレイヤーに追従させる
    if (this.sun) {
      this.sun.target.position.set(player.pos.x, player.pos.y, player.pos.z)
      this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 150)
      this.sun.target.updateMatrixWorld()
    }

    // 風車
    for (let i = 0; i < this.rotors.length; i++) {
      this.rotors[i].rotation.z += dt * (0.26 + (i % 3) * 0.035)
    }

    // 破片が漂う
    for (const sh of this.shards) {
      sh.rotation.x += dt * (sh.userData.spin as number)
      sh.rotation.y += dt * (sh.userData.spin as number) * 0.7
    }

    for (const g of this.glitchMats) g.uniforms.uTime.value = this.elapsed

    // 穴に近づくほど画面が壊れる
    const d = Math.max(
      0,
      Math.hypot(player.pos.x - HOLE.x, player.pos.z - HOLE.z) - Math.max(HOLE.sx, HOLE.sz) / 2,
    )
    this.glitch = 1 - smoothstep01(d / 16)
  }

  override dispose() {
    this.sky?.dispose()
    this.sky = null
    for (const g of this.grass) g.dispose()
    this.grass.length = 0
    this.map?.texture.dispose()
    super.dispose()
  }

  private tmpDir = new THREE.Vector3()

  /** 草は視点を知る必要がある */
  override onCamera(camera: THREE.PerspectiveCamera, dt: number) {
    camera.getWorldDirection(this.tmpDir)
    for (const g of this.grass) g.update(dt, camera.position, this.tmpDir)
  }
}

// ---------------- 小さな部品 ----------------

function clapboardSide(
  batch: Batch,
  x: number,
  cz: number,
  thickness: number,
  depth: number,
  y0: number,
  hgt: number,
) {
  const bh = 0.235
  const n = Math.ceil(hgt / bh)
  for (let i = 0; i < n; i++) {
    const y = y0 + i * bh + bh / 2
    const hh = Math.min(bh, y0 + hgt - (y - bh / 2))
    if (hh <= 0.02) break
    batch.box(x, y, cz, thickness + 0.056, hh * 0.96, depth)
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const batch = new Batch(new THREE.MeshBasicMaterial(), 'tmp')
  batch.add(a, new THREE.Matrix4())
  batch.add(b, new THREE.Matrix4())
  const mesh = batch.finish()!
  const geo = mesh.geometry
  a.dispose()
  b.dispose()
  return geo
}

/** 先が尖った縦板 */
function picketGeometry(w: number, h: number, d: number) {
  const body = new THREE.BoxGeometry(w, h * 0.88, d)
  body.translate(0, -h * 0.06, 0)
  const tip = new THREE.ConeGeometry(w * 0.72, h * 0.14, 4)
  tip.rotateY(Math.PI / 4)
  tip.scale(1, 1, d / w)
  tip.translate(0, h * 0.45, 0)
  return mergeTwo(body, tip)
}

/** 風車の羽根：根元が太く先が細い、ねじれた板 */
function bladeGeometry3(length: number) {
  const seg = 8
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const r = 1.6 + t * length
    const chord = 3.1 * (1 - t * 0.86) + 0.15
    const twist = (1 - t) * 0.5
    const c = Math.cos(twist)
    const sn = Math.sin(twist)
    const thick = 0.4 * (1 - t * 0.85) + 0.03
    for (const side of [-1, 1]) {
      const lx = (chord / 2) * side
      const lz = thick * 0.5 * side * 0.2
      positions.push(lx * c - lz * sn, r, lx * sn + lz * c)
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}
