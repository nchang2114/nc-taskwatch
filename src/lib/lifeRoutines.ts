import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

export type LifeRoutineConfig = {
  id: string
  bucketId: string
  title: string
  blurb: string
  surfaceStyle: SurfaceStyle
}

export const LIFE_ROUTINE_STORAGE_KEY = 'nc-taskwatch-life-routines-v1'
export const LIFE_ROUTINE_UPDATE_EVENT = 'nc-life-routines:updated'

const LIFE_ROUTINE_DEFAULT_DATA: LifeRoutineConfig[] = [
  {
    id: 'life-sleep',
    bucketId: 'life-sleep',
    title: 'Sleep',
    blurb: 'Protect 7–9 hours and wind down with intention.',
    surfaceStyle: 'midnight',
  },
  {
    id: 'life-eat',
    bucketId: 'life-eat',
    title: 'Eat',
    blurb: 'Plan balanced meals and pause to truly refuel.',
    surfaceStyle: 'grove',
  },
  {
    id: 'life-cooking',
    bucketId: 'life-cooking',
    title: 'Cooking',
    blurb: 'Prep ingredients, cook, and plate something nourishing.',
    surfaceStyle: 'grove',
  },
  {
    id: 'life-socials',
    bucketId: 'life-socials',
    title: 'Socials',
    blurb: 'Reach out, share a laugh, or check in with someone.',
    surfaceStyle: 'ember',
  },
  {
    id: 'life-screen-break',
    bucketId: 'life-screen-break',
    title: 'Screen Break',
    blurb: 'Step away from devices—move, stretch, or rest your eyes.',
    surfaceStyle: 'lagoon',
  },
  {
    id: 'life-meditate',
    bucketId: 'life-meditate',
    title: 'Meditate',
    blurb: 'Give your mind 10 minutes of quiet focus.',
    surfaceStyle: 'lagoon',
  },
]

export const LIFE_ROUTINE_DEFAULTS: readonly LifeRoutineConfig[] = LIFE_ROUTINE_DEFAULT_DATA.map((routine) =>
  Object.freeze({ ...routine }),
)

const LIFE_ROUTINE_DEFAULT_MAP = new Map(LIFE_ROUTINE_DEFAULT_DATA.map((routine) => [routine.id, routine]))

const cloneRoutine = (routine: LifeRoutineConfig): LifeRoutineConfig => ({ ...routine })

const sanitizeLifeRoutine = (value: unknown): LifeRoutineConfig | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) {
    return null
  }
  const defaults = LIFE_ROUTINE_DEFAULT_MAP.get(id)
  const bucketIdRaw = typeof record.bucketId === 'string' ? record.bucketId.trim() : ''
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : ''
  const blurbRaw = typeof record.blurb === 'string' ? record.blurb.trim() : ''
  const surfaceStyle = ensureSurfaceStyle(record.surfaceStyle, defaults?.surfaceStyle ?? DEFAULT_SURFACE_STYLE)

  return {
    id,
    bucketId: bucketIdRaw || id,
    title: titleRaw || defaults?.title || 'Routine',
    blurb: blurbRaw || defaults?.blurb || '',
    surfaceStyle,
  }
}

export const sanitizeLifeRoutineList = (value: unknown): LifeRoutineConfig[] => {
  if (!Array.isArray(value)) {
    return LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
  }
  const seen = new Set<string>()
  const result: LifeRoutineConfig[] = []
  for (const entry of value) {
    const routine = sanitizeLifeRoutine(entry)
    if (!routine) {
      continue
    }
    if (seen.has(routine.id)) {
      continue
    }
    seen.add(routine.id)
    result.push(cloneRoutine(routine))
  }
  LIFE_ROUTINE_DEFAULT_DATA.forEach((routine) => {
    if (!seen.has(routine.id)) {
      seen.add(routine.id)
      result.push(cloneRoutine(routine))
    }
  })
  return result.length > 0 ? result : LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
}

export const readStoredLifeRoutines = (): LifeRoutineConfig[] => {
  if (typeof window === 'undefined') {
    return LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
  }
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_STORAGE_KEY)
    if (!raw) {
      return LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
    }
    const parsed = JSON.parse(raw)
    return sanitizeLifeRoutineList(parsed)
  } catch {
    return LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
  }
}

export const writeStoredLifeRoutines = (routines: LifeRoutineConfig[]): LifeRoutineConfig[] => {
  const sanitized = sanitizeLifeRoutineList(routines)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LIFE_ROUTINE_STORAGE_KEY, JSON.stringify(sanitized))
      window.dispatchEvent(new CustomEvent(LIFE_ROUTINE_UPDATE_EVENT, { detail: sanitized }))
    } catch {
      // Ignore storage errors (e.g. quota exceeded, private mode)
    }
  }
  return sanitized.map(cloneRoutine)
}
