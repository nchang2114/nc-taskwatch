import React, { useState, useRef, useEffect, useMemo, type ReactElement } from 'react'
import './GoalsPage.css'
import {
  fetchGoalsHierarchy,
  createGoal as apiCreateGoal,
  renameGoal as apiRenameGoal,
  createBucket as apiCreateBucket,
  renameBucket as apiRenameBucket,
  setBucketFavorite as apiSetBucketFavorite,
  deleteBucketById as apiDeleteBucketById,
  deleteCompletedTasksInBucket as apiDeleteCompletedTasksInBucket,
  createTask as apiCreateTask,
  updateTaskText as apiUpdateTaskText,
  setTaskDifficulty as apiSetTaskDifficulty,
  setTaskCompletedAndResort as apiSetTaskCompletedAndResort,
  setTaskSortIndex as apiSetTaskSortIndex,
  setBucketSortIndex as apiSetBucketSortIndex,
  setGoalSortIndex as apiSetGoalSortIndex,
} from '../lib/goalsApi'

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
interface TaskItem {
  id: string
  text: string
  completed: boolean
  difficulty?: 'none' | 'green' | 'yellow' | 'red'
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

interface Bucket {
  id: string
  name: string
  favorite: boolean
  tasks: TaskItem[]
}

interface Goal {
  id: string
  name: string
  color: string
  buckets: Bucket[]
}

// Default data
const DEFAULT_GOALS: Goal[] = [
  {
    id: 'g_demo',
    name: 'Project X – End-to-end Demo',
    color: 'from-sky-500 to-indigo-500',
    buckets: [
      {
        id: 'b_demo_1',
        name: 'Planning',
        favorite: true,
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
        tasks: [],
      },
    ],
  },
  {
    id: 'g1',
    name: 'Finish PopDot Beta',
    color: 'from-fuchsia-500 to-purple-500',
    buckets: [
      {
        id: 'b1',
        name: 'Coding',
        favorite: true,
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
        tasks: [
          { id: 't4', text: 'Challenge balance', completed: false },
          { id: 't5', text: 'FPS hitches', completed: false },
        ],
      },
      {
        id: 'b3',
        name: 'Art/Polish',
        favorite: false,
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
    buckets: [
      {
        id: 'b4',
        name: 'Flashcards',
        favorite: true,
        tasks: [
          { id: 't8', text: 'N5 verbs', completed: false },
          { id: 't9', text: 'Kana speed run', completed: false },
        ],
      },
      {
        id: 'b5',
        name: 'Listening',
        favorite: true,
        tasks: [
          { id: 't10', text: 'NHK Easy', completed: false },
          { id: 't11', text: 'Anime w/ JP subs', completed: false },
        ],
      },
      {
        id: 'b6',
        name: 'Speaking',
        favorite: false,
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
    buckets: [
      {
        id: 'b7',
        name: 'Gym',
        favorite: true,
        tasks: [
          { id: 't14', text: 'Push day', completed: false },
          { id: 't15', text: 'Stretch 5m', completed: false },
        ],
      },
      {
        id: 'b8',
        name: 'Cooking',
        favorite: true,
        tasks: [
          { id: 't16', text: 'Prep lunches', completed: false },
          { id: 't17', text: 'Protein bowl', completed: false },
        ],
      },
      {
        id: 'b9',
        name: 'Sleep',
        favorite: true,
        tasks: [
          { id: 't18', text: 'Lights out 11pm', completed: false },
        ],
      },
    ],
  },
]

const GOAL_GRADIENTS = [
  'from-fuchsia-500 to-purple-500',
  'from-emerald-500 to-cyan-500',
  'from-lime-400 to-emerald-500',
  'from-sky-500 to-indigo-500',
  'from-amber-400 to-orange-500',
]

const BASE_GRADIENT_PREVIEW: Record<string, string> = {
  'from-fuchsia-500 to-purple-500': 'linear-gradient(135deg, #f471b5 0%, #a855f7 50%, #6b21a8 100%)',
  'from-emerald-500 to-cyan-500': 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  'from-lime-400 to-emerald-500': 'linear-gradient(135deg, #bef264 0%, #4ade80 45%, #22c55e 100%)',
  'from-sky-500 to-indigo-500': 'linear-gradient(135deg, #38bdf8 0%, #60a5fa 50%, #6366f1 100%)',
  'from-amber-400 to-orange-500': 'linear-gradient(135deg, #fbbf24 0%, #fb923c 45%, #f97316 100%)',
}

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

interface GoalRowProps {
  goal: Goal
  isOpen: boolean
  onToggle: () => void
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
  bucketExpanded: Record<string, boolean>
  onToggleBucketExpanded: (bucketId: string) => void
  completedCollapsed: Record<string, boolean>
  onToggleCompletedCollapsed: (bucketId: string) => void
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
  // Editing existing task text
  editingTasks: Record<string, string>
  onStartTaskEdit: (goalId: string, bucketId: string, taskId: string, initial: string) => void
  onTaskEditChange: (taskId: string, value: string) => void
  onTaskEditSubmit: (goalId: string, bucketId: string, taskId: string) => void
  onTaskEditBlur: (goalId: string, bucketId: string, taskId: string) => void
  onTaskEditCancel: (taskId: string) => void
  registerTaskEditRef: (taskId: string, element: HTMLSpanElement | null) => void
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
}

const GoalRow: React.FC<GoalRowProps> = ({
  goal,
  isOpen,
  onToggle,
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
  bucketExpanded,
  onToggleBucketExpanded,
  completedCollapsed,
  onToggleCompletedCollapsed,
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
  editingTasks,
  onStartTaskEdit,
  onTaskEditChange,
  onTaskEditBlur,
  registerTaskEditRef,
  onReorderTasks,
  onReorderBuckets,
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

    const rowCS = window.getComputedStyle(src)
    const cardEl = src.closest('.rounded-2xl') as HTMLElement | null
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
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const bucketRenameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      const withinWrap = menuWrapRef.current && target instanceof Node && menuWrapRef.current.contains(target)
      if (withinWrap) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Do not close if clicking inside any bucket menu/button wrapper
      if (target && target.closest('[data-bucket-menu="true"]')) return
      setBucketMenuOpenId(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

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

  return (
    <div className="rounded-2xl bg-white/5 hover:bg-white/10 transition border border-white/5">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          if (target && (target.closest('input, textarea, [contenteditable="true"]'))) {
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
          const srcCard = (container?.querySelector('.rounded-2xl') as HTMLElement | null) ?? headerEl
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
            )
          })()}
          <div ref={menuWrapRef} className="relative flex items-center gap-2 flex-none whitespace-nowrap" data-goal-menu="true">
            <svg className={classNames('w-4 h-4 goal-chevron-icon transition-transform', isOpen && 'rotate-90')} viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M8.47 4.97a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L13.94 12 8.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd"/>
            </svg>
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
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
            {menuOpen && (
              <div ref={menuRef} className="goal-menu absolute right-0 top-8 z-10 min-w-[140px] rounded-md border p-1 shadow-lg">
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
              </div>
            )}
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
                return (
                  <li key={b.id} className="goal-bucket-item rounded-xl border border-white/10 bg-white/5">
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
                      <div className="relative flex items-center gap-2" data-bucket-menu="true">
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
                          onClick={(e) => {
                            e.stopPropagation()
                            setBucketMenuOpenId((cur) => (cur === b.id ? null : b.id))
                          }}
                          aria-expanded={bucketMenuOpenId === b.id}
                        >
                          <svg className="w-4.5 h-4.5 goal-kebab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <circle cx="12" cy="6" r="1.6" />
                            <circle cx="12" cy="12" r="1.6" />
                            <circle cx="12" cy="18" r="1.6" />
                          </svg>
                        </button>
                        {bucketMenuOpenId === b.id && (
                          <div ref={bucketMenuRef} className="goal-menu absolute right-0 top-8 z-10 min-w-[180px] rounded-md border p-1 shadow-lg">
                            <button
                              type="button"
                              className="goal-menu__item"
                              onClick={(e) => {
                                e.stopPropagation()
                                setBucketMenuOpenId(null)
                                onStartBucketRename(goal.id, b.id, b.name)
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              disabled={completedTasks.length === 0}
                              aria-disabled={completedTasks.length === 0}
                              className={classNames('goal-menu__item', completedTasks.length === 0 && 'opacity-50 cursor-not-allowed')}
                              onClick={(e) => {
                                if (completedTasks.length === 0) return
                                e.stopPropagation()
                                setBucketMenuOpenId(null)
                                onDeleteCompletedTasks(b.id)
                              }}
                            >
                              Delete all completed tasks
                            </button>
                            <div className="goal-menu__divider" />
                            <button
                              type="button"
                              className="goal-menu__item goal-menu__item--danger"
                              onClick={(e) => {
                                e.stopPropagation()
                                setBucketMenuOpenId(null)
                                onDeleteBucket(b.id)
                              }}
                            >
                              Delete bucket
                            </button>
                          </div>
                        )}
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
                              
                              return (
                                <React.Fragment key={`${task.id}-wrap`}>
                                  {/* placeholder suppressed; line is rendered absolutely */}
                                  <li
                                    key={task.id}
                                    className={classNames(
                                      'goal-task-row',
                                      diffClass,
                                      isEditing && 'goal-task-row--draft',
                                      completingMap[completingKey(b.id, task.id)] && 'goal-task-row--completing',
                                    )}
                                    draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData('text/plain', task.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                    const row = e.currentTarget as HTMLElement
                                    row.classList.add('dragging')
                                    // Clone current row as drag image, keep it in DOM until drag ends
                                    const clone = row.cloneNode(true) as HTMLElement
                                    // Use dedicated clone class; we copy computed styles for colors/borders
                                    clone.className = 'goal-drag-clone'
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
                                  <button
                                    type="button"
                                    className="goal-task-marker goal-task-marker--action"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const key = completingKey(b.id, task.id)
                                      if (completingMap[key]) return
                                      setCompletingMap((prev) => ({ ...prev, [key]: true }))
                                      // Play animation, then commit completion toggle
                                      window.setTimeout(() => {
                                        onToggleTaskComplete(b.id, task.id)
                                        setCompletingMap((prev) => {
                                          const next = { ...prev }
                                          delete next[key]
                                          return next
                                        })
                                      }, 1200)
                                    }}
                                    aria-label="Mark task complete"
                                  >
                                    <svg viewBox="0 0 24 24" className="goal-task-check" aria-hidden="true">
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
                                        onStartTaskEdit(goal.id, b.id, task.id, task.text)
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
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onCycleTaskDifficulty(b.id, task.id)
                                    }}
                                    aria-label="Set task difficulty"
                                    title="Difficulty: none → green → yellow → red"
                                  />
                                </li>
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
                                  
                                  return (
                                    <React.Fragment key={`${task.id}-cwrap`}>
                                      {/* placeholder suppressed; line is rendered absolutely */}
                                      <li
                                        key={task.id}
                                        className={classNames('goal-task-row goal-task-row--completed', diffClass, isEditing && 'goal-task-row--draft')}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.setData('text/plain', task.id)
                                          e.dataTransfer.effectAllowed = 'move'
                                          const row = e.currentTarget as HTMLElement
                                          row.classList.add('dragging')
                                          const clone = row.cloneNode(true) as HTMLElement
                                          clone.className = 'goal-drag-clone'
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
                                      <button
                                        type="button"
                                        className="goal-task-marker goal-task-marker--completed"
                                        onClick={() => onToggleTaskComplete(b.id, task.id)}
                                        aria-label="Mark task incomplete"
                                      >
                                        <svg viewBox="0 0 24 24" className="goal-task-check" aria-hidden="true">
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
                                            onStartTaskEdit(goal.id, b.id, task.id, task.text)
                                          }}
                                          aria-label="Edit task text"
                                        >
                                          {highlightText(task.text, highlightTerm)}
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
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          onCycleTaskDifficulty(b.id, task.id)
                                        }}
                                        aria-label="Set task difficulty"
                                        title="Difficulty: none → green → yellow → red"
                                      />
                                      </li>
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
    </div>
  )
}

export default function GoalsPage(): ReactElement {
  const [goals, setGoals] = useState(DEFAULT_GOALS)
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
  const [isCreateGoalOpen, setIsCreateGoalOpen] = useState(false)
  const [goalNameInput, setGoalNameInput] = useState('')
  const [selectedGoalGradient, setSelectedGoalGradient] = useState(GOAL_GRADIENTS[0])
  const [customGradient, setCustomGradient] = useState({ start: '#6366f1', end: '#ec4899', angle: 135 })
  const goalModalInputRef = useRef<HTMLInputElement | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [nextGoalGradientIndex, setNextGoalGradientIndex] = useState(() => DEFAULT_GOALS.length % GOAL_GRADIENTS.length)
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
  // On first load, attempt to hydrate from Supabase (single-user session).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await fetchGoalsHierarchy()
        if (!cancelled && result && Array.isArray(result.goals)) {
          setGoals(result.goals as any)
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
  const expandedRef = useRef(expanded)
  const bucketExpandedRef = useRef(bucketExpanded)
  const completedCollapsedRef = useRef(completedCollapsed)

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
      [bucketId]: !(current[bucketId] ?? true),
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
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, tasks: [] }
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
        setBucketExpanded((current) => ({ ...current, [newBucketId]: false }))
        setCompletedCollapsed((current) => ({ ...current, [newBucketId]: true }))
      })
      .catch(() => {
        const newBucketId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newBucket: Bucket = { id: newBucketId, name: trimmed, favorite: false, tasks: [] }
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
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, buckets: [] }
        setGoals((current) => [newGoal, ...current])
        setExpanded((current) => ({ ...current, [id]: true }))
      })
      .catch(() => {
        const id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newGoal: Goal = { id, name: trimmed, color: gradientForGoal, buckets: [] }
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

    apiCreateTask(bucketId, trimmed)
      .then((db) => {
        const newTask: TaskItem = { id: db?.id ?? `task_${Date.now()}`, text: trimmed, completed: false, difficulty: 'none' }
        setGoals((gs) =>
          gs.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  buckets: g.buckets.map((bucket) => {
                    if (bucket.id !== bucketId) return bucket
                    const active = bucket.tasks.filter((t) => !t.completed)
                    const completed = bucket.tasks.filter((t) => t.completed)
                    // Prepend new task to the top of active section to match DB prepend strategy
                    return { ...bucket, tasks: [newTask, ...active, ...completed] }
                  }),
                }
              : g,
          ),
        )
      })
      .catch(() => {
        const fallback: TaskItem = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: trimmed, completed: false, difficulty: 'none' }
        setGoals((gs) =>
          gs.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  buckets: g.buckets.map((bucket) => {
                    if (bucket.id !== bucketId) return bucket
                    const active = bucket.tasks.filter((t) => !t.completed)
                    const completed = bucket.tasks.filter((t) => t.completed)
                    return { ...bucket, tasks: [fallback, ...active, ...completed] }
                  }),
                }
              : g,
          ),
        )
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

  const toggleTaskCompletion = (goalId: string, bucketId: string, taskId: string) => {
    let updated = false
    let completedCountAfter = 0
    setGoals((gs) =>
      gs.map((goal) =>
        goal.id === goalId
          ? {
              ...goal,
              buckets: goal.buckets.map((bucket) =>
                bucket.id === bucketId
                  ? (() => {
                      updated = true
                      const toggled = bucket.tasks.find((t) => t.id === taskId)
                      const newCompleted = !(toggled?.completed ?? false)
                      const updatedTasks = bucket.tasks.map((task) =>
                        task.id === taskId ? { ...task, completed: newCompleted } : task,
                      )
                      // Move the toggled task to the end of its new section to match DB ordering
                      const active = updatedTasks.filter((t) => !t.completed)
                      const completed = updatedTasks.filter((t) => t.completed)
                      completedCountAfter = completed.length
                      const tasks = newCompleted ? [...active, ...completed] : [...active, ...completed]
                      // Ensure toggled is last in its section
                      if (newCompleted) {
                        const idx = completed.findIndex((t) => t.id === taskId)
                        if (idx !== -1) {
                          const [mv] = completed.splice(idx, 1)
                          completed.push(mv)
                        }
                        return { ...bucket, tasks: [...active, ...completed] }
                      } else {
                        const idx = active.findIndex((t) => t.id === taskId)
                        if (idx !== -1) {
                          const [mv] = active.splice(idx, 1)
                          active.push(mv)
                        }
                        return { ...bucket, tasks: [...active, ...completed] }
                      }
                    })()
                  : bucket,
              ),
            }
          : goal,
      ),
    )

    if (updated) {
      setCompletedCollapsed((current) => ({
        ...current,
        [bucketId]: completedCountAfter > 0 ? false : true,
      }))
    }
    const cur = goals.find((g) => g.id === goalId)?.buckets.find((b) => b.id === bucketId)?.tasks.find((t) => t.id === taskId)
    const newCompleted = !(cur?.completed ?? false)
    apiSetTaskCompletedAndResort(taskId, bucketId, newCompleted).catch(() => {})
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

  const focusTaskEditInput = (taskId: string) => {
    const node = taskEditRefs.current.get(taskId)
    if (!node) return
    node.focus()
    if (typeof window !== 'undefined') {
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        range.selectNodeContents(node)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  const startTaskEdit = (_goalId: string, bucketId: string, taskId: string, initial: string) => {
    setTaskEdits((current) => ({ ...current, [taskId]: initial }))
    // Expand parent bucket to ensure visible
    setBucketExpanded((current) => ({ ...current, [bucketId]: true }))
    if (typeof window !== 'undefined') {
      const scheduleFocus = () => focusTaskEditInput(taskId)
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
    apiSetGoalSortIndex(goalId, toVisibleIndex).catch(() => {})
  }

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
                  bucketExpanded={bucketExpanded}
                  onToggleBucketExpanded={toggleBucketExpanded}
                  completedCollapsed={completedCollapsed}
                  onToggleCompletedCollapsed={toggleCompletedSection}
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
                  editingTasks={taskEdits}
                  onStartTaskEdit={(goalId, bucketId, taskId, initial) => startTaskEdit(goalId, bucketId, taskId, initial)}
                  onTaskEditChange={handleTaskEditChange}
                  onTaskEditSubmit={(goalId, bucketId, taskId) => handleTaskEditSubmit(goalId, bucketId, taskId)}
                  onTaskEditBlur={(goalId, bucketId, taskId) => handleTaskEditBlur(goalId, bucketId, taskId)}
                  onTaskEditCancel={(taskId) => handleTaskEditCancel(taskId)}
                  registerTaskEditRef={registerTaskEditRef}
                    onReorderTasks={(goalId, bucketId, section, fromIndex, toIndex) =>
                      reorderTasks(goalId, bucketId, section, fromIndex, toIndex)
                    }
                    onReorderBuckets={reorderBuckets}
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
