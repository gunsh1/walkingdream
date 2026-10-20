import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { World, type ExitSpec, type WorldMeta } from './World'
import { realisticStyle } from '../render/styles/realistic'
import { POOL } from '../data/palette'
import { Water } from '../render/Water'
import { gradientEnvironment } from '../render/Environment'
import type { AmbienceSpec } from '../core/Audio'
import type { Player } from '../core/Player'
import { Batch, instances, mat4, mushroomCapGeometry, rockGeometry } from '../gen/build'
import { checkerTiles, flutedColumn, grainy, gridTiles, mushroomCap, mulberry32, softDot } from '../gen/textures'

// ---------- 寸法 ----------
const X_MIN = -18
const X_MAX = 18
const Z_MIN = -66
const Z_MAX = 14
const CEIL_Y = 5.4
const WATER_Y = 0.3
const WALK_Y = 0.36

// 抜け穴（水中の深み）
const HOLE = { x: -12.5, z: -56, s: 3.4 }
const HX0 = HOLE.x - HOLE.s / 2
const HX1 = HOLE.x + HOLE.s / 2
const HZ0 = HOLE.z - HOLE.s / 2
const HZ1 = HOLE.z + HOLE.s / 2
/** 泡を撒く坑の深さ */
const BUBBLE_DEPTH = 120

/** 通路は軸に沿った矩形だけで構成する（当たり判定を AABB のままにするため） */
const WALK: Array<[number, number, number, number]> = [
  // [x0, z0, x1, z1]
  [-1.8, -4, 1.8, 14],
  [-8.8, -7.6, 1.8, -4],
  [-8.8, -25, -5.2, -7.6],
  [-8.8, -28.6, 2, -25],
  [-1.6, -33, 2, -28.6],
  // ここで途切れる ── 水を渡る
  [6.2, -47, 9.8, -42],
  [-3, -50.6, 9.8, -47],
  [-3, -54, 0.6, -50.6],
  [-8, -57.6, 0.6, -54],
]

const COLUMNS: Array<[number, number]> = [
  [11.5, 2],
  [11.5, -14],
  [11.5, -30],
  [11.5, -46],
  [-13.5, -6],
  [-13.5, -22],
  [4.5, -20],
  [-3, -44],
]

/** [x, z, 傘の半径, 柄の高さ] */
const MUSHROOMS: Array<[number, number, number, number]> = [
  [-14, 6, 3.4, 3.0],
  [-15.5, -1, 2.4, 2.2],
  [-12.5, -9.5, 1.6, 1.4],
  [14.5, -8, 3.2, 2.9],
  [-15, -30, 2.8, 2.6],
  [12.5, -38, 2.2, 2.0],
  [-14.5, -46, 3.0, 2.7],
  [-4, -62, 2.6, 2.4],
]

function flatQuad(x0: number, z0: number, x1: number, z1: number, y: number, uvScale: number) {
  const sx = x1 - x0
  const sz = z1 - z0
  const g = new THREE.PlaneGeometry(sx, sz)
  g.rotateX(-Math.PI / 2)
  g.translate(x0 + sx / 2, y, z0 + sz / 2)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (sx / uvScale), uv.getY(i) * (sz / uvScale))
  }
  uv.needsUpdate = true
  return g
}

function wallQuad(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  rotY: number,
  uvScale: number,
) {
  const g = new THREE.PlaneGeometry(w, h)
  g.rotateY(rotY)
  g.translate(x, y, z)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / uvScale), uv.getY(i) * (h / uvScale))
  }
  uv.needsUpdate = true
  return g
}

export class MushroomPool extends World {
  readonly meta: WorldMeta = {
    id: 'pool',
    title: 'きのこのプール',
    caption: '天井が低い。水はぬるい。',
  }
  readonly style = realisticStyle(this.pool)
  readonly ambience: AmbienceSpec = {
    noiseFreq: 320,
    noiseQ: 0.55,
    noiseGain: 0.055,
    padRoot: 87.3,
    padRatios: [1, 1.5, 2, 3],
    padGain: 0.026,
    reverb: 3.2,
    dripRate: 0.55,
    dripFreq: 1100,
  }
  readonly spawn = { x: 0, y: WALK_Y, z: 11, yaw: 0 }
  readonly exit: ExitSpec = {
    kind: 'sink',
    // 穴の真上に来て、底より下まで沈んだら転移。ふちに立っているだけでは発火しない。
    contains: (p: THREE.Vector3) =>
      p.x > HX0 && p.x < HX1 && p.z > HZ0 && p.z < HZ1 && p.y < -0.4,
    entryVelocity: new THREE.Vector3(0, -2.2, 0),
    tunnelTint: POOL.waterDeep,
  }
  surface = 'tile' as const

