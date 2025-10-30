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
// Reduce remote fetch window to limit egress; adjust as needed
export const HISTORY_REMOTE_WINDOW_DAYS = 30

const LIFE_ROUTINES_NAME = 'Life Routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'

type HistoryPendingAction = 'upsert' | 'delete'

export type HistorySubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
}

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
  notes: string
  subtasks: HistorySubtask[]
  // When true, this entry represents a planned future session rather than logged work
  futureSession?: boolean
  // Optional tags to link a real entry back to a repeating rule occurrence
  // routineId: id of repeating_sessions rule; occurrenceDate: local YYYY-MM-DD for the occurrence day
  routineId?: string | null
  occurrenceDate?: string | null
}

export type HistoryRecord = HistoryEntry & {
  createdAt: number
  updatedAt: number
  pendingAction: HistoryPendingAction | null
}

type HistoryCandidate = {
  id?: unknown
  taskName?: unknown
  elapsed?: unknown
  startedAt?: unknown
  endedAt?: unknown
  goalName?: unknown
  bucketName?: unknown
  goalId?: unknown
  bucketId?: unknown
  taskId?: unknown
  goalSurface?: unknown
  bucketSurface?: unknown
  notes?: unknown
  subtasks?: unknown
  futureSession?: unknown
  routineId?: unknown
  occurrenceDate?: unknown
}

type HistoryRecordCandidate = HistoryCandidate & {
  createdAt?: unknown
  updatedAt?: unknown
  pendingAction?: unknown
}

const LIFE_ROUTINE_BUCKET_SURFACES = new Map(
  LIFE_ROUTINE_DEFAULTS.map((routine) => [routine.title.trim().toLowerCase(), routine.surfaceStyle]),
)

const sanitizeHistorySubtasks = (value: unknown): HistorySubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        return null
      }
      const candidate = item as Record<string, unknown>
      const rawId = typeof candidate.id === 'string' ? candidate.id : null
      if (!rawId) {
        return null
      }
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      const completed = Boolean(candidate.completed)
      const sortSource = candidate.sortIndex
      const sortIndex =
        typeof sortSource === 'number' && Number.isFinite(sortSource)
          ? sortSource
          : typeof sortSource === 'string'
            ? Number(sortSource)
            : index
      const normalizedSortIndex = Number.isFinite(sortIndex) ? sortIndex : index
      return {
        id: rawId,
        text,
        completed,
        sortIndex: normalizedSortIndex,
      }
    })
    .filter((subtask): subtask is HistorySubtask => Boolean(subtask))
    .sort((a, b) => a.sortIndex - b.sortIndex)
}

export const areHistorySubtasksEqual = (a: HistorySubtask[], b: HistorySubtask[]): boolean => {
  if (a === b) {
    return true
  }
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.text !== right.text ||
      left.completed !== right.completed ||
      left.sortIndex !== right.sortIndex
    ) {
      return false
    }
  }
  return true
}

const clampNumber = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

const parseTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

