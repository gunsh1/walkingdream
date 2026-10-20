import * as THREE from 'three'
import { World, type ExitSpec, type WorldMeta } from './World'
import { MaterialPool, type MaterialRequest, type StyleProfile } from '../render/StyleProfile'
import { SPIRAL } from '../data/palette'
import type { AmbienceSpec } from '../core/Audio'
import { Batch } from '../gen/build'
import { grainy } from '../gen/textures'

/** 世界2以降を作るまでの仮の落下先。白い箱の部屋。 */
function blankStyle(pool: MaterialPool): StyleProfile {
  return {
    name: 'blank',
    toneMapping: THREE.ACESFilmicToneMapping,
    exposure: 1.0,
    shadows: false,
    post: { bloom: { strength: 0.16, radius: 0.5, threshold: 0.9 }, grade: { grain: 0.012, vignette: 0.2, saturation: 0.25 } },
    makeMaterial(req: MaterialRequest) {
      return pool.track(
        new THREE.MeshStandardMaterial({
          color: req.color,
          map: req.map ?? null,
          roughness: req.roughness ?? 0.9,
          metalness: 0,
          side: req.side ?? THREE.FrontSide,
        }),
      )
    },
  }
}

export class Placeholder extends World {
  readonly meta: WorldMeta = { id: 'placeholder', title: 'まだ、なにもない', caption: 'ここは これから つくられる' }
  readonly style = blankStyle(this.pool)
  readonly ambience: AmbienceSpec = {
    noiseFreq: 180,
    noiseQ: 0.4,
    noiseGain: 0.03,
    padRoot: 65.4,
    padRatios: [1, 2, 3],
    padGain: 0.02,
    reverb: 4.5,
  }
  readonly spawn = { x: 0, y: 0, z: 0, yaw: Math.PI }
  readonly exit: ExitSpec = {
    kind: 'hole',
    contains: () => false,
    tunnelTint: 0x101418,
  }
  surface = 'clay' as const
  fallInHeight = 14;

  *build(_renderer: THREE.WebGLRenderer) {
    const s = this.scene
    s.background = new THREE.Color(SPIRAL.clayLight).multiplyScalar(0.9)
    s.fog = new THREE.Fog(SPIRAL.clayMid, 20, 70)

    const tex = grainy({ key: 'clayBlank', base: 0xffffff, contrast: 0.05, blotches: 40 })
    const mat = this.style.makeMaterial({ kind: 'wall', color: SPIRAL.clayLight, map: tex })
    const b = new Batch(mat, 'room')
    const S = 34
    const H = 30
    b.plane(0, 0, 0, S, S)
    b.plane(0, H, 0, S, S, Math.PI / 2)
    b.plane(0, H / 2, -S / 2, S, H, 0, 0)
    b.plane(0, H / 2, S / 2, S, H, 0, Math.PI)
    b.plane(-S / 2, H / 2, 0, S, H, 0, Math.PI / 2)
    b.plane(S / 2, H / 2, 0, S, H, 0, -Math.PI / 2)
    s.add(b.finish()!)

    this.collision.addBoxCS(0, -0.5, 0, S, 1, S)
    this.collision.addBoxCS(0, H / 2, -S / 2 - 0.5, S, H, 1)
    this.collision.addBoxCS(0, H / 2, S / 2 + 0.5, S, H, 1)
    this.collision.addBoxCS(-S / 2 - 0.5, H / 2, 0, 1, H, S)
    this.collision.addBoxCS(S / 2 + 0.5, H / 2, 0, 1, H, S)
    yield 'room'

    s.add(new THREE.HemisphereLight(0xffffff, 0xb8b4ae, 1.6))
    const d = new THREE.DirectionalLight(0xffffff, 0.9)
    d.position.set(6, 20, 8)
    s.add(d)
    yield 'lights'
  }

  override waterLevelAt() {
    return null
  }
}
