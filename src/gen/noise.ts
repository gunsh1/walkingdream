/** 決定論的な勾配ノイズ（Perlin）。地形と質感の下地に使う。 */

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export interface Noise2D {
  (x: number, y: number): number
  /** オクターブを重ねた値（-1..1 付近） */
  fbm(x: number, y: number, octaves: number, lacunarity?: number, gain?: number): number
  /** 尾根っぽくする（絶対値を反転） */
  ridged(x: number, y: number, octaves: number): number
}

export function makeNoise2D(seed = 1): Noise2D {
  // 置換表
  const p = new Uint8Array(512)
  const perm = new Uint8Array(256)
  for (let i = 0; i < 256; i++) perm[i] = i
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = perm[i]
    perm[i] = perm[j]
    perm[j] = tmp
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255]

  const grad = (hash: number, x: number, y: number) => {
    switch (hash & 7) {
      case 0:
        return x + y
      case 1:
        return -x + y
      case 2:
        return x - y
      case 3:
        return -x - y
      case 4:
        return x
      case 5:
        return -x
      case 6:
        return y
      default:
        return -y
    }
  }

  const base = ((x: number, y: number) => {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = fade(xf)
    const v = fade(yf)
    const aa = p[p[xi] + yi]
    const ab = p[p[xi] + yi + 1]
    const ba = p[p[xi + 1] + yi]
    const bb = p[p[xi + 1] + yi + 1]
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf))
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1))
    return (x1 + v * (x2 - x1)) * 0.72
  }) as Noise2D

  base.fbm = (x, y, octaves, lacunarity = 2.03, gain = 0.5) => {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += base(x * freq, y * freq) * amp
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  base.ridged = (x, y, octaves) => {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += (1 - Math.abs(base(x * freq, y * freq))) * amp
      norm += amp
      amp *= 0.5
      freq *= 2.05
    }
    return sum / norm
  }

  return base
}

export function smoothstep01(t: number) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

export function smootherstep01(t: number) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}
