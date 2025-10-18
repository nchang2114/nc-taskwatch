import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import './ReflectionPage.css'
import { readStoredGoalsSnapshot, subscribeToGoalsSnapshot, type GoalSnapshot } from '../lib/goalsSync'

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
  goalName: string | null
  bucketName: string | null
}

type HistoryDraftState = {
  taskName: string
  goalName: string
  bucketName: string
  startedAt: number | null
  endedAt: number | null
}

type GoalGradientInfo = {
  start: string
  end: string
  angle?: number
  css: string
}

type GoalColorInfo = {
  gradient?: GoalGradientInfo
  solidColor?: string
}

type PieSegment = {
  id: string
  label: string
  durationMs: number
  fraction: number
  swatch: string
  baseColor: string
  gradient?: GoalGradientInfo
  colorInfo?: GoalColorInfo
  isUnlogged?: boolean
}

type PieArc = {
  id: string
  color: string
  path: string
  fill: string
  startAngle: number
  endAngle: number
  baseColor: string
  colorInfo?: GoalColorInfo
  isUnlogged?: boolean
}

const HISTORY_STORAGE_KEY = 'nc-taskwatch-history'
const HISTORY_EVENT_NAME = 'nc-taskwatch:history-update'
const CURRENT_SESSION_STORAGE_KEY = 'nc-taskwatch-current-session'
const CURRENT_SESSION_EVENT_NAME = 'nc-taskwatch:session-update'
const UNCATEGORISED_LABEL = 'Uncategorised'
const UNCATEGORISED_GRADIENT = {
  css: 'linear-gradient(135deg, #94a3b8 0%, #64748b 45%, #1e293b 100%)',
  start: '#94a3b8',
  end: '#1e293b',
  angle: 135,
} satisfies GoalGradientInfo
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f97316', '#f472b6', '#a855f7', '#4ade80', '#60a5fa', '#facc15', '#38bdf8', '#fb7185']

type GoalLookup = Map<string, { goalName: string; colorInfo?: GoalColorInfo }>

type DragKind = 'move' | 'resize-start' | 'resize-end'

type DragState = {
  entryId: string
  type: DragKind
  pointerId: number
  rectWidth: number
  startX: number
  initialStart: number
  initialEnd: number
  dayStart: number
  dayEnd: number
  minDurationMs: number
  hasMoved: boolean
}

type DragPreview = {
  entryId: string
  startedAt: number
  endedAt: number
}

type TimelineSegment = {
  id: string
  entry: HistoryEntry
  start: number
  end: number
  lane: number
  leftPercent: number
  widthPercent: number
  color: string
  gradientCss?: string
  colorInfo?: GoalColorInfo
  goalLabel: string
  bucketLabel: string
  deletable: boolean
  originalRangeLabel: string
  tooltipTask: string
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
      const goalNameRaw = typeof candidate.goalName === 'string' ? candidate.goalName : ''
      const bucketNameRaw = typeof candidate.bucketName === 'string' ? candidate.bucketName : ''
      if (!id || elapsed === null || startedAt === null || endedAt === null) {
        return null
      }
      return {
        id,
        taskName,
        elapsed,
        startedAt,
        endedAt,
        goalName: goalNameRaw.trim().length > 0 ? goalNameRaw : null,
        bucketName: bucketNameRaw.trim().length > 0 ? bucketNameRaw : null,
      }
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

const formatTimeOfDay = (timestamp: number) => {
  const date = new Date(timestamp)
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return `${hours12}:${minutes}${period}`
}

const formatHourLabel = (hour24: number) => {
  const normalized = ((hour24 % 24) + 24) % 24
  if (normalized === 0) {
    return '12 AM'
  }
  if (normalized === 12) {
    return '12 PM'
  }
  if (normalized < 12) {
    return `${normalized} AM`
  }
  return `${normalized - 12} PM`
}

const MINUTE_MS = 60 * 1000
const DAY_DURATION_MS = 24 * 60 * 60 * 1000
const DRAG_DETECTION_THRESHOLD_PX = 3
const MIN_SESSION_DURATION_DRAG_MS = MINUTE_MS

const formatTimeInputValue = (timestamp: number | null): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

const applyTimeToTimestamp = (reference: number, timeValue: string): number | null => {
  if (!Number.isFinite(reference) || typeof timeValue !== 'string') {
    return null
  }
  const [hoursStr, minutesStr] = timeValue.split(':')
  if (hoursStr === undefined || minutesStr === undefined) {
    return null
  }
  const hours = Number(hoursStr)
  const minutes = Number(minutesStr)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null
  }
  const base = new Date(reference)
  base.setHours(hours, minutes, 0, 0)
  return base.getTime()
}

const resolveTimestamp = (value: number | null | undefined, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return fallback
}

const sampleLoopGradientColor = (
  colorInfo: GoalColorInfo | undefined,
  fallback: string,
  ratio: number,
): string => {
  const normalizedFallback = normalizeHexColor(fallback) ?? fallback
  if (!colorInfo) {
    return normalizedFallback
  }
  if (colorInfo.gradient) {
    const start = normalizeHexColor(colorInfo.gradient.start) ?? colorInfo.gradient.start
    const end = normalizeHexColor(colorInfo.gradient.end) ?? colorInfo.gradient.end
    if (start && end) {
      const t = ((ratio % 1) + 1) % 1
      if (t <= 0.5) {
        return mixHexColors(start, end, t / 0.5)
      }
      return mixHexColors(end, start, (t - 0.5) / 0.5)
    }
  }
  if (colorInfo.solidColor) {
    return colorInfo.solidColor
  }
  return normalizedFallback
}

type LoopSlice = {
  key: string
  path: string
  color: string
}

const buildArcLoopSlices = (arc: PieArc): LoopSlice[] => {
  if (arc.isUnlogged) {
    return [
      {
        key: `${arc.id}-full`,
        path: describeDonutSlice(arc.startAngle, arc.endAngle),
        color: arc.fill,
      },
    ]
  }
  const span = Math.max(arc.endAngle - arc.startAngle, 0)
  if (span <= 0) {
    return []
  }
  const midAngle = arc.startAngle + span / 2
  const ratio = midAngle / 360
  const baseColor = sampleLoopGradientColor(arc.colorInfo, arc.baseColor, ratio)
  const color = mixHexColors(baseColor, '#ffffff', 0.06)
  return [
    {
      key: `${arc.id}-slice`,
      path: describeDonutSlice(arc.startAngle, arc.endAngle),
      color,
    },
  ]
}

const makeHistoryId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    console.warn('Failed to generate UUID for history entry, falling back to timestamp-based id', error)
  }
  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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

const formatDatePart = (timestamp: number) => {
  const date = new Date(timestamp)
  const day = date.getDate()
  const month = date.toLocaleString(undefined, { month: 'short' })
  const year = date.getFullYear()
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return {
    dateLabel: `${day}/${month}/${year}`,
    timeLabel: `${hours12}:${minutes}${period}`,
  }
}

