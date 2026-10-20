/**
 * 全合成のサウンドエンジン。外部音源ファイルは一切使わない。
 * ambience / footstep / event の3バス → muffle → master → limiter → destination
 */

export interface AmbienceSpec {
  /** ノイズ床の帯域 */
  noiseFreq: number
  noiseQ: number
  noiseGain: number
  /** パッドの根音（Hz）と重ねる音程比 */
  padRoot: number
  padRatios: number[]
  padGain: number
  /** 残響の長さ（秒） */
  reverb: number
  /** ぽつぽつ鳴る点音（水滴など）。0 で無効 */
  dripRate?: number
  dripFreq?: number
}

export type Surface = 'tile' | 'water' | 'grass' | 'asphalt' | 'metal' | 'clay'

export class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  private limiter!: DynamicsCompressorNode
  private ambienceBus!: GainNode
  private footBus!: GainNode
  private eventBus!: GainNode
  private reverbSend!: GainNode
  private convolver!: ConvolverNode
  private noiseBuffer!: AudioBuffer
  private ambienceNodes: AudioNode[] = []
  private ambienceGain: GainNode | null = null
  private dripTimer = 0
  private dripRate = 0
  private dripFreq = 900
  private muffle!: BiquadFilterNode
  private started = false
  volume = 0.8

  get ready() {
    return this.started && this.ctx !== null
  }

  /** ユーザー操作の中から呼ぶこと（自動再生ポリシー） */
  start() {
    if (this.started) return
    this.started = true
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    this.ctx = ctx

    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -8
    this.limiter.knee.value = 6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.18
    this.limiter.connect(ctx.destination)

    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.limiter)

    // 全体を塞ぐためのローパス（落下中など）
    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = 20000
    this.muffle.connect(this.master)

    this.ambienceBus = ctx.createGain()
    this.footBus = ctx.createGain()
    this.eventBus = ctx.createGain()
    this.ambienceBus.gain.value = 1
    this.footBus.gain.value = 0.9
    this.eventBus.gain.value = 1
    this.ambienceBus.connect(this.muffle)
    this.footBus.connect(this.muffle)
    this.eventBus.connect(this.muffle)

    this.convolver = ctx.createConvolver()
    this.convolver.buffer = this.makeImpulse(2.4, 2.5)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 0.5
    this.reverbSend.connect(this.convolver)
    this.convolver.connect(this.muffle)

    this.noiseBuffer = this.makePinkNoise(4)
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume()
  }

  setVolume(v: number) {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  /** 落下中などに全体をこもらせる。1=通常、0=完全に塞ぐ */
  setOpenness(v: number) {
    if (!this.ctx) return
    const f = 220 + Math.pow(Math.max(0, Math.min(1, v)), 2.2) * 19780
    this.muffle.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08)
  }

  // ---------- バッファ生成 ----------

  private makePinkNoise(seconds: number) {
    const ctx = this.ctx!
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let b0 = 0
    let b1 = 0
    let b2 = 0
    let b3 = 0
    let b4 = 0
    let b5 = 0
    let b6 = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
    return buf
  }

  /** ノイズバーストを指数減衰させた合成インパルス応答 */
  private makeImpulse(seconds: number, decay: number) {
    const ctx = this.ctx!
    const len = Math.max(64, Math.floor(ctx.sampleRate * seconds))
    const buf = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c)
      for (let i = 0; i < len; i++) {
        const t = i / len
        // 初期反射をまばらに、その後密に
        const sparse = t < 0.06 ? (Math.random() < 0.25 ? 1 : 0) : 1
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * sparse
      }
    }
    return buf
  }

  private noiseSource(loop = true) {
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    s.loop = loop
    return s
  }

  // ---------- 環境音 ----------

  setAmbience(spec: AmbienceSpec, fadeSec = 1.5) {
    if (!this.ctx) return
    const ctx = this.ctx
    this.stopAmbience(fadeSec * 0.6)

    const out = ctx.createGain()
    out.gain.value = 0
    out.connect(this.ambienceBus)
    out.connect(this.reverbSend)
    out.gain.setTargetAtTime(1, ctx.currentTime, fadeSec * 0.4)
    this.ambienceGain = out

    this.convolver.buffer = this.makeImpulse(Math.max(0.4, spec.reverb), 2.2 + spec.reverb * 0.4)

    // ノイズ床
    const n = this.noiseSource()
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = spec.noiseFreq
    bp.Q.value = spec.noiseQ
    const ng = ctx.createGain()
    ng.gain.value = spec.noiseGain
    n.connect(bp).connect(ng).connect(out)
    n.start()
    // ゆっくりうねらせる
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.06
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = spec.noiseGain * 0.45
    lfo.connect(lfoGain).connect(ng.gain)
    lfo.start()
    this.ambienceNodes.push(n, lfo)

    // パッド
    for (let i = 0; i < spec.padRatios.length; i++) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = spec.padRoot * spec.padRatios[i]
      const g = ctx.createGain()
      g.gain.value = spec.padGain / (i + 1.4)
      // 緩やかなデチューン
      const d = ctx.createOscillator()
      d.frequency.value = 0.03 + i * 0.017
      const dg = ctx.createGain()
      dg.gain.value = 0.6 + i * 0.4
      d.connect(dg).connect(o.detune)
      o.connect(g).connect(out)
      o.start()
      d.start()
      this.ambienceNodes.push(o, d)
    }

    this.dripRate = spec.dripRate ?? 0
    this.dripFreq = spec.dripFreq ?? 900
    this.dripTimer = 0
  }

  stopAmbience(fadeSec = 0.8) {
    if (!this.ctx || !this.ambienceGain) return
    const ctx = this.ctx
    const g = this.ambienceGain
    const nodes = this.ambienceNodes
    g.gain.setTargetAtTime(0, ctx.currentTime, fadeSec * 0.4)
    window.setTimeout(() => {
      for (const n of nodes) {
        try {
          ;(n as OscillatorNode).stop()
        } catch {
          /* 既に停止済み */
        }
        n.disconnect()
      }
      g.disconnect()
    }, fadeSec * 1000 + 200)
    this.ambienceNodes = []
    this.ambienceGain = null
    this.dripRate = 0
  }

  update(dt: number) {
    if (!this.ctx || this.dripRate <= 0) return
    this.dripTimer -= dt
    if (this.dripTimer <= 0) {
      this.dripTimer = (0.6 + Math.random() * 1.8) / this.dripRate
      this.drip()
    }
  }

  // ---------- 効果音 ----------

  private env(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  }

  footstep(surface: Surface, inWater: boolean, intensity = 1) {
    if (!this.ctx) return
    if (inWater) {
      this.splash(intensity)
      return
    }
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const n = this.noiseSource(false)
    n.playbackRate.value = 0.8 + Math.random() * 0.4
    const f = ctx.createBiquadFilter()
    const g = ctx.createGain()

    if (surface === 'tile') {
      f.type = 'bandpass'
      f.frequency.value = 1900 + Math.random() * 500
      f.Q.value = 1.1
      this.env(g, t0, 0.16 * intensity, 0.002, 0.075)
    } else if (surface === 'clay') {
      f.type = 'lowpass'
      f.frequency.value = 900 + Math.random() * 200
      f.Q.value = 0.7
      this.env(g, t0, 0.13 * intensity, 0.004, 0.1)
    } else if (surface === 'grass') {
      f.type = 'bandpass'
      f.frequency.value = 3200 + Math.random() * 900
      f.Q.value = 0.5
      this.env(g, t0, 0.1 * intensity, 0.006, 0.13)
    } else if (surface === 'asphalt') {
      f.type = 'bandpass'
      f.frequency.value = 1200 + Math.random() * 400
      f.Q.value = 0.9
      this.env(g, t0, 0.14 * intensity, 0.003, 0.09)
    } else {
      f.type = 'bandpass'
      f.frequency.value = 2600 + Math.random() * 700
      f.Q.value = 2.4
      this.env(g, t0, 0.12 * intensity, 0.002, 0.16)
    }

    n.connect(f).connect(g)
    g.connect(this.footBus)
    g.connect(this.reverbSend)
    n.start(t0)
    n.stop(t0 + 0.4)
  }

  splash(intensity = 1) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const n = this.noiseSource(false)
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 0.8
    f.frequency.setValueAtTime(500, t0)
    f.frequency.exponentialRampToValueAtTime(3400 + Math.random() * 1200, t0 + 0.14)
    const g = ctx.createGain()
    this.env(g, t0, 0.2 * intensity, 0.004, 0.22)
    n.connect(f).connect(g)
    g.connect(this.footBus)
    g.connect(this.reverbSend)
    n.start(t0)
    n.stop(t0 + 0.6)
  }

  private drip() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    const base = this.dripFreq * (0.7 + Math.random() * 0.7)
    o.frequency.setValueAtTime(base * 0.5, t0)
    o.frequency.exponentialRampToValueAtTime(base * 1.6, t0 + 0.045)
    const g = ctx.createGain()
    this.env(g, t0, 0.05, 0.003, 0.09)
    o.connect(g)
    g.connect(this.eventBus)
    g.connect(this.reverbSend)
    o.start(t0)
    o.stop(t0 + 0.3)
  }

  /** 断片テキストが出る時の合図 */
  chime() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const ratios = [1, 1.5, 2.25]
    for (let i = 0; i < ratios.length; i++) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = 523.25 * ratios[i]
      const g = ctx.createGain()
      this.env(g, t0 + i * 0.045, 0.05 / (i + 1), 0.01, 0.9)
      o.connect(g)
      g.connect(this.eventBus)
      g.connect(this.reverbSend)
      o.start(t0)
      o.stop(t0 + 1.4)
    }
  }

  /** 落下中の風。stop 関数を返す */
  startFallWind() {
    if (!this.ctx) return () => {}
    const ctx = this.ctx
    const n = this.noiseSource()
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(300, ctx.currentTime)
    f.frequency.linearRampToValueAtTime(1400, ctx.currentTime + 2.5)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.42, ctx.currentTime + 0.7)
    n.connect(f).connect(g).connect(this.master)
    n.start()
    return () => {
      g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25)
      window.setTimeout(() => {
        try {
          n.stop()
        } catch {
          /* 既に停止済み */
        }
        n.disconnect()
        g.disconnect()
      }, 900)
    }
  }
}

export const audio = new AudioEngine()
