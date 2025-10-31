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
  setBucketArchived as apiSetBucketArchived,
  setGoalColor as apiSetGoalColor,
  setGoalSurface as apiSetGoalSurface,
  setGoalStarred as apiSetGoalStarred,
  setGoalArchived as apiSetGoalArchived,
  deleteBucketById as apiDeleteBucketById,
  deleteCompletedTasksInBucket as apiDeleteCompletedTasksInBucket,
  deleteTaskById as apiDeleteTaskById,
  createTask as apiCreateTask,
  updateTaskText as apiUpdateTaskText,
  updateTaskNotes as apiUpdateTaskNotes,
  setTaskDifficulty as apiSetTaskDifficulty,
  setTaskCompletedAndResort as apiSetTaskCompletedAndResort,
  setTaskSortIndex as apiSetTaskSortIndex,
  setBucketSortIndex as apiSetBucketSortIndex,
  setGoalSortIndex as apiSetGoalSortIndex,
  setTaskPriorityAndResort as apiSetTaskPriorityAndResort,
  upsertTaskSubtask as apiUpsertTaskSubtask,
  deleteTaskSubtask as apiDeleteTaskSubtask,
  seedGoalsIfEmpty,
  fetchTaskNotes as apiFetchTaskNotes,
  fetchGoalMilestones as apiFetchGoalMilestones,
  upsertGoalMilestone as apiUpsertGoalMilestone,
  deleteGoalMilestone as apiDeleteGoalMilestone,
  fetchGoalCreatedAt as apiFetchGoalCreatedAt,
} from '../lib/goalsApi'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  LIFE_ROUTINE_STORAGE_KEY,
  LIFE_ROUTINE_UPDATE_EVENT,
  readStoredLifeRoutines,
  sanitizeLifeRoutineList,
  syncLifeRoutinesWithSupabase,
  writeStoredLifeRoutines,
  type LifeRoutineConfig,
} from '../lib/lifeRoutines'
import {
  createGoalsSnapshot,
  publishGoalsSnapshot,
  readStoredGoalsSnapshot,
  subscribeToGoalsSnapshot,
  type GoalSnapshot,
} from '../lib/goalsSync'
import { broadcastFocusTask } from '../lib/focusChannel'
import { broadcastScheduleTask } from '../lib/scheduleChannel'

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
  notes?: string | null
  subtasks?: TaskSubtask[]
}

type TaskSubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
}

type TaskDetails = {
  notes: string
  subtasks: TaskSubtask[]
  expanded: boolean
  subtasksCollapsed: boolean
}

type TaskDetailsState = Record<string, TaskDetails>

const ensureTaskDifficultyValue = (value: unknown): TaskItem['difficulty'] => {
  if (value === 'green' || value === 'yellow' || value === 'red') {
    return value
  }
  return 'none'
}

const normalizeSupabaseTaskSubtasks = (value: unknown): TaskSubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((subtask: any, index: number) => {
    const id = typeof subtask?.id === 'string' ? subtask.id : `subtask-${index}`
    const text = typeof subtask?.text === 'string' ? subtask.text : ''
    const completed = Boolean(subtask?.completed)
    const sortIndex =
      typeof subtask?.sortIndex === 'number'
        ? subtask.sortIndex
        : typeof subtask?.sort_index === 'number'
          ? subtask.sort_index
          : (index + 1) * SUBTASK_SORT_STEP
    return {
      id,
      text,
      completed,
      sortIndex,
    }
  })
}

const normalizeSupabaseGoalsPayload = (payload: any[]): Goal[] =>
  payload.map((goal: any) => ({
    id: goal.id,
    name: goal.name,
    color: typeof goal.color === 'string' ? goal.color : FALLBACK_GOAL_COLOR,
    createdAt: typeof goal.createdAt === 'string' ? goal.createdAt : typeof goal.created_at === 'string' ? goal.created_at : undefined,
    surfaceStyle: normalizeSurfaceStyle(goal.surfaceStyle as string | null | undefined),
    starred: Boolean(goal.starred),
    archived: Boolean(goal.archived),
    buckets: Array.isArray(goal.buckets)
      ? goal.buckets.map((bucket: any) => ({
          id: bucket.id,
          name: bucket.name,
          favorite: Boolean(bucket.favorite),
          archived: Boolean(bucket.archived),
          surfaceStyle: normalizeBucketSurfaceStyle(bucket.surfaceStyle as string | null | undefined),
          tasks: Array.isArray(bucket.tasks)
            ? bucket.tasks.map((task: any) => ({
                id: task.id,
                text: task.text,
                completed: Boolean(task.completed),
                difficulty: ensureTaskDifficultyValue(task.difficulty),
                priority: Boolean(task.priority),
                notes: typeof task.notes === 'string' ? task.notes : '',
                subtasks: normalizeSupabaseTaskSubtasks(task.subtasks),
              }))
            : [],
        }))
      : [],
  }))

const createTaskDetails = (overrides?: Partial<TaskDetails>): TaskDetails => ({
  notes: '',
  subtasks: [],
  expanded: false,
  subtasksCollapsed: false,
  ...overrides,
})