  private waterfallMat: THREE.MeshBasicMaterial | null = null
  private shaftLightMat: THREE.MeshBasicMaterial | null = null
  private bubbles: THREE.Points | null = null
  private bubbleSpeeds: Float32Array | null = null
  private wakeCooldown = 0;

  *build(renderer: THREE.WebGLRenderer) {
    const s = this.scene
    s.background = new THREE.Color(POOL.wallLilac).multiplyScalar(0.35)
    s.fog = new THREE.Fog(0x9fc9c8, 40, 140)
    // 天井の灰色 → 壁のミント → 水のターコイズ。金属と艶面がここから色を拾う。
    s.environment = gradientEnvironment(renderer, POOL.ceiling, POOL.wallMint, POOL.waterShallow, 0.55)

    // =============== 床（プールの底）と通路 ===============
    const bottomTex = gridTiles({ key: 'poolBottom', base: POOL.wallMint, grout: 0xa9c6c0, cells: 12 })
    const bottomMat = this.style.makeMaterial({ kind: 'floor', color: 0xffffff, map: bottomTex, roughness: 0.35 })
    const bottom = new Batch(bottomMat, 'poolBottom')
    // 穴のまわりを4枚に分けて張る
    bottom.add(flatQuad(X_MIN, Z_MIN, HX0, Z_MAX, 0, 3.6), new THREE.Matrix4())
    bottom.add(flatQuad(HX1, Z_MIN, X_MAX, Z_MAX, 0, 3.6), new THREE.Matrix4())
    bottom.add(flatQuad(HX0, HZ1, HX1, Z_MAX, 0, 3.6), new THREE.Matrix4())
    bottom.add(flatQuad(HX0, Z_MIN, HX1, HZ0, 0, 3.6), new THREE.Matrix4())
    const bottomMesh = bottom.finish()!
    bottomMesh.receiveShadow = true
    s.add(bottomMesh)
    yield 'pool floor'

    const walkTex = checkerTiles({
      key: 'poolWalk',
      colors: POOL.tile,
      grout: POOL.tileGrout,
      cells: 8,
      seed: 20260823,
    })
    const walkMat = this.style.makeMaterial({ kind: 'floor', color: 0xffffff, map: walkTex, roughness: 0.18 })
    const walk = new Batch(walkMat, 'walkway')
    const copingMat = this.style.makeMaterial({
      kind: 'prop',
      color: POOL.copingTop,
      map: grainy({ key: 'coping', base: 0xffffff, contrast: 0.03 }),
      roughness: 0.5,
    })
    const coping = new Batch(copingMat, 'coping')

    for (const [x0, z0, x1, z1] of WALK) {
      walk.add(flatQuad(x0, z0, x1, z1, WALK_Y, 3.6), new THREE.Matrix4())
      // 側面（水に沈む部分）
      coping.box((x0 + x1) / 2, WALK_Y / 2, z0, x1 - x0, WALK_Y, 0.12)
      coping.box((x0 + x1) / 2, WALK_Y / 2, z1, x1 - x0, WALK_Y, 0.12)
      coping.box(x0, WALK_Y / 2, (z0 + z1) / 2, 0.12, WALK_Y, z1 - z0)
      coping.box(x1, WALK_Y / 2, (z0 + z1) / 2, 0.12, WALK_Y, z1 - z0)
      this.collision.addFloor(x0, z0, x1, z1, WALK_Y)
    }
    yield 'walkway'

    // =============== 曲がったプールの縁石 ===============
    // 参考画像の白い曲線の仕切り。水を区切って形を作る。
    const curves: THREE.Vector2[][] = [
      [
        new THREE.Vector2(-17.5, -12),
        new THREE.Vector2(-12, -14.5),
        new THREE.Vector2(-11.5, -19),
        new THREE.Vector2(-14, -23),
        new THREE.Vector2(-17.5, -24),
      ],
      [
        new THREE.Vector2(17.5, -16),
        new THREE.Vector2(12, -19),
        new THREE.Vector2(10.5, -25),
        new THREE.Vector2(13, -31),
        new THREE.Vector2(17.5, -33),
      ],
      [
        new THREE.Vector2(-17.5, -38),
        new THREE.Vector2(-11, -40),
        new THREE.Vector2(-8, -45),
        new THREE.Vector2(-9.5, -50),
        new THREE.Vector2(-17.5, -52),
      ],
      [
        new THREE.Vector2(3.5, 13.5),
        new THREE.Vector2(6, 9),
        new THREE.Vector2(10, 7.5),
        new THREE.Vector2(14, 8.5),
        new THREE.Vector2(17.5, 6),
      ],
    ]
    for (const c of curves) {
      const pts = new THREE.SplineCurve(c).getSpacedPoints(26)
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        const ang = Math.atan2(b.x - a.x, b.y - a.y)
        coping.box((a.x + b.x) / 2, 0.22, (a.y + b.y) / 2, 0.55, 0.44, len + 0.3, ang)
      }
    }
    const copingMesh = coping.finish()!
    copingMesh.castShadow = true
    copingMesh.receiveShadow = true
    s.add(copingMesh)
    const walkMesh = walk.finish()!
    walkMesh.receiveShadow = true
    s.add(walkMesh)
    yield 'coping'

