import { supabase, ensureSingleUserSession } from './supabaseClient'
import { readStoredLifeRoutines, LIFE_ROUTINE_UPDATE_EVENT } from './lifeRoutines'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from './surfaceStyles'

export const HISTORY_STORAGE_KEY = 'nc-taskwatch-history'
export const HISTORY_EVENT_NAME = 'nc-taskwatch:history-update'
const HISTORY_USER_KEY = 'nc-taskwatch-history-user'
export const CURRENT_SESSION_STORAGE_KEY = 'nc-taskwatch-current-session'
export const CURRENT_SESSION_EVENT_NAME = 'nc-taskwatch:session-update'
export const HISTORY_LIMIT = 250
// Reduce remote fetch window to limit egress; adjust as needed
export const HISTORY_REMOTE_WINDOW_DAYS = 30
// Feature flags persisted locally to enable/disable optional server columns dynamically
const FEATURE_FLAGS_STORAGE_KEY = 'nc-taskwatch-flags'
type FeatureFlags = { repeatOriginal?: boolean }
const readFeatureFlags = (): FeatureFlags => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? (obj as FeatureFlags) : {}
  } catch {
    return {}
  }
}
const writeFeatureFlags = (flags: FeatureFlags) => {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(flags)) } catch {}
}
const isRepeatOriginalEnabled = (): boolean => {
  const flags = readFeatureFlags()
  // Default optimistic: true unless explicitly disabled
  return flags.repeatOriginal !== false
}
const disableRepeatOriginal = () => {
  const flags = readFeatureFlags()
  if (flags.repeatOriginal === false) return
  flags.repeatOriginal = false
  writeFeatureFlags(flags)
}
const getStoredHistoryUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(HISTORY_USER_KEY)
  } catch {
    return null
  }
}
const setStoredHistoryUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (!userId) {
      window.localStorage.removeItem(HISTORY_USER_KEY)
    } else {
      window.localStorage.setItem(HISTORY_USER_KEY, userId)
    }
  } catch {}
}
const isColumnMissingError = (err: any): boolean => {
  const msg = (err && (err.message || err.msg || err.error_description)) || ''
  const details = (err && (err.details || err.hint)) || ''
  const combined = `${msg} ${details}`.toLowerCase()
  return combined.includes('column') && combined.includes('does not exist')
}
const isConflictError = (err: any): boolean => {
  if (!err) return false
  const code = String(err.code ?? '').trim()
  if (code === '409' || code === '23505') {
    return true
  }
  const msg = String(err.message ?? '')
  const details = String(err.details ?? '')
  const combined = `${msg} ${details}`.toLowerCase()
  return combined.includes('duplicate key value') || combined.includes('already exists')
}

const toDbSurface = (value: SurfaceStyle | null | undefined): SurfaceStyle | null =>
  sanitizeSurfaceStyle(value) ?? null

const LIFE_ROUTINES_NAME = 'Daily Life'
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'

const buildLifeRoutineSurfaceLookups = (): {
  idOrBucket: Map<string, SurfaceStyle>
  title: Map<string, SurfaceStyle>
} | null => {
  const routines = readStoredLifeRoutines()
  if (!Array.isArray(routines) || routines.length === 0) {
    return null
  }
  const idOrBucket = new Map<string, SurfaceStyle>()
  const title = new Map<string, SurfaceStyle>()
  routines.forEach((routine) => {
    if (!routine) {
      return
    }
    const surface = ensureSurfaceStyle(routine.surfaceStyle, DEFAULT_SURFACE_STYLE)
    const keys = new Set<string>()
    if (typeof routine.id === 'string' && routine.id.trim().length > 0) {
      keys.add(routine.id.trim())
    }
    if (typeof routine.bucketId === 'string' && routine.bucketId.trim().length > 0) {
      keys.add(routine.bucketId.trim())
    }
    keys.forEach((key) => {
      if (!idOrBucket.has(key)) {
        idOrBucket.set(key, surface)
      }
    })
    if (typeof routine.title === 'string' && routine.title.trim().length > 0) {
      title.set(routine.title.trim().toLowerCase(), surface)
    }
  })
  if (idOrBucket.size === 0 && title.size === 0) {
    return null
  }
  return { idOrBucket, title }
}

