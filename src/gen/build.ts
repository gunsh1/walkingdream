import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 静的ジオメトリをまとめてドローコールを減らすための道具。
 * 同じ材質のものは Batch に貯めて finish() で1メッシュにする。
 */
export class Batch {
  private parts: THREE.BufferGeometry[] = []
  constructor(readonly material: THREE.Material, readonly name = 'batch') {}

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4) {
    const g = geo.clone()
    g.applyMatrix4(matrix)
    this.parts.push(g)
    return this
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, ry = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz)
    const m = new THREE.Matrix4()
    if (ry) m.makeRotationY(ry)
    m.setPosition(cx, cy, cz)
    this.parts.push(g.applyMatrix4(m))
    return this
  }

  plane(cx: number, cy: number, cz: number, sx: number, sz: number, rx = -Math.PI / 2, ry = 0) {
    const g = new THREE.PlaneGeometry(sx, sz)
    const e = new THREE.Euler(rx, ry, 0)
    const m = new THREE.Matrix4().makeRotationFromEuler(e)
    m.setPosition(cx, cy, cz)
    this.parts.push(g.applyMatrix4(m))
    return this
  }

  cylinder(
    cx: number,
    cy: number,
    cz: number,
    rTop: number,
    rBottom: number,
    h: number,
    seg = 16,
    open = false,
  ) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open)
    const m = new THREE.Matrix4().setPosition(cx, cy, cz)
    this.parts.push(g.applyMatrix4(m))
    return this
  }

  get count() {
    return this.parts.length
  }

  /** マージして1つの Mesh を返す。空なら null。 */
  finish(): THREE.Mesh | null {
    if (this.parts.length === 0) return null
    const merged = this.parts.length === 1 ? this.parts[0] : mergeGeometries(this.parts, false)
    if (!merged) return null
    for (const p of this.parts) if (p !== merged) p.dispose()
    this.parts = []
    merged.computeBoundingSphere()
    const mesh = new THREE.Mesh(merged, this.material)
    mesh.name = this.name
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    return mesh
  }
}

/** 同じ形を大量に置く時は InstancedMesh */
export function instances(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  transforms: THREE.Matrix4[],
  name = 'instances',
) {
  const m = new THREE.InstancedMesh(geo, mat, transforms.length)
  for (let i = 0; i < transforms.length; i++) m.setMatrixAt(i, transforms[i])
  m.instanceMatrix.needsUpdate = true
  m.name = name
  m.frustumCulled = true
  return m
}

export function mat4(
  x: number,
  y: number,
  z: number,
  ry = 0,
  scale = 1,
  rx = 0,
): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ'))
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, scale, scale))
  return m
}

/**
 * ごつごつした岩の塊。参考画像の縁に並んでいる石。
 * 二十面体を頂点ごとにノイズで押し出す。
 */
export function rockGeometry(radius: number, detail: number, rough: number, rnd: () => number) {
  const g = new THREE.IcosahedronGeometry(radius, detail)
  const pos = g.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  const seen = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    let f = seen.get(key)
    if (f === undefined) {
      f = 1 + (rnd() - 0.5) * rough * 2
      seen.set(key, f)
    }
    v.multiplyScalar(f)
    // 下側は潰して地面に馴染ませる
    if (v.y < 0) v.y *= 0.45
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

/** キノコの傘：半球を上下に潰したもの。裏側（ひだ）も見えるように両面 */
export function mushroomCapGeometry(radius: number, height: number, seg = 28) {
  const g = new THREE.SphereGeometry(radius, seg, Math.max(6, Math.floor(seg / 2)), 0, Math.PI * 2, 0, Math.PI * 0.52)
  g.scale(1, height / radius, 1)
  return g
}

/** 縁石（プールのコーピング）：角を丸めた細長い箱を曲線に沿って並べる */
export function polylineWall(
  batch: Batch,
  points: THREE.Vector2[],
  y: number,
  height: number,
  thickness: number,
) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    const dz = b.y - a.y
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) continue
    const angle = Math.atan2(dx, dz)
    batch.box((a.x + b.x) / 2, y + height / 2, (a.y + b.y) / 2, thickness, height, len + thickness, angle)
  }
}

/** 折れ線を滑らかにサンプリング */
export function smoothPath(points: THREE.Vector2[], steps: number) {
  return new THREE.SplineCurve(points).getSpacedPoints(steps)
}