    // =============== 壁 ===============
    const wallTexA = grainy({ key: 'wallPink', base: 0xffffff, contrast: 0.035, blotches: 40 })
    const southMat = this.style.makeMaterial({ kind: 'wall', color: POOL.wallPink, map: wallTexA, roughness: 0.8 })
    const northMat = this.style.makeMaterial({ kind: 'wall', color: POOL.wallYellow, map: wallTexA, roughness: 0.8 })
    const sideMat = this.style.makeMaterial({ kind: 'wall', color: POOL.wallLilac, map: wallTexA, roughness: 0.85 })
    const upperMat = this.style.makeMaterial({ kind: 'wall', color: POOL.wallMint, map: wallTexA, roughness: 0.85 })

    const south = new Batch(southMat, 'wallSouth')
    south.add(wallQuad(0, CEIL_Y / 2, Z_MAX, X_MAX - X_MIN, CEIL_Y, Math.PI, 3), new THREE.Matrix4())
    s.add(south.finish()!)

    const north = new Batch(northMat, 'wallNorth')
    north.add(wallQuad(0, CEIL_Y / 2, Z_MIN, X_MAX - X_MIN, CEIL_Y, 0, 3), new THREE.Matrix4())
    s.add(north.finish()!)

    // 側壁は腰から下をラベンダー、上をミントに
    const side = new Batch(sideMat, 'wallSide')
    side.add(wallQuad(X_MIN, 0.9, -26, Z_MAX - Z_MIN, 1.8, Math.PI / 2, 3), new THREE.Matrix4())
    side.add(wallQuad(X_MAX, 0.9, -26, Z_MAX - Z_MIN, 1.8, -Math.PI / 2, 3), new THREE.Matrix4())
    s.add(side.finish()!)
    const upper = new Batch(upperMat, 'wallUpper')
    upper.add(wallQuad(X_MIN, (CEIL_Y + 1.8) / 2, -26, Z_MAX - Z_MIN, CEIL_Y - 1.8, Math.PI / 2, 3), new THREE.Matrix4())
    upper.add(wallQuad(X_MAX, (CEIL_Y + 1.8) / 2, -26, Z_MAX - Z_MIN, CEIL_Y - 1.8, -Math.PI / 2, 3), new THREE.Matrix4())
    s.add(upper.finish()!)

    this.collision.addBoxCS(0, CEIL_Y / 2, Z_MAX + 0.5, 60, CEIL_Y * 2, 1)
    this.collision.addBoxCS(0, CEIL_Y / 2, Z_MIN - 0.5, 60, CEIL_Y * 2, 1)
    this.collision.addBoxCS(X_MIN - 0.5, CEIL_Y / 2, -26, 1, CEIL_Y * 2, 84)
    this.collision.addBoxCS(X_MAX + 0.5, CEIL_Y / 2, -26, 1, CEIL_Y * 2, 84)
    yield 'walls'

    // 北壁のドア（開かない。奥に何かある気配だけ）
    const doorMat = this.style.makeMaterial({ kind: 'prop', color: 0xe8e2d2, roughness: 0.6 })
    const doorGlass = this.style.makeMaterial({ kind: 'emissive', color: 0x2a3a38, emissive: 0x203030, emissiveIntensity: 0.5 })
    const doors = new Batch(doorMat, 'doors')
    const doorGlassB = new Batch(doorGlass, 'doorGlass')
    for (const dx of [-6, 0, 6]) {
      doors.box(dx, 1.1, Z_MIN + 0.12, 1.9, 2.2, 0.16)
      doorGlassB.box(dx, 1.35, Z_MIN + 0.22, 1.5, 1.5, 0.06)
    }
    s.add(doors.finish()!)
    s.add(doorGlassB.finish()!)