const sanitizeHistoryEntries = (value: unknown): HistoryEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((rawEntry) => {
      if (typeof rawEntry !== 'object' || rawEntry === null) {
        return null
      }
      const candidate = rawEntry as HistoryCandidate
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
      const notesRaw = typeof candidate.notes === 'string' ? candidate.notes : ''
      const subtasksRaw = sanitizeHistorySubtasks(candidate.subtasks)
      const futureSessionRaw = Boolean((candidate as any).futureSession)
      const routineIdRaw: string | null =
        typeof (candidate as any).routineId === 'string' ? ((candidate as any).routineId as string) : null
      const occurrenceDateRaw: string | null =
        typeof (candidate as any).occurrenceDate === 'string' ? ((candidate as any).occurrenceDate as string) : null

      const normalizedGoalName = goalNameRaw.trim()
      const normalizedBucketName = bucketNameRaw.trim()

      let goalSurface = goalSurfaceRaw ?? null
      let bucketSurface = bucketSurfaceRaw ?? null

      if (!goalSurface && normalizedGoalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
        goalSurface = LIFE_ROUTINES_SURFACE
      }
      if (!bucketSurface && normalizedBucketName.length > 0) {
        const routineSurface = LIFE_ROUTINE_BUCKET_SURFACES.get(normalizedBucketName.toLowerCase())
        if (routineSurface) {
          bucketSurface = routineSurface
          if (!goalSurface && normalizedGoalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
            goalSurface = LIFE_ROUTINES_SURFACE
          }
        }
      }

      const normalized: HistoryEntry = {
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
        goalSurface: ensureSurfaceStyle(goalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE),
        bucketSurface: bucketSurface ? ensureSurfaceStyle(bucketSurface, DEFAULT_SURFACE_STYLE) : null,
        notes: notesRaw,
        subtasks: subtasksRaw,
        futureSession: futureSessionRaw,
        routineId: routineIdRaw,
        occurrenceDate: occurrenceDateRaw,
      }
      return normalized
    })
    .filter((entry): entry is HistoryEntry => Boolean(entry))
}

const sanitizeHistoryRecords = (value: unknown): HistoryRecord[] => {
  const entries = sanitizeHistoryEntries(value)
  const array = Array.isArray(value) ? (value as HistoryRecordCandidate[]) : []
  const now = Date.now()

  return entries.map((entry, index) => {
    const candidate = array[index] ?? {}
    const createdAt = parseTimestamp(candidate.createdAt, entry.startedAt ?? now)
    const updatedAt = parseTimestamp(candidate.updatedAt, Math.max(createdAt, entry.endedAt ?? createdAt))
    const rawPending = candidate.pendingAction
    const pendingAction =
      rawPending === 'upsert' || rawPending === 'delete' ? (rawPending as HistoryPendingAction) : null

    return {
      ...entry,
      createdAt,
      updatedAt,
      pendingAction,
    }
  })
}

const stripMetadata = (record: HistoryRecord): HistoryEntry => {
  const { createdAt: _c, updatedAt: _u, pendingAction: _p, ...entry } = record
  return entry
}

const recordsToActiveEntries = (records: HistoryRecord[]): HistoryEntry[] =>
  records
    .filter((record) => record.pendingAction !== 'delete')
    .sort((a, b) => (a.endedAt === b.endedAt ? b.startedAt - a.startedAt : b.endedAt - a.endedAt))
    .slice(0, HISTORY_LIMIT)
    .map(stripMetadata)

const readHistoryRecords = (): HistoryRecord[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const records = sanitizeHistoryRecords(JSON.parse(raw))
    // Local normalization: ensure future entries are flagged even before remote sync
    const now = Date.now()
    let changed = false
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]
      if (r.startedAt > now && !r.futureSession) {
        records[i] = { ...r, futureSession: true, updatedAt: now, pendingAction: 'upsert' }
        changed = true
      }
    }
    if (changed) {
      writeHistoryRecords(sortRecordsForStorage(records))
      // Schedule a background push; broadcast will occur on next persist
      schedulePendingPush()
    }
    return records
  } catch {
    return []
  }
}

const writeHistoryRecords = (records: HistoryRecord[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records))
  } catch (error) {
    console.warn('Failed to persist session history locally', error)
  }
}

export const readStoredHistory = (): HistoryEntry[] => recordsToActiveEntries(readHistoryRecords())

const broadcastHistoryRecords = (records: HistoryRecord[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const event = new CustomEvent<HistoryRecord[]>(HISTORY_EVENT_NAME, { detail: records })
    window.dispatchEvent(event)
  } catch (error) {
    console.warn('Failed to broadcast history update', error)
  }
}

const sortRecordsForStorage = (records: HistoryRecord[]): HistoryRecord[] =>
  records
    .slice()
    .sort((a, b) => {
      if (a.endedAt === b.endedAt) {
        return b.startedAt - a.startedAt
      }
      return b.endedAt - a.endedAt
    })

