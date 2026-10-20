import * as THREE from 'three'
import { finishTexture, makeCanvas, mulberry32, textureCache as cache } from './textures'

/** 写実側で使う地表・建材の手続き生成。色だけでなく凹凸も作る。 */

/** グレースケールの凹凸から法線マップを作る（タイル境界は巻き込む） */
export function heightToNormal(src: HTMLCanvasElement, strength = 2.2, key = 'n') {
  const k = `normal:${key}`
  const hit = cache.get(k)
  if (hit) return hit
  const size = src.width
  const sd = src.getContext('2d')!.getImageData(0, 0, size, size).data
  const { c, ctx } = makeCanvas(size)
  const out = ctx.createImageData(size, size)
  const at = (x: number, y: number) => sd[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const len = Math.sqrt(dx * dx + dy * dy + 1)
      const i = (y * size + x) * 4
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255
      out.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  const t = finishTexture(c, 1, false)
  cache.set(k, t)
  return t
}

function rgba(c: THREE.Color, a: number) {
  return `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${a})`
}

/**
 * 芝そのもの。
 * 幾何形状の草だけでは地面を覆いきれない（実際の芝は 1平方メートルに数千本ある）ので、
 * 覆う仕事はこのテクスチャが担う。1.6m 四方に貼る前提で、細い葉の筋を大量に描く。
 * 値の幅は狭く保つ ── コントラストを付けると途端に「土に生えた雑草」になる。
 */
export function grassGround(opts: {
  key: string
  dark: number
  light: number
  dry: number
  size?: number
}) {
  const size = opts.size ?? 512
  const key = `grassGround:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const rnd = mulberry32(31337)
  const dark = new THREE.Color(opts.dark)
  const light = new THREE.Color(opts.light)
  const dry = new THREE.Color(opts.dry)
  ctx.fillStyle = '#' + dark.clone().lerp(light, 0.55).getHexString()
  ctx.fillRect(0, 0, size, size)

  // 株のかたまり（弱いムラ）
  for (let i = 0; i < 420; i++) {
    const r = size * (0.02 + rnd() * 0.06)
    const x = rnd() * size
    const y = rnd() * size
    const col = dark.clone().lerp(light, 0.25 + rnd() * 0.6)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, rgba(col, 0.3))
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // 葉の筋。数で覆う。
  ctx.lineCap = 'round'
  for (let i = 0; i < 42000; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const len = size * (0.003 + rnd() * 0.014)
    const a = rnd() * Math.PI * 2
    const t = rnd()
    const col = dark.clone().lerp(light, t)
    if (rnd() < 0.05) col.lerp(dry, 0.3 + rnd() * 0.5)
    ctx.strokeStyle = rgba(col, 0.3 + rnd() * 0.5)
    ctx.lineWidth = 0.8 + rnd() * 1.3
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
    ctx.stroke()
  }
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/**
 * 未舗装路。u が道幅方向（轍の位置が固定）、v が進行方向（タイルする）。
 * 色と、法線マップ用のグレースケールを返す。
 */
export function dirtRoad(opts: {
  key: string
  base: number
  track: number
  verge: number
  size?: number
}) {
  const size = opts.size ?? 512
  const { c, ctx } = makeCanvas(size)
  const { c: hc, ctx: hctx } = makeCanvas(size)
  const rnd = mulberry32(777)
  const base = new THREE.Color(opts.base)
  const track = new THREE.Color(opts.track)
  const verge = new THREE.Color(opts.verge)

  for (let x = 0; x < size; x++) {
    const u = x / (size - 1)
    const t1 = Math.exp(-Math.pow((u - 0.29) / 0.1, 2))
    const t2 = Math.exp(-Math.pow((u - 0.71) / 0.1, 2))
    const edge = Math.max(0, 1 - Math.min(u, 1 - u) / 0.075)
    const col = base.clone().lerp(track, Math.min(1, (t1 + t2) * 1.0))
    col.lerp(verge, edge * 0.8)
    ctx.fillStyle = '#' + col.getHexString()
    ctx.fillRect(x, 0, 1, size)
    const h = 0.55 - (t1 + t2) * 0.15 + edge * 0.08
    const hv = Math.round(Math.max(0, Math.min(1, h)) * 255)
    hctx.fillStyle = `rgb(${hv},${hv},${hv})`
    hctx.fillRect(x, 0, 1, size)
  }

  for (let i = 0; i < 900; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const len = size * (0.05 + rnd() * 0.35)
    const a = 0.04 + rnd() * 0.1
    ctx.strokeStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(70,55,40,${a})`
    ctx.lineWidth = 1 + rnd() * 2
    ctx.beginPath()
    ctx.moveTo(x, y - len / 2)
    ctx.lineTo(x + (rnd() - 0.5) * 4, y + len / 2)
    ctx.stroke()
  }

  const img = ctx.getImageData(0, 0, size, size)
  const himg = hctx.getImageData(0, 0, size, size)
  for (let i = 0; i < 26000; i++) {
    const x = Math.floor(rnd() * size)
    const y = Math.floor(rnd() * size)
    const k = (y * size + x) * 4
    const bright = rnd() < 0.5
    const amt = 16 + rnd() * 44
    const s = bright ? amt : -amt
    img.data[k] = Math.max(0, Math.min(255, img.data[k] + s))
    img.data[k + 1] = Math.max(0, Math.min(255, img.data[k + 1] + s * 0.95))
    img.data[k + 2] = Math.max(0, Math.min(255, img.data[k + 2] + s * 0.85))
    const hs = bright ? amt : -amt * 0.5
    const hv = Math.max(0, Math.min(255, himg.data[k] + hs))
    himg.data[k] = hv
    himg.data[k + 1] = hv
    himg.data[k + 2] = hv
  }
  ctx.putImageData(img, 0, 0)
  hctx.putImageData(himg, 0, 0)

  const color = finishTexture(c, 1)
  cache.set(`road:${opts.key}`, color)
  return { color, normal: heightToNormal(hc, 2.6, `road:${opts.key}`) }
}

