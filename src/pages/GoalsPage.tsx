import React, { useState, useRef, useEffect, type ReactElement } from 'react'
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
  minutes: number
  weeklyTarget: number
}

// Default data
const DEFAULT_GOALS: Goal[] = [
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
    minutes: 420, // 7h
    weeklyTarget: 720, // 12h
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
    minutes: 180, // 3h
    weeklyTarget: 300, // 5h
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
    minutes: 210, // 3.5h
    weeklyTarget: 360, // 6h
  },
]

const GOAL_GRADIENTS = [
  'from-fuchsia-500 to-purple-500',
  'from-emerald-500 to-cyan-500',
  'from-lime-400 to-emerald-500',
  'from-sky-500 to-indigo-500',
  'from-amber-400 to-orange-500',
]

const GOAL_GRADIENT_PREVIEW: Record<string, string> = {
  'from-fuchsia-500 to-purple-500': 'linear-gradient(135deg, #f471b5 0%, #a855f7 50%, #6b21a8 100%)',
  'from-emerald-500 to-cyan-500': 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  'from-lime-400 to-emerald-500': 'linear-gradient(135deg, #bef264 0%, #4ade80 45%, #22c55e 100%)',
  'from-sky-500 to-indigo-500': 'linear-gradient(135deg, #38bdf8 0%, #60a5fa 50%, #6366f1 100%)',
  'from-amber-400 to-orange-500': 'linear-gradient(135deg, #fbbf24 0%, #fb923c 45%, #f97316 100%)',
}

// Components
const ThinProgress: React.FC<{ value: number; gradient: string }> = ({ value, gradient }) => (
  <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
    <div
      className={classNames('h-full rounded-full bg-gradient-to-r goal-progress-fill', gradient)}
      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
    />
  </div>
)

function formatHours(mins: number) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}.${String(Math.round((m / 60) * 10)).padStart(1, '0')}` : String(h)
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
}) => {
  const pct = Math.min(100, Math.round((goal.minutes / Math.max(1, goal.weeklyTarget)) * 100))
  const right = `${formatHours(goal.minutes)} / ${formatHours(goal.weeklyTarget)} h`
  return (
    <div className="rounded-2xl bg-white/5 hover:bg-white/10 transition border border-white/5">
      <button onClick={onToggle} className="w-full text-left p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base md:text-lg font-semibold tracking-tight break-words">
            {highlightText(goal.name, highlightTerm)}
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/80">{right}</span>
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
              <h4 className="text-sm font-medium text-white/90">Task Bank</h4>
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
                          <p className="text-xs uppercase tracking-wide text-white/50">Tasks</p>
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
                          <ul className="mt-2 space-y-2">
                            {activeTasks.map((task) => (
                              <li key={task.id} className="goal-task-row">
                                <button
                                  type="button"
                                  className="goal-task-marker goal-task-marker--action"
                                  onClick={() => onToggleTaskComplete(b.id, task.id)}
                                  aria-label="Mark task complete"
                                />
                                <span className="goal-task-text">{highlightText(task.text, highlightTerm)}</span>
                              </li>
                            ))}
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
                              <ul className="goal-completed__list">
                                {completedTasks.map((task) => (
                                  <li key={task.id} className="goal-task-row goal-task-row--completed">
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
                                    <span className="goal-task-text">{highlightText(task.text, highlightTerm)}</span>
                                  </li>
                                ))}
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
  const [isCreateGoalOpen, setIsCreateGoalOpen] = useState(false)
  const [goalNameInput, setGoalNameInput] = useState('')
  const [selectedGoalGradient, setSelectedGoalGradient] = useState(GOAL_GRADIENTS[0])
  const goalModalInputRef = useRef<HTMLInputElement | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [nextGoalGradientIndex, setNextGoalGradientIndex] = useState(() => DEFAULT_GOALS.length % GOAL_GRADIENTS.length)
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
    const newGoal: Goal = {
      id: newGoalId,
      name: trimmed,
      color: selectedGoalGradient,
      buckets: [],
      minutes: 0,
      weeklyTarget: 60,
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

    const newTask: TaskItem = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: trimmed, completed: false }

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
                {GOAL_GRADIENTS.map((gradient) => {
                  const isActive = gradient === selectedGoalGradient
                  return (
                    <button
                      key={gradient}
                      type="button"
                      className={classNames('goal-gradient-option', isActive && 'goal-gradient-option--active')}
                      aria-pressed={isActive}
                      onClick={() => setSelectedGoalGradient(gradient)}
                      aria-label={`Select gradient ${gradient}`}
                    >
                      <span
                        className="goal-gradient-swatch"
                        style={{ background: GOAL_GRADIENT_PREVIEW[gradient] }}
                      />
                    </button>
                  )
                })}
              </div>
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
