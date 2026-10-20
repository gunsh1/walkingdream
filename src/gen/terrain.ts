import * as THREE from 'three'
import type { HeightField } from '../core/Collision'

export type HeightFn = (x: number, z: number) => number

export interface TerrainHole {
  x: number
  z: number
  sx: number
  sz: number
}

/**
 * 高さ関数からグリッドメッシュを起こす。
 * holes に入った四角の内側は三角形を張らない（＝床が抜ける）。
 */
export function buildTerrainMesh(
  size: number,
  segments: number,
  height: HeightFn,
  holes: TerrainHole[] = [],
) {
  const n = segments + 1
  const positions = new Float32Array(n * n * 3)
  const uvs = new Float32Array(n * n * 2)
  const step = size / segments
  const half = size / 2

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const x = -half + i * step
      const z = -half + j * step
      positions[k * 3] = x
      positions[k * 3 + 1] = height(x, z)
      positions[k * 3 + 2] = z
      uvs[k * 2] = i / segments
      uvs[k * 2 + 1] = j / segments
    }
  }

  const inHole = (x: number, z: number) => {
    for (const h of holes) {
      if (Math.abs(x - h.x) < h.sx / 2 && Math.abs(z - h.z) < h.sz / 2) return true
    }
    return false
  }

  const indices: number[] = []
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const cx = -half + (i + 0.5) * step
      const cz = -half + (j + 0.5) * step
      if (holes.length > 0 && inHole(cx, cz)) continue
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/** 高さ関数をそのまま当たり判定に使う */
export class HeightFieldFn implements HeightField {
  constructor(
    private fn: HeightFn,
    private bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    private holes: TerrainHole[] = [],
  ) {}

  heightAt(x: number, z: number): number | null {
    const b = this.bounds
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null
    for (const h of this.holes) {
      if (Math.abs(x - h.x) < h.sx / 2 && Math.abs(z - h.z) < h.sz / 2) return null
    }
    return this.fn(x, z)
  }
}

/**
 * 地形に沿って走る帯（道）のジオメトリ。
 * centerX(z) で中心線、width で幅。両端を少し波打たせて、貼り付けた板に見えないようにする。
 */
