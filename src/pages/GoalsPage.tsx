import React, { useState, useRef, type ReactElement } from 'react'
import './GoalsPage.css'

// Helper function for class names
function classNames(...xs: (string | boolean | undefined)[]): string {
  return xs.filter(Boolean).join(' ')
}

// Type definitions
interface Bucket {
  id: string
  name: string
  favorite: boolean
  tasks: string[]
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
      { id: 'b1', name: 'Coding', favorite: true, tasks: ['Chest spawn logic', 'XP scaling', 'Reward tuning'] },
      { id: 'b2', name: 'Testing', favorite: true, tasks: ['Challenge balance', 'FPS hitches'] },
      { id: 'b3', name: 'Art/Polish', favorite: false, tasks: ['Shop UI polish', 'Icon pass'] },
    ],
    minutes: 420, // 7h
    weeklyTarget: 720, // 12h
  },
  {
    id: 'g2',
    name: 'Learn Japanese',
    color: 'from-emerald-500 to-cyan-500',
    buckets: [
      { id: 'b4', name: 'Flashcards', favorite: true, tasks: ['N5 verbs', 'Kana speed run'] },
      { id: 'b5', name: 'Listening', favorite: true, tasks: ['NHK Easy', 'Anime w/ JP subs'] },
      { id: 'b6', name: 'Speaking', favorite: false, tasks: ['HelloTalk 10m', 'Shadowing'] },
    ],
    minutes: 180, // 3h
    weeklyTarget: 300, // 5h
  },
  {
    id: 'g3',
    name: 'Stay Fit',
    color: 'from-lime-400 to-emerald-500',
    buckets: [
      { id: 'b7', name: 'Gym', favorite: true, tasks: ['Push day', 'Stretch 5m'] },
      { id: 'b8', name: 'Cooking', favorite: true, tasks: ['Prep lunches', 'Protein bowl'] },
      { id: 'b9', name: 'Sleep', favorite: true, tasks: ['Lights out 11pm'] },
    ],
    minutes: 210, // 3.5h
    weeklyTarget: 360, // 6h
  },
]

// Components
const ThinProgress: React.FC<{ value: number; gradient: string }> = ({ value, gradient }) => (
  <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
    <div
      className={classNames('h-full rounded-full bg-gradient-to-r', gradient)}
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
}

const GoalRow: React.FC<GoalRowProps> = ({
  goal,
  isOpen,
  onToggle,
  onToggleBucketFavorite,
  bucketExpanded,
  onToggleBucketExpanded,
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
}) => {
  const pct = Math.min(100, Math.round((goal.minutes / Math.max(1, goal.weeklyTarget)) * 100))
  const right = `${formatHours(goal.minutes)} / ${formatHours(goal.weeklyTarget)} h`
  
  return (
    <div className="rounded-2xl bg-white/5 hover:bg-white/10 transition border border-white/5">
      <button onClick={onToggle} className="w-full text-left p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base md:text-lg font-semibold tracking-tight break-words">{goal.name}</h3>
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
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-white/90">Task Bank</h4>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-1 rounded-full bg-white/10">♥ {goal.buckets.filter(b => b.favorite).length} fav</span>
                <span className="text-xs px-2 py-1 rounded-full bg-white/10">🗒 {goal.buckets.reduce((a, b) => a + b.tasks.length, 0)} tasks</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-white/60">Buckets surface in Stopwatch when <span className="text-white">Favourited</span>.</p>
              <button onClick={() => onStartBucketDraft(goal.id)} className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">+ Add Bucket</button>
            </div>

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
                const isBucketOpen = bucketExpanded[b.id] ?? true
                const taskCount = b.tasks.length
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
                        <span className="goal-bucket-title font-medium truncate">{b.name}</span>
                        {taskCount > 0 && (
                          <span className="text-xs text-white/60">({taskCount})</span>
                        )}
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

                        {taskCount === 0 && draftValue === undefined ? (
                          <p className="goal-task-empty">No tasks yet.</p>
                        ) : (
                          <ul className="mt-2 space-y-2">
                            {b.tasks.map((task, index) => (
                              <li key={index} className="goal-task-row">
                                <span className="goal-task-marker" aria-hidden="true" />
                                <span className="goal-task-text">{task}</span>
                              </li>
                            ))}
                          </ul>
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
  const [bucketDrafts, setBucketDrafts] = useState<Record<string, string>>({})
  const bucketDraftRefs = useRef(new Map<string, HTMLInputElement>())
  const submittingBucketDrafts = useRef(new Set<string>())
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({})
  const taskDraftRefs = useRef(new Map<string, HTMLInputElement>())
  const submittingDrafts = useRef(new Set<string>())

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

    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? {
              ...g,
              buckets: g.buckets.map((bucket) =>
                bucket.id === bucketId ? { ...bucket, tasks: [trimmed, ...bucket.tasks] } : bucket,
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

          {goals.length === 0 ? (
            <p className="text-white/70 text-sm">No goals yet.</p>
          ) : (
            <div className="space-y-3 md:space-y-4">
              {goals.map((g) => (
                <GoalRow
                  key={g.id}
                  goal={g}
                  isOpen={expanded[g.id] ?? false}
                  onToggle={() => toggleExpand(g.id)}
                  onToggleBucketFavorite={(bucketId) => toggleBucketFavorite(g.id, bucketId)}
                  bucketExpanded={bucketExpanded}
                  onToggleBucketExpanded={toggleBucketExpanded}
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
    </div>
  )
}
