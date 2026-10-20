import * as THREE from 'three'

/**
 * 「媒体」の定義。ワールドごとにこれを1つ返す。
 * ジオメトリ生成側は媒体を意識せず、materialFactory から材質を受け取る。
 */

export type SurfaceKind =
  | 'floor'
  | 'wall'
  | 'ceiling'
  | 'prop'
  | 'organic'
  | 'metal'
  | 'glass'
  | 'emissive'
  | 'unlit'

export interface MaterialRequest {
  kind: SurfaceKind
  color: number
  map?: THREE.Texture | null
  roughness?: number
  metalness?: number
  emissive?: number
  emissiveIntensity?: number
  opacity?: number
  side?: THREE.Side
  flatShading?: boolean
}

export interface PostSpec {
  bloom?: { strength: number; radius: number; threshold: number }
  /** フィルムグレイン・色収差・ヴィネット */
  grade?: {
    grain?: number
    chroma?: number
    vignette?: number
    posterize?: number
    saturation?: number
    lift?: number
    tint?: THREE.Color
  }
}

export interface StyleProfile {
  name: string
  toneMapping: THREE.ToneMapping
  exposure: number
  /** 影を落とすか */
  shadows: boolean
  /**
   * 影が毎フレーム変わるか。
   * 屋内など影が静止している世界は false にして、シャドウマップを1回だけ焼く。
   */
  dynamicShadows?: boolean
  post: PostSpec
  makeMaterial(req: MaterialRequest): THREE.Material
}

/** 全プロファイル共通の後始末用に、生成した材質を集めておく */
export class MaterialPool {
  private list: THREE.Material[] = []
  track<T extends THREE.Material>(m: T): T {
    this.list.push(m)
    return m
  }
  dispose() {
    for (const m of this.list) m.dispose()
    this.list = []
  }
}
