import React, { useState, useRef, useEffect, useMemo, useCallback, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import './GoalsPage.css'
import {
  fetchGoalsHierarchy,
  createGoal as apiCreateGoal,
  renameGoal as apiRenameGoal,
  deleteGoalById as apiDeleteGoalById,
  createBucket as apiCreateBucket,
  renameBucket as apiRenameBucket,
  setBucketFavorite as apiSetBucketFavorite,
  setBucketSurface as apiSetBucketSurface,
  setGoalColor as apiSetGoalColor,
  setGoalSurface as apiSetGoalSurface,
  setGoalStarred as apiSetGoalStarred,
  deleteBucketById as apiDeleteBucketById,
  deleteCompletedTasksInBucket as apiDeleteCompletedTasksInBucket,
  createTask as apiCreateTask,
  updateTaskText as apiUpdateTaskText,
  setTaskDifficulty as apiSetTaskDifficulty,
  setTaskCompletedAndResort as apiSetTaskCompletedAndResort,
  setTaskSortIndex as apiSetTaskSortIndex,
  setBucketSortIndex as apiSetBucketSortIndex,
  setGoalSortIndex as apiSetGoalSortIndex,
  setTaskPriorityAndResort as apiSetTaskPriorityAndResort,
  seedGoalsIfEmpty,
} from '../lib/goalsApi'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  createGoalsSnapshot,
  publishGoalsSnapshot,
  readStoredGoalsSnapshot,
  subscribeToGoalsSnapshot,
  type GoalSnapshot,
} from '../lib/goalsSync'
import { broadcastFocusTask } from '../lib/focusChannel'

