import * as THREE from 'three'
import type { Input } from './Input'
import type { CollisionWorld } from './Collision'

/** 移動の感触パラメータ。plan 記載の初期値。1つずつ調整する。 */
export const TUNING = {
  radius: 0.3,
  height: 1.7,
  eye: 1.62,
  gravity: -18,
  walkSpeed: 2.6,
  runSpeed: 4.8,
  jumpSpeed: 5.0,
  accelGround: 12,
  accelAir: 1.5,
  frictionGround: 10,
  frictionAir: 0.2,
  stepUp: 0.42,
  bobAmp: 0.035,
  bobHz: 1.9,
  bobRunMul: 1.4,
  /** 水位に対する減速。足首 / 腰 */
  waterAnkle: 0.18,
  waterWaist: 0.75,
  waterSlowAnkle: 0.55,
  waterSlowWaist: 0.4,
  /** 終端速度。これ以上速く落ちない（着地の衝撃と貫通の両方を抑える） */
  terminalSpeed: -18,
  pitchLimit: Math.PI / 2 - 0.02,
  fovBase: 70,
  fovRunAdd: 4,
}

export type PlayerMode = 'walk' | 'fall' | 'frozen'

export class Player {
  readonly pos = new THREE.Vector3(0, 2, 0)
  readonly vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  mode: PlayerMode = 'walk'
  onGround = false
  /** 現在地の水面の高さ（水が無ければ null）。ワールドが毎フレーム設定する。 */
  waterLevel: number | null = null
  submersion = 0 // 0..1 足元からの水の深さの割合
  private bobPhase = 0
  bobOffset = 0
  /** 着地の衝撃で沈み込む量。damp で戻る */
  landDip = 0
  /** 直近の着地の強さ（0 = 通常の歩き） */
  landImpact = 0
  /** 直近で足が着いた（足音を鳴らすタイミング） */
  footstepEvent: { inWater: boolean; surface: string } | null = null
  private lastBobSign = 1
  surface = 'tile'
  fovCurrent = TUNING.fovBase

  private tmpMove = new THREE.Vector2()
  private tmpWish = new THREE.Vector3()

  reset(x: number, y: number, z: number, yaw = 0) {
    this.pos.set(x, y, z)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = 0
    this.bobPhase = 0
    this.bobOffset = 0
    this.onGround = false
    this.mode = 'walk'
  }