    // =============== 柱（ピンクのフルート柱） ===============
    const colTex = flutedColumn({ key: 'pink', base: POOL.columnPink, dark: POOL.columnPinkDark, flutes: 22 })
    colTex.repeat.set(1, 1)
    const colMat = this.style.makeMaterial({ kind: 'prop', color: 0xffffff, map: colTex, roughness: 0.55 })
    const colGeo = new THREE.CylinderGeometry(0.55, 0.6, CEIL_Y, 24, 1, false)
    const capGeo = new THREE.BoxGeometry(1.5, 0.22, 1.5)
    const colBatch = new Batch(colMat, 'columns')
    for (const [cx, cz] of COLUMNS) {
      colBatch.add(colGeo, new THREE.Matrix4().setPosition(cx, CEIL_Y / 2, cz))
      colBatch.add(capGeo, new THREE.Matrix4().setPosition(cx, CEIL_Y - 0.11, cz))
      colBatch.add(capGeo, new THREE.Matrix4().setPosition(cx, 0.11, cz))
      this.collision.addBoxCS(cx, CEIL_Y / 2, cz, 1.1, CEIL_Y, 1.1)
    }
    colGeo.dispose()
    capGeo.dispose()
    const colMesh = colBatch.finish()!
    colMesh.castShadow = true
    s.add(colMesh)
    yield 'columns'

    // =============== キノコ ===============
    const capTex = mushroomCap({ key: 'red', red: POOL.capRed, spot: POOL.capSpot })
    const capMat = this.style.makeMaterial({ kind: 'organic', color: 0xffffff, map: capTex, roughness: 0.62, side: THREE.DoubleSide })
    const stalkMat = this.style.makeMaterial({
      kind: 'organic',
      color: POOL.stalk,
      map: grainy({ key: 'stalk', base: 0xffffff, contrast: 0.05, blotches: 30 }),
      roughness: 0.78,
    })
    const capBatch = new Batch(capMat, 'caps')
    const stalkBatch = new Batch(stalkMat, 'stalks')
    for (const [mx, mz, r, h] of MUSHROOMS) {
      const stalkR = r * 0.26
      const g = new THREE.CylinderGeometry(stalkR * 0.82, stalkR * 1.25, h, 18)
      stalkBatch.add(g, new THREE.Matrix4().setPosition(mx, h / 2, mz))
      g.dispose()
      const cg = mushroomCapGeometry(r, r * 0.62, 26)
      capBatch.add(cg, new THREE.Matrix4().setPosition(mx, h - 0.06, mz))
      cg.dispose()
      // 傘の裏のひだ
      const ug = new THREE.CircleGeometry(r * 0.97, 26)
      ug.rotateX(Math.PI / 2)
      capBatch.add(ug, new THREE.Matrix4().setPosition(mx, h - 0.08, mz))
      ug.dispose()
      this.collision.addBoxCS(mx, h / 2, mz, stalkR * 2.2, h, stalkR * 2.2)
    }
    const capMesh = capBatch.finish()!
    capMesh.castShadow = true
    s.add(capMesh)
    const stalkMesh = stalkBatch.finish()!
    stalkMesh.castShadow = true
    stalkMesh.receiveShadow = true
    s.add(stalkMesh)
    yield 'mushrooms'