const TASK_DETAILS_STORAGE_KEY = 'nc-taskwatch-task-details-v1'
const LIFE_ROUTINES_NAME = 'Life Routines'
const LIFE_ROUTINES_TAGLINE = 'A steady cadence for your everyday wellbeing.'
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const LIFE_ROUTINES_SURFACE: GoalSurfaceStyle = 'linen'

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
      const sortIndex =
        typeof candidate.sortIndex === 'number'
          ? candidate.sortIndex
          : typeof (candidate as any).sort_index === 'number'
            ? ((candidate as any).sort_index as number)
            : 0
      return { id, text, completed, sortIndex }
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
    const subtasksCollapsed = Boolean((candidate as any).subtasksCollapsed)
    next[taskId] = { notes, subtasks, expanded, subtasksCollapsed }
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
  if (a.notes !== b.notes || a.expanded !== b.expanded || a.subtasksCollapsed !== b.subtasksCollapsed) {
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

const cloneTaskSubtasks = (subtasks: TaskSubtask[]): TaskSubtask[] =>
  subtasks.map((subtask) => ({ ...subtask }))

const areGoalTaskSubtasksEqual = (
  left: TaskSubtask[] | undefined,
  right: TaskSubtask[],
): boolean => {
  const a = Array.isArray(left) ? left : []
  if (a.length !== right.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    const nextLeft = a[index]
    const nextRight = right[index]
    if (
      !nextRight ||
      nextLeft.id !== nextRight.id ||
      nextLeft.text !== nextRight.text ||
      nextLeft.completed !== nextRight.completed ||
      nextLeft.sortIndex !== nextRight.sortIndex
    ) {
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

const SUBTASK_SORT_STEP = 1024

const createEmptySubtask = (sortIndex: number) => ({
  id: createSubtaskId(),
  text: '',
  completed: false,
  sortIndex,
})

const getNextSubtaskSortIndex = (subtasks: TaskSubtask[]): number => {
  if (subtasks.length === 0) {
    return SUBTASK_SORT_STEP
  }
  let max = 0
  for (let index = 0; index < subtasks.length; index += 1) {
    const candidate = subtasks[index]?.sortIndex ?? 0
    if (candidate > max) {
      max = candidate
    }
  }
  return max + SUBTASK_SORT_STEP
}

const sanitizeDomIdSegment = (value: string): string => value.replace(/[^a-z0-9]/gi, '-')

const makeGoalSubtaskInputId = (taskId: string, subtaskId: string): string =>
  `goal-subtask-${sanitizeDomIdSegment(taskId)}-${sanitizeDomIdSegment(subtaskId)}`

const SHOW_TASK_DETAILS = true as const

// Auto-size a textarea to fit its content without requiring focus
const autosizeTextArea = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  try {
    el.style.height = 'auto'
    const next = `${el.scrollHeight}px`
    el.style.height = next
  } catch {}
}

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
  archived: boolean
  tasks: TaskItem[]
  surfaceStyle?: BucketSurfaceStyle
}

export interface Goal {
  id: string
  name: string
  color: string
  createdAt?: string
  surfaceStyle?: GoalSurfaceStyle
  starred: boolean
  archived: boolean
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
    archived: false,
    buckets: [
      {
        id: 'b_demo_1',
        name: 'Planning',
        favorite: true,
        archived: false,
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
        archived: false,
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
        archived: false,
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
        archived: false,
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
    archived: false,
    buckets: [
      {
        id: 'b1',
        name: 'Coding',
        favorite: true,
        archived: false,
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
        archived: false,
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
        archived: false,
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
    archived: false,
    buckets: [
      {
        id: 'b4',
        name: 'Flashcards',
        favorite: true,
        archived: false,
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
        archived: false,
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
        archived: false,
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
    archived: false,
    buckets: [
      {
        id: 'b7',
        name: 'Gym',
        favorite: true,
        archived: false,
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
        archived: false,
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
        archived: false,
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
  archived: Boolean(goal.archived),
  buckets: goal.buckets.map((bucket) => ({
    name: bucket.name,
    favorite: bucket.favorite,
    archived: bucket.archived,
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
      createdAt: existingGoal?.createdAt,
      surfaceStyle: goal.surfaceStyle,
      starred: goal.starred ?? existingGoal?.starred ?? false,
      archived: goal.archived ?? existingGoal?.archived ?? false,
      customGradient: existingGoal?.customGradient,
      buckets: goal.buckets.map((bucket) => {
        const existingBucket = existingGoal?.buckets.find((item) => item.id === bucket.id)
        return {
          id: bucket.id,
          name: bucket.name,
          favorite: bucket.favorite,
          archived: bucket.archived ?? existingBucket?.archived ?? false,
          surfaceStyle: bucket.surfaceStyle,
          tasks: bucket.tasks.map((task) => {
            const existingTask = existingBucket?.tasks.find((item) => item.id === task.id)
            const normalizedSubtasks = Array.isArray(task.subtasks)
              ? task.subtasks.map((subtask) => {
                  const fallbackSort =
                    existingTask?.subtasks?.find((item) => item.id === subtask.id)?.sortIndex ??
                    SUBTASK_SORT_STEP
                  const sortIndex =
                    typeof subtask.sortIndex === 'number' ? subtask.sortIndex : fallbackSort
                  return {
                    id: subtask.id,
                    text: subtask.text,
                    completed: subtask.completed,
                    sortIndex,
                  }
                })
              : []
            return {
              id: task.id,
              text: task.text,
              completed: task.completed,
              difficulty: task.difficulty,
              priority: task.priority ?? existingTask?.priority ?? false,
              notes: typeof task.notes === 'string' ? task.notes : existingTask?.notes ?? '',
              subtasks:
                normalizedSubtasks.length > 0
                  ? normalizedSubtasks
                  : existingTask?.subtasks
                    ? existingTask.subtasks.map((item) => ({
                        ...item,
                        sortIndex:
                          typeof item.sortIndex === 'number' ? item.sortIndex : SUBTASK_SORT_STEP,
                      }))
                    : [],
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
  grove: 'goal-card--grove',
  lagoon: 'goal-card--lagoon',
  ember: 'goal-card--ember',
}

const BUCKET_SURFACE_CLASS_MAP: Record<BucketSurfaceStyle, string> = {
  glass: 'goal-bucket-item--surface-glass',
  midnight: 'goal-bucket-item--surface-midnight',
  slate: 'goal-bucket-item--surface-slate',
  charcoal: 'goal-bucket-item--surface-charcoal',
  linen: 'goal-bucket-item--surface-linen',
  frost: 'goal-bucket-item--surface-frost',
  grove: 'goal-bucket-item--surface-grove',
  lagoon: 'goal-bucket-item--surface-lagoon',
  ember: 'goal-bucket-item--surface-ember',
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
  {
    id: 'grove',
    label: 'Grove',
    description: 'Lush greens with a soft forest glow.',
  },
  {
    id: 'lagoon',
    label: 'Lagoon',
    description: 'Crystal blues with a calming tide.',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Vibrant amber with a warm spark.',
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
  { id: 'grove', label: 'Grove', description: 'Fresh green lift with botanical energy.' },
  { id: 'lagoon', label: 'Lagoon', description: 'Crystal blue blend for clean focus.' },
  { id: 'ember', label: 'Ember', description: 'Radiant amber spark with soft glow.' },
]

const formatGradientLabel = (value: string) =>
  value
    .replace(/^from-/, '')
    .replace(' to-', ' → ')
    .replace(/-/g, ' ')

const LIFE_ROUTINE_THEME_OPTIONS: BucketSurfaceStyle[] = ['midnight', 'charcoal', 'ember', 'grove', 'linen', 'glass']

const getSurfaceLabel = (surface: BucketSurfaceStyle): string =>
  BUCKET_SURFACE_PRESETS.find((preset) => preset.id === surface)?.label ?? surface

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

interface LifeRoutineCustomizerProps {
  routine: LifeRoutineConfig
  onUpdate: (surface: BucketSurfaceStyle) => void
  onClose: () => void
}

const LifeRoutineCustomizer = React.forwardRef<HTMLDivElement, LifeRoutineCustomizerProps>(
  ({ routine, onUpdate, onClose }, ref) => {
    const surfaceStyle = normalizeBucketSurfaceStyle(routine.surfaceStyle)

    return (
      <div
        ref={ref}
        className="goal-customizer goal-customizer--life-routine"
        role="region"
        aria-label={`Customise routine ${routine.title}`}
      >
        <div className="goal-customizer__header">
          <div>
            <p className="goal-customizer__title">Theme colour</p>
            <p className="goal-customizer__subtitle">Pick a hue to match this routine.</p>
          </div>
          <button
            type="button"
            className="goal-customizer__close"
            onClick={onClose}
            aria-label="Close routine customiser"
            data-auto-focus="true"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="goal-customizer__section">
          <p className="goal-customizer__label">Colour choices</p>
          <div className="goal-customizer__swatches">
            {LIFE_ROUTINE_THEME_OPTIONS.map((option) => {
              const isActive = surfaceStyle === option
              return (
                <button
                  key={option}
                  type="button"
                  className={classNames('goal-customizer__swatch', isActive && 'goal-customizer__swatch--active')}
                  onClick={() => onUpdate(option)}
                  aria-label={`Select ${getSurfaceLabel(option)} theme colour`}
                  aria-pressed={isActive}
                >
                  <span
                    aria-hidden="true"
                    className={classNames(
                      'goal-customizer__swatch-fill',
                      'goal-customizer__surface-preview',
                      `goal-customizer__surface-preview--${option}`,
                    )}
                  />
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

LifeRoutineCustomizer.displayName = 'LifeRoutineCustomizer'

// --- Milestones ---
type Milestone = {
  id: string
  name: string
  date: string // ISO string (midnight local)
  completed: boolean
  role: 'start' | 'end' | 'normal'
}

const MILESTONE_VIS_KEY = 'nc-taskwatch-milestones-visible-v1'
const MILESTONE_DATA_KEY = 'nc-taskwatch-milestones-state-v1'

const readMilestoneVisibility = (): Record<string, boolean> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(MILESTONE_VIS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}
const writeMilestoneVisibility = (map: Record<string, boolean>) => {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(MILESTONE_VIS_KEY, JSON.stringify(map)) } catch {}
}

const readMilestonesFor = (goalId: string): Milestone[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(MILESTONE_DATA_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, Milestone[]>) : {}
    const list = Array.isArray(map[goalId]) ? map[goalId] : []
    return list
  } catch {
    return []
  }
}
const writeMilestonesFor = (goalId: string, list: Milestone[]) => {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(MILESTONE_DATA_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, Milestone[]>) : {}
    map[goalId] = list
    window.localStorage.setItem(MILESTONE_DATA_KEY, JSON.stringify(map))
  } catch {}
}

const toStartOfDayIso = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.toISOString()
}

const formatShort = (dateIso: string) => {
  try {
    const d = new Date(dateIso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return dateIso.slice(0, 10) }
}

const uid = () => (typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `ms-${Date.now()}-${Math.random().toString(36).slice(2,8)}`)

const ensureDefaultMilestones = (goal: Goal, current: Milestone[]): Milestone[] => {
  if (current && current.length > 0) return current
  const startIso = goal.createdAt ? toStartOfDayIso(new Date(goal.createdAt)) : toStartOfDayIso(new Date())
  const m1 = new Date(startIso)
  m1.setDate(m1.getDate() + 7)
  const m1Iso = toStartOfDayIso(m1)
  return [
    { id: uid(), name: 'Goal Created', date: startIso, completed: true, role: 'start' },
    { id: uid(), name: 'Milestone 1', date: m1Iso, completed: false, role: 'normal' },
  ]
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))

const MilestoneLayer: React.FC<{
  goal: Goal
}> = ({ goal }) => {
  const [milestones, setMilestones] = useState<Milestone[]>(() => ensureDefaultMilestones(goal, readMilestonesFor(goal.id)))
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [editing, setEditing] = useState<null | { id: string; field: 'name' | 'date' }>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)
  // Track current milestones live for robust dragging math during reorders
  const milestonesRef = useRef<Milestone[]>([])
  useEffect(() => { milestonesRef.current = milestones }, [milestones])
  const draggingIdRef = useRef<string | null>(null)
  const suppressClickIdRef = useRef<string | null>(null)
  const captureElRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    writeMilestonesFor(goal.id, milestones)
  }, [goal.id, milestones])

  // Load from Supabase on mount/goal change and seed defaults if empty.
  // Also reconcile the Start milestone date to the goal's created_at date.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await apiFetchGoalMilestones(goal.id)
        if (cancelled) return
        const createdAtRaw = (await apiFetchGoalCreatedAt(goal.id)) ?? goal.createdAt ?? null
        const startIso = createdAtRaw ? toStartOfDayIso(new Date(createdAtRaw)) : toStartOfDayIso(new Date())
        if (rows && rows.length > 0) {
          // Ensure there is a start milestone with the correct date
          let hasStart = false
          const reconciled = rows.map((r) => {
            if (r.role === 'start') {
              hasStart = true
              const fixed = { ...r, date: startIso, completed: true, name: 'Goal Created' }
              // Persist correction if needed
              if (r.date !== startIso || !r.completed || r.name !== 'Goal Created') {
                apiUpsertGoalMilestone(goal.id, fixed).catch((err) =>
                  console.warn('[Milestones] Failed to persist start correction', err),
                )
              }
              return fixed
            }
            return r
          })
          if (!hasStart) {
            const start: Milestone = { id: uid(), name: 'Goal Created', date: startIso, completed: true, role: 'start' }
            reconciled.unshift(start)
            apiUpsertGoalMilestone(goal.id, start).catch((err) =>
              console.warn('[Milestones] Failed to seed missing start', err),
            )
          }
          // Ensure at least one non-start milestone exists
          const hasNonStart = reconciled.some((r) => r.role !== 'start')
          if (!hasNonStart) {
            const d = new Date(startIso)
            d.setDate(d.getDate() + 7)
            const extra: Milestone = { id: uid(), name: 'Milestone 1', date: toStartOfDayIso(d), completed: false, role: 'normal' }
            reconciled.push(extra)
            apiUpsertGoalMilestone(goal.id, extra).catch((err) =>
              console.warn('[Milestones] Failed to seed missing milestone', err),
            )
          }
          setMilestones(
            reconciled.map((r) => ({ id: r.id, name: r.name, date: r.date, completed: r.completed, role: r.role })) as Milestone[],
          )
          return
        }
        const seeded = ensureDefaultMilestones(goal, [])
        setMilestones(seeded)
        // Persist defaults so other devices see them
        for (const m of seeded) {
          try {
            await apiUpsertGoalMilestone(goal.id, m)
          } catch (err) {
            console.warn('[Milestones] Failed to seed default milestone', m, err)
          }
        }
      } catch (error) {
        console.warn('[Milestones] Failed to load milestones from Supabase', error)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [goal.id, goal.createdAt])

  useEffect(() => {
    // If this goal has no milestones saved (newly toggled), ensure defaults that use createdAt
    setMilestones((cur) => (cur && cur.length > 0 ? cur : ensureDefaultMilestones(goal, cur)))
  }, [goal.id, goal.createdAt])

  const addMilestone = () => {
    const baseName = 'Milestone'
    const count = milestonesRef.current.filter((m) => m.role !== 'start').length
      // subtract start to name nicely starting from 1
      ;
    const nextIndex = count + 1
    const nowIso = toStartOfDayIso(new Date())
    const created: Milestone = { id: uid(), name: `${baseName} ${nextIndex}`, date: nowIso, completed: false, role: 'normal' }
    setMilestones((cur) => {
      const arr = [...cur, created]
      return arr
    })
    apiUpsertGoalMilestone(goal.id, created).catch((err) => console.warn('[Milestones] Failed to persist add', err))
  }

  const toggleComplete = (id: string) => {
    const found = milestonesRef.current.find((m) => m.id === id)
    if (found?.role === 'start') return
    setMilestones((cur) => cur.map((m) => (m.id === id ? { ...m, completed: !m.completed } : m)))
    if (found) {
      const updated = { ...found, completed: !found.completed }
      apiUpsertGoalMilestone(goal.id, updated).catch((err) => console.warn('[Milestones] Failed to persist toggle', err))
    }
  }

  const updateName = (id: string, name: string) => {
    const found = milestonesRef.current.find((m) => m.id === id)
    if (found?.role === 'start') return
    setMilestones((cur) => cur.map((m) => (m.id === id ? { ...m, name } : m)))
    if (found) {
      const updated = { ...found, name }
      apiUpsertGoalMilestone(goal.id, updated).catch((err) => console.warn('[Milestones] Failed to persist name', err))
    }
  }

  const updateDate = (id: string, iso: string) => {
    const found = milestonesRef.current.find((m) => m.id === id)
    if (found?.role === 'start') return
    const nonStartNow = milestonesRef.current.filter((m) => m.role !== 'start')
    const isOnlyNonStart = nonStartNow.length === 1 && nonStartNow[0]?.id === id
    if (isOnlyNonStart) return
    setMilestones((cur) => cur.map((m) => (m.id === id ? { ...m, date: iso } : m)))
    if (found) {
      const updated = { ...found, date: iso }
      apiUpsertGoalMilestone(goal.id, updated).catch((err) => console.warn('[Milestones] Failed to persist date', err))
    }
  }

  const removeMilestone = (id: string) => {
    const nonStartNow = milestonesRef.current.filter((m) => m.role !== 'start')
    const isOnlyNonStart = nonStartNow.length === 1 && nonStartNow[0]?.id === id
    if (isOnlyNonStart) {
      // Disallow deleting the last non-start milestone
      return
    }
    setMilestones((cur) => cur.filter((m) => m.id !== id))
    apiDeleteGoalMilestone(goal.id, id).catch((err) => console.warn('[Milestones] Failed to delete', err))
  }

  // Focus the ephemeral editor when entering edit mode
  useEffect(() => {
    if (!editing) return
    const t = setTimeout(() => {
      try { editInputRef.current?.focus() } catch {}
    }, 0)
    return () => clearTimeout(t)
  }, [editing])

  // Simple double-tap (mobile) + double-click (desktop) helper
  const lastTapRef = useRef<number>(0)
  const handleMaybeDoubleTap = (cb: () => void) => () => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      cb()
    }
    lastTapRef.current = now
  }

  const sorted = useMemo(() => {
    return [...milestones].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  }, [milestones])

  const startIsoForRange = useMemo(() => {
    const start = milestones.find((m) => m.role === 'start')
    if (start) return start.date
    return goal.createdAt ? toStartOfDayIso(new Date(goal.createdAt)) : toStartOfDayIso(new Date())
  }, [milestones, goal.createdAt])

  const minMs = useMemo(() => new Date(startIsoForRange).getTime(), [startIsoForRange])
  const maxMs = useMemo(() => new Date(sorted[sorted.length - 1]?.date ?? toStartOfDayIso(new Date())).getTime(), [sorted])
  const rangeMs = Math.max(1, maxMs - minMs)

  const posPct = (iso: string) => {
    const ms = new Date(iso).getTime()
    return clamp(((ms - minMs) / rangeMs) * 100, 0, 100)
  }

  const latestId = sorted[sorted.length - 1]?.id

  // Determine if exactly one non-start milestone exists
  const nonStartIds = useMemo(() => milestones.filter((m) => m.role !== 'start').map((m) => m.id), [milestones])
  const onlyNonStartId = useMemo(() => (nonStartIds.length === 1 ? nonStartIds[0] : null), [nonStartIds])

  const beginDrag = (id: string, e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // Prevent dragging the Start node to keep it aligned with goal.createdAt
    const dragged = milestonesRef.current.find((m) => m.id === id)
    // Also prevent dragging if this is the only non-start milestone remaining
    const nonStartNow = milestonesRef.current.filter((m) => m.role !== 'start')
    const isOnlyNonStart = nonStartNow.length === 1 && nonStartNow[0]?.id === id
    if (dragged?.role === 'start' || isOnlyNonStart) {
      return
    }
    draggingIdRef.current = id
    captureElRef.current = e.currentTarget as HTMLElement
    ;(captureElRef.current as any)?.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!trackRef.current || !draggingIdRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const x = clamp(ev.clientX - rect.left, 0, rect.width)
      const pct = rect.width > 0 ? x / rect.width : 0
      const list = milestonesRef.current
      if (!list || list.length === 0) return
      const sortedNow = [...list].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      const startNow = list.find((m) => m.role === 'start')
      const minNow = startNow ? new Date(startNow.date).getTime() : new Date(sortedNow[0].date).getTime()
      const maxNow = new Date(sortedNow[sortedNow.length - 1].date).getTime()
      const rangeNow = Math.max(1, maxNow - minNow)
      const dragged = list.find((m) => m.id === draggingIdRef.current)
      if (!dragged) return
      const day = 24 * 60 * 60 * 1000
      // Lock left boundary to the Start node's date
      const leftAnchor = minNow
      // Allow extending to the right beyond current max by at least one day
      const totalRange = Math.max(rangeNow, day)
      let ms = leftAnchor + pct * totalRange
      // Snap to day
      const d = new Date(ms)
      d.setHours(0, 0, 0, 0)
      const iso = d.toISOString()
      suppressClickIdRef.current = draggingIdRef.current
      setMilestones((cur) => cur.map((m) => (m.id === draggingIdRef.current ? { ...m, date: iso } : m)))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try { (captureElRef.current as any)?.releasePointerCapture?.((e as any).pointerId) } catch {}
      // Persist the final position of the dragged milestone
      const idNow = suppressClickIdRef.current
      if (idNow) {
        const found = milestonesRef.current.find((m) => m.id === idNow)
        if (found) {
          apiUpsertGoalMilestone(goal.id, found).catch((err) => console.warn('[Milestones] Failed to persist drag', err))
        }
      }
      draggingIdRef.current = null
      captureElRef.current = null
      // Clear suppressed click on next tick to swallow the click immediately following drag
      setTimeout(() => { if (suppressClickIdRef.current === idNow) suppressClickIdRef.current = null }, 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      <div className="milestones__header">
        <h4 className="goal-subheading">Milestone Layer</h4>
        <button className="milestones__add" type="button" onClick={addMilestone}>+ Add Milestone</button>
      </div>
      <div className="milestones" aria-label="Milestone timeline">
        <div className="milestones__track" ref={trackRef}>
        <div className="milestones__line" />
          {sorted.map((m, idx) => {
          const pct = posPct(m.date)
          const isStart = m.role === 'start'
          const isLatest = m.id === latestId
          const isOnlyNonStart = !isStart && onlyNonStartId === m.id
          const isTop = idx % 2 === 0
          return (
            <div key={m.id} className="milestones__node-wrap" style={{ left: `${pct}%` }}>
              <button
                type="button"
                className={classNames('milestones__node', m.completed && 'milestones__node--done', isStart && 'milestones__node--start', isLatest && 'milestones__node--end')}
                onClick={(ev) => {
                  if (suppressClickIdRef.current === m.id) { ev.preventDefault(); ev.stopPropagation(); suppressClickIdRef.current = null; return }
                  if (isStart) { ev.preventDefault(); ev.stopPropagation(); return }
                  toggleComplete(m.id)
                }}
                onPointerDown={(ev) => { if (!isStart && !isOnlyNonStart) beginDrag(m.id, ev) }}
                aria-label={`${m.name} ${formatShort(m.date)}${m.completed ? ' (completed)' : ''}`}
              />
                <span
                  className={classNames('milestones__stem', isTop ? 'milestones__stem--up' : 'milestones__stem--down')}
                  onPointerDown={(ev) => { if (!isStart && !isOnlyNonStart) beginDrag(m.id, ev) }}
                  aria-hidden={true}
                />
                <div className={classNames('milestones__label', isTop ? 'milestones__label--top' : 'milestones__label--bottom')}>
                  {!isStart && editing?.id === m.id && editing.field === 'name' ? (
                    <input
                      ref={editInputRef}
                      className="milestones__name"
                      defaultValue={m.name}
                      onBlur={(ev) => { updateName(m.id, ev.target.value); setEditing(null) }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') { updateName(m.id, (ev.target as HTMLInputElement).value); setEditing(null) }
                        if (ev.key === 'Escape') { setEditing(null) }
                      }}
                      aria-label="Edit milestone name"
                    />
                  ) : (
                    <div
                      className={classNames('milestones__name', 'milestones__name--text', isStart && 'milestones__text--locked')}
                      onDoubleClick={!isStart ? ((ev) => { ev.stopPropagation(); setEditing({ id: m.id, field: 'name' }) }) : undefined}
                      onClick={!isStart ? ((ev) => { if ((ev as React.MouseEvent).detail >= 2) { ev.stopPropagation(); setEditing({ id: m.id, field: 'name' }) } }) : undefined}
                      onPointerDown={!isStart ? handleMaybeDoubleTap(() => setEditing({ id: m.id, field: 'name' })) : undefined}
                      role={!isStart ? 'button' : undefined}
                      tabIndex={!isStart ? 0 : -1}
                      onKeyDown={!isStart ? ((ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); setEditing({ id: m.id, field: 'name' }) } }) : undefined}
                      aria-label={isStart ? `Milestone name ${m.name}.` : `Milestone name ${m.name}. Double tap to edit.`}
                    >
                      {m.name}
                    </div>
                  )}

                  {!isStart && !(onlyNonStartId === m.id) && editing?.id === m.id && editing.field === 'date' ? (
                    <input
                      ref={editInputRef}
                      className="milestones__date"
                      type="date"
                      defaultValue={new Date(m.date).toISOString().slice(0,10)}
                      onBlur={(ev) => { const d = new Date(ev.target.value); updateDate(m.id, toStartOfDayIso(d)); setEditing(null) }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') { const d = new Date((ev.target as HTMLInputElement).value); updateDate(m.id, toStartOfDayIso(d)); setEditing(null) }
                        if (ev.key === 'Escape') { setEditing(null) }
                      }}
                      aria-label="Edit milestone date"
                    />
                  ) : (
                    <div
                      className={classNames('milestones__date', 'milestones__date--text', (isStart || onlyNonStartId === m.id) && 'milestones__text--locked')}
                      onDoubleClick={!isStart && !(onlyNonStartId === m.id) ? ((ev) => { ev.stopPropagation(); setEditing({ id: m.id, field: 'date' }) }) : undefined}
                      onClick={!isStart && !(onlyNonStartId === m.id) ? ((ev) => { if ((ev as React.MouseEvent).detail >= 2) { ev.stopPropagation(); setEditing({ id: m.id, field: 'date' }) } }) : undefined}
                      onPointerDown={!isStart && !(onlyNonStartId === m.id) ? handleMaybeDoubleTap(() => setEditing({ id: m.id, field: 'date' })) : undefined}
                      role={!isStart && !(onlyNonStartId === m.id) ? 'button' : undefined}
                      tabIndex={!isStart && !(onlyNonStartId === m.id) ? 0 : -1}
                      onKeyDown={!isStart && !(onlyNonStartId === m.id) ? ((ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); setEditing({ id: m.id, field: 'date' }) } }) : undefined}
                      aria-label={isStart || onlyNonStartId === m.id ? `Milestone date ${formatShort(m.date)}.` : `Milestone date ${formatShort(m.date)}. Double tap to edit.`}
                    >
                      {formatShort(m.date)}
                    </div>
                  )}
                  {m.role !== 'start' && onlyNonStartId !== m.id ? (
                    <button className="milestones__remove" type="button" onClick={() => removeMilestone(m.id)} aria-label="Remove milestone">×</button>
                  ) : null}
                </div>
            </div>
          )
        })}
        </div>
      </div>
    </>
  )
}

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
  onArchiveBucket: (bucketId: string) => void
  archivedBucketCount: number
  onManageArchivedBuckets: () => void
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
  handleAddSubtask: (taskId: string, options?: { focus?: boolean }) => void
  handleSubtaskTextChange: (taskId: string, subtaskId: string, value: string) => void
  handleSubtaskBlur: (taskId: string, subtaskId: string) => void
  handleToggleSubtaskSection: (taskId: string) => void
  handleToggleSubtaskCompleted: (taskId: string, subtaskId: string) => void
  handleRemoveSubtask: (taskId: string, subtaskId: string) => void
  onCollapseTaskDetailsForDrag: (taskId: string) => void
  onRestoreTaskDetailsAfterDrag: (taskId: string) => void
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
  revealedDeleteTaskKey: string | null
  onRevealDeleteTask: (key: string | null) => void
  onDeleteCompletedTask: (goalId: string, bucketId: string, taskId: string) => void
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
  onReorderBuckets: (bucketId: string, toIndex: number) => void
  onOpenCustomizer: (goalId: string) => void
  activeCustomizerGoalId: string | null
  isStarred: boolean
  onToggleStarred: () => void
  isArchived: boolean
  onArchiveGoal: () => void
  onRestoreGoal: () => void
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
  onArchiveBucket,
  archivedBucketCount,
  onManageArchivedBuckets,
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
  handleSubtaskBlur,
  handleToggleSubtaskSection,
  handleToggleSubtaskCompleted,
  handleRemoveSubtask,
  onCollapseTaskDetailsForDrag,
  onRestoreTaskDetailsAfterDrag,
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
  revealedDeleteTaskKey,
  onRevealDeleteTask,
  onDeleteCompletedTask,
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
  isArchived,
  onArchiveGoal,
  onRestoreGoal,
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
  const activeBuckets = useMemo(() => goal.buckets.filter((bucket) => !bucket.archived), [goal.buckets])
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

  const totalTasks = activeBuckets.reduce((acc, bucket) => acc + bucket.tasks.length, 0)
  const completedTasksCount = activeBuckets.reduce(
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
  const [milestonesVisible, setMilestonesVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      const map = readMilestoneVisibility()
      return Boolean(map[goal.id])
    } catch { return false }
  })
  useEffect(() => {
    const map = readMilestoneVisibility()
    const curr = Boolean(map[goal.id])
    if (curr !== milestonesVisible) {
      map[goal.id] = milestonesVisible
      writeMilestoneVisibility(map)
    }
  }, [goal.id, milestonesVisible])

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
                  setMilestonesVisible((v) => !v)
                }}
              >
                {milestonesVisible ? 'Remove Milestones Layer' : 'Add Milestones Layer'}
              </button>
              <div className="goal-menu__divider" />
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
              <button
                type="button"
                className="goal-menu__item"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  if (isArchived) {
                    onRestoreGoal()
                  } else {
                    onArchiveGoal()
                  }
                }}
              >
                {isArchived ? 'Restore goal' : 'Archive goal'}
              </button>
              <button
                type="button"
                className="goal-menu__item"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onManageArchivedBuckets()
                }}
              >
                Manage archived buckets{archivedBucketCount > 0 ? ` (${archivedBucketCount})` : ''}
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
    return activeBuckets.find((bucket) => bucket.id === bucketMenuOpenId) ?? null
  }, [activeBuckets, bucketMenuOpenId])

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
                className="goal-menu__item"
                onClick={(event) => {
                  event.stopPropagation()
                  setBucketMenuOpenId(null)
                  onArchiveBucket(activeBucketForMenu.id)
                }}
              >
                Archive bucket
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
        draggable={!isArchived}
        onDragStart={(e) => {
          if (isArchived) {
            e.preventDefault()
            return
          }
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
          if (isArchived) {
            return
          }
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
                {isArchived ? <span className="goal-status-pill flex-none">Archived</span> : null}
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
          {milestonesVisible && !isArchived ? (
            <div className="mt-3 md:mt-4">
              <MilestoneLayer goal={goal} />
            </div>
          ) : null}
          <div className="mt-3 md:mt-4">
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h4 className="goal-subheading">Task Bank</h4>
              {!isArchived ? (
                <button
                  onClick={() => onStartBucketDraft(goal.id)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 whitespace-nowrap"
                >
                  + Add Bucket
                </button>
              ) : null}
            </div>

            {isArchived ? null : null}

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
                const toIndex = bucketHoverIndex ?? activeBuckets.length
                if (fromIndex !== toIndex) {
                  onReorderBuckets(info.bucketId, toIndex)
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
              {activeBuckets.map((b, index) => {
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
                        const openIds = activeBuckets.filter((bx) => bucketExpanded[bx.id]).map((bx) => bx.id)
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
                              const subtaskListId = `goal-task-subtasks-${task.id}`
                              const isSubtasksCollapsed = showDetails ? Boolean(details?.subtasksCollapsed) : false
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
                                    onRevealDeleteTask(null)
                                    onCollapseTaskDetailsForDrag(task.id)
                                    e.dataTransfer.setData('text/plain', task.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                    const row = e.currentTarget as HTMLElement
                                    row.classList.add('dragging')
                                    // Clone current row as drag image, keep it in DOM until drag ends
                                    const clone = row.cloneNode(true) as HTMLElement
                                    // Preserve task modifiers so difficulty/priority visuals stay intact
                                    clone.className = `${row.className} goal-drag-clone`
                                    clone.classList.remove('dragging', 'goal-task-row--collapsed', 'goal-task-row--expanded')
                                    // Match row width to avoid layout surprises in the ghost
                                    const rowRect = row.getBoundingClientRect()
                                    clone.style.width = `${Math.floor(rowRect.width)}px`
                                    clone.style.minHeight = `${Math.max(1, Math.round(rowRect.height))}px`
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
                                    clone.querySelectorAll('.goal-task-details').forEach((node) => node.parentNode?.removeChild(node))
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
    onRestoreTaskDetailsAfterDrag(task.id)
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
                                  <div className="goal-task-row__content">
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
                                          ? 'Hide subtasks and notes'
                                          : hasDetailsContent
                                          ? 'Show subtasks and notes'
                                          : 'Add subtasks or notes'
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
                                      onRevealDeleteTask(null)
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
                                      <div
                                        className={classNames(
                                          'goal-task-details__subtasks',
                                          isSubtasksCollapsed && 'goal-task-details__subtasks--collapsed',
                                        )}
                                      >
                                        <div className="goal-task-details__section-title">
                                          <p className="goal-task-details__heading">
                                            Subtasks
                                            <button
                                              type="button"
                                              className="goal-task-details__collapse"
                                              aria-expanded={!isSubtasksCollapsed}
                                              aria-controls={subtaskListId}
                                              onClick={(event) => {
                                                event.stopPropagation()
                                                handleToggleSubtaskSection(task.id)
                                              }}
                                              onPointerDown={(event) => event.stopPropagation()}
                                              aria-label={isSubtasksCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
                                            />
                                          </p>
                                          {subtaskProgressLabel ? (
                                            <span
                                              className="goal-task-details__progress"
                                              aria-label={`Subtasks complete ${completedSubtasks} of ${subtasks.length}`}
                                            >
                                              {subtaskProgressLabel}
                                            </span>
                                          ) : null}
                                          <button
                                            type="button"
                                            className="goal-task-details__add"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              handleAddSubtask(task.id, { focus: true })
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            + Subtask
                                          </button>
                                        </div>
                                        <div className="goal-task-details__subtasks-body" id={subtaskListId}>
                                          {hasSubtasks ? (
                                            <ul className="goal-task-details__subtask-list">
                                              {subtasks.map((subtask) => (
                                                <li
                                                  key={subtask.id}
                                                  className={classNames(
                                                    'goal-task-details__subtask',
                                                    subtask.completed && 'goal-task-details__subtask--completed',
                                                  )}
                                                >
                                                  <label className="goal-task-details__subtask-item">
                                                    <div className="goal-subtask-field">
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
                                                      <textarea
                                                      id={makeGoalSubtaskInputId(task.id, subtask.id)}
                                                      className="goal-task-details__subtask-input"
                                                      rows={1}
                                                        ref={(el) => autosizeTextArea(el)}
                                                      value={subtask.text}
                                                      onChange={(event) => {
                                                        const el = event.currentTarget
                                                        // auto-resize height
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                        handleSubtaskTextChange(task.id, subtask.id, event.target.value)
                                                      }}
                                                      onInput={(event) => {
                                                        const el = event.currentTarget
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                      }}
                                                      onKeyDown={(event) => {
                                                        // Enter commits a new subtask; Shift+Enter inserts newline
                                                        if (event.key === 'Enter' && !event.shiftKey) {
                                                          event.preventDefault()
                                                          const value = event.currentTarget.value.trim()
                                                          if (value.length === 0) {
                                                            return
                                                          }
                                                          handleAddSubtask(task.id, { focus: true })
                                                        }
                                                         // Escape on empty behaves like clicking off (remove empty)
                                                         if (event.key === 'Escape') {
                                                           const value = event.currentTarget.value
                                                           if (value.trim().length === 0) {
                                                             event.preventDefault()
                                                             // trigger blur to run empty-removal logic
                                                             event.currentTarget.blur()
                                                           }
                                                         }
                                                      }}
                                                      onFocus={(event) => {
                                                        const el = event.currentTarget
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                      }}
                                                      onBlur={() => handleSubtaskBlur(task.id, subtask.id)}
                                                      onPointerDown={(event) => event.stopPropagation()}
                                                      placeholder="Describe subtask"
                                                      />
                                                    </div>
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
                                            <div className="goal-task-details__empty">
                                              <p className="goal-task-details__empty-text">No subtasks yet</p>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      <div className="goal-task-details__notes">
                                        <div className="goal-task-details__section-title goal-task-details__section-title--notes">
                                          <p className="goal-task-details__heading">Notes</p>
                                        </div>
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
                                </div>
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
                                          broadcastScheduleTask({
                                            goalId: goal.id,
                                            goalName: goal.name,
                                            bucketId: b.id,
                                            bucketName: b.name,
                                            taskId: task.id,
                                            taskName: task.text,
                                          })
                                          onDismissFocusPrompt()
                                        }}
                                      >
                                        Schedule Task
                                      </button>
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
                                  const subtaskListId = `goal-task-subtasks-${task.id}`
                                  const isSubtasksCollapsed = showDetails ? Boolean(details?.subtasksCollapsed) : false
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
                                  const deleteKey = focusPromptKey
                                  const isDeleteRevealed = revealedDeleteTaskKey === deleteKey
                                  
                                  return (
                                    <React.Fragment key={`${task.id}-cwrap`}>
                                      {/* placeholder suppressed; line is rendered absolutely */}
                                      <li
                                        ref={(el) => registerTaskRowRef(task.id, el)}
                                        key={task.id}
                                        data-focus-prompt-key={focusPromptKey}
                                        data-delete-key={deleteKey}
                                        className={classNames(
                                          'goal-task-row goal-task-row--completed',
                                          diffClass,
                                          task.priority && 'goal-task-row--priority',
                                          isEditing && 'goal-task-row--draft',
                                          isFocusPromptActive && 'goal-task-row--focus-prompt',
                                          showDetails && isDetailsOpen && 'goal-task-row--expanded',
                                          showDetails && hasDetailsContent && 'goal-task-row--has-details',
                                          isDeleteRevealed && 'goal-task-row--delete-revealed',
                                        )}
                                        draggable
                                        onContextMenu={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          onRevealDeleteTask(isDeleteRevealed ? null : deleteKey)
                                        }}
                                        onDragStart={(e) => {
                                          onRevealDeleteTask(null)
                                          onCollapseTaskDetailsForDrag(task.id)
                                          e.dataTransfer.setData('text/plain', task.id)
                                          e.dataTransfer.effectAllowed = 'move'
                                          const row = e.currentTarget as HTMLElement
                                          row.classList.add('dragging')
                                          const clone = row.cloneNode(true) as HTMLElement
                                          clone.className = `${row.className} goal-drag-clone`
                                          clone.classList.remove('dragging', 'goal-task-row--collapsed', 'goal-task-row--expanded')
                                          const rowRect = row.getBoundingClientRect()
                                          clone.style.width = `${Math.floor(rowRect.width)}px`
                                          clone.style.minHeight = `${Math.max(1, Math.round(rowRect.height))}px`
                                          copyVisualStyles(row, clone)
                                          // Force single-line text in clone even if original contains line breaks
                                          const textNodes = clone.querySelectorAll('.goal-task-text, .goal-task-input, .goal-task-text--button')
                                          textNodes.forEach((node) => {
                                            const el = node as HTMLElement
                                            el.querySelectorAll('br').forEach((br) => br.parentNode?.removeChild(br))
                                            const oneLine = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
                                            el.textContent = oneLine
                                          })
                                          clone.querySelectorAll('.goal-task-details').forEach((node) => node.parentNode?.removeChild(node))
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
    onRestoreTaskDetailsAfterDrag(task.id)
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
                                      <div className="goal-task-row__content">
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
                                              ? 'Hide subtasks and notes'
                                              : hasDetailsContent
                                              ? 'Show subtasks and notes'
                                              : 'Add subtasks or notes'
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
                                    onClick={() => {
                                      onRevealDeleteTask(null)
                                      onToggleTaskComplete(b.id, task.id)
                                    }}
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
                                      <div
                                        className={classNames(
                                          'goal-task-details__subtasks',
                                          isSubtasksCollapsed && 'goal-task-details__subtasks--collapsed',
                                        )}
                                      >
                                        <div className="goal-task-details__section-title">
                                          <button
                                            type="button"
                                            className="goal-task-details__collapse"
                                            aria-expanded={!isSubtasksCollapsed}
                                            aria-controls={subtaskListId}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              handleToggleSubtaskSection(task.id)
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            <span className="sr-only">
                                              {isSubtasksCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
                                            </span>
                                            <svg
                                              className="goal-task-details__collapse-icon"
                                              viewBox="0 0 24 24"
                                              aria-hidden="true"
                                            >
                                              <path
                                                d="M6 10l6 6 6-6"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.8"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                              />
                                            </svg>
                                          </button>
                                          <p className="goal-task-details__heading">Subtasks</p>
                                          {subtaskProgressLabel ? (
                                            <span
                                              className="goal-task-details__progress"
                                              aria-label={`Subtasks complete ${completedSubtasks} of ${subtasks.length}`}
                                            >
                                              {subtaskProgressLabel}
                                            </span>
                                          ) : null}
                                          <button
                                            type="button"
                                            className="goal-task-details__add"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              handleAddSubtask(task.id, { focus: true })
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            + Subtask
                                          </button>
                                        </div>
                                        <div className="goal-task-details__subtasks-body" id={subtaskListId}>
                                          {hasSubtasks ? (
                                            <ul className="goal-task-details__subtask-list">
                                              {subtasks.map((subtask) => (
                                                <li
                                                  key={subtask.id}
                                                  className={classNames(
                                                    'goal-task-details__subtask',
                                                    subtask.completed && 'goal-task-details__subtask--completed',
                                                  )}
                                                >
                                                  <label className="goal-task-details__subtask-item">
                                                    <div className="goal-subtask-field">
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
                                                      <textarea
                                                      id={makeGoalSubtaskInputId(task.id, subtask.id)}
                                                      className="goal-task-details__subtask-input"
                                                      rows={1}
                                                        ref={(el) => autosizeTextArea(el)}
                                                      value={subtask.text}
                                                      onChange={(event) => {
                                                        const el = event.currentTarget
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                        handleSubtaskTextChange(task.id, subtask.id, event.target.value)
                                                      }}
                                                      onInput={(event) => {
                                                        const el = event.currentTarget
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                      }}
                                                      onKeyDown={(event) => {
                                                        if (event.key === 'Enter' && !event.shiftKey) {
                                                          event.preventDefault()
                                                          const value = event.currentTarget.value.trim()
                                                          if (value.length === 0) {
                                                            return
                                                          }
                                                          handleAddSubtask(task.id, { focus: true })
                                                        }
                                                         if (event.key === 'Escape') {
                                                           const value = event.currentTarget.value
                                                           if (value.trim().length === 0) {
                                                             event.preventDefault()
                                                             event.currentTarget.blur()
                                                           }
                                                         }
                                                      }}
                                                      onFocus={(event) => {
                                                        const el = event.currentTarget
                                                        el.style.height = 'auto'
                                                        el.style.height = `${el.scrollHeight}px`
                                                      }}
                                                      onBlur={() => handleSubtaskBlur(task.id, subtask.id)}
                                                      onPointerDown={(event) => event.stopPropagation()}
                                                      placeholder="Describe subtask"
                                                      />
                                                    </div>
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
                                            <div className="goal-task-details__empty">
                                              <p className="goal-task-details__empty-text">No subtasks yet</p>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      <div className="goal-task-details__notes">
                                        <div className="goal-task-details__section-title goal-task-details__section-title--notes">
                                          <p className="goal-task-details__heading">Notes</p>
                                        </div>
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
                                </div>
                                <button
                                  type="button"
                                  className="goal-task-row__delete"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    onRevealDeleteTask(null)
                                    onDeleteCompletedTask(goal.id, b.id, task.id)
                                  }}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  aria-label="Delete task permanently"
                                  title="Delete task"
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true" className="goal-task-row__delete-icon">
                                    <path
                                      d="M9 4h6l1 2h4v2H4V6h4l1-2Zm1 5v9m4-9v9m-6 0h8a1 1 0 0 0 1-1V8H7v9a1 1 0 0 0 1 1Z"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.6"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </button>
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
                                              broadcastScheduleTask({
                                                goalId: goal.id,
                                                goalName: goal.name,
                                                bucketId: b.id,
                                                bucketName: b.name,
                                                taskId: task.id,
                                                taskName: task.text,
                                              })
                                              onDismissFocusPrompt()
                                            }}
                                          >
                                            Schedule Task
                                          </button>
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

  const updateGoalTask = useCallback(
    (taskId: string, transformer: (task: TaskItem) => TaskItem | null) => {
      setGoals((current) => {
        let changed = false
        const nextGoals = current.map((goal) => {
          let goalChanged = false
          const nextBuckets = goal.buckets.map((bucket) => {
            const index = bucket.tasks.findIndex((task) => task.id === taskId)
            if (index === -1) {
              return bucket
            }
            const candidate = bucket.tasks[index]
            const updated = transformer(candidate)
            if (!updated || updated === candidate) {
              return bucket
            }
            goalChanged = true
            changed = true
            const nextTasks = [...bucket.tasks]
            nextTasks[index] = updated
            return { ...bucket, tasks: nextTasks }
          })
          if (!goalChanged) {
            return goal
          }
          return { ...goal, buckets: nextBuckets }
        })
        return changed ? nextGoals : current
      })
    },
    [setGoals],
  )

  const syncGoalTaskNotes = useCallback(
    (taskId: string, notes: string) => {
      updateGoalTask(taskId, (task) => {
        const existing = typeof task.notes === 'string' ? task.notes : ''
        if (existing === notes) {
          return null
        }
        return { ...task, notes }
      })
    },
    [updateGoalTask],
  )

  const updateGoalTaskSubtasks = useCallback(
    (taskId: string, derive: (subtasks: TaskSubtask[]) => TaskSubtask[]) => {
      updateGoalTask(taskId, (task) => {
        const previous = Array.isArray(task.subtasks) ? task.subtasks : []
        const next = derive(previous)
        if (areGoalTaskSubtasksEqual(previous, next)) {
          return null
        }
        return {
          ...task,
          subtasks: cloneTaskSubtasks(next),
        }
      })
    },
    [updateGoalTask],
  )
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
  const [lifeRoutinesExpanded, setLifeRoutinesExpanded] = useState(false)
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const [lifeRoutineMenuOpenId, setLifeRoutineMenuOpenId] = useState<string | null>(null)
  const lifeRoutineMenuRef = useRef<HTMLDivElement | null>(null)
  const lifeRoutineMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [lifeRoutineMenuPosition, setLifeRoutineMenuPosition] = useState({ left: 0, top: 0 })
  const [lifeRoutineMenuPositionReady, setLifeRoutineMenuPositionReady] = useState(false)
  const [renamingLifeRoutineId, setRenamingLifeRoutineId] = useState<string | null>(null)
  const [lifeRoutineRenameDraft, setLifeRoutineRenameDraft] = useState('')
  const lifeRoutineRenameInputRef = useRef<HTMLInputElement | null>(null)

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

  const [editingLifeRoutineDescriptionId, setEditingLifeRoutineDescriptionId] = useState<string | null>(null)
  const [lifeRoutineDescriptionDraft, setLifeRoutineDescriptionDraft] = useState('')
  const lifeRoutineDescriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [lifeRoutineHoverIndex, setLifeRoutineHoverIndex] = useState<number | null>(null)
  const [lifeRoutineLineTop, setLifeRoutineLineTop] = useState<number | null>(null)
  const lifeRoutineDragCloneRef = useRef<HTMLElement | null>(null)
  const computeLifeRoutineInsertMetrics = useCallback((listEl: HTMLElement, y: number) => {
    const items = Array.from(listEl.querySelectorAll('li.life-routines-card__task')) as HTMLElement[]
    const candidates = items.filter((el) => !el.classList.contains('dragging'))
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
    let bestDist = Math.abs(y - anchors[0].y)
    for (let i = 1; i < anchors.length; i++) {
      const dist = Math.abs(y - anchors[i].y)
      if (dist < bestDist) {
        best = anchors[i]
        bestDist = dist
      }
    }

    let rawTop: number
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
  }, [])
  const [activeLifeRoutineCustomizerId, setActiveLifeRoutineCustomizerId] = useState<string | null>(null)
  const lifeRoutineCustomizerDialogRef = useRef<HTMLDivElement | null>(null)
  const activeLifeRoutine = useMemo(() => {
    if (!lifeRoutineMenuOpenId) {
      return null
    }
    return lifeRoutineTasks.find((task) => task.id === lifeRoutineMenuOpenId) ?? null
  }, [lifeRoutineMenuOpenId, lifeRoutineTasks])
  const activeLifeRoutineCustomizer = useMemo(() => {
    if (!activeLifeRoutineCustomizerId) {
      return null
    }
    return lifeRoutineTasks.find((task) => task.id === activeLifeRoutineCustomizerId) ?? null
  }, [lifeRoutineTasks, activeLifeRoutineCustomizerId])
  useEffect(() => {
    writeStoredLifeRoutines(lifeRoutineTasks)
  }, [lifeRoutineTasks])
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIFE_ROUTINE_STORAGE_KEY) {
        setLifeRoutineTasks(readStoredLifeRoutines())
      }
    }
    const handleExternalUpdate = (event: Event) => {
      if (event instanceof CustomEvent) {
        // Only update if the data is actually different to avoid infinite loops
        const newData = sanitizeLifeRoutineList(event.detail)
        setLifeRoutineTasks((current) => {
          // Compare the stringified versions to see if they're actually different
          if (JSON.stringify(current) === JSON.stringify(newData)) {
            return current
          }
          return newData
        })
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleExternalUpdate as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleExternalUpdate as EventListener)
    }
  }, [])

  const updateLifeRoutineMenuPosition = useCallback(() => {
    const anchor = lifeRoutineMenuAnchorRef.current
    const menuEl = lifeRoutineMenuRef.current
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
    setLifeRoutineMenuPosition((prev) => {
      if (Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5) {
        return prev
      }
      return { left, top }
    })
    setLifeRoutineMenuPositionReady(true)
  }, [])

  useEffect(() => {
    if (!lifeRoutineMenuOpenId) {
      setLifeRoutineMenuPositionReady(false)
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLifeRoutineMenuOpenId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    setLifeRoutineMenuPositionReady(false)
    const raf = window.requestAnimationFrame(() => {
      updateLifeRoutineMenuPosition()
    })
    const handleRelayout = () => updateLifeRoutineMenuPosition()
    window.addEventListener('resize', handleRelayout)
    window.addEventListener('scroll', handleRelayout, true)
    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleRelayout)
      window.removeEventListener('scroll', handleRelayout, true)
    }
  }, [lifeRoutineMenuOpenId, updateLifeRoutineMenuPosition])

  useEffect(() => {
    if (!lifeRoutineMenuOpenId) {
      lifeRoutineMenuAnchorRef.current = null
    }
  }, [lifeRoutineMenuOpenId])

  useEffect(() => {
    if (renamingLifeRoutineId && lifeRoutineRenameInputRef.current) {
      const el = lifeRoutineRenameInputRef.current
      const len = el.value.length
      el.focus()
      el.setSelectionRange(len, len)
    }
  }, [renamingLifeRoutineId])

  useEffect(() => {
    if (editingLifeRoutineDescriptionId && lifeRoutineDescriptionTextareaRef.current) {
      const el = lifeRoutineDescriptionTextareaRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editingLifeRoutineDescriptionId])

  useEffect(() => {
    if (activeLifeRoutineCustomizerId && !activeLifeRoutineCustomizer) {
      setActiveLifeRoutineCustomizerId(null)
    }
  }, [activeLifeRoutineCustomizerId, activeLifeRoutineCustomizer])

  useEffect(() => {
    if (!activeLifeRoutineCustomizerId) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveLifeRoutineCustomizerId(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeLifeRoutineCustomizerId])

  useEffect(() => {
    if (!activeLifeRoutineCustomizerId) {
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
  }, [activeLifeRoutineCustomizerId])

  useEffect(() => {
    if (!activeLifeRoutineCustomizerId) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const dialog = lifeRoutineCustomizerDialogRef.current
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
  }, [activeLifeRoutineCustomizerId])

  const [focusPromptTarget, setFocusPromptTarget] = useState<FocusPromptTarget | null>(null)
  const [revealedDeleteTaskKey, setRevealedDeleteTaskKey] = useState<string | null>(null)
  const [managingArchivedGoalId, setManagingArchivedGoalId] = useState<string | null>(null)
  useEffect(() => {
    if (!revealedDeleteTaskKey || typeof window === 'undefined') {
      return
    }
    if (typeof document !== 'undefined') {
      const host = document.querySelector<HTMLElement>(`[data-delete-key=\"${revealedDeleteTaskKey}\"]`)
      if (!host) {
        setRevealedDeleteTaskKey(null)
        return
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const key = target?.closest<HTMLElement>('[data-delete-key]')?.dataset.deleteKey ?? null
      if (key !== revealedDeleteTaskKey) {
        setRevealedDeleteTaskKey(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRevealedDeleteTaskKey(null)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [revealedDeleteTaskKey, goals])
  const focusPromptKeyRef = useRef<string | null>(null)
  const [isCreateGoalOpen, setIsCreateGoalOpen] = useState(false)
  const [goalNameInput, setGoalNameInput] = useState('')
  const [selectedGoalGradient, setSelectedGoalGradient] = useState(GOAL_GRADIENTS[0])
  const [customGradient, setCustomGradient] = useState({ start: '#6366f1', end: '#ec4899', angle: 135 })
  const goalModalInputRef = useRef<HTMLInputElement | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [taskDetails, setTaskDetails] = useState<TaskDetailsState>(() => readStoredTaskDetails())
  const taskDetailsRef = useRef<TaskDetailsState>(taskDetails)
  const taskDetailsDragSnapshotRef = useRef<Map<string, { expanded: boolean; subtasksCollapsed: boolean }>>(new Map())
  const draggingTaskIdRef = useRef<string | null>(null)
  const pendingGoalSubtaskFocusRef = useRef<{ taskId: string; subtaskId: string } | null>(null)
  const taskNotesSaveTimersRef = useRef<Map<string, number>>(new Map())
  const taskNotesLatestRef = useRef<Map<string, string>>(new Map())
  const requestedTaskNotesRef = useRef<Set<string>>(new Set())
  const subtaskSaveTimersRef = useRef<Map<string, number>>(new Map())
  const subtaskLatestRef = useRef<Map<string, TaskSubtask>>(new Map())
  const isMountedRef = useRef(true)
  const goalsRefreshInFlightRef = useRef(false)
  const goalsRefreshPendingRef = useRef(false)

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
    taskDetailsRef.current = taskDetails
  }, [taskDetails])
  const mergeSubtasksWithSources = useCallback(
    (taskId: string, remote: TaskSubtask[], sources: TaskSubtask[][]): TaskSubtask[] => {
      const merged = new Map<string, TaskSubtask>()

      remote.forEach((item) => {
        if (!item) {
          return
        }
        const pending = subtaskLatestRef.current.get(`${taskId}:${item.id}`)
        const base = pending ?? item
        merged.set(item.id, {
          id: base.id,
          text: base.text,
          completed: base.completed,
          sortIndex:
            typeof base.sortIndex === 'number' ? base.sortIndex : SUBTASK_SORT_STEP,
        })
      })

      sources.forEach((collection) => {
        collection.forEach((item) => {
          if (!item) {
            return
          }
          const key = `${taskId}:${item.id}`
          const pending = subtaskLatestRef.current.get(key)
          const existing = merged.get(item.id)
          if (!existing) {
            const base = pending ?? item
            merged.set(item.id, {
              id: base.id,
              text: base.text,
              completed: base.completed,
              sortIndex:
                typeof base.sortIndex === 'number' ? base.sortIndex : SUBTASK_SORT_STEP,
            })
            return
          }
          if (pending) {
            merged.set(item.id, {
              id: pending.id,
              text: pending.text,
              completed: pending.completed,
              sortIndex:
                typeof pending.sortIndex === 'number' ? pending.sortIndex : SUBTASK_SORT_STEP,
            })
          }
        })
      })

      return Array.from(merged.values()).sort((a, b) => a.sortIndex - b.sortIndex)
    },
    [subtaskLatestRef],
  )

  const mergeIncomingGoals = useCallback(
    (currentGoals: Goal[], incomingGoals: Goal[]): Goal[] =>
      incomingGoals.map((goal) => {
        const existingGoal = currentGoals.find((item) => item.id === goal.id)
        return {
          ...goal,
          customGradient: goal.customGradient ?? existingGoal?.customGradient,
          buckets: goal.buckets.map((bucket) => {
            const existingBucket = existingGoal?.buckets.find((item) => item.id === bucket.id)
            return {
              ...bucket,
              tasks: bucket.tasks.map((task) => {
                const existingTask = existingBucket?.tasks.find((item) => item.id === task.id)
                const pendingNotes = taskNotesLatestRef.current.get(task.id)
                const mergedNotes =
                  pendingNotes !== undefined
                    ? pendingNotes
                    : typeof task.notes === 'string'
                      ? task.notes
                      : existingTask?.notes ?? ''
                const remoteSubtasks = Array.isArray(task.subtasks) ? task.subtasks : []
                const mergedSubtasks = mergeSubtasksWithSources(task.id, remoteSubtasks, [
                  existingTask?.subtasks ?? [],
                  taskDetailsRef.current[task.id]?.subtasks ?? [],
                ])
                return {
                  ...task,
                  notes: mergedNotes,
                  subtasks: mergedSubtasks,
                }
              }),
            }
          }),
        }
      }),
    [mergeSubtasksWithSources, taskDetailsRef, taskNotesLatestRef],
  )

  const mergeIncomingTaskDetails = useCallback(
    (currentDetails: TaskDetailsState, incomingGoals: Goal[]): TaskDetailsState => {
      const next: TaskDetailsState = {}
      incomingGoals.forEach((goal) => {
        goal.buckets.forEach((bucket) => {
          bucket.tasks.forEach((task) => {
            const existing = currentDetails[task.id]
            const pendingNotes = taskNotesLatestRef.current.get(task.id)
            const notes =
              pendingNotes !== undefined
                ? pendingNotes
                : typeof task.notes === 'string'
                  ? task.notes
                  : existing?.notes ?? ''
            const remoteSubtasks = Array.isArray(task.subtasks) ? task.subtasks : []
            const mergedSubtasks = mergeSubtasksWithSources(task.id, remoteSubtasks, [
              existing?.subtasks ?? [],
            ])
            next[task.id] = {
              notes,
              subtasks: mergedSubtasks,
              expanded: existing?.expanded ?? false,
              subtasksCollapsed: existing?.subtasksCollapsed ?? false,
            }
          })
        })
      })
      return next
    },
    [mergeSubtasksWithSources, taskNotesLatestRef],
  )

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const applySupabaseGoalsPayload = useCallback(
    (payload: any[]) => {
      const normalized = normalizeSupabaseGoalsPayload(payload) as Goal[]
      setGoals((current) => mergeIncomingGoals(current, normalized))
      setTaskDetails((current) => mergeIncomingTaskDetails(current, normalized))
    },
    [mergeIncomingGoals, mergeIncomingTaskDetails],
  )

  const refreshGoalsFromSupabase = useCallback(
    (reason?: string) => {
      if (goalsRefreshInFlightRef.current) {
        goalsRefreshPendingRef.current = true
        return
      }
      goalsRefreshInFlightRef.current = true
      ;(async () => {
        try {
          const result = await fetchGoalsHierarchy()
          if (!isMountedRef.current) {
            return
          }
          if (result?.goals) {
            applySupabaseGoalsPayload(result.goals)
          }
        } catch (error) {
          console.warn(
            `[GoalsPage] Failed to refresh goals from Supabase${reason ? ` (${reason})` : ''}:`,
            error,
          )
        } finally {
          goalsRefreshInFlightRef.current = false
          if (goalsRefreshPendingRef.current) {
            goalsRefreshPendingRef.current = false
            refreshGoalsFromSupabase(reason)
          }
        }
      })()
    },
    [applySupabaseGoalsPayload],
  )

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
        let normalizedGoals: Goal[] | null = null
        setGoals((current) => {
          const reconciled = reconcileGoalsWithSnapshot(snapshot, current)
          normalizedGoals = reconciled
          return mergeIncomingGoals(current, reconciled)
        })
        if (normalizedGoals) {
          const normalizedSnapshot = normalizedGoals
          setTaskDetails((current) => mergeIncomingTaskDetails(current, normalizedSnapshot))
        }
      }
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(run)
      } else {
        Promise.resolve()
          .then(run)
          .catch(() => {
            // ignore
          })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mergeIncomingGoals, mergeIncomingTaskDetails, refreshGoalsFromSupabase])

  // Load once on mount and refresh when the user returns focus to this tab
  useEffect(() => {
    refreshGoalsFromSupabase('initial-load')
  }, [refreshGoalsFromSupabase])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    const handleFocus = () => {
      if (!document.hidden) {
        refreshGoalsFromSupabase('window-focus')
      }
    }
    const handleVisibility = () => {
      if (!document.hidden) {
        refreshGoalsFromSupabase('document-visible')
      }
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshGoalsFromSupabase])

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
    if (typeof window !== 'undefined') {
      taskNotesLatestRef.current.forEach((_, taskId) => {
        if (!validTaskIds.has(taskId)) {
          const timer = taskNotesSaveTimersRef.current.get(taskId)
          if (timer) {
            window.clearTimeout(timer)
            taskNotesSaveTimersRef.current.delete(taskId)
          }
          taskNotesLatestRef.current.delete(taskId)
        }
      })
      subtaskLatestRef.current.forEach((_, compositeKey) => {
        const [taskId] = compositeKey.split(':')
        if (!taskId || !validTaskIds.has(taskId)) {
          const timer = subtaskSaveTimersRef.current.get(compositeKey)
          if (timer) {
            window.clearTimeout(timer)
            subtaskSaveTimersRef.current.delete(compositeKey)
          }
          subtaskLatestRef.current.delete(compositeKey)
        }
      })
    }
  }, [goals])

  useEffect(() => {
    if (!managingArchivedGoalId) {
      return
    }
    const exists = goals.some((goal) => goal.id === managingArchivedGoalId)
    if (!exists) {
      setManagingArchivedGoalId(null)
    }
  }, [goals, managingArchivedGoalId])

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
          subtasksCollapsed: Boolean((base as any).subtasksCollapsed),
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
  const scheduleTaskNotesPersist = useCallback(
    (taskId: string, notes: string) => {
      if (typeof window === 'undefined') {
        void apiUpdateTaskNotes(taskId, notes)
          .then(() => {
            taskNotesLatestRef.current.delete(taskId)
          })
          .catch((error) => console.warn('[GoalsPage] Failed to persist task notes:', error))
        return
      }
      taskNotesLatestRef.current.set(taskId, notes)
      const timers = taskNotesSaveTimersRef.current
      const pending = timers.get(taskId)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(taskId)
        const latest = taskNotesLatestRef.current.get(taskId) ?? ''
        void apiUpdateTaskNotes(taskId, latest)
          .then(() => {
            if (taskNotesLatestRef.current.get(taskId) === latest) {
              taskNotesLatestRef.current.delete(taskId)
            }
          })
          .catch((error) => console.warn('[GoalsPage] Failed to persist task notes:', error))
      }, 500)
      timers.set(taskId, handle)
    },
    [apiUpdateTaskNotes],
  )

  const cancelPendingSubtaskSave = useCallback((taskId: string, subtaskId: string) => {
    if (typeof window !== 'undefined') {
      const key = `${taskId}:${subtaskId}`
      const timers = subtaskSaveTimersRef.current
      const pending = timers.get(key)
      if (pending) {
        window.clearTimeout(pending)
        timers.delete(key)
      }
      subtaskLatestRef.current.delete(key)
    } else {
      subtaskLatestRef.current.delete(`${taskId}:${subtaskId}`)
    }
  }, [])

  const scheduleSubtaskPersist = useCallback(
    (taskId: string, subtask: TaskSubtask) => {
      if (subtask.text.trim().length === 0) {
        cancelPendingSubtaskSave(taskId, subtask.id)
        return
      }
      const key = `${taskId}:${subtask.id}`
      subtaskLatestRef.current.set(key, { ...subtask })
      if (typeof window === 'undefined') {
        const payload = { ...subtask }
        void apiUpsertTaskSubtask(taskId, {
          id: payload.id,
          text: payload.text,
          completed: payload.completed,
          sort_index: payload.sortIndex,
        })
          .then(() => {
            const currentLatest = subtaskLatestRef.current.get(key)
            if (
              currentLatest &&
              currentLatest.id === payload.id &&
              currentLatest.text === payload.text &&
              currentLatest.completed === payload.completed &&
              currentLatest.sortIndex === payload.sortIndex
            ) {
              subtaskLatestRef.current.delete(key)
            }
          })
          .catch((error) => console.warn('[GoalsPage] Failed to persist subtask:', error))
        return
      }
      const timers = subtaskSaveTimersRef.current
      const pending = timers.get(key)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(key)
        const latest = subtaskLatestRef.current.get(key)
        if (!latest || latest.text.trim().length === 0) {
          return
        }
        const payload = { ...latest }
        void apiUpsertTaskSubtask(taskId, {
          id: payload.id,
          text: payload.text,
          completed: payload.completed,
          sort_index: payload.sortIndex,
        })
          .then(() => {
            const currentLatest = subtaskLatestRef.current.get(key)
            if (
              currentLatest &&
              currentLatest.id === payload.id &&
              currentLatest.text === payload.text &&
              currentLatest.completed === payload.completed &&
              currentLatest.sortIndex === payload.sortIndex
            ) {
              subtaskLatestRef.current.delete(key)
            }
          })
          .catch((error) => console.warn('[GoalsPage] Failed to persist subtask:', error))
      }, 400)
      timers.set(key, handle)
    },
    [apiUpsertTaskSubtask, cancelPendingSubtaskSave],
  )

  const flushSubtaskPersist = useCallback(
    (taskId: string, subtask: TaskSubtask) => {
      cancelPendingSubtaskSave(taskId, subtask.id)
      if (subtask.text.trim().length === 0) {
        return
      }
      const payload = { ...subtask }
      void apiUpsertTaskSubtask(taskId, {
        id: payload.id,
        text: payload.text,
        completed: payload.completed,
        sort_index: payload.sortIndex,
      })
        .then(() => {
          const key = `${taskId}:${payload.id}`
          const currentLatest = subtaskLatestRef.current.get(key)
          if (
            currentLatest &&
            currentLatest.id === payload.id &&
            currentLatest.text === payload.text &&
            currentLatest.completed === payload.completed &&
            currentLatest.sortIndex === payload.sortIndex
          ) {
            subtaskLatestRef.current.delete(key)
          }
        })
        .catch((error) => console.warn('[GoalsPage] Failed to persist subtask:', error))
    },
    [apiUpsertTaskSubtask, cancelPendingSubtaskSave],
  )

  const handleToggleTaskDetails = useCallback(
    (taskId: string) => {
      const wasExpanded = Boolean(taskDetailsRef.current[taskId]?.expanded)
      const willExpand = !wasExpanded
      updateTaskDetails(taskId, (current) => ({
        ...current,
        expanded: willExpand,
      }))
      // Lazy-load notes when opening the details panel for the first time
      if (willExpand) {
        const existingNotes = taskDetailsRef.current[taskId]?.notes ?? ''
        if (existingNotes.trim().length > 0) {
          return
        }
        if (!requestedTaskNotesRef.current.has(taskId)) {
          requestedTaskNotesRef.current.add(taskId)
          void apiFetchTaskNotes(taskId)
            .then((notes) => {
              if (typeof notes === 'string' && notes.length > 0) {
                // Update local details state and in-memory goals snapshot
                updateTaskDetails(taskId, (current) => ({ ...current, notes }))
                syncGoalTaskNotes(taskId, notes)
              }
            })
            .catch((error) => {
              console.warn('[GoalsPage] Failed to lazy-load task notes:', error)
            })
        }
      }
    },
    [updateTaskDetails, apiFetchTaskNotes, syncGoalTaskNotes],
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
      syncGoalTaskNotes(taskId, value)
      scheduleTaskNotesPersist(taskId, value)
    },
    [scheduleTaskNotesPersist, syncGoalTaskNotes, updateTaskDetails],
  )

  const handleAddSubtask = useCallback(
    (taskId: string, options?: { focus?: boolean }) => {
      const currentDetails = taskDetailsRef.current[taskId] ?? createTaskDetails()
      const sortIndex = getNextSubtaskSortIndex(currentDetails.subtasks ?? [])
      const newSubtask = createEmptySubtask(sortIndex)
      updateTaskDetails(taskId, (current) => ({
        ...current,
        expanded: true,
        subtasksCollapsed: false,
        subtasks: [...current.subtasks, newSubtask],
      }))
      updateGoalTaskSubtasks(taskId, (current) => [...current, newSubtask])
      if (options?.focus) {
        pendingGoalSubtaskFocusRef.current = { taskId, subtaskId: newSubtask.id }
      }
    },
    [updateGoalTaskSubtasks, updateTaskDetails],
  )

  useEffect(() => {
    const pending = pendingGoalSubtaskFocusRef.current
    if (!pending) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const inputId = makeGoalSubtaskInputId(pending.taskId, pending.subtaskId)
    let attempts = 0
    const tryFocus = () => {
      const input = document.getElementById(inputId) as HTMLInputElement | null
      if (input) {
        input.focus()
        input.select()
        pendingGoalSubtaskFocusRef.current = null
        return
      }
      if (typeof window.requestAnimationFrame === 'function' && attempts < 2) {
        attempts += 1
        window.requestAnimationFrame(tryFocus)
      } else {
        pendingGoalSubtaskFocusRef.current = null
      }
    }
    tryFocus()
  }, [taskDetails])

  const handleSubtaskTextChange = useCallback(
    (taskId: string, subtaskId: string, value: string) => {
      const currentDetails = taskDetailsRef.current[taskId] ?? createTaskDetails()
      const existing = currentDetails.subtasks.find((item) => item.id === subtaskId)
      if (!existing || existing.text === value) {
        return
      }
      const updated: TaskSubtask = { ...existing, text: value }
      updateTaskDetails(taskId, (current) => ({
        ...current,
        expanded: true,
        subtasks: current.subtasks.map((item) => (item.id === subtaskId ? updated : item)),
      }))
      updateGoalTaskSubtasks(taskId, (current) =>
        current.map((item) => (item.id === subtaskId ? updated : item)),
      )
      if (value.trim().length > 0) {
        scheduleSubtaskPersist(taskId, updated)
      } else {
        cancelPendingSubtaskSave(taskId, subtaskId)
      }
    },
    [cancelPendingSubtaskSave, scheduleSubtaskPersist, updateGoalTaskSubtasks, updateTaskDetails],
  )

  const handleSubtaskBlur = useCallback(
    (taskId: string, subtaskId: string) => {
      const currentDetails = taskDetailsRef.current[taskId] ?? createTaskDetails()
      const existing = currentDetails.subtasks.find((item) => item.id === subtaskId)
      if (!existing) {
        return
      }
      const trimmed = existing.text.trim()
      if (trimmed.length === 0) {
        updateTaskDetails(taskId, (current) => ({
          ...current,
          subtasks: current.subtasks.filter((item) => item.id !== subtaskId),
        }))
        updateGoalTaskSubtasks(taskId, (current) => current.filter((item) => item.id !== subtaskId))
        cancelPendingSubtaskSave(taskId, subtaskId)
        void apiDeleteTaskSubtask(taskId, subtaskId).catch((error) =>
          console.warn('[GoalsPage] Failed to delete empty subtask:', error),
        )
        return
      }
      const normalized: TaskSubtask =
        trimmed === existing.text ? existing : { ...existing, text: trimmed }
      updateTaskDetails(taskId, (current) => ({
        ...current,
        subtasks: current.subtasks.map((item) => (item.id === subtaskId ? normalized : item)),
      }))
      updateGoalTaskSubtasks(taskId, (current) =>
        current.map((item) => (item.id === subtaskId ? normalized : item)),
      )
      flushSubtaskPersist(taskId, normalized)
    },
    [cancelPendingSubtaskSave, flushSubtaskPersist, updateGoalTaskSubtasks, updateTaskDetails],
  )

  const handleToggleSubtaskSection = useCallback(
    (taskId: string) => {
      updateTaskDetails(taskId, (current) => ({
        ...current,
        subtasksCollapsed: !current.subtasksCollapsed,
      }))
    },
    [updateTaskDetails],
  )
  const collapseAllTaskDetailsForDrag = useCallback(
    (draggingTaskId: string) => {
      if (draggingTaskIdRef.current === draggingTaskId) {
        return
      }
      draggingTaskIdRef.current = draggingTaskId
      setTaskDetails((current) => {
        const snapshot = new Map<string, { expanded: boolean; subtasksCollapsed: boolean }>()
        let mutated: TaskDetailsState | null = null
        Object.entries(current).forEach(([taskId, details]) => {
          if (details.expanded || !details.subtasksCollapsed) {
            snapshot.set(taskId, {
              expanded: details.expanded,
              subtasksCollapsed: details.subtasksCollapsed,
            })
            if (!mutated) {
              mutated = { ...current }
            }
            mutated[taskId] = {
              ...details,
              expanded: false,
              subtasksCollapsed: true,
            }
          }
        })
        taskDetailsDragSnapshotRef.current = snapshot
        if (!mutated) {
          return current
        }
        taskDetailsRef.current = mutated
        return mutated
      })
    },
    [setTaskDetails],
  )

  const restoreTaskDetailsAfterDrag = useCallback(
    (_draggedTaskId: string) => {
      const snapshot = new Map(taskDetailsDragSnapshotRef.current)
      taskDetailsDragSnapshotRef.current = new Map()
      draggingTaskIdRef.current = null
      if (snapshot.size === 0) {
        return
      }
      setTaskDetails((current) => {
        let mutated: TaskDetailsState | null = null
        snapshot.forEach((previous, taskId) => {
          const details = current[taskId]
          if (!details) {
            return
          }
          const targetExpanded = previous.expanded
          const targetSubtasksCollapsed = previous.subtasksCollapsed
          if (details.expanded !== targetExpanded || details.subtasksCollapsed !== targetSubtasksCollapsed) {
            if (!mutated) {
              mutated = { ...current }
            }
            mutated[taskId] = {
              ...details,
              expanded: targetExpanded,
              subtasksCollapsed: targetSubtasksCollapsed,
            }
          }
        })
        if (!mutated) {
          return current
        }
        taskDetailsRef.current = mutated
        return mutated
      })
    },
    [setTaskDetails],
  )

  const handleToggleSubtaskCompleted = useCallback(
    (taskId: string, subtaskId: string) => {
      const currentDetails = taskDetailsRef.current[taskId] ?? createTaskDetails()
      const existing = currentDetails.subtasks.find((item) => item.id === subtaskId)
      if (!existing) {
        return
      }
      const toggled: TaskSubtask = { ...existing, completed: !existing.completed }
      updateTaskDetails(taskId, (current) => ({
        ...current,
        subtasks: current.subtasks.map((item) => (item.id === subtaskId ? toggled : item)),
      }))
      updateGoalTaskSubtasks(taskId, (current) =>
        current.map((item) => (item.id === subtaskId ? toggled : item)),
      )
      if (toggled.text.trim().length === 0) {
        cancelPendingSubtaskSave(taskId, toggled.id)
        return
      }
      scheduleSubtaskPersist(taskId, toggled)
    },
    [cancelPendingSubtaskSave, scheduleSubtaskPersist, updateGoalTaskSubtasks, updateTaskDetails],
  )

  const handleRemoveSubtask = useCallback(
    (taskId: string, subtaskId: string) => {
      let removed = false
      updateTaskDetails(taskId, (current) => {
        const nextSubtasks = current.subtasks.filter((item) => item.id !== subtaskId)
        if (nextSubtasks.length === current.subtasks.length) {
          return current
        }
        removed = true
        return {
          ...current,
          subtasks: nextSubtasks,
        }
      })
      if (!removed) {
        return
      }
      updateGoalTaskSubtasks(taskId, (current) => current.filter((item) => item.id !== subtaskId))
      cancelPendingSubtaskSave(taskId, subtaskId)
      void apiDeleteTaskSubtask(taskId, subtaskId).catch((error) =>
        console.warn('[GoalsPage] Failed to remove subtask:', error),
      )
    },
    [cancelPendingSubtaskSave, updateGoalTaskSubtasks, updateTaskDetails],
  )
  const [nextGoalGradientIndex, setNextGoalGradientIndex] = useState(() => DEFAULT_GOALS.length % GOAL_GRADIENTS.length)
  const [activeCustomizerGoalId, setActiveCustomizerGoalId] = useState<string | null>(null)
  const customizerDialogRef = useRef<HTMLDivElement | null>(null)
  const archivedManagerDialogRef = useRef<HTMLDivElement | null>(null)
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
  const archivedManagerGoal = useMemo(
    () => goals.find((goal) => goal.id === managingArchivedGoalId) ?? null,
    [goals, managingArchivedGoalId],
  )
  const archivedBucketsForManager = useMemo(
    () => (archivedManagerGoal ? archivedManagerGoal.buckets.filter((bucket) => bucket.archived) : []),
    [archivedManagerGoal],
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
      if (!cancelled) {
        refreshGoalsFromSupabase('initial-load')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshGoalsFromSupabase])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    const handleFocus = () => {
      if (!document.hidden) {
        refreshGoalsFromSupabase('window-focus')
      }
    }
    const handleVisibility = () => {
      if (!document.hidden) {
        refreshGoalsFromSupabase('document-visible')
      }
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshGoalsFromSupabase])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined') {
        taskNotesSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
        subtaskSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      }
      taskNotesSaveTimersRef.current.clear()
      subtaskSaveTimersRef.current.clear()
      taskNotesLatestRef.current.forEach((notes, taskId) => {
        void apiUpdateTaskNotes(taskId, notes).catch((error) =>
          console.warn('[GoalsPage] Failed to flush task notes on cleanup:', error),
        )
      })
      subtaskLatestRef.current.forEach((subtask, compositeKey) => {
        const [taskId] = compositeKey.split(':')
        if (!taskId || subtask.text.trim().length === 0) {
          return
        }
        void apiUpsertTaskSubtask(taskId, {
          id: subtask.id,
          text: subtask.text,
          completed: subtask.completed,
          sort_index: subtask.sortIndex,
        }).catch((error) => console.warn('[GoalsPage] Failed to flush subtask on cleanup:', error))
      })
      taskNotesLatestRef.current.clear()
      subtaskLatestRef.current.clear()
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

  useEffect(() => {
    if (!archivedManagerGoal) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeArchivedManager()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    const frame = window.requestAnimationFrame(() => {
      const dialog = archivedManagerDialogRef.current
      if (!dialog) {
        return
      }
      const focusTarget = dialog.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusTarget?.focus()
    })
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.cancelAnimationFrame(frame)
    }
  }, [archivedManagerGoal])

  const closeCustomizer = useCallback(() => setActiveCustomizerGoalId(null), [])

  // Goal-level DnD hover state and ghost
  const [goalHoverIndex, setGoalHoverIndex] = useState<number | null>(null)
  const [goalLineTop, setGoalLineTop] = useState<number | null>(null)
  const [showArchivedGoals, setShowArchivedGoals] = useState(false)

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

  const startLifeRoutineRename = (routineId: string, initial: string) => {
    setRenamingLifeRoutineId(routineId)
    setLifeRoutineRenameDraft(initial)
    setEditingLifeRoutineDescriptionId(null)
    setLifeRoutineDescriptionDraft('')
  }
  const handleLifeRoutineRenameChange = (value: string) => setLifeRoutineRenameDraft(value)
  const submitLifeRoutineRename = () => {
    if (!renamingLifeRoutineId) {
      return
    }
    const next = lifeRoutineRenameDraft.trim()
    if (next.length > 0) {
      setLifeRoutineTasks((current) =>
        current.map((task) => (task.id === renamingLifeRoutineId ? { ...task, title: next } : task)),
      )
    }
    setRenamingLifeRoutineId(null)
    setLifeRoutineRenameDraft('')
    setLifeRoutineDescriptionDraft((current) =>
      renamingLifeRoutineId === editingLifeRoutineDescriptionId ? current : '',
    )
  }
  const cancelLifeRoutineRename = () => {
    const currentId = renamingLifeRoutineId
    setRenamingLifeRoutineId(null)
    setLifeRoutineRenameDraft('')
    if (currentId && editingLifeRoutineDescriptionId === currentId) {
      setEditingLifeRoutineDescriptionId(null)
      setLifeRoutineDescriptionDraft('')
    }
  }
  const startLifeRoutineDescriptionEdit = (routine: LifeRoutineConfig) => {
    setRenamingLifeRoutineId(routine.id)
    setLifeRoutineRenameDraft(routine.title)
    setEditingLifeRoutineDescriptionId(routine.id)
    setLifeRoutineDescriptionDraft(routine.blurb)
  }
  const handleLifeRoutineDescriptionChange = (value: string) => setLifeRoutineDescriptionDraft(value)
  const submitLifeRoutineDescription = () => {
    if (!editingLifeRoutineDescriptionId) {
      return
    }
    const routineId = editingLifeRoutineDescriptionId
    const next = lifeRoutineDescriptionDraft.trim()
    setLifeRoutineTasks((current) =>
      current.map((task) => (task.id === routineId ? { ...task, blurb: next } : task)),
    )
    setEditingLifeRoutineDescriptionId(null)
    setLifeRoutineDescriptionDraft('')
    setRenamingLifeRoutineId((current) => (current === routineId ? null : current))
    setLifeRoutineRenameDraft('')
  }
  const cancelLifeRoutineDescription = () => {
    setEditingLifeRoutineDescriptionId(null)
    setLifeRoutineDescriptionDraft('')
    setRenamingLifeRoutineId(null)
    setLifeRoutineRenameDraft('')
  }
  const updateLifeRoutineSurface = (routineId: string, surface: BucketSurfaceStyle) => {
    setLifeRoutineTasks((current) =>
      current.map((task) => (task.id === routineId ? { ...task, surfaceStyle: surface } : task)),
    )
  }
  const deleteLifeRoutine = (routineId: string) => {
    const routine = lifeRoutineTasks.find((task) => task.id === routineId) ?? null
    setLifeRoutineTasks((current) => {
      const updated = current.filter((task) => task.id !== routineId)
      return sanitizeLifeRoutineList(updated)
    })
    setLifeRoutineMenuOpenId((current) => (current === routineId ? null : current))
    setActiveLifeRoutineCustomizerId((current) => (current === routineId ? null : current))
    if (renamingLifeRoutineId === routineId) {
      setRenamingLifeRoutineId(null)
      setLifeRoutineRenameDraft('')
    }
    if (editingLifeRoutineDescriptionId === routineId) {
      setEditingLifeRoutineDescriptionId(null)
      setLifeRoutineDescriptionDraft('')
    }
    setFocusPromptTarget((current) => {
      if (
        current &&
        current.goalId === LIFE_ROUTINES_GOAL_ID &&
        current.taskId === routineId &&
        (!routine || current.bucketId === routine.bucketId)
      ) {
        return null
      }
      return current
    })
  }

  const handleAddLifeRoutine = () => {
    const id = `life-custom-${Date.now().toString(36)}`
    const title = 'New routine'
    const newRoutine: LifeRoutineConfig = {
      id,
      bucketId: id,
      title,
      blurb: 'Describe the cadence you want to build.',
      surfaceStyle: DEFAULT_SURFACE_STYLE,
      sortIndex: lifeRoutineTasks.length,
    }
    setLifeRoutinesExpanded(true)
    setLifeRoutineTasks((current) => {
      const updated = [...current, newRoutine]
      return sanitizeLifeRoutineList(updated)
    })
    setRenamingLifeRoutineId(id)
    setLifeRoutineRenameDraft(title)
    setEditingLifeRoutineDescriptionId(null)
    setLifeRoutineDescriptionDraft('')
    requestAnimationFrame(() => {
      lifeRoutineRenameInputRef.current?.focus()
    })
  }

  const reorderLifeRoutines = (routineId: string, targetIndex: number) => {
    setLifeRoutineTasks((current) => {
      const fromIndex = current.findIndex((task) => task.id === routineId)
      if (fromIndex === -1) {
        return current
      }
      
      // Clamp the target index to valid range
      const clampedTargetIndex = Math.max(0, Math.min(targetIndex, current.length - 1))
      
      // If we're not actually moving, don't change anything
      if (fromIndex === clampedTargetIndex) {
        return current
      }
      
      const next = current.slice()
      const [moved] = next.splice(fromIndex, 1)
      next.splice(clampedTargetIndex, 0, moved)
      return sanitizeLifeRoutineList(next)
    })
  }

  const archiveGoal = (goalId: string) => {
    let bucketIds: string[] = []
    let taskIds: string[] = []
    setGoals((current) => {
      const target = current.find((goal) => goal.id === goalId)
      if (!target || target.archived) {
        return current
      }
      bucketIds = target.buckets.map((bucket) => bucket.id)
      taskIds = target.buckets.flatMap((bucket) => bucket.tasks.map((task) => task.id))
      const next = current.map((goal) => (goal.id === goalId ? { ...goal, archived: true } : goal))
      apiSetGoalArchived(goalId, true).catch(() => {
        setGoals((rollback) =>
          rollback.map((goal) => (goal.id === goalId ? { ...goal, archived: false } : goal)),
        )
      })
      return next
    })
    setExpanded((prev) => {
      if (!prev[goalId]) {
        return prev
      }
      const next = { ...prev }
      next[goalId] = false
      return next
    })
    setBucketExpanded((prev) => {
      if (bucketIds.length === 0) {
        return prev
      }
      let changed = false
      const next = { ...prev }
      bucketIds.forEach((bucketId) => {
        if (next[bucketId]) {
          next[bucketId] = false
          changed = true
        }
      })
      return changed ? next : prev
    })
    setCompletedCollapsed((prev) => {
      if (bucketIds.length === 0) {
        return prev
      }
      let changed = false
      const next = { ...prev }
      bucketIds.forEach((bucketId) => {
        if (next[bucketId] !== undefined) {
          next[bucketId] = true
          changed = true
        }
      })
      return changed ? next : prev
    })
    setBucketDrafts((prev) => {
      if (prev[goalId] === undefined) return prev
      const { [goalId]: _removed, ...rest } = prev
      return rest
    })
    if (bucketIds.length > 0) {
      setTaskDrafts((prev) => {
        let changed = false
        const next = { ...prev }
        bucketIds.forEach((bucketId) => {
          if (bucketId in next) {
            delete next[bucketId]
            changed = true
          }
        })
        return changed ? next : prev
      })
    }
    if (taskIds.length > 0) {
      setTaskEdits((prev) => {
        let changed = false
        const next = { ...prev }
        taskIds.forEach((taskId) => {
          if (taskId in next) {
            delete next[taskId]
            changed = true
          }
        })
        return changed ? next : prev
      })
      setTaskDetails((prev) => {
        let changed = false
        const next = { ...prev }
        taskIds.forEach((taskId) => {
          if (taskId in next) {
            delete next[taskId]
            changed = true
          }
        })
        return changed ? next : prev
      })
    }
    if (focusPromptTarget?.goalId === goalId) {
      setFocusPromptTarget(null)
    }
    if (revealedDeleteTaskKey && revealedDeleteTaskKey.startsWith(`${goalId}__`)) {
      setRevealedDeleteTaskKey(null)
    }
    if (renamingGoalId === goalId) {
      setRenamingGoalId(null)
      setGoalRenameDraft('')
    }
    if (activeCustomizerGoalId === goalId) {
      setActiveCustomizerGoalId(null)
    }
    if (managingArchivedGoalId === goalId) {
      setManagingArchivedGoalId(null)
    }
  }

  const restoreGoal = (goalId: string) => {
    setGoals((current) => {
      const target = current.find((goal) => goal.id === goalId)
      if (!target || !target.archived) {
        return current
      }
      const next = current.map((goal) => (goal.id === goalId ? { ...goal, archived: false } : goal))
      apiSetGoalArchived(goalId, false).catch(() => {
        setGoals((rollback) =>
          rollback.map((goal) => (goal.id === goalId ? { ...goal, archived: true } : goal)),
        )
      })
      return next
    })
    setExpanded((prev) => ({ ...prev, [goalId]: true }))
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

  const archiveBucket = (goalId: string, bucketId: string) => {
    let archivedInsertIndex: number | null = null
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) {
          return g
        }
        const currentIndex = g.buckets.findIndex((bucket) => bucket.id === bucketId)
        if (currentIndex === -1) {
          return g
        }
        const nextBuckets = g.buckets.slice()
        const [removed] = nextBuckets.splice(currentIndex, 1)
        if (!removed) {
          return g
        }
        const updatedBucket: Bucket = { ...removed, archived: true }
        const firstArchivedIndex = nextBuckets.findIndex((bucket) => bucket.archived)
        const insertIndex = firstArchivedIndex === -1 ? nextBuckets.length : firstArchivedIndex
        archivedInsertIndex = insertIndex
        nextBuckets.splice(insertIndex, 0, updatedBucket)
        return { ...g, buckets: nextBuckets }
      }),
    )
    setBucketExpanded((prev) => ({ ...prev, [bucketId]: false }))
    setCompletedCollapsed((prev) => ({ ...prev, [bucketId]: true }))
    setTaskDrafts((prev) => {
      if (prev[bucketId] === undefined) {
        return prev
      }
      const { [bucketId]: _removed, ...rest } = prev
      return rest
    })
    setFocusPromptTarget((current) =>
      current && current.goalId === goalId && current.bucketId === bucketId ? null : current,
    )
    setRevealedDeleteTaskKey((current) =>
      current && current.startsWith(`${goalId}__${bucketId}__`) ? null : current,
    )
    if (renamingBucketId === bucketId) {
      setRenamingBucketId(null)
      setBucketRenameDraft('')
    }
    apiSetBucketArchived(bucketId, true).catch(() => {})
    if (archivedInsertIndex !== null) {
      apiSetBucketSortIndex(goalId, bucketId, archivedInsertIndex).catch(() => {})
    }
  }

  const unarchiveBucket = (goalId: string, bucketId: string) => {
    let restoredIndex: number | null = null
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) {
          return g
        }
        const currentIndex = g.buckets.findIndex((bucket) => bucket.id === bucketId)
        if (currentIndex === -1) {
          return g
        }
        const nextBuckets = g.buckets.slice()
        const [removed] = nextBuckets.splice(currentIndex, 1)
        if (!removed) {
          return g
        }
        const updatedBucket: Bucket = { ...removed, archived: false }
        const firstArchivedIndex = nextBuckets.findIndex((bucket) => bucket.archived)
        const insertIndex = firstArchivedIndex === -1 ? nextBuckets.length : firstArchivedIndex
        restoredIndex = insertIndex
        nextBuckets.splice(insertIndex, 0, updatedBucket)
        return { ...g, buckets: nextBuckets }
      }),
    )
    setBucketExpanded((prev) => ({ ...prev, [bucketId]: false }))
    setCompletedCollapsed((prev) => ({ ...prev, [bucketId]: true }))
    apiSetBucketArchived(bucketId, false).catch(() => {})
    if (restoredIndex !== null) {
      apiSetBucketSortIndex(goalId, bucketId, restoredIndex).catch(() => {})
    }
  }

  const openArchivedManager = (goalId: string) => {
    setManagingArchivedGoalId(goalId)
  }

  const closeArchivedManager = () => {
    setManagingArchivedGoalId(null)
  }

  const deleteCompletedTasks = (goalId: string, bucketId: string) => {
    if (revealedDeleteTaskKey && revealedDeleteTaskKey.startsWith(`${goalId}__${bucketId}__`)) {
      setRevealedDeleteTaskKey(null)
    }
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
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, archived: false, surfaceStyle: surface, tasks: [] }
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
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, archived: false, surfaceStyle: 'glass', tasks: [] }
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
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, surfaceStyle, starred: false, archived: false, buckets: [] }
        setGoals((current) => [newGoal, ...current])
        setExpanded((current) => ({ ...current, [id]: true }))
        // Persist new goal at the top to match optimistic UI order
        if (db?.id) {
          apiSetGoalSortIndex(db.id, 0).catch(() => {})
        }
      })
      .catch(() => {
        const id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, surfaceStyle: 'glass', starred: false, archived: false, buckets: [] }
        setGoals((current) => [newGoal, ...current])
        setExpanded((current) => ({ ...current, [id]: true }))
      })

    setNextGoalGradientIndex((index) => (index + 1) % GOAL_GRADIENTS.length)
    closeCreateGoal()
  }