const applyLifeRoutineSurfaces = (
  records: HistoryRecord[],
): { records: HistoryRecord[]; changed: boolean } => {
  if (!records || records.length === 0) {
    return { records, changed: false }
  }
  const lookups = buildLifeRoutineSurfaceLookups()
  if (!lookups) {
    return { records, changed: false }
  }
  let changed = false
  const next = records.map((record) => {
    if (!record) {
      return record
    }
    const isDailyLifeRecord =
      record.goalId === LIFE_ROUTINES_GOAL_ID ||
      record.goalName === LIFE_ROUTINES_NAME ||
      (typeof record.bucketId === 'string' && record.bucketId.startsWith('life-'))
    if (!isDailyLifeRecord) {
      return record
    }
    const candidateKeys: string[] = []
    if (typeof record.bucketId === 'string' && record.bucketId.trim()) {
      candidateKeys.push(record.bucketId.trim())
    }
    if (typeof record.taskId === 'string' && record.taskId.trim()) {
      candidateKeys.push(record.taskId.trim())
    }
    if (typeof record.routineId === 'string' && record.routineId.trim()) {
      candidateKeys.push(record.routineId.trim())
    }
    let surface: SurfaceStyle | null = null
    for (const key of candidateKeys) {
      const match = lookups.idOrBucket.get(key)
      if (match) {
        surface = match
        break
      }
    }
    if (!surface && typeof record.bucketName === 'string' && record.bucketName.trim().length > 0) {
      const normalized = record.bucketName.trim().toLowerCase()
      surface = lookups.title.get(normalized) ?? null
    }
    if (!surface || record.bucketSurface === surface) {
      return record
    }
    changed = true
    const next: HistoryRecord = { ...record, bucketSurface: surface }
    if (record.goalId === LIFE_ROUTINES_GOAL_ID && record.goalSurface !== LIFE_ROUTINES_SURFACE) {
      next.goalSurface = LIFE_ROUTINES_SURFACE
    }
    return next
  })
  return { records: changed ? next : records, changed }
}

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
  // Server-side deletion support:
  // repeatingSessionId: FK to repeating_sessions.id when a guide transforms (confirm/skip/reschedule)
  // originalTime: the scheduled timestamptz (in ms) of the guide occurrence that transformed
  repeatingSessionId?: string | null
  originalTime?: number | null
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
  repeatingSessionId?: unknown
  originalTime?: unknown
}

type HistoryRecordCandidate = HistoryCandidate & {
  createdAt?: unknown
  updatedAt?: unknown
  pendingAction?: unknown
}

const MINUTE_MS = 60 * 1000
export const SAMPLE_SLEEP_ROUTINE_ID = 'sample-sleep-rule'
const formatOccurrenceDate = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10)
const minuteVariance = (dayOffset: number, seed: number): number => {
  const base = (dayOffset * 37 + seed * 11) % 21
  return base - 10
}

