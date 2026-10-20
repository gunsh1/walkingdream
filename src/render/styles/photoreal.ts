import * as THREE from 'three'
import { MaterialPool, type MaterialRequest, type StyleProfile } from '../StyleProfile'

/**
 * 世界2「丘の上の家」の媒体：写真。
 * 誇張をやめ、太陽・空・大気の三つだけで絵を作る。
 * ポストは実写のカメラがやることだけ（わずかなブルーム・粒子・収差・周辺減光）。
 */
export function photorealStyle(pool: MaterialPool): StyleProfile {
  return {
    name: 'photoreal',
    toneMapping: THREE.ACESFilmicToneMapping,
    exposure: 0.7,
    shadows: true,
    dynamicShadows: true,
    post: {
      // 太陽まわりだけがにじむ強さ
      bloom: { strength: 0.11, radius: 0.5, threshold: 1.05 },
      grade: { grain: 0.011, chroma: 0.0007, vignette: 0.2, saturation: 1.02 },
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
            emissiveIntensity: req.emissiveIntensity ?? 1,
            roughness: 0.7,
            metalness: 0,
          }),
        )
      }
      if (req.kind === 'glass') {
        // 窓：外からは空を映し、中は暗い
        return pool.track(
          new THREE.MeshPhysicalMaterial({
            color: req.color,
            roughness: req.roughness ?? 0.06,
            metalness: 0,
            reflectivity: 0.62,
            clearcoat: 0.7,
            clearcoatRoughness: 0.05,
            envMapIntensity: 1.5,
            side: THREE.FrontSide,
          }),
        )
      }
      const defaults: Record<string, { r: number; m: number }> = {
        floor: { r: 0.95, m: 0 },
        wall: { r: 0.72, m: 0 }, // 塗った下見板
        ceiling: { r: 0.9, m: 0 },
        prop: { r: 0.8, m: 0 },
        organic: { r: 0.95, m: 0 },
        metal: { r: 0.42, m: 0.75 },
      }
      const d = defaults[req.kind] ?? { r: 0.8, m: 0 }
      return pool.track(
        new THREE.MeshStandardMaterial({
          color: req.color,
          map: req.map ?? null,
          roughness: req.roughness ?? d.r,
          metalness: req.metalness ?? d.m,
          side: req.side ?? THREE.FrontSide,
          flatShading: req.flatShading ?? false,
          transparent: req.opacity !== undefined && req.opacity < 1,
          opacity: req.opacity ?? 1,
          envMapIntensity: 1,
        }),
      )
    },
  }
}
