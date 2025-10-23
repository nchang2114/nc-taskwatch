import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import '../App.css'
import './GoalsPage.css'
import {
  fetchGoalsHierarchy,
  setTaskCompletedAndResort,
  setTaskDifficulty,
  setTaskPriorityAndResort,
} from '../lib/goalsApi'
import { FOCUS_EVENT_TYPE, type FocusBroadcastDetail, type FocusBroadcastEvent } from '../lib/focusChannel'
import {
  createGoalsSnapshot,
  publishGoalsSnapshot,
  readStoredGoalsSnapshot,
  subscribeToGoalsSnapshot,
  type GoalSnapshot,
} from '../lib/goalsSync'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  LIFE_ROUTINE_STORAGE_KEY,
  LIFE_ROUTINE_UPDATE_EVENT,
  readStoredLifeRoutines,
  sanitizeLifeRoutineList,
  syncLifeRoutinesWithSupabase,
  type LifeRoutineConfig,
} from '../lib/lifeRoutines'
import {
  CURRENT_SESSION_EVENT_NAME,
  CURRENT_SESSION_STORAGE_KEY,
  HISTORY_EVENT_NAME,
  HISTORY_LIMIT,
  HISTORY_STORAGE_KEY,
  persistHistorySnapshot,
  readStoredHistory as readPersistedHistory,
  syncHistoryWithSupabase,
  type HistoryEntry,
} from '../lib/sessionHistory'

type FocusCandidate = {
  goalId: string
  goalName: string
  bucketId: string
  bucketName: string
  taskId: string
  taskName: string
  completed: boolean
  priority: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle
}

type FocusSource = {
  goalId: string | null
  bucketId: string | null
  goalName: string
  bucketName: string
  taskId: string | null
  taskDifficulty: FocusCandidate['difficulty'] | null
  priority: boolean | null
  goalSurface: SurfaceStyle | null
  bucketSurface: SurfaceStyle | null
}

type SessionMetadata = {
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalName: string | null
  bucketName: string | null
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle | null
  sessionKey: string | null
  taskLabel: string
}

const getNextDifficulty = (value: FocusCandidate['difficulty'] | null): FocusCandidate['difficulty'] => {
  switch (value) {
    case 'green':
      return 'yellow'
    case 'yellow':
      return 'red'
    case 'red':
      return 'none'
    case 'none':
    default:
      return 'green'
  }
}

const CURRENT_TASK_STORAGE_KEY = 'nc-taskwatch-current-task'
const CURRENT_TASK_SOURCE_KEY = 'nc-taskwatch-current-task-source'
const NOTEBOOK_STORAGE_KEY = 'nc-taskwatch-notebook'
const MAX_TASK_STORAGE_LENGTH = 256
const FOCUS_COMPLETION_RESET_DELAY_MS = 800
const PRIORITY_HOLD_MS = 300
const SNAPBACK_MARKER_DURATION_MS = 60000

const SNAPBACK_REASONS = [
  { id: 'tired' as const, label: 'Energy dip' },
  { id: 'distracted' as const, label: 'Lost focus' },
  { id: 'interrupted' as const, label: 'Interrupted' },
  { id: 'other' as const, label: 'Something else' },
]

const SNAPBACK_ACTIONS = [
  { id: 'resume' as const, label: 'Resume this focus' },
  { id: 'break' as const, label: 'Take a short break' },
  { id: 'switch' as const, label: 'Switch tasks' },
]

type SnapbackReasonId = (typeof SNAPBACK_REASONS)[number]['id']
type SnapbackActionId = (typeof SNAPBACK_ACTIONS)[number]['id']

const LIFE_ROUTINES_NAME = 'Life Routines'
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'
const makeSessionKey = (goalId: string | null, bucketId: string | null, taskId: string | null) =>
  goalId && bucketId ? `${goalId}::${bucketId}::${taskId ?? ''}` : null

const classNames = (...values: Array<string | false | null | undefined>): string =>
  values.filter(Boolean).join(' ')

const sanitizeDomIdSegment = (value: string): string => value.replace(/[^a-z0-9]/gi, '-')

const makeNotebookSubtaskInputId = (entryKey: string, subtaskId: string): string =>
  `taskwatch-subtask-${sanitizeDomIdSegment(entryKey)}-${sanitizeDomIdSegment(subtaskId)}`

const createEmptySessionMetadata = (taskLabel: string): SessionMetadata => ({
  goalId: null,
  bucketId: null,
  taskId: null,
  goalName: null,
  bucketName: null,
  goalSurface: DEFAULT_SURFACE_STYLE,
  bucketSurface: null,
  sessionKey: null,
  taskLabel,
})

declare global {
  interface Window {
    __ncSetElapsed?: (ms: number) => void
  }
}

const makeHistoryId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    console.warn('Failed to generate UUID, falling back to timestamp-based id', error)
  }

  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

type NotebookSubtask = {
  id: string
  text: string
  completed: boolean
}

type NotebookEntry = {
  notes: string
  subtasks: NotebookSubtask[]
}

type NotebookState = Record<string, NotebookEntry>

const createNotebookEntry = (overrides?: Partial<NotebookEntry>): NotebookEntry => ({
  notes: '',
  subtasks: [],
  ...overrides,
})

const sanitizeNotebookSubtasks = (value: unknown): NotebookSubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => {
      if (typeof item !== 'object' || item === null) {
        return null
      }
      const candidate = item as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      if (!id) {
        return null
      }
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      const completed = Boolean(candidate.completed)
      return { id, text, completed }
    })
    .filter((item): item is NotebookSubtask => Boolean(item))
}

const sanitizeNotebookEntry = (value: unknown): NotebookEntry => {
  if (typeof value !== 'object' || value === null) {
    return createNotebookEntry()
  }
  const candidate = value as Record<string, unknown>
  const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
  const subtasks = sanitizeNotebookSubtasks(candidate.subtasks)
  return { notes, subtasks }
}

const sanitizeNotebookState = (value: unknown): NotebookState => {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const next: NotebookState = {}
  entries.forEach(([key, entry]) => {
    if (typeof key !== 'string') {
      return
    }
    next[key] = sanitizeNotebookEntry(entry)
  })
  return next
}

const shouldPersistNotebookEntry = (entry: NotebookEntry): boolean =>
  entry.notes.trim().length > 0 || entry.subtasks.length > 0

