import * as THREE from 'three'

/** 生成したテクスチャは使い回す。ワールド破棄時に disposeAll() する。 */
export const textureCache = new Map<string, THREE.Texture>()
const cache = textureCache

export function disposeGeneratedTextures() {
  for (const t of cache.values()) t.dispose()
  cache.clear()
}

export function makeCanvas(size: number) {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  return { c, ctx }
}

export function finishTexture(c: HTMLCanvasElement, repeat: number, srgb = true) {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeat, repeat)
  t.anisotropy = 8
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

function hex(n: number) {
  return '#' + n.toString(16).padStart(6, '0')
}

/** 決定論的な乱数（同じ見た目を再現できるように） */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * パステル市松タイル。参考画像1枚目の通路の質感。
 * cells: 1テクスチャあたりのタイル数
 */
export function checkerTiles(opts: {
  key: string
  colors: readonly number[]
  grout: number
  cells?: number
  size?: number
  seed?: number
  jitter?: number
}) {
  const cells = opts.cells ?? 8
  const size = opts.size ?? 512
  const key = `checker:${opts.key}:${cells}:${size}`
  const hit = cache.get(key)
  if (hit) return hit

  const { c, ctx } = makeCanvas(size)
  const rnd = mulberry32(opts.seed ?? 1337)
  const cell = size / cells
  ctx.fillStyle = hex(opts.grout)
  ctx.fillRect(0, 0, size, size)

  const jitter = opts.jitter ?? 0.06
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const col = opts.colors[Math.floor(rnd() * opts.colors.length)]
      const cc = new THREE.Color(col)
      // タイルごとに僅かに明度をずらす（同じ色の面が続かないように）
      const l = 1 + (rnd() - 0.5) * jitter * 2
      cc.multiplyScalar(l)
      ctx.fillStyle = '#' + cc.getHexString()
      const g = size * 0.006
      ctx.fillRect(x * cell + g, y * cell + g, cell - g * 2, cell - g * 2)

      // 濡れたタイルの艶ムラ
      const grd = ctx.createLinearGradient(x * cell, y * cell, (x + 1) * cell, (y + 1) * cell)
      grd.addColorStop(0, 'rgba(255,255,255,0.10)')
      grd.addColorStop(0.5, 'rgba(255,255,255,0.0)')
      grd.addColorStop(1, 'rgba(0,0,0,0.05)')
      ctx.fillStyle = grd
      ctx.fillRect(x * cell + g, y * cell + g, cell - g * 2, cell - g * 2)
    }
  }
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/** 白い正方形グリッドタイル（2枚目の螺旋階段） */
export function gridTiles(opts: { key: string; base: number; grout: number; cells?: number; size?: number }) {
  const cells = opts.cells ?? 16
  const size = opts.size ?? 512
  const key = `grid:${opts.key}:${cells}`
  const hit = cache.get(key)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  ctx.fillStyle = hex(opts.grout)
  ctx.fillRect(0, 0, size, size)
  const cell = size / cells
  const g = Math.max(1, size * 0.0035)
  const rnd = mulberry32(7)
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const cc = new THREE.Color(opts.base)
      cc.multiplyScalar(1 + (rnd() - 0.5) * 0.05)
      ctx.fillStyle = '#' + cc.getHexString()
      ctx.fillRect(x * cell + g, y * cell + g, cell - g * 2, cell - g * 2)
    }
  }
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/** ざらついた無地。コンクリート・アスファルト・粘土などの下地 */
export function grainy(opts: {
  key: string
  base: number
  contrast?: number
  blotches?: number
  size?: number
}) {
  const size = opts.size ?? 256
  const key = `grain:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const base = new THREE.Color(opts.base)
  ctx.fillStyle = '#' + base.getHexString()
  ctx.fillRect(0, 0, size, size)

  const rnd = mulberry32(99)
  const blotches = opts.blotches ?? 60
  for (let i = 0; i < blotches; i++) {
    const r = size * (0.03 + rnd() * 0.14)
    const x = rnd() * size
    const y = rnd() * size
    const dark = rnd() < 0.5
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    const a = 0.05 + rnd() * 0.06
    g.addColorStop(0, dark ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  const contrast = (opts.contrast ?? 0.06) * 255
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * contrast
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/** キノコの傘（赤地に白い斑点）。極座標で貼るので横長 */
export function mushroomCap(opts: { key: string; red: number; spot: number; seed?: number }) {
  const key = `cap:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const w = 512
  const h = 256
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const red = new THREE.Color(opts.red)
  ctx.fillStyle = '#' + red.getHexString()
  ctx.fillRect(0, 0, w, h)

  // 上部（傘の頂点側）を少し明るく
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(255,255,255,0.16)')
  g.addColorStop(0.55, 'rgba(255,255,255,0.0)')
  g.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  const rnd = mulberry32(opts.seed ?? 4)
  ctx.fillStyle = '#' + new THREE.Color(opts.spot).getHexString()
  const spots = 26
  for (let i = 0; i < spots; i++) {
    const y = h * (0.05 + rnd() * 0.8)
    // 頂点付近は円周が縮むので横に伸ばす
    const stretch = 1 / Math.max(0.25, Math.sin((y / h) * Math.PI * 0.5 + 0.15))
    const r = h * (0.035 + rnd() * 0.055)
    const x = rnd() * w
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(stretch, 1)
    ctx.beginPath()
    ctx.ellipse(0, 0, r, r, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    // 継ぎ目をまたぐ斑点は反対側にも描く
    if (x < r * stretch || x > w - r * stretch) {
      ctx.save()
      ctx.translate(x < w / 2 ? x + w : x - w, y)
      ctx.scale(stretch, 1)
      ctx.beginPath()
      ctx.ellipse(0, 0, r, r, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = 8
  cache.set(key, t)
  return t
}

/** 縦の溝が入った柱（ピンクのフルート柱） */
export function flutedColumn(opts: { key: string; base: number; dark: number; flutes?: number }) {
  const key = `fluted:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const w = 512
  const h = 64
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const flutes = opts.flutes ?? 24
  const step = w / flutes
  for (let i = 0; i < flutes; i++) {
    const g = ctx.createLinearGradient(i * step, 0, (i + 1) * step, 0)
    g.addColorStop(0, '#' + new THREE.Color(opts.dark).getHexString())
    g.addColorStop(0.35, '#' + new THREE.Color(opts.base).getHexString())
    g.addColorStop(0.55, '#' + new THREE.Color(opts.base).clone().multiplyScalar(1.08).getHexString())
    g.addColorStop(1, '#' + new THREE.Color(opts.dark).getHexString())
    ctx.fillStyle = g
    ctx.fillRect(i * step, 0, step + 1, h)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  cache.set(key, t)
  return t
}

/** 上下グラデーションの空（板 or 球に貼る） */
export function skyGradient(opts: { key: string; top: number; bottom: number; power?: number }) {
  const key = `sky:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 512
  const ctx = c.getContext('2d')!
  const top = new THREE.Color(opts.top)
  const bot = new THREE.Color(opts.bottom)
  const p = opts.power ?? 1
  for (let y = 0; y < 512; y++) {
    const t = Math.pow(y / 511, p)
    const col = top.clone().lerp(bot, t)
    ctx.fillStyle = '#' + col.getHexString()
    ctx.fillRect(0, y, 4, 1)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  cache.set(key, t)
  return t
}

/** ふちがぼけた丸。粒子（泡・ほこり）用 */
export function softDot(key = 'default', size = 64) {
  const k = `dot:${key}`
  const hit = cache.get(k)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  cache.set(k, t)
  return t
}

/** 汎用のノイズ（法線ゆらぎなどに使う、リニア空間） */
export function noiseTexture(key: string, size = 128) {
  const k = `noise:${key}:${size}`
  const hit = cache.get(k)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const img = ctx.createImageData(size, size)
  const rnd = mulberry32(2024)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rnd() * 255
    img.data[i + 1] = rnd() * 255
    img.data[i + 2] = rnd() * 255
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const t = finishTexture(c, 1, false)
  cache.set(k, t)
  return t
}
