import * as THREE from 'three'
import { CollisionWorld } from '../core/Collision'
import { MaterialPool, type StyleProfile } from '../render/StyleProfile'
import type { Water } from '../render/Water'
import type { AmbienceSpec, Surface } from '../core/Audio'
import type { Player } from '../core/Player'

export interface Interactable {
  position: THREE.Vector3
  radius: number
  /** 表示する断片テキスト */
  fragment: string
  /** 見た時に光る対象（レティクルのヒント用） */
  object?: THREE.Object3D
  seen?: boolean
}

export type ExitKind = 'sink' | 'crack' | 'glitch' | 'hole' | 'door'

export interface ExitSpec {
  kind: ExitKind
  /** 出口に入ったか */
  contains(pos: THREE.Vector3): boolean
  /** 落下開始時に与える初速（null なら現在の速度を維持） */
  entryVelocity?: THREE.Vector3
  /** 落下シーケンスの見た目のヒント */
  tunnelTint: number
}

export interface WorldMeta {
  id: string
  title: string
  /** チャプター選択に出す短い説明 */
  caption: string
}

export abstract class World {
  readonly scene = new THREE.Scene()
  readonly collision = new CollisionWorld()
  readonly pool = new MaterialPool()
  readonly interactables: Interactable[] = []
  water: Water | null = null
  abstract readonly meta: WorldMeta
  abstract readonly style: StyleProfile
  abstract readonly ambience: AmbienceSpec
  abstract readonly spawn: { x: number; y: number; z: number; yaw: number }
  abstract readonly exit: ExitSpec
  /** 落下してきた時に上空に湧く高さ */
  fallInHeight = 26
  /** 既定の足音 */
  surface: Surface = 'tile'
  /** 画面を壊す量（0..1）。Game が毎フレーム描画側へ渡す */
  glitch = 0

  /** 分割生成。1ステップ = 1フレームぶんの作業。 */
  abstract build(renderer: THREE.WebGLRenderer): Generator<string, void, void>

  /** 毎フレーム。水位の設定などもここで行う。 */
  update(_dt: number, _player: Player): void {}

  /** カメラが確定したあと、描画の直前に呼ばれる（草など視点依存のもの用） */
  onCamera(_camera: THREE.PerspectiveCamera, _dt: number): void {}

  /** その地点の水面の高さ（水がなければ null） */
  waterLevelAt(_x: number, _z: number): number | null {
    return this.water ? this.water.level : null
  }

  dispose() {
    if (this.scene.environment) {
      this.scene.environment.dispose()
      this.scene.environment = null
    }
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.scene.clear()
    this.pool.dispose()
    this.water?.dispose()
    this.water = null
  }
}
