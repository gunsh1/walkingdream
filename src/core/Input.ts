import * as THREE from 'three'

/**
 * キーボード / マウス入力とポインタロック。
 * Esc でロックが外れた時の復帰は Game 側が menu 状態と合わせて判断する。
 */
export class Input {
  private keys = new Set<string>()
  private pressedThisFrame = new Set<string>()
  readonly look = new THREE.Vector2() // 累積マウスデルタ（毎フレーム消費される）
  locked = false
  sensitivity = 0.0022
  /** ロックが外れた時に呼ばれる。メニューを開くなどに使う。 */
  onUnlock: (() => void) | null = null
  /** Esc 以外の理由でユーザーがクリックした時 */
  onRequestLock: (() => void) | null = null

  private el: HTMLElement
  private enabled = true

  constructor(el: HTMLElement) {
    this.el = el
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('pointerlockchange', this.handleLockChange)
    document.addEventListener('mousemove', this.handleMouseMove)
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') e.preventDefault()
    if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code)
    this.keys.add(e.code)
  }
  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }
  private handleBlur = () => {
    this.keys.clear()
  }
  private handleLockChange = () => {
    const wasLocked = this.locked
    this.locked = document.pointerLockElement === this.el
    if (wasLocked && !this.locked) this.onUnlock?.()
  }
  private handleMouseMove = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return
    this.look.x -= e.movementX * this.sensitivity
    this.look.y -= e.movementY * this.sensitivity
  }

  requestLock() {
    if (this.locked) return
    // Chrome は連続呼び出しを弾くので失敗は握りつぶす
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined
    if (p && typeof p.catch === 'function') p.catch(() => {})
    this.onRequestLock?.()
  }
  releaseLock() {
    if (document.pointerLockElement === this.el) document.exitPointerLock()
  }
  setEnabled(v: boolean) {
    this.enabled = v
    if (!v) this.keys.clear()
  }

  down(code: string) {
    return this.enabled && this.keys.has(code)
  }
  pressed(code: string) {
    return this.enabled && this.pressedThisFrame.has(code)
  }
  /** 毎フレーム末尾で呼ぶ */
  endFrame() {
    this.pressedThisFrame.clear()
    this.look.set(0, 0)
  }

  /** WASD を -1..1 の 2D ベクトルに (x=右, y=前) */
  moveAxis(out: THREE.Vector2) {
    let x = 0
    let y = 0
    if (this.down('KeyW') || this.down('ArrowUp')) y += 1
    if (this.down('KeyS') || this.down('ArrowDown')) y -= 1
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1
    out.set(x, y)
    if (out.lengthSq() > 1) out.normalize()
    return out
  }
}
