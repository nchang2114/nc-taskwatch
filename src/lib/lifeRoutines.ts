import { supabase, ensureSingleUserSession } from './supabaseClient'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

export type LifeRoutineConfig = {
  id: string
  bucketId: string
  title: string
  blurb: string
  surfaceStyle: SurfaceStyle
  sortIndex: number
}

export const LIFE_ROUTINE_STORAGE_KEY = 'nc-taskwatch-life-routines-v1'
export const LIFE_ROUTINE_UPDATE_EVENT = 'nc-life-routines:updated'

const cloneRoutine = (routine: LifeRoutineConfig): LifeRoutineConfig => ({ ...routine })

const LIFE_ROUTINE_DEFAULTS: LifeRoutineConfig[] = [
  {
    id: 'life-sleep',
    bucketId: 'life-sleep',
    title: 'Sleep',
    blurb: 'Wind-down rituals, lights-out target, and no-screens buffer.',
    surfaceStyle: 'midnight',
    sortIndex: 0,
  },
  {
    id: 'life-cook',
    bucketId: 'life-cook',
    title: 'Cook/Eat',
    blurb: 'Prep staples, plan groceries, and keep easy meals ready.',
    surfaceStyle: 'grove',
    sortIndex: 1,
  },
  {
    id: 'life-travel',
    bucketId: 'life-travel',
    title: 'Travel',
    blurb: 'Commutes, drives, and any time you’re physically getting from A to B.',
    surfaceStyle: 'cool-blue',
    sortIndex: 2,
  },
  {
    id: 'life-mindfulness',
    bucketId: 'life-mindfulness',
    title: 'Mindfulness',
    blurb: 'Breathwork, journaling prompts, and quick resets.',
    surfaceStyle: 'muted-lavender',
    sortIndex: 3,
  },
  {
    id: 'life-admin',
    bucketId: 'life-admin',
    title: 'Life Admin',
    blurb: 'Inbox zero, bills, and those small adulting loops.',
    surfaceStyle: 'neutral-grey-blue',
    sortIndex: 4,
  },
  {
    id: 'life-nature',
    bucketId: 'life-nature',
    title: 'Nature',
    blurb: 'Walks outside, sunlight breaks, or a weekend trail plan.',
    surfaceStyle: 'fresh-teal',
    sortIndex: 5,
  },
  {
    id: 'life-socials',
    bucketId: 'life-socials',
    title: 'Socials',
    blurb: 'Reach out to friends, plan hangs, and reply to messages.',
    surfaceStyle: 'sunset-orange',
    sortIndex: 6,
  },
  {
    id: 'life-relationships',
    bucketId: 'life-relationships',
    title: 'Relationships',
    blurb: 'Date nights, check-ins, and celebrate the small stuff.',
    surfaceStyle: 'soft-magenta',
    sortIndex: 7,
  },
  {
    id: 'life-chill',
    bucketId: 'life-chill',
    title: 'Chill',
    blurb: 'Reading sessions, board games, or general downtime.',
    surfaceStyle: 'deep-indigo',
    sortIndex: 8,
  },
]

export const getDefaultLifeRoutines = (): LifeRoutineConfig[] =>
  LIFE_ROUTINE_DEFAULTS.map((routine, index) =>
    cloneRoutine({
      ...routine,
      sortIndex: index,
    }),
  )

const sanitizeLifeRoutine = (value: unknown): LifeRoutineConfig | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) {
    return null
  }
  const bucketIdRaw = typeof record.bucketId === 'string' ? record.bucketId.trim() : ''
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : ''
  const blurbRaw = typeof record.blurb === 'string' ? record.blurb.trim() : ''
  const surfaceStyle = ensureSurfaceStyle(record.surfaceStyle, DEFAULT_SURFACE_STYLE)
  const sortIndex = typeof record.sortIndex === 'number' && Number.isFinite(record.sortIndex) ? record.sortIndex : 0

  return {
    id,
    bucketId: bucketIdRaw || id,
    title: titleRaw || 'Routine',
    blurb: blurbRaw || '',
    surfaceStyle,
    sortIndex,
  }
}