const formatDateRange = (start: number, end: number) => {
  const startPart = formatDatePart(start)
  const endPart = formatDatePart(end)

  if (startPart.dateLabel === endPart.dateLabel) {
    return `${startPart.dateLabel} ${startPart.timeLabel}-${endPart.timeLabel}`
  }

  return `${startPart.dateLabel} ${startPart.timeLabel} - ${endPart.dateLabel} ${endPart.timeLabel}`
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

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const normalizeHexColor = (value: string): string | null => {
  const trimmed = value.trim()
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return null
  }
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

const hexToRgb = (hex: string) => {
  const normalized = normalizeHexColor(hex)
  if (!normalized) {
    return null
  }
  const value = normalized.slice(1)
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return { r, g, b }
}

const rgbToHex = (r: number, g: number, b: number) => {
  const clamp = (component: number) => Math.min(255, Math.max(0, Math.round(component)))
  const toHex = (component: number) => clamp(component).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const mixHexColors = (source: string, target: string, ratio: number) => {
  const sourceRgb = hexToRgb(source)
  const targetRgb = hexToRgb(target)
  if (!sourceRgb || !targetRgb) {
    return source
  }
  const safeRatio = clamp01(ratio)
  const mix = (a: number, b: number) => a * (1 - safeRatio) + b * safeRatio
  return rgbToHex(mix(sourceRgb.r, targetRgb.r), mix(sourceRgb.g, targetRgb.g), mix(sourceRgb.b, targetRgb.b))
}

const applyAlphaToHex = (hex: string, alpha: number) => {
  const normalized = normalizeHexColor(hex)
  if (!normalized) {
    return hex
  }
  const clampedAlpha = Math.min(1, Math.max(0, alpha))
  const alphaByte = Math.round(clampedAlpha * 255)
  return `${normalized}${alphaByte.toString(16).padStart(2, '0')}`
}

const PRESET_GOAL_GRADIENTS: Record<string, string> = {
  'from-fuchsia-500 to-purple-500': 'linear-gradient(135deg, #f471b5 0%, #a855f7 50%, #6b21a8 100%)',
  'from-emerald-500 to-cyan-500': 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  'from-lime-400 to-emerald-500': 'linear-gradient(135deg, #bef264 0%, #4ade80 45%, #22c55e 100%)',
  'from-sky-500 to-indigo-500': 'linear-gradient(135deg, #38bdf8 0%, #60a5fa 50%, #6366f1 100%)',
  'from-amber-400 to-orange-500': 'linear-gradient(135deg, #fbbf24 0%, #fb923c 45%, #f97316 100%)',
}

const extractGradientColors = (gradient: string): { start: string; end: string; angle?: number } | null => {
  const matches = gradient.match(/#(?:[0-9a-fA-F]{3}){1,2}/g)
  if (!matches || matches.length === 0) {
    return null
  }
  const start = normalizeHexColor(matches[0]) ?? matches[0]
  const end = normalizeHexColor(matches[matches.length - 1]) ?? matches[matches.length - 1]
  const angleMatch = gradient.match(/(-?\d+(?:\.\d+)?)deg/)
  return {
    start,
    end,
    angle: angleMatch ? Number.parseFloat(angleMatch[1]) : undefined,
  }
}

const resolveGoalColorInfo = (value: string | undefined): GoalColorInfo | undefined => {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  let gradientString: string | null = null
  if (trimmed.startsWith('custom:')) {
    gradientString = trimmed.slice(7)
  } else if (trimmed.includes('gradient(')) {
    gradientString = trimmed
  } else if (PRESET_GOAL_GRADIENTS[trimmed]) {
    gradientString = PRESET_GOAL_GRADIENTS[trimmed]
  } else {
    const normalized = normalizeHexColor(trimmed)
    if (normalized) {
      return { solidColor: normalized }
    }
    return undefined
  }

  const parsed = extractGradientColors(gradientString)
  if (!parsed) {
    return undefined
  }

  return {
    gradient: {
      css: gradientString,
      start: parsed.start,
      end: parsed.end,
      angle: parsed.angle,
    },
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

  const filteredSegments = segments.filter((segment) => Math.max(segment.durationMs, 0) > 0)
  if (filteredSegments.length === 0) {
    return []
  }

  const segmentTotal = filteredSegments.reduce((sum, segment) => sum + Math.max(segment.durationMs, 0), 0)
  const denominator = Math.max(windowMs, segmentTotal, 1)
  let accumulated = 0
  const arcs: PieArc[] = []

  for (let index = 0; index < filteredSegments.length; index += 1) {
    const segment = filteredSegments[index]
    const value = Math.max(segment.durationMs, 0)
    if (!Number.isFinite(value) || value <= 0) {
      continue
    }

    const startRatio = clamp01(accumulated / denominator)
    accumulated += value
    let endRatio = index === filteredSegments.length - 1 ? 1 : clamp01(accumulated / denominator)
    if (endRatio < startRatio) {
      endRatio = startRatio
    }

    const sweepRatio = endRatio - startRatio
    if (sweepRatio <= ARC_EPSILON) {
      continue
    }

    const startAngle = startRatio * 360
    const endAngle = Math.min(startAngle + sweepRatio * 360, 360)
    const normalizedBase = normalizeHexColor(segment.baseColor)
    const fallbackFill = normalizedBase ? applyAlphaToHex(normalizedBase, 0.58) : segment.baseColor
    const isUnlogged = Boolean(segment.isUnlogged)
    const fillValue = isUnlogged ? 'var(--reflection-chart-unlogged-soft)' : fallbackFill
    arcs.push({
      id: segment.id,
      color: segment.swatch,
      path: describeDonutSlice(startAngle, endAngle),
      fill: fillValue,
      startAngle,
      endAngle,
      baseColor: segment.baseColor,
      colorInfo: segment.colorInfo,
      isUnlogged,
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
    const colorInfo = resolveGoalColorInfo(goal.color)
    goal.buckets.forEach((bucket) => {
      bucket.tasks.forEach((task) => {
        const key = task.text.trim().toLowerCase()
        if (!key || map.has(key)) {
          return
        }
        map.set(key, { goalName, colorInfo })
      })
    })
  })
  return map
}

const createGoalColorMap = (snapshot: GoalSnapshot[]): Map<string, GoalColorInfo | undefined> => {
  const map = new Map<string, GoalColorInfo | undefined>()
  snapshot.forEach((goal) => {
    const goalName = goal.name?.trim()
    if (!goalName) {
      return
    }
    const normalized = goalName.toLowerCase()
    if (map.has(normalized)) {
      return
    }
    map.set(normalized, resolveGoalColorInfo(goal.color))
  })
  return map
}

type GoalMetadata = {
  label: string
  colorInfo?: GoalColorInfo
}

type ActiveSessionState = {
  taskName: string
  goalName: string | null
  startedAt: number | null
  baseElapsed: number
  isRunning: boolean
  updatedAt: number
}

const resolveGoalMetadata = (
  entry: HistoryEntry,
  taskLookup: GoalLookup,
  goalColorLookup: Map<string, GoalColorInfo | undefined>,
): GoalMetadata => {
  const goalName = entry.goalName?.trim()
  if (goalName && goalName.length > 0) {
    const colorInfo = goalColorLookup.get(goalName.toLowerCase())
    return { label: goalName, colorInfo }
  }

  const taskName = entry.taskName.trim()
  if (taskName.length > 0) {
    const match = taskLookup.get(taskName.toLowerCase())
    if (match) {
      return { label: match.goalName, colorInfo: match.colorInfo }
    }
  }

  return { label: UNCATEGORISED_LABEL, colorInfo: { gradient: UNCATEGORISED_GRADIENT } }
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
  taskLookup: GoalLookup,
  goalColorLookup: Map<string, GoalColorInfo | undefined>,
): { segments: PieSegment[]; windowMs: number; loggedMs: number } => {
  const { durationMs: windowMs } = RANGE_DEFS[range]
  const now = Date.now()
  const windowStart = now - windowMs
  const totals = new Map<
    string,
    {
      durationMs: number
      colorInfo?: GoalColorInfo
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
    const metadata = resolveGoalMetadata(entry, taskLookup, goalColorLookup)
    const current = totals.get(metadata.label)
    if (current) {
      current.durationMs += overlapMs
    } else {
      totals.set(metadata.label, { durationMs: overlapMs, colorInfo: metadata.colorInfo })
    }
  })

  let segments = Array.from(totals.entries()).map(([label, info]) => ({
    label,
    durationMs: info.durationMs,
    colorInfo: info.colorInfo,
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
    const gradient = segment.colorInfo?.gradient
    const solid = segment.colorInfo?.solidColor
    const baseColor = gradient?.start ?? solid ?? getPaletteColorForLabel(segment.label)
    const swatch = gradient?.css ?? baseColor
    const slug = segment.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'segment'
    const id = `${slug}-${Math.abs(hashString(segment.label))}`
    return {
      id,
      label: segment.label,
      durationMs: segment.durationMs,
      fraction: Math.min(Math.max(segment.durationMs / windowMs, 0), 1),
      swatch,
      baseColor,
      gradient,
      colorInfo: segment.colorInfo,
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
      swatch: 'var(--reflection-chart-unlogged)',
      baseColor: 'var(--reflection-chart-unlogged)',
      isUnlogged: true,
    })
  }

  return {
    segments: pieSegments,
    windowMs,
    loggedMs: Math.min(loggedMs, windowMs),
  }
}

export default function ReflectionPage() {
  const [activeRange, setActiveRange] = useState<ReflectionRangeKey>('24h')
  const [history, setHistory] = useState<HistoryEntry[]>(() => readStoredHistory())
  const [deletedHistoryStack, setDeletedHistoryStack] = useState<{ entry: HistoryEntry; index: number }[]>([])
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => readStoredGoalsSnapshot())
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(() => readStoredActiveSession())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [journal, setJournal] = useState('')
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [hoveredHistoryId, setHoveredHistoryId] = useState<string | null>(null)
  const [historyDraft, setHistoryDraft] = useState<HistoryDraftState>({
    taskName: '',
    goalName: '',
    bucketName: '',
    startedAt: null,
    endedAt: null,
  })
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineBarRef = useRef<HTMLDivElement | null>(null)
  const activeTooltipRef = useRef<HTMLDivElement | null>(null)
  const [activeTooltipOffsets, setActiveTooltipOffsets] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragStateRef = useRef<DragState | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const dragPreviewRef = useRef<DragPreview | null>(null)
  const dragPreventClickRef = useRef(false)
  const selectedHistoryIdRef = useRef<string | null>(selectedHistoryId)

  useEffect(() => {
    dragPreviewRef.current = dragPreview
  }, [dragPreview])

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId
  }, [selectedHistoryId])

  const updateActiveTooltipOffsets = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    const tooltipEl = activeTooltipRef.current
    if (!tooltipEl) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }

    const rect = tooltipEl.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = 16

    let shiftX = 0
    if (rect.left < padding) {
      shiftX = padding - rect.left
    } else if (rect.right > viewportWidth - padding) {
      shiftX = viewportWidth - padding - rect.right
    }

    let shiftY = 0
    if (rect.top < padding) {
      shiftY = padding - rect.top
    } else {
      const overflowBottom = rect.bottom - (viewportHeight - padding)
      if (overflowBottom > 0) {
        shiftY = -overflowBottom
      }
    }

    setActiveTooltipOffsets((prev) => {
      if (prev.x === shiftX && prev.y === shiftY) {
        return prev
      }
      return { x: shiftX, y: shiftY }
    })
  }, [])

  const setActiveTooltipNode = useCallback(
    (node: HTMLDivElement | null) => {
      activeTooltipRef.current = node
      if (!node) {
        setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
        return
      }
      updateActiveTooltipOffsets()
    },
    [updateActiveTooltipOffsets],
  )

  const persistHistory = useCallback((next: HistoryEntry[]) => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      console.warn('Failed to persist history from Reflection', error)
    }
    try {
      const event = new CustomEvent(HISTORY_EVENT_NAME, { detail: next })
      window.dispatchEvent(event)
    } catch (error) {
      console.warn('Failed to broadcast history update from Reflection', error)
    }
  }, [])

  const updateHistory = useCallback(
    (updater: (current: HistoryEntry[]) => HistoryEntry[]) => {
      setHistory((current) => {
        const next = updater(current)
        if (next !== current) {
          persistHistory(next)
        }
        return next
      })
    },
    [persistHistory],
  )

  const goalLookup = useMemo(() => createGoalTaskMap(goalsSnapshot), [goalsSnapshot])
  const goalColorLookup = useMemo(() => createGoalColorMap(goalsSnapshot), [goalsSnapshot])
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
    map.set(key, { goalName, colorInfo: goalColorLookup.get(goalName.toLowerCase()) })
    return map
  }, [goalLookup, goalColorLookup, activeSession])

  const goalOptions = useMemo(() => {
    const set = new Set<string>()
    goalsSnapshot.forEach((goal) => {
      const trimmed = goal.name?.trim()
      if (trimmed) {
        set.add(trimmed)
      }
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [goalsSnapshot])

  const bucketOptionsByGoal = useMemo(() => {
    const map = new Map<string, string[]>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName) {
        return
      }
      const bucketNames = goal.buckets
        .map((bucket) => bucket.name?.trim())
        .filter((name): name is string => Boolean(name))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      if (bucketNames.length > 0) {
        map.set(goalName, bucketNames)
      }
    })
    return map
  }, [goalsSnapshot])

  const allBucketOptions = useMemo(() => {
    const set = new Set<string>()
    goalsSnapshot.forEach((goal) => {
      goal.buckets.forEach((bucket) => {
        const trimmed = bucket.name?.trim()
        if (trimmed) {
          set.add(trimmed)
        }
      })
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [goalsSnapshot])

  const trimmedDraftGoal = historyDraft.goalName.trim()
  const trimmedDraftBucket = historyDraft.bucketName.trim()

  const availableBucketOptions = useMemo(() => {
    if (trimmedDraftGoal.length > 0) {
      const match = bucketOptionsByGoal.get(trimmedDraftGoal)
      if (match && match.length > 0) {
        return match
      }
    }
    return allBucketOptions
  }, [trimmedDraftGoal, bucketOptionsByGoal, allBucketOptions])

  const resolvedGoalOptions = useMemo(() => {
    if (trimmedDraftGoal.length > 0 && !goalOptions.includes(trimmedDraftGoal)) {
      return [trimmedDraftGoal, ...goalOptions]
    }
    return goalOptions
  }, [goalOptions, trimmedDraftGoal])

  const resolvedBucketOptions = useMemo(() => {
    if (trimmedDraftBucket.length > 0 && !availableBucketOptions.includes(trimmedDraftBucket)) {
      return [trimmedDraftBucket, ...availableBucketOptions]
    }
    return availableBucketOptions
  }, [availableBucketOptions, trimmedDraftBucket])

  const selectedHistoryEntry = useMemo(() => {
    if (!selectedHistoryId) {
      return null
    }
    const match = history.find((entry) => entry.id === selectedHistoryId)
    return match ?? null
  }, [history, selectedHistoryId])

  useEffect(() => {
    if (!selectedHistoryEntry) {
      setEditingHistoryId(null)
      return
    }
    setHistoryDraft({
      taskName: selectedHistoryEntry.taskName,
      goalName: selectedHistoryEntry.goalName ?? '',
      bucketName: selectedHistoryEntry.bucketName ?? '',
      startedAt: selectedHistoryEntry.startedAt,
      endedAt: selectedHistoryEntry.endedAt,
    })
    setEditingHistoryId(null)
  }, [selectedHistoryEntry])

  useEffect(() => {
    if (!editingHistoryId) {
      return
    }
    if (!selectedHistoryEntry || editingHistoryId !== selectedHistoryEntry.id) {
      setEditingHistoryId(null)
      return
    }
  }, [editingHistoryId, selectedHistoryEntry])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const activeTooltipId = hoveredHistoryId ?? selectedHistoryId
    if (!activeTooltipId) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }
    const tooltipEl = activeTooltipRef.current
    if (!tooltipEl) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }

    const handleUpdate = () => {
      updateActiveTooltipOffsets()
    }

    handleUpdate()

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => handleUpdate())
      resizeObserver.observe(tooltipEl)
    }

    window.addEventListener('resize', handleUpdate)
    window.addEventListener('scroll', handleUpdate, true)
    const timelineEl = timelineRef.current
    timelineEl?.addEventListener('scroll', handleUpdate)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleUpdate)
      window.removeEventListener('scroll', handleUpdate, true)
      timelineEl?.removeEventListener('scroll', handleUpdate)
    }
  }, [hoveredHistoryId, selectedHistoryId, updateActiveTooltipOffsets])

  const handleDeleteHistoryEntry = useCallback(
    (entryId: string) => (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const index = history.findIndex((entry) => entry.id === entryId)
      if (index === -1) {
        return
      }
      const entry = history[index]
      setDeletedHistoryStack((stack) => [...stack, { entry, index }])
      setHoveredHistoryId((current) => (current === entryId ? null : current))
      if (selectedHistoryId === entryId) {
        setSelectedHistoryId(null)
        setEditingHistoryId(null)
        setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
      }
      updateHistory((current) => [...current.slice(0, index), ...current.slice(index + 1)])
    },
    [history, selectedHistoryId, updateHistory],
  )

  const handleUndoDelete = useCallback(() => {
    if (deletedHistoryStack.length === 0) {
      return
    }
    const { entry, index } = deletedHistoryStack[deletedHistoryStack.length - 1]
    setDeletedHistoryStack((stack) => stack.slice(0, -1))
    updateHistory((current) => {
      if (current.some((item) => item.id === entry.id)) {
        return current
      }
      const next = [...current]
      const insertIndex = Math.min(index, next.length)
      next.splice(insertIndex, 0, entry)
      return next
    })
  }, [deletedHistoryStack, updateHistory])

  const handleAddHistoryEntry = useCallback(() => {
    const now = Date.now()
    const defaultDuration = 30 * 60 * 1000
    const endedAt = now
    const startedAt = Math.max(endedAt - defaultDuration, 0)
    const elapsed = Math.max(endedAt - startedAt, 1)
    const entry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: '',
      goalName: null,
      bucketName: null,
      elapsed,
      startedAt,
      endedAt,
    }
    updateHistory((current) => {
      const next = [...current, entry]
      next.sort((a, b) => a.startedAt - b.startedAt)
      return next
    })
    setHoveredHistoryId(null)
    setSelectedHistoryId(entry.id)
    setEditingHistoryId(entry.id)
    setHistoryDraft({
      taskName: '',
      goalName: '',
      bucketName: '',
      startedAt,
      endedAt,
    })
  }, [updateHistory])

  const handleSelectHistorySegment = useCallback(
    (entry: HistoryEntry) => {
      if (selectedHistoryId === entry.id) {
        setSelectedHistoryId(null)
        setEditingHistoryId(null)
        setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
        setHoveredHistoryId((current) => (current === entry.id ? null : current))
        return
      }
      setHistoryDraft({
        taskName: entry.taskName,
        goalName: entry.goalName ?? '',
        bucketName: entry.bucketName ?? '',
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      })
      setSelectedHistoryId(entry.id)
      setEditingHistoryId(null)
    },
    [selectedHistoryId],
  )

  const handleHistoryFieldChange = useCallback(
    (field: 'taskName' | 'goalName' | 'bucketName') => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { value } = event.target
      setHistoryDraft((draft) => ({ ...draft, [field]: value }))
    },
    [],
  )

  const commitHistoryDraft = useCallback(() => {
    if (!selectedHistoryEntry) {
      return
    }
    const nextTaskName = historyDraft.taskName.trim()
    const nextGoalName = historyDraft.goalName.trim()
    const nextBucketName = historyDraft.bucketName.trim()
    const draftStartedAt = historyDraft.startedAt ?? selectedHistoryEntry.startedAt
    const draftEndedAt = historyDraft.endedAt ?? selectedHistoryEntry.endedAt
    let nextStartedAt = Number.isFinite(draftStartedAt) ? draftStartedAt : selectedHistoryEntry.startedAt
    let nextEndedAt = Number.isFinite(draftEndedAt) ? draftEndedAt : selectedHistoryEntry.endedAt
    if (!Number.isFinite(nextStartedAt)) {
      nextStartedAt = selectedHistoryEntry.startedAt
    }
    if (!Number.isFinite(nextEndedAt)) {
      nextEndedAt = selectedHistoryEntry.endedAt
    }
    while (nextEndedAt <= nextStartedAt) {
      nextEndedAt += DAY_DURATION_MS
    }
    const nextElapsed = Math.max(nextEndedAt - nextStartedAt, 1)
    const normalizedGoalName = nextGoalName
    const normalizedBucketName = nextBucketName
    updateHistory((current) => {
      const index = current.findIndex((entry) => entry.id === selectedHistoryEntry.id)
      if (index === -1) {
        return current
      }
      const target = current[index]
      if (
        target.taskName === nextTaskName &&
        (target.goalName ?? '') === normalizedGoalName &&
        (target.bucketName ?? '') === normalizedBucketName &&
        target.startedAt === nextStartedAt &&
        target.endedAt === nextEndedAt
      ) {
        return current
      }
      const next = [...current]
      next[index] = {
        ...target,
        taskName: nextTaskName,
        goalName: normalizedGoalName.length > 0 ? normalizedGoalName : null,
        bucketName: normalizedBucketName.length > 0 ? normalizedBucketName : null,
        startedAt: nextStartedAt,
        endedAt: nextEndedAt,
        elapsed: nextElapsed,
      }
      return next
    })
    setHistoryDraft({
      taskName: nextTaskName,
      goalName: normalizedGoalName,
      bucketName: normalizedBucketName,
      startedAt: nextStartedAt,
      endedAt: nextEndedAt,
    })
    setEditingHistoryId(null)
  }, [historyDraft, selectedHistoryEntry, updateHistory])

  const handleHistoryFieldKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitHistoryDraft()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (selectedHistoryEntry) {
          setHistoryDraft({
            taskName: selectedHistoryEntry.taskName,
            goalName: selectedHistoryEntry.goalName ?? '',
            bucketName: selectedHistoryEntry.bucketName ?? '',
            startedAt: selectedHistoryEntry.startedAt,
            endedAt: selectedHistoryEntry.endedAt,
          })
        }
        setEditingHistoryId(null)
      }
    },
    [commitHistoryDraft, selectedHistoryEntry],
  )

  const handleCancelHistoryEdit = useCallback(() => {
    if (selectedHistoryEntry) {
      setHistoryDraft({
        taskName: selectedHistoryEntry.taskName,
        goalName: selectedHistoryEntry.goalName ?? '',
        bucketName: selectedHistoryEntry.bucketName ?? '',
        startedAt: selectedHistoryEntry.startedAt,
        endedAt: selectedHistoryEntry.endedAt,
      })
    } else {
      setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
    }
    setEditingHistoryId(null)
  }, [selectedHistoryEntry])

  const handleSaveHistoryDraft = useCallback(() => {
    commitHistoryDraft()
  }, [commitHistoryDraft])

  const handleStartEditingHistoryEntry = useCallback((entry: HistoryEntry) => {
    setEditingHistoryId(entry.id)
    setHistoryDraft({
      taskName: entry.taskName,
      goalName: entry.goalName ?? '',
      bucketName: entry.bucketName ?? '',
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    })
  }, [])

  useEffect(() => {
    if (!selectedHistoryId) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const timelineEl = timelineRef.current
      const targetNode = event.target as Node | null
      if (timelineEl && targetNode && timelineEl.contains(targetNode)) {
        return
      }
      handleCancelHistoryEdit()
      setSelectedHistoryId(null)
      setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
      setHoveredHistoryId(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [handleCancelHistoryEdit, selectedHistoryId, timelineRef])

  useEffect(() => {
    const goalName = historyDraft.goalName.trim()
    const bucketName = historyDraft.bucketName.trim()
    if (goalName.length === 0 || bucketName.length === 0) {
      return
    }
    const allowedBuckets = bucketOptionsByGoal.get(goalName)
    if (!allowedBuckets || allowedBuckets.includes(bucketName)) {
      return
    }
    setHistoryDraft((draft) => {
      if (draft.bucketName.trim().length === 0) {
        return draft
      }
      return { ...draft, bucketName: '' }
    })
  }, [historyDraft.goalName, historyDraft.bucketName, bucketOptionsByGoal])

  const handleTimelineBlockKeyDown = useCallback(
    (entry: HistoryEntry) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handleSelectHistorySegment(entry)
      } else if (event.key === 'Escape' && selectedHistoryId === entry.id) {
        event.preventDefault()
        setSelectedHistoryId(null)
        setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
        setEditingHistoryId(null)
      }
    },
    [handleSelectHistorySegment, selectedHistoryId],
  )

  const handleTimelineBackgroundClick = useCallback(() => {
    setSelectedHistoryId(null)
    setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
    setEditingHistoryId(null)
    setHoveredHistoryId(null)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === HISTORY_STORAGE_KEY) {
        setHistory(readStoredHistory())
        setDeletedHistoryStack([])
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
        setDeletedHistoryStack([])
      } else {
        setHistory(readStoredHistory())
        setDeletedHistoryStack([])
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
      activeSession.taskName.length > 0 ? activeSession.taskName : activeSession.goalName ?? UNCATEGORISED_LABEL
    const activeEntry: HistoryEntry = {
      id: 'active-session',
      taskName: taskLabel,
      elapsed: totalElapsed,
      startedAt: safeStartedAt,
      endedAt,
      goalName: activeSession.goalName ?? null,
      bucketName: null,
    }
    const filteredHistory = history.filter((entry) => entry.id !== activeEntry.id)
    return [activeEntry, ...filteredHistory]
  }, [history, activeSession, nowTick])

  useEffect(() => {
    if (!selectedHistoryId) {
      return
    }
    const exists = effectiveHistory.some((entry) => entry.id === selectedHistoryId)
    if (!exists) {
      setSelectedHistoryId(null)
      setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
    }
  }, [effectiveHistory, selectedHistoryId])

  const { segments, windowMs, loggedMs } = useMemo(
    () => computeRangeOverview(effectiveHistory, activeRange, enhancedGoalLookup, goalColorLookup),
    [effectiveHistory, activeRange, enhancedGoalLookup, goalColorLookup, nowTick],
  )
  const activeRangeConfig = RANGE_DEFS[activeRange]
  const loggedSegments = useMemo(() => segments.filter((segment) => !segment.isUnlogged), [segments])
  const unloggedFraction = useMemo(
    () => Math.max(0, 1 - loggedSegments.reduce((sum, segment) => sum + segment.fraction, 0)),
    [loggedSegments],
  )
  const legendSegments = useMemo(() => {
    const base = loggedSegments.length > 1 ? [...loggedSegments].sort((a, b) => b.durationMs - a.durationMs) : loggedSegments
    if (unloggedFraction > 0 && windowMs > loggedMs) {
      return [
        ...base,
        {
          id: 'unlogged',
          label: 'Unlogged Time',
          durationMs: windowMs - loggedMs,
          fraction: unloggedFraction,
          swatch: 'var(--reflection-chart-unlogged)',
          baseColor: 'var(--reflection-chart-unlogged)',
          isUnlogged: true,
        } as PieSegment,
      ]
    }
    return base
  }, [loggedSegments, windowMs, loggedMs, unloggedFraction])
  const pieArcs = useMemo(() => createPieArcs(segments, windowMs), [segments, windowMs])
  const unloggedMs = useMemo(() => Math.max(windowMs - loggedMs, 0), [windowMs, loggedMs])
  const tabPanelId = 'reflection-range-panel'
  const dayStart = useMemo(() => {
    const date = new Date(nowTick)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }, [nowTick])
  const dayEnd = dayStart + DAY_DURATION_MS
  const currentTimePercent = useMemo(() => {
    if (nowTick < dayStart || nowTick > dayEnd) {
      return null
    }
    const raw = ((nowTick - dayStart) / DAY_DURATION_MS) * 100
    return Math.min(Math.max(raw, 0), 100)
  }, [nowTick, dayStart, dayEnd])
  const daySegments = useMemo(() => {
    const preview = dragPreview
    const entries = effectiveHistory
      .map((entry) => {
        const isPreviewed = preview && preview.entryId === entry.id
        const startedAt = isPreviewed ? preview.startedAt : entry.startedAt
        const endedAt = isPreviewed ? preview.endedAt : entry.endedAt
        const previewedEntry = isPreviewed
          ? {
              ...entry,
              startedAt,
              endedAt,
              elapsed: Math.max(endedAt - startedAt, 1),
            }
          : entry
        const start = Math.max(previewedEntry.startedAt, dayStart)
        const end = Math.min(previewedEntry.endedAt, dayEnd)
        if (end <= start) {
          return null
        }
        return { entry: previewedEntry, start, end }
      })
      .filter((segment): segment is { entry: HistoryEntry; start: number; end: number } => Boolean(segment))

    entries.sort((a, b) => a.start - b.start)
    const lanes: number[] = []
    return entries.map(({ entry, start, end }) => {
      let lane = lanes.findIndex((laneEnd) => start >= laneEnd - 1000)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(end)
      } else {
        lanes[lane] = end
      }
      const left = ((start - dayStart) / DAY_DURATION_MS) * 100
      const rawWidth = ((end - start) / DAY_DURATION_MS) * 100
      const safeLeft = Math.min(Math.max(left, 0), 100)
      const maxWidth = Math.max(100 - safeLeft, 0)
      const widthPercent = Math.min(Math.max(rawWidth, 0.8), maxWidth)
      const labelSource = entry.goalName?.trim().length ? entry.goalName! : entry.taskName
      const metadata = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup)
      const gradientCss = metadata.colorInfo?.gradient?.css
      const solidColor = metadata.colorInfo?.solidColor
      const fallbackLabel =
        labelSource && labelSource.trim().length > 0 ? labelSource : metadata.label ?? 'Session'
      const color =
        gradientCss ?? solidColor ?? getPaletteColorForLabel(fallbackLabel && fallbackLabel.trim().length > 0 ? fallbackLabel : 'Session')
      const goalLabel = metadata.label
      const bucketLabel = entry.bucketName && entry.bucketName.trim().length > 0 ? entry.bucketName : ''
      const originalRangeLabel = formatDateRange(entry.startedAt, entry.endedAt)
      const tooltipTask =
        entry.taskName.trim().length > 0 ? entry.taskName : goalLabel !== UNCATEGORISED_LABEL ? goalLabel : 'Focus Session'
      return {
        id: entry.id,
        entry,
        start,
        end,
        lane,
        leftPercent: safeLeft,
        widthPercent,
        color,
        gradientCss,
        colorInfo: metadata.colorInfo,
        goalLabel,
        bucketLabel,
        deletable: entry.id !== 'active-session',
        originalRangeLabel,
        tooltipTask,
      }
    })
  }, [effectiveHistory, dayStart, dayEnd, enhancedGoalLookup, goalColorLookup, dragPreview])
  const timelineRowCount = daySegments.length > 0 ? daySegments.reduce((max, segment) => Math.max(max, segment.lane), 0) + 1 : 1
  const showCurrentTimeIndicator = typeof currentTimePercent === 'number' && editingHistoryId === null
  const timelineStyle = useMemo(() => ({ '--history-timeline-rows': timelineRowCount } as CSSProperties), [timelineRowCount])
  const timelineTicks = useMemo(() => {
    const ticks: Array<{ hour: number; showLabel: boolean }> = []
    for (let hour = 0; hour <= 24; hour += 1) {
      const isLabeledTick = hour % 6 === 0 && hour < 24
      ticks.push({ hour, showLabel: isLabeledTick })
    }
    return ticks
  }, [])
  const anchoredTooltipId = hoveredHistoryId ?? selectedHistoryId
  const dayEntryCount = daySegments.length
  const dayLabel = useMemo(() => {
    const date = new Date(dayStart)
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  }, [dayStart])

  const handleWindowPointerMove = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current
      if (!state || event.pointerId !== state.pointerId || state.rectWidth <= 0) {
        return
      }

      const deltaPx = event.clientX - state.startX
      const deltaMsRaw = (deltaPx / state.rectWidth) * DAY_DURATION_MS
      if (!Number.isFinite(deltaMsRaw)) {
        return
      }
      const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
      const deltaMs = deltaMinutes * MINUTE_MS

      let nextStart = state.initialStart
      let nextEnd = state.initialEnd

      if (state.type === 'move') {
        nextStart = state.initialStart + deltaMs
        nextEnd = state.initialEnd + deltaMs

        const overflowLeft = state.dayStart - nextStart
        if (overflowLeft > 0) {
          nextStart += overflowLeft
          nextEnd += overflowLeft
        }
        const overflowRight = nextEnd - state.dayEnd
        if (overflowRight > 0) {
          nextStart -= overflowRight
          nextEnd -= overflowRight
        }
      } else if (state.type === 'resize-start') {
        nextStart = state.initialStart + deltaMs
        const maxStart = state.initialEnd - state.minDurationMs
        if (nextStart > maxStart) {
          nextStart = maxStart
        }
        if (nextStart < state.dayStart) {
          nextStart = state.dayStart
        }
        nextEnd = state.initialEnd
      } else {
        nextEnd = state.initialEnd + deltaMs
        const minEnd = state.initialStart + state.minDurationMs
        if (nextEnd < minEnd) {
          nextEnd = minEnd
        }
        if (nextEnd > state.dayEnd) {
          nextEnd = state.dayEnd
        }
        nextStart = state.initialStart
      }

      if (nextEnd - nextStart < state.minDurationMs) {
        if (state.type === 'resize-start') {
          nextStart = nextEnd - state.minDurationMs
        } else {
          nextEnd = nextStart + state.minDurationMs
        }
      }

      nextStart = Math.max(state.dayStart, Math.min(nextStart, state.dayEnd - state.minDurationMs))
      nextEnd = Math.min(state.dayEnd, Math.max(nextEnd, state.dayStart + state.minDurationMs))

      const movedEnough = Math.abs(deltaPx) >= DRAG_DETECTION_THRESHOLD_PX
      if (movedEnough && !state.hasMoved) {
        state.hasMoved = true
        dragPreventClickRef.current = true
      }

      if (!state.hasMoved) {
        return
      }

      event.preventDefault()

      const nextStartRounded = Math.round(nextStart)
      const nextEndRounded = Math.round(nextEnd)
      const currentPreview = dragPreviewRef.current
      if (
        currentPreview &&
        currentPreview.entryId === state.entryId &&
        currentPreview.startedAt === nextStartRounded &&
        currentPreview.endedAt === nextEndRounded
      ) {
        return
      }

      const nextPreview = { entryId: state.entryId, startedAt: nextStartRounded, endedAt: nextEndRounded }
      dragPreviewRef.current = nextPreview
      setDragPreview(nextPreview)
    },
    [],
  )

  const handleWindowPointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }

      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerUp)

      const preview = dragPreviewRef.current
      if (state.hasMoved && preview && preview.entryId === state.entryId) {
        updateHistory((current) => {
          const index = current.findIndex((entry) => entry.id === preview.entryId)
          if (index === -1) {
            return current
          }
          const target = current[index]
          if (target.startedAt === preview.startedAt && target.endedAt === preview.endedAt) {
            return current
          }
          const next = [...current]
          next[index] = {
            ...target,
            startedAt: preview.startedAt,
            endedAt: preview.endedAt,
            elapsed: Math.max(preview.endedAt - preview.startedAt, 1),
          }
          return next
        })
        if (selectedHistoryIdRef.current === state.entryId) {
          setHistoryDraft((draft) => ({
            ...draft,
            startedAt: preview.startedAt,
            endedAt: preview.endedAt,
          }))
        }
      }

      dragStateRef.current = null
      dragPreviewRef.current = null
      setDragPreview(null)
      dragPreventClickRef.current = state.hasMoved
    },
    [handleWindowPointerMove, setHistoryDraft, updateHistory],
  )

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerUp)
    },
    [handleWindowPointerMove, handleWindowPointerUp],
  )

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, segment: TimelineSegment, type: DragKind) => {
      if (segment.entry.id === 'active-session') {
        return
      }
      if (event.button !== 0) {
        return
      }
      if (dragStateRef.current) {
        return
      }
      const bar = timelineBarRef.current
      if (!bar) {
        return
      }
      const rect = bar.getBoundingClientRect()
      if (!rect || rect.width <= 0) {
        return
      }
      dragStateRef.current = {
        entryId: segment.entry.id,
        type,
        pointerId: event.pointerId,
        rectWidth: rect.width,
        startX: event.clientX,
        initialStart: segment.entry.startedAt,
        initialEnd: segment.entry.endedAt,
        dayStart,
        dayEnd,
        minDurationMs: MIN_SESSION_DURATION_DRAG_MS,
        hasMoved: false,
      }
      dragPreventClickRef.current = false
      dragPreviewRef.current = null
      setDragPreview(null)
      event.stopPropagation()
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
      window.addEventListener('pointercancel', handleWindowPointerUp)
    },
    [dayStart, dayEnd, handleWindowPointerMove, handleWindowPointerUp],
  )

  return (
    <section className="site-main__inner reflection-page" aria-label="Reflection">
      <div className="reflection-intro">
        <h1 className="reflection-title">Reflection</h1>
        <p className="reflection-subtitle">Review your progress and capture insights to guide tomorrow.</p>
      </div>

      <section
        className={`history-section${dayEntryCount > 0 ? '' : ' history-section--empty'}`}
        aria-label="Session History"
      >
        <div className="history-controls history-controls--floating">
          <button
            type="button"
            className="history-controls__button"
            onClick={handleUndoDelete}
            disabled={deletedHistoryStack.length === 0}
            aria-label="Undo last deleted session"
          >
            Undo
          </button>
          <button
            type="button"
            className="history-controls__button history-controls__button--primary"
            onClick={handleAddHistoryEntry}
            aria-label="Add a new history session"
          >
            Add history
          </button>
        </div>
        <div className="history-section__header">
          <div className="history-section__title">
            <h2 className="history-heading">Session History</h2>
            <p className="history-section__date">{dayLabel}</p>
          </div>
        </div>

        <div
          className="history-timeline"
          style={timelineStyle}
          ref={timelineRef}
          onClick={handleTimelineBackgroundClick}
        >
          <div className="history-timeline__bar" ref={timelineBarRef}>
            {showCurrentTimeIndicator ? (
              <div
                className="history-timeline__current-time"
                style={{ left: `${currentTimePercent}%` }}
                aria-hidden="true"
              />
            ) : null}
            {daySegments.length === 0 ? <p className="history-timeline__empty">No sessions logged yet today</p> : null}
            {daySegments.map((segment) => {
              const isSelected = segment.entry.id === selectedHistoryId
              const isActiveSegment = segment.entry.id === 'active-session'
              const isEditing = editingHistoryId === segment.entry.id
              const isActiveSessionSegment = segment.entry.id === 'active-session'
              const isDragging = dragPreview?.entryId === segment.entry.id
              const trimmedTaskDraft = historyDraft.taskName.trim()
              const displayTask = isSelected
                ? trimmedTaskDraft.length > 0
                  ? trimmedTaskDraft
                  : segment.tooltipTask
                : segment.tooltipTask
              const trimmedGoalDraft = historyDraft.goalName.trim()
              const displayGoal = isSelected
                ? trimmedGoalDraft.length > 0
                  ? trimmedGoalDraft
                  : segment.goalLabel
                : segment.goalLabel
              const trimmedBucketDraft = historyDraft.bucketName.trim()
              const displayBucket = isSelected
                ? trimmedBucketDraft.length > 0
                  ? trimmedBucketDraft
                  : segment.bucketLabel
                : segment.bucketLabel
              const baseStartedAt = segment.entry.startedAt
              const baseEndedAt = segment.entry.endedAt
              const resolvedStartedAt = isSelected ? resolveTimestamp(historyDraft.startedAt, baseStartedAt) : baseStartedAt
              const resolvedEndedAt = isSelected ? resolveTimestamp(historyDraft.endedAt, baseEndedAt) : baseEndedAt
              const resolvedDurationMs = Math.max(resolvedEndedAt - resolvedStartedAt, 0)
              const startTimeInputValue = formatTimeInputValue(resolvedStartedAt)
              const endTimeInputValue = formatTimeInputValue(resolvedEndedAt)
              const durationMinutesValue = Math.max(1, Math.round(resolvedDurationMs / MINUTE_MS)).toString()
              const handleStartTimeInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const { value } = event.target
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) {
                    return draft
                  }
                  if (value.trim().length === 0) {
                    return { ...draft, startedAt: null }
                  }
                  const reference = resolveTimestamp(draft.startedAt, baseStartedAt)
                  const parsed = applyTimeToTimestamp(reference, value)
                  if (parsed === null) {
                    return draft
                  }
                  return { ...draft, startedAt: parsed }
                })
              }
              const handleEndTimeInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const { value } = event.target
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) {
                    return draft
                  }
                  if (value.trim().length === 0) {
                    return { ...draft, endedAt: null }
                  }
                  const reference = resolveTimestamp(draft.endedAt, baseEndedAt)
                  const parsed = applyTimeToTimestamp(reference, value)
                  if (parsed === null) {
                    return draft
                  }
                  return { ...draft, endedAt: parsed }
                })
              }
              const handleDurationInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const value = event.target.value
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) {
                    return draft
                  }
                  if (value.trim().length === 0) {
                    return draft
                  }
                  const minutes = Number(value)
                  if (!Number.isFinite(minutes) || minutes <= 0) {
                    return draft
                  }
                  const normalizedMinutes = Math.max(1, Math.round(minutes))
                  const baseStart = resolveTimestamp(draft.startedAt, baseStartedAt)
                  return { ...draft, endedAt: baseStart + normalizedMinutes * MINUTE_MS }
                })
              }
              const handleBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'move')
              }
              const handleResizeStartPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-start')
              }
              const handleResizeEndPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-end')
              }
              const blockClassName = [
                'history-timeline__block',
                isActiveSegment ? 'history-timeline__block--active' : '',
                isSelected ? 'history-timeline__block--selected' : '',
                isDragging ? 'history-timeline__block--dragging' : '',
              ]
                .filter(Boolean)
                .join(' ')
              const isAnchoredTooltip = segment.entry.id === anchoredTooltipId
              const tooltipClassName = `history-timeline__tooltip${isSelected ? ' history-timeline__tooltip--pinned' : ''}${
                isEditing ? ' history-timeline__tooltip--editing' : ''
              }`
              const overlayTitleId = `history-tooltip-title-${segment.id}`
              const tooltipContent = (
                <div className="history-timeline__tooltip-content">
                  <p className="history-timeline__tooltip-task" id={overlayTitleId}>
                    {displayTask}
                  </p>
                  <p className="history-timeline__tooltip-time">
                    {formatTimeOfDay(resolvedStartedAt)} — {formatTimeOfDay(resolvedEndedAt)}
                  </p>
                  <p className="history-timeline__tooltip-meta">
                    {displayGoal}
                    {displayBucket && displayBucket !== displayGoal ? ` → ${displayBucket}` : ''}
                  </p>
                  <p className="history-timeline__tooltip-duration">{formatDuration(resolvedDurationMs)}</p>
                  {isSelected ? (
                    <>
                      {isEditing ? (
                        <>
                          <div className="history-timeline__tooltip-form">
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Session name</span>
                              <input
                                className="history-timeline__field-input"
                                type="text"
                                value={historyDraft.taskName}
                                placeholder={segment.tooltipTask}
                                onChange={handleHistoryFieldChange('taskName')}
                                onKeyDown={handleHistoryFieldKeyDown}
                              />
                            </label>
                            <div className="history-timeline__field-group">
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">Start time</span>
                                <input
                                  className="history-timeline__field-input"
                                  type="time"
                                  step={60}
                                  value={startTimeInputValue}
                                  onChange={handleStartTimeInputChange}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                              </label>
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">End time</span>
                                <input
                                  className="history-timeline__field-input"
                                  type="time"
                                  step={60}
                                  value={endTimeInputValue}
                                  onChange={handleEndTimeInputChange}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                              </label>
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">Duration (minutes)</span>
                                <input
                                  className="history-timeline__field-input"
                                  type="number"
                                  min={1}
                                  inputMode="numeric"
                                  value={durationMinutesValue}
                                  onChange={handleDurationInputChange}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                              </label>
                            </div>
                            <div className="history-timeline__field-group">
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">Goal</span>
                                <select
                                  className="history-timeline__field-input history-timeline__field-input--select"
                                  value={historyDraft.goalName}
                                  onChange={handleHistoryFieldChange('goalName')}
                                >
                                  <option value="">No goal</option>
                                  {resolvedGoalOptions.map((option) => (
                                    <option key={`goal-option-${option}`} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">Bucket</span>
                                <select
                                  className="history-timeline__field-input history-timeline__field-input--select"
                                  value={historyDraft.bucketName}
                                  onChange={handleHistoryFieldChange('bucketName')}
                                  disabled={availableBucketOptions.length === 0}
                                >
                                  <option value="">No bucket</option>
                                  {resolvedBucketOptions.map((option) => (
                                    <option key={`bucket-option-${option}`} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          </div>
                          <div className="history-timeline__actions">
                            <button
                              type="button"
                              className="history-timeline__action-button history-timeline__action-button--primary"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleSaveHistoryDraft()
                              }}
                            >
                              Save changes
                            </button>
                            <button
                              type="button"
                              className="history-timeline__action-button"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleCancelHistoryEdit()
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="history-timeline__actions">
                          <button
                            type="button"
                            className="history-timeline__action-button history-timeline__action-button--primary"
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!isActiveSessionSegment) {
                                handleStartEditingHistoryEntry(segment.entry)
                              }
                            }}
                            disabled={isActiveSessionSegment}
                          >
                            Edit details
                          </button>
                        </div>
                      )}
                      {isActiveSessionSegment ? (
                        <p className="history-timeline__tooltip-note">Active session updates live; finish to edit details.</p>
                      ) : null}
                    </>
                  ) : null}
                  {segment.deletable ? (
                    <button
                      type="button"
                      className="history-timeline__tooltip-delete"
                      onClick={handleDeleteHistoryEntry(segment.entry.id)}
                    >
                      Delete session
                    </button>
                  ) : null}
                </div>
              )
              const tooltipCommonProps: HTMLAttributes<HTMLDivElement> = {
                className: tooltipClassName,
                role: 'presentation',
                onClick: (event) => event.stopPropagation(),
                onMouseDown: (event) => event.stopPropagation(),
                onPointerDown: (event) => event.stopPropagation(),
              }

              const inlineTooltip = (
                <div
                  {...tooltipCommonProps}
                  ref={isAnchoredTooltip && !isEditing ? setActiveTooltipNode : null}
                  style={
                    isAnchoredTooltip && !isEditing
                      ? ({
                          '--history-tooltip-shift-x': `${activeTooltipOffsets.x}px`,
                          '--history-tooltip-shift-y': `${activeTooltipOffsets.y}px`,
                        } as CSSProperties)
                      : undefined
                  }
                >
                  {tooltipContent}
                </div>
              )

              const renderedTooltip =
                isEditing && typeof document !== 'undefined'
                  ? createPortal(
                      <div {...tooltipCommonProps}>{tooltipContent}</div>,
                      document.body,
                    )
                  : inlineTooltip

              return (
                <div
                  key={`${segment.id}-${segment.start}-${segment.end}`}
                  className={blockClassName}
                  style={{
                    left: `${segment.leftPercent}%`,
                    width: `${segment.widthPercent}%`,
                    top: `calc(${segment.lane} * var(--history-timeline-row-height))`,
                    background: segment.gradientCss ?? segment.color,
                  }}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`${segment.tooltipTask} from ${formatTimeOfDay(resolvedStartedAt)} to ${formatTimeOfDay(resolvedEndedAt)}`}
                  onPointerDown={handleBlockPointerDown}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (dragPreventClickRef.current) {
                      dragPreventClickRef.current = false
                      return
                    }
                    handleSelectHistorySegment(segment.entry)
                  }}
                  onMouseEnter={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? current : segment.entry.id))
                  }
                  onMouseLeave={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? null : current))
                  }
                  onFocus={() => setHoveredHistoryId(segment.entry.id)}
                  onBlur={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? null : current))
                  }
                  onKeyDown={handleTimelineBlockKeyDown(segment.entry)}
                >
                  <div
                    className="history-timeline__block-handle history-timeline__block-handle--start"
                    role="presentation"
                    aria-hidden="true"
                    onPointerDown={handleResizeStartPointerDown}
                  />
                  <div
                    className="history-timeline__block-handle history-timeline__block-handle--end"
                    role="presentation"
                    aria-hidden="true"
                    onPointerDown={handleResizeEndPointerDown}
                  />
                  {renderedTooltip}
                </div>
              )
            })}
          </div>
          <div className="history-timeline__axis">
            {timelineTicks.map((tick, index) => {
              const isFirstTick = index === 0
              const isLastTick = index === timelineTicks.length - 1
              const { hour, showLabel } = tick
              const tickClassName = [
                'history-timeline__tick',
                isFirstTick ? 'history-timeline__tick--first' : '',
                isLastTick ? 'history-timeline__tick--last' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={`tick-${hour}`}
                  className={tickClassName}
                  style={{ left: `${(hour / 24) * 100}%` }}
                >
                  <span
                    className={`history-timeline__tick-line${showLabel ? ' history-timeline__tick-line--major' : ''}`}
                  />
                  <span
                    className={`history-timeline__tick-label${showLabel ? '' : ' history-timeline__tick-label--hidden'}`}
                    aria-hidden={!showLabel}
                  >
                    {formatHourLabel(hour)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </section>

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
                  className="reflection-pie__slice reflection-pie__slice--unlogged"
                  d={FULL_DONUT_PATH}
                  fill="var(--reflection-chart-unlogged-soft)"
                  stroke="var(--reflection-chart-unlogged-stroke)"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                  fillRule="evenodd"
                  clipRule="evenodd"
                />
              ) : (
                pieArcs.map((arc) => {
                  if (arc.isUnlogged) {
                    return (
                      <path
                        key={arc.id}
                        className="reflection-pie__slice reflection-pie__slice--unlogged"
                        d={arc.path}
                        fill={arc.fill}
                        fillRule="evenodd"
                        clipRule="evenodd"
                      />
                    )
                  }
                  const slices = buildArcLoopSlices(arc)
                  return (
                    <g key={arc.id}>
                      {slices.map((slice) => (
                        <path
                          key={slice.key}
                          className="reflection-pie__slice"
                          d={slice.path}
                          fill={slice.color}
                          fillRule="evenodd"
                          clipRule="evenodd"
                        />
                      ))}
                    </g>
                  )
                })
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
                <span className="reflection-legend__swatch" style={{ background: segment.swatch }} aria-hidden="true" />
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
