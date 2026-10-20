import * as THREE from 'three'
import { Renderer } from '../render/Renderer'
import { Input } from './Input'
import { Player, TUNING } from './Player'
import { Hud } from '../ui/Hud'
import { audio } from './Audio'
import { progress } from './Progress'
import type { World } from '../worlds/World'
import { MushroomPool } from '../worlds/W1_MushroomPool'
import { HillHouse } from '../worlds/W2_HillHouse'
import { disposeGeneratedTextures } from '../gen/textures'

type State = 'start' | 'playing' | 'falling' | 'paused'

/** 世界の並び。落ちるたびに次へ進み、戻る手段はない。 */
const WORLDS: Array<() => World> = [() => new MushroomPool(), () => new HillHouse()]

/** 落下の最短時間。次の世界の生成が終わっていてもこれより短くはしない。 */
const MIN_FALL = 3.2
/** 1フレームあたりの生成予算（ミリ秒） */
const BUILD_BUDGET_MS = 6

export class Game {
  private renderer: Renderer
  private input: Input
  private player = new Player()
  private hud = new Hud()
  private world: World | null = null
  private worldIndex = 0
  private state: State = 'start'

  private builder: Generator<string, void, void> | null = null
  private nextWorld: World | null = null
  private buildDone = false
  private fallTime = 0
  private stopWind: (() => void) | null = null