/** 塗った木（下見板・柵）。刷毛目とわずかな汚れ */
export function paintedWood(opts: { key: string; base: number; size?: number; grime?: number }) {
  const size = opts.size ?? 256
  const key = `paint:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const rnd = mulberry32(9001)
  ctx.fillStyle = '#' + new THREE.Color(opts.base).getHexString()
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 700; i++) {
    const y = rnd() * size
    const a = 0.015 + rnd() * 0.03
    ctx.strokeStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(120,115,105,${a})`
    ctx.lineWidth = 1 + rnd() * 2
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size, y + (rnd() - 0.5) * 3)
    ctx.stroke()
  }
  const grime = opts.grime ?? 0.1
  for (let i = 0; i < 30; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = size * (0.04 + rnd() * 0.16)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(105,100,88,${grime * (0.3 + rnd() * 0.5)})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/** 塗装した金属屋根。縦の流れと退色 */
export function paintedMetal(opts: { key: string; base: number; size?: number }) {
  const size = opts.size ?? 256
  const key = `metalPaint:${opts.key}`
  const hit = cache.get(key)
  if (hit) return hit
  const { c, ctx } = makeCanvas(size)
  const rnd = mulberry32(5309)
  ctx.fillStyle = '#' + new THREE.Color(opts.base).getHexString()
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 420; i++) {
    const x = rnd() * size
    const a = 0.02 + rnd() * 0.05
    ctx.strokeStyle = rnd() < 0.55 ? `rgba(255,235,225,${a})` : `rgba(80,26,18,${a})`
    ctx.lineWidth = 1 + rnd() * 3
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + (rnd() - 0.5) * 5, size)
    ctx.stroke()
  }
  for (let i = 0; i < 22; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = size * (0.05 + rnd() * 0.12)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,250,240,${0.05 + rnd() * 0.06})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const t = finishTexture(c, 1)
  cache.set(key, t)
  return t
}

/** 虹（横方向にスペクトル、縦方向に減衰） */
export function rainbowStrip(key = 'rainbow') {
  const k = `rainbow:${key}`
  const hit = cache.get(k)
  if (hit) return hit
  const w = 256
  const h = 8
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, 0)
  const stops: Array<[number, string]> = [
    [0.0, 'rgba(255,255,255,0)'],
    [0.16, 'rgba(180,120,220,0.35)'],
    [0.32, 'rgba(120,150,235,0.45)'],
    [0.48, 'rgba(150,225,190,0.5)'],
    [0.64, 'rgba(250,240,150,0.5)'],
    [0.8, 'rgba(250,175,140,0.42)'],
    [1.0, 'rgba(255,255,255,0)'],
  ]
  for (const [p, col] of stops) g.addColorStop(p, col)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  cache.set(k, t)
  return t
}


/**
 * 芝の地表：色と、凹凸から起こした法線マップ。
 * 低い斜光のとき、地表の細かい起伏が出るかどうかで「絵の具か、草地か」が決まる。
 */
export function grassGroundMaps(opts: {
  key: string
  dark: number
  light: number
  dry: number
  size?: number
}) {
  const color = grassGround(opts)
  const nKey = `grassN:${opts.key}`
  const hit = cache.get(nKey)
  if (hit) return { color, normal: hit }

  const size = opts.size ?? 512
  const { c, ctx } = makeCanvas(size)
  const rnd = mulberry32(4711)
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, size, size)
  // 草の株：まるい盛り上がり（弱く、細かく）
  for (let i = 0; i < 520; i++) {
    const r = size * (0.006 + rnd() * 0.02)
    const x = rnd() * size
    const y = rnd() * size
    const up = rnd() < 0.62
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    const a = 0.16 + rnd() * 0.24
    g.addColorStop(0, up ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`)
    g.addColorStop(1, 'rgba(128,128,128,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // 葉の筋
  for (let i = 0; i < 14000; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const len = size * (0.003 + rnd() * 0.011)
    const a = rnd() * Math.PI
    const v = rnd() < 0.5 ? 255 : 0
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.12 + rnd() * 0.3})`
    ctx.lineWidth = 1 + rnd() * 1.6
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
    ctx.stroke()
  }
  const normal = heightToNormal(c, 1.5, nKey)
  cache.set(nKey, normal)
  return { color, normal }
}