// Helper function for class names
function classNames(...xs: (string | boolean | undefined)[]): string {
  return xs.filter(Boolean).join(' ')
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightText(text: string, term: string): React.ReactNode {
  if (!term) {
    return text
  }
  const regex = new RegExp(`(${escapeRegExp(term)})`, 'ig')
  const parts = text.split(regex)
  return parts.map((part, index) => {
    if (!part) {
      return null
    }
    if (part.toLowerCase() === term.toLowerCase()) {
      return (
        <mark key={`${part}-${index}`} className="goal-highlight">
          {part}
        </mark>
      )
    }
    return <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
  })
}

// Type definitions
export interface TaskItem {
  id: string
  text: string
  completed: boolean
  difficulty?: 'none' | 'green' | 'yellow' | 'red'
  // Local-only: whether this task is prioritized (not persisted yet)
  priority?: boolean
}

type TaskSubtask = {
  id: string
  text: string
  completed: boolean
}

type TaskDetails = {
  notes: string
  subtasks: TaskSubtask[]
  expanded: boolean
}

type TaskDetailsState = Record<string, TaskDetails>

const createTaskDetails = (overrides?: Partial<TaskDetails>): TaskDetails => ({
  notes: '',
  subtasks: [],
  expanded: false,
  ...overrides,
})

const TASK_DETAILS_STORAGE_KEY = 'nc-taskwatch-task-details-v1'

const sanitizeSubtasks = (value: unknown): TaskSubtask[] => {
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
    .filter((item): item is TaskSubtask => Boolean(item))
}

const sanitizeTaskDetailsState = (value: unknown): TaskDetailsState => {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const next: TaskDetailsState = {}
  entries.forEach(([taskId, details]) => {
    if (typeof taskId !== 'string') {
      return
    }
    if (typeof details !== 'object' || details === null) {
      return
    }
    const candidate = details as Record<string, unknown>
    const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
    const subtasks = sanitizeSubtasks(candidate.subtasks)
    const expanded = Boolean(candidate.expanded)
    next[taskId] = { notes, subtasks, expanded }
  })
  return next
}

const readStoredTaskDetails = (): TaskDetailsState => {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(TASK_DETAILS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    return sanitizeTaskDetailsState(parsed)
  } catch {
    return {}
  }
}

const areTaskDetailsEqual = (a: TaskDetails, b: TaskDetails): boolean => {
  if (a.notes !== b.notes || a.expanded !== b.expanded) {
    return false
  }
  if (a.subtasks.length !== b.subtasks.length) {
    return false
  }
  for (let index = 0; index < a.subtasks.length; index += 1) {
    const left = a.subtasks[index]
    const right = b.subtasks[index]
    if (!right) {
      return false
    }
    if (left.id !== right.id || left.text !== right.text || left.completed !== right.completed) {
      return false
    }
  }
  return true
}

const shouldPersistTaskDetails = (details: TaskDetails): boolean => {
  if (details.expanded) {
    return true
  }
  if (details.notes.trim().length > 0) {
    return true
  }
  return details.subtasks.length > 0
}

const createSubtaskId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    // fall back to timestamp-based id below
  }
  return `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const SHOW_TASK_DETAILS = true as const

type FocusPromptTarget = {
  goalId: string
  bucketId: string
  taskId: string
}

const makeTaskFocusKey = (goalId: string, bucketId: string, taskId: string): string =>
  `${goalId}__${bucketId}__${taskId}`

const computeSelectionOffsetWithin = (element: HTMLElement, mode: 'start' | 'end' = 'start'): number | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return null
  }
  const range = selection.getRangeAt(selection.rangeCount - 1)
  const node = mode === 'start' ? range.startContainer : range.endContainer
  if (!element.contains(node)) {
    return null
  }
  const probe = range.cloneRange()
  probe.selectNodeContents(element)
  try {
    if (mode === 'start') {
      probe.setEnd(range.startContainer, range.startOffset)
    } else {
      probe.setEnd(range.endContainer, range.endOffset)
    }
  } catch {
    return null
  }
  return probe.toString().length
}

const resolveCaretOffsetFromPoint = (
  element: HTMLElement,
  clientX: number,
  clientY: number,
): number | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const doc = element.ownerDocument ?? document
  let range: Range | null = null

  const anyDoc = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null
  }

  if (typeof anyDoc.caretRangeFromPoint === 'function') {
    try {
      range = anyDoc.caretRangeFromPoint(clientX, clientY)
    } catch {
      range = null
    }
  }

  if (!range && typeof anyDoc.caretPositionFromPoint === 'function') {
    try {
      const position = anyDoc.caretPositionFromPoint(clientX, clientY)
      if (position?.offsetNode) {
        const tempRange = doc.createRange()
        const maxOffset = position.offsetNode.textContent?.length ?? 0
        const safeOffset = Math.max(0, Math.min(position.offset, maxOffset))
        tempRange.setStart(position.offsetNode, safeOffset)
        tempRange.collapse(true)
        range = tempRange
      }
    } catch {
      range = null
    }
  }

  if (!range) {
    return null
  }

  if (!element.contains(range.startContainer)) {
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const firstText = walker.nextNode()
    if (!firstText) {
      return 0
    }
    const maxOffset = firstText.textContent?.length ?? 0
    range.setStart(firstText, Math.max(0, Math.min(range.startOffset, maxOffset)))
    range.collapse(true)
  }

  const probe = range.cloneRange()
  probe.selectNodeContents(element)
  try {
    probe.setEnd(range.startContainer, range.startOffset)
  } catch {
    return null
  }
  return probe.toString().length
}

const findActivationCaretOffset = (
  element: HTMLElement | null,
  clientX: number,
  clientY: number,
): number | null => {
  if (!element) {
    return null
  }
  const fromPoint = resolveCaretOffsetFromPoint(element, clientX, clientY)
  if (fromPoint !== null) {
    return fromPoint
  }
  const fromSelection = computeSelectionOffsetWithin(element, 'start')
  if (fromSelection !== null) {
    return fromSelection
  }
  return computeSelectionOffsetWithin(element, 'end')
}

// Limit for inline task text editing (mirrors Taskwatch behavior)
const MAX_TASK_TEXT_LENGTH = 256

// Borrowed approach from Taskwatch: sanitize contentEditable text and preserve caret when possible
const sanitizeEditableValue = (
  element: HTMLSpanElement,
  rawValue: string,
  maxLength: number,
) => {
  const sanitized = rawValue.replace(/\n+/g, ' ')
  const limited = sanitized.slice(0, maxLength)
  const previous = element.textContent ?? ''
  const changed = previous !== limited

  let caretOffset: number | null = null
  if (typeof window !== 'undefined') {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      if (range && element.contains(range.endContainer)) {
        const preRange = range.cloneRange()
        preRange.selectNodeContents(element)
        try {
          preRange.setEnd(range.endContainer, range.endOffset)
          caretOffset = preRange.toString().length
        } catch {
          caretOffset = null
        }
      }
    }
  }

  if (changed) {
    element.textContent = limited

    if (caretOffset !== null && typeof window !== 'undefined') {
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        const targetOffset = Math.min(caretOffset, element.textContent?.length ?? 0)
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let remaining = targetOffset
        let node: Node | null = null
        let positioned = false
        while ((node = walker.nextNode())) {
          const length = node.textContent?.length ?? 0
          if (remaining <= length) {
            range.setStart(node, Math.max(0, remaining))
            positioned = true
            break
          }
          remaining -= length
        }

        if (!positioned) {
          range.selectNodeContents(element)
          range.collapse(false)
        } else {
          range.collapse(true)
        }

        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  return { value: limited, changed }
}

type GoalSurfaceStyle = SurfaceStyle
const normalizeSurfaceStyle = (value: string | null | undefined): GoalSurfaceStyle =>
  ensureSurfaceStyle(value, DEFAULT_SURFACE_STYLE)

type BucketSurfaceStyle = GoalSurfaceStyle

const normalizeBucketSurfaceStyle = (value: string | null | undefined): BucketSurfaceStyle =>
  ensureSurfaceStyle(value, DEFAULT_SURFACE_STYLE)

export interface Bucket {
  id: string
  name: string
  favorite: boolean
  tasks: TaskItem[]
  surfaceStyle?: BucketSurfaceStyle
}

export interface Goal {
  id: string
  name: string
  color: string
  surfaceStyle?: GoalSurfaceStyle
  starred: boolean
  customGradient?: {
    from: string
    to: string
  }
  buckets: Bucket[]
}

type GoalAppearanceUpdate = {
  surfaceStyle?: GoalSurfaceStyle
  color?: string
  customGradient?: {
    from: string
    to: string
  } | null
}

// Default data
const DEFAULT_GOALS: Goal[] = [
  {
    id: 'g_demo',
    name: 'Project X – End-to-end Demo',
    color: 'from-sky-500 to-indigo-500',
    surfaceStyle: 'glass',
    starred: false,
    buckets: [
      {
        id: 'b_demo_1',
        name: 'Planning',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't_demo_1', text: 'Scope v1 features', completed: false, difficulty: 'green' },
          { id: 't_demo_2', text: 'Draft milestones', completed: false, difficulty: 'yellow' },
          { id: 't_demo_3', text: 'Risk matrix', completed: true, difficulty: 'green' },
        ],
      },
      {
        id: 'b_demo_2',
        name: 'Build',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't_demo_4', text: 'Auth flow', completed: false, difficulty: 'yellow' },
          { id: 't_demo_5', text: 'Payments – stripe webhooks', completed: false, difficulty: 'red' },
          { id: 't_demo_6', text: 'Health checks', completed: true, difficulty: 'green' },
        ],
      },
      {
        id: 'b_demo_3',
        name: 'Polish',
        favorite: false,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't_demo_7', text: 'Empty states', completed: false, difficulty: 'green' },
          { id: 't_demo_8', text: 'Dark mode contrast', completed: false, difficulty: 'yellow' },
          { id: 't_demo_9', text: 'Animation timing', completed: true, difficulty: 'none' },
        ],
      },
      {
        id: 'b_demo_4',
        name: 'QA',
        favorite: false,
        surfaceStyle: 'glass',
        tasks: [],
      },
    ],
  },
  {
    id: 'g1',
    name: 'Finish PopDot Beta',
    color: 'from-fuchsia-500 to-purple-500',
    surfaceStyle: 'glass',
    starred: false,
    buckets: [
      {
        id: 'b1',
        name: 'Coding',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't1', text: 'Chest spawn logic', completed: false },
          { id: 't2', text: 'XP scaling', completed: false },
          { id: 't3', text: 'Reward tuning', completed: false },
        ],
      },
      {
        id: 'b2',
        name: 'Testing',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't4', text: 'Challenge balance', completed: false },
          { id: 't5', text: 'FPS hitches', completed: false },
        ],
      },
      {
        id: 'b3',
        name: 'Art/Polish',
        favorite: false,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't6', text: 'Shop UI polish', completed: false },
          { id: 't7', text: 'Icon pass', completed: false },
        ],
      },
    ],
  },
  {
    id: 'g2',
    name: 'Learn Japanese',
    color: 'from-emerald-500 to-cyan-500',
    surfaceStyle: 'glass',
    starred: false,
    buckets: [
      {
        id: 'b4',
        name: 'Flashcards',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't8', text: 'N5 verbs', completed: false },
          { id: 't9', text: 'Kana speed run', completed: false },
        ],
      },
      {
        id: 'b5',
        name: 'Listening',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't10', text: 'NHK Easy', completed: false },
          { id: 't11', text: 'Anime w/ JP subs', completed: false },
        ],
      },
      {
        id: 'b6',
        name: 'Speaking',
        favorite: false,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't12', text: 'HelloTalk 10m', completed: false },
          { id: 't13', text: 'Shadowing', completed: false },
        ],
      },
    ],
  },
  {
    id: 'g3',
    name: 'Stay Fit',
    color: 'from-lime-400 to-emerald-500',
    surfaceStyle: 'glass',
    starred: false,
    buckets: [
      {
        id: 'b7',
        name: 'Gym',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't14', text: 'Push day', completed: false },
          { id: 't15', text: 'Stretch 5m', completed: false },
        ],
      },
      {
        id: 'b8',
        name: 'Cooking',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't16', text: 'Prep lunches', completed: false },
          { id: 't17', text: 'Protein bowl', completed: false },
        ],
      },
      {
        id: 'b9',
        name: 'Sleep',
        favorite: true,
        surfaceStyle: 'glass',
        tasks: [
          { id: 't18', text: 'Lights out 11pm', completed: false },
        ],
      },
    ],
  },
]

const DEFAULT_GOAL_SEEDS: Parameters<typeof seedGoalsIfEmpty>[0] = DEFAULT_GOALS.map((goal) => ({
  name: goal.name,
  color: goal.color,
  surfaceStyle: goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
  starred: Boolean(goal.starred),
  buckets: goal.buckets.map((bucket) => ({
    name: bucket.name,
    favorite: bucket.favorite,
    surfaceStyle: bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
    tasks: bucket.tasks.map((task) => ({
      text: task.text,
      completed: task.completed,
      difficulty: task.difficulty ?? 'none',
      priority: task.priority ?? false,
    })),
  })),
}))

const GOAL_GRADIENTS = [
  'from-fuchsia-500 to-purple-500',
  'from-emerald-500 to-cyan-500',
  'from-lime-400 to-emerald-500',
  'from-sky-500 to-indigo-500',
  'from-amber-400 to-orange-500',
]

const FALLBACK_GOAL_COLOR = GOAL_GRADIENTS[0]

const computeSnapshotSignature = (snapshot: GoalSnapshot[]): string => JSON.stringify(snapshot)

function reconcileGoalsWithSnapshot(snapshot: GoalSnapshot[], current: Goal[]): Goal[] {
  return snapshot.map((goal) => {
    const existingGoal = current.find((item) => item.id === goal.id)
    return {
      id: goal.id,
      name: goal.name,
      color: goal.color ?? existingGoal?.color ?? FALLBACK_GOAL_COLOR,
      surfaceStyle: goal.surfaceStyle,
      starred: goal.starred ?? existingGoal?.starred ?? false,
      customGradient: existingGoal?.customGradient,
      buckets: goal.buckets.map((bucket) => {
        const existingBucket = existingGoal?.buckets.find((item) => item.id === bucket.id)
        return {
          id: bucket.id,
          name: bucket.name,
          favorite: bucket.favorite,
          surfaceStyle: bucket.surfaceStyle,
          tasks: bucket.tasks.map((task) => {
            const existingTask = existingBucket?.tasks.find((item) => item.id === task.id)
            return {
              id: task.id,
              text: task.text,
              completed: task.completed,
              difficulty: task.difficulty,
              priority: task.priority ?? existingTask?.priority ?? false,
            }
          }),
        }
      }),
    }
  })
}

const BASE_GRADIENT_PREVIEW: Record<string, string> = {
  'from-fuchsia-500 to-purple-500': 'linear-gradient(135deg, #f471b5 0%, #a855f7 50%, #6b21a8 100%)',
  'from-emerald-500 to-cyan-500': 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  'from-lime-400 to-emerald-500': 'linear-gradient(135deg, #bef264 0%, #4ade80 45%, #22c55e 100%)',
  'from-sky-500 to-indigo-500': 'linear-gradient(135deg, #38bdf8 0%, #60a5fa 50%, #6366f1 100%)',
  'from-amber-400 to-orange-500': 'linear-gradient(135deg, #fbbf24 0%, #fb923c 45%, #f97316 100%)',
}

const DEFAULT_CUSTOM_GRADIENT_ANGLE = 135

const createCustomGradientString = (from: string, to: string, angle = DEFAULT_CUSTOM_GRADIENT_ANGLE) =>
  `linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`

const DEFAULT_CUSTOM_STOPS = {
  from: '#6366f1',
  to: '#ec4899',
}

const extractStopsFromGradient = (value: string): { from: string; to: string } | null => {
  const matches = value.match(/#(?:[0-9a-fA-F]{3}){1,2}/g)
  if (matches && matches.length >= 2) {
    return {
      from: matches[0],
      to: matches[1],
    }
  }
  return null
}

const GOAL_SURFACE_CLASS_MAP: Record<GoalSurfaceStyle, string> = {
  glass: 'goal-card--glass',
  midnight: 'goal-card--midnight',
  slate: 'goal-card--slate',
  charcoal: 'goal-card--charcoal',
  linen: 'goal-card--linen',
  frost: 'goal-card--frost',
}

const BUCKET_SURFACE_CLASS_MAP: Record<BucketSurfaceStyle, string> = {
  glass: 'goal-bucket-item--surface-glass',
  midnight: 'goal-bucket-item--surface-midnight',
  slate: 'goal-bucket-item--surface-slate',
  charcoal: 'goal-bucket-item--surface-charcoal',
  linen: 'goal-bucket-item--surface-linen',
  frost: 'goal-bucket-item--surface-frost',
}

const GOAL_SURFACE_PRESETS: Array<{
  id: GoalSurfaceStyle
  label: string
  description: string
}> = [
  {
    id: 'glass',
    label: 'Simple',
    description: 'Barely-there wash with a soft outline.',
  },
  {
    id: 'slate',
    label: 'Coastal',
    description: 'Airy blue tint with a gentle fade.',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Cool indigo haze for subtle depth.',
  },
  {
    id: 'charcoal',
    label: 'Cherry',
    description: 'Blush pink highlight with a pastel glow.',
  },
  {
    id: 'linen',
    label: 'Warm',
    description: 'Golden peach accent with gentle warmth.',
  },
  {
    id: 'frost',
    label: 'Frost',
    description: 'Minty aqua highlight with a breezy feel.',
  },
]

const BUCKET_SURFACE_PRESETS: Array<{
  id: BucketSurfaceStyle
  label: string
  description: string
}> = [
  { id: 'glass', label: 'Simple', description: 'Barely-there wash with a soft outline.' },
  { id: 'slate', label: 'Coastal', description: 'Airy blue tint for relaxed columns.' },
  { id: 'midnight', label: 'Midnight', description: 'Cool indigo haze for subtle depth.' },
  { id: 'charcoal', label: 'Cherry', description: 'Blush pink highlight with a pastel glow.' },
  { id: 'linen', label: 'Warm', description: 'Golden peach accent with gentle warmth.' },
  { id: 'frost', label: 'Frost', description: 'Minty aqua highlight with a breezy feel.' },
]

const formatGradientLabel = (value: string) =>
  value
    .replace(/^from-/, '')
    .replace(' to-', ' → ')
    .replace(/-/g, ' ')

// Components
const ThinProgress: React.FC<{ value: number; gradient: string; className?: string }> = ({ value, gradient, className }) => {
  const isCustomGradient = gradient.startsWith('custom:')
  const customGradientValue = isCustomGradient ? gradient.slice(7) : undefined
  return (
    <div className={classNames('h-2 w-full rounded-full bg-white/10 overflow-hidden', className)}>
      <div
        className={classNames(
          'h-full rounded-full goal-progress-fill',
          !isCustomGradient && 'bg-gradient-to-r',
          !isCustomGradient && gradient,
        )}
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          backgroundImage: customGradientValue,
        }}
      />
    </div>
  )
}

interface GoalCustomizerProps {
  goal: Goal
  onUpdate: (updates: GoalAppearanceUpdate) => void
  onClose: () => void
}

const GoalCustomizer = React.forwardRef<HTMLDivElement, GoalCustomizerProps>(({ goal, onUpdate, onClose }, ref) => {
  const surfaceStyle: GoalSurfaceStyle = goal.surfaceStyle ?? 'glass'
  const initialStops = useMemo(() => {
    if (goal.customGradient) {
      return goal.customGradient
    }
    if (goal.color.startsWith('custom:')) {
      const parsed = extractStopsFromGradient(goal.color.slice(7))
      if (parsed) {
        return { ...parsed }
      }
    }
    return { ...DEFAULT_CUSTOM_STOPS }
  }, [goal.color, goal.customGradient])

  const [customStops, setCustomStops] = useState(initialStops)
  const { from: initialFrom, to: initialTo } = initialStops

  useEffect(() => {
    setCustomStops({ from: initialFrom, to: initialTo })
  }, [goal.id, initialFrom, initialTo])

  const customPreview = useMemo(() => createCustomGradientString(customStops.from, customStops.to), [customStops])
  const activeGradient = goal.color.startsWith('custom:') ? 'custom' : goal.color
  const gradientSwatches = useMemo(() => [...GOAL_GRADIENTS, 'custom'], [])
  const gradientPreviewMap = useMemo<Record<string, string>>(
    () => ({
      ...BASE_GRADIENT_PREVIEW,
      custom: customPreview,
    }),
    [customPreview],
  )

  const handleSurfaceSelect = (style: GoalSurfaceStyle) => {
    onUpdate({ surfaceStyle: style })
  }

  const handleGradientSelect = (value: string) => {
    if (value === 'custom') {
      onUpdate({ customGradient: { ...customStops } })
      return
    }
    onUpdate({ color: value, customGradient: null })
  }

  const handleCustomStopChange = (key: 'from' | 'to') => (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value
    setCustomStops((current) => {
      const next = { ...current, [key]: nextValue }
      onUpdate({ customGradient: next })
      return next
    })
  }

  return (
    <div ref={ref} className="goal-customizer" role="region" aria-label={`Customise ${goal.name}`}>
      <div className="goal-customizer__header">
        <div>
          <p className="goal-customizer__title">Personalise</p>
          <p className="goal-customizer__subtitle">Tune the card surface and progress glow.</p>
        </div>
        <button
          type="button"
          className="goal-customizer__close"
          onClick={onClose}
          aria-label="Close customiser"
          data-auto-focus="true"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div className="goal-customizer__section">
        <p className="goal-customizer__label">Card surface</p>
        <div className="goal-customizer__surface-grid">
          {GOAL_SURFACE_PRESETS.map((preset) => {
            const isActive = surfaceStyle === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                className={classNames('goal-customizer__surface', isActive && 'goal-customizer__surface--active')}
                onClick={() => handleSurfaceSelect(preset.id)}
              >
                <span
                  aria-hidden="true"
                  className={classNames('goal-customizer__surface-preview', `goal-customizer__surface-preview--${preset.id}`)}
                />
                <span className="goal-customizer__surface-title">{preset.label}</span>
                <span className="goal-customizer__surface-caption">{preset.description}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="goal-customizer__section">
        <p className="goal-customizer__label">Progress gradient</p>
        <div className="goal-customizer__swatches">
          {gradientSwatches.map((value) => {
            const isCustom = value === 'custom'
            const preview = gradientPreviewMap[value]
            const isActive = activeGradient === value
            return (
              <button
                key={value}
                type="button"
                className={classNames('goal-customizer__swatch', isActive && 'goal-customizer__swatch--active')}
                onClick={() => handleGradientSelect(value)}
                aria-pressed={isActive}
              >
                <span
                  className={classNames('goal-customizer__swatch-fill', isCustom && 'goal-customizer__swatch-fill--custom')}
                  style={{ backgroundImage: preview }}
                  aria-hidden="true"
                >
                  {isCustom ? '∿' : null}
                </span>
                <span className="goal-customizer__swatch-label">
                  {value === 'custom' ? 'Custom' : formatGradientLabel(value)}
                </span>
              </button>
            )
          })}
        </div>
        <div
          className={classNames(
            'goal-customizer__custom-grid',
            activeGradient === 'custom' && 'goal-customizer__custom-grid--active',
          )}
          aria-hidden={activeGradient !== 'custom'}
        >
          <label className="goal-customizer__color-input">
            <span>From</span>
            <input type="color" value={customStops.from} onChange={handleCustomStopChange('from')} aria-label="Custom gradient start colour" />
          </label>
          <label className="goal-customizer__color-input">
            <span>To</span>
            <input type="color" value={customStops.to} onChange={handleCustomStopChange('to')} aria-label="Custom gradient end colour" />
          </label>
          <div className="goal-customizer__custom-preview" style={{ backgroundImage: customPreview }}>
            <span>Preview</span>
          </div>
        </div>
      </div>

      <div className="goal-customizer__footer">
        <button type="button" className="goal-customizer__done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
})

GoalCustomizer.displayName = 'GoalCustomizer'

interface BucketCustomizerProps {
  bucket: Bucket
  onUpdate: (surface: BucketSurfaceStyle) => void
  onClose: () => void
}

const BucketCustomizer = React.forwardRef<HTMLDivElement, BucketCustomizerProps>(
  ({ bucket, onUpdate, onClose }, ref) => {
    const surfaceStyle = normalizeBucketSurfaceStyle(bucket.surfaceStyle)

    return (
      <div ref={ref} className="goal-customizer" role="region" aria-label={`Customise bucket ${bucket.name}`}>
        <div className="goal-customizer__header">
          <div>
            <p className="goal-customizer__title">Bucket surface</p>
            <p className="goal-customizer__subtitle">Pick a card style to match your flow.</p>
          </div>
          <button
            type="button"
            className="goal-customizer__close"
            onClick={onClose}
            aria-label="Close bucket customiser"
            data-auto-focus="true"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="goal-customizer__section">
          <p className="goal-customizer__label">Card surface</p>
          <div className="goal-customizer__surface-grid">
            {BUCKET_SURFACE_PRESETS.map((preset) => {
              const isActive = surfaceStyle === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={classNames('goal-customizer__surface', isActive && 'goal-customizer__surface--active')}
                  onClick={() => onUpdate(preset.id)}
                >
                  <span
                    aria-hidden="true"
                    className={classNames('goal-customizer__surface-preview', `goal-customizer__surface-preview--${preset.id}`)}
                  />
                  <span className="goal-customizer__surface-title">{preset.label}</span>
                  <span className="goal-customizer__surface-caption">{preset.description}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="goal-customizer__footer">
          <button type="button" className="goal-customizer__done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    )
  },
)

BucketCustomizer.displayName = 'BucketCustomizer'

interface GoalRowProps {
  goal: Goal
  isOpen: boolean
  onToggle: () => void
  onDeleteGoal: (goalId: string) => void
  // Goal-level DnD helpers
  onCollapseOtherGoalsForDrag: (draggedGoalId: string) => string[]
  onRestoreGoalsOpenState: (ids: string[]) => void
  // Goal rename
  isRenaming: boolean
  goalRenameValue?: string
  onStartGoalRename: (goalId: string, initial: string) => void
  onGoalRenameChange: (value: string) => void
  onGoalRenameSubmit: () => void
  onGoalRenameCancel: () => void
  // Bucket rename
  renamingBucketId: string | null
  bucketRenameValue: string
  onStartBucketRename: (goalId: string, bucketId: string, initial: string) => void
  onBucketRenameChange: (value: string) => void
  onBucketRenameSubmit: () => void
  onBucketRenameCancel: () => void
  onDeleteBucket: (bucketId: string) => void
  onDeleteCompletedTasks: (bucketId: string) => void
  onToggleBucketFavorite: (bucketId: string) => void
  onUpdateBucketSurface: (goalId: string, bucketId: string, surface: BucketSurfaceStyle) => void
  bucketExpanded: Record<string, boolean>
  onToggleBucketExpanded: (bucketId: string) => void
  completedCollapsed: Record<string, boolean>
  onToggleCompletedCollapsed: (bucketId: string) => void
  taskDetails: TaskDetailsState
  handleToggleTaskDetails: (taskId: string) => void
  handleTaskNotesChange: (taskId: string, value: string) => void
  handleAddSubtask: (taskId: string) => void
  handleSubtaskTextChange: (taskId: string, subtaskId: string, value: string) => void
  handleToggleSubtaskCompleted: (taskId: string, subtaskId: string) => void
  handleRemoveSubtask: (taskId: string, subtaskId: string) => void
  taskDrafts: Record<string, string>
  onStartTaskDraft: (goalId: string, bucketId: string) => void
  onTaskDraftChange: (goalId: string, bucketId: string, value: string) => void
  onTaskDraftSubmit: (goalId: string, bucketId: string, options?: { keepDraft?: boolean }) => void
  onTaskDraftBlur: (goalId: string, bucketId: string) => void
  onTaskDraftCancel: (bucketId: string) => void
  registerTaskDraftRef: (bucketId: string, element: HTMLInputElement | null) => void
  bucketDraftValue?: string
  onStartBucketDraft: (goalId: string) => void
  onBucketDraftChange: (goalId: string, value: string) => void
  onBucketDraftSubmit: (goalId: string, options?: { keepDraft?: boolean }) => void
  onBucketDraftBlur: (goalId: string) => void
  onBucketDraftCancel: (goalId: string) => void
  registerBucketDraftRef: (goalId: string, element: HTMLInputElement | null) => void
  highlightTerm: string
  onToggleTaskComplete: (bucketId: string, taskId: string) => void
  onCycleTaskDifficulty: (bucketId: string, taskId: string) => void
  onToggleTaskPriority: (bucketId: string, taskId: string) => void
  // Editing existing task text
  editingTasks: Record<string, string>
  onStartTaskEdit: (
    goalId: string,
    bucketId: string,
    taskId: string,
    initial: string,
    options?: { caretOffset?: number | null },
  ) => void
  onTaskEditChange: (taskId: string, value: string) => void
  onTaskEditSubmit: (goalId: string, bucketId: string, taskId: string) => void
  onTaskEditBlur: (goalId: string, bucketId: string, taskId: string) => void
  onTaskEditCancel: (taskId: string) => void
  registerTaskEditRef: (taskId: string, element: HTMLSpanElement | null) => void
  focusPromptTarget: FocusPromptTarget | null
  onTaskTextClick: (goalId: string, bucketId: string, taskId: string) => void
  onDismissFocusPrompt: () => void
  onStartFocusTask: (goal: Goal, bucket: Bucket, task: TaskItem) => void
  onReorderTasks: (
    goalId: string,
    bucketId: string,
    section: 'active' | 'completed',
    fromIndex: number,
    toIndex: number,
  ) => void
  onReorderBuckets: (
    goalId: string,
    fromIndex: number,
    toIndex: number,
  ) => void
  onOpenCustomizer: (goalId: string) => void
  activeCustomizerGoalId: string | null
  isStarred: boolean
  onToggleStarred: () => void
}

const GoalRow: React.FC<GoalRowProps> = ({
  goal,
  isOpen,
  onToggle,
  onDeleteGoal,
  onCollapseOtherGoalsForDrag,
  onRestoreGoalsOpenState,
  isRenaming,
  goalRenameValue,
  onStartGoalRename,
  onGoalRenameChange,
  onGoalRenameSubmit,
  onGoalRenameCancel,
  renamingBucketId,
  bucketRenameValue,
  onStartBucketRename,
  onBucketRenameChange,
  onBucketRenameSubmit,
  onBucketRenameCancel,
  onDeleteBucket,
  onDeleteCompletedTasks,
  onToggleBucketFavorite,
  onUpdateBucketSurface,
  bucketExpanded,
  onToggleBucketExpanded,
  completedCollapsed,
  onToggleCompletedCollapsed,
  taskDetails,
  handleToggleTaskDetails,
  handleTaskNotesChange,
  handleAddSubtask,
  handleSubtaskTextChange,
  handleToggleSubtaskCompleted,
  handleRemoveSubtask,
  taskDrafts,
  onStartTaskDraft,
  onTaskDraftChange,
  onTaskDraftSubmit,
  onTaskDraftBlur,
  onTaskDraftCancel,
  registerTaskDraftRef,
  bucketDraftValue,
  onStartBucketDraft,
  onBucketDraftChange,
  onBucketDraftSubmit,
  onBucketDraftBlur,
  onBucketDraftCancel,
  registerBucketDraftRef,
  highlightTerm,
  onToggleTaskComplete,
  onCycleTaskDifficulty,
  onToggleTaskPriority,
  editingTasks,
  onStartTaskEdit,
  onTaskEditChange,
  onTaskEditBlur,
  registerTaskEditRef,
  focusPromptTarget,
  onTaskTextClick,
  onDismissFocusPrompt,
  onStartFocusTask,
  onReorderTasks,
  onReorderBuckets,
  onOpenCustomizer,
  activeCustomizerGoalId,
  isStarred,
  onToggleStarred,
}) => {
  const [dragHover, setDragHover] = useState<
    | { bucketId: string; section: 'active' | 'completed'; index: number }
    | null
  >(null)
  const dragCloneRef = useRef<HTMLElement | null>(null)
  const [dragLine, setDragLine] = useState<
    | { bucketId: string; section: 'active' | 'completed'; top: number }
    | null
  >(null)
  const [bucketHoverIndex, setBucketHoverIndex] = useState<number | null>(null)
  const [bucketLineTop, setBucketLineTop] = useState<number | null>(null)
  const bucketDragCloneRef = useRef<HTMLElement | null>(null)
  // Transient animation state for task completion (active → completed)
  const [completingMap, setCompletingMap] = useState<Record<string, boolean>>({})
  const completingKey = (bucketId: string, taskId: string) => `${bucketId}:${taskId}`
  
  // Long-press to toggle priority on the difficulty dot
  const PRIORITY_HOLD_MS = 300
  const longPressTimersRef = useRef<Map<string, number>>(new Map())
  const longPressTriggeredRef = useRef<Set<string>>(new Set())

  // FLIP animation for moving task to top
  const taskRowRefs = useRef(new Map<string, HTMLLIElement>())
  const registerTaskRowRef = (taskId: string, el: HTMLLIElement | null) => {
    if (el) taskRowRefs.current.set(taskId, el)
    else taskRowRefs.current.delete(taskId)
  }
  const flipStartRectsRef = useRef(new Map<string, DOMRect>())
  const prepareFlipForTask = (taskId: string) => {
    const el = taskRowRefs.current.get(taskId)
    if (!el) return
    try {
      flipStartRectsRef.current.set(taskId, el.getBoundingClientRect())
    } catch {}
  }
  const runFlipForTask = (taskId: string) => {
    const el = taskRowRefs.current.get(taskId)
    const start = flipStartRectsRef.current.get(taskId)
    if (!el || !start) return
    try {
      const end = el.getBoundingClientRect()
      const dx = start.left - end.left
      const dy = start.top - end.top
      // If no movement, skip
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      el.style.willChange = 'transform'
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      // Flush
      void el.getBoundingClientRect()
      el.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)'
      el.style.transform = 'translate(0, 0)'
      const cleanup = () => {
        el.style.transition = ''
        el.style.transform = ''
        el.style.willChange = ''
      }
      el.addEventListener('transitionend', cleanup, { once: true })
      // Fallback cleanup
      window.setTimeout(cleanup, 420)
    } catch {}
  }
  

  // Preserve original transparency — no conversion to opaque

  const computeInsertIndex = (listEl: HTMLElement, y: number) => {
    const rows = Array.from(listEl.querySelectorAll('li.goal-task-row')) as HTMLElement[]
    const candidates = rows.filter(
      (el) =>
        !el.classList.contains('dragging') &&
        !el.classList.contains('goal-task-row--placeholder') &&
        !el.classList.contains('goal-task-row--collapsed'),
    )
    if (candidates.length === 0) return 0

    const rects = candidates.map((el) => el.getBoundingClientRect())
    // Build gap anchors: before first, between rows (midpoints), after last
    const anchors: Array<{ y: number; index: number }> = []
    anchors.push({ y: rects[0].top, index: 0 })
    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i]
      const b = rects[i + 1]
      const mid = a.bottom + (b.top - a.bottom) / 2
      anchors.push({ y: mid, index: i + 1 })
    }
    anchors.push({ y: rects[rects.length - 1].bottom, index: rects.length })

    // Pick the nearest anchor to the cursor Y
    let best = anchors[0]
    let bestDist = Math.abs(y - best.y)
    for (let i = 1; i < anchors.length; i++) {
      const d = Math.abs(y - anchors[i].y)
      if (d < bestDist) {
        best = anchors[i]
        bestDist = d
      }
    }
    return best.index
  }

  // Copy key visual styles so the drag clone matches layered backgrounds and borders
  const copyVisualStyles = (src: HTMLElement, dst: HTMLElement) => {
    const rowCS = window.getComputedStyle(src)
    const isTaskRow = src.classList.contains('goal-task-row') || dst.classList.contains('goal-task-row')

    if (isTaskRow) {
      const taskVars = ['--task-row-bg', '--task-row-overlay', '--task-row-border', '--task-row-shadow', '--priority-overlay']
      for (const name of taskVars) {
        const value = rowCS.getPropertyValue(name)
        const trimmed = value.trim()
        if (trimmed) {
          dst.style.setProperty(name, trimmed)
        } else {
          dst.style.removeProperty(name)
        }
      }

      dst.style.backgroundColor = rowCS.backgroundColor
      dst.style.backgroundImage = rowCS.backgroundImage && rowCS.backgroundImage !== 'none' ? rowCS.backgroundImage : 'none'
      dst.style.backgroundSize = rowCS.backgroundSize
      dst.style.backgroundPosition = rowCS.backgroundPosition
      dst.style.backgroundRepeat = rowCS.backgroundRepeat
      dst.style.borderColor = rowCS.borderColor
      dst.style.borderWidth = rowCS.borderWidth
      dst.style.borderStyle = rowCS.borderStyle
      dst.style.borderRadius = rowCS.borderRadius
      dst.style.boxShadow = rowCS.boxShadow
      dst.style.outline = rowCS.outline
      dst.style.color = rowCS.color
      dst.style.opacity = rowCS.opacity

      return
    }

    const parseColor = (value: string) => {
      const s = (value || '').trim().toLowerCase()
      let m = s.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/)
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, +m[4])) }
      m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: 1 }
      m = s.match(/^#([0-9a-f]{6})$/)
      if (m) {
        const n = parseInt(m[1], 16)
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
      }
      return { r: 0, g: 0, b: 0, a: 0 }
    }
    const toCssRgb = (c: { r: number; g: number; b: number }) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
    const over = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number; a: number }) => {
      const a = top.a + under.a * (1 - top.a)
      if (a === 0) return { r: under.r, g: under.g, b: under.b, a }
      return {
        r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
        g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
        b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
        a,
      }
    }
    // Known layers: page base, goal card, bucket body, row surface
    const themeBase = document.documentElement.getAttribute('data-theme') === 'light'
      ? parseColor('rgb(248, 250, 255)')
      : parseColor('rgb(16, 20, 36)')

    const cardEl = src.closest('.goal-card') as HTMLElement | null
    const cardCS = cardEl ? window.getComputedStyle(cardEl) : null

    // Compose colors: page -> card -> bucket -> row
    // Helper to apply layer with its own opacity
    const withOpacity = (colorStr: string, opacityStr: string) => {
      const c = parseColor(colorStr)
      const o = Math.max(0, Math.min(1, parseFloat(opacityStr || '1')))
      return { r: c.r, g: c.g, b: c.b, a: (c.a ?? 1) * o }
    }
    let base = themeBase
    // Compose page and known containers (falling back to theme mid-tones if fully transparent)

    

    // Compose base strictly from theme base + goal entry (card) to avoid overly dark appearance in dark mode
    // Start at theme base only
    base = themeBase
    // Blend goal card (entry) over theme base if present
    if (cardCS) {
      base = over(withOpacity(cardCS.backgroundColor, cardCS.opacity), base)
    }
    // Finally, flatten the row surface over the entry so the clone looks like in-list
    base = over(withOpacity(rowCS.backgroundColor, rowCS.opacity), base)

    // Apply computed backgrounds
    dst.style.backgroundImage = rowCS.backgroundImage && rowCS.backgroundImage !== 'none' ? rowCS.backgroundImage : 'none'
    dst.style.backgroundSize = rowCS.backgroundSize
    dst.style.backgroundPosition = rowCS.backgroundPosition
    dst.style.backgroundRepeat = rowCS.backgroundRepeat
    dst.style.backgroundColor = toCssRgb(base)
    // Match overall element opacity
    dst.style.opacity = rowCS.opacity

    // Borders / radius / shadows / text
    dst.style.borderColor = rowCS.borderColor
    dst.style.borderWidth = rowCS.borderWidth
    dst.style.borderStyle = rowCS.borderStyle
    dst.style.borderRadius = rowCS.borderRadius
    dst.style.boxShadow = rowCS.boxShadow
    dst.style.outline = rowCS.outline
    dst.style.color = rowCS.color
  }

  const computeInsertMetrics = (listEl: HTMLElement, y: number) => {
    const index = computeInsertIndex(listEl, y)
    const rows = Array.from(listEl.querySelectorAll('li.goal-task-row')) as HTMLElement[]
    const candidates = rows.filter(
      (el) =>
        !el.classList.contains('dragging') &&
        !el.classList.contains('goal-task-row--placeholder') &&
        !el.classList.contains('goal-task-row--collapsed'),
    )
    const listRect = listEl.getBoundingClientRect()
    let rawTop = 0
    if (candidates.length === 0 || index <= 0) {
      // With 8px container padding, place line 3.5px from the top edge
      rawTop = 3.5
    } else if (index >= candidates.length) {
      // With 8px container padding, place line 3.5px from the bottom edge
      rawTop = listRect.height - 4.5 // (3.5px space + 1px line)
    } else {
      const prev = candidates[index - 1]
      const next = candidates[index]
      const a = prev.getBoundingClientRect()
      const b = next.getBoundingClientRect()
      const gap = Math.max(0, b.top - a.bottom)
      // Center a 1px line within the actual gap: (gap - 1) / 2 from the top edge
      rawTop = a.bottom - listRect.top + (gap - 1) / 2
    }
    // Keep the line within the list box now that the container has padding
    const clamped = Math.max(0.5, Math.min(rawTop, listRect.height - 0.5))
    // Snap to nearest 0.5px for crisp 1px rendering while preserving centering
    const top = Math.round(clamped * 2) / 2
    return { index, top }
  }
  const computeBucketInsertMetrics = (listEl: HTMLElement, y: number) => {
    const items = Array.from(listEl.querySelectorAll('li.goal-bucket-item')) as HTMLElement[]
    const candidates = items.filter(
      (el) => !el.classList.contains('dragging') && !el.classList.contains('goal-bucket-item--collapsed'),
    )
    const listRect = listEl.getBoundingClientRect()
    const cs = window.getComputedStyle(listEl)
    const padTop = parseFloat(cs.paddingTop || '0') || 0
    const padBottom = parseFloat(cs.paddingBottom || '0') || 0
    if (candidates.length === 0) {
      const rawTop = (padTop - 1) / 2
      const clamped = Math.max(0.5, Math.min(rawTop, listRect.height - 0.5))
      const top = Math.round(clamped * 2) / 2
      return { index: 0, top }
    }
    const rects = candidates.map((el) => el.getBoundingClientRect())
    const anchors: Array<{ y: number; index: number }> = []
    anchors.push({ y: rects[0].top, index: 0 })
    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i]
      const b = rects[i + 1]
      const mid = a.bottom + (b.top - a.bottom) / 2
      anchors.push({ y: mid, index: i + 1 })
    }
    anchors.push({ y: rects[rects.length - 1].bottom, index: rects.length })

    let best = anchors[0]
    let bestDist = Math.abs(y - best.y)
    for (let i = 1; i < anchors.length; i++) {
      const d = Math.abs(y - anchors[i].y)
      if (d < bestDist) {
        best = anchors[i]
        bestDist = d
      }
    }
    let rawTop = 0
    if (best.index <= 0) {
      // Center within top padding
      rawTop = (padTop - 1) / 2
    } else if (best.index >= candidates.length) {
      // Center within bottom padding relative to last visible item
      const last = candidates[candidates.length - 1]
      const a = last.getBoundingClientRect()
      rawTop = a.bottom - listRect.top + (padBottom - 1) / 2
    } else {
      const prev = candidates[best.index - 1]
      const next = candidates[best.index]
      const a = prev.getBoundingClientRect()
      const b = next.getBoundingClientRect()
      const gap = Math.max(0, b.top - a.bottom)
      rawTop = a.bottom - listRect.top + (gap - 1) / 2
    }
    const clamped = Math.max(0.5, Math.min(rawTop, listRect.height - 0.5))
    const top = Math.round(clamped * 2) / 2
    return { index: best.index, top }
  }
  const totalTasks = goal.buckets.reduce((acc, bucket) => acc + bucket.tasks.length, 0)
  const completedTasksCount = goal.buckets.reduce(
    (acc, bucket) => acc + bucket.tasks.filter((task) => task.completed).length,
    0,
  )
  const pct = totalTasks === 0 ? 0 : Math.round((completedTasksCount / totalTasks) * 100)
  const progressLabel = totalTasks > 0 ? `${completedTasksCount} / ${totalTasks} tasks` : 'No tasks yet'
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const [bucketMenuOpenId, setBucketMenuOpenId] = useState<string | null>(null)
  const bucketMenuRef = useRef<HTMLDivElement | null>(null)
  const bucketMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [bucketMenuPosition, setBucketMenuPosition] = useState({ left: 0, top: 0 })
  const [bucketMenuPositionReady, setBucketMenuPositionReady] = useState(false)
  const [activeBucketCustomizerId, setActiveBucketCustomizerId] = useState<string | null>(null)
  const bucketCustomizerDialogRef = useRef<HTMLDivElement | null>(null)
  const activeBucketCustomizer = useMemo(() => {
    if (!activeBucketCustomizerId) return null
    return goal.buckets.find((bucket) => bucket.id === activeBucketCustomizerId) ?? null
  }, [goal.buckets, activeBucketCustomizerId])
  const closeBucketCustomizer = useCallback(() => setActiveBucketCustomizerId(null), [])
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const bucketRenameInputRef = useRef<HTMLInputElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [menuPositionReady, setMenuPositionReady] = useState(false)

  const updateMenuPosition = useCallback(() => {
    const trigger = menuButtonRef.current
    const menuEl = menuRef.current
    if (!trigger || !menuEl) {
      return
    }
    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menuEl.getBoundingClientRect()
    const spacing = 12
    let left = triggerRect.right - menuRect.width
    let top = triggerRect.bottom + spacing
    if (left < spacing) {
      left = spacing
    }
    if (top + menuRect.height > window.innerHeight - spacing) {
      top = Math.max(spacing, triggerRect.top - spacing - menuRect.height)
    }
    if (top < spacing) {
      top = spacing
    }
    if (left + menuRect.width > window.innerWidth - spacing) {
      left = Math.max(spacing, window.innerWidth - spacing - menuRect.width)
    }
    setMenuPosition((prev) => {
      if (Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5) {
        return prev
      }
      return { left, top }
    })
    setMenuPositionReady(true)
  }, [])

  const updateBucketMenuPosition = useCallback(() => {
    const anchor = bucketMenuAnchorRef.current
    const menuEl = bucketMenuRef.current
    if (!anchor || !menuEl) {
      return
    }
    const triggerRect = anchor.getBoundingClientRect()
    const menuRect = menuEl.getBoundingClientRect()
    const spacing = 12
    let top = triggerRect.bottom + spacing
    let left = triggerRect.right - menuRect.width
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    if (left + menuRect.width > viewportWidth - spacing) {
      left = Math.max(spacing, viewportWidth - spacing - menuRect.width)
    }
    if (left < spacing) {
      left = spacing
    }
    if (top + menuRect.height > viewportHeight - spacing) {
      top = Math.max(spacing, triggerRect.top - spacing - menuRect.height)
    }
    if (top < spacing) {
      top = spacing
    }
    setBucketMenuPosition((prev) => {
      if (Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5) {
        return prev
      }
      return { left, top }
    })
    setBucketMenuPositionReady(true)
  }, [])

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const handleDocClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuWrapRef.current && menuWrapRef.current.contains(target)) return
      if (menuRef.current && menuRef.current.contains(target)) return
      setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!bucketMenuOpenId) {
      setBucketMenuPositionReady(false)
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBucketMenuOpenId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    setBucketMenuPositionReady(false)
    const raf = requestAnimationFrame(() => {
      updateBucketMenuPosition()
    })
    const handleRelayout = () => updateBucketMenuPosition()
    window.addEventListener('resize', handleRelayout)
    window.addEventListener('scroll', handleRelayout, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleRelayout)
      window.removeEventListener('scroll', handleRelayout, true)
    }
  }, [bucketMenuOpenId, updateBucketMenuPosition])

  useEffect(() => {
    if (!bucketMenuOpenId) {
      bucketMenuAnchorRef.current = null
    }
  }, [bucketMenuOpenId])

  useEffect(() => {
    if (activeBucketCustomizerId && !activeBucketCustomizer) {
      setActiveBucketCustomizerId(null)
    }
  }, [activeBucketCustomizerId, activeBucketCustomizer])

  useEffect(() => {
    if (!activeBucketCustomizerId) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveBucketCustomizerId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeBucketCustomizerId])

  useEffect(() => {
    if (!activeBucketCustomizerId) {
      return
    }
    if (typeof document === 'undefined') {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [activeBucketCustomizerId])

  useEffect(() => {
    if (!activeBucketCustomizerId) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const dialog = bucketCustomizerDialogRef.current
      if (!dialog) {
        return
      }
      const target = dialog.querySelector<HTMLElement>(
        '[data-auto-focus="true"], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      target?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeBucketCustomizerId])

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      const el = renameInputRef.current
      const len = el.value.length
      el.focus()
      el.setSelectionRange(len, len)
    }
  }, [isRenaming])

  useEffect(() => {
    if (renamingBucketId && bucketRenameInputRef.current) {
      const el = bucketRenameInputRef.current
      const len = el.value.length
      el.focus()
      el.setSelectionRange(len, len)
    }
  }, [renamingBucketId])

  useEffect(() => {
    if (!menuOpen) {
      setMenuPositionReady(false)
      return
    }
    setMenuPositionReady(false)
    const raf = requestAnimationFrame(() => {
      updateMenuPosition()
    })
    const handleRelayout = () => updateMenuPosition()
    window.addEventListener('resize', handleRelayout)
    window.addEventListener('scroll', handleRelayout, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleRelayout)
      window.removeEventListener('scroll', handleRelayout, true)
    }
  }, [menuOpen, updateMenuPosition])

  const surfaceStyle = goal.surfaceStyle ?? 'glass'
  const surfaceClass = GOAL_SURFACE_CLASS_MAP[surfaceStyle] || GOAL_SURFACE_CLASS_MAP.glass
  const isCustomizerOpen = activeCustomizerGoalId === goal.id

  const menuPortal =
    menuOpen && typeof document !== 'undefined'
      ? createPortal(
          <div className="goal-menu-overlay" role="presentation" onClick={() => setMenuOpen(false)}>
            <div
              ref={menuRef}
              className="goal-menu goal-menu--floating min-w-[160px] rounded-md border p-1 shadow-lg"
              style={{
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
                visibility: menuPositionReady ? 'visible' : 'hidden',
              }}
              role="menu"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="goal-menu__item"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onOpenCustomizer(goal.id)
                }}
              >
                Customise
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onStartGoalRename(goal.id, goal.name)
                }}
              >
                Rename
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item goal-menu__item--danger"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onDeleteGoal(goal.id)
                }}
                aria-label="Delete goal"
              >
                Delete goal
              </button>
            </div>
          </div>,
          document.body,
        )
      : null

  const activeBucketForMenu = useMemo(() => {
    if (!bucketMenuOpenId) {
      return null
    }
    return goal.buckets.find((bucket) => bucket.id === bucketMenuOpenId) ?? null
  }, [goal.buckets, bucketMenuOpenId])

  const activeBucketCompletedCount = activeBucketForMenu
    ? activeBucketForMenu.tasks.filter((task) => task.completed).length
    : 0

  const bucketMenuPortal =
    bucketMenuOpenId && activeBucketForMenu && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="goal-menu-overlay"
            role="presentation"
            onMouseDown={(event) => {
              event.stopPropagation()
              setBucketMenuOpenId(null)
            }}
          >
            <div
              ref={bucketMenuRef}
              className="goal-menu goal-menu--floating min-w-[180px] rounded-md border p-1 shadow-lg"
              style={{
                top: `${bucketMenuPosition.top}px`,
                left: `${bucketMenuPosition.left}px`,
                visibility: bucketMenuPositionReady ? 'visible' : 'hidden',
              }}
              role="menu"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="goal-menu__item"
                onClick={(event) => {
                  event.stopPropagation()
                  setBucketMenuOpenId(null)
                  setActiveBucketCustomizerId(activeBucketForMenu.id)
                }}
              >
                Customise
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item"
                onClick={(event) => {
                  event.stopPropagation()
                  setBucketMenuOpenId(null)
                  onStartBucketRename(goal.id, activeBucketForMenu.id, activeBucketForMenu.name)
                }}
              >
                Rename
              </button>
              <button
                type="button"
                disabled={activeBucketCompletedCount === 0}
                aria-disabled={activeBucketCompletedCount === 0}
                className={classNames('goal-menu__item', activeBucketCompletedCount === 0 && 'opacity-50 cursor-not-allowed')}
                onClick={(event) => {
                  if (activeBucketCompletedCount === 0) {
                    return
                  }
                  event.stopPropagation()
                  setBucketMenuOpenId(null)
                  onDeleteCompletedTasks(activeBucketForMenu.id)
                }}
              >
                Delete all completed tasks
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item goal-menu__item--danger"
                onClick={(event) => {
                  event.stopPropagation()
                  setBucketMenuOpenId(null)
                  onDeleteBucket(activeBucketForMenu.id)
                }}
              >
                Delete bucket
              </button>
            </div>
          </div>,
          document.body,
        )
      : null

  const bucketCustomizerPortal =
    activeBucketCustomizer && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="goal-customizer-overlay"
            role="presentation"
            onMouseDown={(event) => {
              event.stopPropagation()
              closeBucketCustomizer()
            }}
          >
            <div
              ref={bucketCustomizerDialogRef}
              className="goal-customizer-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Customise bucket ${activeBucketCustomizer.name}`}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <BucketCustomizer
                bucket={activeBucketCustomizer}
                onUpdate={(surface) => onUpdateBucketSurface(goal.id, activeBucketCustomizer.id, surface)}
                onClose={closeBucketCustomizer}
              />
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div className={classNames('goal-card', surfaceClass, isCustomizerOpen && 'goal-card--customizing', isStarred && 'goal-card--favorite')}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          if (target && target.closest('input, textarea, [contenteditable="true"]')) {
            return
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className="goal-header-toggle w-full text-left p-4 md:p-5"
        draggable
          onDragStart={(e) => {
          try { e.dataTransfer.setData('text/plain', goal.id) } catch {}
          const headerEl = e.currentTarget as HTMLElement
          const container = headerEl.closest('li.goal-entry') as HTMLElement | null
          container?.classList.add('dragging')
          // Clone visible header for ghost image; copy visuals from the card wrapper for accurate background/border
          const srcCard = (container?.querySelector('.goal-card') as HTMLElement | null) ?? headerEl
          const srcRect = (srcCard ?? headerEl).getBoundingClientRect()
          const clone = headerEl.cloneNode(true) as HTMLElement
          clone.className = headerEl.className + ' goal-bucket-drag-clone'
          clone.style.width = `${Math.floor(srcRect.width)}px`
          copyVisualStyles(srcCard as HTMLElement, clone)
          document.body.appendChild(clone)
          ;(window as any).__goalDragCloneRef = clone
          // Anchor drag hotspot to the top-left like bucket/task drags
          try { e.dataTransfer.setDragImage(clone, 16, 0) } catch {}
          // Snapshot open state for this goal and collapse after drag image snapshot
          ;(window as any).__dragGoalInfo = { goalId: goal.id, wasOpen: isOpen } as {
            goalId: string
            wasOpen?: boolean
            openIds?: string[]
          }
          const scheduleCollapse = () => {
            if (isOpen) {
              onToggle()
            }
            // Close all other open goals during drag and remember them for restoration
            const othersOpen = onCollapseOtherGoalsForDrag(goal.id)
            const info = (window as any).__dragGoalInfo as { goalId: string; wasOpen?: boolean; openIds?: string[] }
            info.openIds = othersOpen
            container?.classList.add('goal-entry--collapsed')
          }
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(scheduleCollapse)
            })
          } else {
            setTimeout(scheduleCollapse, 0)
          }
          try { e.dataTransfer.effectAllowed = 'move' } catch {}
        }}
        onDragEnd={(e) => {
          const headerEl = e.currentTarget as HTMLElement
          const container = headerEl.closest('li.goal-entry') as HTMLElement | null
          container?.classList.remove('dragging')
          container?.classList.remove('goal-entry--collapsed')
          const info = (window as any).__dragGoalInfo as | { goalId: string; wasOpen?: boolean; openIds?: string[] } | null
          if (info && info.goalId === goal.id) {
            if (info.openIds && info.openIds.length > 0) {
              onRestoreGoalsOpenState(info.openIds)
            }
            if (info.wasOpen) {
              onRestoreGoalsOpenState([goal.id])
            }
          }
          const ghost = (window as any).__goalDragCloneRef as HTMLElement | null
          if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost)
          ;(window as any).__goalDragCloneRef = null
          ;(window as any).__dragGoalInfo = null
        }}
      >
        <div className="flex flex-nowrap items-center justify-between gap-2">
          {(() => {
            const name = goal.name || ''
            const words = name.trim().split(/\s+/).filter(Boolean)
            const isLong = name.length > 28 || words.length > 6
            const titleSize = isLong ? 'text-sm sm:text-base md:text-lg' : 'text-base sm:text-lg md:text-xl'
            const inputSize = isLong ? 'text-sm sm:text-base md:text-lg' : 'text-base sm:text-lg md:text-xl'
            return (
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <button
                  type="button"
                  className={classNames('goal-favorite-toggle', isStarred && 'goal-favorite-toggle--active')}
                  aria-pressed={isStarred}
                  aria-label={isStarred ? 'Remove goal from favourites' : 'Add goal to favourites'}
                  title={isStarred ? 'Unfavourite goal' : 'Favourite goal'}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleStarred()
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDragStart={(event) => event.preventDefault()}
                  data-starred={isStarred ? 'true' : 'false'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="goal-favorite-toggle__icon">
                    {isStarred ? (
                      <path d="M12 17.27 18.18 21 16.54 13.97 22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                    ) : (
                      <path
                        d="M12 17.27 18.18 21 16.54 13.97 22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                    )}
                  </svg>
                </button>
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={goalRenameValue ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onGoalRenameChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onGoalRenameSubmit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          onGoalRenameCancel()
                        }
                      }}
                      onBlur={() => onGoalRenameSubmit()}
                      placeholder="Rename goal"
                      className={classNames(
                        'w-full bg-transparent border border-white/15 focus:border-white/30 rounded-md px-2 py-1 font-semibold tracking-tight outline-none',
                        inputSize,
                      )}
                    />
                  ) : (
                    <h3 className={classNames('min-w-0 whitespace-nowrap truncate font-semibold tracking-tight', titleSize)}>
                      {highlightText(goal.name, highlightTerm)}
                    </h3>
                  )}
                </div>
              </div>
            )
          })()}
          <div ref={menuWrapRef} className="relative flex items-center gap-2 flex-none whitespace-nowrap" data-goal-menu="true">
            <svg className={classNames('w-4 h-4 goal-chevron-icon transition-transform', isOpen && 'rotate-90')} viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M8.47 4.97a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L13.94 12 8.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd"/>
            </svg>
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
              ref={menuButtonRef}
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Goal actions"
            >
              <svg className="w-4.5 h-4.5 goal-kebab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="6" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="18" r="1.6" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 flex-nowrap">
          <ThinProgress value={pct} gradient={goal.color} className="h-1 flex-1 min-w-0" />
          <span className="text-xs sm:text-sm text-white/80 whitespace-nowrap flex-none">{progressLabel}</span>
        </div>

      </div>

      {isOpen && (
        <div className="px-4 md:px-5 pb-4 md:pb-5">
          <div className="mt-3 md:mt-4">
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h4 className="goal-subheading">Task Bank</h4>
              <button onClick={() => onStartBucketDraft(goal.id)} className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 whitespace-nowrap">+ Add Bucket</button>
            </div>

            <p className="mt-2 text-xs text-white/60">Buckets surface in Stopwatch when <span className="text-white">Favourited</span>.</p>

            <ul
              className="goal-bucket-list mt-3 md:mt-4 space-y-2"
              onDragOver={(e) => {
                const info = (window as any).__dragBucketInfo as
                  | { goalId: string; index: number; bucketId: string; wasOpen?: boolean }
                  | null
                if (!info) return
                if (info.goalId !== goal.id) return
                e.preventDefault()
                try { e.dataTransfer.dropEffect = 'move' } catch {}
                const list = e.currentTarget as HTMLElement
                const { index, top } = computeBucketInsertMetrics(list, e.clientY)
                setBucketHoverIndex((cur) => (cur === index ? cur : index))
                setBucketLineTop(top)
              }}
              onDrop={(e) => {
                const info = (window as any).__dragBucketInfo as
                  | { goalId: string; index: number; bucketId: string; wasOpen?: boolean; openIds?: string[] }
                  | null
                if (!info) return
                if (info.goalId !== goal.id) return
                e.preventDefault()
                const fromIndex = info.index
                const toIndex = bucketHoverIndex ?? fromIndex
                if (fromIndex !== toIndex) {
                  onReorderBuckets(goal.id, fromIndex, toIndex)
                }
                // Restore all buckets that were originally open at drag start
                if (info.openIds && info.openIds.length > 0) {
                  for (const id of info.openIds) {
                    if (!(bucketExpanded[id] ?? false)) {
                      onToggleBucketExpanded(id)
                    }
                  }
                }
                setBucketHoverIndex(null)
                setBucketLineTop(null)
                ;(window as any).__dragBucketInfo = null
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setBucketHoverIndex(null)
                setBucketLineTop(null)
              }}
            >
              {bucketLineTop !== null ? (
                <div className="goal-insert-line" style={{ top: `${bucketLineTop}px` }} aria-hidden />
              ) : null}
              {bucketDraftValue !== undefined && (
                <li className="goal-bucket-draft" key="bucket-draft">
                  <div className="goal-bucket-draft-inner">
                    <input
                      ref={(element) => registerBucketDraftRef(goal.id, element)}
                      value={bucketDraftValue}
                      onChange={(event) => onBucketDraftChange(goal.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          onBucketDraftSubmit(goal.id, { keepDraft: true })
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          onBucketDraftCancel(goal.id)
                        }
                      }}
                      onBlur={() => onBucketDraftBlur(goal.id)}
                      placeholder="New bucket"
                      className="goal-bucket-draft-input"
                    />
                  </div>
                </li>
              )}
              {goal.buckets.map((b, index) => {
                const isBucketOpen = bucketExpanded[b.id] ?? false
                const activeTasks = b.tasks.filter((task) => !task.completed)
                const completedTasks = b.tasks.filter((task) => task.completed)
                const isCompletedCollapsed = completedCollapsed[b.id] ?? true
                const draftValue = taskDrafts[b.id]
                const bucketSurface = normalizeBucketSurfaceStyle(b.surfaceStyle as BucketSurfaceStyle | null | undefined)
                const bucketSurfaceClass = BUCKET_SURFACE_CLASS_MAP[bucketSurface] || BUCKET_SURFACE_CLASS_MAP.glass
                return (
                  <li key={b.id} className={classNames('goal-bucket-item rounded-xl border', bucketSurfaceClass)}>
                    <div
                      className="goal-bucket-toggle p-3 md:p-4 flex items-center justify-between gap-3 md:gap-4"
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => {
                        try { e.dataTransfer.setData('text/plain', b.id) } catch {}
                        const headerEl = e.currentTarget as HTMLElement
                        const container = headerEl.closest('li') as HTMLElement | null
                        container?.classList.add('dragging')
                        // Clone the visible header so the ghost matches the bucket element
                        const srcEl = (container ?? headerEl) as HTMLElement
                        const rect = srcEl.getBoundingClientRect()
                        const clone = headerEl.cloneNode(true) as HTMLElement
                        clone.className = headerEl.className + ' goal-bucket-drag-clone'
                        clone.style.width = `${Math.floor(rect.width)}px`
                        copyVisualStyles(srcEl, clone)
                        document.body.appendChild(clone)
                        bucketDragCloneRef.current = clone
                        try { e.dataTransfer.setDragImage(clone, 16, 0) } catch {}
                        // Snapshot which buckets in this goal were open BEFORE any state changes
                        const openIds = goal.buckets.filter((bx) => bucketExpanded[bx.id]).map((bx) => bx.id)
                        ;(window as any).__dragBucketInfo = { goalId: goal.id, index, bucketId: b.id, wasOpen: isBucketOpen, openIds }
                        // Defer state changes (collapse buckets + source) until next frames so the browser captures drag image
                        const scheduleCollapse = () => {
                          // Close original if it was open
                          if (isBucketOpen) {
                            onToggleBucketExpanded(b.id)
                          }
                          // Close all other open buckets during drag for consistent view
                          for (const id of openIds) {
                            if (id !== b.id) {
                              onToggleBucketExpanded(id)
                            }
                          }
                          // Collapse original item so it visually leaves the list
                          container?.classList.add('goal-bucket-item--collapsed')
                        }
                        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                          window.requestAnimationFrame(() => {
                            window.requestAnimationFrame(scheduleCollapse)
                          })
                        } else {
                          setTimeout(scheduleCollapse, 0)
                        }
                        try {
                          e.dataTransfer.effectAllowed = 'move'
                        } catch {}
                      }}
                      onDragEnd={(e) => {
                        const container = (e.currentTarget as HTMLElement).closest('li') as HTMLElement | null
                        container?.classList.remove('dragging')
                        container?.classList.remove('goal-bucket-item--collapsed')
                        setBucketHoverIndex(null)
                        setBucketLineTop(null)
                        // If drop didn't restore, restore here using snapshot
                        const info = (window as any).__dragBucketInfo as
                          | { goalId: string; bucketId: string; wasOpen?: boolean; openIds?: string[] }
                          | null
                        if (info && info.goalId === goal.id) {
                          if (info.openIds && info.openIds.length > 0) {
                            for (const id of info.openIds) {
                              if (!(bucketExpanded[id] ?? false)) {
                                onToggleBucketExpanded(id)
                              }
                            }
                          }
                        }
                        const ghost = bucketDragCloneRef.current
                        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost)
                        bucketDragCloneRef.current = null
                        ;(window as any).__dragBucketInfo = null
                      }}
                      onClick={() => onToggleBucketExpanded(b.id)}
                      onKeyDown={(event) => {
                        const tgt = event.target as HTMLElement
                        if (tgt && (tgt.closest('input, textarea, [contenteditable="true"]'))) {
                          return
                        }
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onToggleBucketExpanded(b.id)
                        }
                      }}
                      aria-expanded={isBucketOpen}
                    >
                      <div className="goal-bucket-header-info">
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            onToggleBucketFavorite(b.id)
                          }}
                          className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-white/10 transition"
                          aria-label={b.favorite ? 'Unfavourite' : 'Favourite'}
                          title={b.favorite ? 'Unfavourite' : 'Favourite'}
                        >
                          {b.favorite ? (
                            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M12 21c-4.84-3.52-9-7.21-9-11.45C3 6.02 5.05 4 7.5 4c1.74 0 3.41.81 4.5 2.09C13.09 4.81 14.76 4 16.5 4 18.95 4 21 6.02 21 9.55 21 13.79 16.84 17.48 12 21z" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4 text-white/80" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path
                                d="M12 21c-4.84-3.52-9-7.21-9-11.45C3 6.02 5.05 4 7.5 4c1.74 0 3.41.81 4.5 2.09C13.09 4.81 14.76 4 16.5 4 18.95 4 21 6.02 21 9.55 21 13.79 16.84 17.48 12 21z"
                                stroke="currentColor"
                                strokeWidth="1.75"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                        {renamingBucketId === b.id ? (
                          <input
                            ref={bucketRenameInputRef}
                            value={bucketRenameValue}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onBucketRenameChange(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                onBucketRenameSubmit()
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                onBucketRenameCancel()
                              }
                            }}
                            onBlur={() => onBucketRenameSubmit()}
                            className="ml-2 w-[14rem] max-w-[60vw] bg-transparent border border-white/15 focus:border-white/30 rounded px-2 py-1 text-sm font-medium outline-none"
                            placeholder="Rename bucket"
                          />
                        ) : (
                          <span className="goal-bucket-title font-medium truncate">{highlightText(b.name, highlightTerm)}</span>
                        )}
                      </div>
                      <div className="relative flex items-center gap-2">
                        <svg
                          className={classNames('w-3.5 h-3.5 goal-chevron-icon transition-transform', isBucketOpen && 'rotate-90')}
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path fillRule="evenodd" d="M8.47 4.97a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L13.94 12 8.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
                        </svg>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-white/10"
                          aria-haspopup="menu"
                          aria-label="Bucket actions"
                          onClick={(event) => {
                            event.stopPropagation()
                            const button = event.currentTarget as HTMLButtonElement
                            const isClosing = bucketMenuOpenId === b.id
                            setBucketMenuOpenId((current) => {
                              if (current === b.id) {
                                bucketMenuAnchorRef.current = null
                                return null
                              }
                              bucketMenuAnchorRef.current = button
                              return b.id
                            })
                            if (!isClosing) {
                              setBucketMenuPositionReady(false)
                            }
                          }}
                          aria-expanded={bucketMenuOpenId === b.id}
                        >
                          <svg className="w-4.5 h-4.5 goal-kebab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <circle cx="12" cy="6" r="1.6" />
                            <circle cx="12" cy="12" r="1.6" />
                            <circle cx="12" cy="18" r="1.6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {isBucketOpen && (
                      <div className="goal-bucket-body px-3 md:px-4 pb-3 md:pb-4">
                        <div className="goal-bucket-body-header">
                          <div className="goal-section-header">
                            <p className="goal-section-title">Tasks ({activeTasks.length})</p>
                          </div>
                          <button
                            type="button"
                            className="goal-task-add"
                            onClick={(event) => {
                              event.stopPropagation()
                              onStartTaskDraft(goal.id, b.id)
                            }}
                          >
                            + Task
                          </button>
                        </div>

                        {draftValue !== undefined && (
                          <div className="goal-task-row goal-task-row--draft">
                            <span className="goal-task-marker" aria-hidden="true" />
                            <input
                              ref={(element) => registerTaskDraftRef(b.id, element)}
                              value={draftValue}
                              onChange={(event) => onTaskDraftChange(goal.id, b.id, event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  onTaskDraftSubmit(goal.id, b.id, { keepDraft: true })
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  onTaskDraftCancel(b.id)
                                }
                              }}
                              onBlur={() => onTaskDraftBlur(goal.id, b.id)}
                              placeholder="New task"
                              className="goal-task-input"
                            />
                          </div>
                        )}

                        {activeTasks.length === 0 && draftValue === undefined ? (
                          <p className="goal-task-empty">No tasks yet.</p>
                        ) : (
                          <ul
                            className="mt-2 space-y-2"
                            onDragOver={(e) => {
                              const info = (window as any).__dragTaskInfo as
                                | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                | null
                              if (!info) return
                              if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'active') return
                              e.preventDefault()
                              const list = e.currentTarget as HTMLElement
                              const { index: insertIndex, top } = computeInsertMetrics(list, e.clientY)
                              setDragHover((cur) => {
                                if (cur && cur.bucketId === b.id && cur.section === 'active' && cur.index === insertIndex) {
                                  return cur
                                }
                                return { bucketId: b.id, section: 'active', index: insertIndex }
                              })
                              setDragLine({ bucketId: b.id, section: 'active', top })
                            }}
                            onDrop={(e) => {
                              const info = (window as any).__dragTaskInfo as
                                | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                | null
                              if (!info) return
                              if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'active') return
                              e.preventDefault()
                              const fromIndex = info.index
                              const toIndex = dragHover && dragHover.bucketId === b.id && dragHover.section === 'active' ? dragHover.index : activeTasks.length
                              if (fromIndex !== toIndex) {
                                onReorderTasks(goal.id, b.id, 'active', fromIndex, toIndex)
                              }
                              setDragHover(null)
                              setDragLine(null)
                            }}
                            onDragLeave={(e) => {
                              if (e.currentTarget.contains(e.relatedTarget as Node)) return
                              setDragHover((cur) => (cur && cur.bucketId === b.id && cur.section === 'active' ? null : cur))
                              setDragLine((cur) => (cur && cur.bucketId === b.id && cur.section === 'active' ? null : cur))
                            }}
                          >
                            {dragLine && dragLine.bucketId === b.id && dragLine.section === 'active' ? (
                              <div
                                className="goal-insert-line"
                                style={{ top: `${dragLine.top}px` }}
                                aria-hidden
                              />
                            ) : null}
                            {activeTasks.map((task, index) => {
                              const isEditing = editingTasks[task.id] !== undefined
                              const diffClass =
                                task.difficulty === 'green'
                                  ? 'goal-task-row--diff-green'
                                  : task.difficulty === 'yellow'
                                  ? 'goal-task-row--diff-yellow'
                                  : task.difficulty === 'red'
                                  ? 'goal-task-row--diff-red'
                                  : ''
                              const showDetails = SHOW_TASK_DETAILS
                              const details = showDetails ? taskDetails[task.id] : undefined
                              const notesValue = showDetails ? details?.notes ?? '' : ''
                              const subtasks = showDetails ? details?.subtasks ?? [] : []
                              const trimmedNotesLength = showDetails ? notesValue.trim().length : 0
                              const completedSubtasks = showDetails
                                ? subtasks.filter((subtask) => subtask.completed).length
                                : 0
                              const hasSubtasks = showDetails ? subtasks.length > 0 : false
                              const subtaskProgressLabel =
                                showDetails && hasSubtasks ? `${completedSubtasks}/${subtasks.length}` : null
                              const isDetailsOpen = showDetails && Boolean(details?.expanded)
                              const hasDetailsContent = showDetails && (trimmedNotesLength > 0 || hasSubtasks)
                              const notesFieldId = `task-notes-${task.id}`
                              const focusPromptKey = makeTaskFocusKey(goal.id, b.id, task.id)
                              const isFocusPromptActive =
                                !isEditing &&
                                focusPromptTarget !== null &&
                                focusPromptTarget.goalId === goal.id &&
                                focusPromptTarget.bucketId === b.id &&
                                focusPromptTarget.taskId === task.id
                              
                              return (
                                <React.Fragment key={`${task.id}-wrap`}>
                                  {/* placeholder suppressed; line is rendered absolutely */}
                                  <li
                                    ref={(el) => registerTaskRowRef(task.id, el)}
                                    key={task.id}
                                    data-focus-prompt-key={focusPromptKey}
                                    className={classNames(
                                      'goal-task-row',
                                      diffClass,
                                      task.priority && 'goal-task-row--priority',
                                      isEditing && 'goal-task-row--draft',
                                      completingMap[completingKey(b.id, task.id)] && 'goal-task-row--completing',
                                      showDetails && isDetailsOpen && 'goal-task-row--expanded',
                                      showDetails && hasDetailsContent && 'goal-task-row--has-details',
                                    )}
                                    draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData('text/plain', task.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                    const row = e.currentTarget as HTMLElement
                                    row.classList.add('dragging')
                                    // Clone current row as drag image, keep it in DOM until drag ends
                                    const clone = row.cloneNode(true) as HTMLElement
                                    // Preserve task modifiers so difficulty/priority visuals stay intact
                                    clone.className = `${row.className} goal-drag-clone`
                                    clone.classList.remove('dragging', 'goal-task-row--collapsed')
                                    // Match row width to avoid layout surprises in the ghost
                                    const rowRect = row.getBoundingClientRect()
                                    clone.style.width = `${Math.floor(rowRect.width)}px`
                                    // Copy visual styles from the source row so colors match (including gradients/shadows)
                                    copyVisualStyles(row, clone)
                                    // Force single-line text in clone even if original contains line breaks
                                    const textNodes = clone.querySelectorAll('.goal-task-text, .goal-task-input, .goal-task-text--button')
                                    textNodes.forEach((node) => {
                                      const el = node as HTMLElement
                                      // Remove explicit <br> or block children that would force new lines
                                      el.querySelectorAll('br').forEach((br) => br.parentNode?.removeChild(br))
                                      const oneLine = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
                                      el.textContent = oneLine
                                    })
                                    // Width already matched above
                                    document.body.appendChild(clone)
                                    dragCloneRef.current = clone
                                    try {
                                      e.dataTransfer.setDragImage(clone, 16, 0)
                                    } catch {}
                                    // Collapse the original in the next frame(s) so the drag image has been captured
                                    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                                      window.requestAnimationFrame(() => {
                                        window.requestAnimationFrame(() => {
                                          row.classList.add('goal-task-row--collapsed')
                                        })
                                      })
                                    } else {
                                      setTimeout(() => row.classList.add('goal-task-row--collapsed'), 0)
                                    }
                                    ;(window as any).__dragTaskInfo = { goalId: goal.id, bucketId: b.id, section: 'active', index }
                                  }}
  onDragEnd={(e) => {
    e.currentTarget.classList.remove('dragging')
    ;(window as any).__dragTaskInfo = null
    setDragHover(null)
    setDragLine(null)
    const row = e.currentTarget as HTMLElement
    row.classList.remove('goal-task-row--collapsed')
    const ghost = dragCloneRef.current
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost)
    dragCloneRef.current = null
  }}
                                    onDragOver={(e) => {
                                      // Row-level allow move cursor but do not compute index here to avoid jitter
                                      const info = (window as any).__dragTaskInfo as
                                        | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                        | null
                                      if (!info) return
                                      if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'active') return
                                      e.preventDefault()
                                      e.dataTransfer.dropEffect = 'move'
                                    }}
                                  >
                                  {showDetails && (
                                    <button
                                      type="button"
                                      className={classNames(
                                        'goal-task-toggle',
                                        isDetailsOpen && 'goal-task-toggle--open',
                                        hasDetailsContent && 'goal-task-toggle--active',
                                      )}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        handleToggleTaskDetails(task.id)
                                      }}
                                      onPointerDown={(event) => {
                                        event.stopPropagation()
                                      }}
                                      aria-label={
                                        isDetailsOpen
                                          ? 'Hide notes and subtasks'
                                          : hasDetailsContent
                                          ? 'Show notes and subtasks'
                                          : 'Add notes or subtasks'
                                      }
                                      aria-expanded={isDetailsOpen}
                                    >
                                      <svg viewBox="0 0 24 24" className="goal-task-toggle__icon" aria-hidden="true">
                                        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                      </svg>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="goal-task-marker goal-task-marker--action"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const key = completingKey(b.id, task.id)
                                      if (completingMap[key]) return

                                      // Ensure the SVG check path uses its exact length so stroke animation works on mobile.
                                      try {
                                        const marker = e.currentTarget as HTMLElement
                                        const checkPath = marker.querySelector('.goal-task-check path') as SVGPathElement | null
                                        if (checkPath) {
                                          const length = checkPath.getTotalLength()
                                          if (Number.isFinite(length) && length > 0) {
                                            const dash = `${length}`
                                            checkPath.style.removeProperty('stroke-dasharray')
                                            checkPath.style.removeProperty('stroke-dashoffset')
                                            checkPath.style.setProperty('--goal-check-length', dash)
                                            console.log('[Goals] Prepared tick animation', {
                                              bucketId: b.id,
                                              taskId: task.id,
                                              length,
                                              dash,
                                            })
                                          } else {
                                            console.log('[Goals] Tick path length not finite', {
                                              bucketId: b.id,
                                              taskId: task.id,
                                              length,
                                            })
                                          }
                                        } else {
                                          console.log('[Goals] Tick path not found for task', {
                                            bucketId: b.id,
                                            taskId: task.id,
                                          })
                                        }
                                      } catch (err) {
                                        console.warn('[Goals] Failed to prepare tick path', err)
                                        // Ignore measurement errors; CSS defaults remain as fallback.
                                      }

                                      // Compute per-line strike overlay for sequential left→right wipe
                                      let overlayTotal = 600
                                      let rowTotalMs = 1600
                                      try {
                                        const marker = e.currentTarget as HTMLElement
                                        const row = marker.closest('li.goal-task-row') as HTMLElement | null
                                        const textHost = (row?.querySelector('.goal-task-text') as HTMLElement | null) ?? null
                                        const textInner = (row?.querySelector('.goal-task-text__inner') as HTMLElement | null) ?? textHost
                                        if (row && textHost && textInner) {
                                          const range = document.createRange()
                                          range.selectNodeContents(textInner)
                                          const rects = Array.from(range.getClientRects())
                                          const containerRect = textHost.getBoundingClientRect()
                                          // Merge fragments that belong to the same visual line
                                          const merged: Array<{ left: number; right: number; top: number; height: number }> = []
                                          const byTop = rects
                                            .filter((r) => r.width > 2 && r.height > 0)
                                            .sort((a, b) => a.top - b.top)
                                          const lineThreshold = 4 // px tolerance to group rects on the same line
                                          byTop.forEach((r) => {
                                            const last = merged[merged.length - 1]
                                            if (!last || Math.abs(r.top - last.top) > lineThreshold) {
                                              merged.push({ left: r.left, right: r.right, top: r.top, height: r.height })
                                            } else {
                                              last.left = Math.min(last.left, r.left)
                                              last.right = Math.max(last.right, r.right)
                                              last.top = Math.min(last.top, r.top)
                                              last.height = Math.max(last.height, r.height)
                                            }
                                          })
                                          const lineDur = 520 // ms
                                          const lineStagger = 220 // ms
                                          const thickness = 2 // px
                                          const lineCount = Math.max(1, merged.length)
                                          // Attach an overlay inside the text host so currentColor is inherited
                                          const overlay = document.createElement('div')
                                          overlay.className = 'goal-strike-overlay'
                                          // Ensure host is position:relative so overlay aligns correctly
                                          const hostStyle = window.getComputedStyle(textHost)
                                          const patchPosition = hostStyle.position === 'static'
                                          if (patchPosition) textHost.style.position = 'relative'
                                          merged.forEach((m, i) => {
                                            const top = Math.round((m.top - containerRect.top) + (m.height - thickness) / 2)
                                            const left = Math.max(0, Math.round(m.left - containerRect.left))
                                            const width = Math.max(0, Math.round(m.right - m.left))
                                            const seg = document.createElement('div')
                                            seg.className = 'goal-strike-line'
                                            seg.style.top = `${top}px`
                                            seg.style.left = `${left}px`
                                            seg.style.height = `${thickness}px`
                                            seg.style.setProperty('--target-w', `${width}px`)
                                            seg.style.setProperty('--line-dur', `${lineDur}ms`)
                                            seg.style.setProperty('--line-delay', `${i * lineStagger}ms`)
                                            overlay.appendChild(seg)
                                          })
                                          textHost.appendChild(overlay)
                                          // Compute total overlay time and align row slide to begin after wipe completes
                                          overlayTotal = lineDur + (lineCount - 1) * lineStagger + 100
                                          rowTotalMs = Math.max(Math.ceil(overlayTotal / 0.7), overlayTotal + 400)
                                          row.style.setProperty('--row-complete-dur', `${rowTotalMs}ms`)
                                          // Cleanup overlay after the slide completes to avoid leftovers
                                          window.setTimeout(() => {
                                            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
                                            if (patchPosition) textHost.style.position = ''
                                          }, rowTotalMs + 80)
                                        }
                                      } catch {}
                                      // Trigger completing state for marker/check + row timing
                                      setCompletingMap((prev) => ({ ...prev, [key]: true }))
                                      // Commit completion after row slide (duration set above)
                                      window.setTimeout(() => {
                                        onToggleTaskComplete(b.id, task.id)
                                        setCompletingMap((prev) => {
                                          const next = { ...prev }
                                          delete next[key]
                                          return next
                                        })
                                      }, Math.max(1200, rowTotalMs))
                                    }}
                                    aria-label="Mark task complete"
                                  >
                                    <svg viewBox="0 0 24 24" width="24" height="24" className="goal-task-check" aria-hidden="true">
                                      <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                  {isEditing ? (
                                    <span
                                      className="goal-task-input"
                                      contentEditable
                                      suppressContentEditableWarning
                                      ref={(el) => registerTaskEditRef(task.id, el)}
                                      onInput={(event) => {
                                        const node = (event.currentTarget as HTMLSpanElement)
                                        const raw = node.textContent ?? ''
                                        const { value } = sanitizeEditableValue(node, raw, MAX_TASK_TEXT_LENGTH)
                                        onTaskEditChange(task.id, value)
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === 'Escape') {
                                          e.preventDefault()
                                          ;(e.currentTarget as HTMLSpanElement).blur()
                                        }
                                      }}
                                      onPaste={(event) => {
                                        event.preventDefault()
                                        const node = event.currentTarget as HTMLSpanElement
                                        const text = event.clipboardData?.getData('text/plain') ?? ''
                                        const sanitized = text.replace(/\n+/g, ' ')
                                        const current = node.textContent ?? ''
                                        const selection = typeof window !== 'undefined' ? window.getSelection() : null
                                        let next = current
                                        if (selection && selection.rangeCount > 0) {
                                          const range = selection.getRangeAt(0)
                                          if (node.contains(range.endContainer)) {
                                            const prefix = current.slice(0, range.startOffset)
                                            const suffix = current.slice(range.endOffset)
                                            next = `${prefix}${sanitized}${suffix}`
                                          }
                                        } else {
                                          next = current + sanitized
                                        }
                                        const { value } = sanitizeEditableValue(node, next, MAX_TASK_TEXT_LENGTH)
                                        onTaskEditChange(task.id, value)
                                      }}
                                      onBlur={() => onTaskEditBlur(goal.id, b.id, task.id)}
                                      role="textbox"
                                      tabIndex={0}
                                      aria-label="Edit task text"
                                      spellCheck={false}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      className="goal-task-text goal-task-text--button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onTaskTextClick(goal.id, b.id, task.id)
                                      }}
                                      onPointerDown={(e) => {
                                        // guard capture and drag vs edit/long-press
                                        if (e.pointerType === 'touch') {
                                          e.preventDefault()
                                        }
                                      }}
                                      onDoubleClick={(e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        const container = e.currentTarget.querySelector('.goal-task-text__inner') as HTMLElement | null
                                        const caretOffset = findActivationCaretOffset(container, e.clientX, e.clientY)
                                        onDismissFocusPrompt()
                                        onStartTaskEdit(
                                          goal.id,
                                          b.id,
                                          task.id,
                                          task.text,
                                          caretOffset !== null ? { caretOffset } : undefined,
                                        )
                                      }}
                                      aria-label="Edit task text"
                                    >
                                      <span className="goal-task-text__inner" aria-hidden="true">
                                        {highlightText(task.text, highlightTerm)}
                                      </span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className={classNames(
                                      'goal-task-diff',
                                      task.difficulty === 'green' && 'goal-task-diff--green',
                                      task.difficulty === 'yellow' && 'goal-task-diff--yellow',
                                      task.difficulty === 'red' && 'goal-task-diff--red',
                                    )}
                                    onPointerDown={(e) => {
                                      e.stopPropagation()
                                      const key = `${goal.id}:${b.id}:${task.id}`
                                      try {
                                        const timerId = window.setTimeout(() => {
                                          longPressTriggeredRef.current.add(key)
                                          // Prepare FLIP, toggle, then animate
                                          prepareFlipForTask(task.id)
                                          onToggleTaskPriority(b.id, task.id)
                                          if (typeof window !== 'undefined') {
                                            window.requestAnimationFrame(() =>
                                              window.requestAnimationFrame(() => runFlipForTask(task.id)),
                                            )
                                          }
                                        }, PRIORITY_HOLD_MS)
                                        longPressTimersRef.current.set(key, timerId)
                                      } catch {}
                                    }}
                                    onPointerUp={(e) => {
                                      e.stopPropagation()
                                      const key = `${goal.id}:${b.id}:${task.id}`
                                      const timerId = longPressTimersRef.current.get(key)
                                      if (timerId) {
                                        window.clearTimeout(timerId)
                                        longPressTimersRef.current.delete(key)
                                      }
                                      if (longPressTriggeredRef.current.has(key)) {
                                        longPressTriggeredRef.current.delete(key)
                                        // consumed by long-press; do not cycle difficulty
                                        return
                                      }
                                      onCycleTaskDifficulty(b.id, task.id)
                                    }}
                                    onPointerCancel={(e) => {
                                      e.stopPropagation()
                                      const key = `${goal.id}:${b.id}:${task.id}`
                                      const timerId = longPressTimersRef.current.get(key)
                                      if (timerId) {
                                        window.clearTimeout(timerId)
                                        longPressTimersRef.current.delete(key)
                                      }
                                    }}
                                    onPointerLeave={() => {
                                      const key = `${goal.id}:${b.id}:${task.id}`
                                      const timerId = longPressTimersRef.current.get(key)
                                      if (timerId) {
                                        window.clearTimeout(timerId)
                                        longPressTimersRef.current.delete(key)
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        onCycleTaskDifficulty(b.id, task.id)
                                      }
                                    }}
                                    aria-label="Set task difficulty"
                                    title="Tap to cycle difficulty • Hold ~300ms for Priority"
                                  />
                                  {showDetails && isDetailsOpen && (
                                    <div
                                      className={classNames(
                                        'goal-task-details',
                                        isDetailsOpen && 'goal-task-details--open',
                                      )}
                                      onPointerDown={(event) => event.stopPropagation()}
                                    >
                                      <div className="goal-task-details__subtasks">
                                        <div className="goal-task-details__subtasks-header">
                                          <button
                                            type="button"
                                            className="goal-task-details__add"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              handleAddSubtask(task.id)
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            + Subtask
                                          </button>
                                          {subtaskProgressLabel ? (
                                            <span
                                              className="goal-task-details__progress"
                                              aria-label={`Subtasks complete ${completedSubtasks} of ${subtasks.length}`}
                                            >
                                              {subtaskProgressLabel}
                                            </span>
                                          ) : null}
                                        </div>
                                        {hasSubtasks ? (
                                          <ul className="goal-task-details__subtask-list">
                                            {subtasks.map((subtask) => (
                                              <li key={subtask.id} className="goal-task-details__subtask">
                                                <label className="goal-task-details__subtask-item">
                                                  <input
                                                    type="checkbox"
                                                    className="goal-task-details__checkbox"
                                                    checked={subtask.completed}
                                                    onChange={(event) => {
                                                      event.stopPropagation()
                                                      handleToggleSubtaskCompleted(task.id, subtask.id)
                                                    }}
                                                    onPointerDown={(event) => event.stopPropagation()}
                                                  />
                                                  <input
                                                    type="text"
                                                    className="goal-task-details__subtask-input"
                                                    value={subtask.text}
                                                    onChange={(event) =>
                                                      handleSubtaskTextChange(task.id, subtask.id, event.target.value)
                                                    }
                                                    onPointerDown={(event) => event.stopPropagation()}
                                                    placeholder="Describe subtask"
                                                  />
                                                </label>
                                                <button
                                                  type="button"
                                                  className="goal-task-details__remove"
                                                  onClick={(event) => {
                                                    event.stopPropagation()
                                                    handleRemoveSubtask(task.id, subtask.id)
                                                  }}
                                                  onPointerDown={(event) => event.stopPropagation()}
                                                  aria-label="Remove subtask"
                                                >
                                                  ×
                                                </button>
                                              </li>
                                            ))}
                                          </ul>
                                        ) : (
                                          <button
                                            type="button"
                                            className="goal-task-details__empty-add"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              handleAddSubtask(task.id)
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            Start a subtask
                                          </button>
                                        )}
                                      </div>
                                      <div className="goal-task-details__notes">
                                        {trimmedNotesLength > 0 ? (
                                          <p className="goal-task-details__label">Notes</p>
                                        ) : null}
                                        <textarea
                                          id={notesFieldId}
                                          className="goal-task-details__textarea"
                                          value={notesValue}
                                          onChange={(event) => handleTaskNotesChange(task.id, event.target.value)}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          placeholder="Add a quick note..."
                                          rows={3}
                                          aria-label="Task notes"
                                        />
                                      </div>
                                    </div>
                                  )}
                                </li>
                                {!isEditing && isFocusPromptActive ? (
                                  <li
                                    key={`${task.id}-focus`}
                                    className="goal-task-focus-row"
                                    data-focus-prompt-key={focusPromptKey}
                                  >
                                    <div className="goal-task-focus">
                                      <button
                                        type="button"
                                        className="goal-task-focus__button"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          onStartFocusTask(goal, b, task)
                                          onDismissFocusPrompt()
                                        }}
                                      >
                                        Start Focus
                                      </button>
                                    </div>
                                  </li>
                                ) : null}
                                </React.Fragment>
                              )
                            })}
                          </ul>
                        )}

                        {completedTasks.length > 0 && (
                          <div className="goal-completed">
                            <button
                              type="button"
                              className="goal-completed__title"
                              onClick={() => onToggleCompletedCollapsed(b.id)}
                              aria-expanded={!isCompletedCollapsed}
                            >
                              <span>Completed ({completedTasks.length})</span>
                              <svg
                                className={classNames('goal-completed__chevron', !isCompletedCollapsed && 'goal-completed__chevron--open')}
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path d="M8.12 9.29a1 1 0 011.41-.17L12 11.18l2.47-2.06a1 1 0 111.24 1.58l-3.07 2.56a1 1 0 01-1.24 0l-3.07-2.56a1 1 0 01-.17-1.41z" fill="currentColor" />
                              </svg>
                            </button>
                            {!isCompletedCollapsed && (
                              <ul
                                className="goal-completed__list"
                                onDragOver={(e) => {
                                  const info = (window as any).__dragTaskInfo as
                                    | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                    | null
                                  if (!info) return
                                  if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'completed') return
                                  e.preventDefault()
                                  const list = e.currentTarget as HTMLElement
                                  const { index: insertIndex, top } = computeInsertMetrics(list, e.clientY)
                                  setDragHover((cur) => {
                                    if (cur && cur.bucketId === b.id && cur.section === 'completed' && cur.index === insertIndex) {
                                      return cur
                                    }
                                    return { bucketId: b.id, section: 'completed', index: insertIndex }
                                  })
                                  setDragLine({ bucketId: b.id, section: 'completed', top })
                                }}
                                onDrop={(e) => {
                                  const info = (window as any).__dragTaskInfo as
                                    | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                    | null
                                  if (!info) return
                                  if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'completed') return
                                  e.preventDefault()
                                  const fromIndex = info.index
                                  const toIndex = dragHover && dragHover.bucketId === b.id && dragHover.section === 'completed' ? dragHover.index : completedTasks.length
                                  if (fromIndex !== toIndex) {
                                    onReorderTasks(goal.id, b.id, 'completed', fromIndex, toIndex)
                                  }
                                  setDragHover(null)
                                  setDragLine(null)
                                }}
                                onDragLeave={(e) => {
                                  if (e.currentTarget.contains(e.relatedTarget as Node)) return
                                  setDragHover((cur) => (cur && cur.bucketId === b.id && cur.section === 'completed' ? null : cur))
                                  setDragLine((cur) => (cur && cur.bucketId === b.id && cur.section === 'completed' ? null : cur))
                                }}
                              >
                                {dragLine && dragLine.bucketId === b.id && dragLine.section === 'completed' ? (
                                  <div
                                    className="goal-insert-line"
                                    style={{ top: `${dragLine.top}px` }}
                                    aria-hidden
                                  />
                                ) : null}
                                {completedTasks.map((task, cIndex) => {
                                  const isEditing = editingTasks[task.id] !== undefined
                                  const diffClass =
                                    task.difficulty === 'green'
                                      ? 'goal-task-row--diff-green'
                                      : task.difficulty === 'yellow'
                                      ? 'goal-task-row--diff-yellow'
                                      : task.difficulty === 'red'
                                      ? 'goal-task-row--diff-red'
                                      : ''
                                  const showDetails = SHOW_TASK_DETAILS
                                  const details = showDetails ? taskDetails[task.id] : undefined
                                  const notesValue = showDetails ? details?.notes ?? '' : ''
                                  const subtasks = showDetails ? details?.subtasks ?? [] : []
                                  const trimmedNotesLength = showDetails ? notesValue.trim().length : 0
                                  const completedSubtasks = showDetails
                                    ? subtasks.filter((subtask) => subtask.completed).length
                                    : 0
                                  const hasSubtasks = showDetails ? subtasks.length > 0 : false
                                  const subtaskProgressLabel =
                                    showDetails && hasSubtasks ? `${completedSubtasks}/${subtasks.length}` : null
                                  const isDetailsOpen = showDetails && Boolean(details?.expanded)
                                  const hasDetailsContent = showDetails && (trimmedNotesLength > 0 || hasSubtasks)
                                  const notesFieldId = `task-notes-${task.id}`
                                  const focusPromptKey = makeTaskFocusKey(goal.id, b.id, task.id)
                                  const isFocusPromptActive =
                                    !isEditing &&
                                    focusPromptTarget !== null &&
                                    focusPromptTarget.goalId === goal.id &&
                                    focusPromptTarget.bucketId === b.id &&
                                    focusPromptTarget.taskId === task.id
                                  
                                  return (
                                    <React.Fragment key={`${task.id}-cwrap`}>
                                      {/* placeholder suppressed; line is rendered absolutely */}
                                      <li
                                        ref={(el) => registerTaskRowRef(task.id, el)}
                                        key={task.id}
                                        data-focus-prompt-key={focusPromptKey}
                                        className={classNames(
                                          'goal-task-row goal-task-row--completed',
                                          diffClass,
                                          task.priority && 'goal-task-row--priority',
                                          isEditing && 'goal-task-row--draft',
                                          isFocusPromptActive && 'goal-task-row--focus-prompt',
                                          showDetails && isDetailsOpen && 'goal-task-row--expanded',
                                          showDetails && hasDetailsContent && 'goal-task-row--has-details',
                                        )}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.setData('text/plain', task.id)
                                          e.dataTransfer.effectAllowed = 'move'
                                          const row = e.currentTarget as HTMLElement
                                          row.classList.add('dragging')
                                          const clone = row.cloneNode(true) as HTMLElement
                                          clone.className = `${row.className} goal-drag-clone`
                                          clone.classList.remove('dragging', 'goal-task-row--collapsed')
                                          const rowRect = row.getBoundingClientRect()
                                          clone.style.width = `${Math.floor(rowRect.width)}px`
                                          copyVisualStyles(row, clone)
                                          // Force single-line text in clone even if original contains line breaks
                                          const textNodes = clone.querySelectorAll('.goal-task-text, .goal-task-input, .goal-task-text--button')
                                          textNodes.forEach((node) => {
                                            const el = node as HTMLElement
                                            el.querySelectorAll('br').forEach((br) => br.parentNode?.removeChild(br))
                                            const oneLine = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
                                            el.textContent = oneLine
                                          })
                                          // Width already matched above
                                          document.body.appendChild(clone)
                                          dragCloneRef.current = clone
                                          try {
                                            e.dataTransfer.setDragImage(clone, 16, 0)
                                          } catch {}
                                          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                                            window.requestAnimationFrame(() => {
                                              window.requestAnimationFrame(() => {
                                                row.classList.add('goal-task-row--collapsed')
                                              })
                                            })
                                          } else {
                                            setTimeout(() => row.classList.add('goal-task-row--collapsed'), 0)
                                          }
                                          ;(window as any).__dragTaskInfo = { goalId: goal.id, bucketId: b.id, section: 'completed', index: cIndex }
                                        }}
  onDragEnd={(e) => {
    e.currentTarget.classList.remove('dragging')
    ;(window as any).__dragTaskInfo = null
    setDragHover(null)
    setDragLine(null)
    const row = e.currentTarget as HTMLElement
    row.classList.remove('goal-task-row--collapsed')
    const ghost = dragCloneRef.current
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost)
    dragCloneRef.current = null
  }}
                                        onDragOver={(e) => {
                                          const info = (window as any).__dragTaskInfo as
                                            | { goalId: string; bucketId: string; section: 'active' | 'completed'; index: number }
                                            | null
                                          if (!info) return
                                          if (info.goalId !== goal.id || info.bucketId !== b.id || info.section !== 'completed') return
                                          e.preventDefault()
                                          e.dataTransfer.dropEffect = 'move'
                                        }}
                                      >
                                      {showDetails && (
                                        <button
                                          type="button"
                                          className={classNames(
                                            'goal-task-toggle',
                                            isDetailsOpen && 'goal-task-toggle--open',
                                            hasDetailsContent && 'goal-task-toggle--active',
                                          )}
                                          onClick={(event) => {
                                            event.stopPropagation()
                                            handleToggleTaskDetails(task.id)
                                          }}
                                          onPointerDown={(event) => {
                                            event.stopPropagation()
                                          }}
                                          aria-label={
                                            isDetailsOpen
                                              ? 'Hide notes and subtasks'
                                              : hasDetailsContent
                                              ? 'Show notes and subtasks'
                                              : 'Add notes or subtasks'
                                          }
                                          aria-expanded={isDetailsOpen}
                                        >
                                          <svg viewBox="0 0 24 24" className="goal-task-toggle__icon" aria-hidden="true">
                                            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        </button>
                                      )}
                                  <button
                                    type="button"
                                    className="goal-task-marker goal-task-marker--completed"
                                    onClick={() => onToggleTaskComplete(b.id, task.id)}
                                    aria-label="Mark task incomplete"
                                  >
                                    <svg viewBox="0 0 24 24" width="24" height="24" className="goal-task-check" aria-hidden="true">
                                      <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                      {isEditing ? (
                                        <span
                                          className="goal-task-input"
                                          contentEditable
                                          suppressContentEditableWarning
                                          ref={(el) => registerTaskEditRef(task.id, el)}
                                          onInput={(event) => {
                                            const node = (event.currentTarget as HTMLSpanElement)
                                            const raw = node.textContent ?? ''
                                            const { value } = sanitizeEditableValue(node, raw, MAX_TASK_TEXT_LENGTH)
                                            onTaskEditChange(task.id, value)
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === 'Escape') {
                                              e.preventDefault()
                                              ;(e.currentTarget as HTMLSpanElement).blur()
                                            }
                                          }}
                                          onPaste={(event) => {
                                            event.preventDefault()
                                            const node = event.currentTarget as HTMLSpanElement
                                            const text = event.clipboardData?.getData('text/plain') ?? ''
                                            const sanitized = text.replace(/\n+/g, ' ')
                                            const current = node.textContent ?? ''
                                            const selection = typeof window !== 'undefined' ? window.getSelection() : null
                                            let next = current
                                            if (selection && selection.rangeCount > 0) {
                                              const range = selection.getRangeAt(0)
                                              if (node.contains(range.endContainer)) {
                                                const prefix = current.slice(0, range.startOffset)
                                                const suffix = current.slice(range.endOffset)
                                                next = `${prefix}${sanitized}${suffix}`
                                              }
                                            } else {
                                              next = current + sanitized
                                            }
                                            const { value } = sanitizeEditableValue(node, next, MAX_TASK_TEXT_LENGTH)
                                            onTaskEditChange(task.id, value)
                                          }}
                                          onBlur={() => onTaskEditBlur(goal.id, b.id, task.id)}
                                          role="textbox"
                                          tabIndex={0}
                                          aria-label="Edit task text"
                                          spellCheck={false}
                                        />
                                      ) : (
                                        <button
                                          type="button"
                                          className="goal-task-text goal-task-text--button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onTaskTextClick(goal.id, b.id, task.id)
                                      }}
                                      onDoubleClick={(e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        const container = e.currentTarget.querySelector('.goal-task-text__inner') as HTMLElement | null
                                        const caretOffset = findActivationCaretOffset(container, e.clientX, e.clientY)
                                        onDismissFocusPrompt()
                                        onStartTaskEdit(
                                          goal.id,
                                          b.id,
                                          task.id,
                                              task.text,
                                              caretOffset !== null ? { caretOffset } : undefined,
                                            )
                                          }}
                                          aria-label="Edit task text"
                                        >
                                          <span className="goal-task-text__inner">{highlightText(task.text, highlightTerm)}</span>
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className={classNames(
                                          'goal-task-diff',
                                          task.difficulty === 'green' && 'goal-task-diff--green',
                                          task.difficulty === 'yellow' && 'goal-task-diff--yellow',
                                          task.difficulty === 'red' && 'goal-task-diff--red',
                                        )}
                                        onPointerDown={(e) => {
                                          e.stopPropagation()
                                          const key = `${goal.id}:${b.id}:${task.id}`
                                          try {
                                            const timerId = window.setTimeout(() => {
                                              longPressTriggeredRef.current.add(key)
                                              // Prepare FLIP, toggle, then animate
                                              prepareFlipForTask(task.id)
                                              onToggleTaskPriority(b.id, task.id)
                                              if (typeof window !== 'undefined') {
                                                window.requestAnimationFrame(() =>
                                                  window.requestAnimationFrame(() => runFlipForTask(task.id)),
                                                )
                                              }
                                            }, PRIORITY_HOLD_MS)
                                            longPressTimersRef.current.set(key, timerId)
                                          } catch {}
                                        }}
                                        onPointerUp={(e) => {
                                          e.stopPropagation()
                                          const key = `${goal.id}:${b.id}:${task.id}`
                                          const timerId = longPressTimersRef.current.get(key)
                                          if (timerId) {
                                            window.clearTimeout(timerId)
                                            longPressTimersRef.current.delete(key)
                                          }
                                          if (longPressTriggeredRef.current.has(key)) {
                                            longPressTriggeredRef.current.delete(key)
                                            return
                                          }
                                          onCycleTaskDifficulty(b.id, task.id)
                                        }}
                                        onPointerCancel={(e) => {
                                          e.stopPropagation()
                                          const key = `${goal.id}:${b.id}:${task.id}`
                                          const timerId = longPressTimersRef.current.get(key)
                                          if (timerId) {
                                            window.clearTimeout(timerId)
                                            longPressTimersRef.current.delete(key)
                                          }
                                        }}
                                        onPointerLeave={() => {
                                          const key = `${goal.id}:${b.id}:${task.id}`
                                          const timerId = longPressTimersRef.current.get(key)
                                          if (timerId) {
                                            window.clearTimeout(timerId)
                                            longPressTimersRef.current.delete(key)
                                          }
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            onCycleTaskDifficulty(b.id, task.id)
                                          }
                                        }}
                                        aria-label="Set task difficulty"
                                        title="Tap to cycle difficulty • Hold ~300ms for Priority"
                                      />
                                      {showDetails && isDetailsOpen && (
                                        <div
                                          className={classNames(
                                            'goal-task-details',
                                            isDetailsOpen && 'goal-task-details--open',
                                          )}
                                          onPointerDown={(event) => event.stopPropagation()}
                                        >
                                          <div className="goal-task-details__subtasks">
                                            <div className="goal-task-details__subtasks-header">
                                              <button
                                                type="button"
                                                className="goal-task-details__add"
                                                onClick={(event) => {
                                                  event.stopPropagation()
                                                  handleAddSubtask(task.id)
                                                }}
                                                onPointerDown={(event) => event.stopPropagation()}
                                              >
                                                + Subtask
                                              </button>
                                              {subtaskProgressLabel ? (
                                                <span
                                                  className="goal-task-details__progress"
                                                  aria-label={`Subtasks complete ${completedSubtasks} of ${subtasks.length}`}
                                                >
                                                  {subtaskProgressLabel}
                                                </span>
                                              ) : null}
                                            </div>
                                            {hasSubtasks ? (
                                              <ul className="goal-task-details__subtask-list">
                                                {subtasks.map((subtask) => (
                                                  <li key={subtask.id} className="goal-task-details__subtask">
                                                    <label className="goal-task-details__subtask-item">
                                                      <input
                                                        type="checkbox"
                                                        className="goal-task-details__checkbox"
                                                        checked={subtask.completed}
                                                        onChange={(event) => {
                                                          event.stopPropagation()
                                                          handleToggleSubtaskCompleted(task.id, subtask.id)
                                                        }}
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                      />
                                                      <input
                                                        type="text"
                                                        className="goal-task-details__subtask-input"
                                                        value={subtask.text}
                                                        onChange={(event) =>
                                                          handleSubtaskTextChange(task.id, subtask.id, event.target.value)
                                                        }
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                        placeholder="Describe subtask"
                                                      />
                                                    </label>
                                                    <button
                                                      type="button"
                                                      className="goal-task-details__remove"
                                                      onClick={(event) => {
                                                        event.stopPropagation()
                                                        handleRemoveSubtask(task.id, subtask.id)
                                                      }}
                                                      onPointerDown={(event) => event.stopPropagation()}
                                                      aria-label="Remove subtask"
                                                    >
                                                      ×
                                                    </button>
                                                  </li>
                                                ))}
                                              </ul>
                                            ) : (
                                              <button
                                                type="button"
                                                className="goal-task-details__empty-add"
                                                onClick={(event) => {
                                                  event.stopPropagation()
                                                  handleAddSubtask(task.id)
                                                }}
                                                onPointerDown={(event) => event.stopPropagation()}
                                              >
                                                Start a subtask
                                              </button>
                                            )}
                                          </div>
                                          <div className="goal-task-details__notes">
                                            {trimmedNotesLength > 0 ? (
                                              <p className="goal-task-details__label">Notes</p>
                                            ) : null}
                                            <textarea
                                              id={notesFieldId}
                                              className="goal-task-details__textarea"
                                              value={notesValue}
                                              onChange={(event) => handleTaskNotesChange(task.id, event.target.value)}
                                              onPointerDown={(event) => event.stopPropagation()}
                                              placeholder="Add a quick note..."
                                              rows={3}
                                              aria-label="Task notes"
                                            />
                                          </div>
                                        </div>
                                      )}
                                    </li>
                                    {!isEditing && isFocusPromptActive ? (
                                      <li
                                        key={`${task.id}-focus`}
                                        className="goal-task-focus-row"
                                        data-focus-prompt-key={focusPromptKey}
                                      >
                                        <div className="goal-task-focus">
                                          <button
                                            type="button"
                                            className="goal-task-focus__button"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              onStartFocusTask(goal, b, task)
                                              onDismissFocusPrompt()
                                            }}
                                          >
                                            Start Focus
                                          </button>
                                        </div>
                                      </li>
                                    ) : null}
                                    </React.Fragment>
                                  )
                                })}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
      {menuPortal}
      {bucketMenuPortal}
      {bucketCustomizerPortal}
    </div>
  )
}