export const createSampleHistoryRecords = (): HistoryRecord[] => {
  const anchor = new Date()
  anchor.setSeconds(0, 0)
  const getStart = (daysAgo: number, hour: number, minute: number): number => {
    const d = new Date(anchor.getTime())
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }

  type SampleConfig = {
    taskName: string
    daysAgo: number
    startHour: number
    startMinute: number
    durationMinutes: number
    goalName: string | null
    bucketName: string | null
    goalId: string | null
    bucketId: string | null
    taskId: string | null
    goalSurface: SurfaceStyle
    bucketSurface?: SurfaceStyle | null
    notes?: string
    routineId?: string | null
    occurrenceDate?: string | null
    futureSession?: boolean
  }

  const entries: HistoryEntry[] = []
  const addEntry = (config: SampleConfig) => {
    const startedAt = getStart(config.daysAgo, config.startHour, config.startMinute)
    const elapsed = Math.max(MINUTE_MS, config.durationMinutes * MINUTE_MS)
    const occurrenceDate =
      config.occurrenceDate ?? (config.routineId ? formatOccurrenceDate(startedAt) : null)
    entries.push({
      id: `history-sample-${entries.length + 1}`,
      taskName: config.taskName,
      elapsed,
      startedAt,
      endedAt: startedAt + elapsed,
      goalName: config.goalName,
      bucketName: config.bucketName,
      goalId: config.goalId,
      bucketId: config.bucketId,
      taskId: config.taskId,
      goalSurface: config.goalSurface,
      bucketSurface: config.bucketSurface ?? null,
      notes: config.notes ?? '',
      subtasks: [],
      routineId: config.routineId ?? null,
      occurrenceDate,
      futureSession: config.futureSession ?? false,
    })
  }

  const CANONICAL_SLEEP_DAY_OFFSET = 3

  const addSleepEntry = (dayOffset: number) => {
    let startMinute = Math.max(0, Math.min(59, minuteVariance(dayOffset, 4)))
    if (dayOffset === CANONICAL_SLEEP_DAY_OFFSET) {
      startMinute = 0
    }
    const durationMinutes = 8 * 60
    addEntry({
      taskName: 'Sleep',
      daysAgo: dayOffset,
      startHour: 23,
      startMinute,
      durationMinutes,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      notes: 'Daily wind-down + sleep block.',
      routineId: SAMPLE_SLEEP_ROUTINE_ID,
    })
  }

  type SessionPreset = Omit<SampleConfig, 'daysAgo' | 'startHour' | 'startMinute' | 'durationMinutes'>
  const sessionPresets: Record<string, SessionPreset> = {
    study: {
      taskName: 'Deep study block',
      goalName: 'Ace This Semester',
      bucketName: 'Lectures & Notes',
      goalId: 'g_demo',
      bucketId: 'b_demo_1',
      taskId: 't_demo_1',
      goalSurface: 'glass',
      bucketSurface: 'cool-blue',
      notes: 'Lecture review + flashcards.',
    },
    internship: {
      taskName: 'Internship sprint',
      goalName: 'Level Up at Work',
      bucketName: 'Deep Work Sprints',
      goalId: 'g2',
      bucketId: 'b4',
      taskId: 't19',
      goalSurface: 'glass',
      bucketSurface: 'charcoal',
      notes: 'Heads-down product work.',
    },
    creative: {
      taskName: 'Creative assignment burst',
      goalName: 'Ace This Semester',
      bucketName: 'Assignments',
      goalId: 'g_demo',
      bucketId: 'b_demo_2',
      taskId: 't_demo_4',
      goalSurface: 'glass',
      bucketSurface: 'midnight',
      notes: 'Essay outline + drafting.',
    },
    health: {
      taskName: 'Gym + movement',
      goalName: 'Healthy Work-Life Rhythm',
      bucketName: 'Movement',
      goalId: 'g3',
      bucketId: 'b7',
      taskId: 't14',
      goalSurface: 'glass',
      bucketSurface: 'fresh-teal',
      notes: 'Strength + stretch.',
    },
    social: {
      taskName: 'Social reset',
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Socials',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-socials',
      taskId: 'life-socials',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'soft-magenta',
      notes: 'Hangs / check-ins.',
    },
    admin: {
      taskName: 'Life admin sprint',
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Life Admin',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-admin',
      taskId: 'life-admin',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'neutral-grey-blue',
      notes: 'Inbox, bills, planning.',
    },
  }

  type DaySessionPlan = {
    preset: keyof typeof sessionPresets
    duration: number
    overrideName?: string
    notes?: string
  }

  const dayPlans: Array<{ dayOffset: number; sessions: DaySessionPlan[] }> = [
    { dayOffset: 1, sessions: [
      { preset: 'study', duration: 180, overrideName: 'Lecture review marathon' },
      { preset: 'internship', duration: 150, overrideName: 'Product sprint focus' },
      {
        preset: 'internship',
        duration: 240,
        overrideName: 'End Taskwatch Demo event',
        notes: 'Wrap up guest walkthrough and share highlights.',
      },
    ] },
    { dayOffset: 2, sessions: [
      { preset: 'internship', duration: 180, overrideName: 'Deep work sprints' },
      { preset: 'creative', duration: 150, overrideName: 'Studio critique prep' },
      { preset: 'social', duration: 120, overrideName: 'Dinner + hangout' },
    ] },
    { dayOffset: 3, sessions: [
      { preset: 'study', duration: 150, overrideName: 'Group study jam' },
      { preset: 'admin', duration: 90, overrideName: 'Life admin & groceries' },
      { preset: 'health', duration: 100, overrideName: 'Pilates + walk' },
    ] },
    { dayOffset: 4, sessions: [
      { preset: 'creative', duration: 180, overrideName: 'Essay drafting session' },
      { preset: 'study', duration: 150, overrideName: 'Lab prep & notes' },
      { preset: 'social', duration: 120, overrideName: 'Family FaceTime' },
    ] },
    { dayOffset: 5, sessions: [] },
  ]

  const dayClock = new Map<number, number>()
  const ensureDayClock = (dayOffset: number): number => {
    if (!dayClock.has(dayOffset)) {
      const base = 8 * 60 + minuteVariance(dayOffset, 33)
      dayClock.set(dayOffset, base)
    }
    return dayClock.get(dayOffset)!
  }

  const scheduleSession = (dayOffset: number, session: DaySessionPlan) => {
    const preset = sessionPresets[session.preset]
    const startMinutes = Math.max(6 * 60, ensureDayClock(dayOffset))
    const duration = Math.max(60, session.duration + minuteVariance(dayOffset, session.duration))
    const safeStartMinutes = Math.min(startMinutes, 21 * 60)
    const startHour = Math.floor(safeStartMinutes / 60)
    const startMinute = safeStartMinutes % 60
    addEntry({
      ...preset,
      taskName: session.overrideName ?? preset.taskName,
      notes: session.notes ?? preset.notes,
      daysAgo: dayOffset,
      startHour,
      startMinute,
      durationMinutes: duration,
    })
    const gap = Math.max(20, 30 + minuteVariance(dayOffset, duration))
    dayClock.set(dayOffset, safeStartMinutes + duration + gap)
  }

  dayPlans.forEach((plan) => {
    addSleepEntry(plan.dayOffset)
    dayClock.set(plan.dayOffset, 8 * 60 + minuteVariance(plan.dayOffset, 41))
    plan.sessions.forEach((session) => scheduleSession(plan.dayOffset, session))
  })

  addEntry({
    taskName: "X's Birthday",
    daysAgo: 3,
    startHour: 0,
    startMinute: 0,
    durationMinutes: 24 * 60,
    goalName: LIFE_ROUTINES_NAME,
    bucketName: 'Socials',
    goalId: LIFE_ROUTINES_GOAL_ID,
    bucketId: 'life-socials',
    taskId: 'life-socials-birthday',
    goalSurface: LIFE_ROUTINES_SURFACE,
    bucketSurface: 'sunset-orange',
    notes: 'All-day celebration for a close friend.',
  })

  addEntry({
    taskName: 'Snapback – Doomscrolling',
    daysAgo: 2,
    startHour: 22,
    startMinute: 0,
    durationMinutes: 45,
    goalName: 'Snapback',
    bucketName: 'Doomscrolling',
    goalId: 'snapback',
    bucketId: 'snapback-doomscrolling',
    taskId: 'snapback-doomscroll',
    goalSurface: 'charcoal',
    bucketSurface: 'charcoal',
    notes: 'Mindless scrolling that pulled me off track.',
  })

  const futureGuideBlocks: SampleConfig[] = [
    {
      taskName: 'Sleep',
      daysAgo: -1,
      startHour: 23,
      startMinute: 0,
      durationMinutes: 8 * 60,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      routineId: SAMPLE_SLEEP_ROUTINE_ID,
      futureSession: true,
      notes: 'Guide entry for tomorrow night.',
    },
    {
      taskName: 'Sleep',
      daysAgo: -2,
      startHour: 23,
      startMinute: 0,
      durationMinutes: 8 * 60,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      routineId: SAMPLE_SLEEP_ROUTINE_ID,
      futureSession: true,
      notes: 'Guide entry for later this week.',
    },
  ]

  futureGuideBlocks.forEach(addEntry)

  return entries.map((entry, index) => ({
    ...entry,
    createdAt: entry.startedAt,
    updatedAt: entry.endedAt + index,
    pendingAction: null,
  }))
}
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
// Snap a timestamp to the nearest minute. If exactly halfway (30s), round up.
const snapToNearestMinute = (ms: number): number => {
  if (!Number.isFinite(ms)) return ms
  const MIN = 60_000
  const rem = ms % MIN
  if (rem === 0) return ms
  const posRem = rem < 0 ? rem + MIN : rem
  return posRem >= 30_000 ? ms + (MIN - posRem) : ms - posRem
}