  private prevPaused: State = 'playing'
  private debugOn = false
  private fpsAccum = 0
  private fpsFrames = 0
  private fps = 0
  private gpuName = ''
  private noWater = false
  private noPost = false
  private noLock = false
  private tmpDir = new THREE.Vector3()
  private tmpTo = new THREE.Vector3()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas)
    this.input = new Input(canvas)

    const params = new URLSearchParams(location.search)
    this.debugOn = params.get('debug') === '1'
    this.noWater = params.get('water') === '0'
    this.noPost = params.get('post') === '0'
    // 自動テスト用：ポインタロックを使わない（外れても一時停止しない）
    this.noLock = params.get('nolock') === '1'
    const w = Number(params.get('world'))
    if (Number.isFinite(w) && w >= 1 && w <= WORLDS.length) this.worldIndex = w - 1

    this.input.onUnlock = () => {
      if (this.noLock) return
      if (this.state === 'playing' || this.state === 'falling') this.openPause()
    }

    document.getElementById('startBtn')!.addEventListener('click', () => this.beginGame())
    document.getElementById('resumeBtn')!.addEventListener('click', () => this.closePause())
    const vol = document.getElementById('volSlider') as HTMLInputElement
    vol.addEventListener('input', () => audio.setVolume(Number(vol.value) / 100))

    // Esc は「開いたキー」でもあるので、どちらでも閉じられるようにする
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.state === 'paused') {
        e.preventDefault()
        this.closePause()
      }
      if (e.code === 'F3') {
        e.preventDefault()
        this.debugOn = !this.debugOn
      }
    })
    canvas.addEventListener('click', () => {
      if (this.noLock) return
      if (this.state === 'playing' || this.state === 'falling') this.input.requestLock()
    })

    this.gpuName = this.renderer.glInfo
    this.hud.showStart(true)
  }

  // ---------- 進行 ----------

  private beginGame() {
    audio.start()
    audio.resume()
    this.hud.showStart(false)
    this.state = 'playing'
    this.loadWorldImmediate(this.worldIndex)
    if (!this.noLock) this.input.requestLock()
  }

  /** その場で最後まで生成する（開始時とチャプター選択時） */
  private loadWorldImmediate(index: number) {
    const w = WORLDS[index]()
    const gen = w.build(this.renderer.gl)
    while (!gen.next().done) {
      /* 開始時は待ってよい */
    }
    this.adoptWorld(w, false)
  }

  private adoptWorld(w: World, keepVelocity: boolean) {
    this.world?.dispose()
    this.world = w
    this.renderer.setScene(w.scene)
    this.renderer.applyStyle(this.noPost ? { ...w.style, post: {} } : w.style)
    this.renderer.requestShadowUpdate()
    if (w.water) w.water.setSize(window.innerWidth, window.innerHeight)

    const y = keepVelocity ? w.spawn.y + w.fallInHeight : w.spawn.y
    const vy = keepVelocity ? Math.max(-16, this.player.vel.y) : 0
    this.player.reset(w.spawn.x, y, w.spawn.z, w.spawn.yaw)
    this.player.vel.y = vy
    this.player.surface = w.surface
    this.player.mode = 'walk'

    audio.setAmbience(w.ambience, keepVelocity ? 2.2 : 1.2)
    audio.setOpenness(1)
    progress.visit(w.meta.id)
    this.hud.showWorldTitle(w.meta.title, w.meta.caption)
    this.renderer.setFade(0)
    this.renderer.setGlitch(0)
  }

  private beginFall() {
    if (!this.world) return
    this.state = 'falling'
    this.player.mode = 'fall'
    const ev = this.world.exit.entryVelocity
    if (ev) this.player.vel.add(ev)
    this.fallTime = 0
    this.stopWind = audio.startFallWind()
    audio.stopAmbience(0.8)
    this.hud.clearFragment()
    this.hud.showLoading(true)

    const next = this.worldIndex + 1
    if (next < WORLDS.length) {
      this.nextWorld = WORLDS[next]()
      this.builder = this.nextWorld.build(this.renderer.gl)
      this.buildDone = false
    } else {
      // 最後まで来た：とりあえず先頭へ戻す（Phase 4 で終了画面に差し替える）
      this.nextWorld = WORLDS[0]()
      this.builder = this.nextWorld.build(this.renderer.gl)
      this.buildDone = false
    }
  }

  private stepBuild() {
    if (!this.builder || this.buildDone) return
    const t0 = performance.now()
    while (performance.now() - t0 < BUILD_BUDGET_MS) {
      const r = this.builder.next()
      if (r.done) {
        this.buildDone = true
        break
      }
    }
  }

  private finishFall() {
    if (!this.nextWorld) return
    this.worldIndex = (this.worldIndex + 1) % WORLDS.length
    this.stopWind?.()
    this.stopWind = null
    this.hud.showLoading(false)
    this.adoptWorld(this.nextWorld, true)
    this.nextWorld = null
    this.builder = null
    this.state = 'playing'
  }

  // ---------- 一時停止 ----------

  private openPause() {
    if (this.state === 'paused') return
    this.prevPaused = this.state
    this.state = 'paused'
    this.input.setEnabled(false)
    this.hud.showPause(true)
  }

  private closePause() {
    if (this.state !== 'paused') return
    this.hud.showPause(false)
    this.state = this.prevPaused
    this.input.setEnabled(true)
    // Esc で外れたポインタロックを必ず戻す
    if (!this.noLock) this.input.requestLock()
    audio.resume()
  }

  // ---------- ループ ----------

  update(dt: number) {
    this.hud.update(dt)
    this.renderer.beginFrame()

    if (this.state === 'start' || this.state === 'paused') {
      this.renderer.render(dt)
      this.input.endFrame()
      return
    }

    const world = this.world!
    // 視点
    if (this.input.locked) {
      this.player.applyLook(this.input.look.x, this.input.look.y)
    }

    // 水位を先に決めてから移動させる
    this.player.waterLevel = world.waterLevelAt(this.player.pos.x, this.player.pos.z)
    this.player.update(dt, this.input, world.collision)
    this.player.applyToCamera(this.renderer.camera)

    // 音
    if (this.player.footstepEvent) {
      audio.footstep(world.surface, this.player.footstepEvent.inWater, 1)
    }
    if (this.player.landImpact > 0.15) {
      audio.footstep(world.surface, this.player.submersion > 0.05, 1 + this.player.landImpact * 1.4)
    }
    audio.update(dt)

    world.update(dt, this.player)
    world.onCamera(this.renderer.camera, dt)
    this.renderer.setGlitch(world.glitch)

    if (this.state === 'playing') {
      this.updateInteract(world)
      if (world.exit.contains(this.player.pos)) this.beginFall()
      // 世界の外に落ちた時の保険
      if (this.player.pos.y < -80) this.beginFall()
    } else {
      // 落下中
      this.fallTime += dt
      this.stepBuild()
      const closeness = Math.min(1, this.fallTime / 1.2)
      audio.setOpenness(1 - closeness * 0.92)
      this.hud.setReticle(false, false)
      if (this.fallTime > MIN_FALL && this.buildDone) this.finishFall()
    }

    // 水（本描画の前に反射・屈折・波紋を更新）
    if (world.water && !this.noWater && this.player.pos.y > -6) {
      world.water.update(this.renderer.gl, world.scene, this.renderer.camera, dt)
    }

    this.renderer.render(dt)
    this.updateDebug(dt)
    this.input.endFrame()
  }

  /**
   * 視線のレイと対象との距離で判定する。
   * 許容半径は距離に比例させて広げる（＝細い円錐）ので、
   * 足元の小物を見下ろした時も、遠くの物を狙った時も同じ感覚で当たる。
   */
  private updateInteract(world: World) {
    this.renderer.camera.getWorldDirection(this.tmpDir)
    const eye = this.renderer.camera.position
    let best: (typeof world.interactables)[number] | null = null
    let bestScore = Infinity
    for (const it of world.interactables) {
      this.tmpTo.copy(it.position).sub(eye)
      const along = this.tmpTo.dot(this.tmpDir)
      if (along <= 0.15 || along > it.radius) continue
      const perp = Math.sqrt(Math.max(0, this.tmpTo.lengthSq() - along * along))
      const allow = 0.35 + along * 0.16
      if (perp > allow) continue
      const score = perp / allow + along * 0.02
      if (score < bestScore) {
        bestScore = score
        best = it
      }
    }
    this.hud.setReticle(true, best !== null)
    if (best && this.input.pressed('KeyE')) {
      this.hud.showFragment(best.fragment)
      audio.chime()
      best.seen = true
      progress.markRead(`${world.meta.id}:${best.fragment.slice(0, 8)}`)
    }
  }

  private updateDebug(dt: number) {
    this.fpsAccum += dt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum
      this.fpsAccum = 0
      this.fpsFrames = 0
    }
    if (!this.debugOn) {
      this.hud.setDebug(null)
      return
    }
    const p = this.player
    this.hud.setDebug(
      [
        `fps   ${this.fps.toFixed(0)}`,
        `draw  ${this.renderer.drawCalls}  tri ${(this.renderer.triangles / 1000).toFixed(0)}k`,
        `pos   ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(2)} ${p.pos.z.toFixed(1)}`,
        `vel   ${Math.hypot(p.vel.x, p.vel.z).toFixed(2)} m/s  vy ${p.vel.y.toFixed(1)}`,
        `water ${p.waterLevel === null ? '-' : p.submersion.toFixed(2)}  ground ${p.onGround ? 'y' : 'n'}`,
        `world ${this.world?.meta.id ?? '-'}  state ${this.state}`,
        `eye   ${TUNING.eye.toFixed(2)}`,
        `gpu   ${this.gpuName}`,
      ].join('\n'),
    )
  }

  /** 開発用：任意の場所へ飛ぶ */
  tp(x: number, z: number, yaw?: number, y?: number, pitch = 0) {
    const w = this.world
    if (!w) return
    const ground = w.collision.groundAt(x, z, 500, 500, 0.3)
    this.player.pos.set(x, y ?? (ground ?? 0.4), z)
    this.player.vel.set(0, 0, 0)
    if (yaw !== undefined) this.player.yaw = yaw
    this.player.pitch = pitch
  }

  get stateName() {
    return this.state
  }

  /** 開発用：現在の状態を1行で */
  snapshot() {
    const p = this.player
    return `state=${this.state} world=${this.world?.meta.id} y=${p.pos.y.toFixed(1)} vy=${p.vel.y.toFixed(1)} ground=${p.onGround}`
  }

  /**
   * 開発用の GPU 実測。rAF のスロットリングに影響されないよう
   * 描画のあと gl.finish() で待って1フレームの実コストを測る。
   */
  probe(frames = 60) {
    const gl = this.renderer.gl.getContext()
    const world = this.world
    const run = (withWater: boolean) => {
      // 1回捨てて温める
      for (let warm = 0; warm < 3; warm++) {
        if (withWater && world?.water) world.water.update(this.renderer.gl, world.scene, this.renderer.camera, 0.016)
        this.renderer.render(0.016)
      }
      gl.finish()
      const t0 = performance.now()
      for (let i = 0; i < frames; i++) {
        if (withWater && world?.water) world.water.update(this.renderer.gl, world.scene, this.renderer.camera, 0.016)
        this.renderer.render(0.016)
      }
      gl.finish()
      return (performance.now() - t0) / frames
    }
    return { withWater: run(true), withoutWater: run(false) }
  }

  onResize() {
    this.world?.water?.setSize(window.innerWidth, window.innerHeight)
  }

  dispose() {
    this.world?.dispose()
    disposeGeneratedTextures()
  }
}
