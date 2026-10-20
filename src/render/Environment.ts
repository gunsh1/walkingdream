import * as THREE from 'three'

/**
 * 3色のグラデーションから環境マップを作る。
 * 金属や艶のある面が真っ黒に落ちるのを防ぎ、世界ごとの空気の色を全体に回す。
 * 外部の HDRI は使わない。
 */
export function gradientEnvironment(
  renderer: THREE.WebGLRenderer,
  top: number,
  horizon: number,
  bottom: number,
  intensity = 1,
) {
  // three の PMREM は「幅 / 4」をキューブ面のサイズにするので、
  // 等距円筒の正しい比率（幅 = 高さ × 2）で、十分な幅を持たせる必要がある。
  const w = 256
  const h = 128
  const data = new Float32Array(w * h * 4)
  const cTop = new THREE.Color(top).convertSRGBToLinear().multiplyScalar(intensity)
  const cMid = new THREE.Color(horizon).convertSRGBToLinear().multiplyScalar(intensity)
  const cBot = new THREE.Color(bottom).convertSRGBToLinear().multiplyScalar(intensity)
  const tmp = new THREE.Color()
  for (let y = 0; y < h; y++) {
    // y=0 が上（等距円筒図法の v=0 は上端）
    const t = y / (h - 1)
    if (t < 0.5) tmp.copy(cTop).lerp(cMid, Math.pow(t / 0.5, 0.7))
    else tmp.copy(cMid).lerp(cBot, Math.pow((t - 0.5) / 0.5, 1.3))
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = tmp.r
      data[i + 1] = tmp.g
      data[i + 2] = tmp.b
      data[i + 3] = 1
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.needsUpdate = true

  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()
  const rt = pmrem.fromEquirectangular(tex)
  pmrem.dispose()
  tex.dispose()
  return rt.texture
}