const normalizeEntryTimes = (entry: HistoryEntry): HistoryEntry => {
  const started = snapToNearestMinute(entry.startedAt)
  const ended = snapToNearestMinute(entry.endedAt)
  const elapsed = Math.max(0, ended - started)
  if (started === entry.startedAt && ended === entry.endedAt && elapsed === entry.elapsed) return entry
  return { ...entry, startedAt: started, endedAt: ended, elapsed }
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
      const repeatingSessionIdRaw: string | null =
        typeof (candidate as any).repeatingSessionId === 'string' ? ((candidate as any).repeatingSessionId as string) : null
      const originalTimeRaw: number | null =
        typeof (candidate as any).originalTime === 'number' && Number.isFinite((candidate as any).originalTime as number)
          ? ((candidate as any).originalTime as number)
          : null

      const normalizedGoalName = goalNameRaw.trim()
      const normalizedBucketName = bucketNameRaw.trim()

      let goalSurface = goalSurfaceRaw ?? null
      let bucketSurface = bucketSurfaceRaw ?? null

      if (!goalSurface && normalizedGoalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
        goalSurface = LIFE_ROUTINES_SURFACE
      }
      // No default bucket surface mapping; bucket surface remains as provided or null

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
        repeatingSessionId: repeatingSessionIdRaw,
        originalTime: originalTimeRaw,
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
    return createSampleHistoryRecords()
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      const sampleRecords = createSampleHistoryRecords()
      writeHistoryRecords(sampleRecords)
      return sampleRecords
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

export const purgeDeletedHistoryRecords = (): void => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) {
    return
  }
  const filtered = records.filter((record) => record.pendingAction !== 'delete')
  if (filtered.length === records.length) {
    return
  }
  const sorted = sortRecordsForStorage(filtered)
  writeHistoryRecords(sorted)
  broadcastHistoryRecords(sorted)
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
  const dispatch = () => {
    try {
      const event = new CustomEvent<HistoryRecord[]>(HISTORY_EVENT_NAME, { detail: records })
      window.dispatchEvent(event)
    } catch (error) {
      console.warn('Failed to broadcast history update', error)
    }
  }
  // Dispatch on a microtask to avoid triggering state updates in other components
  // while React is rendering this component (prevents cross-component setState warnings).
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispatch)
  } else {
    setTimeout(dispatch, 0)
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)
const generateUuid = (): string => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

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

const realignHistoryWithLifeRoutineSurfaces = (): void => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) {
    return
  }
  const { records: alignedRecords, changed } = applyLifeRoutineSurfaces(records)
  if (!changed) {
    return
  }
  persistRecords(alignedRecords)
}