const recordEqualsEntry = (record: HistoryRecord, entry: HistoryEntry): boolean =>
  record.taskName === entry.taskName &&
  record.elapsed === entry.elapsed &&
  record.startedAt === entry.startedAt &&
  record.endedAt === entry.endedAt &&
  record.goalName === entry.goalName &&
  record.bucketName === entry.bucketName &&
  record.goalId === entry.goalId &&
  record.bucketId === entry.bucketId &&
  record.taskId === entry.taskId &&
  record.goalSurface === entry.goalSurface &&
  record.bucketSurface === entry.bucketSurface &&
  Boolean(record.futureSession) === Boolean(entry.futureSession) &&
  record.notes === entry.notes &&
  areHistorySubtasksEqual(record.subtasks, entry.subtasks)

const updateRecordWithEntry = (record: HistoryRecord, entry: HistoryEntry, timestamp: number): HistoryRecord => {
  if (recordEqualsEntry(record, entry) && record.pendingAction !== 'delete') {
    return record
  }
  return {
    ...record,
    ...entry,
    updatedAt: timestamp,
    pendingAction: 'upsert',
  }
}

const createRecordFromEntry = (entry: HistoryEntry, timestamp: number): HistoryRecord => ({
  ...entry,
  createdAt: timestamp,
  updatedAt: timestamp,
  pendingAction: 'upsert',
})

const markRecordPendingDelete = (record: HistoryRecord, timestamp: number): HistoryRecord => ({
  ...record,
  updatedAt: timestamp,
  pendingAction: 'delete',
})

const persistRecords = (records: HistoryRecord[]): HistoryEntry[] => {
  const sorted = sortRecordsForStorage(records)
  writeHistoryRecords(sorted)
  const activeEntries = recordsToActiveEntries(sorted)
  broadcastHistoryRecords(sorted)
  return activeEntries
}

export const persistHistorySnapshot = (nextEntries: HistoryEntry[]): HistoryEntry[] => {
  const sanitized = sanitizeHistoryEntries(nextEntries)
  const existingRecords = readHistoryRecords()
  const recordsById = new Map<string, HistoryRecord>()
  existingRecords.forEach((record) => {
    recordsById.set(record.id, record)
  })

  const timestamp = Date.now()
  const activeIds = new Set<string>()

  sanitized.forEach((entry) => {
    activeIds.add(entry.id)
    const existing = recordsById.get(entry.id)
    if (existing) {
      recordsById.set(entry.id, updateRecordWithEntry(existing, entry, timestamp))
    } else {
      recordsById.set(entry.id, createRecordFromEntry(entry, timestamp))
    }
  })

  recordsById.forEach((record, id) => {
    if (!activeIds.has(id)) {
      recordsById.set(id, markRecordPendingDelete(record, timestamp))
    }
  })

  const nextRecords = Array.from(recordsById.values())
  const activeEntries = persistRecords(nextRecords)
  schedulePendingPush()
  return activeEntries
}

const payloadFromRecord = (
  record: HistoryRecord,
  userId: string,
  overrideUpdatedAt?: number,
): Record<string, unknown> => {
  const updatedAt = overrideUpdatedAt ?? record.updatedAt
  const ENABLE_ROUTINE_TAGS = Boolean((import.meta as any)?.env?.VITE_ENABLE_ROUTINE_TAGS)
  return {
    id: record.id,
    user_id: userId,
    task_name: record.taskName,
    elapsed_ms: Math.max(0, Math.round(record.elapsed)),
    started_at: new Date(record.startedAt).toISOString(),
    ended_at: new Date(record.endedAt).toISOString(),
    goal_name: record.goalName,
    bucket_name: record.bucketName,
    goal_id: record.goalId,
    bucket_id: record.bucketId,
    task_id: record.taskId,
    goal_surface: record.goalSurface,
    bucket_surface: record.bucketSurface,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    ...(typeof record.futureSession === 'boolean' ? { future_session: record.futureSession } : {}),
    // Only include routine tags if the DB has these columns; gate with env flag to avoid PostgREST errors
    ...(ENABLE_ROUTINE_TAGS && record.routineId ? { routine_id: record.routineId } : {}),
    ...(ENABLE_ROUTINE_TAGS && record.occurrenceDate ? { occurrence_date: record.occurrenceDate } : {}),
  }
}

