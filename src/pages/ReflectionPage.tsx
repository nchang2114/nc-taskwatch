import {
  useCallback,
  useEffect,
  useId,
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
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  LIFE_ROUTINE_DEFAULTS,
  LIFE_ROUTINE_STORAGE_KEY,
  LIFE_ROUTINE_UPDATE_EVENT,
  readStoredLifeRoutines,
  sanitizeLifeRoutineList,
  type LifeRoutineConfig,
} from '../lib/lifeRoutines'
import {
  CURRENT_SESSION_EVENT_NAME,
  CURRENT_SESSION_STORAGE_KEY,
  HISTORY_EVENT_NAME,
  HISTORY_STORAGE_KEY,
  readStoredHistory as readPersistedHistory,
  persistHistorySnapshot,
  syncHistoryWithSupabase,
  type HistoryEntry,
} from '../lib/sessionHistory'

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

type HistoryDraftState = {
  taskName: string
  goalName: string
  bucketName: string
  startedAt: number | null
  endedAt: number | null
}

type GradientStop = {
  position: number
  color: string
}

type GoalGradientInfo = {
  start: string
  end: string
  angle?: number
  css: string
  stops: GradientStop[]
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

const UNCATEGORISED_LABEL = 'Uncategorised'
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f97316', '#f472b6', '#a855f7', '#4ade80', '#60a5fa', '#facc15', '#38bdf8', '#fb7185']
const LIFE_ROUTINES_NAME = 'Life Routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'
const LIFE_ROUTINE_DEFAULT_SURFACE_LOOKUP = new Map(
  LIFE_ROUTINE_DEFAULTS.map((routine) => [routine.title.toLowerCase(), routine.surfaceStyle]),
)

type SurfaceGradientInfo = {
  gradient: string
  start: string
  mid: string
  end: string
  base: string
}

const SURFACE_GRADIENT_INFO: Record<SurfaceStyle, SurfaceGradientInfo> = {
  glass: {
    gradient: 'linear-gradient(135deg, #313c67 0%, #1f2952 45%, #121830 100%)',
    start: '#313c67',
    mid: '#1f2952',
    end: '#121830',
    base: '#1f2952',
  },
  midnight: {
    gradient: 'linear-gradient(135deg, #8e9bff 0%, #6c86ff 45%, #3f51b5 100%)',
    start: '#8e9bff',
    mid: '#6c86ff',
    end: '#3f51b5',
    base: '#5a63f1',
  },
  slate: {
    gradient: 'linear-gradient(135deg, #97e3ff 0%, #5ec0ff 45%, #1f7adb 100%)',
    start: '#97e3ff',
    mid: '#5ec0ff',
    end: '#1f7adb',
    base: '#45b0ff',
  },
  charcoal: {
    gradient: 'linear-gradient(135deg, #ffb8d5 0%, #f472b6 45%, #be3a84 100%)',
    start: '#ffb8d5',
    mid: '#f472b6',
    end: '#be3a84',
    base: '#f472b6',
  },
  linen: {
    gradient: 'linear-gradient(135deg, #ffd4aa 0%, #f9a84f 45%, #d97706 100%)',
    start: '#ffd4aa',
    mid: '#f9a84f',
    end: '#d97706',
    base: '#f9a84f',
  },
  frost: {
    gradient: 'linear-gradient(135deg, #aee9ff 0%, #6dd3ff 45%, #1d9bf0 100%)',
    start: '#aee9ff',
    mid: '#6dd3ff',
    end: '#1d9bf0',
    base: '#38bdf8',
  },
  grove: {
    gradient: 'linear-gradient(135deg, #baf5d8 0%, #4ade80 45%, #15803d 100%)',
    start: '#baf5d8',
    mid: '#4ade80',
    end: '#15803d',
    base: '#34d399',
  },
  lagoon: {
    gradient: 'linear-gradient(135deg, #a7dcff 0%, #60a5fa 45%, #2563eb 100%)',
    start: '#a7dcff',
    mid: '#60a5fa',
    end: '#2563eb',
    base: '#3b82f6',
  },
  ember: {
    gradient: 'linear-gradient(135deg, #ffd5b5 0%, #fb923c 45%, #c2410c 100%)',
    start: '#ffd5b5',
    mid: '#fb923c',
    end: '#c2410c',
    base: '#f97316',
  },
}

type HistoryDropdownOption = {
  value: string
  label: string
  disabled?: boolean
}

type HistoryDropdownProps = {
  id?: string
  value: string
  placeholder: string
  options: HistoryDropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
}

const HistoryDropdown = ({ id, value, placeholder, options, onChange, disabled }: HistoryDropdownProps) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pointerSelectionRef = useRef(false)
  const previousValueRef = useRef(value)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 })
  const [menuPositionReady, setMenuPositionReady] = useState(false)

  const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value])
  const displayLabel = selectedOption?.label ?? placeholder
  const isPlaceholder = !selectedOption

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current
    const menu = menuRef.current
    if (!button || !menu) {
      return
    }
    const buttonRect = button.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const spacing = 8
    
    let left = buttonRect.left
    let top = buttonRect.bottom + spacing
    const width = buttonRect.width
    
    // Ensure menu doesn't go off-screen horizontally
    if (left + width > window.innerWidth - 16) {
      left = window.innerWidth - width - 16
    }
    if (left < 16) {
      left = 16
    }
    
    // If menu would go below viewport, show it above the button instead
    if (top + menuRect.height > window.innerHeight - 16) {
      top = buttonRect.top - menuRect.height - spacing
    }
    
    setMenuPosition({ top, left, width })
    setMenuPositionReady(true)
  }, [])

  useEffect(() => {
    if (!open) {
      setMenuPositionReady(false)
      return
    }
    
    // Update position when opened
    updateMenuPosition()
    
    // Update position on scroll/resize
    const handleUpdate = () => updateMenuPosition()
    window.addEventListener('scroll', handleUpdate, true)
    window.addEventListener('resize', handleUpdate)
    
    return () => {
      window.removeEventListener('scroll', handleUpdate, true)
      window.removeEventListener('resize', handleUpdate)
    }
  }, [open, updateMenuPosition])

  useEffect(() => {
    if (!open) {
      return
    }
    const handleClickOutside = (event: Event) => {
      const container = containerRef.current
      const menu = menuRef.current
      
      // If click is on the button itself, let the button handler deal with it
      if (container && event.target instanceof Node && container.contains(event.target)) {
        return
      }
      
      // If click is on the menu, don't close
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return
      }
      
      // Click is outside both - close the dropdown
      setOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleClickOutside, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled && open) {
      setOpen(false)
    }
  }, [disabled, open])

  useEffect(() => {
    if (previousValueRef.current !== value) {
      previousValueRef.current = value
      if (open) {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
  }, [open, value])

  useEffect(() => {
    if (!open) {
      return
    }
    const focusTarget = () => {
      const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
      const fallbackIndex = options.findIndex((option) => !option.disabled)
      const targetIndex = selectedIndex !== -1 ? selectedIndex : fallbackIndex
      if (targetIndex === -1) {
        return
      }
      const target = optionRefs.current[targetIndex]
      if (target) {
        target.focus()
      }
    }
    const frame = window.requestAnimationFrame(focusTarget)
    return () => window.cancelAnimationFrame(frame)
  }, [open, options, value])

  const findNextEnabledIndex = useCallback(
    (startIndex: number, direction: 1 | -1) => {
      if (options.length === 0) {
        return -1
      }
      let index = startIndex
      for (let attempt = 0; attempt < options.length; attempt += 1) {
        index = (index + direction + options.length) % options.length
        if (!options[index]?.disabled) {
          return index
        }
      }
      return -1
    },
    [options],
  )

  const focusOptionAt = useCallback(
    (targetIndex: number) => {
      if (targetIndex === -1) {
        return
      }
      const target = optionRefs.current[targetIndex]
      if (target) {
        target.focus()
      }
    },
    [],
  )

  const handleButtonClick = useCallback(() => {
    if (disabled) {
      return
    }
    setOpen((current) => !current)
  }, [disabled])

  const handleButtonKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
        const direction: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1
        const startIndex = selectedIndex !== -1 ? selectedIndex : direction === 1 ? -1 : 0
        const nextIndex = findNextEnabledIndex(startIndex, direction)
        focusOptionAt(nextIndex)
      }
    },
    [disabled, findNextEnabledIndex, focusOptionAt, open, options, value],
  )

  const handleOptionSelect = useCallback(
    (nextValue: string) => {
      onChange(nextValue)
      setOpen(false)
      buttonRef.current?.focus()
    },
    [onChange],
  )

  const handleOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, optionIndex: number) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = findNextEnabledIndex(optionIndex, direction)
        focusOptionAt(nextIndex)
      } else if (event.key === 'Home') {
        event.preventDefault()
        const firstIndex = options.findIndex((option) => !option.disabled)
        focusOptionAt(firstIndex)
      } else if (event.key === 'End') {
        event.preventDefault()
        let lastIndex = -1
        for (let i = options.length - 1; i >= 0; i -= 1) {
          if (!options[i]?.disabled) {
            lastIndex = i
            break
          }
        }
        focusOptionAt(lastIndex)
      } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        const option = options[optionIndex]
        if (!option?.disabled) {
          handleOptionSelect(option.value)
          pointerSelectionRef.current = false
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
      }
    },
    [findNextEnabledIndex, focusOptionAt, handleOptionSelect, options],
  )

  return (
    <div className="history-dropdown" ref={containerRef}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        className={[
          'history-dropdown__button',
          'history-timeline__field-input',
          'history-timeline__field-input--select',
          open ? 'history-dropdown__button--open' : '',
          disabled ? 'history-dropdown__button--disabled' : '',
          isPlaceholder ? 'history-dropdown__button--placeholder' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        onClick={handleButtonClick}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
      >
        <span className="history-dropdown__value">{displayLabel}</span>
        <span className="history-dropdown__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              className="history-dropdown__menu history-dropdown__menu--overlay"
              aria-labelledby={id}
              tabIndex={-1}
              style={{
                position: 'fixed',
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
                width: `${menuPosition.width}px`,
                visibility: menuPositionReady ? 'visible' : 'hidden',
              }}
            >
              {options.length === 0 ? (
                <div className="history-dropdown__empty">No options</div>
              ) : (
                options.map((option, index) => (
                  <button
                    key={`${option.value || 'empty-option'}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={[
                      'history-dropdown__option',
                      option.value === value ? 'history-dropdown__option--selected' : '',
                      option.disabled ? 'history-dropdown__option--disabled' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onPointerDown={(event) => {
                      if (option.disabled) {
                        event.preventDefault()
                        return
                      }
                      pointerSelectionRef.current = true
                      event.preventDefault()
                      handleOptionSelect(option.value)
                    }}
                    onClick={(event) => {
                      if (option.disabled) {
                        event.preventDefault()
                        return
                      }
                      if (pointerSelectionRef.current) {
                        pointerSelectionRef.current = false
                        return
                      }
                      event.preventDefault()
                      handleOptionSelect(option.value)
                    }}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    disabled={option.disabled}
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    tabIndex={-1}
                  >
                    {option.label}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

const getSurfaceColorInfo = (surface: SurfaceStyle): GoalColorInfo => {
  const info = SURFACE_GRADIENT_INFO[surface]
  return {
    gradient: {
      css: info.gradient,
      start: info.start,
      end: info.end,
      angle: 135,
      stops: [
        { color: info.start, position: 0 },
        { color: info.mid, position: 0.45 },
        { color: info.end, position: 1 },
      ],
    },
    solidColor: info.base,
  }
}

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

type LoopSlice = {
  key: string
  path: string
  color: string
}

const sampleGradientColor = (
  colorInfo: GoalColorInfo | undefined,
  fallback: string,
  ratio: number,
): string => {
  const normalizedFallback = normalizeHexColor(fallback) ?? fallback
  const gradient = colorInfo?.gradient
  if (gradient && gradient.stops.length >= 2) {
    const t = clamp01(ratio)
    const stops = gradient.stops
    let previous = stops[0]
    for (let index = 1; index < stops.length; index += 1) {
      const current = stops[index]
      if (t <= current.position) {
        const span = current.position - previous.position
        const local = span <= 0 ? 0 : clamp01((t - previous.position) / span)
        return mixHexColors(previous.color, current.color, local)
      }
      previous = current
    }
    return stops[stops.length - 1].color
  }
  if (colorInfo?.solidColor) {
    return colorInfo.solidColor
  }
  return normalizedFallback
}

const GRADIENT_SLICE_DEGREES = 0.25
const GRADIENT_MIN_SLICES = 48
const GRADIENT_MAX_SLICES = 1440

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
  const gradient = arc.colorInfo?.gradient
  const sliceCount = gradient
    ? Math.min(
        GRADIENT_MAX_SLICES,
        Math.max(
          GRADIENT_MIN_SLICES,
          Math.ceil(span / Math.max(GRADIENT_SLICE_DEGREES, ARC_EPSILON)),
        ),
      )
    : 1
  const slices: LoopSlice[] = []
  for (let index = 0; index < sliceCount; index += 1) {
    const sliceStart = arc.startAngle + (span * index) / sliceCount
    const sliceEnd = index === sliceCount - 1 ? arc.endAngle : arc.startAngle + (span * (index + 1)) / sliceCount
    if (sliceEnd - sliceStart <= ARC_EPSILON) {
      continue
    }
    const midAngle = sliceStart + (sliceEnd - sliceStart) / 2
    const localRatio = span <= 0 ? 0 : clamp01((midAngle - arc.startAngle) / span)
    const color = sampleGradientColor(arc.colorInfo, arc.baseColor, localRatio)
    slices.push({
      key: `${arc.id}-slice-${index}`,
      path: describeDonutSlice(sliceStart, sliceEnd),
      color,
    })
  }
  return slices
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
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
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

const resolveCssColor = (value: string, fallback?: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('var(') && typeof window !== 'undefined' && typeof document !== 'undefined') {
    const content = trimmed.slice(4, -1)
    const [rawName, ...rest] = content.split(',')
    const variableName = rawName.trim()
    const fallbackValue = rest.join(',').trim()
    const computed = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim()
    if (computed.length > 0) {
      return computed
    }
    if (fallbackValue.length > 0) {
      return resolveCssColor(fallbackValue, fallback)
    }
    if (typeof fallback === 'string' && fallback !== trimmed) {
      return resolveCssColor(fallback, undefined)
    }
  }
  if (trimmed.length === 0 && typeof fallback === 'string') {
    return fallback
  }
  return trimmed
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

const splitGradientArgs = (value: string): string[] => {
  const result: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') {
      depth += 1
      current += char
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
    } else if (char === ',' && depth === 0) {
      if (current.trim().length > 0) {
        result.push(current.trim())
      }
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim().length > 0) {
    result.push(current.trim())
  }
  return result
}

type PartialGradientStop = {
  color: string
  position?: number
}

const parseGradientStopToken = (token: string): PartialGradientStop | null => {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 0) {
    return null
  }
  const color = normalizeHexColor(parts[0])
  if (!color) {
    return null
  }
  let position: number | undefined
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]
    const match = part.match(/^(-?\d+(?:\.\d+)?)%$/)
    if (match) {
      position = clamp01(Number.parseFloat(match[1]) / 100)
      break
    }
  }
  return { color, position }
}

const normalizeGradientStops = (stops: PartialGradientStop[]): GradientStop[] => {
  if (stops.length < 2) {
    return []
  }
  const working = stops.map((stop) => ({ ...stop }))
  if (working[0].position === undefined) {
    working[0].position = 0
  }
  if (working[working.length - 1].position === undefined) {
    working[working.length - 1].position = 1
  }
  let lastDefinedIndex = 0
  for (let index = 1; index < working.length; index += 1) {
    const stop = working[index]
    if (stop.position !== undefined) {
      const startPos = clamp01(working[lastDefinedIndex].position ?? 0)
      const endPos = clamp01(stop.position)
      const gap = index - lastDefinedIndex
      if (gap > 1) {
        const step = (endPos - startPos) / gap
        for (let offset = 1; offset < gap; offset += 1) {
          const target = working[lastDefinedIndex + offset]
          target.position = clamp01(startPos + step * offset)
        }
      }
      stop.position = endPos
      lastDefinedIndex = index
    }
  }
  for (let index = 0; index < working.length; index += 1) {
    if (working[index].position !== undefined) {
      continue
    }
    const prevIndex = Math.max(0, index - 1)
    let nextIndex = index + 1
    while (nextIndex < working.length && working[nextIndex].position === undefined) {
      nextIndex += 1
    }
    const prevPos = clamp01(working[prevIndex].position ?? 0)
    const nextPos = nextIndex < working.length ? clamp01(working[nextIndex].position ?? prevPos) : prevPos
    const span = nextIndex - prevIndex
    if (span <= 0) {
      working[index].position = prevPos
    } else {
      const relativeIndex = index - prevIndex
      working[index].position = clamp01(prevPos + ((nextPos - prevPos) * relativeIndex) / span)
    }
  }
  return working
    .map<GradientStop>((stop) => ({
      color: stop.color,
      position: clamp01(stop.position ?? 0),
    }))
    .sort((a, b) => a.position - b.position)
}

const parseGoalGradient = (gradient: string): GoalGradientInfo | null => {
  const trimmed = gradient.trim()
  if (!trimmed.toLowerCase().startsWith('linear-gradient')) {
    return null
  }
  const openIndex = trimmed.indexOf('(')
  const closeIndex = trimmed.lastIndexOf(')')
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex + 1) {
    return null
  }
  const inner = trimmed.slice(openIndex + 1, closeIndex)
  const args = splitGradientArgs(inner)
  if (args.length < 2) {
    return null
  }
  let angle: number | undefined
  let stopStartIndex = 0
  const angleMatch = args[0].match(/^(-?\d+(?:\.\d+)?)deg$/i)
  if (angleMatch) {
    angle = Number.parseFloat(angleMatch[1])
    stopStartIndex = 1
  }
  const stopTokens = args.slice(stopStartIndex)
  const partialStops = stopTokens
    .map((token) => parseGradientStopToken(token))
    .filter((stop): stop is PartialGradientStop => Boolean(stop))
  const stops = normalizeGradientStops(partialStops)
  if (stops.length < 2) {
    return null
  }
  return {
    css: gradient,
    start: stops[0].color,
    end: stops[stops.length - 1].color,
    angle,
    stops,
  }
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

  const parsed = parseGoalGradient(gradientString)
  if (parsed) {
    return {
      gradient: parsed,
    }
  }

  const fallback = extractGradientColors(gradientString)
  if (!fallback) {
    return undefined
  }

  return {
    gradient: {
      css: gradientString,
      start: fallback.start,
      end: fallback.end,
      angle: fallback.angle,
      stops: [
        { color: fallback.start, position: 0 },
        { color: fallback.end, position: 1 },
      ],
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
  bucketName: string | null
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle | null
  startedAt: number | null
  baseElapsed: number
  isRunning: boolean
  updatedAt: number
}

const resolveGoalMetadata = (
  entry: HistoryEntry,
  taskLookup: GoalLookup,
  goalColorLookup: Map<string, GoalColorInfo | undefined>,
  lifeRoutineSurfaceLookup: Map<string, SurfaceStyle>,
): GoalMetadata => {
  const goalNameRaw = entry.goalName?.trim()
  const bucketNameRaw = entry.bucketName?.trim()
  const normalizedGoalName = goalNameRaw?.toLowerCase() ?? ''
  const normalizedBucketName = bucketNameRaw?.toLowerCase() ?? ''
  const isLifeRoutineEntry =
    (goalNameRaw && normalizedGoalName === LIFE_ROUTINES_NAME.toLowerCase()) ||
    (bucketNameRaw && lifeRoutineSurfaceLookup.has(normalizedBucketName))

  if (isLifeRoutineEntry) {
    const routineSurface =
      entry.bucketSurface ?? (normalizedBucketName ? lifeRoutineSurfaceLookup.get(normalizedBucketName) ?? null : null)
    const surfaceInfo = routineSurface ? getSurfaceColorInfo(routineSurface) : getSurfaceColorInfo(LIFE_ROUTINES_SURFACE)
    const labelCandidate =
      bucketNameRaw && bucketNameRaw.length > 0
        ? bucketNameRaw
        : entry.taskName.trim().length > 0
          ? entry.taskName.trim()
          : LIFE_ROUTINES_NAME
    return { label: labelCandidate, colorInfo: surfaceInfo }
  }

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

  const fallbackSurfaceInfo = getSurfaceColorInfo(entry.goalSurface)
  return { label: UNCATEGORISED_LABEL, colorInfo: fallbackSurfaceInfo }
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
  const rawBucketName = typeof candidate.bucketName === 'string' ? candidate.bucketName.trim() : ''
  const bucketName = rawBucketName.length > 0 ? rawBucketName : null
  const rawGoalId = typeof candidate.goalId === 'string' ? candidate.goalId.trim() : ''
  const goalId = rawGoalId.length > 0 ? rawGoalId : null
  const rawBucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId.trim() : ''
  const bucketId = rawBucketId.length > 0 ? rawBucketId : null
  const rawTaskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : ''
  const taskId = rawTaskId.length > 0 ? rawTaskId : null
  const sanitizedGoalSurface = sanitizeSurfaceStyle(candidate.goalSurface)
  const goalSurface = ensureSurfaceStyle(
    sanitizedGoalSurface ?? DEFAULT_SURFACE_STYLE,
    DEFAULT_SURFACE_STYLE,
  )
  const sanitizedBucketSurface = sanitizeSurfaceStyle(candidate.bucketSurface)
  const bucketSurface = sanitizedBucketSurface ?? null
  const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
  const baseElapsed = typeof candidate.baseElapsed === 'number' ? Math.max(0, candidate.baseElapsed) : 0
  const isRunning = Boolean(candidate.isRunning)
  const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
  return {
    taskName,
    goalName,
    bucketName,
    goalId,
    bucketId,
    taskId,
    goalSurface,
    bucketSurface,
    startedAt,
    baseElapsed,
    isRunning,
    updatedAt,
  }
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
  lifeRoutineSurfaceLookup: Map<string, SurfaceStyle>,
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
    const metadata = resolveGoalMetadata(entry, taskLookup, goalColorLookup, lifeRoutineSurfaceLookup)
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
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
  const latestHistoryRef = useRef(history)
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => readStoredGoalsSnapshot())
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(() => readStoredActiveSession())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [historyDayOffset, setHistoryDayOffset] = useState(0)
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
  const [hoveredDuringDragId, setHoveredDuringDragId] = useState<string | null>(null)
  const pieCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [supportsConicGradient, setSupportsConicGradient] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const context = document.createElement('canvas').getContext('2d')
    return Boolean(context && 'createConicGradient' in context)
  })
  const [themeToken, setThemeToken] = useState(() => {
    if (typeof document === 'undefined') {
      return 'dark'
    }
    return document.documentElement.getAttribute('data-theme') ?? 'dark'
  })
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

  useEffect(() => {
    if (supportsConicGradient || typeof window === 'undefined') {
      return
    }
    const context = document.createElement('canvas').getContext('2d')
    if (context && 'createConicGradient' in context) {
      setSupportsConicGradient(true)
    }
  }, [supportsConicGradient])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return
    }
    const root = document.documentElement
    const handleMutation = () => {
      setThemeToken(root.getAttribute('data-theme') ?? 'dark')
    }
    const observer = new MutationObserver(handleMutation)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSelectedHistoryId(null)
    setHoveredHistoryId(null)
    setEditingHistoryId(null)
    setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
    setDragPreview(null)
    dragStateRef.current = null
    dragPreviewRef.current = null
  }, [historyDayOffset])

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

  const lifeRoutineSurfaceLookup = useMemo(() => {
    const map = new Map<string, SurfaceStyle>(LIFE_ROUTINE_DEFAULT_SURFACE_LOOKUP)
    lifeRoutineTasks.forEach((routine) => {
      const title = routine.title.trim().toLowerCase()
      if (title) {
        map.set(title, routine.surfaceStyle)
      }
    })
    return map
  }, [lifeRoutineTasks])

  const lifeRoutineBucketOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    lifeRoutineTasks.forEach((routine) => {
      const title = routine.title.trim()
      if (!title) {
        return
      }
      const normalized = title.toLowerCase()
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      result.push(title)
    })
    return result.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [lifeRoutineTasks])

  const updateHistory = useCallback((updater: (current: HistoryEntry[]) => HistoryEntry[]) => {
    setHistory((current) => {
      const next = updater(current)
      if (historiesAreEqual(current, next)) {
        return current
      }
      return persistHistorySnapshot(next)
    })
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

  const goalLookup = useMemo(() => createGoalTaskMap(goalsSnapshot), [goalsSnapshot])
  const goalColorLookup = useMemo(() => createGoalColorMap(goalsSnapshot), [goalsSnapshot])
  const goalSurfaceLookup = useMemo(() => {
    const map = new Map<string, SurfaceStyle>()
    goalsSnapshot.forEach((goal) => {
      const name = goal.name?.trim()
      if (!name) {
        return
      }
      map.set(name.toLowerCase(), ensureSurfaceStyle(goal.surfaceStyle, DEFAULT_SURFACE_STYLE))
    })
    return map
  }, [goalsSnapshot])
  const bucketSurfaceLookup = useMemo(() => {
    const byGoal = new Map<string, SurfaceStyle>()
    const byName = new Map<string, SurfaceStyle>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName) {
        return
      }
      const goalKey = goalName.toLowerCase()
      const goalSurface = ensureSurfaceStyle(goal.surfaceStyle, DEFAULT_SURFACE_STYLE)
      goal.buckets.forEach((bucket) => {
        const bucketName = bucket.name?.trim()
        if (!bucketName) {
          return
        }
        const bucketKey = bucketName.toLowerCase()
        const bucketSurface = ensureSurfaceStyle(bucket.surfaceStyle, goalSurface)
        const scopedKey = `${goalKey}::${bucketKey}`
        if (!byGoal.has(scopedKey)) {
          byGoal.set(scopedKey, bucketSurface)
        }
        if (!byName.has(bucketKey)) {
          byName.set(bucketKey, bucketSurface)
        }
      })
    })
    return { byGoal, byName }
  }, [goalsSnapshot])
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
    const normalizedLifeRoutines = LIFE_ROUTINES_NAME.toLowerCase()
    const seen = new Set<string>()
    const ordered: string[] = []
    goalsSnapshot.forEach((goal) => {
      const trimmed = goal.name?.trim()
      if (!trimmed) {
        return
      }
      const normalized = trimmed.toLowerCase()
      if (normalized === normalizedLifeRoutines) {
        return
      }
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      ordered.push(trimmed)
    })
    return [LIFE_ROUTINES_NAME, ...ordered]
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
    if (lifeRoutineBucketOptions.length > 0) {
      map.set(LIFE_ROUTINES_NAME, lifeRoutineBucketOptions)
    }
    return map
  }, [goalsSnapshot, lifeRoutineBucketOptions])

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
    lifeRoutineBucketOptions.forEach((title) => set.add(title))
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [goalsSnapshot, lifeRoutineBucketOptions])

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

  const goalDropdownId = useId()
  const bucketDropdownId = useId()

  const goalDropdownOptions = useMemo<HistoryDropdownOption[]>(() => {
    const normalizedLifeRoutines = LIFE_ROUTINES_NAME.toLowerCase()
    const optionsWithoutLife = resolvedGoalOptions.filter(
      (option) => option.trim().toLowerCase() !== normalizedLifeRoutines,
    )
    const hasLifeOption =
      resolvedGoalOptions.some((option) => option.trim().toLowerCase() === normalizedLifeRoutines) ||
      lifeRoutineBucketOptions.length > 0
    const next: HistoryDropdownOption[] = [{ value: '', label: 'No goal' }]
    if (hasLifeOption) {
      next.push({ value: LIFE_ROUTINES_NAME, label: LIFE_ROUTINES_NAME })
    }
    optionsWithoutLife.forEach((option) => {
      next.push({ value: option, label: option })
    })
    return next
  }, [lifeRoutineBucketOptions, resolvedGoalOptions])

  const bucketDropdownOptions = useMemo<HistoryDropdownOption[]>(
    () => [
      { value: '', label: 'No bucket' },
      ...resolvedBucketOptions.map((option) => ({ value: option, label: option })),
    ],
    [resolvedBucketOptions],
  )

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
    setEditingHistoryId((current) => (current === selectedHistoryEntry.id ? current : null))
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
      setHoveredHistoryId((current) => (current === entryId ? null : current))
      setHoveredDuringDragId((current) => (current === entryId ? null : current))
      if (selectedHistoryId === entryId) {
        setSelectedHistoryId(null)
        setEditingHistoryId(null)
        setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
      }
      updateHistory((current) => [...current.slice(0, index), ...current.slice(index + 1)])
    },
    [history, selectedHistoryId, updateHistory],
  )

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
      goalId: null,
      bucketId: null,
      taskId: null,
      elapsed,
      startedAt,
      endedAt,
      goalSurface: DEFAULT_SURFACE_STYLE,
      bucketSurface: null,
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

  const updateHistoryDraftField = useCallback(
    (field: 'taskName' | 'goalName' | 'bucketName', nextValue: string) => {
      setHistoryDraft((draft) => ({ ...draft, [field]: nextValue }))
    },
    [],
  )

  const handleHistoryFieldChange = useCallback(
    (field: 'taskName' | 'goalName' | 'bucketName') => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { value } = event.target
      updateHistoryDraftField(field, value)
    },
    [updateHistoryDraftField],
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
    const goalKey = normalizedGoalName.toLowerCase()
    const bucketKey = normalizedBucketName.toLowerCase()
    const hasGoalName = normalizedGoalName.length > 0
    const hasBucketName = normalizedBucketName.length > 0
    const lifeRoutineKey = LIFE_ROUTINES_NAME.toLowerCase()
    const resolvedGoalSurface = ensureSurfaceStyle(
      (() => {
        if (!hasGoalName) {
          return DEFAULT_SURFACE_STYLE
        }
        if (goalKey === lifeRoutineKey) {
          return LIFE_ROUTINES_SURFACE
        }
        return goalSurfaceLookup.get(goalKey) ?? DEFAULT_SURFACE_STYLE
      })(),
      DEFAULT_SURFACE_STYLE,
    )
    const resolvedBucketSurface = (() => {
      if (!hasBucketName) {
        return null
      }
      if (goalKey === lifeRoutineKey) {
        const routineSurface = lifeRoutineSurfaceLookup.get(bucketKey)
        return routineSurface ? ensureSurfaceStyle(routineSurface, LIFE_ROUTINES_SURFACE) : null
      }
      if (!hasGoalName) {
        const fallback = bucketSurfaceLookup.byName.get(bucketKey)
        return fallback ? ensureSurfaceStyle(fallback, DEFAULT_SURFACE_STYLE) : null
      }
      const scopedKey = `${goalKey}::${bucketKey}`
      const scopedSurface = bucketSurfaceLookup.byGoal.get(scopedKey)
      if (scopedSurface) {
        return ensureSurfaceStyle(scopedSurface, DEFAULT_SURFACE_STYLE)
      }
      const fallback = bucketSurfaceLookup.byName.get(bucketKey)
      return fallback ? ensureSurfaceStyle(fallback, DEFAULT_SURFACE_STYLE) : null
    })()
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
        target.endedAt === nextEndedAt &&
        target.goalSurface === resolvedGoalSurface &&
        target.bucketSurface === resolvedBucketSurface
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
        goalSurface: resolvedGoalSurface,
        bucketSurface: resolvedBucketSurface,
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
  }, [bucketSurfaceLookup, goalSurfaceLookup, historyDraft, lifeRoutineSurfaceLookup, selectedHistoryEntry, updateHistory])

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
    setSelectedHistoryId(entry.id)
    setHoveredHistoryId(entry.id)
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
        const stored = readPersistedHistory()
        if (!historiesAreEqual(latestHistoryRef.current, stored)) {
          setHistory(stored)
        }
        return
      }
      if (event.key === CURRENT_SESSION_STORAGE_KEY) {
        setActiveSession(readStoredActiveSession())
      }
    }
    const handleHistoryBroadcast = () => {
      const stored = readPersistedHistory()
      if (!historiesAreEqual(latestHistoryRef.current, stored)) {
        setHistory(stored)
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
      bucketName: activeSession.bucketName ?? null,
      goalId: activeSession.goalId,
      bucketId: activeSession.bucketId,
      taskId: activeSession.taskId,
      goalSurface: activeSession.goalSurface,
      bucketSurface: activeSession.bucketSurface,
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
    () =>
      computeRangeOverview(
        effectiveHistory,
        activeRange,
        enhancedGoalLookup,
        goalColorLookup,
        lifeRoutineSurfaceLookup,
      ),
    [effectiveHistory, activeRange, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup, nowTick],
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
  useLayoutEffect(() => {
    if (!supportsConicGradient) {
      return
    }
    const canvas = pieCanvasRef.current
    if (!canvas) {
      return
    }
    const context = canvas.getContext('2d')
    if (!context || typeof (context as CanvasRenderingContext2D & { createConicGradient?: unknown }).createConicGradient !== 'function') {
      return
    }
    const ctx = context as CanvasRenderingContext2D & {
      createConicGradient: (startAngle: number, x: number, y: number) => CanvasGradient
    }

    const draw = () => {
      if (typeof window === 'undefined') {
        return
      }
      const displayWidth = canvas.clientWidth || PIE_VIEWBOX_SIZE
      const displayHeight = canvas.clientHeight || PIE_VIEWBOX_SIZE
      const dpr = window.devicePixelRatio || 1
      const scaleX = displayWidth / PIE_VIEWBOX_SIZE
      const scaleY = displayHeight / PIE_VIEWBOX_SIZE
      const pixelWidth = Math.max(1, Math.round(displayWidth * dpr))
      const pixelHeight = Math.max(1, Math.round(displayHeight * dpr))

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(dpr * scaleX, 0, 0, dpr * scaleY, 0, 0)
      ctx.clearRect(0, 0, PIE_VIEWBOX_SIZE, PIE_VIEWBOX_SIZE)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'butt'
      ctx.imageSmoothingEnabled = true
      if ('imageSmoothingQuality' in ctx) {
        ;(ctx as unknown as { imageSmoothingQuality: ImageSmoothingQuality }).imageSmoothingQuality = 'high'
      }

      const fillDonut = (fillStyle: string | CanvasGradient) => {
        ctx.beginPath()
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 0, Math.PI * 2, false)
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, Math.PI * 2, 0, true)
        ctx.closePath()
        ctx.fillStyle = fillStyle
        ctx.fill()
      }

      if (pieArcs.length === 0) {
        const fallbackFill = resolveCssColor('var(--reflection-chart-unlogged-soft)', '#31374d')
        fillDonut(fallbackFill)
        return
      }

      pieArcs.forEach((arc) => {
        const spanDegrees = arc.endAngle - arc.startAngle
        if (spanDegrees <= ARC_EPSILON) {
          return
        }
        const startRad = ((arc.startAngle - 90) * Math.PI) / 180
        const endRad = ((arc.endAngle - 90) * Math.PI) / 180
        ctx.beginPath()
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startRad, endRad, false)
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, endRad, startRad, true)
        ctx.closePath()

        let fillStyle: string | CanvasGradient
        if (arc.isUnlogged) {
          fillStyle = resolveCssColor(arc.fill, '#31374d')
        } else if (arc.colorInfo?.gradient) {
          const gradientInfo = arc.colorInfo.gradient
          const gradient = ctx.createConicGradient(startRad, PIE_CENTER, PIE_CENTER)
          const spanRatio = clamp01(spanDegrees / 360)
          gradientInfo.stops.forEach((stop) => {
            gradient.addColorStop(spanRatio * clamp01(stop.position), stop.color)
          })
          const lastStop = gradientInfo.stops[gradientInfo.stops.length - 1]
          if (lastStop) {
            gradient.addColorStop(spanRatio, lastStop.color)
          }
          fillStyle = gradient
        } else if (arc.colorInfo?.solidColor) {
          fillStyle = arc.colorInfo.solidColor
        } else {
          fillStyle = resolveCssColor(arc.fill, arc.baseColor)
        }
        ctx.fillStyle = fillStyle
        ctx.fill()
      })
    }

    let rafId: number | null = null
    const scheduleDraw = () => {
      if (typeof window === 'undefined') {
        draw()
        return
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
      }
      rafId = window.requestAnimationFrame(() => {
        draw()
        rafId = null
      })
    }

    scheduleDraw()

    const handleResize = () => {
      scheduleDraw()
    }

    window.addEventListener('resize', handleResize)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleDraw()
      })
      resizeObserver.observe(canvas)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      if (rafId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [pieArcs, supportsConicGradient, themeToken])
  const unloggedMs = useMemo(() => Math.max(windowMs - loggedMs, 0), [windowMs, loggedMs])
  const tabPanelId = 'reflection-range-panel'
  const dayStart = useMemo(() => {
    const date = new Date(nowTick)
    date.setHours(0, 0, 0, 0)
    if (historyDayOffset !== 0) {
      date.setDate(date.getDate() + historyDayOffset)
    }
    return date.getTime()
  }, [nowTick, historyDayOffset])
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

    if (preview && preview.entryId === 'new-entry') {
      const start = Math.max(Math.min(preview.startedAt, preview.endedAt), dayStart)
      const end = Math.min(Math.max(preview.startedAt, preview.endedAt), dayEnd)
      if (end > start) {
        const syntheticEntry: HistoryEntry = {
          id: 'new-entry',
          taskName: '',
          goalName: null,
          bucketName: null,
          goalId: null,
          bucketId: null,
          taskId: null,
          elapsed: Math.max(end - start, MIN_SESSION_DURATION_DRAG_MS),
          startedAt: start,
          endedAt: end,
          goalSurface: DEFAULT_SURFACE_STYLE,
          bucketSurface: null,
        }
        entries.push({ entry: syntheticEntry, start, end })
      }
    }

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
      const metadata = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
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
  const handlePreviousDay = useCallback(() => {
    setHistoryDayOffset((offset) => offset - 1)
  }, [])
  const handleNextDay = useCallback(() => {
    setHistoryDayOffset((offset) => Math.min(offset + 1, 0))
  }, [])

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
      setHoveredDuringDragId(state.entryId)
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
      const bar = timelineBarRef.current
      if (bar?.hasPointerCapture?.(state.pointerId)) {
        bar.releasePointerCapture(state.pointerId)
      }

      const preview = dragPreviewRef.current
      if (state.hasMoved && preview) {
        if (state.entryId === 'new-entry') {
          const startedAt = Math.min(preview.startedAt, preview.endedAt)
          const endedAt = Math.max(preview.startedAt, preview.endedAt)
          const elapsed = Math.max(endedAt - startedAt, MIN_SESSION_DURATION_DRAG_MS)
          const newEntry: HistoryEntry = {
            id: makeHistoryId(),
            taskName: '',
            goalName: null,
            bucketName: null,
            goalId: null,
            bucketId: null,
            taskId: null,
            elapsed,
            startedAt,
            endedAt,
            goalSurface: DEFAULT_SURFACE_STYLE,
            bucketSurface: null,
          }
          updateHistory((current) => {
            const next = [...current, newEntry]
            next.sort((a, b) => a.startedAt - b.startedAt)
            return next
          })
          setTimeout(() => {
            handleStartEditingHistoryEntry(newEntry)
          }, 0)
        } else {
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
      }

      dragStateRef.current = null
      dragPreviewRef.current = null
      setDragPreview(null)
      dragPreventClickRef.current = state.hasMoved
      setHoveredDuringDragId(null)
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
      setHoveredDuringDragId(segment.entry.id)
      event.stopPropagation()
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
      window.addEventListener('pointercancel', handleWindowPointerUp)
    },
    [dayStart, dayEnd, handleWindowPointerMove, handleWindowPointerUp],
  )

  const startCreateDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, startTimestamp: number) => {
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
        entryId: 'new-entry',
        type: 'resize-end',
        pointerId: event.pointerId,
        rectWidth: rect.width,
        startX: event.clientX,
        initialStart: startTimestamp,
        initialEnd: startTimestamp + MIN_SESSION_DURATION_DRAG_MS,
        dayStart,
        dayEnd,
        minDurationMs: MIN_SESSION_DURATION_DRAG_MS,
        hasMoved: false,
      }
      dragPreviewRef.current = {
        entryId: 'new-entry',
        startedAt: startTimestamp,
        endedAt: startTimestamp + MIN_SESSION_DURATION_DRAG_MS,
      }
      setDragPreview(dragPreviewRef.current)
      dragPreventClickRef.current = false
      setHoveredDuringDragId('new-entry')
      event.currentTarget.setPointerCapture?.(event.pointerId)
      event.preventDefault()
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

      <div className="history-block">
        <div className="history-section__heading">
          <h2 className="reflection-section__title">Session History</h2>
          <p className="history-section__desc">
            Review today’s focus sessions, fine-tune their timing, and capture what made each block productive.
          </p>
        </div>

        <section className={`history-section${dayEntryCount > 0 ? '' : ' history-section--empty'}`} aria-label="Session History">
          <div className="history-controls history-controls--floating">
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
            <div className="history-section__date-container">
              <div className="history-section__date-controls" role="group" aria-label="Session history day navigation">
                <button
                  type="button"
                  className="history-section__date-button"
                  onClick={handlePreviousDay}
                  aria-label="View previous day"
                >
                  <span aria-hidden="true">&lt;</span>
                </button>
                <button
                  type="button"
                  className="history-section__date-button"
                  onClick={handleNextDay}
                  disabled={historyDayOffset >= 0}
                  aria-label="View next day"
                >
                  <span aria-hidden="true">&gt;</span>
                </button>
              </div>
              <h3 className="history-section__date">{dayLabel}</h3>
            </div>
          </div>

          <div
            className="history-timeline"
            style={timelineStyle}
            ref={timelineRef}
            onClick={handleTimelineBackgroundClick}
          >
            <div
              className="history-timeline__bar"
              ref={timelineBarRef}
              onDoubleClick={(event) => {
                event.stopPropagation()
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return
                }
                const bar = timelineBarRef.current
                if (!bar) {
                  return
                }
                if (event.nativeEvent.button !== 0) {
                  return
                }
                const rect = bar.getBoundingClientRect()
                if (rect.width <= 0) {
                  return
                }
                const ratio = (event.clientX - rect.left) / rect.width
                const clampedRatio = Math.min(Math.max(ratio, 0), 1)
                const startTimestamp = Math.round(dayStart + clampedRatio * DAY_DURATION_MS)
                startCreateDrag(event, startTimestamp)
              }}
            >
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
              
              // Use drag preview timestamps if this segment is being dragged
              const draggedStartedAt = isDragging && dragPreview ? dragPreview.startedAt : baseStartedAt
              const draggedEndedAt = isDragging && dragPreview ? dragPreview.endedAt : baseEndedAt
              
              // For active sessions, use live timestamp unless user has explicitly modified the start time, but prioritize drag preview
              const shouldUseLiveStartTime = isActiveSessionSegment && activeSession?.isRunning && historyDraft.startedAt === null && !isDragging
              const resolvedStartedAt = isSelected 
                ? isDragging 
                  ? draggedStartedAt  // During drag, always use drag preview
                  : shouldUseLiveStartTime 
                    ? baseStartedAt  // Use live timestamp from the active session
                    : resolveTimestamp(historyDraft.startedAt, baseStartedAt) 
                : draggedStartedAt
              // For active sessions, use live timestamp unless user has explicitly modified the end time, but prioritize drag preview
              const shouldUseLiveEndTime = isActiveSessionSegment && activeSession?.isRunning && historyDraft.endedAt === null && !isDragging
              const resolvedEndedAt = isSelected 
                ? isDragging 
                  ? draggedEndedAt  // During drag, always use drag preview
                  : shouldUseLiveEndTime 
                    ? baseEndedAt  // Use live timestamp from the active session
                    : resolveTimestamp(historyDraft.endedAt, baseEndedAt) 
                : draggedEndedAt
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
              const isPreviewEntry = segment.entry.id === 'new-entry'
              const isDragHover = hoveredDuringDragId === segment.entry.id
              const showDragBadge = isDragHover || (isPreviewEntry && dragPreview?.entryId === 'new-entry')
              const blockClassName = [
                'history-timeline__block',
                isActiveSegment ? 'history-timeline__block--active' : '',
                isSelected ? 'history-timeline__block--selected' : '',
                isDragging ? 'history-timeline__block--dragging' : '',
                isDragHover ? 'history-timeline__block--drag-hover' : '',
              ]
                .filter(Boolean)
                .join(' ')
              const isAnchoredTooltip = segment.entry.id === anchoredTooltipId
              const shouldSuppressTooltip = Boolean(dragStateRef.current)
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
                                <HistoryDropdown
                                  id={goalDropdownId}
                                  value={historyDraft.goalName}
                                  placeholder="Select goal"
                                  options={goalDropdownOptions}
                                  onChange={(nextValue) => updateHistoryDraftField('goalName', nextValue)}
                                />
                              </label>
                              <label className="history-timeline__field">
                                <span className="history-timeline__field-text">Bucket</span>
                                <HistoryDropdown
                                  id={bucketDropdownId}
                                  value={historyDraft.bucketName}
                                  placeholder="Select bucket"
                                  options={bucketDropdownOptions}
                                  onChange={(nextValue) => updateHistoryDraftField('bucketName', nextValue)}
                                  disabled={availableBucketOptions.length === 0}
                                />
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

              const inlineTooltip =
                shouldSuppressTooltip && showDragBadge
                  ? null
                  : (
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
                (isEditing && typeof document !== 'undefined' && !(shouldSuppressTooltip && showDragBadge))
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
                  data-drag-time={
                    showDragBadge
                      ? `${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`
                      : undefined
                  }
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
                    if (event.detail > 1) {
                      return
                    }
                    handleSelectHistorySegment(segment.entry)
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    if (dragPreventClickRef.current) {
                      dragPreventClickRef.current = false
                    }
                    if (!isActiveSessionSegment) {
                      handleStartEditingHistoryEntry(segment.entry)
                    }
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
            {supportsConicGradient ? (
              <canvas
                ref={pieCanvasRef}
                className="reflection-pie__canvas"
                width={PIE_VIEWBOX_SIZE}
                height={PIE_VIEWBOX_SIZE}
                aria-hidden="true"
              />
            ) : (
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
                    if (slices.length <= 1) {
                      const slice = slices[0]
                      return (
                        <path
                          key={arc.id}
                          className="reflection-pie__slice"
                          d={arc.path}
                          fill={slice?.color ?? arc.fill}
                          fillRule="evenodd"
                          clipRule="evenodd"
                        />
                      )
                    }
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
            )}
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
