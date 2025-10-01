import React, { useState, useEffect, type ReactElement } from 'react'
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
  suggestions: string[]
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
      { id: 'b1', name: 'Coding', favorite: true, suggestions: ['Chest spawn logic', 'XP scaling', 'Reward tuning'] },
      { id: 'b2', name: 'Testing', favorite: true, suggestions: ['Challenge balance', 'FPS hitches'] },
      { id: 'b3', name: 'Art/Polish', favorite: false, suggestions: ['Shop UI polish', 'Icon pass'] },
    ],
    minutes: 420, // 7h
    weeklyTarget: 720, // 12h
  },
  {
    id: 'g2',
    name: 'Learn Japanese',
    color: 'from-emerald-500 to-cyan-500',
    buckets: [
      { id: 'b4', name: 'Flashcards', favorite: true, suggestions: ['N5 verbs', 'Kana speed run'] },
      { id: 'b5', name: 'Listening', favorite: true, suggestions: ['NHK Easy', 'Anime w/ JP subs'] },
      { id: 'b6', name: 'Speaking', favorite: false, suggestions: ['HelloTalk 10m', 'Shadowing'] },
    ],
    minutes: 180, // 3h
    weeklyTarget: 300, // 5h
  },
  {
    id: 'g3',
    name: 'Stay Fit',
    color: 'from-lime-400 to-emerald-500',
    buckets: [
      { id: 'b7', name: 'Gym', favorite: true, suggestions: ['Push day', 'Stretch 5m'] },
      { id: 'b8', name: 'Cooking', favorite: true, suggestions: ['Prep lunches', 'Protein bowl'] },
      { id: 'b9', name: 'Sleep', favorite: true, suggestions: ['Lights out 11pm'] },
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
  onAddBucket: () => void
  onAddSuggestion: (bucketId: string) => void
  onToggleBucketFavorite: (bucketId: string) => void
}

const GoalRow: React.FC<GoalRowProps> = ({ goal, isOpen, onToggle, onAddBucket, onAddSuggestion, onToggleBucketFavorite }) => {
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
                <span className="text-xs px-2 py-1 rounded-full bg-white/10">💡 {goal.buckets.reduce((a, b) => a + b.suggestions.length, 0)}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-white/60">Buckets surface in Stopwatch when <span className="text-white">Favourited</span>.</p>
              <button onClick={onAddBucket} className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">+ Add Bucket</button>
            </div>

            <ul className="mt-3 md:mt-4 space-y-2">
              {goal.buckets.map((b) => (
                <li key={b.id} className="rounded-xl border border-white/10 bg-white/5">
                  <div className="p-3 md:p-4 flex flex-col md:flex-row md:items-start justify-between gap-3 md:gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onToggleBucketFavorite(b.id)}
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
                        <span className="font-medium truncate">{b.name}</span>
                      </div>
                      {b.suggestions.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs uppercase tracking-wide text-white/50">Suggestions</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {b.suggestions.map((s, i) => (
                              <span key={i} className="text-xs px-2 py-1 rounded-full bg-white/10 text-white/90 border border-white/10">
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 md:shrink-0">
                      <button onClick={() => onAddSuggestion(b.id)} className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">
                        + Suggestion
                      </button>
                      <button
                        onClick={() => onToggleBucketFavorite(b.id)}
                        className={classNames('text-xs px-3 py-1.5 rounded-lg', b.favorite ? 'bg-white text-gray-900' : 'bg-white/10 hover:bg-white/20')}
                        title="Toggle favourite (shown in Stopwatch)"
                      >
                        {b.favorite ? 'Unfavourite' : 'Favourite'}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

export default function GoalsPage(): ReactElement {
  const [goals, setGoals] = useState(DEFAULT_GOALS)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const firstGoalId = DEFAULT_GOALS[0]?.id
    return firstGoalId ? { [firstGoalId]: true } : {}
  })
  const [hasAutoOpenedFirst, setHasAutoOpenedFirst] = useState(() => Boolean(DEFAULT_GOALS[0]))

  useEffect(() => {
    if (hasAutoOpenedFirst) {
      return
    }
    if (goals.length === 0) {
      return
    }

    const firstGoalId = goals[0]?.id
    if (!firstGoalId) {
      return
    }

    setExpanded((current) => {
      if (current[firstGoalId]) {
        return current
      }
      return { ...current, [firstGoalId]: true }
    })
    setHasAutoOpenedFirst(true)
  }, [goals, hasAutoOpenedFirst])

  const toggleExpand = (goalId: string) => {
    setExpanded((e) => ({ ...e, [goalId]: !e[goalId] }))
  }

  const addBucket = (goalId: string) => {
    const name = prompt('New bucket name (e.g., “Testing”, “Gym”)?')
    if (!name) return
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? { ...g, buckets: [...g.buckets, { id: `b_${Date.now()}`, name, favorite: true, suggestions: [] }] }
          : g
      )
    )
  }

  const addSuggestion = (goalId: string, bucketId: string) => {
    const text = prompt('Quick suggestion (15–60 min action)')
    if (!text) return
    setGoals((gs) =>
      gs.map((g) =>
        g.id === goalId
          ? { ...g, buckets: g.buckets.map((b) => (b.id === bucketId ? { ...b, suggestions: [...b.suggestions, text] } : b)) }
          : g
      )
    )
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
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Goals</h1>
            <p className="text-white/70 mt-1">
              Sleek rows with thin progress bars. Expand a goal to see Task Bank. Add buckets and quick suggestions inside.
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
                  onAddBucket={() => addBucket(g.id)}
                  onAddSuggestion={(bucketId) => addSuggestion(g.id, bucketId)}
                  onToggleBucketFavorite={(bucketId) => toggleBucketFavorite(g.id, bucketId)}
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
