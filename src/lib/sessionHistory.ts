import { supabase, ensureSingleUserSession } from './supabaseClient'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from './surfaceStyles'
import { LIFE_ROUTINE_DEFAULTS } from './lifeRoutines'

export const HISTORY_STORAGE_KEY = 'nc-taskwatch-history'
export const HISTORY_EVENT_NAME = 'nc-taskwatch:history-update'
export const CURRENT_SESSION_STORAGE_KEY = 'nc-taskwatch-current-session'
export const CURRENT_SESSION_EVENT_NAME = 'nc-taskwatch:session-update'
export const HISTORY_LIMIT = 250

const LIFE_ROUTINES_NAME = 'Life Routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'

const LIFE_ROUTINE_SURFACE_LOOKUP = new Map(
  LIFE_ROUTINE_DEFAULTS.map((routine) => [routine.title.toLowerCase(), routine.surfaceStyle]),
)

let knownRemoteIds = new Set<string>()

export type HistoryEntry = {
  id: string
  taskName: string
  elapsed: number
  startedAt: number
  endedAt: number
  goalName: string | null
  bucketName: string | null
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle | null
}

type HistoryCandidate = {
  id: unknown
  taskName: unknown
  elapsed: unknown
  startedAt: unknown
  endedAt: unknown
  goalName?: unknown
  bucketName?: unknown
  goalId?: unknown
  bucketId?: unknown
  taskId?: unknown
  goalSurface?: unknown
  bucketSurface?: unknown
}

const normalizeLifeRoutineSurface = (
  goalName: string,
  bucketName: string,
  goalSurface: SurfaceStyle | null,
  bucketSurface: SurfaceStyle | null,
): { goalSurface: SurfaceStyle; bucketSurface: SurfaceStyle | null } => {
  let resolvedGoalSurface = goalSurface
  let resolvedBucketSurface = bucketSurface

  if (!resolvedGoalSurface && goalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
    resolvedGoalSurface = LIFE_ROUTINES_SURFACE
  }
  if (!resolvedBucketSurface && bucketName.length > 0) {
    const routineSurface = LIFE_ROUTINE_SURFACE_LOOKUP.get(bucketName.toLowerCase())
    if (routineSurface) {
      resolvedBucketSurface = routineSurface
      if (!resolvedGoalSurface && goalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
        resolvedGoalSurface = LIFE_ROUTINES_SURFACE
      }
    }
  }

  return {
    goalSurface: ensureSurfaceStyle(resolvedGoalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE),
    bucketSurface: resolvedBucketSurface ? ensureSurfaceStyle(resolvedBucketSurface, DEFAULT_SURFACE_STYLE) : null,
  }
}

export const sanitizeHistoryEntries = (value: unknown): HistoryEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null
      }
      const candidate = entry as HistoryCandidate

      const id = typeof candidate.id === 'string' ? candidate.id : null
      const taskName = typeof candidate.taskName === 'string' ? candidate.taskName : null
      const elapsed = typeof candidate.elapsed === 'number' ? candidate.elapsed : null
      const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
      const endedAt = typeof candidate.endedAt === 'number' ? candidate.endedAt : null
      if (!id || taskName === null || elapsed === null || startedAt === null || endedAt === null) {
        return null
      }

      const goalNameRaw = typeof candidate.goalName === 'string' ? candidate.goalName : ''
      const bucketNameRaw = typeof candidate.bucketName === 'string' ? candidate.bucketName : ''
      const goalIdRaw = typeof candidate.goalId === 'string' ? candidate.goalId : null
      const bucketIdRaw = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
      const taskIdRaw = typeof candidate.taskId === 'string' ? candidate.taskId : null
      const goalSurfaceRaw = sanitizeSurfaceStyle(candidate.goalSurface)
      const bucketSurfaceRaw = sanitizeSurfaceStyle(candidate.bucketSurface)

      const normalizedGoalName = goalNameRaw.trim()
      const normalizedBucketName = bucketNameRaw.trim()

      const { goalSurface, bucketSurface } = normalizeLifeRoutineSurface(
        normalizedGoalName,
        normalizedBucketName,
        goalSurfaceRaw ?? null,
        bucketSurfaceRaw ?? null,
      )

      return {
        id,
        taskName,
        elapsed,
        startedAt,
        endedAt,
        goalName: normalizedGoalName.length > 0 ? normalizedGoalName : null,
        bucketName: normalizedBucketName.length > 0 ? normalizedBucketName : null,
        goalId: goalIdRaw,
        bucketId: bucketIdRaw,
        taskId: taskIdRaw,
        goalSurface,
        bucketSurface,
      }
    })
    .filter((entry): entry is HistoryEntry => Boolean(entry))
}

export const truncateHistory = (entries: HistoryEntry[], limit: number = HISTORY_LIMIT): HistoryEntry[] => {
  if (entries.length <= limit) {
    return entries.slice()
  }
  return entries.slice(0, limit)
}

export const sortHistoryByEndedAtDesc = (entries: HistoryEntry[]): HistoryEntry[] =>
  entries
    .slice()
    .sort((a, b) => {
      if (a.endedAt === b.endedAt) {
        return b.startedAt - a.startedAt
      }
      return b.endedAt - a.endedAt
    })

export const readStoredHistory = (): HistoryEntry[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return sanitizeHistoryEntries(parsed)
  } catch {
    return []
  }
}