const setupLifeRoutineSurfaceSync = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    realignHistoryWithLifeRoutineSurfaces()
  } catch (error) {
    console.warn('[sessionHistory] Failed to align history surfaces on load', error)
  }
  const handleUpdate = () => {
    try {
      realignHistoryWithLifeRoutineSurfaces()
    } catch (error) {
      console.warn('[sessionHistory] Failed to align history surfaces after routine update', error)
    }
  }
  window.addEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate)
}

setupLifeRoutineSurfaceSync()

export const persistHistorySnapshot = (nextEntries: HistoryEntry[]): HistoryEntry[] => {
  const sanitized = sanitizeHistoryEntries(nextEntries).map(normalizeEntryTimes)
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
  const updatedAt = overrideUpdatedAt ?? record.updatedAt ?? Date.now()
  const createdAtSource =
    typeof record.createdAt === 'number'
      ? record.createdAt
      : typeof record.startedAt === 'number'
        ? record.startedAt
        : Date.now()
  const ENABLE_ROUTINE_TAGS = Boolean((import.meta as any)?.env?.VITE_ENABLE_ROUTINE_TAGS)
  const ENABLE_REPEAT_ORIGINAL = isRepeatOriginalEnabled()
  const DEBUG_REPEAT = false
  const includeRepeat = ENABLE_REPEAT_ORIGINAL && !!record.repeatingSessionId
  const includeOriginal = ENABLE_REPEAT_ORIGINAL && Number.isFinite(record.originalTime as number)
  if (DEBUG_REPEAT) {
    try {
      // Minimal debug to verify what we are sending to the server for this record
      // Avoid logging large payload; only the linkage fields
      // eslint-disable-next-line no-console
      console.info('[history] payload linkage', {
        id: record.id,
        enableRepeatOriginal: ENABLE_REPEAT_ORIGINAL,
        repeatingSessionId: record.repeatingSessionId ?? null,
        originalTimeMs: Number.isFinite(record.originalTime as number) ? (record.originalTime as number) : null,
        willInclude: { repeating_session_id: includeRepeat, original_time: includeOriginal },
      })
    } catch {}
  }
  return {
    id: record.id,
    user_id: userId,
    task_name: record.taskName,
    elapsed_ms: Math.max(0, Math.round(record.elapsed)),
    started_at: new Date(record.startedAt).toISOString(),
    ended_at: new Date(record.endedAt).toISOString(),
    goal_name: record.goalName,
    bucket_name: record.bucketName,
    goal_id: isUuid(record.goalId) ? record.goalId : null,
    bucket_id: isUuid(record.bucketId) ? record.bucketId : null,
    task_id: isUuid(record.taskId) ? record.taskId : null,
    // Clamp surfaces to DB-allowed values to satisfy CHECK constraints server-side
    goal_surface: toDbSurface(record.goalSurface),
    bucket_surface: toDbSurface(record.bucketSurface ?? undefined),
    created_at: new Date(createdAtSource).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    ...(typeof record.futureSession === 'boolean' ? { future_session: record.futureSession } : {}),
    // Only include routine tags if the DB has these columns; gate with env flag to avoid PostgREST errors
    ...(ENABLE_ROUTINE_TAGS && record.routineId ? { routine_id: record.routineId } : {}),
    ...(ENABLE_ROUTINE_TAGS && record.occurrenceDate ? { occurrence_date: record.occurrenceDate } : {}),
    // Include server-side resolution metadata if enabled
    ...(includeRepeat ? { repeating_session_id: record.repeatingSessionId } : {}),
    ...(includeOriginal ? { original_time: new Date(record.originalTime as number).toISOString() } : {}),
  }
}

