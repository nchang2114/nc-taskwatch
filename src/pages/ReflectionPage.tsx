import { useEffect, useMemo, useState } from 'react'
import './ReflectionPage.css'
import { readStoredGoalsSnapshot, subscribeToGoalsSnapshot, type GoalSnapshot } from '../lib/goalsSync'

const MOCK_SUMMARY = [
  { id: 'g1', goal: 'Finish PopDot Beta', gradient: 'gradient-fuchsia-purple', minutes: 420, target: 720 },
  { id: 'g2', goal: 'Learn Japanese', gradient: 'gradient-emerald-cyan', minutes: 180, target: 300 },
  { id: 'g3', goal: 'Stay Fit', gradient: 'gradient-lime-emerald', minutes: 210, target: 360 },
]

const JOURNAL_PROMPTS = [
  "What was today's biggest win?",
  "What drained your energy?",
  "Any blockers you noticed recurring?",
  "What's one small improvement for tomorrow?",
]

type ReflectionRangeKey = '24h' | '48h' | '7d'

type RangeDefinition = {
  label: string
  shortLabel: string
  durationMs: number
}

const RANGE_DEFS: Record<ReflectionRangeKey, RangeDefinition> = {
  '24h': { label: 'Last 24 Hours', shortLabel: '24h', durationMs: 24 * 60 * 60 * 1000 },
  '48h': { label: 'Last 48 Hours', shortLabel: '48h', durationMs: 48 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 Days', shortLabel: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
}

const RANGE_KEYS: ReflectionRangeKey[] = ['24h', '48h', '7d']

type HistoryEntry = {
  id: string
  taskName: string
  elapsed: number
  startedAt: number
  endedAt: number
}

type PieSegment = {
  id: string
  label: string
  durationMs: number
  color: string
  fraction: number
  isUnlogged?: boolean
}

type PieArc = {
  id: string
  color: string
  path: string
}

const HISTORY_STORAGE_KEY = 'nc-taskwatch-history'
const HISTORY_EVENT_NAME = 'nc-taskwatch:history-update'
const CURRENT_SESSION_STORAGE_KEY = 'nc-taskwatch-current-session'
const CURRENT_SESSION_EVENT_NAME = 'nc-taskwatch:session-update'
const UNLABELED_FOCUS_LABEL = 'Unlabeled Focus'
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f97316', '#f472b6', '#a855f7', '#4ade80', '#60a5fa', '#facc15', '#38bdf8', '#fb7185']

type GoalLookup = Map<string, { goalName: string; color?: string }>

const normalizeColor = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('#') ||
    lower.startsWith('rgb(') ||
    lower.startsWith('rgba(') ||
    lower.startsWith('hsl(') ||
    lower.startsWith('hsla(') ||
    lower.startsWith('var(')
  ) {
    return trimmed
  }
  return undefined
}

const sanitizeHistory = (value: unknown): HistoryEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null
      }
      const candidate = entry as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const taskName = typeof candidate.taskName === 'string' ? candidate.taskName : ''
      const elapsed = typeof candidate.elapsed === 'number' ? candidate.elapsed : null
      const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
      const endedAt = typeof candidate.endedAt === 'number' ? candidate.endedAt : null
      if (!id || elapsed === null || startedAt === null || endedAt === null) {
        return null
      }
      return { id, taskName, elapsed, startedAt, endedAt }
    })
    .filter((entry): entry is HistoryEntry => Boolean(entry))
}

const readStoredHistory = (): HistoryEntry[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return sanitizeHistory(parsed)
  } catch {
    return []
  }
}

const formatDuration = (ms: number) => {
  const safeMs = Math.max(0, Math.round(ms))
  const totalMinutes = Math.floor(safeMs / 60000)
  if (totalMinutes <= 0) {
    return '0m'
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  if (remainingHours === 0) {
    return `${days}d`
  }
  return minutes > 0 ? `${days}d ${remainingHours}h` : `${days}d ${remainingHours}h`
}

const hashString = (value: string) => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return hash
}

const getPaletteColorForLabel = (label: string) => {
  const hash = Math.abs(hashString(label))
  const index = hash % CHART_COLORS.length
  return CHART_COLORS[index]
}

const PIE_VIEWBOX_SIZE = 200
const PIE_CENTER = PIE_VIEWBOX_SIZE / 2
const PIE_RADIUS = PIE_VIEWBOX_SIZE / 2 - 2
const PIE_INNER_RADIUS = PIE_RADIUS * 0.56
const ARC_EPSILON = 1e-6

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1)