const mapDbRowToRecord = (row: Record<string, unknown>): HistoryRecord | null => {
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) {
    return null
  }
  const taskName = typeof row.task_name === 'string' ? row.task_name : ''

  const startedAt = parseTimestamp(row.started_at, Date.now())
  const endedAt = parseTimestamp(row.ended_at, startedAt)
  const elapsed = clampNumber(row.elapsed_ms, Math.max(0, endedAt - startedAt))

  const candidate: HistoryCandidate = {
    id,
    taskName,
    elapsed,
    startedAt,
    endedAt,
    goalName: typeof row.goal_name === 'string' ? row.goal_name : null,
    bucketName: typeof row.bucket_name === 'string' ? row.bucket_name : null,
    goalId: typeof row.goal_id === 'string' ? row.goal_id : null,
    bucketId: typeof row.bucket_id === 'string' ? row.bucket_id : null,
    taskId: typeof row.task_id === 'string' ? row.task_id : null,
    goalSurface: typeof row.goal_surface === 'string' ? row.goal_surface : null,
    bucketSurface: typeof row.bucket_surface === 'string' ? row.bucket_surface : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    subtasks: row.subtasks ?? null,
    futureSession: typeof (row as any).future_session === 'boolean' ? ((row as any).future_session as boolean) : null,
    routineId: typeof (row as any).routine_id === 'string' ? (row as any).routine_id : null,
    occurrenceDate: typeof (row as any).occurrence_date === 'string' ? (row as any).occurrence_date : null,
  }

  const entry = sanitizeHistoryEntries([candidate])[0]
  if (!entry) {
    return null
  }

  const createdAt = parseTimestamp(row.created_at, startedAt)
  const updatedAt = parseTimestamp(row.updated_at, endedAt)
  return {
    ...entry,
    createdAt,
    updatedAt,
    pendingAction: null,
  }
}

let activeSyncPromise: Promise<HistoryEntry[] | null> | null = null
let pendingPushTimeout: number | null = null

const schedulePendingPush = (): void => {
  if (!supabase) {
    return
  }
  if (typeof window === 'undefined') {
    void pushPendingHistoryToSupabase()
    return
  }
  if (pendingPushTimeout !== null) {
    window.clearTimeout(pendingPushTimeout)
  }
  pendingPushTimeout = window.setTimeout(() => {
    pendingPushTimeout = null
    void pushPendingHistoryToSupabase()
  }, 25)
}

