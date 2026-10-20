/** 画面表示。3D の外側にある要素はすべてここが持つ。 */
export class Hud {
  private root: HTMLElement
  private reticle: HTMLElement
  private fragment: HTMLElement
  private worldTitle: HTMLElement
  private debug: HTMLElement
  private loading: HTMLElement
  readonly start: HTMLElement
  readonly pause: HTMLElement

  private fragmentTimer = 0
  private titleTimer = 0

  constructor() {
    this.root = document.getElementById('ui')!
    this.root.innerHTML = `
      <div id="reticle"><div class="dot"></div><div class="hint">E</div></div>
      <div id="fragment"></div>
      <div id="worldTitle"><div class="t"></div><div class="c"></div></div>
      <div id="loading">おちていく</div>
      <div id="debug"></div>
      <div class="overlay" id="startOverlay">
        <h1>walkingdream</h1>
        <p>戻れない場所を、ひとつずつ歩く。</p>
        <button type="button" id="startBtn">はじめる</button>
      </div>
      <div class="overlay" id="pauseOverlay">
        <h2>とまっている</h2>
        <div class="keys">
          <b>W A S D</b><span>あるく</span>
          <b>Shift</b><span>はしる</span>
          <b>Space</b><span>とぶ</span>
          <b>E</b><span>みる・さわる</span>
          <b>Esc</b><span>とまる / もどる</span>
        </div>
        <div class="row">
          <label for="volSlider">おと</label>
          <input type="range" id="volSlider" min="0" max="100" value="80" />
        </div>
        <button type="button" id="resumeBtn">つづける</button>
      </div>
    `
    this.reticle = document.getElementById('reticle')!
    this.fragment = document.getElementById('fragment')!
    this.worldTitle = document.getElementById('worldTitle')!
    this.debug = document.getElementById('debug')!
    this.loading = document.getElementById('loading')!
    this.start = document.getElementById('startOverlay')!
    this.pause = document.getElementById('pauseOverlay')!
  }

  showStart(v: boolean) {
    this.start.classList.toggle('show', v)
  }
  showPause(v: boolean) {
    this.pause.classList.toggle('show', v)
  }
  clearFragment() {
    this.fragmentTimer = 0
    this.fragment.classList.remove('show')
  }

  showLoading(v: boolean) {
    this.loading.classList.toggle('show', v)
  }

  setReticle(visible: boolean, active: boolean) {
    this.reticle.classList.toggle('visible', visible)
    this.reticle.classList.toggle('active', active)
  }

  showFragment(text: string, seconds = 6.5) {
    this.fragment.textContent = text
    this.fragment.classList.add('show')
    this.fragmentTimer = seconds
  }

  showWorldTitle(title: string, caption: string, seconds = 5) {
    this.worldTitle.querySelector('.t')!.textContent = title
    this.worldTitle.querySelector('.c')!.textContent = caption
    this.worldTitle.classList.add('show')
    this.titleTimer = seconds
  }

  setDebug(text: string | null) {
    if (text === null) {
      this.debug.classList.remove('show')
      return
    }
    this.debug.classList.add('show')
    this.debug.textContent = text
  }

  update(dt: number) {
    if (this.fragmentTimer > 0) {
      this.fragmentTimer -= dt
      if (this.fragmentTimer <= 0) this.fragment.classList.remove('show')
    }
    if (this.titleTimer > 0) {
      this.titleTimer -= dt
      if (this.titleTimer <= 0) this.worldTitle.classList.remove('show')
    }
  }
}