  applyLook(dx: number, dy: number) {
    this.yaw += dx
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy, -TUNING.pitchLimit, TUNING.pitchLimit)
  }

  get eyeY() {
    return this.pos.y + TUNING.eye + this.bobOffset + this.landDip
  }

  update(dt: number, input: Input, world: CollisionWorld) {
    this.footstepEvent = null
    this.landImpact = 0
    this.landDip = THREE.MathUtils.damp(this.landDip, 0, 6, dt)
    if (this.mode === 'frozen') return

    const t = TUNING
    const running = input.down('ShiftLeft') || input.down('ShiftRight')

    // --- 水の深さ ---
    let slow = 1
    if (this.waterLevel !== null) {
      const depth = this.waterLevel - this.pos.y
      this.submersion = THREE.MathUtils.clamp(depth / t.height, 0, 1)
      if (depth > t.waterWaist) slow = t.waterSlowWaist
      else if (depth > t.waterAnkle) slow = t.waterSlowAnkle
    } else {
      this.submersion = 0
    }

    // --- 望む速度 ---
    const wishSpeed = (running ? t.runSpeed : t.walkSpeed) * slow
    input.moveAxis(this.tmpMove)
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    // 前方 = (-sin(yaw), 0, -cos(yaw))
    this.tmpWish.set(
      this.tmpMove.x * cy - this.tmpMove.y * sy,
      0,
      -this.tmpMove.x * sy - this.tmpMove.y * cy,
    )
    const wishLen = this.tmpWish.length()
    if (wishLen > 1e-4) this.tmpWish.multiplyScalar(1 / wishLen)

    if (this.mode === 'fall') {
      // 落下中は緩やかな空中制御のみ
      this.vel.x += this.tmpWish.x * 2.0 * dt
      this.vel.z += this.tmpWish.z * 2.0 * dt
      this.vel.y += t.gravity * 0.55 * dt
      this.pos.addScaledVector(this.vel, dt)
      this.fovCurrent = THREE.MathUtils.damp(this.fovCurrent, 86, 3, dt)
      return
    }

    const accel = this.onGround ? t.accelGround : t.accelAir
    const friction = this.onGround ? t.frictionGround : t.frictionAir

    // 摩擦（水平のみ）
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z)
    const hs = hv.length()
    if (hs > 0) {
      const drop = hs * friction * dt
      const ns = Math.max(0, hs - drop)
      if (hs > 1e-5) {
        this.vel.x *= ns / hs
        this.vel.z *= ns / hs
      }
    }
    // 加速
    if (wishLen > 1e-4) {
      const cur = this.vel.x * this.tmpWish.x + this.vel.z * this.tmpWish.z
      const add = Math.min(wishSpeed - cur, accel * wishSpeed * dt)
      if (add > 0) {
        this.vel.x += this.tmpWish.x * add
        this.vel.z += this.tmpWish.z * add
      }
    }

    // ジャンプ
    if (this.onGround && input.pressed('Space')) {
      this.vel.y = t.jumpSpeed * (this.submersion > 0.4 ? 0.75 : 1)
      this.onGround = false
    }

    this.vel.y += t.gravity * dt
    if (this.submersion > 0.45) this.vel.y *= 1 - 2.2 * dt // 水中の抵抗
    if (this.vel.y < t.terminalSpeed) this.vel.y = t.terminalSpeed

    // --- 移動と衝突 ---
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    world.resolveHorizontal(this.pos, t.radius, t.height, t.stepUp)

    const prevY = this.pos.y
    this.pos.y += this.vel.y * dt

    const ground = world.groundAt(this.pos.x, this.pos.z, prevY, this.pos.y, t.radius)
    if (ground !== null && this.pos.y <= ground && this.vel.y <= 0) {
      this.pos.y = ground
      const impact = -this.vel.y
      this.vel.y = 0
      if (!this.onGround) {
        if (impact > 5) {
          this.landImpact = Math.min(1, impact / 22)
          this.landDip = -Math.min(0.42, impact * 0.016)
        }
        this.emitFootstep()
      }
      this.onGround = true
    } else {
      this.onGround = false
      const ceil = world.ceilingAt(this.pos.x, this.pos.z, this.pos.y + t.height, t.radius)
      if (ceil !== null && this.pos.y + t.height > ceil && this.vel.y > 0) {
        this.pos.y = ceil - t.height
        this.vel.y = 0
      }
    }

    // --- ヘッドボブと足音 ---
    const speed = Math.hypot(this.vel.x, this.vel.z)
    if (this.onGround && speed > 0.35) {
      const hz = t.bobHz * (running ? t.bobRunMul : 1) * (speed / t.walkSpeed) * 0.9
      this.bobPhase += dt * hz * Math.PI * 2
      const s = Math.sin(this.bobPhase)
      this.bobOffset = -Math.abs(s) * t.bobAmp * (running ? 1.35 : 1)
      const sign = Math.sign(Math.cos(this.bobPhase))
      if (sign !== this.lastBobSign) {
        this.lastBobSign = sign
        this.emitFootstep()
      }
    } else {
      this.bobOffset = THREE.MathUtils.damp(this.bobOffset, 0, 8, dt)
    }

    const targetFov = t.fovBase + (running && speed > 2.8 ? t.fovRunAdd : 0)
    this.fovCurrent = THREE.MathUtils.damp(this.fovCurrent, targetFov, 5, dt)
  }

  private emitFootstep() {
    const inWater = this.waterLevel !== null && this.waterLevel - this.pos.y > 0.04
    this.footstepEvent = { inWater, surface: this.surface }
  }

  /** カメラに姿勢を反映 */
  applyToCamera(cam: THREE.PerspectiveCamera) {
    cam.position.set(this.pos.x, this.eyeY, this.pos.z)
    cam.rotation.order = 'YXZ'
    cam.rotation.set(this.pitch, this.yaw, 0)
    if (Math.abs(cam.fov - this.fovCurrent) > 0.01) {
      cam.fov = this.fovCurrent
      cam.updateProjectionMatrix()
    }
  }
}