const polarToCartesian = (cx: number, cy: number, radius: number, angleDeg: number) => {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  }
}

const describeFullDonut = () => {
  const outerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 0)
  const outerOpposite = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 180)
  const innerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, 0)
  const innerOpposite = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, 180)
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${outerOpposite.x} ${outerOpposite.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${outerStart.x} ${outerStart.y}`,
    'Z',
    `M ${innerStart.x} ${innerStart.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 1 0 ${innerOpposite.x} ${innerOpposite.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 1 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

const describeDonutSlice = (startAngle: number, endAngle: number) => {
  const start = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startAngle)
  const end = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, endAngle)
  const innerEnd = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, endAngle)
  const innerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, startAngle)
  const sweepAngle = Math.max(Math.min(endAngle - startAngle, 360), 0)
  if (sweepAngle >= 360 - ARC_EPSILON) {
    return describeFullDonut()
  }
  const largeArcFlag = sweepAngle > 180 ? 1 : 0
  const sweepFlagOuter = 1
  const sweepFlagInner = 0
  return [
    `M ${start.x} ${start.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArcFlag} ${sweepFlagOuter} ${end.x} ${end.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 ${largeArcFlag} ${sweepFlagInner} ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

const createPieArcs = (segments: PieSegment[], windowMs: number): PieArc[] => {
  if (segments.length === 0) {
    return []
  }

  const segmentTotal = segments.reduce((sum, segment) => sum + Math.max(segment.durationMs, 0), 0)
  const denominator = Math.max(windowMs, segmentTotal, 1)
  let accumulated = 0
  const arcs: PieArc[] = []

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const value = Math.max(segment.durationMs, 0)
    if (!Number.isFinite(value) || value <= 0) {
      continue
    }

    const startRatio = clamp01(accumulated / denominator)
    accumulated += value
    let endRatio = index === segments.length - 1 ? 1 : clamp01(accumulated / denominator)
    if (endRatio < startRatio) {
      endRatio = startRatio
    }

    const sweepRatio = endRatio - startRatio
    if (sweepRatio <= ARC_EPSILON) {
      continue
    }

    const startAngle = startRatio * 360
    const endAngle = Math.min(startAngle + sweepRatio * 360, 360)

    arcs.push({
      id: segment.id,
      color: segment.color,
      path: describeDonutSlice(startAngle, endAngle),
    })
  }

  return arcs
}

const FULL_DONUT_PATH = describeFullDonut()

const createGoalTaskMap = (snapshot: GoalSnapshot[]): GoalLookup => {
  const map: GoalLookup = new Map()
  snapshot.forEach((goal) => {
    const goalName = goal.name?.trim()
    if (!goalName) {
      return
    }
    const goalColor = normalizeColor(goal.color)
    goal.buckets.forEach((bucket) => {
      bucket.tasks.forEach((task) => {
        const key = task.text.trim().toLowerCase()
        if (!key || map.has(key)) {
          return
        }
        map.set(key, { goalName, color: goalColor })
      })
    })
  })
  return map
}

type GoalMetadata = {
  label: string
  colorHint?: string
}

type ActiveSessionState = {
  taskName: string
  goalName: string | null
  startedAt: number | null
  baseElapsed: number
  isRunning: boolean
  updatedAt: number
}

const resolveGoalMetadata = (taskName: string, lookup: GoalLookup): GoalMetadata => {
  const trimmed = taskName.trim()
  if (!trimmed) {
    return { label: UNLABELED_FOCUS_LABEL }
  }
  const match = lookup.get(trimmed.toLowerCase())
  if (match) {
    return { label: match.goalName, colorHint: match.color }
  }
  return { label: trimmed }
}

const sanitizeActiveSession = (value: unknown): ActiveSessionState | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const rawTaskName = typeof candidate.taskName === 'string' ? candidate.taskName : ''
  const taskName = rawTaskName.trim()
  const rawGoalName = typeof candidate.goalName === 'string' ? candidate.goalName.trim() : ''
  const goalName = rawGoalName.length > 0 ? rawGoalName : null
  const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
  const baseElapsed = typeof candidate.baseElapsed === 'number' ? Math.max(0, candidate.baseElapsed) : 0
  const isRunning = Boolean(candidate.isRunning)
  const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
  return { taskName, goalName, startedAt, baseElapsed, isRunning, updatedAt }
}

const readStoredActiveSession = (): ActiveSessionState | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    return sanitizeActiveSession(parsed)
  } catch {
    return null
  }
}

const computeRangeOverview = (
  history: HistoryEntry[],
  range: ReflectionRangeKey,
  lookup: GoalLookup,
): { segments: PieSegment[]; windowMs: number; loggedMs: number } => {
  const { durationMs: windowMs } = RANGE_DEFS[range]
  const now = Date.now()
  const windowStart = now - windowMs
  const totals = new Map<
    string,
    {
      durationMs: number
      colorHint?: string
    }
  >()

  history.forEach((entry) => {
    const start = Math.min(entry.startedAt, entry.endedAt)
    const end = Math.max(entry.startedAt, entry.endedAt)
    if (end <= windowStart || start >= now) {
      return
    }
    const clampedStart = Math.max(start, windowStart)
    const clampedEnd = Math.min(end, now)
    const overlapMs = Math.max(0, clampedEnd - clampedStart)
    if (overlapMs <= 0) {
      return
    }
    const metadata = resolveGoalMetadata(entry.taskName, lookup)
    const current = totals.get(metadata.label)
    if (current) {
      current.durationMs += overlapMs
    } else {
      totals.set(metadata.label, { durationMs: overlapMs, colorHint: metadata.colorHint })
    }
  })

  let segments = Array.from(totals.entries()).map(([label, info]) => ({
    label,
    durationMs: info.durationMs,
    colorHint: info.colorHint,
  }))

  segments.sort((a, b) => b.durationMs - a.durationMs)

  let loggedMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0)

  if (loggedMs > windowMs && loggedMs > 0) {
    const scale = windowMs / loggedMs
    segments = segments.map((segment) => ({
      ...segment,
      durationMs: segment.durationMs * scale,
    }))
    loggedMs = windowMs
  }

  const pieSegments: PieSegment[] = segments.map((segment) => {
    const color = segment.colorHint && segment.colorHint.trim().length > 0
      ? segment.colorHint
      : getPaletteColorForLabel(segment.label)
    const slug = segment.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'segment'
    const id = `${slug}-${Math.abs(hashString(segment.label))}`
    return {
      id,
      label: segment.label,
      durationMs: segment.durationMs,
      fraction: Math.min(Math.max(segment.durationMs / windowMs, 0), 1),
      color,
    }
  })

  const loggedMsTotal = pieSegments.reduce((sum, segment) => sum + segment.durationMs, 0)
  const unloggedMs = Math.max(windowMs - loggedMsTotal, 0)

  if (unloggedMs > 0) {
    pieSegments.push({
      id: 'unlogged',
      label: 'Unlogged Time',
      durationMs: unloggedMs,
      fraction: unloggedMs / windowMs,
      color: 'var(--reflection-chart-unlogged)',
      isUnlogged: true,
    })
  }

  return {
    segments: pieSegments,
    windowMs,
    loggedMs: Math.min(loggedMs, windowMs),
  }
}

function ThinProgress({ value, gradient }: { value: number; gradient: string }) {
  return (
    <div className="reflection-progress">
      <div className={`reflection-progress__bar ${gradient}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export default function ReflectionPage() {
  const [activeRange, setActiveRange] = useState<ReflectionRangeKey>('24h')
  const [history, setHistory] = useState<HistoryEntry[]>(() => readStoredHistory())
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => readStoredGoalsSnapshot())
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(() => readStoredActiveSession())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [journal, setJournal] = useState('')

  const goalLookup = useMemo(() => createGoalTaskMap(goalsSnapshot), [goalsSnapshot])
  const enhancedGoalLookup = useMemo(() => {
    if (!activeSession || !activeSession.goalName) {
      return goalLookup
    }
    const key = activeSession.taskName?.trim().toLowerCase()
    const goalName = activeSession.goalName.trim()
    if (!key) {
      return goalLookup
    }
    const existing = goalLookup.get(key)
    if (existing && existing.goalName === goalName) {
      return goalLookup
    }
    const map = new Map(goalLookup)
    map.set(key, { goalName, color: undefined })
    return map
  }, [goalLookup, activeSession])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === HISTORY_STORAGE_KEY) {
        setHistory(readStoredHistory())
        return
      }
      if (event.key === CURRENT_SESSION_STORAGE_KEY) {
        setActiveSession(readStoredActiveSession())
      }
    }
    const handleHistoryBroadcast = (event: Event) => {
      const custom = event as CustomEvent<unknown>
      const detail = sanitizeHistory(custom.detail)
      if (detail.length > 0 || Array.isArray(custom.detail)) {
        setHistory(detail)
      } else {
        setHistory(readStoredHistory())
      }
    }
    const handleSessionBroadcast = (event: Event) => {
      const custom = event as CustomEvent<unknown>
      const detail = sanitizeActiveSession(custom.detail)
      if (detail) {
        setActiveSession(detail)
      } else {
        setActiveSession(readStoredActiveSession())
      }
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    window.addEventListener(CURRENT_SESSION_EVENT_NAME, handleSessionBroadcast as EventListener)

    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
      window.removeEventListener(CURRENT_SESSION_EVENT_NAME, handleSessionBroadcast as EventListener)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToGoalsSnapshot((snapshot) => {
      setGoalsSnapshot(snapshot)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const effectiveHistory = useMemo(() => {
    if (!activeSession) {
      return history
    }
    const now = Date.now()
    const baseElapsed = Math.max(0, activeSession.baseElapsed)
    const runningElapsed =
      activeSession.isRunning && typeof activeSession.startedAt === 'number'
        ? Math.max(0, now - activeSession.startedAt)
        : 0
    const totalElapsed = baseElapsed + runningElapsed
    if (totalElapsed <= 0) {
      return history
    }
    const defaultStart = now - totalElapsed
    const startCandidate =
      typeof activeSession.startedAt === 'number'
        ? activeSession.startedAt
        : activeSession.updatedAt - totalElapsed
    const startedAt = Math.min(startCandidate, now)
    const safeStartedAt = Number.isFinite(startedAt) ? startedAt : defaultStart
    const endedAt = activeSession.isRunning ? now : safeStartedAt + totalElapsed
    const taskLabel =
      activeSession.taskName.length > 0 ? activeSession.taskName : activeSession.goalName ?? UNLABELED_FOCUS_LABEL
    const activeEntry: HistoryEntry = {
      id: 'active-session',
      taskName: taskLabel,
      elapsed: totalElapsed,
      startedAt: safeStartedAt,
      endedAt,
    }
    const filteredHistory = history.filter((entry) => entry.id !== activeEntry.id)
    return [activeEntry, ...filteredHistory]
  }, [history, activeSession, nowTick])

  const { segments, windowMs, loggedMs } = useMemo(
    () => computeRangeOverview(effectiveHistory, activeRange, enhancedGoalLookup),
    [effectiveHistory, activeRange, enhancedGoalLookup, nowTick],
  )
  const activeRangeConfig = RANGE_DEFS[activeRange]
  const loggedSegments = useMemo(() => segments.filter((segment) => !segment.isUnlogged), [segments])
  const unloggedSegment = useMemo(() => segments.find((segment) => segment.isUnlogged), [segments])
  const legendSegments = useMemo(() => {
    const base = loggedSegments.length > 1 ? [...loggedSegments].sort((a, b) => b.durationMs - a.durationMs) : loggedSegments
    if (unloggedSegment && unloggedSegment.durationMs > 0) {
      return [...base, unloggedSegment]
    }
    if (!unloggedSegment && windowMs > loggedMs) {
      return [
        ...base,
        {
          id: 'unlogged',
          label: 'Unlogged Time',
          durationMs: windowMs - loggedMs,
          color: 'var(--reflection-chart-unlogged)',
          isUnlogged: true,
        },
      ]
    }
    return base
  }, [loggedSegments, unloggedSegment, windowMs, loggedMs])
  const pieArcs = useMemo(() => createPieArcs(segments, windowMs), [segments, windowMs])
  const unloggedMs = useMemo(
    () => unloggedSegment?.durationMs ?? Math.max(windowMs - loggedMs, 0),
    [unloggedSegment, windowMs, loggedMs],
  )
  const tabPanelId = 'reflection-range-panel'

  return (
    <section className="site-main__inner reflection-page" aria-label="Reflection">
      <div className="reflection-intro">
        <h1 className="reflection-title">Reflection</h1>
        <p className="reflection-subtitle">Review your progress and capture insights to guide tomorrow.</p>
      </div>

      <section className="reflection-section reflection-section--overview">
        <h2 className="reflection-section__title">Time Overview</h2>
        <div className="reflection-tabs" role="tablist" aria-label="Reflection time ranges">
          {RANGE_KEYS.map((key) => {
            const config = RANGE_DEFS[key]
            const isActive = key === activeRange
            return (
              <button
                key={key}
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-controls={tabPanelId}
                className={`reflection-tab${isActive ? ' reflection-tab--active' : ''}`}
                onClick={() => setActiveRange(key)}
              >
                <span className="reflection-tab__label">{config.label}</span>
              </button>
            )
          })}
        </div>

        <div
          className="reflection-overview"
          role="tabpanel"
          id={tabPanelId}
          aria-live="polite"
          aria-label={`${activeRangeConfig.label} chart`}
        >
          <div className="reflection-pie">
            <svg
              className="reflection-pie__chart"
              viewBox={`0 0 ${PIE_VIEWBOX_SIZE} ${PIE_VIEWBOX_SIZE}`}
              aria-hidden="true"
              focusable="false"
            >
              {pieArcs.length === 0 ? (
                <path
                  className="reflection-pie__slice"
                  d={FULL_DONUT_PATH}
                  fill="var(--reflection-chart-unlogged)"
                  fillRule="evenodd"
                  clipRule="evenodd"
                />
              ) : (
                pieArcs.map((arc) => (
                  <path
                    key={arc.id}
                    className="reflection-pie__slice"
                    d={arc.path}
                    fill={arc.color}
                    fillRule="evenodd"
                    clipRule="evenodd"
                  />
                ))
              )}
            </svg>
            <div className="reflection-pie__center">
              <span className="reflection-pie__range">{activeRangeConfig.shortLabel}</span>
              <span className="reflection-pie__value">{formatDuration(loggedMs)}</span>
              <span className="reflection-pie__caption">logged</span>
            </div>
          </div>

          <div className="reflection-legend" aria-label={`${activeRangeConfig.label} breakdown`}>
            {legendSegments.map((segment) => (
              <div
                key={segment.id}
                className={`reflection-legend__item${segment.isUnlogged ? ' reflection-legend__item--unlogged' : ''}`}
              >
                <span className="reflection-legend__swatch" style={{ background: segment.color }} aria-hidden="true" />
                <div className="reflection-legend__meta">
                  <span className="reflection-legend__label">{segment.label}</span>
                  <span className="reflection-legend__value">{formatDuration(segment.durationMs)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="reflection-stats">
          <div className="reflection-stats__item">
            <span className="reflection-stats__label">Logged</span>
            <span className="reflection-stats__value">{formatDuration(loggedMs)}</span>
          </div>
          <div className="reflection-stats__item">
            <span className="reflection-stats__label">Unlogged</span>
            <span className="reflection-stats__value">{formatDuration(unloggedMs)}</span>
          </div>
          <div className="reflection-stats__item">
            <span className="reflection-stats__label">Window</span>
            <span className="reflection-stats__value">{formatDuration(windowMs)}</span>
          </div>
        </div>
      </section>

      {/* Progress Summary */}
      <section className="reflection-section">
        <h2 className="reflection-section__title">Weekly Progress</h2>
        <div className="reflection-goals">
          {MOCK_SUMMARY.map((g) => {
            const pct = Math.round((g.minutes / g.target) * 100)
            return (
              <div key={g.id} className="reflection-goal-card">
                <div className="reflection-goal-header">
                  <h3 className="reflection-goal-name">{g.goal}</h3>
                  <span className="reflection-goal-time">
                    {Math.round(g.minutes / 60)} / {Math.round(g.target / 60)} h
                  </span>
                </div>
                <ThinProgress value={pct} gradient={g.gradient} />
              </div>
            )
          })}
        </div>
      </section>

      {/* Journal Prompts */}
      <section className="reflection-section">
        <h2 className="reflection-section__title">Daily Reflection</h2>
        <p className="reflection-section__desc">Answer a few prompts to capture today's highlights and challenges.</p>
        
        <div className="reflection-prompts">
          {JOURNAL_PROMPTS.map((p, idx) => (
            <div key={idx} className="reflection-prompt">
              {p}
            </div>
          ))}
        </div>
        
        <textarea
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          placeholder="Write your thoughts here..."
          className="reflection-journal"
        />
        
        <div className="reflection-actions">
          <button className="reflection-save">Save Reflection</button>
        </div>
      </section>
    </section>
  )
}