    // =============== 岩 ===============
    const rnd = mulberry32(5150)
    const rockMat = this.style.makeMaterial({
      kind: 'prop',
      color: POOL.rock,
      map: grainy({ key: 'rock', base: 0xffffff, contrast: 0.12, blotches: 90 }),
      roughness: 0.95,
      flatShading: true,
    })
    const rockGeo = rockGeometry(1, 2, 0.24, rnd)
    const rockTf: THREE.Matrix4[] = []
    const pushRocks = (x: number, z: number, count: number, spread: number, scale: number) => {
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2
        const d = Math.sqrt(rnd()) * spread
        const px = x + Math.cos(a) * d
        const pz = z + Math.sin(a) * d
        const sc = scale * (0.5 + rnd() * 0.9)
        rockTf.push(mat4(px, sc * 0.34, pz, rnd() * Math.PI * 2, sc))
      }
    }
    for (let z = 12; z > Z_MIN; z -= 7) {
      pushRocks(X_MIN + 1.4 + rnd() * 1.2, z, 5, 2.2, 0.85)
      pushRocks(X_MAX - 1.4 - rnd() * 1.2, z + 3, 5, 2.2, 0.85)
    }
    for (const [mx, mz, r] of MUSHROOMS) pushRocks(mx, mz, 4, r * 0.8, 0.5)
    const rockMesh = instances(rockGeo, rockMat, rockTf, 'rocks')
    rockMesh.castShadow = true
    rockMesh.receiveShadow = true
    s.add(rockMesh)
    yield 'rocks'

    // =============== 天井 ===============
    const ceilMat = this.style.makeMaterial({
      kind: 'ceiling',
      color: POOL.ceiling,
      map: grainy({ key: 'ceil', base: 0xffffff, contrast: 0.06, blotches: 50 }),
      roughness: 0.95,
    })
    const ceil = new Batch(ceilMat, 'ceiling')
    const cq = new THREE.PlaneGeometry(X_MAX - X_MIN, Z_MAX - Z_MIN)
    cq.rotateX(Math.PI / 2)
    cq.translate(0, CEIL_Y, -26)
    const cuv = cq.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) * 9, cuv.getY(i) * 20)
    cuv.needsUpdate = true
    ceil.add(cq, new THREE.Matrix4())
    cq.dispose()
    s.add(ceil.finish()!)

    const ductMat = this.style.makeMaterial({ kind: 'metal', color: POOL.duct, roughness: 0.6, metalness: 0.35 })
    const duct = new Batch(ductMat, 'ducts')
    for (let z = 10; z > Z_MIN; z -= 13) {
      duct.box(0, CEIL_Y - 0.6, z, X_MAX - X_MIN, 0.85, 1.15)
    }
    duct.box(-4, CEIL_Y - 0.5, -26, 1.5, 1.0, Z_MAX - Z_MIN)
    for (const [vx, vz] of [
      [2, 2],
      [-6, -30],
      [8, -54],
    ]) {
      duct.cylinder(vx, CEIL_Y - 0.22, vz, 1.05, 1.05, 0.44, 20)
    }
    s.add(duct.finish()!)

    const pipeMat = this.style.makeMaterial({ kind: 'metal', color: POOL.pipe, roughness: 0.42, metalness: 0.6 })
    const pipes = new Batch(pipeMat, 'pipes')
    const pipeGeo = new THREE.CylinderGeometry(0.11, 0.11, Z_MAX - Z_MIN, 10)
    pipeGeo.rotateX(Math.PI / 2)
    for (const px of [6.4, 6.9, 7.4, -10.6, -11.1]) {
      pipes.add(pipeGeo, new THREE.Matrix4().setPosition(px, CEIL_Y - 0.28, -26))
    }
    pipeGeo.dispose()
    s.add(pipes.finish()!)
    yield 'ceiling'

    // =============== 照明 ===============
    const stripMat = this.style.makeMaterial({
      kind: 'emissive',
      color: POOL.lightWarm,
      emissive: POOL.lightWarm,
      emissiveIntensity: 4.2,
    })
    const strips = new Batch(stripMat, 'strips')
    for (let z = 9; z > Z_MIN + 2; z -= 8.5) {
      strips.box(-9, CEIL_Y - 0.14, z, 0.26, 0.09, 5.4)
      strips.box(9, CEIL_Y - 0.14, z + 4, 0.26, 0.09, 5.4)
    }
    s.add(strips.finish()!)

    // 東側にぶら下がる裸電球の列
    const bulbMat = this.style.makeMaterial({
      kind: 'emissive',
      color: 0xffffff,
      emissive: POOL.lightWarm,
      emissiveIntensity: 7,
    })
    const bulbGeo = new THREE.SphereGeometry(0.085, 10, 8)
    const bulbTf: THREE.Matrix4[] = []
    for (let z = 12; z > Z_MIN + 2; z -= 2.2) {
      const sag = Math.sin(((z - 12) / 2.2) * 0.9) * 0.16
      bulbTf.push(mat4(15.6, CEIL_Y - 0.75 + sag, z, 0, 1))
      bulbTf.push(mat4(-15.6, CEIL_Y - 0.8 - sag * 0.7, z - 1.1, 0, 1))
    }
    s.add(instances(bulbGeo, bulbMat, bulbTf, 'bulbs'))

    s.add(new THREE.AmbientLight(0xd6e8ea, 0.25))
    s.add(new THREE.HemisphereLight(0xe8f6f2, 0xf2d2da, 0.8))
    const sun = new THREE.DirectionalLight(POOL.lightWarm, 1.1)
    sun.position.set(12, 16, 10)
    sun.target.position.set(-4, 0, -30)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -24
    sun.shadow.camera.right = 24
    sun.shadow.camera.top = 46
    sun.shadow.camera.bottom = -46
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 70
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.03
    sun.shadow.camera.updateProjectionMatrix()
    s.add(sun)
    s.add(sun.target)

    const p1 = new THREE.PointLight(POOL.lightWarm, 26, 22, 2)
    p1.position.set(0, 3.6, 6)
    s.add(p1)
    const p2 = new THREE.PointLight(POOL.lightWarm, 22, 20, 2)
    p2.position.set(-11, 3.8, -14)
    s.add(p2)
    const p3 = new THREE.PointLight(POOL.lightWarm, 24, 22, 2)
    p3.position.set(4, 3.6, -37)
    s.add(p3)
    // 出口の合図：ここだけ冷たい色で明るい
    const pExit = new THREE.PointLight(POOL.lightCool, 30, 30, 2)
    pExit.position.set(HOLE.x, 4.2, HOLE.z)
    s.add(pExit)
    const pExitLow = new THREE.PointLight(POOL.lightCool, 10, 9, 2)
    pExitLow.position.set(HOLE.x, 0.8, HOLE.z)
    s.add(pExitLow)
    yield 'lights'

    // =============== 抜け穴 ===============
    // 底に開いた四角い穴。タイル張りの縦坑がしばらく続き、その下は真っ暗。
    const shaftMat = this.style.makeMaterial({
      kind: 'wall',
      color: 0x8fb0ac,
      map: gridTiles({ key: 'poolBottom', base: POOL.wallMint, grout: 0xa9c6c0, cells: 12 }),
      roughness: 0.4,
    })
    const shaft = new Batch(shaftMat, 'shaft')
    const shaftDepth = 14
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2
      const g = new THREE.PlaneGeometry(HOLE.s, shaftDepth)
      const uv = g.attributes.uv as THREE.BufferAttribute
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (HOLE.s / 3.6), uv.getY(k) * (shaftDepth / 3.6))
      uv.needsUpdate = true
      // 法線が坑の内側を向くように（外から覗くと奥の面だけが見える）
      g.rotateY(ang + Math.PI)
      g.translate(
        HOLE.x + Math.sin(ang) * (HOLE.s / 2),
        -shaftDepth / 2,
        HOLE.z + Math.cos(ang) * (HOLE.s / 2),
      )
      shaft.add(g, new THREE.Matrix4())
      g.dispose()
    }
    s.add(shaft.finish()!)

    const voidMat = new THREE.MeshBasicMaterial({ color: POOL.voidBlack, side: THREE.BackSide, fog: false })
    this.pool.track(voidMat)
    const voidBox = new THREE.Mesh(new THREE.BoxGeometry(HOLE.s, 150, HOLE.s), voidMat)
    voidBox.position.set(HOLE.x, -shaftDepth - 74, HOLE.z)
    s.add(voidBox)

    // ふちから落ちる水のカーテン。内向きなので手前側は自動で消える。
    const fallTex = grainy({ key: 'waterfall', base: 0xffffff, contrast: 0.16, blotches: 20, size: 64 })
    fallTex.repeat.set(1, 3)
    this.waterfallMat = new THREE.MeshBasicMaterial({
      color: POOL.waterFoam,
      map: fallTex,
      transparent: true,
      opacity: 0.3,
      side: THREE.FrontSide,
      depthWrite: false,
      fog: false,
    })
    this.pool.track(this.waterfallMat)
    const fallH = 0.85
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2
      const m = new THREE.Mesh(new THREE.PlaneGeometry(HOLE.s, fallH), this.waterfallMat)
      m.position.set(
        HOLE.x + Math.sin(ang) * (HOLE.s / 2 - 0.02),
        WATER_Y - fallH / 2,
        HOLE.z + Math.cos(ang) * (HOLE.s / 2 - 0.02),
      )
      m.rotation.y = ang + Math.PI
      m.renderOrder = 3
      s.add(m)
    }

    // 水面のふち（あわの線）。ここで水が終わっていることを見せる。
    const lipMat = new THREE.MeshBasicMaterial({
      color: POOL.waterFoam,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      fog: false,
    })
    this.pool.track(lipMat)
    const lip = new Batch(lipMat, 'holeLip')
    const lw = 0.22
    lip.box(HOLE.x, WATER_Y + 0.004, HZ0 - lw / 2, HOLE.s + lw * 2, 0.008, lw)
    lip.box(HOLE.x, WATER_Y + 0.004, HZ1 + lw / 2, HOLE.s + lw * 2, 0.008, lw)
    lip.box(HX0 - lw / 2, WATER_Y + 0.004, HOLE.z, lw, 0.008, HOLE.s)
    lip.box(HX1 + lw / 2, WATER_Y + 0.004, HOLE.z, lw, 0.008, HOLE.s)
    const lipMesh = lip.finish()!
    lipMesh.renderOrder = 4
    s.add(lipMesh)

    // 坑の中を昇っていく泡。落ちている間の速度感になる。
    {
      const n = 2000
      const pos = new Float32Array(n * 3)
      const speeds = new Float32Array(n)
      const r = mulberry32(881)
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2
        // 中心を避ける：まっすぐ落ちるプレイヤーの目の前で巨大化しないように
        const rad = 0.45 + r() * 1.2
        pos[i * 3] = HOLE.x + Math.cos(a) * rad
        pos[i * 3 + 1] = -r() * BUBBLE_DEPTH
        pos[i * 3 + 2] = HOLE.z + Math.sin(a) * rad
        speeds[i] = 0.5 + r() * 1.6
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(HOLE.x, -BUBBLE_DEPTH / 2, HOLE.z), BUBBLE_DEPTH)
      const pm = new THREE.PointsMaterial({
        size: 0.045,
        map: softDot('bubble'),
        color: POOL.waterFoam,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        sizeAttenuation: true,
        fog: false,
      })
      this.pool.track(pm)
      this.bubbles = new THREE.Points(g, pm)
      this.bubbleSpeeds = speeds
      s.add(this.bubbles)
    }

    // 出口の目印：天井から水面へ落ちる淡い光の柱
    this.shaftLightMat = new THREE.MeshBasicMaterial({
      color: POOL.lightCool,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const shaftLight = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 1.6, CEIL_Y - WATER_Y, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: POOL.lightCool,
        transparent: true,
        opacity: 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    )
    shaftLight.material = this.shaftLightMat
    this.pool.track(this.shaftLightMat)
    shaftLight.position.set(HOLE.x, (CEIL_Y + WATER_Y) / 2, HOLE.z)
    shaftLight.renderOrder = 2
    s.add(shaftLight)

    this.collision.addFloor(X_MIN, Z_MIN, X_MAX, Z_MAX, 0)
    this.collision.addHole(HOLE.x, HOLE.z, HOLE.s, HOLE.s, 1.6, -60)
    yield 'exit'

    // =============== 水 ===============
    const waterGeo = mergeWaterQuads()
    this.water = new Water(renderer, {
      level: WATER_Y,
      min: new THREE.Vector2(X_MIN, Z_MIN),
      max: new THREE.Vector2(X_MAX, Z_MAX),
      shallow: POOL.waterShallow,
      deep: POOL.waterDeep,
      foam: POOL.waterFoam,
      sunDir: new THREE.Vector3(12, 16, 10),
      sunColor: POOL.lightWarm,
      absorption: 1.0,
      distortion: 0.028,
      reflectivity: 0.08,
      rippleStrength: 7.0,
      waveStrength: 0.012,
      foamWidth: 0.1,
      specular: 1.1,
      geometry: waterGeo,
    })
    s.add(this.water.mesh)
    yield 'water'

    // =============== 小物と断片 ===============
    this.buildProps()
    yield 'props'
  }

  private buildProps() {
    const s = this.scene
    const propMat = this.style.makeMaterial({ kind: 'prop', color: 0xf5e9d8, roughness: 0.6 })
    const rubberMat = this.style.makeMaterial({ kind: 'prop', color: 0xe86a7a, roughness: 0.45 })
    const metalMat = this.style.makeMaterial({ kind: 'metal', color: 0xc8ccd0, roughness: 0.35, metalness: 0.7 })

    // 1. 片方だけのサンダル
    const sandal = new Batch(rubberMat, 'sandal')
    sandal.box(1.05, WALK_Y + 0.025, 6.4, 0.14, 0.05, 0.3, 0.35)
    sandal.box(1.42, WALK_Y + 0.025, 5.9, 0.14, 0.05, 0.3, -0.9)
    const sandalMesh = sandal.finish()!
    sandalMesh.castShadow = true
    s.add(sandalMesh)
    this.interactables.push({
      position: new THREE.Vector3(1.2, WALK_Y + 0.1, 6.15),
      radius: 3.2,
      fragment: 'サンダルが片方だけ残っている。まだ、乾いていない。',
      object: sandalMesh,
    })

    // 2. 柱に掛かった浮き輪
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.14, 10, 24), rubberMat)
    ring.position.set(11.5, 1.35, -13.35)
    ring.rotation.x = Math.PI / 2
    ring.rotation.z = 0.3
    ring.castShadow = true
    s.add(ring)
    this.interactables.push({
      position: new THREE.Vector3(11.5, 1.35, -13.35),
      radius: 3.4,
      fragment: '浮き輪に空気を入れる係は、いつも決まっていた。',
      object: ring,
    })

    // 3. もう何も落ちてこない自販機
    const vend = new Batch(propMat, 'vending')
    vend.box(-4.6, 0.95, -63.4, 1.1, 1.9, 0.7)
    const vendMesh = vend.finish()!
    vendMesh.castShadow = true
    s.add(vendMesh)
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, 1.1),
      this.style.makeMaterial({ kind: 'emissive', color: 0xffffff, emissive: 0xffe8c0, emissiveIntensity: 1.1 }),
    )
    panel.position.set(-4.6, 1.25, -63.03)
    s.add(panel)
    this.interactables.push({
      position: new THREE.Vector3(-4.6, 1.25, -63.0),
      radius: 3.6,
      fragment: '百円を入れても、もう何も落ちてこない。',
      object: vendMesh,
    })

    // 4. 帰る時間で止まった時計
    const clockBody = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 24), metalMat)
    clockBody.rotation.x = Math.PI / 2
    clockBody.position.set(3, 3.3, Z_MIN + 0.2)
    s.add(clockBody)
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.37, 24),
      this.style.makeMaterial({ kind: 'unlit', color: 0xf6f2e8 }),
    )
    face.position.set(3, 3.3, Z_MIN + 0.26)
    s.add(face)
    const handMat = this.style.makeMaterial({ kind: 'unlit', color: 0x30343a })
    const hands = new Batch(handMat, 'hands')
    hands.box(3, 3.42, Z_MIN + 0.28, 0.035, 0.24, 0.02)
    hands.box(3.14, 3.3, Z_MIN + 0.28, 0.3, 0.035, 0.02, 0)
    s.add(hands.finish()!)
    this.interactables.push({
      position: new THREE.Vector3(3, 3.3, Z_MIN + 0.3),
      radius: 4.2,
      fragment: '針は、帰る時間のところで止まっている。',
      object: clockBody,
    })

    // 5. 出口のそば：脱ぎ捨てられたタオル
    const towelMat = this.style.makeMaterial({ kind: 'prop', color: 0xf0e2ea, roughness: 0.9 })
    const towel = new Batch(towelMat, 'towel')
    towel.box(-7.4, WALK_Y + 0.04, -56.2, 0.9, 0.08, 0.5, 0.4)
    towel.box(-7.1, WALK_Y + 0.09, -56.4, 0.6, 0.06, 0.4, -0.2)
    const towelMesh = towel.finish()!
    towelMesh.castShadow = true
    s.add(towelMesh)
    this.interactables.push({
      position: new THREE.Vector3(-7.3, WALK_Y + 0.1, -56.3),
      radius: 3.4,
      fragment: 'タオルはまだ濡れている。誰かが、さっきまでここにいた。',
      object: towelMesh,
    })
  }

  /** 穴の上には水面がない（落ちている間に水の抵抗がかからないように） */
  override waterLevelAt(x: number, z: number) {
    if (x > HX0 && x < HX1 && z > HZ0 && z < HZ1) return null
    return WATER_Y
  }

  override update(dt: number, player: Player) {
    // 水面の揺らぎ：歩いているあいだ、足元から波が出る
    if (this.water) {
      if (player.footstepEvent?.inWater) {
        this.water.splash(player.pos.x, player.pos.z, 0.55)
      }
      this.wakeCooldown -= dt
      const speed = Math.hypot(player.vel.x, player.vel.z)
      if (this.wakeCooldown <= 0 && player.submersion > 0.03 && speed > 0.4) {
        this.water.splash(player.pos.x, player.pos.z, 0.055 * Math.min(1, speed / 2.5))
        this.wakeCooldown = 0.05
      }
      // 穴に落ちる水が立てるさざなみ
      if (this.wakeCooldown <= 0.02 && Math.random() < 0.5) {
        const a = Math.random() * Math.PI * 2
        this.water.splash(
          HOLE.x + Math.cos(a) * (HOLE.s / 2 + 0.2),
          HOLE.z + Math.sin(a) * (HOLE.s / 2 + 0.2),
          0.09,
        )
      }
    }
    if (this.waterfallMat?.map) {
      this.waterfallMat.map.offset.y -= dt * 1.9
    }
    // 泡は上へ昇り、上端まで来たら下に戻る
    if (this.bubbles && this.bubbleSpeeds) {
      const attr = this.bubbles.geometry.attributes.position as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      for (let i = 0; i < this.bubbleSpeeds.length; i++) {
        const yi = i * 3 + 1
        arr[yi] += this.bubbleSpeeds[i] * dt
        if (arr[yi] > 0) arr[yi] -= BUBBLE_DEPTH
      }
      attr.needsUpdate = true
    }

    // 光の柱は遠くからの目印。近づいたら邪魔なので消す。
    if (this.shaftLightMat) {
      const d = Math.hypot(player.pos.x - HOLE.x, player.pos.z - HOLE.z)
      this.shaftLightMat.opacity = 0.055 * THREE.MathUtils.smoothstep(d, 4, 14)
    }
  }
}

/** 穴を避けた4枚の矩形で水面を作る */
function mergeWaterQuads() {
  const quads: THREE.BufferGeometry[] = []
  const add = (x0: number, z0: number, x1: number, z1: number) => {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
    g.rotateX(-Math.PI / 2)
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2)
    quads.push(g)
  }
  add(X_MIN, Z_MIN, HX0, Z_MAX)
  add(HX1, Z_MIN, X_MAX, Z_MAX)
  add(HX0, HZ1, HX1, Z_MAX)
  add(HX0, Z_MIN, HX1, HZ0)
  const merged = mergeGeometries(quads, false)!
  for (const q of quads) q.dispose()
  merged.computeBoundingSphere()
  return merged
}
