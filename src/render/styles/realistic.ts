import * as THREE from 'three'
import { MaterialPool, type MaterialRequest, type StyleProfile } from '../StyleProfile'

/**
 * 世界1「キノコの屋内プール」の媒体：現代的なリアル描写。
 * PBR・実影・柔らかいブルーム。
 */
export function realisticStyle(pool: MaterialPool): StyleProfile {
  return {
    name: 'realistic',
    toneMapping: THREE.ACESFilmicToneMapping,
    exposure: 1.05,
    shadows: true,
    post: {
      bloom: { strength: 0.28, radius: 0.65, threshold: 0.82 },
      grade: { grain: 0.018, chroma: 0.0008, vignette: 0.24, saturation: 1.04 },
    },
    makeMaterial(req: MaterialRequest) {
      if (req.kind === 'unlit') {
        return pool.track(
          new THREE.MeshBasicMaterial({
            color: req.color,
            map: req.map ?? null,
            side: req.side ?? THREE.FrontSide,
            transparent: req.opacity !== undefined && req.opacity < 1,
            opacity: req.opacity ?? 1,
          }),
        )
      }
      if (req.kind === 'emissive') {
        return pool.track(
          new THREE.MeshStandardMaterial({
            color: req.color,
            emissive: req.emissive ?? req.color,
            emissiveIntensity: req.emissiveIntensity ?? 1.6,
            roughness: 0.6,
            metalness: 0,
            map: req.map ?? null,
          }),
        )
      }
      const defaults: Record<string, { r: number; m: number }> = {
        floor: { r: 0.22, m: 0.02 }, // 濡れたタイル
        wall: { r: 0.68, m: 0 },
        ceiling: { r: 0.85, m: 0.02 },
        prop: { r: 0.55, m: 0 },
        organic: { r: 0.72, m: 0 },
        metal: { r: 0.34, m: 0.85 },
        glass: { r: 0.08, m: 0 },
      }
      const d = defaults[req.kind] ?? { r: 0.6, m: 0 }
      const m = new THREE.MeshStandardMaterial({
        color: req.color,
        map: req.map ?? null,
        roughness: req.roughness ?? d.r,
        metalness: req.metalness ?? d.m,
        side: req.side ?? THREE.FrontSide,
        flatShading: req.flatShading ?? false,
        transparent: req.opacity !== undefined && req.opacity < 1,
        opacity: req.opacity ?? 1,
      })
      if (req.kind === 'glass') {
        m.transparent = true
        m.opacity = req.opacity ?? 0.35
        m.envMapIntensity = 1.4
      }
      return pool.track(m)
    },
  }
}
