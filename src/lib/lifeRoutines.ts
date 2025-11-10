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

const LIFE_ROUTINE_DEFAULT_DATA: LifeRoutineConfig[] = [
  {
    id: 'life-sleep',
    bucketId: 'life-sleep',
    title: 'Sleep',
    blurb: 'Protect 7–9 hours and wind down with intention.',
    surfaceStyle: 'midnight',
    sortIndex: 0,
  },
  {
    id: 'life-cook-eat',
    bucketId: 'life-cook-eat',
    title: 'Cook/Eat',
    blurb: 'Prep, cook, and enjoy a proper meal.',
    surfaceStyle: 'grove',
    sortIndex: 1,
  },
  {
    id: 'life-travel',
    bucketId: 'life-travel',
    title: 'Travel',
    blurb: 'Transit time—commutes, driving, or getting around.',
    surfaceStyle: 'slate',
    sortIndex: 2,
  },
  {
    id: 'life-mindfulness',
    bucketId: 'life-mindfulness',
    title: 'Mindfulness',
    blurb: 'Breathe, meditate, or a short moment of awareness.',
    surfaceStyle: 'glass',
    sortIndex: 3,
  },
  {
    id: 'life-admin',
    bucketId: 'life-admin',
    title: 'Life Admin',
    blurb: 'Bills, bookings, messages, and small housekeeping tasks.',
    surfaceStyle: 'neutral-grey-blue',
    sortIndex: 4,
  },
  {
    id: 'life-nature',
    bucketId: 'life-nature',
    title: 'Nature',
    blurb: 'Step outside—sunlight, fresh air, or a short walk.',
    surfaceStyle: 'leaf',
    sortIndex: 5,
  },
  {
    id: 'life-socials',
    bucketId: 'life-socials',
    title: 'Socials',
    blurb: 'Reach out, share a laugh, or check in with someone.',
    surfaceStyle: 'ember',
    sortIndex: 6,
  },
  {
    id: 'life-chill',
    bucketId: 'life-chill',
    title: 'Chill',
    blurb: 'Unwind—light reading, music, or a calm break.',
    surfaceStyle: 'cool-blue',
    sortIndex: 7,
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
  const sortIndex =
    typeof record.sortIndex === 'number' && Number.isFinite(record.sortIndex)
      ? record.sortIndex
      : defaults?.sortIndex ?? 0

  return {
    id,
    bucketId: bucketIdRaw || id,
    title: titleRaw || defaults?.title || 'Routine',
    blurb: blurbRaw || defaults?.blurb || '',
    surfaceStyle,
    sortIndex,
  }
}

export const sanitizeLifeRoutineList = (value: unknown): LifeRoutineConfig[] => {
  // If nothing stored or provided, seed with current defaults
  if (!Array.isArray(value)) {
    return LIFE_ROUTINE_DEFAULT_DATA.map(cloneRoutine)
  }
  // Otherwise, respect the user’s customized list exactly (no auto-restore of removed defaults)
  const seen = new Set<string>()
  const result: LifeRoutineConfig[] = []
  for (const entry of value) {
    const routine = sanitizeLifeRoutine(entry)
    if (!routine) continue
    if (seen.has(routine.id)) continue
    seen.add(routine.id)
    result.push(cloneRoutine(routine))
  }
  const source = result.length > 0 ? result : LIFE_ROUTINE_DEFAULT_DATA
  return source.map((routine, index) => {
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

const pushLifeRoutinesToSupabase = async (routines: LifeRoutineConfig[]): Promise<void> => {
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
    return null
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return null
  }
  const { data, error } = await supabase
    .from('life_routines')
    .select('id, title, blurb, surface_style, sort_index')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })

  if (error) {
    console.warn('Failed to fetch life routines from Supabase', error)
    return null
  }

  const mapped = (data ?? [])
    .map((row) => mapDbRowToRoutine(row as LifeRoutineDbRow))
    .filter((routine): routine is LifeRoutineConfig => Boolean(routine))
  const sanitized = sanitizeLifeRoutineList(mapped)
  const stored = storeLifeRoutinesLocal(sanitized)

  if ((data?.length ?? 0) !== sanitized.length) {
    void pushLifeRoutinesToSupabase(stored)
  }

  return stored
}