export const sanitizeLifeRoutineList = (value: unknown): LifeRoutineConfig[] => {
  // If nothing stored or provided, return an empty list; seeding is handled explicitly elsewhere.
  if (!Array.isArray(value)) {
    return []
  }
  // Otherwise, respect the user’s customized list exactly (including empty = user removed all)
  const seen = new Set<string>()
  const result: LifeRoutineConfig[] = []
  for (const entry of value) {
    const routine = sanitizeLifeRoutine(entry)
    if (!routine) continue
    if (seen.has(routine.id)) continue
    seen.add(routine.id)
    result.push(cloneRoutine(routine))
  }
  // Preserve empty if user intentionally removed all
  return result.map((routine, index) => {
    const normalized = cloneRoutine(routine)
    const bucketId =
      typeof normalized.bucketId === 'string' && normalized.bucketId.trim().length > 0
        ? normalized.bucketId.trim()
        : normalized.id
    return {
      ...normalized,
      bucketId,
      sortIndex: index,
    }
  })
}

type LifeRoutineDbRow = {
  id: string
  title?: string | null
  blurb?: string | null
  surface_style?: string | null
  sort_index?: number | null
}

const storeLifeRoutinesLocal = (routines: LifeRoutineConfig[]): LifeRoutineConfig[] => {
  const clones = routines.map(cloneRoutine)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LIFE_ROUTINE_STORAGE_KEY, JSON.stringify(clones))
      window.dispatchEvent(new CustomEvent(LIFE_ROUTINE_UPDATE_EVENT, { detail: clones }))
    } catch {
      // ignore storage errors
    }
  }
  return clones
}

// Read raw local value without default seeding; returns null when key is absent
const readRawLifeRoutinesLocal = (): unknown | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const mapDbRowToRoutine = (row: LifeRoutineDbRow): LifeRoutineConfig | null => {
  const id = typeof row.id === 'string' ? row.id : null
  const title = typeof row.title === 'string' ? row.title : null
  if (!id || !title) {
    return null
  }
  const blurb = typeof row.blurb === 'string' ? row.blurb : ''
  const surfaceStyle = ensureSurfaceStyle(row.surface_style, DEFAULT_SURFACE_STYLE)
  const sortIndex = typeof row.sort_index === 'number' && Number.isFinite(row.sort_index) ? row.sort_index : 0
  return {
    id,
    bucketId: id,
    title,
    blurb,
    surfaceStyle,
    sortIndex,
  }
}

export const pushLifeRoutinesToSupabase = async (routines: LifeRoutineConfig[]): Promise<void> => {
  if (!supabase) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return
  }

  const normalized = sanitizeLifeRoutineList(routines)

  const rows = normalized.map((routine, index) => ({
    id: routine.id,
    user_id: session.user.id,
    title: routine.title,
    blurb: routine.blurb,
    surface_style: routine.surfaceStyle,
    sort_index: index,
  }))

  const { data: remoteIdsData, error: remoteIdsError } = await supabase
    .from('life_routines')
    .select('id')
    .eq('user_id', session.user.id)

  if (remoteIdsError) {
    console.warn('Failed to read existing life routines from Supabase', remoteIdsError)
    return
  }

  if (rows.length > 0) {
    const tryUpsert = async (payload: typeof rows) =>
      supabase!.from('life_routines').upsert(payload, { onConflict: 'id' })

    const { error: upsertError } = await tryUpsert(rows)
    if (upsertError) {
      const code = (upsertError as any).code || 'unknown'
      const details = (upsertError as any).details || ''
      const hint = (upsertError as any).hint || ''
      const msg = `${upsertError.message} ${details}`.toLowerCase()
      console.warn('[lifeRoutines] Upsert failed:', { code, message: upsertError.message, details, hint })

      // If the backend uses a Postgres ENUM or CHECK constraint for surface_style
      // and it hasn't been updated to include new themes, a 400 error will occur.
      const looksLikeSurfaceStyleConstraint =
        msg.includes('surface_style') || msg.includes('enum') || msg.includes('invalid input value')

      if (looksLikeSurfaceStyleConstraint) {
        // Retry once with a safe fallback so sync doesn’t block other fields.
        const fallback = DEFAULT_SURFACE_STYLE
        const fallbackRows = rows.map((r) => ({ ...r, surface_style: fallback }))
        const { error: retryError } = await tryUpsert(fallbackRows)
        if (retryError) {
          console.warn(
            'Failed to upsert life routines to Supabase even with fallback surface_style. Please apply the SQL migration to extend allowed surface styles.',
            retryError,
          )
          return
        }
        console.warn(
          '[lifeRoutines] Upsert succeeded using fallback surface_style because the backend is missing the new values. Apply the provided SQL migration to enable new themes server-side.',
        )
      } else {
        console.warn('Failed to upsert life routines to Supabase', upsertError)
        return
      }
    }
  }

  const remoteIds = new Set((remoteIdsData ?? []).map((row) => row.id))
  const localIds = new Set(rows.map((row) => row.id))
  const idsToDelete: string[] = []
  remoteIds.forEach((id) => {
    if (!localIds.has(id)) {
      idsToDelete.push(id)
    }
  })
  if (idsToDelete.length > 0) {
    const { error: deleteError } = await supabase.from('life_routines').delete().in('id', idsToDelete)
    if (deleteError) {
      console.warn('Failed to delete removed life routines from Supabase', deleteError)
    }
  }
}

