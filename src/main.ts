import './ui/style.css'
import { Game } from './core/Game'

const canvas = document.getElementById('view') as HTMLCanvasElement
const game = new Game(canvas)
// 開発用の計測フック
;(window as unknown as { __game: Game }).__game = game

window.addEventListener('resize', () => game.onResize())

let last = performance.now()
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  game.update(dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