export const syncHistoryWithSupabase = async (): Promise<HistoryEntry[] | null> => {
  if (activeSyncPromise) {
    return activeSyncPromise
  }
  if (!supabase) {
    return null
  }

  activeSyncPromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session) {
      return null
    }

    const userId = session.user.id
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const localRecords = readHistoryRecords()
    const recordsById = new Map<string, HistoryRecord>()
    localRecords.forEach((record) => {
      recordsById.set(record.id, record)
    })

    const selectColumns =
      'id, task_name, elapsed_ms, started_at, ended_at, goal_name, bucket_name, goal_id, bucket_id, task_id, goal_surface, bucket_surface, created_at, updated_at, future_session'

    // Limit remote fetch to a recent window to reduce egress
    const sinceIso = new Date(now - HISTORY_REMOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data: remoteRows, error: fetchError } = await supabase
      .from('session_history')
      .select((selectColumns as unknown) as any)
      .eq('user_id', userId)
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: false })
    if (fetchError) {
      console.warn('Failed to fetch session history delta from Supabase', fetchError)
      return null
    }

    const remoteMap = new Map<string, HistoryRecord>()
    ;((remoteRows as any[]) ?? []).forEach((row) => {
      const record = mapDbRowToRecord((row as unknown) as Record<string, unknown>)
      if (!record) {
        return
      }
      remoteMap.set(record.id, record)
      const local = recordsById.get(record.id)
      if (!local) {
        recordsById.set(record.id, record)
        return
      }
      const remoteTimestamp = record.updatedAt
      const localTimestamp = local.updatedAt
      if (remoteTimestamp > localTimestamp || (!local.pendingAction && remoteTimestamp === localTimestamp)) {
        recordsById.set(record.id, { ...record, pendingAction: null })
      }
    })

    // Remove records that were deleted remotely (not present in remoteMap and no local pending action)
    // Only apply delete within the remote window; keep older local records intact to avoid accidental purge.
    const sinceMs = now - HISTORY_REMOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    recordsById.forEach((record, id) => {
      if (!remoteMap.has(id) && !record.pendingAction) {
        if (record.updatedAt >= sinceMs) {
          recordsById.delete(id)
        }
      }
    })

    // Normalize: any record that starts in the future must be marked as a future session
    const normalizeNow = Date.now()
    recordsById.forEach((record, id) => {
      if (record.startedAt > normalizeNow && !record.futureSession) {
        recordsById.set(id, { ...record, futureSession: true, pendingAction: 'upsert', updatedAt: normalizeNow })
      }
    })

    const pending = Array.from(recordsById.values()).filter((record) => record.pendingAction)
    const pendingUpserts = pending.filter((record) => record.pendingAction === 'upsert')
    const pendingDeletes = pending.filter((record) => record.pendingAction === 'delete')

    if (pendingUpserts.length > 0) {
      const payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, Date.now()))
      const { error: upsertError } = await supabase.from('session_history').upsert(payloads, { onConflict: 'id' })
      if (upsertError) {
        console.warn('Failed to push pending history updates to Supabase', upsertError)
      } else {
        pendingUpserts.forEach((record, index) => {
          const payload = payloads[index]
          const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : nowIso
          const updatedAt = Date.parse(updatedIso)
          record.pendingAction = null
          record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
          recordsById.set(record.id, record)
        })
      }
    }

    if (pendingDeletes.length > 0) {
      const deleteIds = pendingDeletes.map((record) => record.id)
      const { error: deleteError } = await supabase.from('session_history').delete().in('id', deleteIds)
      if (deleteError) {
        console.warn('Failed to delete session history rows from Supabase', deleteError)
      } else {
        deleteIds.forEach((id) => {
          recordsById.delete(id)
        })
      }
    }

    return persistRecords(Array.from(recordsById.values()))
  })()

  try {
    return await activeSyncPromise
  } finally {
    activeSyncPromise = null
  }
}

export const pushPendingHistoryToSupabase = async (): Promise<void> => {
  if (!supabase) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return
  }

  const userId = session.user.id
  const records = readHistoryRecords()
  const pendingUpserts = records.filter((record) => record.pendingAction === 'upsert')
  const pendingDeletes = records.filter((record) => record.pendingAction === 'delete')

  if (pendingUpserts.length > 0) {
    const payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, Date.now()))
    const { error: upsertError } = await supabase.from('session_history').upsert(payloads, { onConflict: 'id' })
    if (upsertError) {
      console.warn('Failed to push pending history updates to Supabase', upsertError)
    } else {
      pendingUpserts.forEach((record, index) => {
        const payload = payloads[index]
        const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : new Date().toISOString()
        const updatedAt = Date.parse(updatedIso)
        record.pendingAction = null
        record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
      })
    }
  }

  if (pendingDeletes.length > 0) {
    const deleteIds = pendingDeletes.map((record) => record.id)
    const { error: deleteError } = await supabase.from('session_history').delete().in('id', deleteIds)
    if (deleteError) {
      console.warn('Failed to delete session history rows from Supabase', deleteError)
    } else {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (deleteIds.includes(records[index].id)) {
          records.splice(index, 1)
        }
      }
    }
  }

  persistRecords(records)
}