const mapDbRowToRecord = (row: Record<string, unknown>): HistoryRecord | null => {
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) {
    return null
  }
  const taskName = typeof row.task_name === 'string' ? row.task_name : ''

  // Normalize remote timestamps to minute boundaries
  const rawStart = parseTimestamp(row.started_at, Date.now())
  const rawEnd = parseTimestamp(row.ended_at, rawStart)
  const startedAt = snapToNearestMinute(rawStart)
  const endedAt = snapToNearestMinute(rawEnd)
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
    repeatingSessionId: typeof (row as any).repeating_session_id === 'string' ? (row as any).repeating_session_id : null,
    originalTime: parseTimestamp((row as any).original_time, NaN),
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
    const lastUserId = getStoredHistoryUserId()
    const userChanged = lastUserId !== userId
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    let localRecords = readHistoryRecords()

    if (userChanged && (!lastUserId || lastUserId.length === 0) && localRecords.length > 0) {
      console.info('[sessionHistory] Guest history detected; deferring Supabase sync until bootstrap seeds data.')
      return recordsToActiveEntries(localRecords)
    }

    if (userChanged && lastUserId && lastUserId !== userId) {
      console.info('[sessionHistory] Switching users; clearing local history cache for new session.')
      writeHistoryRecords([])
      localRecords = []
    }

    const recordsById = new Map<string, HistoryRecord>()
    if (!userChanged) {
      localRecords.forEach((record) => {
        recordsById.set(record.id, record)
      })
    }

    const ENABLE_REPEAT_ORIGINAL = isRepeatOriginalEnabled()
    let selectColumns =
      'id, task_name, elapsed_ms, started_at, ended_at, goal_name, bucket_name, goal_id, bucket_id, task_id, goal_surface, bucket_surface, created_at, updated_at, future_session'
    // If server has repeat-orig columns, request them to avoid losing local metadata on merge
    if (ENABLE_REPEAT_ORIGINAL) {
      selectColumns += ', repeating_session_id, original_time'
    }

    // Limit remote fetch to a recent window to reduce egress
    const sinceIso = new Date(now - HISTORY_REMOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    let { data: remoteRows, error: fetchError } = await supabase
      .from('session_history')
      .select((selectColumns as unknown) as any)
      .eq('user_id', userId)
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: false })
    if (fetchError) {
      if (ENABLE_REPEAT_ORIGINAL && isColumnMissingError(fetchError)) {
        // Server likely doesn't have the optional columns; disable dynamically and retry once
        disableRepeatOriginal()
        const baseColumns = 'id, task_name, elapsed_ms, started_at, ended_at, goal_name, bucket_name, goal_id, bucket_id, task_id, goal_surface, bucket_surface, created_at, updated_at, future_session'
        const retry = await supabase
          .from('session_history')
          .select((baseColumns as unknown) as any)
          .eq('user_id', userId)
          .gte('updated_at', sinceIso)
          .order('updated_at', { ascending: false })
        remoteRows = retry.data as any
        fetchError = retry.error as any
      }
    }
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
        // Preserve routine tags from local if remote mapping lacks them (schema may not include these columns)
        const routineId = (record as any).routineId ?? (local as any).routineId ?? null
        const occurrenceDate = (record as any).occurrenceDate ?? (local as any).occurrenceDate ?? null
        // Also preserve repeat-orig linkage if remote rows don't include these columns
        const repeatingSessionId = (record as any).repeatingSessionId ?? (local as any).repeatingSessionId ?? null
        const originalTime = Number.isFinite((record as any).originalTime)
          ? (record as any).originalTime
          : ((local as any).originalTime ?? null)
        recordsById.set(record.id, { ...record, routineId, occurrenceDate, repeatingSessionId, originalTime, pendingAction: null })
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
      const client = supabase!
      const doUpsertWithFallback = async (pls: any[]) => {
        // First attempt
        let resp = await client
          .from('session_history')
          .upsert(pls, { onConflict: 'id', ignoreDuplicates: true })
        // Column missing for ANY optional column (routine_id, occurrence_date, repeating_session_id, original_time)
        // Retry once stripping all optional linkage/tag columns.
        if (resp.error && isColumnMissingError(resp.error)) {
          if (isRepeatOriginalEnabled()) {
            // Disable repeat-original feature dynamically so future payloads omit linkage columns
            disableRepeatOriginal()
          }
          const strippedOptional = pls.map((p) => {
            const c: any = { ...p }
            delete c.routine_id
            delete c.occurrence_date
            delete c.repeating_session_id
            delete c.original_time
            return c
          })
          resp = await client
            .from('session_history')
            .upsert(strippedOptional, { onConflict: 'id', ignoreDuplicates: true })
          return { resp, usedPayloads: strippedOptional }
        }
        // Foreign key violation for repeating_session_id → retry stripping linkage only (keep routine tags if present)
        const code = String((resp.error as any)?.code || '')
        const details = String((resp.error as any)?.details || '') + ' ' + String((resp.error as any)?.message || '')
        if (resp.error && code === '23503' && details.toLowerCase().includes('repeating_sessions')) {
          const stripped = pls.map((p) => {
            const copy: any = { ...p }
            delete copy.repeating_session_id
            delete copy.original_time
            return copy
          })
        resp = await client
          .from('session_history')
          .upsert(stripped, { onConflict: 'id', ignoreDuplicates: true })
          return { resp, usedPayloads: stripped }
        }
        if (resp.error && isConflictError(resp.error)) {
          console.info('[sessionHistory] Ignoring history conflict error', resp.error?.message ?? resp.error)
          const cleanResp: typeof resp = { ...resp, error: null as any }
          return { resp: cleanResp, usedPayloads: pls }
        }
        return { resp, usedPayloads: pls }
      }

      let payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, Date.now()))
      const { resp: upsertResp, usedPayloads } = await doUpsertWithFallback(payloads)
      if (upsertResp.error) {
        console.warn('Failed to push pending history updates to Supabase', upsertResp.error)
      } else {
        pendingUpserts.forEach((record, index) => {
          const payload = usedPayloads[index]
          const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : nowIso
          const updatedAt = Date.parse(updatedIso)
          record.pendingAction = null
          record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
          recordsById.set(record.id, record)
        })
      }
    }

    if (pendingDeletes.length > 0) {
      const deleteIds = pendingDeletes.map((record) => record.id).filter((id) => isUuid(id))
      if (deleteIds.length > 0) {
        const { error: deleteError } = await supabase.from('session_history').delete().in('id', deleteIds)
        if (deleteError) {
          console.warn('Failed to delete session history rows from Supabase', deleteError)
        } else {
          deleteIds.forEach((id) => {
            recordsById.delete(id)
          })
        }
      }
      // Purge any non-UUID delete candidates locally since we can't delete them remotely
      pendingDeletes
        .filter((record) => !isUuid(record.id))
        .forEach((record) => {
          recordsById.delete(record.id)
        })
    }

    const recordList = Array.from(recordsById.values())
    const { records: enrichedRecords } = applyLifeRoutineSurfaces(recordList)
    const persisted = persistRecords(enrichedRecords)
    setStoredHistoryUserId(userId)
    return persisted
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
  const lastUserId = getStoredHistoryUserId()
  if (lastUserId !== null && lastUserId !== userId) {
    console.info('[sessionHistory] User changed; deferring pending push until sync.')
    return
  }
  const records = readHistoryRecords()
  const pendingUpserts = records.filter((record) => record.pendingAction === 'upsert')
  const pendingDeletes = records.filter((record) => record.pendingAction === 'delete')
  if (pendingUpserts.length > 0 || pendingDeletes.length > 0) {
    console.info('[sessionHistory] pushPendingHistory run', {
      pendingUpserts: pendingUpserts.length,
      pendingDeletes: pendingDeletes.length,
    })
  }

  if (pendingUpserts.length > 0) {
    const client = supabase!
    const doUpsertWithFallback = async (pls: any[]) => {
      let resp = await client
        .from('session_history')
        .upsert(pls, { onConflict: 'id', ignoreDuplicates: true })
      // Handle missing columns for any optional set (routine tags or repeat-original linkage)
      if (resp.error && isColumnMissingError(resp.error)) {
        if (isRepeatOriginalEnabled()) {
          disableRepeatOriginal()
        }
        const strippedOptional = pls.map((p) => { const c: any = { ...p }; delete c.routine_id; delete c.occurrence_date; delete c.repeating_session_id; delete c.original_time; return c })
        resp = await client
          .from('session_history')
          .upsert(strippedOptional, { onConflict: 'id', ignoreDuplicates: true })
        return { resp, usedPayloads: strippedOptional }
      }
      const code = String((resp.error as any)?.code || '')
      const details = String((resp.error as any)?.details || '') + ' ' + String((resp.error as any)?.message || '')
      if (resp.error && code === '23503' && details.toLowerCase().includes('repeating_sessions')) {
        const stripped = pls.map((p) => { const c: any = { ...p }; delete c.repeating_session_id; delete c.original_time; return c })
        resp = await client
          .from('session_history')
          .upsert(stripped, { onConflict: 'id', ignoreDuplicates: true })
        return { resp, usedPayloads: stripped }
      }
      if (resp.error && isConflictError(resp.error)) {
        console.info('[sessionHistory] Ignoring conflict while pushing history', resp.error?.message ?? resp.error)
        const cleanResp: typeof resp = { ...resp, error: null as any }
        return { resp: cleanResp, usedPayloads: pls }
      }
      return { resp, usedPayloads: pls }
    }

    let payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, Date.now()))
    const { resp: upsertResp, usedPayloads } = await doUpsertWithFallback(payloads)
    if (upsertResp.error) {
      console.warn('Failed to push pending history updates to Supabase', upsertResp.error)
    } else {
      pendingUpserts.forEach((record, index) => {
        const payload = usedPayloads[index]
        const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : new Date().toISOString()
        const updatedAt = Date.parse(updatedIso)
        record.pendingAction = null
        record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
      })
    }
  }

  if (pendingDeletes.length > 0) {
    const uuidDeleteIds = pendingDeletes.map((record) => record.id).filter((id) => isUuid(id))
    if (uuidDeleteIds.length > 0) {
      const { error: deleteError } = await supabase.from('session_history').delete().in('id', uuidDeleteIds)
      if (deleteError) {
        console.warn('Failed to delete session history rows from Supabase', deleteError)
      } else {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (uuidDeleteIds.includes(records[index].id)) {
            records.splice(index, 1)
          }
        }
      }
    }
    // Remove local-only ids that have no remote UUID equivalent.
    pendingDeletes
      .filter((record) => !isUuid(record.id))
      .forEach((record) => {
        const idx = records.findIndex((r) => r.id === record.id)
        if (idx !== -1) {
          records.splice(idx, 1)
        }
      })
  }

  persistRecords(records)
}

