import type { Goal } from '../pages/GoalsPage'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

const STORAGE_KEY = 'nc-taskwatch-goals-snapshot'
const EVENT_NAME = 'nc-taskwatch:goals-update'

export type GoalTaskSnapshot = {
  id: string
  text: string
  completed: boolean
  priority: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
}

export type GoalBucketSnapshot = {
  id: string
  name: string
  favorite: boolean
  surfaceStyle: SurfaceStyle
  tasks: GoalTaskSnapshot[]
}

export type GoalSnapshot = {
  id: string
  name: string
  color?: string
  surfaceStyle: SurfaceStyle
  starred: boolean
  buckets: GoalBucketSnapshot[]
}

const ensureDifficulty = (value: unknown): GoalTaskSnapshot['difficulty'] => {
  if (value === 'green' || value === 'yellow' || value === 'red') {
    return value
  }
  return 'none'
}

const coerceTasks = (value: unknown): GoalTaskSnapshot[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((task) => {
      if (typeof task !== 'object' || task === null) {
        return null
      }
      const candidate = task as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const text = typeof candidate.text === 'string' ? candidate.text : null
      if (!id || text === null) {
        return null
      }
      const completed = Boolean(candidate.completed)
      const priority = Boolean(candidate.priority)
      const difficulty = ensureDifficulty(candidate.difficulty)
      return { id, text, completed, priority, difficulty }
    })
    .filter((task): task is GoalTaskSnapshot => Boolean(task))
}

const coerceBuckets = (value: unknown): GoalBucketSnapshot[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((bucket) => {
      if (typeof bucket !== 'object' || bucket === null) {
        return null
      }
      const candidate = bucket as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const name = typeof candidate.name === 'string' ? candidate.name : null
      if (!id || name === null) {
        return null
      }
      const favorite = Boolean(candidate.favorite)
      const surfaceStyle = ensureSurfaceStyle(candidate.surfaceStyle, DEFAULT_SURFACE_STYLE)
      const tasks = coerceTasks(candidate.tasks)
      return { id, name, favorite, surfaceStyle, tasks }
    })
    .filter((bucket): bucket is GoalBucketSnapshot => Boolean(bucket))
}

export const createGoalsSnapshot = (goals: Goal[] | unknown): GoalSnapshot[] => {
  if (!Array.isArray(goals)) {
    return []
  }
  const snapshot: GoalSnapshot[] = []
  goals.forEach((goal) => {
    if (typeof goal !== 'object' || goal === null) {
      return
    }
    const candidate = goal as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id : null
    const name = typeof candidate.name === 'string' ? candidate.name : null
    if (!id || name === null) {
      return
    }
    const color = typeof candidate.color === 'string' ? candidate.color : undefined
    const surfaceStyle = ensureSurfaceStyle(candidate.surfaceStyle, DEFAULT_SURFACE_STYLE)
    const starred = Boolean(candidate.starred)
    const buckets = coerceBuckets(candidate.buckets)
    snapshot.push({ id, name, color, surfaceStyle, starred, buckets })
  })
  return snapshot
}

export const publishGoalsSnapshot = (snapshot: GoalSnapshot[]) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore storage errors (e.g., quota exceeded, restricted environments)
  }
  try {
    const event = new CustomEvent<GoalSnapshot[]>(EVENT_NAME, { detail: snapshot })
    window.dispatchEvent(event)
  } catch {
    // CustomEvent may fail in very old browsers; ignore silently
  }
}

export const readStoredGoalsSnapshot = (): GoalSnapshot[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return createGoalsSnapshot(parsed)
  } catch {
    return []
  }
}

export const subscribeToGoalsSnapshot = (
  callback: (snapshot: GoalSnapshot[]) => void,
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<GoalSnapshot[]>
    const detail = Array.isArray(customEvent.detail) ? customEvent.detail : []
    callback(detail)
  }
  window.addEventListener(EVENT_NAME, handler as EventListener)
  return () => {
    window.removeEventListener(EVENT_NAME, handler as EventListener)
  }
}