const normalizedSearch = searchTerm.trim().toLowerCase()

  const lifeRoutineMatchesSearch = useMemo(() => {
    if (!normalizedSearch) {
      return true
    }
    const needle = normalizedSearch
    if (LIFE_ROUTINES_NAME.toLowerCase().includes(needle)) {
      return true
    }
    return lifeRoutineTasks.some((task) => {
      const titleMatch = task.title.toLowerCase().includes(needle)
      const blurbMatch = task.blurb.toLowerCase().includes(needle)
      return titleMatch || blurbMatch
    })
  }, [lifeRoutineTasks, normalizedSearch])

  const filteredGoals = useMemo(() => {
    if (!normalizedSearch) {
      return goals
    }
    return goals.filter((goal) => {
      if (goal.name.toLowerCase().includes(normalizedSearch)) {
        return true
      }
      return goal.buckets.filter((bucket) => !bucket.archived).some((bucket) => {
        if (bucket.name.toLowerCase().includes(normalizedSearch)) {
          return true
        }
        return bucket.tasks.some((task) => task.text.toLowerCase().includes(normalizedSearch))
      })
    })
  }, [goals, normalizedSearch])

  const visibleActiveGoals = useMemo(
    () => filteredGoals.filter((goal) => !goal.archived),
    [filteredGoals],
  )
  const visibleArchivedGoals = useMemo(
    () => filteredGoals.filter((goal) => goal.archived),
    [filteredGoals],
  )
  const archivedGoals = useMemo(() => goals.filter((goal) => goal.archived), [goals])
  const archivedGoalsCount = archivedGoals.length

  const hasNoGoals = goals.length === 0
  const hasNoActiveGoals = goals.every((goal) => goal.archived)
  const hasLifeRoutineMatch = normalizedSearch ? lifeRoutineMatchesSearch : false
  const showNoActiveGoalsNotice =
    visibleActiveGoals.length === 0 && (normalizedSearch ? !hasLifeRoutineMatch : true)
  const shouldShowLifeRoutinesCard = !normalizedSearch || lifeRoutineMatchesSearch

  useEffect(() => {
    if (normalizedSearch && visibleArchivedGoals.length > 0) {
      setShowArchivedGoals((current) => (current ? current : true))
    }
  }, [normalizedSearch, visibleArchivedGoals])

  useEffect(() => {
    if (normalizedSearch && lifeRoutineMatchesSearch) {
      setLifeRoutinesExpanded((current) => (current ? current : true))
    }
  }, [normalizedSearch, lifeRoutineMatchesSearch])

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
      const details = taskDetailsRef.current[task.id]
      const fallbackSubtasks = Array.isArray(task.subtasks) ? task.subtasks : []
      const effectiveNotes =
        details?.notes ?? (typeof task.notes === 'string' ? task.notes : '') ?? ''
      const effectiveSubtasks =
        (details?.subtasks && details.subtasks.length > 0 ? details.subtasks : fallbackSubtasks) ?? []
      const broadcastSubtasks = effectiveSubtasks.map((subtask) => ({
        id: subtask.id,
        text: subtask.text,
        completed: subtask.completed,
        sortIndex: subtask.sortIndex,
      }))
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
        notes: effectiveNotes,
        subtasks: broadcastSubtasks,
      })
      setFocusPromptTarget(null)
    },
    [],
  )
  const handleLifeRoutineFocus = useCallback((routine: LifeRoutineConfig) => {
    broadcastFocusTask({
      goalId: LIFE_ROUTINES_GOAL_ID,
      goalName: LIFE_ROUTINES_NAME,
      bucketId: routine.bucketId,
      bucketName: routine.title,
      taskId: routine.id,
      taskName: routine.title,
      taskDifficulty: null,
      priority: null,
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: routine.surfaceStyle,
      autoStart: true,
      notes: '',
      subtasks: [],
    })
    setFocusPromptTarget(null)
  }, [])

  const toggleLifeRoutineFocusPrompt = useCallback((routine: LifeRoutineConfig) => {
    setFocusPromptTarget((current) => {
      const isSame =
        current &&
        current.goalId === LIFE_ROUTINES_GOAL_ID &&
        current.bucketId === routine.bucketId &&
        current.taskId === routine.id
      if (isSame) {
        return null
      }
      return { goalId: LIFE_ROUTINES_GOAL_ID, bucketId: routine.bucketId, taskId: routine.id }
    })
  }, [])

  const toggleTaskCompletion = (goalId: string, bucketId: string, taskId: string) => {
    setRevealedDeleteTaskKey((current) => {
      if (!current) {
        return current
      }
      const key = makeTaskFocusKey(goalId, bucketId, taskId)
      return current === key ? null : current
    })
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

  const deleteCompletedTask = (goalId: string, bucketId: string, taskId: string) => {
    const deleteKey = makeTaskFocusKey(goalId, bucketId, taskId)
    setRevealedDeleteTaskKey((current) => (current === deleteKey ? null : current))
    const targetTask = goals
      .find((goal) => goal.id === goalId)
      ?.buckets.find((bucket) => bucket.id === bucketId)
      ?.tasks.find((task) => task.id === taskId)
    if (!targetTask || !targetTask.completed) {
      return
    }
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) =>
                b.id === bucketId ? { ...b, tasks: b.tasks.filter((t) => t.id !== taskId) } : b,
              ),
            }
          : g,
      ),
    )
    setTaskDetails((current) => {
      if (!current[taskId]) return current
      const { [taskId]: _removed, ...rest } = current
      return rest
    })
    removeTaskEdit(taskId)
    taskEditRefs.current.delete(taskId)
    setFocusPromptTarget((current) =>
      current && current.goalId === goalId && current.bucketId === bucketId && current.taskId === taskId ? null : current,
    )
    apiDeleteTaskById(taskId, bucketId).catch((error) => {
      console.warn('[GoalsPage] Failed to delete task', error)
    })
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
    const bucket = goals.find((g) => g.id === goalId)?.buckets.find((b) => b.id === bucketId)
    if (!bucket) {
      return
    }
    const sectionTasks = bucket.tasks.filter((task) => (section === 'active' ? !task.completed : task.completed))
    const movedTask = sectionTasks[fromIndex]
    if (!movedTask) {
      return
    }

    let persistedIndex: number | null = null
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
            const listLength = list.length
            if (fromIndex < 0 || fromIndex >= listLength) {
              return b
            }
            const nextList = list.slice()
            const [moved] = nextList.splice(fromIndex, 1)
            if (!moved) {
              return b
            }
            const cappedIndex = Math.max(0, Math.min(toIndex, nextList.length))
            nextList.splice(cappedIndex, 0, moved)
            if (cappedIndex !== fromIndex) {
              const rawPersisted = cappedIndex > fromIndex ? cappedIndex + 1 : cappedIndex
              const clampedPersisted = Math.max(0, Math.min(rawPersisted, listLength))
              persistedIndex = clampedPersisted
            }
            const newTasks = section === 'active' ? [...nextList, ...completed] : [...active, ...nextList]
            return { ...b, tasks: newTasks }
          }),
        }
      }),
    )
    if (persistedIndex !== null) {
      apiSetTaskSortIndex(bucketId, section, persistedIndex, movedTask.id).catch(() => {})
    }
  }

  // Reorder buckets within a goal (active buckets only; archived stay at the end)
  const reorderBuckets = (goalId: string, bucketId: string, toIndex: number) => {
    let persistedIndex: number | null = null
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g
        const currentIndex = g.buckets.findIndex((bucket) => bucket.id === bucketId)
        if (currentIndex === -1) {
          return g
        }
        const nextBuckets = g.buckets.slice()
        const [removed] = nextBuckets.splice(currentIndex, 1)
        if (!removed) {
          return g
        }
        if (removed.archived) {
          nextBuckets.splice(currentIndex, 0, removed)
          return g
        }
        const activeBuckets = nextBuckets.filter((bucket) => !bucket.archived)
        const clampedIndex = Math.max(0, Math.min(toIndex, activeBuckets.length))
        if (clampedIndex >= activeBuckets.length) {
          const firstArchivedIndex = nextBuckets.findIndex((bucket) => bucket.archived)
          const insertIndex = firstArchivedIndex === -1 ? nextBuckets.length : firstArchivedIndex
          nextBuckets.splice(insertIndex, 0, removed)
          persistedIndex = insertIndex
        } else {
          const targetId = activeBuckets[clampedIndex].id
          const targetIndex = nextBuckets.findIndex((bucket) => bucket.id === targetId)
          const insertIndex = targetIndex === -1 ? nextBuckets.length : targetIndex
          nextBuckets.splice(insertIndex, 0, removed)
          persistedIndex = insertIndex
        }
        return { ...g, buckets: nextBuckets }
      }),
    )
    if (persistedIndex !== null) {
      apiSetBucketSortIndex(goalId, bucketId, persistedIndex).catch(() => {})
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
    const targetGoal = goals[fromGlobalIndex]
    if (!targetGoal || targetGoal.archived) {
      return
    }
    // Build the visible list exactly like the DOM candidates used for insert metrics,
    // but exclude the dragged goal so indices match the hover line positions.
    const visible = visibleActiveGoals.filter((g) => g.id !== goalId)
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

  const lifeRoutineMenuPortal =
    lifeRoutineMenuOpenId && activeLifeRoutine && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="goal-menu-overlay"
            role="presentation"
            onMouseDown={(event) => {
              event.stopPropagation()
              setLifeRoutineMenuOpenId(null)
            }}
          >
            <div
              ref={lifeRoutineMenuRef}
              className="goal-menu goal-menu--floating min-w-[180px] rounded-md border p-1 shadow-lg"
              style={{
                top: `${lifeRoutineMenuPosition.top}px`,
                left: `${lifeRoutineMenuPosition.left}px`,
                visibility: lifeRoutineMenuPositionReady ? 'visible' : 'hidden',
              }}
              role="menu"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
              className="goal-menu__item"
              onClick={(event) => {
                event.stopPropagation()
                setLifeRoutineMenuOpenId(null)
                setActiveLifeRoutineCustomizerId(activeLifeRoutine.id)
              }}
            >
              Customise gradient
            </button>
            <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item"
                onClick={(event) => {
                  event.stopPropagation()
                  setLifeRoutineMenuOpenId(null)
                  startLifeRoutineDescriptionEdit(activeLifeRoutine)
                }}
              >
                Edit description
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item"
                onClick={(event) => {
                  event.stopPropagation()
                  setLifeRoutineMenuOpenId(null)
                  startLifeRoutineRename(activeLifeRoutine.id, activeLifeRoutine.title)
                }}
              >
                Rename routine
              </button>
              <div className="goal-menu__divider" />
              <button
                type="button"
                className="goal-menu__item goal-menu__item--danger"
                onClick={(event) => {
                  event.stopPropagation()
                  setLifeRoutineMenuOpenId(null)
                  deleteLifeRoutine(activeLifeRoutine.id)
                }}
              >
                Delete routine
              </button>
            </div>
          </div>,
          document.body,
        )
      : null

  const lifeRoutineCustomizerPortal =
    activeLifeRoutineCustomizer && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="goal-customizer-overlay"
            role="presentation"
            onMouseDown={(event) => {
              event.stopPropagation()
              setActiveLifeRoutineCustomizerId(null)
            }}
          >
            <div
              ref={lifeRoutineCustomizerDialogRef}
              className="goal-customizer-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Customise routine ${activeLifeRoutineCustomizer.title}`}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <LifeRoutineCustomizer
                routine={activeLifeRoutineCustomizer}
                onUpdate={(surface) => updateLifeRoutineSurface(activeLifeRoutineCustomizer.id, surface)}
                onClose={() => setActiveLifeRoutineCustomizerId(null)}
              />
            </div>
          </div>,
          document.body,
        )
      : null

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

          {shouldShowLifeRoutinesCard ? (
            <section
              className={classNames('life-routines-card', lifeRoutinesExpanded && 'life-routines-card--open')}
              aria-label={LIFE_ROUTINES_NAME}
            >
              <div className="life-routines-card__header-wrapper">
                <div className="life-routines-card__header-left">
                  <button
                    type="button"
                    className="life-routines-card__header"
                    onClick={() => setLifeRoutinesExpanded((value) => !value)}
                    aria-expanded={lifeRoutinesExpanded}
                    aria-controls="life-routines-body"
                  >
                  <div className="life-routines-card__header-content">
                    <div className="life-routines-card__meta">
                      <p className="life-routines-card__eyebrow">System Layer</p>
                      <h2 className="life-routines-card__title">
                        {highlightText(LIFE_ROUTINES_NAME, normalizedSearch)}
                      </h2>
                      <p className="life-routines-card__subtitle">
                        {highlightText(LIFE_ROUTINES_TAGLINE, normalizedSearch)}
                      </p>
                    </div>
                  </div>
                  </button>
                  {lifeRoutinesExpanded && (
                    <button 
                      type="button" 
                      className="life-routines-card__add-inline-button" 
                      onClick={(event) => {
                        event.stopPropagation()
                        handleAddLifeRoutine()
                      }}
                      aria-label="Add routine"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path
                          d="M10 4v12M4 10h12"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>Add routine</span>
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="life-routines-card__toggle"
                  onClick={() => setLifeRoutinesExpanded((value) => !value)}
                  aria-expanded={lifeRoutinesExpanded}
                  aria-controls="life-routines-body"
                  aria-label={`${lifeRoutinesExpanded ? 'Collapse' : 'Expand'} life routines`}
                >
                  <span className="life-routines-card__indicator" aria-hidden="true">
                    <svg className="life-routines-card__chevron" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
              </div>
              {lifeRoutinesExpanded ? (
                <>
                  <ul
                    id="life-routines-body"
                    className="life-routines-card__tasks"
                    onDragOver={(event) => {
                      const info = (window as any).__dragLifeRoutineInfo as { routineId: string; index: number } | null
                      if (!info) {
                      return
                    }
                    event.preventDefault()
                    const list = event.currentTarget as HTMLElement
                    const { index, top } = computeLifeRoutineInsertMetrics(list, event.clientY)
                    setLifeRoutineHoverIndex((current) => (current === index ? current : index))
                    setLifeRoutineLineTop(top)
                  }}
                  onDrop={(event) => {
                    const info = (window as any).__dragLifeRoutineInfo as { routineId: string; index: number } | null
                    if (!info) {
                      return
                    }
                    event.preventDefault()
                    const targetIndex = lifeRoutineHoverIndex ?? lifeRoutineTasks.length
                    if (info.index !== targetIndex) {
                      reorderLifeRoutines(info.routineId, targetIndex)
                    }
                    setLifeRoutineHoverIndex(null)
                    setLifeRoutineLineTop(null)
                    const ghost = lifeRoutineDragCloneRef.current
                    if (ghost && ghost.parentNode) {
                      ghost.parentNode.removeChild(ghost)
                    }
                    lifeRoutineDragCloneRef.current = null
                    ;(window as any).__dragLifeRoutineInfo = null
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) {
                      return
                    }
                    setLifeRoutineHoverIndex(null)
                    setLifeRoutineLineTop(null)
                  }}
                >
                  {lifeRoutineLineTop !== null ? (
                    <div className="goal-insert-line" style={{ top: `${lifeRoutineLineTop}px` }} aria-hidden />
                  ) : null}
                  {lifeRoutineTasks.map((task, index) => {
                    const focusKey = makeTaskFocusKey(LIFE_ROUTINES_GOAL_ID, task.bucketId, task.id)
                    const isPromptActive =
                      focusPromptTarget &&
                      focusPromptTarget.goalId === LIFE_ROUTINES_GOAL_ID &&
                      focusPromptTarget.bucketId === task.bucketId &&
                      focusPromptTarget.taskId === task.id
                    const isRenamingRoutine = renamingLifeRoutineId === task.id
                    const isEditingRoutineDescription = editingLifeRoutineDescriptionId === task.id
                    const isRoutineEditorOpen = isRenamingRoutine || isEditingRoutineDescription
                    const taskSurfaceClass = classNames(
                      'life-routines-card__task',
                      `life-routines-card__task--surface-${task.surfaceStyle}`,
                    )
                    return (
                      <React.Fragment key={task.id}>
                        <li
                          className={taskSurfaceClass}
                          data-focus-prompt-key={isPromptActive ? focusKey : undefined}
                        >
                          <div
                            className="life-routines-card__task-inner"
                            draggable={!isRoutineEditorOpen}
                            onDragStart={(event) => {
                              if (isRoutineEditorOpen) {
                                event.preventDefault()
                                return
                              }
                              try {
                                event.dataTransfer.setData('text/plain', task.id)
                              } catch {}
                              const container = event.currentTarget.closest('li.life-routines-card__task') as
                                | HTMLElement
                                | null
                              container?.classList.add('dragging')
                              const srcEl = (container ?? event.currentTarget) as HTMLElement
                              const rect = srcEl.getBoundingClientRect()
                              const clone = srcEl.cloneNode(true) as HTMLElement
                              clone.className = 'life-routines-card__task life-routines-card__task--drag-clone'
                              clone.style.width = `${Math.floor(rect.width)}px`
                              clone.style.opacity = '0.9'
                              clone.style.pointerEvents = 'none'
                              clone.style.boxShadow = '0 12px 32px rgba(12, 18, 48, 0.35)'
                              copyVisualStyles(srcEl, clone)
                              document.body.appendChild(clone)
                              lifeRoutineDragCloneRef.current = clone
                              try {
                                event.dataTransfer.setDragImage(clone, 16, 0)
                              } catch {}
                              ;(window as any).__dragLifeRoutineInfo = { routineId: task.id, index }
                              setLifeRoutineHoverIndex(index)
                              // Collapse the original item after drag image is captured
                              const scheduleCollapse = () => {
                                container?.classList.add('life-routines-card__task--collapsed')
                              }
                              if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                                window.requestAnimationFrame(() => {
                                  window.requestAnimationFrame(scheduleCollapse)
                                })
                              } else {
                                setTimeout(scheduleCollapse, 0)
                              }
                              try {
                                event.dataTransfer.effectAllowed = 'move'
                              } catch {}
                            }}
                            onDragEnd={(event) => {
                              const info = (window as any).__dragLifeRoutineInfo as
                                | { routineId: string; index: number }
                                | null
                              if (info) {
                                ;(window as any).__dragLifeRoutineInfo = null
                              }
                              const container = event.currentTarget.closest(
                                'li.life-routines-card__task',
                              ) as HTMLElement | null
                              container?.classList.remove('dragging')
                              container?.classList.remove('life-routines-card__task--collapsed')
                              const ghost = lifeRoutineDragCloneRef.current
                              if (ghost && ghost.parentNode) {
                                ghost.parentNode.removeChild(ghost)
                              }
                              lifeRoutineDragCloneRef.current = null
                              setLifeRoutineHoverIndex(null)
                              setLifeRoutineLineTop(null)
                            }}
                          >
                            {isRoutineEditorOpen ? (
                              <div className="life-routines-card__task-editor">
                                {isRenamingRoutine ? (
                                  <input
                                    ref={lifeRoutineRenameInputRef}
                                    value={lifeRoutineRenameDraft}
                                    onChange={(event) => handleLifeRoutineRenameChange(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        submitLifeRoutineRename()
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault()
                                        cancelLifeRoutineRename()
                                      }
                                    }}
                                    onBlur={() => submitLifeRoutineRename()}
                                    className="life-routines-card__task-rename"
                                    placeholder="Rename routine"
                                  />
                                ) : (
                                  <span className="life-routines-card__task-title">
                                    {highlightText(task.title, normalizedSearch)}
                                  </span>
                                )}
                                {isEditingRoutineDescription ? (
                                  <textarea
                                    ref={lifeRoutineDescriptionTextareaRef}
                                    value={lifeRoutineDescriptionDraft}
                                    onChange={(event) => handleLifeRoutineDescriptionChange(event.target.value)}
                                    onKeyDown={(event) => {
                                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                        event.preventDefault()
                                        submitLifeRoutineDescription()
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault()
                                        cancelLifeRoutineDescription()
                                      }
                                    }}
                                    onBlur={() => submitLifeRoutineDescription()}
                                    className="life-routines-card__task-description"
                                    placeholder="Describe the cadence"
                                    rows={3}
                                  />
                                ) : (
                                  <span className="life-routines-card__task-blurb">
                                    {highlightText(task.blurb, normalizedSearch)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="life-routines-card__task-button"
                                onClick={() => toggleLifeRoutineFocusPrompt(task)}
                              >
                                <span className="life-routines-card__task-title">
                                  {highlightText(task.title, normalizedSearch)}
                                </span>
                                <span className="life-routines-card__task-blurb">
                                  {highlightText(task.blurb, normalizedSearch)}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 transition life-routines-card__task-menu-button"
                              aria-haspopup="menu"
                              aria-label="Routine actions"
                              aria-expanded={lifeRoutineMenuOpenId === task.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                const button = event.currentTarget as HTMLButtonElement
                                const isClosing = lifeRoutineMenuOpenId === task.id
                                setLifeRoutineMenuOpenId((current) => {
                                  if (current === task.id) {
                                    lifeRoutineMenuAnchorRef.current = null
                                    return null
                                  }
                                  lifeRoutineMenuAnchorRef.current = button
                                  return task.id
                                })
                                if (!isClosing) {
                                  setLifeRoutineMenuPositionReady(false)
                                }
                              }}
                            >
                              <svg className="w-4.5 h-4.5 goal-kebab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="12" cy="6" r="1.6" />
                                <circle cx="12" cy="12" r="1.6" />
                                <circle cx="12" cy="18" r="1.6" />
                              </svg>
                            </button>
                          </div>
                        </li>
                        {isPromptActive ? (
                          <li
                            className="goal-task-focus-row life-routines-card__focus-row"
                            data-focus-prompt-key={focusKey}
                          >
                            <div className="goal-task-focus">
                              <button
                                type="button"
                                className="goal-task-focus__button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  broadcastScheduleTask({
                                    goalId: LIFE_ROUTINES_GOAL_ID,
                                    goalName: LIFE_ROUTINES_NAME,
                                    bucketId: task.bucketId,
                                    bucketName: task.title,
                                    taskId: task.id,
                                    taskName: task.title,
                                  })
                                  dismissFocusPrompt()
                                }}
                              >
                                Schedule Task
                              </button>
                              <button
                                type="button"
                                className="goal-task-focus__button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleLifeRoutineFocus(task)
                                  dismissFocusPrompt()
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
                </>
              ) : null}
            </section>
          ) : null}

          {hasNoGoals ? (
            <p className="text-white/70 text-sm">No goals yet.</p>
          ) : showNoActiveGoalsNotice ? (
            normalizedSearch ? (
              <p className="text-white/70 text-sm">
                No active goals match “{searchTerm.trim()}”.
                {visibleArchivedGoals.length > 0 ? ' Matches found in Archived Goals below.' : ''}
              </p>
            ) : hasNoActiveGoals ? (
              <p className="text-white/70 text-sm">All goals are archived. Restore one from the section below.</p>
            ) : (
              <p className="text-white/70 text-sm">No active goals right now.</p>
            )
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
                const toIndex = goalHoverIndex ?? visibleActiveGoals.length
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
              {visibleActiveGoals.map((g) => (
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
                    onArchiveBucket={(bucketId) => archiveBucket(g.id, bucketId)}
                    archivedBucketCount={g.buckets.filter((bucket) => bucket.archived).length}
                    onManageArchivedBuckets={() => openArchivedManager(g.id)}
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
                    handleSubtaskBlur={handleSubtaskBlur}
                    handleToggleSubtaskSection={handleToggleSubtaskSection}
                    handleToggleSubtaskCompleted={handleToggleSubtaskCompleted}
                    handleRemoveSubtask={handleRemoveSubtask}
                    onCollapseTaskDetailsForDrag={collapseAllTaskDetailsForDrag}
                    onRestoreTaskDetailsAfterDrag={restoreTaskDetailsAfterDrag}
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
                    revealedDeleteTaskKey={revealedDeleteTaskKey}
                    onRevealDeleteTask={setRevealedDeleteTaskKey}
                    onDeleteCompletedTask={deleteCompletedTask}
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
                    onReorderBuckets={(bucketId, toIndex) => reorderBuckets(g.id, bucketId, toIndex)}
                    onOpenCustomizer={(goalId) => setActiveCustomizerGoalId(goalId)}
                    activeCustomizerGoalId={activeCustomizerGoalId}
                    isStarred={Boolean(g.starred)}
                    onToggleStarred={() => toggleGoalStarred(g.id)}
                    isArchived={g.archived}
                    onArchiveGoal={() => archiveGoal(g.id)}
                    onRestoreGoal={() => restoreGoal(g.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          <section className="goal-archived-section">
            <button
              type="button"
              className={classNames('goal-archived-toggle', archivedGoalsCount === 0 && 'goal-archived-toggle--empty')}
              onClick={() => setShowArchivedGoals((value) => !value)}
              aria-expanded={showArchivedGoals}
            >
              <span className="goal-archived-label">Archived Goals</span>
              <span className="goal-archived-count">{archivedGoalsCount}</span>
              <svg
                className={classNames('goal-archived-chevron', showArchivedGoals && 'goal-archived-chevron--open')}
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M5 9l7 7 7-7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {showArchivedGoals ? (
              archivedGoalsCount === 0 ? (
                <p className="goal-archived-empty text-white/60 text-sm">
                  Archive a goal from the menu to see it here.
                </p>
              ) : visibleArchivedGoals.length === 0 ? (
                <p className="goal-archived-empty text-white/60 text-sm">
                  No archived goals match “{searchTerm.trim()}”.
                </p>
              ) : (
                <ul className="goal-archived-list space-y-3 md:space-y-4">
                  {visibleArchivedGoals.map((g) => (
                    <li key={g.id} className="goal-entry goal-entry--archived" data-goal-id={g.id}>
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
                        onArchiveBucket={(bucketId) => archiveBucket(g.id, bucketId)}
                        archivedBucketCount={g.buckets.filter((bucket) => bucket.archived).length}
                        onManageArchivedBuckets={() => openArchivedManager(g.id)}
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
                        handleSubtaskBlur={handleSubtaskBlur}
                        handleToggleSubtaskSection={handleToggleSubtaskSection}
                        handleToggleSubtaskCompleted={handleToggleSubtaskCompleted}
                        handleRemoveSubtask={handleRemoveSubtask}
                        onCollapseTaskDetailsForDrag={collapseAllTaskDetailsForDrag}
                        onRestoreTaskDetailsAfterDrag={restoreTaskDetailsAfterDrag}
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
                        revealedDeleteTaskKey={revealedDeleteTaskKey}
                        onRevealDeleteTask={setRevealedDeleteTaskKey}
                        onDeleteCompletedTask={deleteCompletedTask}
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
                        onReorderBuckets={(bucketId, toIndex) => reorderBuckets(g.id, bucketId, toIndex)}
                        onOpenCustomizer={(goalId) => setActiveCustomizerGoalId(goalId)}
                        activeCustomizerGoalId={activeCustomizerGoalId}
                        isStarred={Boolean(g.starred)}
                        onToggleStarred={() => toggleGoalStarred(g.id)}
                        isArchived={g.archived}
                        onArchiveGoal={() => archiveGoal(g.id)}
                        onRestoreGoal={() => restoreGoal(g.id)}
                      />
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>

        </div>
      </div>

      <div className="pointer-events-none fixed -z-10 inset-0 opacity-30">
        <div className="absolute -top-24 -left-24 h-72 w-72 bg-fuchsia-500 blur-3xl rounded-full mix-blend-screen" />
        <div className="absolute -bottom-28 -right-24 h-80 w-80 bg-indigo-500 blur-3xl rounded-full mix-blend-screen" />
      </div>

      {lifeRoutineMenuPortal}
      {lifeRoutineCustomizerPortal}
      {customizerPortal}

      {archivedManagerGoal && (
        <div className="goal-modal-backdrop" role="presentation" onClick={closeArchivedManager}>
          <div
            ref={archivedManagerDialogRef}
            className="goal-modal goal-modal--archived"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archived-buckets-title"
            aria-describedby="archived-buckets-description"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="goal-modal__header">
              <h2 id="archived-buckets-title">Archived buckets</h2>
              <p id="archived-buckets-description">
                Restore buckets back to {archivedManagerGoal.name}.
              </p>
            </header>
            <div className="goal-modal__body goal-archive-body">
              {archivedBucketsForManager.length === 0 ? (
                <p className="goal-archive-empty">No archived buckets yet. Archive one from the Task Bank menu to see it here.</p>
              ) : (
                <ul className="goal-archive-list">
                  {archivedBucketsForManager.map((bucket) => {
                    const activeTasks = bucket.tasks.filter((task) => !task.completed).length
                    const completedTasks = bucket.tasks.filter((task) => task.completed).length
                    return (
                      <li key={bucket.id} className="goal-archive-item">
                        <div className="goal-archive-info">
                          <p className="goal-archive-name">{bucket.name}</p>
                          <p className="goal-archive-meta">
                            {activeTasks} active · {completedTasks} completed
                          </p>
                        </div>
                        <div className="goal-archive-actions">
                          <button
                            type="button"
                            className="goal-archive-restore"
                            onClick={() => unarchiveBucket(archivedManagerGoal.id, bucket.id)}
                          >
                            Restore
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <footer className="goal-modal__footer">
              <button type="button" className="goal-modal__button goal-modal__button--muted" onClick={closeArchivedManager}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}

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