// Remove planned (futureSession) entries for a given rule that occur strictly AFTER the given local date (YYYY-MM-DD).
// Used when setting a repeating rule to "none" after a selected occurrence to avoid lingering planned rows.
export const pruneFuturePlannedForRuleAfter = async (ruleId: string, afterYmd: string): Promise<void> => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) return
  const now = Date.now()
  let changed = false
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i] as any
    const isPlanned = Boolean(r.futureSession)
    const rid = typeof r.routineId === 'string' ? (r.routineId as string) : null
    const od = typeof r.occurrenceDate === 'string' ? (r.occurrenceDate as string) : null
    if (isPlanned && rid === ruleId && od && od > afterYmd && (records[i] as any).pendingAction !== 'delete') {
      records[i] = { ...records[i], pendingAction: 'delete', updatedAt: now }
      changed = true
    }
  }
  if (changed) {
    persistRecords(records)
    schedulePendingPush()
  }
}

export const remapHistoryRoutineIds = async (mapping: Record<string, string>): Promise<void> => {
  if (!mapping || Object.keys(mapping).length === 0) {
    return
  }
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return

  let records = readHistoryRecords()
  const originalLength = records.length
  records = records.filter((record) => record.pendingAction !== 'delete')
  if (originalLength !== records.length) {
    writeHistoryRecords(records)
  }
  let changed = false
  records = records.map((record) => {
    let next = record
    if (record.routineId && mapping[record.routineId]) {
      next = { ...next, routineId: mapping[record.routineId] }
      changed = true
    }
    if (record.repeatingSessionId && mapping[record.repeatingSessionId]) {
      next = { ...next, repeatingSessionId: mapping[record.repeatingSessionId] }
      changed = true
    }
    return next
  })
  if (changed) {
    writeHistoryRecords(records)
  }
}

