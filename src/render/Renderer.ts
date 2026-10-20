import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { GradeShader } from './GradePass'
import type { StyleProfile } from './StyleProfile'

export class Renderer {
  readonly gl: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private renderPass: RenderPass
  private bloomPass: UnrealBloomPass | null = null
  private gradePass: ShaderPass
  private outputPass: OutputPass
  private currentScene: THREE.Scene
  private size = new THREE.Vector2()
  private time = 0

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // 開発時のスクリーンショット用。描画済みバッファを保持して直接読み出す。
      preserveDrawingBuffer: new URLSearchParams(location.search).get('preserve') === '1',
    })
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.gl.outputColorSpace = THREE.SRGBColorSpace
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap
    // 影を落とすものは動かないので、シャドウマップはワールド読み込み時に1回だけ焼く。
    // （水の屈折・反射で1フレームに3回 render するため、自動更新だと3倍のコストになる）
    this.gl.shadowMap.autoUpdate = false
    // 1フレームに複数回 render するので、集計は手動でリセットする
    this.gl.info.autoReset = false

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400)
    this.currentScene = new THREE.Scene()

    // 既定の EffectComposer はマルチサンプルなしの RT を作るので、
    // 柵や草の輪郭がジャギる。自前で samples 付きの RT を渡す。
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    })
    this.composer = new EffectComposer(this.gl, rt)
    this.renderPass = new RenderPass(this.currentScene, this.camera)
    this.outputPass = new OutputPass()
    this.gradePass = new ShaderPass(GradeShader)
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.outputPass)
    this.composer.addPass(this.gradePass)
    this.gradePass.renderToScreen = true

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  get grade() {
    return this.gradePass.uniforms as Record<string, { value: number | THREE.Color | THREE.Vector2 }>
  }

  setScene(scene: THREE.Scene) {
    this.currentScene = scene
    this.renderPass.scene = scene
  }

  applyStyle(style: StyleProfile) {
    this.gl.toneMapping = style.toneMapping
    this.gl.toneMappingExposure = style.exposure
    this.gl.shadowMap.enabled = style.shadows
    this.setShadowAutoUpdate(!!style.dynamicShadows)

    // ブルームは必要な時だけ挿す
    const wantBloom = !!style.post.bloom
    if (wantBloom && !this.bloomPass) {
      this.bloomPass = new UnrealBloomPass(this.size.clone(), 0.3, 0.6, 0.85)
      // renderPass の直後に入れる
      this.composer.insertPass(this.bloomPass, 1)
    } else if (!wantBloom && this.bloomPass) {
      this.composer.removePass(this.bloomPass)
      this.bloomPass.dispose()
      this.bloomPass = null
    }
    if (this.bloomPass && style.post.bloom) {
      this.bloomPass.strength = style.post.bloom.strength
      this.bloomPass.radius = style.post.bloom.radius
      this.bloomPass.threshold = style.post.bloom.threshold
    }

    const g = style.post.grade ?? {}
    const u = this.gradePass.uniforms
    u.uGrain.value = g.grain ?? 0
    u.uChroma.value = g.chroma ?? 0
    u.uVignette.value = g.vignette ?? 0
    u.uPosterize.value = g.posterize ?? 0
    u.uSaturation.value = g.saturation ?? 1
    u.uLift.value = g.lift ?? 0
    ;(u.uTint.value as THREE.Color).copy(g.tint ?? new THREE.Color(1, 1, 1))
  }

  /** 転移演出用。1=白、-1=黒 */
  setFade(v: number) {
    this.gradePass.uniforms.uFade.value = v
  }
  setGlitch(v: number) {
    this.gradePass.uniforms.uGlitch.value = v
  }

  resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    this.size.set(w, h)
    this.gl.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    ;(this.gradePass.uniforms.uResolution.value as THREE.Vector2).set(w, h)
    this.bloomPass?.setSize(w, h)
  }

  /** 次の描画でシャドウマップを焼き直す */
  requestShadowUpdate() {
    this.gl.shadowMap.needsUpdate = true
  }

  /** 影が動く世界（太陽の下を歩き回る屋外）では毎フレーム焼き直す */
  setShadowAutoUpdate(v: boolean) {
    this.gl.shadowMap.autoUpdate = v
  }

  /** フレームの先頭で呼ぶ（水の反射・屈折パスより前） */
  beginFrame() {
    this.gl.info.reset()
  }

  render(dt: number) {
    this.time += dt
    this.gradePass.uniforms.uTime.value = this.time
    this.composer.render(dt)
  }

  get drawCalls() {
    return this.gl.info.render.calls
  }
  get glInfo() {
    const dbg = this.gl.getContext().getExtension('WEBGL_debug_renderer_info')
    if (!dbg) return 'unknown'
    return String(this.gl.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL))
  }
  get triangles() {
    return this.gl.info.render.triangles
  }
}
