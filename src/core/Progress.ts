const KEY = 'walkingdream.progress'

export interface ProgressData {
  /** 到達した世界の id（順番どおり） */
  visited: string[]
  /** 読んだ断片のキー */
  read: string[]
  completed: boolean
}

const empty: ProgressData = { visited: [], read: [], completed: false }

export const progress = {
  load(): ProgressData {
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return { ...empty, visited: [], read: [] }
      const p = JSON.parse(raw) as Partial<ProgressData>
      return {
        visited: Array.isArray(p.visited) ? p.visited : [],
        read: Array.isArray(p.read) ? p.read : [],
        completed: !!p.completed,
      }
    } catch {
      return { ...empty, visited: [], read: [] }
    }
  },
  save(d: ProgressData) {
    try {
      localStorage.setItem(KEY, JSON.stringify(d))
    } catch {
      /* プライベートウィンドウなど。進行は保存できないが遊べる */
    }
  },
  visit(id: string) {
    const d = this.load()
    if (!d.visited.includes(id)) {
      d.visited.push(id)
      this.save(d)
    }
  },
  markRead(key: string) {
    const d = this.load()
    if (!d.read.includes(key)) {
      d.read.push(key)
      this.save(d)
    }
  },
  complete() {
    const d = this.load()
    d.completed = true
    this.save(d)
  },
  reset() {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* noop */
    }
  },
}