export const hasRemoteHistory = async (): Promise<boolean> => {
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true
  try {
    const { count, error } = await supabase
      .from('session_history')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
    if (error) {
      console.warn('[sessionHistory] Unable to inspect remote history:', error)
      return true
    }
    return typeof count === 'number' && count > 0
  } catch (error) {
    console.warn('[sessionHistory] Unexpected remote history check error:', error)
    return true
  }
}

export const pushAllHistoryToSupabase = async (
  ruleIdMap?: Record<string, string>,
  seedTimestamp?: number,
): Promise<void> => {
  if (!supabase) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return
  }
  purgeDeletedHistoryRecords()
  const remoteExists = await hasRemoteHistory()
  if (remoteExists) {
    console.info('[sessionHistory] Remote history already exists; skipping seed.')
    return
  }
  let records = readHistoryRecords()
  const samples = createSampleHistoryRecords()
  if (!records || records.length === 0) {
    writeHistoryRecords(samples)
    records = samples
  } else {
    const map = new Map<string, HistoryRecord>()
    records.forEach((record) => map.set(record.id, record))
    let added = false
    samples.forEach((sample) => {
      if (!map.has(sample.id)) {
        map.set(sample.id, sample)
        added = true
      }
    })
    if (added) {
      const merged = Array.from(map.values())
      records = sortRecordsForStorage(merged)
      writeHistoryRecords(records)
    }
  }
  const uuidNormalized = records.map((record) => {
    if (isUuid(record.id)) {
      return record
    }
    const id = generateUuid()
    return { ...record, id }
  })
  if (uuidNormalized.some((record, index) => record.id !== records[index]?.id)) {
    console.info('[sessionHistory] Normalized history ids to UUID format')
    records = uuidNormalized
    writeHistoryRecords(records)
  }
  const { records: lifeRoutineAligned, changed: alignedChanged } = applyLifeRoutineSurfaces(records)
  if (alignedChanged) {
    records = lifeRoutineAligned
    writeHistoryRecords(records)
  }
  const normalizedRecords = sortRecordsForStorage(records).map((record, index) => {
    let mappedRoutineId = record.routineId
    let mappedRepeatingId = record.repeatingSessionId
    if (ruleIdMap && record.routineId && ruleIdMap[record.routineId]) {
      mappedRoutineId = ruleIdMap[record.routineId]
    }
    if (ruleIdMap && record.repeatingSessionId && ruleIdMap[record.repeatingSessionId]) {
      mappedRepeatingId = ruleIdMap[record.repeatingSessionId]
    }
    const createdAt =
      typeof record.createdAt === 'number'
        ? record.createdAt
        : typeof seedTimestamp === 'number'
          ? seedTimestamp + index
          : Date.now() + index
    return {
      ...record,
      createdAt,
      routineId: mappedRoutineId,
      repeatingSessionId: mappedRepeatingId,
      pendingAction: null,
    }
  })
  const userId = session.user.id
  const payloads = normalizedRecords.map((record, index) =>
    payloadFromRecord(record, userId, seedTimestamp ? seedTimestamp + index : Date.now() + index),
  )
  const { error } = await supabase
    .from('session_history')
    .upsert(payloads, { onConflict: 'id', ignoreDuplicates: true })
  if (error) {
    console.warn('[sessionHistory] Failed to seed initial history:', {
      error,
      samplePayload: payloads[0],
    })
  } else {
    console.info('[sessionHistory] Seeded session history rows:', payloads.length)
  }
  persistRecords(normalizedRecords)
  setStoredHistoryUserId(session.user.id)
}
