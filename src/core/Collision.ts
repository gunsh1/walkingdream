import * as THREE from 'three'

export interface HeightField {
  /** その地点の地面の高さ。null なら地面なし（虚無） */
  heightAt(x: number, z: number): number | null
}

/**
 * 物理エンジンは使わない。各ワールドが AABB の並びと、任意で高さ場を提供する。
 * プレイヤーは半径 r / 高さ h の縦カプセルを AABB で近似して軸ごとに押し戻す。
 */
export class CollisionWorld {
  /** 横からぶつかる障害物（壁・柱など） */
  boxes: THREE.Box3[] = []
  /** 上に乗るだけの床。横方向の当たり判定には使わない（穴に落ちられるように） */
  floors: THREE.Box3[] = []
  /** 通り抜けられる（見た目だけの）箱は入れない */
  heightField: HeightField | null = null
  /** 落下できる穴。ここに入ると地面判定が消える */
  holes: THREE.Box3[] = []

  addBox(min: THREE.Vector3Like, max: THREE.Vector3Like) {
    this.boxes.push(new THREE.Box3(new THREE.Vector3().copy(min), new THREE.Vector3().copy(max)))
    return this
  }

  /** 床を足す。天面だけが意味を持つ。 */
  addFloor(x0: number, z0: number, x1: number, z1: number, top: number, bottom = top - 1) {
    this.floors.push(
      new THREE.Box3(
        new THREE.Vector3(Math.min(x0, x1), bottom, Math.min(z0, z1)),
        new THREE.Vector3(Math.max(x0, x1), top, Math.max(z0, z1)),
      ),
    )
    return this
  }

  /** 中心と大きさから箱を足す（回転なし） */
  addBoxCS(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    this.boxes.push(
      new THREE.Box3(
        new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
        new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
      ),
    )
    return this
  }

  addHole(cx: number, cz: number, sx: number, sz: number, top: number, bottom: number) {
    this.holes.push(
      new THREE.Box3(
        new THREE.Vector3(cx - sx / 2, bottom, cz - sz / 2),
        new THREE.Vector3(cx + sx / 2, top, cz + sz / 2),
      ),
    )
    return this
  }

  inHole(x: number, y: number, z: number) {
    for (const h of this.holes) {
      if (x >= h.min.x && x <= h.max.x && z >= h.min.z && z <= h.max.z && y >= h.min.y && y <= h.max.y) {
        return true
      }
    }
    return false
  }

  /** 円柱 (cx,cz,r) が y 区間 [y0,y1) で箱と重なるなら押し戻し量を返す */
  private static overlapsY(b: THREE.Box3, y0: number, y1: number) {
    return y1 > b.min.y && y0 < b.max.y
  }

  /**
   * 水平方向の解決。pos を直接書き換える。
   * 段差 stepUp 以下の箱は乗り越えられる（=衝突扱いしない）。
   */
  resolveHorizontal(pos: THREE.Vector3, radius: number, height: number, stepUp: number) {
    const y0 = pos.y + 0.02
    const y1 = pos.y + height
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      for (const b of this.boxes) {
        if (!CollisionWorld.overlapsY(b, y0, y1)) continue
        // 段差として登れる高さなら無視
        if (b.max.y - pos.y <= stepUp && b.max.y > pos.y) continue
        const closestX = Math.max(b.min.x, Math.min(pos.x, b.max.x))
        const closestZ = Math.max(b.min.z, Math.min(pos.z, b.max.z))
        let dx = pos.x - closestX
        let dz = pos.z - closestZ
        const d2 = dx * dx + dz * dz
        if (d2 >= radius * radius) continue
        let d = Math.sqrt(d2)
        let push: number
        if (d < 1e-5) {
          // 完全に内部。一番近い面へ抜く
          const toMinX = pos.x - b.min.x
          const toMaxX = b.max.x - pos.x
          const toMinZ = pos.z - b.min.z
          const toMaxZ = b.max.z - pos.z
          const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ)
          if (m === toMinX) {
            dx = -1
            dz = 0
          } else if (m === toMaxX) {
            dx = 1
            dz = 0
          } else if (m === toMinZ) {
            dx = 0
            dz = -1
          } else {
            dx = 0
            dz = 1
          }
          push = radius + m
        } else {
          dx /= d
          dz /= d
          push = radius - d
        }
        pos.x += dx * push
        pos.z += dz * push
        moved = true
      }
      if (!moved) break
    }
  }

  /**
   * 足元の地面の高さ。
   * fromY→toY はこのフレームで足が通った区間。速く落ちている時に床をすり抜けないよう、
   * 通過した範囲の上端までを候補にする。
   * 穴の中では null（=落ちる）。
   */
  groundAt(x: number, z: number, fromY: number, toY: number, radius: number): number | null {
    if (this.inHole(x, Math.min(fromY, toY), z)) return null
    let best: number | null = null
    // 登れる高さの余裕 ＋ このフレームで落ちた距離
    const probe = Math.max(fromY, toY) + 0.55
    if (this.heightField) {
      const h = this.heightField.heightAt(x, z)
      if (h !== null && h <= probe) best = h
    }
    const consider = (list: THREE.Box3[]) => {
      for (const b of list) {
        if (b.max.y > probe) continue
        if (x < b.min.x - radius || x > b.max.x + radius) continue
        if (z < b.min.z - radius || z > b.max.z + radius) continue
        // 半径を考慮：円柱が箱の上に少しでも載っていれば足場
        const cx = Math.max(b.min.x, Math.min(x, b.max.x))
        const cz = Math.max(b.min.z, Math.min(z, b.max.z))
        const dx = x - cx
        const dz = z - cz
        if (dx * dx + dz * dz > radius * radius) continue
        if (best === null || b.max.y > best) best = b.max.y
      }
    }
    consider(this.boxes)
    consider(this.floors)
    return best
  }

  /** 頭上の天井の高さ（ジャンプで頭をぶつける用） */
  ceilingAt(x: number, z: number, headY: number, radius: number): number | null {
    let best: number | null = null
    for (const b of this.boxes) {
      if (b.min.y < headY) continue
      const cx = Math.max(b.min.x, Math.min(x, b.max.x))
      const cz = Math.max(b.min.z, Math.min(z, b.max.z))
      const dx = x - cx
      const dz = z - cz
      if (dx * dx + dz * dz > radius * radius) continue
      if (best === null || b.min.y < best) best = b.min.y
    }
    return best
  }
}