const createNotebookSubtaskId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    // ignore
  }
  return `notebook-subtask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const createNotebookEmptySubtask = () => ({ id: createNotebookSubtaskId(), text: '', completed: false })

const computeNotebookKey = (focusSource: FocusSource | null, taskName: string): string => {
  if (focusSource?.taskId) {
    return `task:${focusSource.taskId}`
  }
  const trimmed = taskName.trim()
  if (focusSource?.goalId) {
    const goalPart = focusSource.goalId
    const bucketPart = focusSource.bucketId ?? 'none'
    if (trimmed.length > 0) {
      return `source:${goalPart}:${bucketPart}:${trimmed.toLowerCase()}`
    }
    return `source:${goalPart}:${bucketPart}:scratch`
  }
  if (trimmed.length > 0) {
    return `custom:${trimmed.toLowerCase()}`
  }
  return 'scratchpad'
}

const historiesAreEqual = (a: HistoryEntry[], b: HistoryEntry[]): boolean => {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id ||
      left.taskName !== right.taskName ||
      left.elapsed !== right.elapsed ||
      left.startedAt !== right.startedAt ||
      left.endedAt !== right.endedAt ||
      left.goalName !== right.goalName ||
      left.bucketName !== right.bucketName ||
      left.goalId !== right.goalId ||
      left.bucketId !== right.bucketId ||
      left.taskId !== right.taskId ||
      left.goalSurface !== right.goalSurface ||
      left.bucketSurface !== right.bucketSurface
    ) {
      return false
    }
  }
  return true
}

const getStoredTaskName = (): string => {
  if (typeof window === 'undefined') {
    return 'New Task'
  }

  const stored = window.localStorage.getItem(CURRENT_TASK_STORAGE_KEY)
  if (!stored) {
    return 'New Task'
  }

  const trimmed = stored.trim()
  if (trimmed.length === 0) {
    return ''
  }
  return trimmed.slice(0, MAX_TASK_STORAGE_LENGTH)
}

const readStoredFocusSource = (): FocusSource | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(CURRENT_TASK_SOURCE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const candidate = parsed as Record<string, unknown>
    const goalId = typeof candidate.goalId === 'string' ? candidate.goalId : null
    const bucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
    const goalName =
      typeof candidate.goalName === 'string' && candidate.goalName.trim().length > 0
        ? candidate.goalName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
        : ''
    const bucketName =
      typeof candidate.bucketName === 'string' && candidate.bucketName.trim().length > 0
        ? candidate.bucketName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
        : ''
    if (!goalName || !bucketName) {
      return null
    }
    const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : null
    const rawDifficulty = typeof candidate.taskDifficulty === 'string' ? candidate.taskDifficulty : null
    const taskDifficulty =
      rawDifficulty === 'green' || rawDifficulty === 'yellow' || rawDifficulty === 'red' || rawDifficulty === 'none'
        ? rawDifficulty
        : null
    const priority =
      typeof candidate.priority === 'boolean'
        ? candidate.priority
        : typeof candidate.priority === 'string'
          ? candidate.priority === 'true'
          : null
    const goalSurface = sanitizeSurfaceStyle(candidate.goalSurface)
    const bucketSurface = sanitizeSurfaceStyle(candidate.bucketSurface)
    return {
      goalId,
      bucketId,
      goalName,
      bucketName,
      taskId,
      taskDifficulty,
      priority,
      goalSurface,
      bucketSurface,
    }
  } catch {
    return null
  }
}

const formatTime = (milliseconds: number) => {
  const totalMs = Math.max(0, Math.floor(milliseconds))
  const days = Math.floor(totalMs / 86_400_000)
  const hours = Math.floor((totalMs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1_000)
  const centiseconds = Math.floor((totalMs % 1_000) / 10)

  const segments: string[] = []

  if (days > 0) {
    segments.push(`${days}D`)
    segments.push(hours.toString().padStart(2, '0'))
  } else if (hours > 0) {
    segments.push(hours.toString().padStart(2, '0'))
  }

  segments.push(minutes.toString().padStart(2, '0'))
  segments.push(seconds.toString().padStart(2, '0'))

  const timeCore = segments.join(':')
  const fraction = centiseconds.toString().padStart(2, '0')

  return `${timeCore}.${fraction}`
}

const formatClockTime = (timestamp: number) => {
  const date = new Date(timestamp)
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12

  return `${hours12.toString().padStart(2, '0')}:${minutes}:${seconds} ${period}`
}

export type TaskwatchPageProps = {
  viewportWidth: number
}

export function TaskwatchPage({ viewportWidth: _viewportWidth }: TaskwatchPageProps) {
  const initialTaskName = useMemo(() => getStoredTaskName(), [])
  const [elapsed, setElapsed] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [isTimeHidden, setIsTimeHidden] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
  const latestHistoryRef = useRef(history)
  const applyLocalHistoryChange = useCallback(
    (updater: (current: HistoryEntry[]) => HistoryEntry[]) => {
      setHistory((current) => {
        const next = updater(current)
        if (historiesAreEqual(current, next)) {
          return current
        }
        return persistHistorySnapshot(next)
      })
    },
    [],
  )
  const [lastSnapbackSummary, setLastSnapbackSummary] = useState<string | null>(null)
  const [isSnapbackOpen, setIsSnapbackOpen] = useState(false)
  const [snapbackReason, setSnapbackReason] = useState<SnapbackReasonId>('tired')
  const [snapbackNextAction, setSnapbackNextAction] = useState<SnapbackActionId>('resume')
  const [snapbackNote, setSnapbackNote] = useState('')
  const [currentTaskName, setCurrentTaskName] = useState<string>(initialTaskName)
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [notebookState, setNotebookState] = useState<NotebookState>(() => {
    if (typeof window === 'undefined') {
      return {}
    }
    try {
      const raw = window.localStorage.getItem(NOTEBOOK_STORAGE_KEY)
      if (!raw) {
        return {}
      }
      const parsed = JSON.parse(raw)
      return sanitizeNotebookState(parsed)
    } catch {
      return {}
    }
  })
  const frameRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)
  const selectorButtonRef = useRef<HTMLButtonElement | null>(null)
  const selectorPopoverRef = useRef<HTMLDivElement | null>(null)
  const focusTaskContainerRef = useRef<HTMLDivElement | null>(null)
  const focusCompleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const focusCompletionTimeoutRef = useRef<number | null>(null)
  const focusPriorityHoldTimerRef = useRef<number | null>(null)
  const focusPriorityHoldTriggeredRef = useRef(false)
  const snapbackDialogRef = useRef<HTMLDivElement | null>(null)
  const focusContextRef = useRef<{
    goalId: string | null
    bucketId: string | null
    taskId: string | null
    sessionKey: string | null
    goalName: string | null
    bucketName: string | null
    goalSurface: SurfaceStyle
    bucketSurface: SurfaceStyle | null
  }>({
    goalId: null,
    bucketId: null,
    taskId: null,
    sessionKey: null,
    goalName: null,
    bucketName: null,
    goalSurface: DEFAULT_SURFACE_STYLE,
    bucketSurface: null,
  })
  const currentSessionKeyRef = useRef<string | null>(null)
  const lastLoggedSessionKeyRef = useRef<string | null>(null)
  const [isSelectorOpen, setIsSelectorOpen] = useState(false)
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => readStoredGoalsSnapshot())
  const activeGoalSnapshots = useMemo(
    () => goalsSnapshot.filter((goal) => !goal.archived),
    [goalsSnapshot],
  )
  const [hasRequestedGoals, setHasRequestedGoals] = useState(false)
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(() => new Set())
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(() => new Set())
  const [lifeRoutinesExpanded, setLifeRoutinesExpanded] = useState(false)
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const lifeRoutineBucketIds = useMemo(
    () => new Set(lifeRoutineTasks.map((task) => task.bucketId)),
    [lifeRoutineTasks],
  )
  const [focusSource, setFocusSource] = useState<FocusSource | null>(() => readStoredFocusSource())
  const [customTaskDraft, setCustomTaskDraft] = useState('')
  const [isCompletingFocus, setIsCompletingFocus] = useState(false)
  void _viewportWidth

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const synced = await syncLifeRoutinesWithSupabase()
      if (!cancelled && synced) {
        setLifeRoutineTasks((current) =>
          JSON.stringify(current) === JSON.stringify(synced) ? current : synced,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setCurrentTime(Date.now())
    if (typeof window === 'undefined') return

    const intervalId = window.setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIFE_ROUTINE_STORAGE_KEY) {
        setLifeRoutineTasks(readStoredLifeRoutines())
      }
    }
    const handleUpdate = (event: Event) => {
      if (event instanceof CustomEvent) {
        setLifeRoutineTasks(sanitizeLifeRoutineList(event.detail))
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate as EventListener)
    }
  }, [])

  useEffect(() => {
    latestHistoryRef.current = history
  }, [history])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const synced = await syncHistoryWithSupabase()
      if (cancelled || !synced) {
        return
      }
      setHistory((current) => (historiesAreEqual(current, synced) ? current : synced))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const applyIncomingHistory = (incoming: HistoryEntry[]) => {
      const next = incoming.slice(0, HISTORY_LIMIT)
      if (!historiesAreEqual(latestHistoryRef.current, next)) {
        setHistory(next)
      }
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== HISTORY_STORAGE_KEY) {
        return
      }
      try {
        const next = readPersistedHistory()
        applyIncomingHistory(next)
      } catch (error) {
        console.warn('Failed to sync stopwatch history from storage', error)
      }
    }

    const handleHistoryBroadcast = () => {
      const next = readPersistedHistory()
      applyIncomingHistory(next)
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.localStorage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(notebookState))
    } catch (error) {
      console.warn('Failed to persist Taskwatch notebook state', error)
    }
  }, [notebookState])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const trimmed = currentTaskName.trim()
    const value = trimmed.length > 0 ? trimmed : ''

    try {
      window.localStorage.setItem(CURRENT_TASK_STORAGE_KEY, value)
    } catch (error) {
      console.warn('Failed to persist current task name', error)
    }
  }, [currentTaskName])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (focusSource) {
        window.localStorage.setItem(CURRENT_TASK_SOURCE_KEY, JSON.stringify(focusSource))
      } else {
        window.localStorage.removeItem(CURRENT_TASK_SOURCE_KEY)
      }
    } catch (error) {
      console.warn('Failed to persist current task source', error)
    }
  }, [focusSource])

  useEffect(() => {
    if (!isRunning) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      lastTickRef.current = null
      return
    }

    const update = (timestamp: number) => {
      if (lastTickRef.current === null) {
        lastTickRef.current = timestamp
      }
      const delta = timestamp - lastTickRef.current
      lastTickRef.current = timestamp
      setElapsed((prev) => prev + delta)
      frameRef.current = requestAnimationFrame(update)
    }

    frameRef.current = requestAnimationFrame(update)

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [isRunning])

  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return

    window.__ncSetElapsed = (ms: number) => {
      setIsRunning(false)
      const safeElapsed = Math.max(0, Math.floor(ms))
      setElapsed(safeElapsed)
      const now = Date.now()
      setSessionStart(now - safeElapsed)
      lastTickRef.current = null
    }

    return () => {
      delete window.__ncSetElapsed
    }
  }, [])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (focusCompletionTimeoutRef.current !== null) {
        window.clearTimeout(focusCompletionTimeoutRef.current)
        focusCompletionTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToGoalsSnapshot((snapshot) => {
      setGoalsSnapshot(snapshot)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (goalsSnapshot.length > 0 || hasRequestedGoals) {
      return
    }
    let cancelled = false
    setHasRequestedGoals(true)
    ;(async () => {
      try {
        const result = await fetchGoalsHierarchy()
        if (cancelled || !result || !Array.isArray(result.goals)) {
          return
        }
        const snapshot = createGoalsSnapshot(result.goals)
        setGoalsSnapshot(snapshot)
        publishGoalsSnapshot(snapshot)
      } catch {
        // Ignore offline or auth failures; fall back to stored snapshot.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [goalsSnapshot.length, hasRequestedGoals])

  useEffect(() => {
    if (!isSelectorOpen || typeof window === 'undefined') {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const withinFocusTask = focusTaskContainerRef.current?.contains(target) ?? false
      const withinPopover = selectorPopoverRef.current?.contains(target) ?? false
      if (withinFocusTask || withinPopover) {
        return
      }
      setIsSelectorOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsSelectorOpen(false)
        selectorButtonRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSelectorOpen])

  const normalizedCurrentTask = useMemo(() => currentTaskName.trim(), [currentTaskName])
  const safeTaskName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
  const sessionMetadataRef = useRef<SessionMetadata>(createEmptySessionMetadata(safeTaskName))
  const elapsedSeconds = Math.floor(elapsed / 1000)

  useEffect(() => {
    if (!isRunning) {
      sessionMetadataRef.current = {
        ...sessionMetadataRef.current,
        taskLabel: safeTaskName,
      }
    }
  }, [isRunning, safeTaskName])

  const focusCandidates = useMemo<FocusCandidate[]>(() => {
    const candidates: FocusCandidate[] = []
    activeGoalSnapshots.forEach((goal) => {
      goal.buckets
        .filter((bucket) => !bucket.archived)
        .forEach((bucket) => {
          bucket.tasks.forEach((task) => {
            candidates.push({
            goalId: goal.id,
            goalName: goal.name,
            bucketId: bucket.id,
            bucketName: bucket.name,
            taskId: task.id,
            taskName: task.text,
            completed: task.completed,
            priority: task.priority,
            difficulty: task.difficulty,
            goalSurface: goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
            bucketSurface: bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
          })
        })
        })
    })
    return candidates
  }, [activeGoalSnapshots])

  const priorityTasks = useMemo(
    () => focusCandidates.filter((candidate) => candidate.priority && !candidate.completed),
    [focusCandidates],
  )

  const activeFocusCandidate = useMemo(() => {
    if (!focusSource) {
      return null
    }
    if (focusSource.taskId) {
      const byId = focusCandidates.find((candidate) => candidate.taskId === focusSource.taskId)
      if (byId) {
        return byId
      }
    }
    if (focusSource.goalId && focusSource.bucketId) {
      const lower = normalizedCurrentTask.toLocaleLowerCase()
      const byMatch = focusCandidates.find(
        (candidate) =>
          candidate.goalId === focusSource.goalId &&
          candidate.bucketId === focusSource.bucketId &&
          candidate.taskName.trim().toLocaleLowerCase() === lower,
      )
      if (byMatch) {
        return byMatch
      }
    }
    return null
  }, [focusCandidates, focusSource, normalizedCurrentTask])

  const currentSessionMeta = sessionMetadataRef.current
  const sessionGoalName =
    isRunning || elapsed > 0
      ? currentSessionMeta.goalName
      : focusSource?.goalName?.trim() || null
  const sessionBucketName =
    isRunning || elapsed > 0
      ? currentSessionMeta.bucketName
      : focusSource?.bucketName?.trim() || null
  const sessionTaskLabel =
    normalizedCurrentTask.length > 0
      ? normalizedCurrentTask
      : sessionGoalName
        ? sessionGoalName
        : ''
  const rawSessionGoalSurface =
    isRunning || elapsed > 0
      ? currentSessionMeta.goalSurface
      : focusSource?.goalSurface ?? activeFocusCandidate?.goalSurface ?? DEFAULT_SURFACE_STYLE
  const sessionGoalSurface = ensureSurfaceStyle(rawSessionGoalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE)
  const rawSessionBucketSurface =
    isRunning || elapsed > 0
      ? currentSessionMeta.bucketSurface
      : focusSource?.bucketSurface ?? activeFocusCandidate?.bucketSurface ?? null
  const sessionBucketSurface =
    rawSessionBucketSurface !== null && rawSessionBucketSurface !== undefined
      ? ensureSurfaceStyle(rawSessionBucketSurface, DEFAULT_SURFACE_STYLE)
      : null
  const sessionGoalId =
    isRunning || elapsed > 0
      ? currentSessionMeta.goalId
      : focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
  const sessionBucketId =
    isRunning || elapsed > 0
      ? currentSessionMeta.bucketId
      : focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
  const sessionTaskId =
    isRunning || elapsed > 0
      ? currentSessionMeta.taskId
      : focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
  const deriveSessionMetadata = useCallback((): SessionMetadata => {
    const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const bucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const taskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const goalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
    const bucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
    const goalSurfaceSource =
      focusSource?.goalSurface ?? activeFocusCandidate?.goalSurface ?? DEFAULT_SURFACE_STYLE
    const goalSurface = ensureSurfaceStyle(goalSurfaceSource ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE)
    const bucketSurfaceSource = focusSource?.bucketSurface ?? activeFocusCandidate?.bucketSurface ?? null
    const bucketSurface =
      bucketSurfaceSource !== null && bucketSurfaceSource !== undefined
        ? ensureSurfaceStyle(bucketSurfaceSource, DEFAULT_SURFACE_STYLE)
        : null
    const sessionKey = makeSessionKey(goalId, bucketId, taskId)
    return {
      goalId,
      bucketId,
      taskId,
      goalName,
      bucketName,
      goalSurface,
      bucketSurface,
      sessionKey,
      taskLabel: safeTaskName,
    }
  }, [activeFocusCandidate, focusSource, safeTaskName])

  const effectiveGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
  const effectiveBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
  const effectiveGoalSurface =
    focusSource?.goalSurface ?? activeFocusCandidate?.goalSurface ?? DEFAULT_SURFACE_STYLE
  const effectiveBucketSurface =
    focusSource?.bucketSurface ?? activeFocusCandidate?.bucketSurface ?? null
  const isLifeRoutineFocus =
    (focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null) === LIFE_ROUTINES_GOAL_ID
  const focusSurfaceClasses = useMemo(() => {
    if (isLifeRoutineFocus && effectiveBucketSurface) {
      return ['surface-life-routine', `surface-life-routine--${effectiveBucketSurface}`]
    }
    return []
  }, [effectiveBucketSurface, isLifeRoutineFocus])
  const notebookKey = useMemo(
    () => computeNotebookKey(focusSource, normalizedCurrentTask),
    [focusSource, normalizedCurrentTask],
  )
  const updateNotebookForKey = useCallback(
    (key: string, updater: (entry: NotebookEntry) => NotebookEntry) => {
      setNotebookState((current) => {
        const previous = current[key] ?? createNotebookEntry()
        const updated = sanitizeNotebookEntry(updater(previous))
        if (!shouldPersistNotebookEntry(updated)) {
          if (!current[key]) {
            return current
          }
          const { [key]: _removed, ...rest } = current
          return rest
        }
        const existing = current[key]
        if (existing) {
          const sameNotes = existing.notes === updated.notes
          const sameLength = existing.subtasks.length === updated.subtasks.length
          const sameSubtasks =
            sameLength &&
            existing.subtasks.every((subtask, index) => {
              const candidate = updated.subtasks[index]
              return (
                candidate &&
                candidate.id === subtask.id &&
                candidate.text === subtask.text &&
                candidate.completed === subtask.completed
              )
            })
          if (sameNotes && sameSubtasks) {
            return current
          }
        }
        return { ...current, [key]: updated }
      })
    },
    [],
  )
  const activeNotebookEntry = useMemo(
    () => notebookState[notebookKey] ?? createNotebookEntry(),
    [notebookState, notebookKey],
  )
  const notebookNotes = activeNotebookEntry.notes
  const notebookSubtasks = activeNotebookEntry.subtasks
  const completedNotebookSubtasks = useMemo(
    () => notebookSubtasks.filter((subtask) => subtask.completed).length,
    [notebookSubtasks],
  )
  const subtaskProgressLabel = notebookSubtasks.length > 0 ? `${completedNotebookSubtasks}/${notebookSubtasks.length}` : null
  const hasNotebookContent = notebookNotes.trim().length > 0 || notebookSubtasks.length > 0
  const notesFieldId = useMemo(() => {
    const safeKey = notebookKey.replace(/[^a-z0-9-]/gi, '-') || 'scratchpad'
    return `taskwatch-notes-${safeKey}`
  }, [notebookKey])
  const focusContextLabel = useMemo(() => {
    const parts: string[] = []
    if (effectiveGoalName) {
      parts.push(effectiveGoalName)
    }
    if (effectiveBucketName) {
      parts.push(effectiveBucketName)
    }
    if (parts.length === 0) {
      return 'No linked goal'
    }
    return parts.join(' → ')
  }, [effectiveGoalName, effectiveBucketName])
  const handleNotebookNotesChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value
      updateNotebookForKey(notebookKey, (entry) => (entry.notes === value ? entry : { ...entry, notes: value }))
    },
    [notebookKey, updateNotebookForKey],
  )
  const pendingNotebookSubtaskFocusRef = useRef<{ notebookKey: string; subtaskId: string } | null>(null)
  const handleAddNotebookSubtask = useCallback(
    (options?: { focus?: boolean }) => {
      const newSubtask = createNotebookEmptySubtask()
      updateNotebookForKey(notebookKey, (entry) => ({
        ...entry,
        subtasks: [...entry.subtasks, newSubtask],
      }))
      if (options?.focus) {
        pendingNotebookSubtaskFocusRef.current = { notebookKey, subtaskId: newSubtask.id }
      }
    },
    [notebookKey, updateNotebookForKey],
  )
  useEffect(() => {
    const pending = pendingNotebookSubtaskFocusRef.current
    if (!pending || pending.notebookKey !== notebookKey) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const inputId = makeNotebookSubtaskInputId(notebookKey, pending.subtaskId)
    let attempts = 0
    const tryFocus = () => {
      const input = document.getElementById(inputId) as HTMLInputElement | null
      if (input) {
        input.focus()
        input.select()
        pendingNotebookSubtaskFocusRef.current = null
        return
      }
      if (typeof window.requestAnimationFrame === 'function' && attempts < 2) {
        attempts += 1
        window.requestAnimationFrame(tryFocus)
      } else {
        pendingNotebookSubtaskFocusRef.current = null
      }
    }
    tryFocus()
  }, [notebookKey, notebookSubtasks])
  const handleNotebookSubtaskTextChange = useCallback(
    (subtaskId: string, value: string) => {
      updateNotebookForKey(notebookKey, (entry) => {
        const index = entry.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return entry
        }
        const target = entry.subtasks[index]
        if (!target || target.text === value) {
          return entry
        }
        const nextSubtasks = entry.subtasks.map((item, idx) =>
          idx === index ? { ...item, text: value } : item,
        )
        return { ...entry, subtasks: nextSubtasks }
      })
    },
    [notebookKey, updateNotebookForKey],
  )
  const handleNotebookSubtaskBlur = useCallback(
    (subtaskId: string) => {
      updateNotebookForKey(notebookKey, (entry) => {
        const target = entry.subtasks.find((item) => item.id === subtaskId)
        if (!target || target.text.trim().length > 0) {
          return entry
        }
        const nextSubtasks = entry.subtasks.filter((item) => item.id !== subtaskId)
        return nextSubtasks.length === entry.subtasks.length ? entry : { ...entry, subtasks: nextSubtasks }
      })
    },
    [notebookKey, updateNotebookForKey],
  )
  const handleNotebookSubtaskToggle = useCallback(
    (subtaskId: string) => {
      updateNotebookForKey(notebookKey, (entry) => {
        const index = entry.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return entry
        }
        const nextSubtasks = entry.subtasks.map((item, idx) =>
          idx === index ? { ...item, completed: !item.completed } : item,
        )
        return { ...entry, subtasks: nextSubtasks }
      })
    },
    [notebookKey, updateNotebookForKey],
  )
  const handleNotebookSubtaskRemove = useCallback(
    (subtaskId: string) => {
      updateNotebookForKey(notebookKey, (entry) => {
        const nextSubtasks = entry.subtasks.filter((item) => item.id !== subtaskId)
        if (nextSubtasks.length === entry.subtasks.length) {
          return entry
        }
        return { ...entry, subtasks: nextSubtasks }
      })
    },
    [notebookKey, updateNotebookForKey],
  )
  const handleNotebookClear = useCallback(() => {
    updateNotebookForKey(notebookKey, () => createNotebookEntry())
  }, [notebookKey, updateNotebookForKey])


  useEffect(() => {
    const contextGoalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const contextBucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const contextTaskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const sessionKey = makeSessionKey(contextGoalId, contextBucketId, contextTaskId)
    focusContextRef.current = {
      goalId: contextGoalId,
      bucketId: contextBucketId,
      taskId: contextTaskId,
      sessionKey,
      goalName: effectiveGoalName,
      bucketName: effectiveBucketName,
      goalSurface: effectiveGoalSurface,
      bucketSurface: effectiveBucketSurface,
    }
  }, [
    focusSource,
    activeFocusCandidate,
    effectiveGoalName,
    effectiveBucketName,
    effectiveGoalSurface,
    effectiveBucketSurface,
  ])

  useEffect(() => {
    setFocusSource((current) => {
      if (!current) {
        return current
      }
      if (!current.goalId) {
        return current
      }
      const goal = goalsSnapshot.find((g) => g.id === current.goalId)
      if (!goal) {
        return null
      }
      const bucket = current.bucketId ? goal.buckets.find((b) => b.id === current.bucketId) : null
      if (bucket && bucket.archived) {
        return null
      }
      if (current.bucketId && !bucket) {
        return null
      }
      const candidate = activeFocusCandidate
      let nextGoalName = current.goalName
      let nextBucketName = current.bucketName
      let nextGoalSurface: SurfaceStyle | null =
        current.goalSurface ?? goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE
      let nextBucketSurface: SurfaceStyle | null =
        current.bucketSurface ?? bucket?.surfaceStyle ?? null
      let nextTaskId = current.taskId
      let nextTaskDifficulty = current.taskDifficulty
      let nextPriority = current.priority
      let changed = false
      if (goal.name !== current.goalName) {
        nextGoalName = goal.name
        changed = true
      }
      if ((goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE) !== nextGoalSurface) {
        nextGoalSurface = goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE
        changed = true
      }
      if (bucket) {
        if (bucket.name !== current.bucketName) {
          nextBucketName = bucket.name
          changed = true
        }
        const bucketSurfaceValue = bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE
        if (bucketSurfaceValue !== nextBucketSurface) {
          nextBucketSurface = bucketSurfaceValue
          changed = true
        }
      } else if (current.bucketSurface !== null) {
        nextBucketSurface = null
        changed = true
      }
      if (candidate) {
        if (candidate.taskId !== current.taskId) {
          nextTaskId = candidate.taskId
          changed = true
        }
        if (candidate.difficulty !== current.taskDifficulty) {
          nextTaskDifficulty = candidate.difficulty
          changed = true
        }
        if (candidate.priority !== current.priority) {
          nextPriority = candidate.priority
          changed = true
        }
      }
      if (!changed) {
        return current
      }
      return {
        ...current,
        goalName: nextGoalName,
        bucketName: nextBucketName,
        taskId: nextTaskId,
        taskDifficulty: nextTaskDifficulty,
        priority: nextPriority,
        goalSurface: nextGoalSurface,
        bucketSurface: nextBucketSurface,
      }
    })
  }, [activeFocusCandidate, goalsSnapshot])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const hasActiveSession = isRunning || elapsed > 0
    if (!hasActiveSession) {
      try {
        window.localStorage.removeItem(CURRENT_SESSION_STORAGE_KEY)
      } catch (error) {
        console.warn('Failed to clear active session state', error)
      }
      try {
        const event = new CustomEvent(CURRENT_SESSION_EVENT_NAME, { detail: null })
        window.dispatchEvent(event)
      } catch {
        // ignore dispatch errors
      }
      return
    }

    const payload = {
      taskName: sessionTaskLabel,
      goalName: sessionGoalName,
      bucketName: sessionBucketName,
      startedAt: sessionStart,
      baseElapsed: elapsed,
      isRunning,
      goalId: sessionGoalId,
      bucketId: sessionBucketId,
      taskId: sessionTaskId,
      goalSurface: sessionGoalSurface,
      bucketSurface: sessionBucketSurface,
      updatedAt: Date.now(),
    }

    try {
      window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, JSON.stringify(payload))
    } catch (error) {
      console.warn('Failed to persist active session state', error)
    }

    try {
      const event = new CustomEvent(CURRENT_SESSION_EVENT_NAME, { detail: payload })
      window.dispatchEvent(event)
    } catch {
      // ignore dispatch errors
    }
  }, [
    isRunning,
    elapsedSeconds,
    sessionStart,
    sessionTaskLabel,
    sessionGoalName,
    sessionBucketName,
    sessionGoalId,
    sessionBucketId,
    sessionTaskId,
    sessionGoalSurface,
    sessionBucketSurface,
  ])

  useEffect(() => {
    if (activeGoalSnapshots.length === 0) {
      setExpandedGoals(new Set())
      setExpandedBuckets(new Set())
      return
    }
    setExpandedGoals((current) => {
      const validGoalIds = new Set(activeGoalSnapshots.map((goal) => goal.id))
      const next = new Set<string>()
      current.forEach((id) => {
        if (validGoalIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })
    setExpandedBuckets((current) => {
      const validBucketIds = new Set(
        activeGoalSnapshots.flatMap((goal) =>
          goal.buckets.filter((bucket) => !bucket.archived).map((bucket) => bucket.id),
        ),
      )
      const next = new Set<string>()
      current.forEach((id) => {
        if (validBucketIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })
  }, [activeGoalSnapshots])

  const currentTaskLower = normalizedCurrentTask.toLocaleLowerCase()
  const isDefaultTask = normalizedCurrentTask.length === 0
  const focusDifficulty =
    focusSource?.taskDifficulty ?? activeFocusCandidate?.difficulty ?? null
  const focusPriority = focusSource?.priority ?? activeFocusCandidate?.priority ?? false
  const focusGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
  const focusBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
  const effectiveTaskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
  const effectiveGoalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
  const effectiveBucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
  const canCompleteFocus = Boolean(effectiveTaskId && effectiveBucketId && effectiveGoalId) && !isCompletingFocus
  const focusDiffClass =
    focusDifficulty === 'green'
      ? 'goal-task-row--diff-green'
      : focusDifficulty === 'yellow'
      ? 'goal-task-row--diff-yellow'
      : focusDifficulty === 'red'
      ? 'goal-task-row--diff-red'
      : ''
  const canCycleFocusDifficulty = Boolean(effectiveTaskId && effectiveGoalId && effectiveBucketId)
  const focusDiffButtonClass = [
    'goal-task-diff',
    focusDifficulty && focusDifficulty !== 'none' ? `goal-task-diff--${focusDifficulty}` : '',
    'focus-task__diff-chip',
  ]
    .filter(Boolean)
    .join(' ')
  const canToggleFocusPriority = Boolean(effectiveTaskId && effectiveGoalId && effectiveBucketId)
  const focusDifficultyDescriptor = focusDifficulty && focusDifficulty !== 'none' ? focusDifficulty : 'none'
  const focusDiffButtonTitle = !canToggleFocusPriority
    ? `Cycle task difficulty (current ${focusDifficultyDescriptor})`
    : focusPriority
    ? `Tap to cycle difficulty (current ${focusDifficultyDescriptor}) • Hold ~300ms to remove priority`
    : `Tap to cycle difficulty (current ${focusDifficultyDescriptor}) • Hold ~300ms to mark as priority`

  const toggleGoalExpansion = (goalId: string) => {
    const isExpanded = expandedGoals.has(goalId)
    setExpandedGoals((current) => {
      const next = new Set(current)
      if (isExpanded) {
        next.delete(goalId)
      } else {
        next.add(goalId)
      }
      return next
    })
    if (isExpanded) {
      const goal = goalsSnapshot.find((g) => g.id === goalId)
      if (goal) {
        setExpandedBuckets((current) => {
          const next = new Set(current)
          goal.buckets.forEach((bucket) => next.delete(bucket.id))
          return next
        })
      }
    }
  }

  const toggleBucketExpansion = (bucketId: string) => {
    setExpandedBuckets((current) => {
      const next = new Set(current)
      if (next.has(bucketId)) {
        next.delete(bucketId)
      } else {
        next.add(bucketId)
      }
      return next
    })
  }

  const handleToggleSelector = () => {
    setIsSelectorOpen((open) => {
      if (open) {
        return false
      }
      setCustomTaskDraft(normalizedCurrentTask)
      return true
    })
  }

  const cycleFocusDifficulty = useCallback(() => {
    if (!canCycleFocusDifficulty || !effectiveGoalId || !effectiveBucketId || !effectiveTaskId) {
      return
    }
    const nextDifficulty = getNextDifficulty(focusDifficulty ?? 'none')
    setGoalsSnapshot((current) => {
      let mutated = false
      const updated = current.map((goal) => {
        if (goal.id !== effectiveGoalId) {
          return goal
        }
        const updatedBuckets = goal.buckets.map((bucket) => {
          if (bucket.id !== effectiveBucketId) {
            return bucket
          }
          const updatedTasks = bucket.tasks.map((task) => {
            if (task.id !== effectiveTaskId) {
              return task
            }
            mutated = true
            return { ...task, difficulty: nextDifficulty }
          })
          return { ...bucket, tasks: updatedTasks }
        })
        return { ...goal, buckets: updatedBuckets }
      })
      if (mutated) {
        publishGoalsSnapshot(updated)
        return updated
      }
      return current
    })
    setFocusSource((current) => {
      if (!current || current.taskId !== effectiveTaskId) {
        return current
      }
      return {
        ...current,
        taskDifficulty: nextDifficulty,
      }
    })
    setTaskDifficulty(effectiveTaskId, nextDifficulty).catch((error) => {
      console.warn('Failed to update focus task difficulty', error)
    })
  }, [
    canCycleFocusDifficulty,
    effectiveGoalId,
    effectiveBucketId,
    effectiveTaskId,
    focusDifficulty,
  ])

  const toggleFocusPriority = useCallback(() => {
    if (!canToggleFocusPriority || !effectiveGoalId || !effectiveBucketId || !effectiveTaskId) {
      return
    }
    const snapshotTask = goalsSnapshot
      .find((goal) => goal.id === effectiveGoalId)?.buckets
      .find((bucket) => bucket.id === effectiveBucketId)?.tasks
      .find((task) => task.id === effectiveTaskId) ?? null
    const wasCompleted = snapshotTask?.completed ?? false
    const nextPriority = !focusPriority
    setGoalsSnapshot((current) => {
      let mutated = false
      const updated = current.map((goal) => {
        if (goal.id !== effectiveGoalId) {
          return goal
        }
        let goalMutated = false
        const updatedBuckets = goal.buckets.map((bucket) => {
          if (bucket.id !== effectiveBucketId) {
            return bucket
          }
          const idx = bucket.tasks.findIndex((task) => task.id === effectiveTaskId)
          if (idx === -1) {
            return bucket
          }
          goalMutated = true
          mutated = true
          let updatedTasks = bucket.tasks.map((task, index) =>
            index === idx ? { ...task, priority: nextPriority } : task,
          )
          const moved = updatedTasks.find((task) => task.id === effectiveTaskId)!
          const active = updatedTasks.filter((task) => !task.completed)
          const completed = updatedTasks.filter((task) => task.completed)
          if (nextPriority) {
            if (!moved.completed) {
              const without = active.filter((task) => task.id !== effectiveTaskId)
              const newActive = [moved, ...without]
              updatedTasks = [...newActive, ...completed]
            } else {
              const without = completed.filter((task) => task.id !== effectiveTaskId)
              const newCompleted = [moved, ...without]
              updatedTasks = [...active, ...newCompleted]
            }
          } else {
            if (!moved.completed) {
              const prios = active.filter((task) => task.priority)
              const non = active.filter((task) => !task.priority && task.id !== effectiveTaskId)
              const newActive = [...prios, moved, ...non]
              updatedTasks = [...newActive, ...completed]
            } else {
              const prios = completed.filter((task) => task.priority)
              const non = completed.filter((task) => !task.priority && task.id !== effectiveTaskId)
              const newCompleted = [...prios, moved, ...non]
              updatedTasks = [...active, ...newCompleted]
            }
          }
          return { ...bucket, tasks: updatedTasks }
        })
        return goalMutated ? { ...goal, buckets: updatedBuckets } : goal
      })
      if (mutated) {
        publishGoalsSnapshot(updated)
        return updated
      }
      return current
    })
    setFocusSource((current) => {
      if (!current || current.taskId !== effectiveTaskId) {
        return current
      }
      return {
        ...current,
        priority: nextPriority,
      }
    })
    setTaskPriorityAndResort(effectiveTaskId, effectiveBucketId, wasCompleted, nextPriority).catch((error) => {
      console.warn('Failed to update focus task priority', error)
    })
  }, [
    canToggleFocusPriority,
    effectiveGoalId,
    effectiveBucketId,
    effectiveTaskId,
    focusPriority,
    goalsSnapshot,
  ])

  const clearPriorityHoldTimer = useCallback(() => {
    if (focusPriorityHoldTimerRef.current !== null) {
      if (typeof window !== 'undefined') {
        window.clearTimeout(focusPriorityHoldTimerRef.current)
      }
      focusPriorityHoldTimerRef.current = null
    }
  }, [])

  const handleDifficultyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!canCycleFocusDifficulty) {
        return
      }
      focusPriorityHoldTriggeredRef.current = false
      clearPriorityHoldTimer()
      if (canToggleFocusPriority && typeof window !== 'undefined') {
        try {
          focusPriorityHoldTimerRef.current = window.setTimeout(() => {
            focusPriorityHoldTriggeredRef.current = true
            focusPriorityHoldTimerRef.current = null
            toggleFocusPriority()
          }, PRIORITY_HOLD_MS)
        } catch (error) {
          focusPriorityHoldTimerRef.current = null
        }
      }
    },
    [canCycleFocusDifficulty, canToggleFocusPriority, clearPriorityHoldTimer, toggleFocusPriority],
  )

  const handleDifficultyPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      const wasTriggered = focusPriorityHoldTriggeredRef.current
      clearPriorityHoldTimer()
      if (wasTriggered) {
        focusPriorityHoldTriggeredRef.current = false
        return
      }
      focusPriorityHoldTriggeredRef.current = false
      cycleFocusDifficulty()
    },
    [clearPriorityHoldTimer, cycleFocusDifficulty],
  )

  const handleDifficultyPointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    },
    [clearPriorityHoldTimer],
  )

  const handleDifficultyPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    },
    [clearPriorityHoldTimer],
  )

  const handleDifficultyKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        cycleFocusDifficulty()
      }
    },
    [cycleFocusDifficulty],
  )

  useEffect(() => {
    return () => {
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    }
  }, [clearPriorityHoldTimer])

  const prepareFocusCheckAnimation = useCallback((marker?: HTMLElement | null) => {
    const host = marker ?? focusCompleteButtonRef.current
    if (!host) {
      return
    }
    const path = host.querySelector('.goal-task-check path') as SVGPathElement | null
    if (!path) {
      return
    }
    try {
      const length = path.getTotalLength()
      if (Number.isFinite(length) && length > 0) {
        const dash = `${length}`
        path.style.removeProperty('stroke-dasharray')
        path.style.removeProperty('stroke-dashoffset')
        path.style.setProperty('--goal-check-length', dash)
      }
    } catch {
      // ignore measurement errors; fallback styles remain
    }
  }, [])

  useEffect(() => {
    prepareFocusCheckAnimation()
  }, [prepareFocusCheckAnimation, activeFocusCandidate?.taskId, focusSource?.taskId, normalizedCurrentTask])

  const handleCompleteFocus = async (
    event?: ReactPointerEvent<HTMLButtonElement> | ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!canCompleteFocus) {
      return
    }
    const marker = event?.currentTarget
    if (marker) {
      prepareFocusCheckAnimation(marker)
    } else {
      prepareFocusCheckAnimation()
    }
    const taskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const bucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const entryGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
    const entryBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
    const isLifeRoutineFocus =
      goalId === LIFE_ROUTINES_GOAL_ID && bucketId !== null && lifeRoutineBucketIds.has(bucketId)

    if (!taskId || !bucketId || !goalId) {
      return
    }
    if (isCompletingFocus) {
      return
    }
    if (focusCompletionTimeoutRef.current !== null) {
      window.clearTimeout(focusCompletionTimeoutRef.current)
      focusCompletionTimeoutRef.current = null
    }
    setIsCompletingFocus(true)

    const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
    if (elapsed > 0) {
      const sessionMeta = sessionMetadataRef.current
      registerNewHistoryEntry(elapsed, entryName, {
        goalId: sessionMeta.goalId ?? goalId,
        bucketId: sessionMeta.bucketId ?? bucketId,
        taskId: sessionMeta.taskId ?? taskId,
        sessionKey: currentSessionKeyRef.current,
        goalName: sessionMeta.goalName ?? entryGoalName,
        bucketName: sessionMeta.bucketName ?? entryBucketName,
        goalSurface: sessionMeta.goalSurface,
        bucketSurface: sessionMeta.bucketSurface,
      })
    }

    setIsRunning(false)
    setElapsed(0)
    setSessionStart(null)
    lastTickRef.current = null
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)

    if (!isLifeRoutineFocus) {
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          if (goal.id !== goalId) {
            return goal
          }
          const updatedBuckets = goal.buckets.map((bucket) => {
            if (bucket.id !== bucketId) {
              return bucket
            }
            const updatedTasks = bucket.tasks.map((task) => {
              if (task.id !== taskId) {
                return task
              }
              mutated = true
              return { ...task, completed: true }
            })
            if (!mutated) {
              return { ...bucket, tasks: updatedTasks }
            }
            const activeTasks = updatedTasks.filter((task) => !task.completed)
            const completedTasks = updatedTasks.filter((task) => task.completed)
            return { ...bucket, tasks: [...activeTasks, ...completedTasks] }
          })
          return { ...goal, buckets: updatedBuckets }
        })
        if (mutated) {
          publishGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    }

    if (!isLifeRoutineFocus) {
      try {
        await setTaskCompletedAndResort(taskId, bucketId, true)
      } catch (error) {
        console.warn('Failed to mark task complete from Taskwatch', error)
      }
    }

    const timeoutId = window.setTimeout(() => {
      setIsCompletingFocus(false)
      setCurrentTaskName('')
      setFocusSource(null)
      setCustomTaskDraft('')
      setIsSelectorOpen(false)
      focusCompletionTimeoutRef.current = null
    }, FOCUS_COMPLETION_RESET_DELAY_MS)
    focusCompletionTimeoutRef.current = timeoutId
  }

  const handleSelectTask = (taskName: string, source: FocusSource | null) => {
    const trimmed = taskName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
    const sanitizedSource = source && source.goalName && source.bucketName
      ? {
          goalId: source.goalId,
          bucketId: source.bucketId,
          goalName: source.goalName.trim().slice(0, MAX_TASK_STORAGE_LENGTH),
          bucketName: source.bucketName.trim().slice(0, MAX_TASK_STORAGE_LENGTH),
          taskId: source.taskId ?? null,
          taskDifficulty: source.taskDifficulty ?? null,
          priority: source.priority ?? null,
          goalSurface: source.goalSurface ? ensureSurfaceStyle(source.goalSurface, DEFAULT_SURFACE_STYLE) : null,
          bucketSurface: source.bucketSurface ? ensureSurfaceStyle(source.bucketSurface, DEFAULT_SURFACE_STYLE) : null,
        }
      : null
    setCurrentTaskName(trimmed)
    setFocusSource(sanitizedSource)
    setCustomTaskDraft(trimmed)
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
  }

  const handleClearFocus = () => {
    setCurrentTaskName('')
    setFocusSource(null)
    setCustomTaskDraft('')
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
  }

  const handleCustomSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = customTaskDraft.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
    setCurrentTaskName(trimmed)
    setFocusSource(null)
    setCustomTaskDraft(trimmed)
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
  }

  const handleCustomDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value ?? ''
    setCustomTaskDraft(raw.slice(0, MAX_TASK_STORAGE_LENGTH))
  }

  const handleStartStop = () => {
    setIsRunning((current) => {
      if (current) {
        currentSessionKeyRef.current = null
        lastLoggedSessionKeyRef.current = null
        return false
      }

      const now = Date.now()
      setSessionStart(now - elapsed)
      lastTickRef.current = null
      const metadata = deriveSessionMetadata()
      sessionMetadataRef.current = metadata
      currentSessionKeyRef.current = metadata.sessionKey
      lastLoggedSessionKeyRef.current = null
      return true
    })
  }

  const handleReset = () => {
    if (elapsed > 0) {
      const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
      const sessionMeta = sessionMetadataRef.current
      registerNewHistoryEntry(elapsed, entryName, {
        goalId: sessionMeta.goalId,
        bucketId: sessionMeta.bucketId,
        taskId: sessionMeta.taskId,
        sessionKey: currentSessionKeyRef.current,
        goalName: sessionMeta.goalName,
        bucketName: sessionMeta.bucketName,
        goalSurface: sessionMeta.goalSurface,
        bucketSurface: sessionMeta.bucketSurface,
      })
    }
    setIsRunning(false)
    setElapsed(0)
    setSessionStart(null)
    lastTickRef.current = null
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)
  }

  const handleToggleTimeVisibility = useCallback(() => {
    setIsTimeHidden((current) => !current)
  }, [])

  const registerNewHistoryEntry = useCallback(
    (
      elapsedMs: number,
      taskName: string,
      context?: {
        goalId?: string | null
        bucketId?: string | null
        taskId?: string | null
        sessionKey?: string | null
        goalName?: string | null
        bucketName?: string | null
        goalSurface?: SurfaceStyle | null
        bucketSurface?: SurfaceStyle | null
      },
    ) => {
      const now = Date.now()
      const startedAt = sessionStart ?? now - elapsedMs
      const sessionMeta = sessionMetadataRef.current
      const contextGoalId =
        context?.goalId !== undefined ? context.goalId : sessionMeta.goalId
      const contextBucketId =
        context?.bucketId !== undefined ? context.bucketId : sessionMeta.bucketId
      const contextTaskId =
        context?.taskId !== undefined ? context.taskId : sessionMeta.taskId
      const sessionKeyExplicit =
        context?.sessionKey !== undefined ? context.sessionKey : sessionMeta.sessionKey
      const sessionKey =
        sessionKeyExplicit !== undefined && sessionKeyExplicit !== null
          ? sessionKeyExplicit
          : makeSessionKey(contextGoalId, contextBucketId, contextTaskId)
      if (sessionKey) {
        if (lastLoggedSessionKeyRef.current === sessionKey) {
          return
        }
        lastLoggedSessionKeyRef.current = sessionKey
      }

      const goalName =
        context?.goalName !== undefined ? context.goalName : sessionMeta.goalName
      const bucketName =
        context?.bucketName !== undefined ? context.bucketName : sessionMeta.bucketName
      const goalSurfaceCandidate =
        context?.goalSurface !== undefined ? context.goalSurface : sessionMeta.goalSurface
      const bucketSurfaceCandidate =
        context?.bucketSurface !== undefined ? context.bucketSurface : sessionMeta.bucketSurface
      const normalizedGoalSurface = ensureSurfaceStyle(
        goalSurfaceCandidate ?? DEFAULT_SURFACE_STYLE,
        DEFAULT_SURFACE_STYLE,
      )
      const normalizedBucketSurface =
        bucketSurfaceCandidate !== undefined && bucketSurfaceCandidate !== null
          ? ensureSurfaceStyle(bucketSurfaceCandidate, DEFAULT_SURFACE_STYLE)
          : null

      const entry: HistoryEntry = {
        id: makeHistoryId(),
        taskName,
        elapsed: elapsedMs,
        startedAt,
        endedAt: now,
        goalName: goalName ?? null,
        bucketName: bucketName ?? null,
        goalId: contextGoalId ?? null,
        bucketId: contextBucketId ?? null,
        taskId: contextTaskId ?? null,
        goalSurface: normalizedGoalSurface,
        bucketSurface: normalizedBucketSurface,
      }

      applyLocalHistoryChange((current) => {
        const next = [entry, ...current]
        return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
      })

      if (context?.sessionKey !== undefined || sessionMeta.sessionKey !== null) {
        const nextLabel = taskName.length > 0 ? taskName : sessionMeta.taskLabel
        sessionMetadataRef.current = createEmptySessionMetadata(nextLabel)
      }
    },
    [applyLocalHistoryChange, sessionStart],
  )

  const handleOpenSnapback = useCallback(() => {
    setIsRunning(false)
    setSnapbackReason('tired')
    setSnapbackNextAction('resume')
    setSnapbackNote('')
    setIsSnapbackOpen(true)
  }, [])

  const handleCloseSnapback = useCallback(() => {
    setIsSnapbackOpen(false)
    setSnapbackNote('')
  }, [])

  const handleSubmitSnapback = useCallback(() => {
    const reasonMeta = SNAPBACK_REASONS.find((option) => option.id === snapbackReason)
    const actionMeta = SNAPBACK_ACTIONS.find((option) => option.id === snapbackNextAction)
    const reasonLabel = reasonMeta?.label ?? 'Snapback'
    const actionLabel = actionMeta?.label ?? 'Decide next'
    const note = snapbackNote.trim()
    const now = Date.now()

  if (elapsed > 0) {
    const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'Focus Session'
    const sessionMeta = sessionMetadataRef.current
    const fallbackContext = focusContextRef.current
    const sourceMeta =
      sessionMeta.goalId !== null || sessionMeta.bucketId !== null || sessionMeta.taskId !== null
        ? sessionMeta
        : {
            goalId: fallbackContext.goalId,
            bucketId: fallbackContext.bucketId,
            taskId: fallbackContext.taskId,
            goalName: fallbackContext.goalName,
            bucketName: fallbackContext.bucketName,
            goalSurface: fallbackContext.goalSurface,
            bucketSurface: fallbackContext.bucketSurface,
            sessionKey: sessionMeta.sessionKey,
            taskLabel: sessionMeta.taskLabel,
          }
    registerNewHistoryEntry(elapsed, entryName, {
      goalId: sourceMeta.goalId,
      bucketId: sourceMeta.bucketId,
      taskId: sourceMeta.taskId,
      sessionKey: currentSessionKeyRef.current,
      goalName: sourceMeta.goalName,
      bucketName: sourceMeta.bucketName,
      goalSurface: sourceMeta.goalSurface,
      bucketSurface: sourceMeta.bucketSurface,
    })
    setElapsed(0)
    setSessionStart(null)
    lastTickRef.current = null
  } else {
    setSessionStart(null)
  }

  currentSessionKeyRef.current = null
  lastLoggedSessionKeyRef.current = null
  sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)

    const labelParts = [reasonLabel]
    if (note.length > 0) {
      labelParts.push(note)
    }
    const markerTaskName = `Snapback • ${labelParts.join(' – ')}`.slice(0, MAX_TASK_STORAGE_LENGTH)
    const context = focusContextRef.current
    const markerGoalSurface = ensureSurfaceStyle(context.goalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE)
    const markerBucketSurface =
      context.bucketSurface !== undefined && context.bucketSurface !== null
        ? ensureSurfaceStyle(context.bucketSurface, DEFAULT_SURFACE_STYLE)
        : null
    const markerEntry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: markerTaskName,
      elapsed: SNAPBACK_MARKER_DURATION_MS,
      startedAt: now,
      endedAt: now + SNAPBACK_MARKER_DURATION_MS,
      goalName: context.goalName,
      bucketName: actionLabel,
      goalId: context.goalId,
      bucketId: context.bucketId,
      taskId: context.taskId,
      goalSurface: markerGoalSurface,
      bucketSurface: markerBucketSurface,
    }

    applyLocalHistoryChange((current) => {
      const next = [markerEntry, ...current]
      return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
    })

    setLastSnapbackSummary(`${reasonLabel}${note.length > 0 ? ` • ${note}` : ''} → ${actionLabel}`)
    setIsSnapbackOpen(false)
    setSnapbackNote('')

    if (snapbackNextAction === 'resume') {
      const resumeStart = Date.now()
      setSessionStart(resumeStart)
      setIsRunning(true)
      const resumeMetadata = deriveSessionMetadata()
      sessionMetadataRef.current = resumeMetadata
      currentSessionKeyRef.current = resumeMetadata.sessionKey
      lastLoggedSessionKeyRef.current = null
    } else {
      setIsRunning(false)
      if (snapbackNextAction === 'switch') {
        setIsSelectorOpen(true)
      }
  }
  }, [
    applyLocalHistoryChange,
    deriveSessionMetadata,
    elapsed,
    normalizedCurrentTask,
    registerNewHistoryEntry,
    snapbackNextAction,
    snapbackNote,
    snapbackReason,
  ])

  useEffect(() => {
    if (!isSnapbackOpen) {
      return
    }
    const timerId = window.setTimeout(() => {
      snapbackDialogRef.current?.focus()
    }, 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCloseSnapback()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(timerId)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleCloseSnapback, isSnapbackOpen])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleFocusBroadcast = (event: Event) => {
      const custom = event as FocusBroadcastEvent
      const detail = custom.detail as FocusBroadcastDetail | undefined
      if (!detail) {
        return
      }
      const previousContext = focusContextRef.current
      const taskName = detail.taskName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const goalName = detail.goalName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const bucketName = detail.bucketName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const safeGoalSurface = ensureSurfaceStyle(detail.goalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE)
      const safeBucketSurface =
        detail.bucketSurface !== undefined && detail.bucketSurface !== null
          ? ensureSurfaceStyle(detail.bucketSurface, DEFAULT_SURFACE_STYLE)
          : null

      setCurrentTaskName(taskName)
      setFocusSource({
        goalId: detail.goalId,
        bucketId: detail.bucketId,
        goalName,
        bucketName,
        taskId: detail.taskId ?? null,
        taskDifficulty: detail.taskDifficulty ?? null,
        priority: detail.priority ?? null,
        goalSurface: safeGoalSurface,
        bucketSurface: safeBucketSurface,
      })
      setCustomTaskDraft(taskName)
      setIsSelectorOpen(false)

      if (detail.autoStart) {
        const now = Date.now()
        const previousSessionKey = currentSessionKeyRef.current
        if (elapsed > 0) {
          const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
          const previousSessionMeta = sessionMetadataRef.current
          registerNewHistoryEntry(elapsed, entryName, {
            goalId: previousSessionMeta.goalId ?? previousContext.goalId,
            bucketId: previousSessionMeta.bucketId ?? previousContext.bucketId,
            taskId: previousSessionMeta.taskId ?? previousContext.taskId,
            sessionKey: previousSessionKey,
            goalName: previousSessionMeta.goalName ?? previousContext.goalName,
            bucketName: previousSessionMeta.bucketName ?? previousContext.bucketName,
            goalSurface: previousSessionMeta.goalSurface ?? previousContext.goalSurface,
            bucketSurface: previousSessionMeta.bucketSurface ?? previousContext.bucketSurface,
          })
        }
        setElapsed(0)
        setSessionStart(now)
        lastTickRef.current = null
        setIsRunning(true)
        const autoSessionKey = makeSessionKey(detail.goalId ?? null, detail.bucketId ?? null, detail.taskId ?? null)
        const autoTaskLabel =
          taskName.length > 0 ? taskName : goalName.length > 0 ? goalName : 'New Task'
        sessionMetadataRef.current = {
          goalId: detail.goalId ?? null,
          bucketId: detail.bucketId ?? null,
          taskId: detail.taskId ?? null,
          goalName: goalName.length > 0 ? goalName : null,
          bucketName: bucketName.length > 0 ? bucketName : null,
          goalSurface: safeGoalSurface,
          bucketSurface: safeBucketSurface,
          sessionKey: autoSessionKey,
          taskLabel: autoTaskLabel,
        }
        currentSessionKeyRef.current = autoSessionKey
        lastLoggedSessionKeyRef.current = null
      }
    }
    window.addEventListener(FOCUS_EVENT_TYPE, handleFocusBroadcast as EventListener)
    return () => {
      window.removeEventListener(FOCUS_EVENT_TYPE, handleFocusBroadcast as EventListener)
    }
  }, [elapsed, normalizedCurrentTask, registerNewHistoryEntry])

  const formattedTime = useMemo(() => formatTime(elapsed), [elapsed])
  const formattedClock = useMemo(() => formatClockTime(currentTime), [currentTime])
  const clockDateTime = useMemo(() => new Date(currentTime).toISOString(), [currentTime])
  const baseTimeClass = elapsed >= 3600000 ? 'time-value--long' : ''
  const charCount = formattedTime.length
  let lengthClass = ''
  if (charCount >= 15) {
    lengthClass = 'time-length-xxs'
  } else if (charCount >= 13) {
    lengthClass = 'time-length-xs'
  } else if (charCount >= 11) {
    lengthClass = 'time-length-sm'
  }

  const timeValueClassName = ['time-value', baseTimeClass, lengthClass, isTimeHidden ? 'time-value--hidden' : '']
    .filter(Boolean)
    .join(' ')
  const timeToggleLabel = isTimeHidden ? 'Show Time' : 'Hide Time'
  const timeToggleTitle = isTimeHidden ? 'Show stopwatch time' : 'Hide stopwatch time'
  const statusText = isRunning ? 'running' : elapsed > 0 ? 'paused' : 'idle'
  const primaryLabel = isRunning ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start'

  return (
    <div className="site-main__inner">
      <h1 className="stopwatch-heading">Taskwatch</h1>
      <div className="task-selector-container">
        <div
          className={[
            'focus-task',
            'goal-task-row',
            ...focusSurfaceClasses,
            focusDiffClass,
            focusPriority ? 'goal-task-row--priority' : '',
            isCompletingFocus ? 'goal-task-row--completing' : '',
            isSelectorOpen ? 'focus-task--open' : '',
            isDefaultTask ? 'focus-task--empty' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={focusTaskContainerRef}
        >
          <button
            type="button"
            className={[
              'goal-task-marker',
              'goal-task-marker--action',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={handleCompleteFocus}
            onPointerDown={(event) => {
              if (canCompleteFocus) {
                prepareFocusCheckAnimation(event.currentTarget)
              }
            }}
            onTouchStart={(event) => {
              if (canCompleteFocus) {
                prepareFocusCheckAnimation(event.currentTarget)
              }
            }}
            aria-disabled={!canCompleteFocus}
            aria-label="Mark focus task complete"
            ref={focusCompleteButtonRef}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" className="goal-task-check" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="focus-task__body"
            onClick={handleToggleSelector}
            aria-haspopup="dialog"
            aria-expanded={isSelectorOpen}
            ref={selectorButtonRef}
          >
            <div className="focus-task__content">
              <div className="focus-task__main">
                <span className="focus-task__label">What am I doing now?</span>
                <span className="goal-task-text">
                  <span
                    className={[
                      'goal-task-text__inner',
                      'focus-task__name',
                      isDefaultTask ? 'focus-task__name--placeholder' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {isDefaultTask ? 'Choose a focus task' : safeTaskName}
                  </span>
                </span>
                {focusGoalName && focusBucketName ? (
                  <span className="focus-task__origin">{`${focusGoalName} → ${focusBucketName}`}</span>
                ) : null}
              </div>
            </div>
          </button>
          <div className="focus-task__indicators">
            <button
              type="button"
              className={focusDiffButtonClass}
              onPointerDown={handleDifficultyPointerDown}
              onPointerUp={handleDifficultyPointerUp}
              onPointerLeave={handleDifficultyPointerLeave}
              onPointerCancel={handleDifficultyPointerCancel}
              onKeyDown={handleDifficultyKeyDown}
              disabled={!canCycleFocusDifficulty}
              aria-label={focusDiffButtonTitle}
              title={focusDiffButtonTitle}
            >
              <span className="sr-only">{focusDiffButtonTitle}</span>
            </button>
            <span className={`focus-task__chevron${isSelectorOpen ? ' focus-task__chevron--open' : ''}`}>
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M5.293 7.293a1 1 0 0 1 1.414 0L10 10.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 0-1.414z" />
              </svg>
            </span>
          </div>
        </div>
        {isSelectorOpen ? (
          <div
            className="task-selector-popover"
            role="dialog"
            aria-label="Select focus task"
            ref={selectorPopoverRef}
          >
            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Custom focus</h2>
              <form className="task-selector__custom-form" onSubmit={handleCustomSubmit}>
                <label htmlFor="taskwatch-custom-focus" className="sr-only">
                  Custom focus task
                </label>
                <input
                  id="taskwatch-custom-focus"
                  type="text"
                  value={customTaskDraft}
                  onChange={handleCustomDraftChange}
                  placeholder="Type a task name"
                  className="task-selector__input"
                  maxLength={MAX_TASK_STORAGE_LENGTH}
                />
                <button type="submit" className="task-selector__set-button">
                  Set
                </button>
              </form>
              <button
                type="button"
                className="task-selector__clear-button"
                onClick={handleClearFocus}
                disabled={isDefaultTask && !focusSource}
              >
                Clear focus
              </button>
            </div>

            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Priority</h2>
              {priorityTasks.length > 0 ? (
                <ul className="task-selector__list">
                  {priorityTasks.map((task) => {
                    const candidateLower = task.taskName.trim().toLocaleLowerCase()
                    const matches = focusSource
                      ? focusSource.goalId === task.goalId &&
                        focusSource.bucketId === task.bucketId &&
                        candidateLower === currentTaskLower
                      : !isDefaultTask && candidateLower === currentTaskLower
                    const diffClass =
                      task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                    const rowClassName = [
                      'task-selector__task',
                      'goal-task-row',
                      diffClass,
                      task.priority ? 'goal-task-row--priority' : '',
                      matches ? 'task-selector__task--active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    const diffBadgeClass =
                      task.difficulty && task.difficulty !== 'none'
                        ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                            .filter(Boolean)
                            .join(' ')
                        : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                            .join(' ')
                    return (
                      <li key={task.taskId} className="task-selector__item">
                        <button
                          type="button"
                          className={rowClassName}
                          onClick={() =>
                            handleSelectTask(task.taskName, {
                              goalId: task.goalId,
                              bucketId: task.bucketId,
                              goalName: task.goalName,
                              bucketName: task.bucketName,
                              taskId: task.taskId,
                              taskDifficulty: task.difficulty,
                              priority: task.priority,
                              goalSurface: task.goalSurface,
                              bucketSurface: task.bucketSurface,
                            })
                          }
                        >
                          <div className="task-selector__task-main">
                            <div className="task-selector__task-content">
                              <span className="goal-task-text">
                                <span className="goal-task-text__inner">{task.taskName}</span>
                              </span>
                              <span className="task-selector__origin task-selector__origin--dropdown">
                                {`${task.goalName} → ${task.bucketName}`}
                              </span>
                            </div>
                            <span className={diffBadgeClass} aria-hidden="true" />
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="task-selector__empty">No priority tasks yet.</p>
              )}
            </div>

            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Life Routines</h2>
              <button
                type="button"
                className={`task-selector__goal-toggle surface-goal surface-goal--${LIFE_ROUTINES_SURFACE}`}
                onClick={() => setLifeRoutinesExpanded((value) => !value)}
                aria-expanded={lifeRoutinesExpanded}
              >
                <span className="task-selector__goal-info">
                  <span className="task-selector__goal-badge" aria-hidden="true">
                    System
                  </span>
                  <span className="task-selector__goal-name">{LIFE_ROUTINES_NAME}</span>
                </span>
                <span className="task-selector__chevron" aria-hidden="true">
                  {lifeRoutinesExpanded ? '−' : '+'}
                </span>
              </button>
              {lifeRoutinesExpanded ? (
                <ul className="task-selector__list">
                  {lifeRoutineTasks.map((task) => {
                    const taskLower = task.title.trim().toLocaleLowerCase()
                    const matches = focusSource
                      ? focusSource.goalId === LIFE_ROUTINES_GOAL_ID &&
                        focusSource.bucketId === task.bucketId &&
                        currentTaskLower === taskLower
                      : !isDefaultTask && currentTaskLower === taskLower
                    const surfaceClass = `surface-life-routine surface-life-routine--${task.surfaceStyle}`
                    const rowClassName = [
                      'task-selector__task',
                      'goal-task-row',
                      'task-selector__task--life-routine',
                      surfaceClass,
                      matches ? 'task-selector__task--active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <li key={task.id} className="task-selector__item">
                        <button
                          type="button"
                          className={rowClassName}
                          onClick={() =>
                            handleSelectTask(task.title, {
                              goalId: LIFE_ROUTINES_GOAL_ID,
                              bucketId: task.bucketId,
                              goalName: LIFE_ROUTINES_NAME,
                              bucketName: task.title,
                              taskId: task.id,
                              taskDifficulty: 'none',
                              priority: false,
                              goalSurface: LIFE_ROUTINES_SURFACE,
                              bucketSurface: task.surfaceStyle,
                            })
                          }
                        >
                          <div className="task-selector__task-main">
                            <div className="task-selector__task-content">
                              <span className="goal-task-text">
                                <span className="goal-task-text__inner">{task.title}</span>
                              </span>
                              <span className="task-selector__origin task-selector__origin--dropdown">{task.blurb}</span>
                            </div>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>

            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Goals</h2>
              {activeGoalSnapshots.length > 0 ? (
                <ul className="task-selector__goals">
                  {activeGoalSnapshots.map((goal) => {
                    const goalExpanded = expandedGoals.has(goal.id)
                    const goalSurface = goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE
                    const goalToggleClass = `task-selector__goal-toggle surface-goal surface-goal--${goalSurface}`
                    return (
                      <li key={goal.id} className="task-selector__goal">
                        <button
                          type="button"
                          className={goalToggleClass}
                          onClick={() => toggleGoalExpansion(goal.id)}
                          aria-expanded={goalExpanded}
                        >
                          <span className="task-selector__goal-info">
                            <span className="task-selector__goal-badge" aria-hidden="true">
                              Goal
                            </span>
                            <span className="task-selector__goal-name">{goal.name}</span>
                          </span>
                          <span className="task-selector__chevron" aria-hidden="true">
                            {goalExpanded ? '−' : '+'}
                          </span>
                        </button>
                        {goalExpanded ? (
                          <ul className="task-selector__buckets">
                            {goal.buckets
                              .filter((bucket) => !bucket.archived)
                              .map((bucket) => {
                              const bucketExpanded = expandedBuckets.has(bucket.id)
                              const activeTasks = bucket.tasks.filter((task) => !task.completed)
                              const completedTasks = bucket.tasks.filter((task) => task.completed)
                              if (activeTasks.length === 0 && completedTasks.length === 0) {
                                return null
                              }
                              const bucketSurface = bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE
                              const diffClsForTask = (diff?: FocusCandidate['difficulty']) =>
                                diff && diff !== 'none' ? `goal-task-row--diff-${diff}` : ''

                              return (
                                <li key={bucket.id} className="task-selector__bucket">
                                  <button
                                    type="button"
                                    className="task-selector__bucket-toggle"
                                    onClick={() => toggleBucketExpansion(bucket.id)}
                                    aria-expanded={bucketExpanded}
                                  >
                                    <span className="task-selector__bucket-info">
                                      <span className="task-selector__bucket-badge" aria-hidden="true">
                                        Bucket
                                      </span>
                                      <span className="task-selector__bucket-name">{bucket.name}</span>
                                    </span>
                                    <span className="task-selector__chevron" aria-hidden="true">
                                      {bucketExpanded ? '−' : '+'}
                                    </span>
                                  </button>
                                  {bucketExpanded ? (
                                    <div className="task-selector__bucket-content">
                                      {activeTasks.length > 0 ? (
                                        <ul className="task-selector__tasks">
                                          {activeTasks.map((task) => {
                                            const candidateLower = task.text.trim().toLocaleLowerCase()
                                            const matches = focusSource
                                              ? focusSource.goalId === goal.id &&
                                                focusSource.bucketId === bucket.id &&
                                                candidateLower === currentTaskLower
                                              : !isDefaultTask && candidateLower === currentTaskLower
                                            const diffClass = diffClsForTask(task.difficulty as any)
                                            const taskClassName = [
                                              'task-selector__task',
                                              'goal-task-row',
                                              diffClass,
                                              task.priority ? 'goal-task-row--priority' : '',
                                              matches ? 'task-selector__task--active' : '',
                                            ]
                                              .filter(Boolean)
                                              .join(' ')
                                            const diffBadgeClass =
                                              task.difficulty && task.difficulty !== 'none'
                                                ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                                    .filter(Boolean)
                                                    .join(' ')
                                                : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                                    .join(' ')
                                            return (
                                              <li key={task.id}>
                                                <button
                                                  type="button"
                                                  className={taskClassName}
                                                  onClick={() =>
                                                    handleSelectTask(task.text, {
                                                      goalId: goal.id,
                                                      bucketId: bucket.id,
                                                      goalName: goal.name,
                                                      bucketName: bucket.name,
                                                      taskId: task.id,
                                                      taskDifficulty: task.difficulty ?? 'none',
                                                      priority: task.priority ?? false,
                                                      goalSurface: goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
                                                      bucketSurface,
                                                    })
                                                  }
                                                >
                                                  <div className="task-selector__task-main">
                                                    <div className="task-selector__task-content">
                                                      <span className="goal-task-text">
                                                        <span className="goal-task-text__inner">{task.text}</span>
                                                      </span>
                                                      <span className="task-selector__origin task-selector__origin--dropdown">
                                                        {`${goal.name} → ${bucket.name}`}
                                                      </span>
                                                    </div>
                                                    <span className={diffBadgeClass} aria-hidden="true" />
                                                  </div>
                                                </button>
                                              </li>
                                            )
                                          })}
                                        </ul>
                                      ) : (
                                        <p className="task-selector__empty-sub">No active tasks.</p>
                                      )}
                                    </div>
                                  ) : null}
                                </li>
                              )
                            })}
                          </ul>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="task-selector__empty">Goals will appear here once synced.</p>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <section className="stopwatch-card" role="region" aria-live="polite">
        <button
          type="button"
          className="card-clock-toggle"
          onClick={handleToggleTimeVisibility}
          aria-pressed={isTimeHidden}
          aria-label={timeToggleTitle}
        >
          {timeToggleLabel}
        </button>
        <time className="card-clock" dateTime={clockDateTime} aria-label="Current time">
          {formattedClock}
        </time>
        <div className="time-display">
          <span className="time-label">elapsed</span>
          <span className={timeValueClassName} aria-hidden={isTimeHidden}>
            {formattedTime}
          </span>
        </div>
        {isTimeHidden ? (
          <span className="sr-only" role="status">
            Stopwatch time hidden
          </span>
        ) : null}

        <div className="status-row" aria-live="polite">
          <span className={`status-dot status-${statusText}`} aria-hidden="true" />
          <span className="status-text">{statusText}</span>
        </div>

        <div className="controls">
          <button
            className="control control-primary"
            type="button"
            onClick={handleStartStop}
          >
            {primaryLabel}
          </button>
          <button
            className="control control-secondary"
            type="button"
            onClick={handleReset}
            disabled={elapsed === 0}
          >
            Reset
          </button>
        </div>
      </section>

      <section className="snapback-tool" aria-label="Snap back momentum">
        <div className="snapback-tool__card">
          <div className="snapback-tool__body">
            <h2 className="snapback-tool__title">Snap Back</h2>
            <p className="snapback-tool__text">
              Momentum dipped? Pause, capture what happened, and choose your next move.
            </p>
            {lastSnapbackSummary ? (
              <p className="snapback-tool__last" aria-live="polite">
                Last snapback: {lastSnapbackSummary}
              </p>
            ) : null}
          </div>
          <button type="button" className="snapback-tool__button" onClick={handleOpenSnapback}>
            Snap Back
          </button>
        </div>
      </section>

      <section className="taskwatch-notes" aria-label="Notes and subtasks">
        <div className="taskwatch-notes__header">
          <div className="taskwatch-notes__heading">
            <h2 className="taskwatch-notes__title">Notes & Subtasks</h2>
            <p className="taskwatch-notes__subtitle">
              <span className="taskwatch-notes__task">{safeTaskName}</span>
              <span className="taskwatch-notes__context">{focusContextLabel}</span>
            </p>
          </div>
          {hasNotebookContent ? (
            <button type="button" className="taskwatch-notes__clear" onClick={handleNotebookClear}>
              Clear
            </button>
          ) : null}
        </div>

        <div className="taskwatch-notes__subtasks">
          <div className="taskwatch-notes__subtasks-row">
            <div className="taskwatch-notes__subtasks-header">
              <p className="taskwatch-notes__label">Subtasks</p>
              {subtaskProgressLabel ? (
                <span className="taskwatch-notes__progress" aria-label={`Completed ${subtaskProgressLabel} subtasks`}>
                  {subtaskProgressLabel}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="taskwatch-notes__add"
              onClick={() => handleAddNotebookSubtask({ focus: true })}
            >
              + Subtask
            </button>
          </div>
          {notebookSubtasks.length === 0 ? (
            <p className="taskwatch-notes__empty-text">No subtasks yet</p>
          ) : (
            <ul className="taskwatch-notes__list">
              {notebookSubtasks.map((subtask) => (
                <li
                  key={subtask.id}
                  className={classNames(
                    'taskwatch-notes__item',
                    subtask.completed && 'taskwatch-notes__item--completed',
                  )}
                >
                  <label className="taskwatch-notes__subtask">
                    <input
                      type="checkbox"
                      className="taskwatch-notes__checkbox goal-task-details__checkbox"
                      checked={subtask.completed}
                      onChange={() => handleNotebookSubtaskToggle(subtask.id)}
                  aria-label={subtask.text.trim().length > 0 ? `Mark "${subtask.text}" complete` : 'Toggle subtask'}
                />
                <input
                  id={makeNotebookSubtaskInputId(notebookKey, subtask.id)}
                  type="text"
                  className="taskwatch-notes__input"
                  value={subtask.text}
                  onChange={(event) => handleNotebookSubtaskTextChange(subtask.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const value = event.currentTarget.value.trim()
                      if (value.length === 0) {
                        return
                      }
                      handleAddNotebookSubtask({ focus: true })
                    }
                  }}
                  onBlur={() => handleNotebookSubtaskBlur(subtask.id)}
                  placeholder="Describe subtask"
                />
                  </label>
                  <button
                    type="button"
                    className="taskwatch-notes__remove"
                    onClick={() => handleNotebookSubtaskRemove(subtask.id)}
                    aria-label="Remove subtask"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="taskwatch-notes__notes">
          <label className="taskwatch-notes__label" htmlFor={notesFieldId}>
            Notes
          </label>
          <textarea
            id={notesFieldId}
            className="taskwatch-notes__textarea"
            value={notebookNotes}
            onChange={handleNotebookNotesChange}
            placeholder="Capture quick ideas, wins, or blockers while you work..."
            rows={4}
          />
        </div>
      </section>

      {isSnapbackOpen ? (
        <div className="snapback-overlay" role="dialog" aria-modal="true" aria-labelledby="snapback-title" onClick={handleCloseSnapback}>
          <div
            className="snapback-panel"
            ref={snapbackDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="snapback-panel__header">
              <div className="snapback-panel__heading">
                <h2 className="snapback-panel__title" id="snapback-title">
                  Snap back to focus
                </h2>
                <p className="snapback-panel__lead">Capture what happened and line up your next move.</p>
              </div>
              <button type="button" className="snapback-panel__close" onClick={handleCloseSnapback} aria-label="Close snapback panel">
                ×
              </button>
            </div>

            <div className="snapback-panel__context">
              <span className="snapback-panel__context-label">Current focus</span>
              <span className="snapback-panel__context-task">{safeTaskName}</span>
              {focusContextLabel ? <span className="snapback-panel__context-meta">{focusContextLabel}</span> : null}
            </div>

            <div className="snapback-panel__content">
              <div className="snapback-panel__grid">
                <div className="snapback-panel__section snapback-panel__section--stretch" aria-labelledby="snapback-reason-label">
                  <h3 id="snapback-reason-label" className="snapback-panel__heading">What pulled you off track?</h3>
                  <div className="snapback-panel__chips" role="group" aria-label="Select a reason">
                    {SNAPBACK_REASONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`snapback-option${snapbackReason === option.id ? ' snapback-option--active' : ''}`}
                        aria-pressed={snapbackReason === option.id}
                        onClick={() => setSnapbackReason(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <label className="snapback-panel__label">
                    <span className="snapback-panel__label-text">
                      Add a quick note <span className="snapback-panel__optional">(optional)</span>
                    </span>
                    <textarea
                      className="snapback-panel__textarea"
                      value={snapbackNote}
                      onChange={(event) => setSnapbackNote(event.target.value.slice(0, MAX_TASK_STORAGE_LENGTH))}
                      placeholder="Jot what happened or what you tried instead"
                      rows={3}
                    />
                  </label>
                </div>

                <div className="snapback-panel__section snapback-panel__section--compact" aria-labelledby="snapback-action-label">
                  <h3 id="snapback-action-label" className="snapback-panel__heading">Next step</h3>
                  <div className="snapback-panel__chips" role="group" aria-label="Choose a next action">
                    {SNAPBACK_ACTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`snapback-option${snapbackNextAction === option.id ? ' snapback-option--active' : ''}`}
                        aria-pressed={snapbackNextAction === option.id}
                        onClick={() => setSnapbackNextAction(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="snapback-panel__actions">
              <button type="button" className="snapback-panel__button snapback-panel__button--ghost" onClick={handleCloseSnapback}>
                Cancel
              </button>
              <button type="button" className="snapback-panel__button snapback-panel__button--primary" onClick={handleSubmitSnapback}>
                Log Snapback
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="meta meta-note">Built with React + Vite for seamless desktop and mobile use.</p>
    </div>
  )
}

export default TaskwatchPage