export const writeStoredHistory = (history: HistoryEntry[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch (error) {
    console.warn('Failed to persist session history locally', error)
  }
}

export const broadcastHistoryUpdate = (history: HistoryEntry[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const event = new CustomEvent(HISTORY_EVENT_NAME, { detail: history })
    window.dispatchEvent(event)
  } catch (error) {
    console.warn('Failed to broadcast session history update', error)
  }
}

export const mergeHistoryEntries = (localEntries: HistoryEntry[], remoteEntries: HistoryEntry[]): HistoryEntry[] => {
  const merged = new Map<string, HistoryEntry>()
  localEntries.forEach((entry) => {
    merged.set(entry.id, entry)
  })
  remoteEntries.forEach((entry) => {
    merged.set(entry.id, entry)
  })
  return truncateHistory(sortHistoryByEndedAtDesc(Array.from(merged.values())))
}

type DbSessionHistoryRow = {
  id: string
  user_id: string
  task_name: string
  elapsed_ms: number
  started_at: string | null
  ended_at: string | null
  goal_name: string | null
  bucket_name: string | null
  goal_id: string | null
  bucket_id: string | null
  task_id: string | null
  goal_surface: string | null
  bucket_surface: string | null
}

const mapDbRowToCandidate = (row: DbSessionHistoryRow): HistoryCandidate => ({
  id: row.id,
  taskName: row.task_name,
  elapsed: typeof row.elapsed_ms === 'number' && Number.isFinite(row.elapsed_ms) ? row.elapsed_ms : null,
  startedAt: (() => {
    if (!row.started_at) return null
    const parsed = Date.parse(row.started_at)
    return Number.isFinite(parsed) ? parsed : null
  })(),
  endedAt: (() => {
    if (!row.ended_at) return null
    const parsed = Date.parse(row.ended_at)
    return Number.isFinite(parsed) ? parsed : null
  })(),
  goalName: row.goal_name ?? undefined,
  bucketName: row.bucket_name ?? undefined,
  goalId: row.goal_id ?? undefined,
  bucketId: row.bucket_id ?? undefined,
  taskId: row.task_id ?? undefined,
  goalSurface: row.goal_surface ?? undefined,
  bucketSurface: row.bucket_surface ?? undefined,
})

const formatTimestampForDb = (timestamp: number): string => {
  const safe = Number.isFinite(timestamp) ? timestamp : Date.now()
  return new Date(safe).toISOString()
}

const mapEntryToDbRow = (entry: HistoryEntry, userId: string) => ({
  id: entry.id,
  user_id: userId,
  task_name: entry.taskName,
  elapsed_ms: Math.max(0, Math.round(entry.elapsed)),
  started_at: formatTimestampForDb(entry.startedAt),
  ended_at: formatTimestampForDb(entry.endedAt),
  goal_name: entry.goalName,
  bucket_name: entry.bucketName,
  goal_id: entry.goalId,
  bucket_id: entry.bucketId,
  task_id: entry.taskId,
  goal_surface: entry.goalSurface,
  bucket_surface: entry.bucketSurface,
})

export const fetchHistoryFromSupabase = async (): Promise<HistoryEntry[] | null> => {
  if (!supabase) {
    return null
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return null
  }
  const { data, error } = await supabase
    .from('session_history')
    .select(
      'id, user_id, task_name, elapsed_ms, started_at, ended_at, goal_name, bucket_name, goal_id, bucket_id, task_id, goal_surface, bucket_surface',
    )
    .eq('user_id', session.user.id)
    .order('ended_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error || !data) {
    if (error) {
      console.warn('Failed to fetch session history from Supabase', error)
    }
    return null
  }
  const sanitized = sanitizeHistoryEntries(data.map(mapDbRowToCandidate))
  knownRemoteIds = new Set(sanitized.map((entry) => entry.id))
  return truncateHistory(sortHistoryByEndedAtDesc(sanitized))
}

export const syncHistoryToSupabase = async (history: HistoryEntry[]): Promise<void> => {
  if (!supabase) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return
  }

  const sanitized = truncateHistory(sortHistoryByEndedAtDesc(sanitizeHistoryEntries(history)))
  const rows = sanitized.map((entry) => mapEntryToDbRow(entry, session.user.id))

  const { data: remoteIdsData, error: remoteIdsError } = await supabase
    .from('session_history')
    .select('id')
    .eq('user_id', session.user.id)

  if (remoteIdsError) {
    console.warn('Failed to read existing session history ids from Supabase', remoteIdsError)
    return
  }

  const remoteIds = new Set((remoteIdsData ?? []).map((row) => row.id))
  const localIds = new Set(rows.map((row) => row.id))

  let upsertFailed = false

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from('session_history').upsert(rows, { onConflict: 'id' })
    if (upsertError) {
      console.warn('Failed to upsert session history to Supabase', upsertError)
      upsertFailed = true
    } else {
      rows.forEach((row) => {
        knownRemoteIds.add(row.id)
      })
    }
  }

  if (upsertFailed) {
    return
  }

  const idsToDelete: string[] = []
  remoteIds.forEach((id) => {
    if (!localIds.has(id) && knownRemoteIds.has(id)) {
      idsToDelete.push(id)
    }
  })

  if (idsToDelete.length > 0) {
    const { error: deleteError } = await supabase.from('session_history').delete().in('id', idsToDelete)
    if (deleteError) {
      console.warn('Failed to delete removed session history rows from Supabase', deleteError)
    } else {
      idsToDelete.forEach((id) => {
        knownRemoteIds.delete(id)
      })
    }
  }
}