export default function GoalsPage(): ReactElement {
  const [goals, setGoals] = useState<Goal[]>(() => {
    const stored = readStoredGoalsSnapshot()
    if (stored.length > 0) {
      return reconcileGoalsWithSnapshot(stored, DEFAULT_GOALS)
    }
    return DEFAULT_GOALS
  })
  const toggleGoalStarred = useCallback((goalId: string) => {
    setGoals((current) => {
      const target = current.find((goal) => goal.id === goalId)
      if (!target) {
        return current
      }
      const nextStarred = !target.starred
      apiSetGoalStarred(goalId, nextStarred).catch(() => {
        setGoals((rollback) =>
          rollback.map((goal) => (goal.id === goalId ? { ...goal, starred: target.starred } : goal)),
        )
      })
      return current.map((goal) => (goal.id === goalId ? { ...goal, starred: nextStarred } : goal))
    })
  }, [setGoals])
  const skipNextPublishRef = useRef(false)
  const lastSnapshotSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (skipNextPublishRef.current) {
      skipNextPublishRef.current = false
      return
    }
    const snapshot = createGoalsSnapshot(goals)
    const signature = computeSnapshotSignature(snapshot)
    lastSnapshotSignatureRef.current = signature
    publishGoalsSnapshot(snapshot)
  }, [goals])
  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeToGoalsSnapshot((snapshot) => {
      const signature = computeSnapshotSignature(snapshot)
      if (lastSnapshotSignatureRef.current === signature) {
        return
      }
      skipNextPublishRef.current = true
      lastSnapshotSignatureRef.current = signature
      const run = () => {
        if (cancelled) {
          return
        }
        setGoals((current) => reconcileGoalsWithSnapshot(snapshot, current))
      }
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(run)
      } else {
        Promise.resolve().then(run).catch(() => {
          // ignore
        })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Goal rename state
  const [renamingGoalId, setRenamingGoalId] = useState<string | null>(null)
  const [goalRenameDraft, setGoalRenameDraft] = useState<string>('')
  // Bucket rename state
  const [renamingBucketId, setRenamingBucketId] = useState<string | null>(null)
  const [bucketRenameDraft, setBucketRenameDraft] = useState<string>('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [bucketExpanded, setBucketExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    DEFAULT_GOALS.forEach((goal) => {
      goal.buckets.forEach((bucket) => {
        initial[bucket.id] = false
      })
    })
    return initial
  })
  const [completedCollapsed, setCompletedCollapsed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    DEFAULT_GOALS.forEach((goal) => {
      goal.buckets.forEach((bucket) => {
        initial[bucket.id] = true
      })
    })
    return initial
  })
  const [bucketDrafts, setBucketDrafts] = useState<Record<string, string>>({})
  const bucketDraftRefs = useRef(new Map<string, HTMLInputElement>())
  const submittingBucketDrafts = useRef(new Set<string>())
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({})
  const taskDraftRefs = useRef(new Map<string, HTMLInputElement>())
  const submittingDrafts = useRef(new Set<string>())
  const [taskEdits, setTaskEdits] = useState<Record<string, string>>({})
  const taskEditRefs = useRef(new Map<string, HTMLSpanElement>())
  const submittingEdits = useRef(new Set<string>())
  const [focusPromptTarget, setFocusPromptTarget] = useState<FocusPromptTarget | null>(null)
  const focusPromptKeyRef = useRef<string | null>(null)
  const [isCreateGoalOpen, setIsCreateGoalOpen] = useState(false)
  const [goalNameInput, setGoalNameInput] = useState('')
  const [selectedGoalGradient, setSelectedGoalGradient] = useState(GOAL_GRADIENTS[0])
  const [customGradient, setCustomGradient] = useState({ start: '#6366f1', end: '#ec4899', angle: 135 })
  const goalModalInputRef = useRef<HTMLInputElement | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [taskDetails, setTaskDetails] = useState<TaskDetailsState>(() => readStoredTaskDetails())

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.localStorage.setItem(TASK_DETAILS_STORAGE_KEY, JSON.stringify(taskDetails))
    } catch {
      // Ignore quota or storage errors silently
    }
  }, [taskDetails])

  useEffect(() => {
    const validTaskIds = new Set<string>()
    goals.forEach((goal) => {
      goal.buckets.forEach((bucket) => {
        bucket.tasks.forEach((task) => {
          validTaskIds.add(task.id)
        })
      })
    })
    setTaskDetails((current) => {
      let changed = false
      const next: TaskDetailsState = {}
      Object.entries(current).forEach(([taskId, details]) => {
        if (validTaskIds.has(taskId)) {
          next[taskId] = details
        } else {
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [goals])

  const updateTaskDetails = useCallback(
    (taskId: string, transform: (current: TaskDetails) => TaskDetails) => {
      setTaskDetails((current) => {
        const previous = current[taskId] ?? createTaskDetails()
        const transformed = transform(previous)
        const base = transformed === previous ? previous : transformed
        const normalized: TaskDetails = {
          notes: typeof base.notes === 'string' ? base.notes : '',
          expanded: Boolean(base.expanded),
          subtasks: Array.isArray(base.subtasks) ? base.subtasks : [],
        }
        if (!shouldPersistTaskDetails(normalized)) {
          if (!current[taskId]) {
            return current
          }
          const { [taskId]: _removed, ...rest } = current
          return rest
        }
        const existing = current[taskId]
        if (existing && areTaskDetailsEqual(existing, normalized)) {
          return current
        }
        return { ...current, [taskId]: normalized }
      })
    },
    [],
  )

  const handleToggleTaskDetails = useCallback(
    (taskId: string) => {
      updateTaskDetails(taskId, (current) => ({
        ...current,
        expanded: !current.expanded,
      }))
    },
    [updateTaskDetails],
  )

  const handleTaskNotesChange = useCallback(
    (taskId: string, value: string) => {
      updateTaskDetails(taskId, (current) => {
        if (current.notes === value) {
          return current
        }
        return {
          ...current,
          notes: value,
        }
      })
    },
    [updateTaskDetails],
  )

  const handleAddSubtask = useCallback(
    (taskId: string) => {
      updateTaskDetails(taskId, (current) => ({
        ...current,
        expanded: true,
        subtasks: [...current.subtasks, { id: createSubtaskId(), text: '', completed: false }],
      }))
    },
    [updateTaskDetails],
  )

  const handleSubtaskTextChange = useCallback(
    (taskId: string, subtaskId: string, value: string) => {
      updateTaskDetails(taskId, (current) => {
        const index = current.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return current
        }
        const nextSubtasks = current.subtasks.map((item, idx) =>
          idx === index ? { ...item, text: value } : item,
        )
        return {
          ...current,
          subtasks: nextSubtasks,
        }
      })
    },
    [updateTaskDetails],
  )

  const handleToggleSubtaskCompleted = useCallback(
    (taskId: string, subtaskId: string) => {
      updateTaskDetails(taskId, (current) => {
        const index = current.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return current
        }
        const nextSubtasks = current.subtasks.map((item, idx) =>
          idx === index ? { ...item, completed: !item.completed } : item,
        )
        return {
          ...current,
          subtasks: nextSubtasks,
        }
      })
    },
    [updateTaskDetails],
  )

  const handleRemoveSubtask = useCallback(
    (taskId: string, subtaskId: string) => {
      updateTaskDetails(taskId, (current) => {
        const nextSubtasks = current.subtasks.filter((item) => item.id !== subtaskId)
        if (nextSubtasks.length === current.subtasks.length) {
          return current
        }
        return {
          ...current,
          subtasks: nextSubtasks,
        }
      })
    },
    [updateTaskDetails],
  )
  const [nextGoalGradientIndex, setNextGoalGradientIndex] = useState(() => DEFAULT_GOALS.length % GOAL_GRADIENTS.length)
  const [activeCustomizerGoalId, setActiveCustomizerGoalId] = useState<string | null>(null)
  const customizerDialogRef = useRef<HTMLDivElement | null>(null)
  const customGradientPreview = useMemo(
    () => `linear-gradient(${customGradient.angle}deg, ${customGradient.start} 0%, ${customGradient.end} 100%)`,
    [customGradient],
  )
  const gradientOptions = useMemo<string[]>(() => [...GOAL_GRADIENTS, 'custom'], [])
  const gradientPreview = useMemo<Record<string, string>>(
    () => ({
      ...BASE_GRADIENT_PREVIEW,
      custom: customGradientPreview,
    }),
    [customGradientPreview],
  )
  const activeCustomizerGoal = useMemo(
    () => goals.find((goal) => goal.id === activeCustomizerGoalId) ?? null,
    [goals, activeCustomizerGoalId],
  )
  // On first load, attempt to hydrate from Supabase (single-user session).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await seedGoalsIfEmpty(DEFAULT_GOAL_SEEDS)
      } catch (error) {
        console.warn('[GoalsPage] Failed to seed Supabase defaults:', error)
      }
      try {
        const result = await fetchGoalsHierarchy()
        if (!cancelled && result && Array.isArray(result.goals)) {
          const normalized = result.goals.map((goal: any) => ({
            ...goal,
            starred: Boolean(goal.starred),
            surfaceStyle: normalizeSurfaceStyle(goal.surfaceStyle as string | null | undefined),
            buckets: Array.isArray(goal.buckets)
              ? goal.buckets.map((bucket: any) => ({
                  ...bucket,
                  surfaceStyle: normalizeBucketSurfaceStyle(bucket.surfaceStyle as string | null | undefined),
                }))
              : [],
          }))
          setGoals(normalized as any)
        }
      } catch {
        // ignore; fall back to local defaults
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const previousExpandedRef = useRef<Record<string, boolean> | null>(null)
  const previousBucketExpandedRef = useRef<Record<string, boolean> | null>(null)
  const previousCompletedCollapsedRef = useRef<Record<string, boolean> | null>(null)

  useEffect(() => {
    focusPromptKeyRef.current = focusPromptTarget
      ? makeTaskFocusKey(focusPromptTarget.goalId, focusPromptTarget.bucketId, focusPromptTarget.taskId)
      : null
  }, [focusPromptTarget])

  useEffect(() => {
    if (!focusPromptTarget) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const key = focusPromptKeyRef.current
      if (!key) {
        setFocusPromptTarget(null)
        return
      }
      const target = event.target
      if (target instanceof Element) {
        const container = target.closest('[data-focus-prompt-key]')
        if (container && container.getAttribute('data-focus-prompt-key') === key) {
          return
        }
      }
      setFocusPromptTarget(null)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [focusPromptTarget])
  const expandedRef = useRef(expanded)
  const bucketExpandedRef = useRef(bucketExpanded)
  const completedCollapsedRef = useRef(completedCollapsed)

  useEffect(() => {
    if (!activeCustomizerGoalId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveCustomizerGoalId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeCustomizerGoalId])

  useEffect(() => {
    if (activeCustomizerGoalId && !activeCustomizerGoal) {
      setActiveCustomizerGoalId(null)
    }
  }, [activeCustomizerGoalId, activeCustomizerGoal])

  useEffect(() => {
    if (!activeCustomizerGoalId) {
      return
    }
    if (typeof document === 'undefined') {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [activeCustomizerGoalId])

  useEffect(() => {
    if (!activeCustomizerGoalId) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const dialog = customizerDialogRef.current
      if (!dialog) {
        return
      }
      const target = dialog.querySelector<HTMLElement>('[data-auto-focus="true"], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      target?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeCustomizerGoalId])

  const closeCustomizer = useCallback(() => setActiveCustomizerGoalId(null), [])

  // Goal-level DnD hover state and ghost
  const [goalHoverIndex, setGoalHoverIndex] = useState<number | null>(null)
  const [goalLineTop, setGoalLineTop] = useState<number | null>(null)

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  useEffect(() => {
    bucketExpandedRef.current = bucketExpanded
  }, [bucketExpanded])

  useEffect(() => {
    completedCollapsedRef.current = completedCollapsed
  }, [completedCollapsed])

  const toggleExpand = (goalId: string) => {
    setExpanded((e) => ({ ...e, [goalId]: !e[goalId] }))
  }

  const updateGoalAppearance = (goalId: string, updates: GoalAppearanceUpdate) => {
    const surfaceStyleToPersist = updates.surfaceStyle ? normalizeSurfaceStyle(updates.surfaceStyle) : null
    let colorToPersist: string | null = null
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g
        let next: Goal = { ...g }
        const previousColor = g.color
        if (updates.surfaceStyle) {
          next.surfaceStyle = normalizeSurfaceStyle(updates.surfaceStyle)
        }

        if ('customGradient' in updates) {
          const custom = updates.customGradient
          if (custom) {
            const gradientString = createCustomGradientString(custom.from, custom.to)
            next.customGradient = { ...custom }
            const newColor = `custom:${gradientString}`
            next.color = newColor
            if (newColor !== previousColor) {
              colorToPersist = newColor
            }
          } else {
            next.customGradient = undefined
          }
        }

        if (updates.color) {
          next.color = updates.color
          if (!updates.color.startsWith('custom:')) {
            next.customGradient = undefined
          }
          if (updates.color !== previousColor) {
            colorToPersist = updates.color
          }
        }

        return next
      }),
    )
    if (surfaceStyleToPersist) {
      apiSetGoalSurface(goalId, surfaceStyleToPersist).catch(() => {})
    }
    if (colorToPersist) {
      apiSetGoalColor(goalId, colorToPersist).catch(() => {})
    }
  }

  const startGoalRename = (goalId: string, initial: string) => {
    setRenamingGoalId(goalId)
    setGoalRenameDraft(initial)
  }
  const handleGoalRenameChange = (value: string) => setGoalRenameDraft(value)
  const submitGoalRename = () => {
    if (!renamingGoalId) return
    const next = goalRenameDraft.trim()
    setGoals((gs) => gs.map((g) => (g.id === renamingGoalId ? { ...g, name: next || g.name } : g)))
    if (next.length > 0) {
      apiRenameGoal(renamingGoalId, next).catch(() => {})
    }
    setRenamingGoalId(null)
    setGoalRenameDraft('')
  }
  const cancelGoalRename = () => {
    setRenamingGoalId(null)
    setGoalRenameDraft('')
  }

  const startBucketRename = (goalId: string, bucketId: string, initial: string) => {
    // Ensure parent goal is open to reveal input
    setExpanded((e) => ({ ...e, [goalId]: true }))
    setRenamingBucketId(bucketId)
    setBucketRenameDraft(initial)
  }
  const handleBucketRenameChange = (value: string) => setBucketRenameDraft(value)
  const submitBucketRename = () => {
    if (!renamingBucketId) return
    const next = bucketRenameDraft.trim()
    setGoals((gs) =>
      gs.map((g) => ({
        ...g,
        buckets: g.buckets.map((b) => (b.id === renamingBucketId ? { ...b, name: next || b.name } : b)),
      })),
    )
    if (next.length > 0) {
      apiRenameBucket(renamingBucketId, next).catch(() => {})
    }
    setRenamingBucketId(null)
    setBucketRenameDraft('')
  }
  const cancelBucketRename = () => {
    setRenamingBucketId(null)
    setBucketRenameDraft('')
  }

  const deleteGoal = (goalId: string) => {
    // Snapshot buckets to clean up per-bucket UI state
    const target = goals.find((g) => g.id === goalId)
    setGoals((gs) => gs.filter((g) => g.id !== goalId))
    setExpanded((prev) => {
      const { [goalId]: _removed, ...rest } = prev
      return rest
    })
    if (renamingGoalId === goalId) {
      setRenamingGoalId(null)
      setGoalRenameDraft('')
    }
    if (target) {
      const bucketIds = target.buckets.map((b) => b.id)
      setBucketExpanded((prev) => {
        const next = { ...prev }
        bucketIds.forEach((id) => delete next[id])
        return next
      })
      setCompletedCollapsed((prev) => {
        const next = { ...prev }
        bucketIds.forEach((id) => delete next[id])
        return next
      })
      setTaskDrafts((prev) => {
        const next = { ...prev }
        bucketIds.forEach((id) => delete next[id])
        return next
      })
    }
    if (activeCustomizerGoalId === goalId) {
      setActiveCustomizerGoalId(null)
    }
    apiDeleteGoalById(goalId).catch(() => {})
  }

  const deleteBucket = (goalId: string, bucketId: string) => {
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId ? { ...g, buckets: g.buckets.filter((b) => b.id !== bucketId) } : g,
      ),
    )
    apiDeleteBucketById(bucketId).catch(() => {})
  }

  const deleteCompletedTasks = (goalId: string, bucketId: string) => {
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) =>
                b.id === bucketId ? { ...b, tasks: b.tasks.filter((t) => !t.completed) } : b,
              ),
            }
          : g,
      ),
    )
    apiDeleteCompletedTasksInBucket(bucketId).catch(() => {})
  }

  const toggleBucketExpanded = (bucketId: string) => {
    setBucketExpanded((current) => ({
      ...current,
      [bucketId]: !(current[bucketId] ?? false),
    }))
  }

  const focusBucketDraftInput = (goalId: string) => {
    const node = bucketDraftRefs.current.get(goalId)
    if (!node) {
      return
    }
    const length = node.value.length
    node.focus()
    node.setSelectionRange(length, length)
  }

  const startBucketDraft = (goalId: string) => {
    setExpanded((current) => ({ ...current, [goalId]: true }))
    setBucketDrafts((current) => {
      if (goalId in current) {
        return current
      }
      return { ...current, [goalId]: '' }
    })

    if (typeof window !== 'undefined') {
      const scheduleFocus = () => focusBucketDraftInput(goalId)
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleFocus))
      } else {
        window.setTimeout(scheduleFocus, 0)
      }
    }
  }

  const handleBucketDraftChange = (goalId: string, value: string) => {
    setBucketDrafts((current) => ({ ...current, [goalId]: value }))
  }

  const removeBucketDraft = (goalId: string) => {
    setBucketDrafts((current) => {
      if (current[goalId] === undefined) {
        return current
      }
      const { [goalId]: _removed, ...rest } = current
      return rest
    })
  }

  const releaseBucketSubmittingFlag = (goalId: string) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => submittingBucketDrafts.current.delete(goalId))
    } else if (typeof window !== 'undefined') {
      window.setTimeout(() => submittingBucketDrafts.current.delete(goalId), 0)
    } else {
      submittingBucketDrafts.current.delete(goalId)
    }
  }

  const handleBucketDraftSubmit = (goalId: string, options?: { keepDraft?: boolean }) => {
    if (submittingBucketDrafts.current.has(goalId)) {
      return
    }
    submittingBucketDrafts.current.add(goalId)

    const currentValue = bucketDrafts[goalId]
    if (currentValue === undefined) {
      releaseBucketSubmittingFlag(goalId)
      return
    }

    const trimmed = currentValue.trim()
    if (trimmed.length === 0) {
      removeBucketDraft(goalId)
      releaseBucketSubmittingFlag(goalId)
      return
    }

    apiCreateBucket(goalId, trimmed)
      .then((db) => {
        const newBucketId = db?.id ?? `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const surface = normalizeBucketSurfaceStyle((db as any)?.buckets_card_style ?? 'glass')
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, surfaceStyle: surface, tasks: [] }
        setGoals((gs) =>
          gs.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  buckets: [newBucket, ...g.buckets],
                }
              : g,
          ),
        )
        // Persist top insertion to align with optimistic UI
        if (db?.id) {
          apiSetBucketSortIndex(goalId, db.id, 0).catch(() => {})
        }
        setBucketExpanded((current) => ({ ...current, [newBucketId]: false }))
        setCompletedCollapsed((current) => ({ ...current, [newBucketId]: true }))
      })
      .catch(() => {
        const newBucketId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, surfaceStyle: 'glass', tasks: [] }
        setGoals((gs) =>
          gs.map((g) => (g.id === goalId ? { ...g, buckets: [newBucket, ...g.buckets] } : g)),
        )
        setBucketExpanded((current) => ({ ...current, [newBucketId]: false }))
        setCompletedCollapsed((current) => ({ ...current, [newBucketId]: true }))
      })

    if (options?.keepDraft) {
      setBucketDrafts((current) => ({ ...current, [goalId]: '' }))
    } else {
      removeBucketDraft(goalId)
    }

    releaseBucketSubmittingFlag(goalId)

    if (options?.keepDraft) {
      if (typeof window !== 'undefined') {
        const scheduleFocus = () => focusBucketDraftInput(goalId)
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleFocus))
        } else {
          window.setTimeout(scheduleFocus, 0)
        }
      }
    }
  }

  const handleBucketDraftCancel = (goalId: string) => {
    submittingBucketDrafts.current.delete(goalId)
    removeBucketDraft(goalId)
  }

  const handleBucketDraftBlur = (goalId: string) => {
    if (submittingBucketDrafts.current.has(goalId)) {
      return
    }
    handleBucketDraftSubmit(goalId)
  }

  const registerBucketDraftRef = (goalId: string, element: HTMLInputElement | null) => {
    if (element) {
      bucketDraftRefs.current.set(goalId, element)
      return
    }
    bucketDraftRefs.current.delete(goalId)
  }

  const openCreateGoal = () => {
    setGoalNameInput('')
    setSelectedGoalGradient(GOAL_GRADIENTS[nextGoalGradientIndex])
    setIsCreateGoalOpen(true)
  }

  const closeCreateGoal = () => {
    setIsCreateGoalOpen(false)
    setGoalNameInput('')
  }

  useEffect(() => {
    if (!isCreateGoalOpen) {
      return
    }
    const input = goalModalInputRef.current
    if (!input) {
      return
    }
    const focus = () => {
      const length = input.value.length
      input.focus()
      input.setSelectionRange(length, length)
    }
    focus()
  }, [isCreateGoalOpen])

  useEffect(() => {
    if (!isCreateGoalOpen) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeCreateGoal()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isCreateGoalOpen])

  const handleCreateGoal = () => {
    const trimmed = goalNameInput.trim()
    if (trimmed.length === 0) {
      const input = goalModalInputRef.current
      if (input) {
        input.focus()
      }
      return
    }
    const gradientForGoal = selectedGoalGradient === 'custom' ? `custom:${customGradientPreview}` : selectedGoalGradient
    apiCreateGoal(trimmed, gradientForGoal)
      .then((db) => {
        const id = db?.id ?? `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const surfaceStyle = normalizeSurfaceStyle((db?.card_surface as string | null | undefined) ?? 'glass')
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, surfaceStyle, starred: false, buckets: [] }
        setGoals((current) => [newGoal, ...current])
        setExpanded((current) => ({ ...current, [id]: true }))
        // Persist new goal at the top to match optimistic UI order
        if (db?.id) {
          apiSetGoalSortIndex(db.id, 0).catch(() => {})
        }
      })
      .catch(() => {
        const id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, surfaceStyle: 'glass', starred: false, buckets: [] }
        setGoals((current) => [newGoal, ...current])
        setExpanded((current) => ({ ...current, [id]: true }))
      })

    setNextGoalGradientIndex((index) => (index + 1) % GOAL_GRADIENTS.length)
    closeCreateGoal()
  }

  const normalizedSearch = searchTerm.trim().toLowerCase()

  const visibleGoals = normalizedSearch
    ? goals.filter((goal) => {
        if (goal.name.toLowerCase().includes(normalizedSearch)) {
          return true
        }
        return goal.buckets.some((bucket) => {
          if (bucket.name.toLowerCase().includes(normalizedSearch)) {
            return true
          }
          return bucket.tasks.some((task) => task.text.toLowerCase().includes(normalizedSearch))
        })
      })
    : goals

  const hasNoGoals = goals.length === 0

  useEffect(() => {
    if (!normalizedSearch) {
      if (previousExpandedRef.current) {
        setExpanded({ ...previousExpandedRef.current })
      }
      if (previousBucketExpandedRef.current) {
        setBucketExpanded({ ...previousBucketExpandedRef.current })
      }
      if (previousCompletedCollapsedRef.current) {
        setCompletedCollapsed({ ...previousCompletedCollapsedRef.current })
      }
      previousExpandedRef.current = null
      previousBucketExpandedRef.current = null
      previousCompletedCollapsedRef.current = null
      return
    }

    if (!previousExpandedRef.current) {
      previousExpandedRef.current = { ...expandedRef.current }
    }
    if (!previousBucketExpandedRef.current) {
      previousBucketExpandedRef.current = { ...bucketExpandedRef.current }
    }
    if (!previousCompletedCollapsedRef.current) {
      previousCompletedCollapsedRef.current = { ...completedCollapsedRef.current }
    }

    const nextExpanded: Record<string, boolean> = {}
    const nextBucketExpanded: Record<string, boolean> = {}
    const nextCompletedCollapsed: Record<string, boolean> = {}

    goals.forEach((goal) => {
      const goalNameMatch = goal.name.toLowerCase().includes(normalizedSearch)
      let goalHasMatch = goalNameMatch

      goal.buckets.forEach((bucket) => {
        const bucketNameMatch = bucket.name.toLowerCase().includes(normalizedSearch)
        const activeMatch = bucket.tasks.some((task) => !task.completed && task.text.toLowerCase().includes(normalizedSearch))
        const completedMatch = bucket.tasks.some((task) => task.completed && task.text.toLowerCase().includes(normalizedSearch))
        const bucketHasMatch = bucketNameMatch || activeMatch || completedMatch

        nextBucketExpanded[bucket.id] = bucketHasMatch
        nextCompletedCollapsed[bucket.id] = completedMatch ? false : true

        if (bucketHasMatch) {
          goalHasMatch = true
        }
      })

      nextExpanded[goal.id] = goalHasMatch
    })

    setExpanded(nextExpanded)
    setBucketExpanded(nextBucketExpanded)
    setCompletedCollapsed(nextCompletedCollapsed)
  }, [normalizedSearch, goals])

  const focusTaskDraftInput = (bucketId: string) => {
    const node = taskDraftRefs.current.get(bucketId)
    if (!node) {
      return
    }
    const length = node.value.length
    node.focus()
    node.setSelectionRange(length, length)
  }

  const startTaskDraft = (_goalId: string, bucketId: string) => {
    setBucketExpanded((current) => ({ ...current, [bucketId]: true }))
    setTaskDrafts((current) => {
      if (bucketId in current) {
        return current
      }
      return { ...current, [bucketId]: '' }
    })

    if (typeof window !== 'undefined') {
      const scheduleFocus = () => focusTaskDraftInput(bucketId)
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleFocus))
      } else {
        window.setTimeout(scheduleFocus, 0)
      }
    }
  }

  const handleTaskDraftChange = (_goalId: string, bucketId: string, value: string) => {
    setTaskDrafts((current) => ({ ...current, [bucketId]: value }))
  }

  const releaseSubmittingFlag = (bucketId: string) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => submittingDrafts.current.delete(bucketId))
    } else if (typeof window !== 'undefined') {
      window.setTimeout(() => submittingDrafts.current.delete(bucketId), 0)
    } else {
      submittingDrafts.current.delete(bucketId)
    }
  }

  const removeTaskDraft = (bucketId: string) => {
    setTaskDrafts((current) => {
      if (current[bucketId] === undefined) {
        return current
      }
      const { [bucketId]: _removed, ...rest } = current
      return rest
    })
  }

  const handleTaskDraftSubmit = (goalId: string, bucketId: string, options?: { keepDraft?: boolean }) => {
    if (submittingDrafts.current.has(bucketId)) {
      return
    }
    submittingDrafts.current.add(bucketId)

    const currentValue = taskDrafts[bucketId]
    if (currentValue === undefined) {
      releaseSubmittingFlag(bucketId)
      return
    }

    const trimmed = currentValue.trim()
    if (trimmed.length === 0) {
      removeTaskDraft(bucketId)
      releaseSubmittingFlag(bucketId)
      return
    }

    const temporaryId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const optimisticTask: TaskItem = { id: temporaryId, text: trimmed, completed: false, difficulty: 'none' }

    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((bucket) => {
                if (bucket.id !== bucketId) return bucket
                const active = bucket.tasks.filter((t) => !t.completed)
                const completed = bucket.tasks.filter((t) => t.completed)
                return { ...bucket, tasks: [optimisticTask, ...active, ...completed] }
              }),
            }
          : g,
      ),
    )

    apiCreateTask(bucketId, trimmed)
      .then((db) => {
        if (!db) {
          return
        }
        setGoals((current) =>
          current.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  buckets: g.buckets.map((bucket) => {
                    if (bucket.id !== bucketId) return bucket
                    return {
                      ...bucket,
                      tasks: bucket.tasks.map((task) =>
                        task.id === temporaryId
                          ? {
                              ...task,
                              id: db.id,
                              text: db.text,
                              completed: db.completed,
                              difficulty: db.difficulty ?? 'none',
                              priority: db.priority ?? false,
                            }
                          : task,
                      ),
                    }
                  }),
                }
              : g,
          ),
        )
      })
      .catch((error) => {
        console.warn('[GoalsPage] Failed to persist new task:', error)
        setGoals((current) =>
          current.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  buckets: g.buckets.map((bucket) =>
                    bucket.id === bucketId
                      ? { ...bucket, tasks: bucket.tasks.filter((task) => task.id !== temporaryId) }
                      : bucket,
                  ),
                }
              : g,
          ),
        )
        if (!options?.keepDraft) {
          setTaskDrafts((drafts) => ({ ...drafts, [bucketId]: trimmed }))
        }
      })

    if (options?.keepDraft) {
      setTaskDrafts((current) => ({ ...current, [bucketId]: '' }))
    } else {
      removeTaskDraft(bucketId)
    }

    releaseSubmittingFlag(bucketId)

    if (options?.keepDraft) {
      if (typeof window !== 'undefined') {
        const scheduleFocus = () => focusTaskDraftInput(bucketId)
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleFocus))
        } else {
          window.setTimeout(scheduleFocus, 0)
        }
      }
    }
  }

  const handleTaskDraftCancel = (bucketId: string) => {
    submittingDrafts.current.delete(bucketId)
    removeTaskDraft(bucketId)
  }

  const handleTaskDraftBlur = (goalId: string, bucketId: string) => {
    if (submittingDrafts.current.has(bucketId)) {
      return
    }
    handleTaskDraftSubmit(goalId, bucketId)
  }

  const registerTaskDraftRef = (bucketId: string, element: HTMLInputElement | null) => {
    if (element) {
      taskDraftRefs.current.set(bucketId, element)
      return
    }
    taskDraftRefs.current.delete(bucketId)
  }

  const handleTaskTextClick = useCallback((goalId: string, bucketId: string, taskId: string) => {
    setFocusPromptTarget((current) => {
      if (
        current &&
        current.goalId === goalId &&
        current.bucketId === bucketId &&
        current.taskId === taskId
      ) {
        return null
      }
      return { goalId, bucketId, taskId }
    })
  }, [])

  const dismissFocusPrompt = useCallback(() => {
    setFocusPromptTarget(null)
  }, [])

  const handleStartFocusTask = useCallback(
    (goal: Goal, bucket: Bucket, task: TaskItem) => {
      broadcastFocusTask({
        goalId: goal.id,
        goalName: goal.name,
        bucketId: bucket.id,
        bucketName: bucket.name,
        taskId: task.id,
        taskName: task.text,
        taskDifficulty: task.difficulty ?? null,
        priority: task.priority ?? null,
        goalSurface: goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
        bucketSurface: bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
        autoStart: true,
      })
      setFocusPromptTarget(null)
    },
    [],
  )

  const toggleTaskCompletion = (goalId: string, bucketId: string, taskId: string) => {
    const previousGoals = goals.map((goal) => ({
      ...goal,
      buckets: goal.buckets.map((bucket) => ({
        ...bucket,
        tasks: bucket.tasks.map((task) => ({ ...task })),
      })),
    }))
    const previousCompletedCollapsed = { ...completedCollapsed }
    let toggledNewCompleted: boolean | null = null
    let shouldCollapseAfterFirstComplete = false

    const nextGoals = goals.map((goal) => {
      if (goal.id !== goalId) {
        return goal
      }
      return {
        ...goal,
        buckets: goal.buckets.map((bucket) => {
          if (bucket.id !== bucketId) {
            return bucket
          }
          const toggled = bucket.tasks.find((t) => t.id === taskId)
          if (!toggled) {
            return bucket
          }
          const newCompleted = !toggled.completed
          toggledNewCompleted = newCompleted
          const previousCompletedCount = bucket.tasks.reduce(
            (count, task) => (task.completed ? count + 1 : count),
            0,
          )
          const updatedTasks = bucket.tasks.map((task) =>
            task.id === taskId ? { ...task, completed: newCompleted } : task,
          )
          const active = updatedTasks.filter((t) => !t.completed)
          const completed = updatedTasks.filter((t) => t.completed)
          if (!shouldCollapseAfterFirstComplete && previousCompletedCount === 0 && completed.length > 0) {
            shouldCollapseAfterFirstComplete = true
          }
          if (newCompleted) {
            const idx = completed.findIndex((t) => t.id === taskId)
            if (idx !== -1) {
              const [mv] = completed.splice(idx, 1)
              completed.push(mv)
            }
            return { ...bucket, tasks: [...active, ...completed] }
          }
          const idx = active.findIndex((t) => t.id === taskId)
          if (idx !== -1) {
            const [mv] = active.splice(idx, 1)
            active.push(mv)
          }
          return { ...bucket, tasks: [...active, ...completed] }
        }),
      }
    })

    setGoals(nextGoals)

    if (shouldCollapseAfterFirstComplete) {
      setCompletedCollapsed((current) => ({
        ...current,
        [bucketId]: true,
      }))
    }

    if (toggledNewCompleted !== null) {
      apiSetTaskCompletedAndResort(taskId, bucketId, toggledNewCompleted)
        .then((persisted) => {
          const persistedCompleted =
            persisted && typeof persisted.completed === 'string'
              ? persisted.completed.toLowerCase() === 'true'
              : Boolean(persisted?.completed)
          if (persistedCompleted !== toggledNewCompleted) {
            console.warn(
              '[GoalsPage] Supabase completion toggle mismatch; expected',
              toggledNewCompleted,
              'but received',
              persisted?.completed,
            )
            setGoals(() => previousGoals)
            setCompletedCollapsed(() => previousCompletedCollapsed)
          }
        })
        .catch((error) => {
          console.warn('[GoalsPage] Failed to persist task completion toggle:', error)
          setGoals(() => previousGoals)
          setCompletedCollapsed(() => previousCompletedCollapsed)
        })
    }
  }

  const cycleTaskDifficulty = (goalId: string, bucketId: string, taskId: string) => {
    const nextOf = (d?: 'none' | 'green' | 'yellow' | 'red') => {
      switch (d) {
        case 'none':
        case undefined:
          return 'green' as const
        case 'green':
          return 'yellow' as const
        case 'yellow':
          return 'red' as const
        case 'red':
          return 'none' as const
      }
    }
    // Compute next difficulty first to persist the correct value
    const cur = goals
      .find((g) => g.id === goalId)?.buckets
      .find((b) => b.id === bucketId)?.tasks.find((t) => t.id === taskId)
    const nextDiff = nextOf(cur?.difficulty)
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) =>
                b.id === bucketId
                  ? { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, difficulty: nextDiff } : t)) }
                  : b,
              ),
            }
          : g,
      ),
    )
    apiSetTaskDifficulty(taskId, nextDiff as any).catch(() => {})
  }

  // Toggle priority on a task with a long-press on the difficulty control.
  // Local-only: reorders task to the top of its current section when enabling.
  const toggleTaskPriority = (goalId: string, bucketId: string, taskId: string) => {
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g
        return {
          ...g,
          buckets: g.buckets.map((b) => {
            if (b.id !== bucketId) return b
            const idx = b.tasks.findIndex((t) => t.id === taskId)
            if (idx < 0) return b
            const current = b.tasks[idx]
            const nextPriority = !(current.priority ?? false)
            // Update priority flag first
            let updatedTasks = b.tasks.map((t, i) => (i === idx ? { ...t, priority: nextPriority } : t))
            const moved = updatedTasks.find((t) => t.id === taskId)!
            const active = updatedTasks.filter((t) => !t.completed)
            const completed = updatedTasks.filter((t) => t.completed)
            if (nextPriority) {
              if (!moved.completed) {
                const without = active.filter((t) => t.id !== taskId)
                const newActive = [moved, ...without]
                updatedTasks = [...newActive, ...completed]
              } else {
                const without = completed.filter((t) => t.id !== taskId)
                const newCompleted = [moved, ...without]
                updatedTasks = [...active, ...newCompleted]
              }
            } else {
              // De-prioritise: keep within same section, insert as first non-priority
              if (!moved.completed) {
                const prios = active.filter((t) => t.priority)
                const non = active.filter((t) => !t.priority && t.id !== taskId)
                const newActive = [...prios, moved, ...non]
                updatedTasks = [...newActive, ...completed]
              } else {
                const prios = completed.filter((t) => t.priority)
                const non = completed.filter((t) => !t.priority && t.id !== taskId)
                const newCompleted = [...prios, moved, ...non]
                updatedTasks = [...active, ...newCompleted]
              }
            }
            return { ...b, tasks: updatedTasks }
          }),
        }
      }),
    )
    const task = goals
      .find((g) => g.id === goalId)?.buckets
      .find((b) => b.id === bucketId)?.tasks
      .find((t) => t.id === taskId)
    const completed = !!task?.completed
    const nextPriority = !(task?.priority ?? false)
    apiSetTaskPriorityAndResort(taskId, bucketId, completed, nextPriority).catch(() => {})
  }

  // Inline edit existing task text (Google Tasks-style)
  const registerTaskEditRef = (taskId: string, element: HTMLSpanElement | null) => {
    if (element) {
      taskEditRefs.current.set(taskId, element)
      const text = taskEdits[taskId] ?? ''
      if (element.textContent !== text) {
        element.textContent = text
      }
      return
    }
    taskEditRefs.current.delete(taskId)
  }

  const focusTaskEditInput = (taskId: string, caretOffset?: number | null) => {
    const node = taskEditRefs.current.get(taskId)
    if (!node) return
    node.focus()
    if (typeof window !== 'undefined') {
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        const textLength = node.textContent?.length ?? 0
        const targetOffset =
          caretOffset === undefined || caretOffset === null
            ? textLength
            : Math.max(0, Math.min(caretOffset, textLength))
        if (targetOffset === textLength) {
          range.selectNodeContents(node)
          range.collapse(false)
        } else {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
          let remaining = targetOffset
          let current: Node | null = null
          let positioned = false
          while ((current = walker.nextNode())) {
            const length = current.textContent?.length ?? 0
            if (remaining <= length) {
              range.setStart(current, Math.max(0, remaining))
              positioned = true
              break
            }
            remaining -= length
          }
          if (!positioned) {
            range.selectNodeContents(node)
            range.collapse(false)
          } else {
            range.collapse(true)
          }
        }
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  const startTaskEdit = (
    goalId: string,
    bucketId: string,
    taskId: string,
    initial: string,
    options?: { caretOffset?: number | null },
  ) => {
    setTaskEdits((current) => ({ ...current, [taskId]: initial }))
    // Expand parent bucket to ensure visible
    setBucketExpanded((current) => ({ ...current, [bucketId]: true }))
    if (focusPromptTarget) {
      setFocusPromptTarget((current) =>
        current && current.goalId === goalId && current.bucketId === bucketId && current.taskId === taskId ? null : current,
      )
    }
    if (typeof window !== 'undefined') {
      const scheduleFocus = () => focusTaskEditInput(taskId, options?.caretOffset ?? null)
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleFocus))
      } else {
        window.setTimeout(scheduleFocus, 0)
      }
    }
  }

  const handleTaskEditChange = (taskId: string, value: string) => {
    setTaskEdits((current) => ({ ...current, [taskId]: value }))
  }

  const releaseEditSubmittingFlag = (taskId: string) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => submittingEdits.current.delete(taskId))
    } else if (typeof window !== 'undefined') {
      window.setTimeout(() => submittingEdits.current.delete(taskId), 0)
    } else {
      submittingEdits.current.delete(taskId)
    }
  }

  const removeTaskEdit = (taskId: string) => {
    setTaskEdits((current) => {
      if (current[taskId] === undefined) return current
      const { [taskId]: _removed, ...rest } = current
      return rest
    })
  }

  const handleTaskEditSubmit = (goalId: string, bucketId: string, taskId: string) => {
    if (submittingEdits.current.has(taskId)) return
    submittingEdits.current.add(taskId)

    const currentValue = taskEdits[taskId]
    if (currentValue === undefined) {
      releaseEditSubmittingFlag(taskId)
      return
    }

    const trimmed = currentValue.trim()
    const nextText = trimmed.length === 0 ? '' : trimmed

    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) =>
                b.id === bucketId
                  ? { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, text: nextText } : t)) }
                  : b,
              ),
            }
          : g,
      ),
    )

    // Keep empty possible to allow user to type after blur; mimic Google Tasks keeps empty allowed
    // but if you prefer fallback, uncomment next two lines:
    // const fallback = nextText.length > 0 ? nextText : '(untitled)'
    // setGoals(... with fallback ...)

    removeTaskEdit(taskId)
    releaseEditSubmittingFlag(taskId)
    if (nextText.length > 0) {
      apiUpdateTaskText(taskId, nextText).catch(() => {})
    }
  }

  const handleTaskEditBlur = (goalId: string, bucketId: string, taskId: string) => {
    if (submittingEdits.current.has(taskId)) return
    handleTaskEditSubmit(goalId, bucketId, taskId)
  }

  const handleTaskEditCancel = (taskId: string) => {
    submittingEdits.current.delete(taskId)
    removeTaskEdit(taskId)
  }

  const toggleCompletedSection = (bucketId: string) => {
    setCompletedCollapsed((current) => ({
      ...current,
      [bucketId]: !(current[bucketId] ?? true),
    }))
  }

  const toggleBucketFavorite = (goalId: string, bucketId: string) => {
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? { ...g, buckets: g.buckets.map((b) => (b.id === bucketId ? { ...b, favorite: !b.favorite } : b)) }
          : g
      )
    )
    const current = goals.find((g) => g.id === goalId)?.buckets.find((b) => b.id === bucketId)
    const next = !(current?.favorite ?? false)
    apiSetBucketFavorite(bucketId, next).catch(() => {})
  }

  const updateBucketSurface = (goalId: string, bucketId: string, surface: BucketSurfaceStyle) => {
    const normalized = normalizeBucketSurfaceStyle(surface)
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) => (b.id === bucketId ? { ...b, surfaceStyle: normalized } : b)),
            }
          : g,
      ),
    )
    apiSetBucketSurface(bucketId, normalized).catch(() => {})
  }

  // Reorder tasks within a bucket section (active or completed), similar to Google Tasks
  const reorderTasks = (
    goalId: string,
    bucketId: string,
    section: 'active' | 'completed',
    fromIndex: number,
    toIndex: number,
  ) => {
    // Determine moved task id based on current state before mutation
    const bucket = goals.find((g) => g.id === goalId)?.buckets.find((b) => b.id === bucketId)
    const listBefore = (bucket?.tasks ?? []).filter((t) => (section === 'active' ? !t.completed : t.completed))
    const movedId = listBefore[fromIndex]?.id
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g
        return {
          ...g,
          buckets: g.buckets.map((b) => {
            if (b.id !== bucketId) return b
            const active = b.tasks.filter((t) => !t.completed)
            const completed = b.tasks.filter((t) => t.completed)
            const list = section === 'active' ? active : completed
            if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) {
              return b
            }
            const nextList = list.slice()
            const [moved] = nextList.splice(fromIndex, 1)
            nextList.splice(toIndex, 0, moved)
            const newTasks = section === 'active' ? [...nextList, ...completed] : [...active, ...nextList]
            return { ...b, tasks: newTasks }
          }),
        }
      }),
    )
    if (movedId) {
      apiSetTaskSortIndex(bucketId, section, toIndex, movedId).catch(() => {})
    }
  }

  // Reorder buckets within a goal
  const reorderBuckets = (
    goalId: string,
    fromIndex: number,
    toIndex: number,
  ) => {
    // Determine moved bucket id
    const goal = goals.find((g) => g.id === goalId)
    const movedBucketId = goal?.buckets?.[fromIndex]?.id
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g
        const list = g.buckets
        if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex > list.length) {
          return g
        }
        const next = list.slice()
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ...g, buckets: next }
      }),
    )
    if (movedBucketId) {
      apiSetBucketSortIndex(goalId, movedBucketId, toIndex).catch(() => {})
    }
  }

  // Collapse all other open goals during a goal drag; return snapshot of open goal IDs (excluding dragged)
  const collapseOtherGoalsForDrag = (draggedId: string): string[] => {
    const current = expandedRef.current
    const openIds = Object.keys(current).filter((id) => id !== draggedId && current[id])
    if (openIds.length === 0) return []
    setExpanded((prev) => {
      const next = { ...prev }
      for (const id of openIds) next[id] = false
      return next
    })
    return openIds
  }

  // Restore a set of goals to open state
  const restoreGoalsOpenState = (ids: string[]) => {
    if (!ids || ids.length === 0) return
    setExpanded((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = true
      return next
    })
  }

  // Compute insertion metrics for goal list, mirroring bucket logic
  const computeGoalInsertMetrics = (listEl: HTMLElement, y: number) => {
    const items = Array.from(listEl.querySelectorAll('li.goal-entry')) as HTMLElement[]
    const candidates = items.filter(
      (el) => !el.classList.contains('dragging') && !el.classList.contains('goal-entry--collapsed'),
    )
    const listRect = listEl.getBoundingClientRect()
    const cs = window.getComputedStyle(listEl)
    const padTop = parseFloat(cs.paddingTop || '0') || 0
    const padBottom = parseFloat(cs.paddingBottom || '0') || 0
    if (candidates.length === 0) {
      const rawTop = (padTop - 1) / 2
      const clamped = Math.max(0.5, Math.min(rawTop, listRect.height - 0.5))
      const top = Math.round(clamped * 2) / 2
      return { index: 0, top }
    }
    const rects = candidates.map((el) => el.getBoundingClientRect())
    const anchors: Array<{ y: number; index: number }> = []
    anchors.push({ y: rects[0].top, index: 0 })
    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i]
      const b = rects[i + 1]
      const mid = a.bottom + (b.top - a.bottom) / 2
      anchors.push({ y: mid, index: i + 1 })
    }
    anchors.push({ y: rects[rects.length - 1].bottom, index: rects.length })

    let best = anchors[0]
    let bestDist = Math.abs(y - best.y)
    for (let i = 1; i < anchors.length; i++) {
      const d = Math.abs(y - anchors[i].y)
      if (d < bestDist) {
        best = anchors[i]
        bestDist = d
      }
    }
    let rawTop = 0
    if (best.index <= 0) {
      rawTop = (padTop - 1) / 2
    } else if (best.index >= candidates.length) {
      const last = candidates[candidates.length - 1]
      const a = last.getBoundingClientRect()
      rawTop = a.bottom - listRect.top + (padBottom - 1) / 2
    } else {
      const prev = candidates[best.index - 1]
      const next = candidates[best.index]
      const a = prev.getBoundingClientRect()
      const b = next.getBoundingClientRect()
      const gap = Math.max(0, b.top - a.bottom)
      rawTop = a.bottom - listRect.top + (gap - 1) / 2
    }
    const clamped = Math.max(0.5, Math.min(rawTop, listRect.height - 0.5))
    const top = Math.round(clamped * 2) / 2
    return { index: best.index, top }
  }

  // Reorder goals across the top-level list using a visible→global mapping
  const reorderGoalsByVisibleInsert = (goalId: string, toVisibleIndex: number) => {
    const fromGlobalIndex = goals.findIndex((g) => g.id === goalId)
    if (fromGlobalIndex === -1) return
    // Build the visible list exactly like the DOM candidates used for insert metrics,
    // but exclude the dragged goal so indices match the hover line positions.
    const visible = normalizedSearch
      ? goals.filter((g) =>
          (g.id !== goalId) && (
            g.name.toLowerCase().includes(normalizedSearch) ||
            g.buckets.some((b) => b.name.toLowerCase().includes(normalizedSearch) || b.tasks.some((t) => t.text.toLowerCase().includes(normalizedSearch)))
          )
        )
      : goals.filter((g) => g.id !== goalId)
    const visibleIds = visible.map((g) => g.id)
    // Clamp target visible index to [0, visibleIds.length]
    const clampedVisibleIndex = Math.max(0, Math.min(toVisibleIndex, visibleIds.length))
    // Resolve the global insertion index relative to the nearest visible anchor
    let toGlobalIndex: number
    if (visibleIds.length === 0) {
      // Only the dragged item is visible; place at start
      toGlobalIndex = 0
    } else if (clampedVisibleIndex === 0) {
      // Insert before first visible
      const anchorId = visibleIds[0]
      toGlobalIndex = goals.findIndex((g) => g.id === anchorId)
    } else if (clampedVisibleIndex >= visibleIds.length) {
      // Insert after last visible
      const lastId = visibleIds[visibleIds.length - 1]
      toGlobalIndex = goals.findIndex((g) => g.id === lastId) + 1
    } else {
      const anchorId = visibleIds[clampedVisibleIndex]
      toGlobalIndex = goals.findIndex((g) => g.id === anchorId)
    }
    // Adjust target if removing the item shifts indices
    let adjustedTo = toGlobalIndex
    if (fromGlobalIndex < toGlobalIndex) {
      adjustedTo = Math.max(0, toGlobalIndex - 1)
    }
    if (fromGlobalIndex === adjustedTo) {
      return
    }
    setGoals((gs) => {
      const next = gs.slice()
      const [moved] = next.splice(fromGlobalIndex, 1)
      next.splice(adjustedTo, 0, moved)
      return next
    })
    // Persist using the computed global insertion index
    apiSetGoalSortIndex(goalId, adjustedTo).catch(() => {})
  }

  const customizerPortal =
    activeCustomizerGoal && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="goal-customizer-overlay"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeCustomizer()
              }
            }}
          >
            <div
              ref={customizerDialogRef}
              className="goal-customizer-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Customise goal ${activeCustomizerGoal.name}`}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <GoalCustomizer
                goal={activeCustomizerGoal}
                onUpdate={(updates) => updateGoalAppearance(activeCustomizerGoal.id, updates)}
                onClose={closeCustomizer}
              />
            </div>
          </div>,
          document.body,
        )
      : null
  return (
    <div className="goals-layer text-white">
      <div className="goals-content site-main__inner">
        <div className="goals-main">
          <section className="goals-intro">
            <h1 className="goals-heading">Goals</h1>
            <p className="text-white/70 mt-1">
              Sleek rows with thin progress bars. Expand a goal to see Task Bank. Add buckets and capture tasks inside.
            </p>
          </section>

          <div className="goals-toolbar">
            <div className="goal-search">
              <svg className="goal-search__icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" fill="none" />
                <line x1="15.35" y1="15.35" x2="21" y2="21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                placeholder="Search goals"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                aria-label="Search goals"
              />
            </div>
            <button type="button" className="goal-new-button" onClick={openCreateGoal}>
              + New Goal
            </button>
          </div>

          {hasNoGoals && visibleGoals.length === 0 ? (
            <p className="text-white/70 text-sm">No goals yet.</p>
          ) : visibleGoals.length === 0 ? (
            <p className="text-white/70 text-sm">
              No goals match “{searchTerm.trim()}”.
            </p>
          ) : (
            <ul
              className="goal-list space-y-3 md:space-y-4"
              onDragOver={(e) => {
                const info = (window as any).__dragGoalInfo as | { goalId: string; wasOpen?: boolean } | null
                if (!info) return
                e.preventDefault()
                try { e.dataTransfer.dropEffect = 'move' } catch {}
                const list = e.currentTarget as HTMLElement
                const { index, top } = computeGoalInsertMetrics(list, e.clientY)
                setGoalHoverIndex((cur) => (cur === index ? cur : index))
                setGoalLineTop(top)
              }}
              onDrop={(e) => {
                const info = (window as any).__dragGoalInfo as | { goalId: string; wasOpen?: boolean; openIds?: string[] } | null
                if (!info) return
                e.preventDefault()
                const toIndex = goalHoverIndex ?? visibleGoals.length
                reorderGoalsByVisibleInsert(info.goalId, toIndex)
                // Restore goals open state snapshot
                if (info.openIds && info.openIds.length > 0) {
                  restoreGoalsOpenState(info.openIds)
                }
                if (info.wasOpen) {
                  restoreGoalsOpenState([info.goalId])
                }
                setGoalHoverIndex(null)
                setGoalLineTop(null)
                ;(window as any).__dragGoalInfo = null
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setGoalHoverIndex(null)
                setGoalLineTop(null)
              }}
            >
              {goalLineTop !== null ? (
                <div className="goal-insert-line" style={{ top: `${goalLineTop}px` }} aria-hidden />
              ) : null}
              {visibleGoals.map((g) => (
                <li key={g.id} className="goal-entry" data-goal-id={g.id}>
                  <GoalRow
                    goal={g}
                    isOpen={expanded[g.id] ?? false}
                    onToggle={() => toggleExpand(g.id)}
                    onDeleteGoal={(goalId) => deleteGoal(goalId)}
                    onCollapseOtherGoalsForDrag={collapseOtherGoalsForDrag}
                    onRestoreGoalsOpenState={restoreGoalsOpenState}
                    isRenaming={renamingGoalId === g.id}
                    goalRenameValue={renamingGoalId === g.id ? goalRenameDraft : undefined}
                    onStartGoalRename={(goalId, initial) => startGoalRename(goalId, initial)}
                    onGoalRenameChange={(value) => handleGoalRenameChange(value)}
                    onGoalRenameSubmit={() => submitGoalRename()}
                  onGoalRenameCancel={() => cancelGoalRename()}
                  renamingBucketId={renamingBucketId}
                  bucketRenameValue={bucketRenameDraft}
                  onStartBucketRename={(goalId, bucketId, initial) => startBucketRename(goalId, bucketId, initial)}
                  onBucketRenameChange={(value) => handleBucketRenameChange(value)}
                  onBucketRenameSubmit={() => submitBucketRename()}
                  onBucketRenameCancel={() => cancelBucketRename()}
                  onDeleteBucket={(bucketId) => deleteBucket(g.id, bucketId)}
                  onDeleteCompletedTasks={(bucketId) => deleteCompletedTasks(g.id, bucketId)}
                  onToggleBucketFavorite={(bucketId) => toggleBucketFavorite(g.id, bucketId)}
                  onUpdateBucketSurface={(goalId, bucketId, surface) => updateBucketSurface(goalId, bucketId, surface)}
                  bucketExpanded={bucketExpanded}
                  onToggleBucketExpanded={toggleBucketExpanded}
                  completedCollapsed={completedCollapsed}
                  onToggleCompletedCollapsed={toggleCompletedSection}
                  taskDetails={taskDetails}
                  handleToggleTaskDetails={handleToggleTaskDetails}
                  handleTaskNotesChange={handleTaskNotesChange}
                  handleAddSubtask={handleAddSubtask}
                  handleSubtaskTextChange={handleSubtaskTextChange}
                  handleToggleSubtaskCompleted={handleToggleSubtaskCompleted}
                  handleRemoveSubtask={handleRemoveSubtask}
                  taskDrafts={taskDrafts}
                  onStartTaskDraft={startTaskDraft}
                  onTaskDraftChange={handleTaskDraftChange}
                  onTaskDraftSubmit={handleTaskDraftSubmit}
                  onTaskDraftBlur={handleTaskDraftBlur}
                  onTaskDraftCancel={handleTaskDraftCancel}
                  registerTaskDraftRef={registerTaskDraftRef}
                  bucketDraftValue={bucketDrafts[g.id]}
                  onStartBucketDraft={startBucketDraft}
                  onBucketDraftChange={handleBucketDraftChange}
                  onBucketDraftSubmit={handleBucketDraftSubmit}
                  onBucketDraftBlur={handleBucketDraftBlur}
                  onBucketDraftCancel={handleBucketDraftCancel}
                  registerBucketDraftRef={registerBucketDraftRef}
                  highlightTerm={normalizedSearch}
                  onToggleTaskComplete={(bucketId, taskId) => toggleTaskCompletion(g.id, bucketId, taskId)}
                  onCycleTaskDifficulty={(bucketId, taskId) => cycleTaskDifficulty(g.id, bucketId, taskId)}
                  onToggleTaskPriority={(bucketId, taskId) => toggleTaskPriority(g.id, bucketId, taskId)}
                  editingTasks={taskEdits}
                  onStartTaskEdit={(goalId, bucketId, taskId, initial, options) =>
                    startTaskEdit(goalId, bucketId, taskId, initial, options)
                  }
                  onTaskEditChange={handleTaskEditChange}
                  onTaskEditSubmit={(goalId, bucketId, taskId) => handleTaskEditSubmit(goalId, bucketId, taskId)}
                  onTaskEditBlur={(goalId, bucketId, taskId) => handleTaskEditBlur(goalId, bucketId, taskId)}
                  onTaskEditCancel={(taskId) => handleTaskEditCancel(taskId)}
                  registerTaskEditRef={registerTaskEditRef}
                  focusPromptTarget={focusPromptTarget}
                  onTaskTextClick={handleTaskTextClick}
                  onDismissFocusPrompt={dismissFocusPrompt}
                  onStartFocusTask={handleStartFocusTask}
                  onReorderTasks={(goalId, bucketId, section, fromIndex, toIndex) =>
                    reorderTasks(goalId, bucketId, section, fromIndex, toIndex)
                  }
                  onReorderBuckets={reorderBuckets}
                  onOpenCustomizer={(goalId) => setActiveCustomizerGoalId(goalId)}
                  activeCustomizerGoalId={activeCustomizerGoalId}
                  isStarred={Boolean(g.starred)}
                  onToggleStarred={() => toggleGoalStarred(g.id)}
                />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="pointer-events-none fixed -z-10 inset-0 opacity-30">
        <div className="absolute -top-24 -left-24 h-72 w-72 bg-fuchsia-500 blur-3xl rounded-full mix-blend-screen" />
        <div className="absolute -bottom-28 -right-24 h-80 w-80 bg-indigo-500 blur-3xl rounded-full mix-blend-screen" />
      </div>

      {customizerPortal}

      {isCreateGoalOpen && (
        <div className="goal-modal-backdrop" role="presentation" onClick={closeCreateGoal}>
          <div
            className="goal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-goal-title"
            aria-describedby="create-goal-description"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="goal-modal__header">
              <h2 id="create-goal-title">Create Goal</h2>
              <p id="create-goal-description">Give it a short, motivating name. You can link buckets after creating.</p>
            </header>

            <div className="goal-modal__body">
              <label className="goal-modal__label" htmlFor="goal-name-input">
                Name
              </label>
              <input
                id="goal-name-input"
                ref={goalModalInputRef}
                value={goalNameInput}
                onChange={(event) => setGoalNameInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleCreateGoal()
                  }
                }}
                placeholder="e.g., Finish PopDot Beta"
                className="goal-modal__input"
              />

              <p className="goal-modal__label">Accent Gradient</p>
              <div className="goal-gradient-grid">
                {gradientOptions.map((gradient) => {
                  const isActive = gradient === selectedGoalGradient
                  const preview = gradientPreview[gradient]
                  return (
                    <button
                      key={gradient}
                      type="button"
                      className={classNames('goal-gradient-option', isActive && 'goal-gradient-option--active')}
                      aria-pressed={isActive}
                      onClick={() => setSelectedGoalGradient(gradient)}
                      aria-label={gradient === 'custom' ? 'Select custom gradient' : `Select gradient ${gradient}`}
                    >
                      <span className="goal-gradient-swatch" style={{ background: preview }}>
                        {gradient === 'custom' && !isActive && <span className="goal-gradient-plus" aria-hidden="true">+</span>}
                      </span>
                    </button>
                  )
                })}
              </div>

              {selectedGoalGradient === 'custom' && (
                <div className="goal-gradient-custom-editor">
                  <div className="goal-gradient-custom-field">
                    <label htmlFor="custom-gradient-start">Start</label>
                    <input
                      id="custom-gradient-start"
                      type="color"
                      value={customGradient.start}
                      onChange={(event) => setCustomGradient((current) => ({ ...current, start: event.target.value }))}
                    />
                  </div>
                  <div className="goal-gradient-custom-field">
                    <label htmlFor="custom-gradient-end">End</label>
                    <input
                      id="custom-gradient-end"
                      type="color"
                      value={customGradient.end}
                      onChange={(event) => setCustomGradient((current) => ({ ...current, end: event.target.value }))}
                    />
                  </div>
                  <div className="goal-gradient-custom-field goal-gradient-custom-field--angle">
                    <label htmlFor="custom-gradient-angle">Angle</label>
                    <div className="goal-gradient-angle">
                      <input
                        id="custom-gradient-angle"
                        type="range"
                        min="0"
                        max="360"
                        value={customGradient.angle}
                        onChange={(event) => setCustomGradient((current) => ({ ...current, angle: Number(event.target.value) }))}
                      />
                      <span className="goal-gradient-angle-value">{customGradient.angle}°</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <footer className="goal-modal__footer">
              <button type="button" className="goal-modal__button goal-modal__button--muted" onClick={closeCreateGoal}>
                Cancel
              </button>
              <button
                type="button"
                className="goal-modal__button goal-modal__button--primary"
                onClick={handleCreateGoal}
                disabled={goalNameInput.trim().length === 0}
              >
                Create
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