export function buildRibbon(opts: {
  zStart: number
  zEnd: number
  segments: number
  width: number
  centerX: (z: number) => number
  height: HeightFn
  lift: number
  /** 端のゆらぎ（メートル） */
  edgeWobble?: number
  wobbleNoise?: (t: number) => number
  /** 幅方向の分割数（かまぼこ状の反りを付けるため） */
  across?: number
  /** 中央の盛り上がり（メートル） */
  crown?: number
  uvScale?: number
}) {
  const across = opts.across ?? 6
  const wobble = opts.edgeWobble ?? 0
  const noise = opts.wobbleNoise ?? (() => 0)
  const n = opts.segments + 1
  const m = across + 1
  const positions = new Float32Array(n * m * 3)
  const uvs = new Float32Array(n * m * 2)
  const uvScale = opts.uvScale ?? 1

  for (let j = 0; j < n; j++) {
    const t = j / opts.segments
    const z = opts.zStart + (opts.zEnd - opts.zStart) * t
    const cx = opts.centerX(z)
    const wl = opts.width / 2 + noise(z * 0.05) * wobble
    const wr = opts.width / 2 + noise(z * 0.05 + 31.7) * wobble
    for (let i = 0; i < m; i++) {
      const u = i / across // 0..1
      const x = cx - wl + (wl + wr) * u
      const k = j * m + i
      // かまぼこ：中央が少し高い
      const crown = (opts.crown ?? 0) * Math.sin(u * Math.PI)
      positions[k * 3] = x
      positions[k * 3 + 1] = opts.height(x, z) + opts.lift + crown
      positions[k * 3 + 2] = z
      uvs[k * 2] = u * uvScale
      uvs[k * 2 + 1] = (t * Math.abs(opts.zEnd - opts.zStart)) / opts.width * uvScale
    }
  }

  const indices: number[] = []
  // 帯は z が減る向きに進むので、地形グリッドとは巻き方向が逆になる。
  // ここを間違えると上面が裏面になり、まるごと消える。
  for (let j = 0; j < opts.segments; j++) {
    for (let i = 0; i < across; i++) {
      const a = j * m + i
      const b = a + 1
      const c = a + m
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/**
 * 高さ・草マスク・色ムラを1枚の RGBA8 テクスチャに詰める。
 *   R,G : 高さを16bitで（minH..maxH を正規化）
 *   B   : 草を生やす割合（0=生やさない）
 *   A   : 大きな色ムラ
 * 草シェーダーと地形シェーダーが同じ値を読むので、近景と遠景の色がずれない。
 * 生成に時間がかかるのでジェネレータにして落下中に分割実行する。
 */
export interface TerrainMap {
  texture: THREE.DataTexture
  size: number
  res: number
  minH: number
  maxH: number
}

export function* buildTerrainMap(opts: {
  size: number
  res: number
  minH: number
  maxH: number
  height: HeightFn
  grassMask: (x: number, z: number) => number
  macro: (x: number, z: number) => number
  rowsPerStep?: number
}): Generator<string, TerrainMap, void> {
  const { size, res, minH, maxH } = opts
  const data = new Uint8Array(res * res * 4)
  const span = maxH - minH
  const half = size / 2
  const rows = opts.rowsPerStep ?? 48

  for (let j = 0; j < res; j++) {
    const z = -half + (j / (res - 1)) * size
    for (let i = 0; i < res; i++) {
      const x = -half + (i / (res - 1)) * size
      const k = (j * res + i) * 4
      const h01 = Math.max(0, Math.min(1, (opts.height(x, z) - minH) / span))
      const v = Math.round(h01 * 65535)
      data[k] = (v >> 8) & 255
      data[k + 1] = v & 255
      data[k + 2] = Math.round(Math.max(0, Math.min(1, opts.grassMask(x, z))) * 255)
      data[k + 3] = Math.round(Math.max(0, Math.min(1, opts.macro(x, z))) * 255)
    }
    if (j % rows === rows - 1) yield `terrain map ${Math.round((j / res) * 100)}%`
  }

  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return { texture: tex, size, res, minH, maxH }
}

/** シェーダー側で使う、パックした地形マップの読み出し（バイリニア） */
export const TERRAIN_MAP_GLSL = /* glsl */ `
uniform sampler2D uTerrainMap;
uniform vec4 uTerrainInfo; // x: size, y: res, z: minH, w: maxH

vec4 sampleTerrainRaw(vec2 p) {
  vec2 uv = p / uTerrainInfo.x + 0.5;
  return texture2D(uTerrainMap, uv);
}

// 高さ・草マスク・色ムラをまとめて返す（xyz は使わず x=高さ y=マスク z=ムラ）
vec3 sampleTerrain(vec2 p) {
  float res = uTerrainInfo.y;
  vec2 uv = clamp(p / uTerrainInfo.x + 0.5, 0.0, 1.0) * res - 0.5;
  vec2 base = floor(uv);
  vec2 f = uv - base;
  vec2 texel = vec2(1.0 / res);
  vec2 uv00 = (base + 0.5) * texel;

  vec4 t00 = texture2D(uTerrainMap, uv00);
  vec4 t10 = texture2D(uTerrainMap, uv00 + vec2(texel.x, 0.0));
  vec4 t01 = texture2D(uTerrainMap, uv00 + vec2(0.0, texel.y));
  vec4 t11 = texture2D(uTerrainMap, uv00 + texel);

  float h00 = t00.r * 65280.0 + t00.g * 255.0;
  float h10 = t10.r * 65280.0 + t10.g * 255.0;
  float h01 = t01.r * 65280.0 + t01.g * 255.0;
  float h11 = t11.r * 65280.0 + t11.g * 255.0;
  float h = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) / 65535.0;

  float m = mix(mix(t00.b, t10.b, f.x), mix(t01.b, t11.b, f.x), f.y);
  float g = mix(mix(t00.a, t10.a, f.x), mix(t01.a, t11.a, f.x), f.y);

  return vec3(uTerrainInfo.z + h * (uTerrainInfo.w - uTerrainInfo.z), m, g);
}
`
