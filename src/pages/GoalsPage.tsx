import React, { useState, useRef, useEffect, useMemo, type ReactElement } from 'react'
import './GoalsPage.css'

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
const ThinProgress: React.FC<{ value: number; gradient: string }> = ({ value, gradient }) => {
  const isCustomGradient = gradient.startsWith('custom:')
  const customGradientValue = isCustomGradient ? gradient.slice(7) : undefined
  return (
    <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
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
}

const GoalRow: React.FC<GoalRowProps> = ({
  goal,
  isOpen,
  onToggle,
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
  onTaskEditSubmit,
  onTaskEditBlur,
  onTaskEditCancel,
  registerTaskEditRef,
  onReorderTasks,
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

  const truncateForDrag = (text: string, maxChars = 96) => {
    const trimmed = text.trim()
    if (trimmed.length <= maxChars) return trimmed
    return trimmed.slice(0, Math.max(0, maxChars - 1)) + '…'
  }

  const toOpaqueColor = (color: string, fallbackDark = '#1f2743', fallbackLight = '#e8eeff') => {
    const c = color.trim().toLowerCase()
    if (c === 'transparent' || c === 'initial' || c === 'inherit' || c === '') {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light'
      return isLight ? fallbackLight : fallbackDark
    }
    const rgbaMatch = c.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/)
    const rgbMatch = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
    if (rgbaMatch) {
      const r = Number(rgbaMatch[1])
      const g = Number(rgbaMatch[2])
      const b = Number(rgbaMatch[3])
      return `rgb(${r}, ${g}, ${b})`
    }
    if (rgbMatch) {
      return color
    }
    // Fallback for hex or named colors: assume already opaque
    return color
  }

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

  // Copy key visual styles so the drag clone matches the row appearance (colors, gradients, shadows)
  const copyVisualStyles = (src: HTMLElement, dst: HTMLElement) => {
    const cs = window.getComputedStyle(src)
    // Backgrounds
    dst.style.backgroundColor = toOpaqueColor(cs.backgroundColor)
    dst.style.backgroundImage = cs.backgroundImage
    dst.style.backgroundSize = cs.backgroundSize
    dst.style.backgroundPosition = cs.backgroundPosition
    dst.style.backgroundRepeat = cs.backgroundRepeat
    // Borders / radius
    dst.style.borderColor = cs.borderColor
    dst.style.borderWidth = cs.borderWidth
    dst.style.borderStyle = cs.borderStyle
    dst.style.borderRadius = cs.borderRadius
    // Shadows / outline
    dst.style.boxShadow = cs.boxShadow
    dst.style.outline = cs.outline
    // Typography color
    dst.style.color = cs.color
    // Ensure fully opaque rendering
    dst.style.opacity = '1'
    dst.style.filter = 'none'
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
    let top = 0
    if (candidates.length === 0 || index <= 0) {
      top = candidates.length > 0 ? candidates[0].getBoundingClientRect().top - listRect.top : 0
    } else if (index >= candidates.length) {
      const last = candidates[candidates.length - 1]
      top = last.getBoundingClientRect().bottom - listRect.top
    } else {
      const prev = candidates[index - 1]
      const next = candidates[index]
      const a = prev.getBoundingClientRect()
      const b = next.getBoundingClientRect()
      top = a.bottom + (b.top - a.bottom) / 2 - listRect.top
    }
    return { index, top }
  }
  const totalTasks = goal.buckets.reduce((acc, bucket) => acc + bucket.tasks.length, 0)
  const completedTasksCount = goal.buckets.reduce(
    (acc, bucket) => acc + bucket.tasks.filter((task) => task.completed).length,
    0,
  )
  const pct = totalTasks === 0 ? 0 : Math.round((completedTasksCount / totalTasks) * 100)
  const progressLabel = totalTasks > 0 ? `${completedTasksCount} / ${totalTasks} tasks` : 'No tasks yet'
  return (
    <div className="rounded-2xl bg-white/5 hover:bg-white/10 transition border border-white/5">
      <button onClick={onToggle} className="w-full text-left p-4 md:p-5">
        <div className="flex flex-nowrap items-center justify-between gap-2">
          <h3 className="min-w-0 flex-1 whitespace-nowrap truncate text-sm sm:text-base md:text-lg font-semibold tracking-tight">
            {highlightText(goal.name, highlightTerm)}
          </h3>
          <div className="flex items-center gap-3 flex-none whitespace-nowrap">
            <span className="text-xs sm:text-sm text-white/80">{progressLabel}</span>
            <svg className={classNames('w-4 h-4 text-white/70 transition-transform', isOpen && 'rotate-90')} viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M8.47 4.97a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L13.94 12 8.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd"/>
            </svg>
          </div>
        </div>
        <div className="mt-3">
          <ThinProgress value={pct} gradient={goal.color} />
        </div>
      </button>

      {isOpen && (
        <div className="px-4 md:px-5 pb-4 md:pb-5">
          <div className="mt-3 md:mt-4">
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h4 className="goal-subheading">Task Bank</h4>
              <button onClick={() => onStartBucketDraft(goal.id)} className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 whitespace-nowrap">+ Add Bucket</button>
            </div>

            <p className="mt-2 text-xs text-white/60">Buckets surface in Stopwatch when <span className="text-white">Favourited</span>.</p>

            <ul className="mt-3 md:mt-4 space-y-2">
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
              {goal.buckets.map((b) => {
                const isBucketOpen = bucketExpanded[b.id] ?? false
                const activeTasks = b.tasks.filter((task) => !task.completed)
                const completedTasks = b.tasks.filter((task) => task.completed)
                const isCompletedCollapsed = completedCollapsed[b.id] ?? true
                const draftValue = taskDrafts[b.id]
                return (
                  <li key={b.id} className="rounded-xl border border-white/10 bg-white/5">
                    <div
                      className="goal-bucket-toggle p-3 md:p-4 flex items-center justify-between gap-3 md:gap-4"
                      role="button"
                      tabIndex={0}
                      onClick={() => onToggleBucketExpanded(b.id)}
                      onKeyDown={(event) => {
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
                        <span className="goal-bucket-title font-medium truncate">{highlightText(b.name, highlightTerm)}</span>
                      </div>
                      <svg
                        className={classNames('w-3.5 h-3.5 text-white/80 transition-transform', isBucketOpen && 'rotate-90')}
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path fillRule="evenodd" d="M8.47 4.97a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L13.94 12 8.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
                      </svg>
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
                              const showAbove =
                                dragHover &&
                                dragHover.bucketId === b.id &&
                                dragHover.section === 'active' &&
                                dragHover.index === index
                              return (
                                <React.Fragment key={`${task.id}-wrap`}>
                                  {/* placeholder suppressed; line is rendered absolutely */}
                                  <li
                                    key={task.id}
                                    className={classNames('goal-task-row', diffClass, isEditing && 'goal-task-row--draft')}
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
                                    onClick={() => onToggleTaskComplete(b.id, task.id)}
                                    aria-label="Mark task complete"
                                  />
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
                                  const showAbove =
                                    dragHover &&
                                    dragHover.bucketId === b.id &&
                                    dragHover.section === 'completed' &&
                                    dragHover.index === cIndex
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
  const previousExpandedRef = useRef<Record<string, boolean> | null>(null)
  const previousBucketExpandedRef = useRef<Record<string, boolean> | null>(null)
  const previousCompletedCollapsedRef = useRef<Record<string, boolean> | null>(null)
  const expandedRef = useRef(expanded)
  const bucketExpandedRef = useRef(bucketExpanded)
  const completedCollapsedRef = useRef(completedCollapsed)

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

    const newBucketId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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

    const newGoalId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const gradientForGoal = selectedGoalGradient === 'custom' ? `custom:${customGradientPreview}` : selectedGoalGradient

    const newGoal: Goal = {
      id: newGoalId,
      name: trimmed,
      color: gradientForGoal,
      buckets: [],
    }

    setGoals((current) => [newGoal, ...current])
    setExpanded((current) => ({ ...current, [newGoalId]: true }))

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

    const newTask: TaskItem = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: trimmed, completed: false, difficulty: 'none' }

    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((bucket) =>
                bucket.id === bucketId ? { ...bucket, tasks: [newTask, ...bucket.tasks] } : bucket,
              ),
            }
          : g,
      ),
    )

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
                      const updatedTasks = bucket.tasks.map((task) =>
                        task.id === taskId ? { ...task, completed: !task.completed } : task,
                      )
                      completedCountAfter = updatedTasks.filter((task) => task.completed).length
                      return { ...bucket, tasks: updatedTasks }
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
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((b) =>
                b.id === bucketId
                  ? { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, difficulty: nextOf(t.difficulty) } : t)) }
                  : b,
              ),
            }
          : g,
      ),
    )
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
    const len = (node.textContent ?? '').length
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
  }

  // Reorder tasks within a bucket section (active or completed), similar to Google Tasks
  const reorderTasks = (
    goalId: string,
    bucketId: string,
    section: 'active' | 'completed',
    fromIndex: number,
    toIndex: number,
  ) => {
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
            <div className="space-y-3 md:space-y-4">
              {visibleGoals.map((g) => (
                <GoalRow
                  key={g.id}
                  goal={g}
                  isOpen={expanded[g.id] ?? false}
                  onToggle={() => toggleExpand(g.id)}
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
                />
              ))}
            </div>
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