export const readStoredLifeRoutines = (): LifeRoutineConfig[] => {
  if (typeof window === 'undefined') {
    return getDefaultLifeRoutines()
  }
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_STORAGE_KEY)
    if (!raw) {
      return getDefaultLifeRoutines()
    }
    const parsed = JSON.parse(raw)
    const sanitized = sanitizeLifeRoutineList(parsed)
    if (sanitized.length > 0) {
      return sanitized
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      return []
    }
    return getDefaultLifeRoutines()
  } catch {
    return getDefaultLifeRoutines()
  }
}

export const writeStoredLifeRoutines = (
  routines: LifeRoutineConfig[],
  options?: { sync?: boolean },
): LifeRoutineConfig[] => {
  const { sync = true } = options ?? {}
  const sanitized = sanitizeLifeRoutineList(routines)
  const stored = storeLifeRoutinesLocal(sanitized)
  if (sync) {
    void pushLifeRoutinesToSupabase(stored)
  }
  return stored
}

export const syncLifeRoutinesWithSupabase = async (): Promise<LifeRoutineConfig[] | null> => {
  if (!supabase) {
    return []
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return null
  }
  // Default to preferring the remote snapshot. You can opt out by setting
  // VITE_PREFER_REMOTE_LIFE_ROUTINES=false in .env.local.
  const preferRemoteEnv = String((import.meta as any)?.env?.VITE_PREFER_REMOTE_LIFE_ROUTINES ?? 'true')
    .trim()
    .toLowerCase()
  const PREFER_REMOTE = preferRemoteEnv === 'true' || preferRemoteEnv === '1' || preferRemoteEnv === 'yes'
  // Fetch remote snapshot
  const { data, error } = await supabase
    .from('life_routines')
    .select('id, title, blurb, surface_style, sort_index')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })

  if (error) {
    console.warn('Failed to fetch life routines from Supabase', error)
    return null
  }

  const remoteRows = data ?? []
  const localRaw = readRawLifeRoutinesLocal()
  const localSanitized = sanitizeLifeRoutineList(Array.isArray(localRaw) ? localRaw : [])

  // Prefer local if the user already has any routines configured locally.
  // This avoids surprising "random" routines appearing from a stale server snapshot
  // (e.g., defaults or data from another device) overriding local choices.
  if (!PREFER_REMOTE && localSanitized.length > 0) {
    const stored = storeLifeRoutinesLocal(localSanitized)
    // Best-effort push so other devices converge to local
    void pushLifeRoutinesToSupabase(stored)
    return stored
  }

  // If local is empty, adopt remote when available; otherwise persist an empty list locally
  if (remoteRows.length > 0) {
    const mapped = remoteRows
      .map((row) => mapDbRowToRoutine(row as LifeRoutineDbRow))
      .filter((routine): routine is LifeRoutineConfig => Boolean(routine))
    const sanitized = sanitizeLifeRoutineList(mapped)
    return storeLifeRoutinesLocal(sanitized)
  }

  // Both empty: persist empty locally
  return storeLifeRoutinesLocal([])
}
