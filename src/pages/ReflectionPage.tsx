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
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
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
  syncLifeRoutinesWithSupabase,
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

const PAN_SNAP_THRESHOLD = 0.35
const PAN_FLICK_VELOCITY_PX_PER_MS = 0.6
const PAN_MIN_ANIMATION_MS = 220
const PAN_MAX_ANIMATION_MS = 450
const MAX_BUFFER_DAYS = 28
const MULTI_DAY_OPTIONS = [2, 3, 4, 5, 6] as const
const isValidMultiDayOption = (value: number): value is (typeof MULTI_DAY_OPTIONS)[number] =>
  (MULTI_DAY_OPTIONS as readonly number[]).includes(value)

const getCalendarBufferDays = (visibleDayCount: number): number => {
  if (!Number.isFinite(visibleDayCount) || visibleDayCount <= 0) {
    return 4
  }
  const scaled = Math.ceil(visibleDayCount * 1.6)
  return Math.min(MAX_BUFFER_DAYS, Math.max(4, scaled))
}

const clampPanDelta = (dx: number, dayWidth: number, spanDays: number): number => {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
    return 0
  }
  const safeSpan = Number.isFinite(spanDays) ? Math.max(1, Math.min(MAX_BUFFER_DAYS, Math.abs(spanDays))) : 1
  const maxShift = dayWidth * safeSpan
  if (!Number.isFinite(maxShift) || maxShift <= 0) {
    return 0
  }
  if (dx > maxShift) return maxShift
  if (dx < -maxShift) return -maxShift
  return dx
}

type EditableSelectionSnapshot = {
  path: number[]
  offset: number
}

const buildSelectionSnapshotFromRange = (root: HTMLElement, range: Range | null): EditableSelectionSnapshot | null => {
  if (!range) return null
  const container = range.endContainer
  if (!root.contains(container)) return null
  const path: number[] = []
  let current: Node | null = container
  while (current && current !== root) {
    const parent: Node | null = current.parentNode
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, current)
    if (index === -1) return null
    path.push(index)
    current = parent
  }
  if (current !== root) {
    return null
  }
  path.reverse()
  return { path, offset: range.endOffset }
}

const resolveNodeFromPath = (root: HTMLElement, path: number[]): Node => {
  let node: Node = root
  for (const index of path) {
    if (!node.childNodes || index < 0 || index >= node.childNodes.length) {
      return node
    }
    node = node.childNodes[index]
  }
  return node
}

const applySelectionSnapshot = (root: HTMLElement, snapshot: EditableSelectionSnapshot | null): boolean => {
  if (!snapshot || typeof window === 'undefined') {
    return false
  }
  const selection = window.getSelection()
  if (!selection) {
    return false
  }
  const doc = root.ownerDocument || document
  const node = resolveNodeFromPath(root, snapshot.path)
  const range = doc.createRange()
  const maxOffset =
    node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
  const clampedOffset = Math.max(0, Math.min(snapshot.offset, maxOffset))
  try {
    range.setStart(node, clampedOffset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  } catch {
    return false
  }
}

type HistoryDraftState = {
  taskName: string
  goalName: string
  bucketName: string
  startedAt: number | null
  endedAt: number | null
}

type CalendarPopoverEditingState = {
  entryId: string
  value: string
  initialTaskName: string
  initialDisplayValue: string
  dirty: boolean
  selectionSnapshot: EditableSelectionSnapshot | null
}

type CalendarActionsKebabProps = {
  onDuplicate: () => void
  previewRef: RefObject<HTMLDivElement | null>
}

const CalendarActionsKebab = ({ onDuplicate, previewRef }: CalendarActionsKebabProps) => {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const host = previewRef.current
      if (host && host.contains(target)) {
        const menu = host.querySelector('.calendar-popover__menu') as HTMLElement | null
        if (menu && menu.contains(target)) return
        if (btnRef.current && btnRef.current.contains(target)) return
      }
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDocDown as EventListener, true)
    return () => window.removeEventListener('pointerdown', onDocDown as EventListener, true)
  }, [open, previewRef])

  return (
    <div className="calendar-popover__kebab-wrap">
      <button
        ref={btnRef}
        type="button"
        className="calendar-popover__action"
        aria-label="More actions"
        onPointerDown={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          setOpen((v) => !v)
        }}
        onClick={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="12" cy="19" r="1.75"/></svg>
      </button>
      {open ? (
        <div className="calendar-popover__menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="calendar-popover__menu-item"
            onPointerDown={(ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              try {
                onDuplicate()
              } finally {
                setOpen(false)
              }
            }}
          >
            Duplicate entry
          </button>
        </div>
      ) : null}
    </div>
  )
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

const LIFE_ROUTINE_SURFACE_GRADIENT_INFO: Partial<Record<SurfaceStyle, SurfaceGradientInfo>> = {
  glass: {
    gradient:
      'linear-gradient(135deg, rgba(76, 118, 255, 0.42) 0%, rgba(56, 96, 230, 0.34) 48%, rgba(28, 54, 156, 0.28) 100%)',
    start: 'rgba(76, 118, 255, 0.42)',
    mid: 'rgba(56, 96, 230, 0.34)',
    end: 'rgba(28, 54, 156, 0.28)',
    base: '#3f60d6',
  },
  midnight: {
    gradient:
      'linear-gradient(135deg, rgba(118, 126, 255, 0.3) 0%, rgba(110, 118, 246, 0.26) 48%, rgba(92, 106, 230, 0.22) 100%)',
    start: 'rgba(118, 126, 255, 0.3)',
    mid: 'rgba(110, 118, 246, 0.26)',
    end: 'rgba(92, 106, 230, 0.22)',
    base: SURFACE_GRADIENT_INFO.midnight.base,
  },
  slate: {
    gradient:
      'linear-gradient(135deg, rgba(151, 227, 255, 0.3) 0%, rgba(120, 198, 255, 0.26) 48%, rgba(96, 180, 255, 0.22) 100%)',
    start: 'rgba(151, 227, 255, 0.3)',
    mid: 'rgba(120, 198, 255, 0.26)',
    end: 'rgba(96, 180, 255, 0.22)',
    base: SURFACE_GRADIENT_INFO.slate.base,
  },
  charcoal: {
    gradient:
      'linear-gradient(135deg, rgba(255, 188, 213, 0.34) 0%, rgba(250, 190, 216, 0.3) 50%, rgba(244, 174, 206, 0.26) 100%)',
    start: 'rgba(255, 188, 213, 0.34)',
    mid: 'rgba(250, 190, 216, 0.3)',
    end: 'rgba(244, 174, 206, 0.26)',
    base: SURFACE_GRADIENT_INFO.charcoal.base,
  },
  linen: {
    gradient:
      'linear-gradient(135deg, rgba(255, 214, 170, 0.34) 0%, rgba(255, 200, 156, 0.3) 48%, rgba(255, 233, 192, 0.26) 100%)',
    start: 'rgba(255, 214, 170, 0.34)',
    mid: 'rgba(255, 200, 156, 0.3)',
    end: 'rgba(255, 233, 192, 0.26)',
    base: SURFACE_GRADIENT_INFO.linen.base,
  },
  frost: {
    gradient:
      'linear-gradient(135deg, rgba(174, 233, 255, 0.3) 0%, rgba(150, 224, 255, 0.26) 48%, rgba(142, 210, 255, 0.22) 100%)',
    start: 'rgba(174, 233, 255, 0.3)',
    mid: 'rgba(150, 224, 255, 0.26)',
    end: 'rgba(142, 210, 255, 0.22)',
    base: SURFACE_GRADIENT_INFO.frost.base,
  },
  grove: {
    gradient:
      'linear-gradient(135deg, rgba(140, 255, 204, 0.3) 0%, rgba(112, 240, 176, 0.26) 48%, rgba(74, 222, 128, 0.22) 100%)',
    start: 'rgba(140, 255, 204, 0.3)',
    mid: 'rgba(112, 240, 176, 0.26)',
    end: 'rgba(74, 222, 128, 0.22)',
    base: SURFACE_GRADIENT_INFO.grove.base,
  },
  lagoon: {
    gradient:
      'linear-gradient(135deg, rgba(146, 213, 255, 0.3) 0%, rgba(116, 190, 255, 0.26) 48%, rgba(88, 168, 255, 0.22) 100%)',
    start: 'rgba(146, 213, 255, 0.3)',
    mid: 'rgba(116, 190, 255, 0.26)',
    end: 'rgba(88, 168, 255, 0.22)',
    base: SURFACE_GRADIENT_INFO.lagoon.base,
  },
  ember: {
    gradient:
      'linear-gradient(135deg, rgba(255, 210, 170, 0.34) 0%, rgba(255, 192, 136, 0.3) 48%, rgba(249, 160, 68, 0.24) 100%)',
    start: 'rgba(255, 210, 170, 0.34)',
    mid: 'rgba(255, 192, 136, 0.3)',
    end: 'rgba(249, 160, 68, 0.24)',
    base: SURFACE_GRADIENT_INFO.ember.base,
  },
}

const toGoalColorInfo = (info: SurfaceGradientInfo): GoalColorInfo => ({
  gradient: {
    css: info.gradient,
    start: info.start,
    end: info.end,
    angle: 135,
    stops: [
      { color: info.start, position: 0 },
      { color: info.mid, position: 0.48 },
      { color: info.end, position: 1 },
    ],
  },
  solidColor: info.base,
})

const hexToRgba = (hex: string, alpha: number): string => {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex
  if (normalized.length !== 6) {
    return hex
  }
  const value = Number.parseInt(normalized, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const deriveLifeRoutineSolidColor = (surface: SurfaceStyle): string => {
  const info = LIFE_ROUTINE_SURFACE_GRADIENT_INFO[surface] ?? SURFACE_GRADIENT_INFO[surface]
  return hexToRgba(info.base, 0.78)
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
                    }}
                    onPointerUp={() => {
                      pointerSelectionRef.current = false
                    }}
                    onClick={(event) => {
                      if (option.disabled) {
                        event.preventDefault()
                        return
                      }
                      if (pointerSelectionRef.current) {
                        pointerSelectionRef.current = false
                        handleOptionSelect(option.value)
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

const getSurfaceColorInfo = (surface: SurfaceStyle): GoalColorInfo => toGoalColorInfo(SURFACE_GRADIENT_INFO[surface])

const getLifeRoutineSurfaceColorInfo = (surface: SurfaceStyle): GoalColorInfo => {
  return {
    solidColor: deriveLifeRoutineSolidColor(surface),
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
// Double-tap (touch) detection settings
// Double-tap (touch) detection thresholds (tighter to reduce accidental triggers)
const DOUBLE_TAP_DELAY_MS = 220
const DOUBLE_TAP_DISTANCE_PX = 8

const formatTimeInputValue = (timestamp: number | null): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

const formatDateInputValue = (timestamp: number | null): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseLocalDateTime = (dateValue: string, timeValue: string): number | null => {
  if (typeof dateValue !== 'string' || dateValue.trim().length === 0) {
    return null
  }
  const time = typeof timeValue === 'string' && timeValue.trim().length > 0 ? timeValue : '00:00'
  const parsed = Date.parse(`${dateValue}T${time}`)
  return Number.isFinite(parsed) ? parsed : null
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

const deriveEntryTaskName = (entry: HistoryEntry): string => {
  const name = entry.taskName?.trim()
  if (name && name.length > 0) {
    return name
  }
  const bucket = entry.bucketName?.trim()
  if (bucket && bucket.length > 0) {
    return bucket
  }
  const goal = entry.goalName?.trim()
  if (goal && goal.length > 0) {
    return goal
  }
  return 'Session'
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
    const surfaceInfo = getLifeRoutineSurfaceColorInfo(routineSurface ?? LIFE_ROUTINES_SURFACE)
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
  type CalendarViewMode = 'day' | '3d' | 'week' | 'month' | 'year'
  const [calendarView, setCalendarView] = useState<CalendarViewMode>('month')
  const [multiDayCount, setMultiDayCount] = useState<number>(4)
  const [showMultiDayChooser, setShowMultiDayChooser] = useState(false)
  const [historyDayOffset, setHistoryDayOffset] = useState(0)
  const historyDayOffsetRef = useRef(historyDayOffset)
  const multiChooserRef = useRef<HTMLDivElement | null>(null)
  const lastCalendarHotkeyRef = useRef<{ key: string; timestamp: number } | null>(null)
  const multiDayKeyboardStateRef = useRef<{ active: boolean; selection: number }>({
    active: false,
    selection: multiDayCount,
  })
  const calendarDaysAreaRef = useRef<HTMLDivElement | null>(null)
  const calendarDaysRef = useRef<HTMLDivElement | null>(null)
  const calendarHeadersRef = useRef<HTMLDivElement | null>(null)
  const calendarBaseTranslateRef = useRef<number>(0)
  const calendarDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startTime: number
    areaWidth: number
    dayCount: number
    baseOffset: number
    mode: 'pending' | 'hdrag'
    lastAppliedDx: number
  } | null>(null)
  const calendarPanCleanupRef = useRef<((shouldCommit: boolean) => void) | null>(null)
  const calendarPanDesiredOffsetRef = useRef<number>(historyDayOffset)

  const stopCalendarPanAnimation = useCallback(
    (options?: { commit?: boolean }) => {
      const cleanup = calendarPanCleanupRef.current
      if (!cleanup) return
      calendarPanCleanupRef.current = null
      cleanup(options?.commit ?? true)
    },
    [],
  )
  const focusMultiDayOption = useCallback((value: number) => {
    const chooser = multiChooserRef.current
    if (!chooser) {
      return
    }
    const button = chooser.querySelector<HTMLButtonElement>(`button[data-day-count="${value}"]`)
    if (button) {
      button.focus()
    }
  }, [])

  const animateCalendarPan = useCallback(
    (snapDays: number, dayWidth: number, baseOffset: number) => {
      const targetOffset = baseOffset - snapDays
      calendarPanDesiredOffsetRef.current = targetOffset
      historyDayOffsetRef.current = targetOffset
      const daysEl = calendarDaysRef.current
      const hdrEl = calendarHeadersRef.current
      if (!daysEl || !hdrEl || !Number.isFinite(dayWidth) || dayWidth <= 0) {
        if (targetOffset !== baseOffset) {
          setHistoryDayOffset(targetOffset)
        }
        return
      }

      if (snapDays === 0) {
        stopCalendarPanAnimation({ commit: false })
        const baseTransform = calendarBaseTranslateRef.current
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        daysEl.style.transform = `translateX(${baseTransform}px)`
        hdrEl.style.transform = `translateX(${baseTransform}px)`
        return
      }

      const baseTransform = calendarBaseTranslateRef.current
      const endTransform = baseTransform + snapDays * dayWidth

      const parseCurrentTransform = (value: string): number => {
        const match = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(value)
        if (!match) return baseTransform
        const parsed = Number(match[1])
        return Number.isFinite(parsed) ? parsed : baseTransform
      }

      const currentTransform = parseCurrentTransform(daysEl.style.transform)
      const deltaPx = endTransform - currentTransform
      if (Math.abs(deltaPx) < 0.5) {
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        daysEl.style.transform = `translateX(${baseTransform}px)`
        hdrEl.style.transform = `translateX(${baseTransform}px)`
        if (targetOffset !== baseOffset) {
          setHistoryDayOffset(targetOffset)
        }
        return
      }

      stopCalendarPanAnimation()

      const distanceFactor = Math.min(1.8, Math.max(1, Math.abs(deltaPx) / Math.max(dayWidth, 1)))
      const duration = Math.round(
        Math.min(PAN_MAX_ANIMATION_MS, Math.max(PAN_MIN_ANIMATION_MS, PAN_MIN_ANIMATION_MS * distanceFactor)),
      )
      const easing = 'cubic-bezier(0.22, 0.72, 0.28, 1)'

      const finalize = (shouldCommit: boolean) => {
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        if (!shouldCommit) {
          const baseAfter = calendarBaseTranslateRef.current
          daysEl.style.transform = `translateX(${baseAfter}px)`
          hdrEl.style.transform = `translateX(${baseAfter}px)`
          calendarPanDesiredOffsetRef.current = baseOffset
          historyDayOffsetRef.current = baseOffset
        } else {
          calendarPanDesiredOffsetRef.current = targetOffset
          historyDayOffsetRef.current = targetOffset
          if (targetOffset !== baseOffset) {
            setHistoryDayOffset(targetOffset)
          }
        }
      }

      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName !== 'transform') {
          return
        }
        daysEl.removeEventListener('transitionend', onTransitionEnd)
        calendarPanCleanupRef.current = null
        finalize(true)
      }

      calendarPanCleanupRef.current = (shouldCommit: boolean) => {
        daysEl.removeEventListener('transitionend', onTransitionEnd)
        finalize(shouldCommit)
      }

      // Start animation on next frame to ensure transition registers
      requestAnimationFrame(() => {
        daysEl.style.transition = `transform ${duration}ms ${easing}`
        hdrEl.style.transition = `transform ${duration}ms ${easing}`
        daysEl.style.transform = `translateX(${endTransform}px)`
        hdrEl.style.transform = `translateX(${endTransform}px)`
      })

      daysEl.addEventListener('transitionend', onTransitionEnd)
      window.setTimeout(() => {
        const cleanup = calendarPanCleanupRef.current
        if (!cleanup) {
          return
        }
        calendarPanCleanupRef.current = null
        cleanup(true)
      }, duration + 60)
    },
    [stopCalendarPanAnimation, setHistoryDayOffset],
  )

  const resolvePanSnap = useCallback(
    (
      state: { baseOffset: number; startTime: number; dayCount: number },
      dx: number,
      dayWidth: number,
      view: CalendarViewMode,
      appliedDx?: number,
    ) => {
      const hasDayWidth = Number.isFinite(dayWidth) && dayWidth > 0
      const effectiveDx = hasDayWidth
        ? Number.isFinite(appliedDx)
          ? appliedDx!
          : clampPanDelta(dx, dayWidth, state.dayCount)
        : 0
      const rawDays = hasDayWidth ? effectiveDx / dayWidth : 0
      const chunkSize = state.dayCount > 0 ? state.dayCount : 1
      const snapUnitSpan = view === '3d'
        ? 1
        : chunkSize <= 1
          ? 1
          : chunkSize
      const effectiveRaw = snapUnitSpan === 1 ? rawDays : rawDays / snapUnitSpan
      let snapUnits = Math.round(effectiveRaw)
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsedMs = Math.max(now - state.startTime, 1)
      const velocityPxPerMs = dx / elapsedMs

      if (snapUnits === 0) {
        if (Math.abs(effectiveRaw) > PAN_SNAP_THRESHOLD) {
          snapUnits = effectiveRaw > 0 ? 1 : -1
        } else if (Math.abs(velocityPxPerMs) > PAN_FLICK_VELOCITY_PX_PER_MS) {
          snapUnits = velocityPxPerMs > 0 ? 1 : -1
        }
      }

      const snap = snapUnits * snapUnitSpan

      const targetOffset = state.baseOffset - snap
      return { snap, targetOffset }
    },
    [],
  )
  const [activeRange, setActiveRange] = useState<ReflectionRangeKey>('24h')
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
  const latestHistoryRef = useRef(history)
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => readStoredGoalsSnapshot())
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(() => readStoredActiveSession())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [journal, setJournal] = useState('')
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [pendingNewHistoryId, setPendingNewHistoryId] = useState<string | null>(null)
  const [hoveredHistoryId, setHoveredHistoryId] = useState<string | null>(null)
  const [historyDraft, setHistoryDraft] = useState<HistoryDraftState>({
    taskName: '',
    goalName: '',
    bucketName: '',
    startedAt: null,
    endedAt: null,
  })
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null)
  // When set, shows a modal editor for a calendar entry
  const [calendarEditorEntryId, setCalendarEditorEntryId] = useState<string | null>(null)
  const [hoveredDuringDragId, setHoveredDuringDragId] = useState<string | null>(null)
  const pieCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Ref to the live-updating current-time line in the calendar view (DOM-updated to avoid React re-renders)
  const calendarNowLineRef = useRef<HTMLDivElement | null>(null)
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
  const editingTooltipRef = useRef<HTMLDivElement | null>(null)
  // Ref to the calendar editor panel so global outside-click handlers don't cancel edits when interacting with the modal
  const calendarEditorRef = useRef<HTMLDivElement | null>(null)
  // Ref to the session name input inside the calendar editor modal (for autofocus on new entries)
  const calendarEditorNameInputRef = useRef<HTMLInputElement | null>(null)
  const [activeTooltipOffsets, setActiveTooltipOffsets] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [activeTooltipPlacement, setActiveTooltipPlacement] = useState<'above' | 'below'>('above')
  const dragStateRef = useRef<DragState | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const dragPreviewRef = useRef<DragPreview | null>(null)
  const dragPreventClickRef = useRef(false)
  const selectedHistoryIdRef = useRef<string | null>(selectedHistoryId)
  // Long-press to move on touch
  const longPressTimerRef = useRef<number | null>(null)
  const longPressPointerIdRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const longPressCancelHandlersRef = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
    cancel: (e: PointerEvent) => void
  } | null>(null)
  // Double-tap (touch) to edit
  const lastTapRef = useRef<{ time: number; id: string; x: number; y: number } | null>(null)
  const lastTapTimeoutRef = useRef<number | null>(null)
  // One-time auto-fill guard for session name when selecting Life Routine bucket
  const taskNameAutofilledRef = useRef(false)
  // Mouse pre-drag detection to preserve click/double-click semantics
  const mousePreDragRef = useRef<{
    pointerId: number
    startX: number
    segment: TimelineSegment
  } | null>(null)
  const mousePreDragHandlersRef = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
  } | null>(null)

  const clearLongPressWatch = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      try { window.clearTimeout(longPressTimerRef.current) } catch {}
    }
    longPressTimerRef.current = null
    longPressPointerIdRef.current = null
    longPressStartRef.current = null
    const handlers = longPressCancelHandlersRef.current
    if (handlers) {
      window.removeEventListener('pointermove', handlers.move)
      window.removeEventListener('pointerup', handlers.up)
      window.removeEventListener('pointercancel', handlers.cancel)
    }
    longPressCancelHandlersRef.current = null
  }, [])

  useEffect(() => {
    // Cleanup double-tap timer on unmount
    return () => {
      if (lastTapTimeoutRef.current !== null) {
        try { window.clearTimeout(lastTapTimeoutRef.current) } catch {}
      }
      lastTapTimeoutRef.current = null
      lastTapRef.current = null
      // Cleanup mouse pre-drag handlers
      if (mousePreDragHandlersRef.current) {
        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
      }
      mousePreDragHandlersRef.current = null
      mousePreDragRef.current = null
    }
  }, [])

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

    // Decide whether to anchor below if there isn't enough space above
    const shouldBeBelow = rect.top < padding && rect.bottom < viewportHeight - padding
    if (shouldBeBelow && activeTooltipPlacement !== 'below') {
      setActiveTooltipPlacement('below')
    } else if (!shouldBeBelow && activeTooltipPlacement !== 'above') {
      setActiveTooltipPlacement('above')
    }

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
  }, [activeTooltipPlacement])

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

  const setEditingTooltipNode = useCallback((node: HTMLDivElement | null) => {
    editingTooltipRef.current = node
  }, [])

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
    taskNameAutofilledRef.current = false
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
  }, [hoveredHistoryId, selectedHistoryId, activeTooltipPlacement, updateActiveTooltipOffsets])

  const handleDeleteHistoryEntry = useCallback(
    (entryId: string) => (
      event:
        | MouseEvent<HTMLButtonElement>
        | ReactPointerEvent<HTMLButtonElement>
        | TouchEvent<HTMLButtonElement>
    ) => {
      event.preventDefault()
      event.stopPropagation()
      // Delete by id against the latest state to avoid stale-index bugs when multiple events fire
      setHoveredHistoryId((current) => (current === entryId ? null : current))
      setHoveredDuringDragId((current) => (current === entryId ? null : current))
      if (selectedHistoryId === entryId) {
        setSelectedHistoryId(null)
        setEditingHistoryId(null)
        setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
      }
      if (pendingNewHistoryId === entryId) {
        setPendingNewHistoryId(null)
      }
      updateHistory((current) => {
        if (!current.some((e) => e.id === entryId)) return current
        return current.filter((e) => e.id !== entryId)
      })
    },
    [selectedHistoryId, updateHistory, pendingNewHistoryId],
  )

  const handleAddHistoryEntry = useCallback(() => {
    const nowDate = new Date()
    const targetDate = new Date()
    targetDate.setHours(0, 0, 0, 0)
    if (historyDayOffset !== 0) {
      targetDate.setDate(targetDate.getDate() + historyDayOffset)
    }
    const timeOfDayMs =
      nowDate.getHours() * 60 * 60 * 1000 +
      nowDate.getMinutes() * 60 * 1000 +
      nowDate.getSeconds() * 1000 +
      nowDate.getMilliseconds()
    const startedAt = targetDate.getTime() + timeOfDayMs
    const defaultDuration = 30 * 60 * 1000
    const endedAt = Math.max(startedAt + defaultDuration, startedAt + MINUTE_MS)
    const elapsed = Math.max(endedAt - startedAt, 1)
    const entry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: 'New session',
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
    setPendingNewHistoryId(entry.id)
    setHistoryDraft({
      taskName: 'New session',
      goalName: '',
      bucketName: '',
      startedAt,
      endedAt,
    })
    // Immediately open the full editor modal for the new entry
    setCalendarEditorEntryId(entry.id)
  }, [historyDayOffset, updateHistory])

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
        taskName: deriveEntryTaskName(entry),
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
      setHistoryDraft((draft) => {
        const base = { ...draft, [field]: nextValue }
        // Only auto-fill once: when choosing a Life Routine bucket, and only if name is effectively empty or default
        if (field === 'bucketName') {
          const nextGoal = base.goalName.trim()
          const nextBucket = nextValue.trim()
          const isLifeRoutine = nextGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
          const trimmedTask = base.taskName.trim()
          const looksDefault = trimmedTask.length === 0 || /^new session$/i.test(trimmedTask)
          if (isLifeRoutine && nextBucket.length > 0 && looksDefault && !taskNameAutofilledRef.current) {
            taskNameAutofilledRef.current = true
            return { ...base, taskName: nextBucket }
          }
        }
        return base
      })
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
    // Preserve blank names if the user cleared it intentionally
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
    if (nextEndedAt <= nextStartedAt) {
      nextEndedAt = nextStartedAt + MIN_SESSION_DURATION_DRAG_MS
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
        if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
          setPendingNewHistoryId(null)
        }
        commitHistoryDraft()
        // If the calendar editor modal is open, close it after saving via Enter
        if (calendarEditorEntryId) {
          setCalendarEditorEntryId(null)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (selectedHistoryEntry) {
          setHistoryDraft({
            taskName: deriveEntryTaskName(selectedHistoryEntry),
            goalName: selectedHistoryEntry.goalName ?? '',
            bucketName: selectedHistoryEntry.bucketName ?? '',
            startedAt: selectedHistoryEntry.startedAt,
            endedAt: selectedHistoryEntry.endedAt,
          })
        }
        setEditingHistoryId(null)
      }
    },
    [calendarEditorEntryId, commitHistoryDraft, pendingNewHistoryId, selectedHistoryEntry, selectedHistoryId],
  )

  const handleCancelHistoryEdit = useCallback(() => {
    // If we're cancelling a newly added (pending) entry, delete it only if untouched (no field edits)
    if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
      const entry = selectedHistoryEntry
      const draft = historyDraft
      const entryTask = (entry?.taskName ?? '').trim()
      const draftTask = (draft.taskName ?? '').trim()
      const entryGoal = (entry?.goalName ?? '').trim()
      const draftGoal = (draft.goalName ?? '').trim()
      const entryBucket = (entry?.bucketName ?? '').trim()
      const draftBucket = (draft.bucketName ?? '').trim()
      const entryStart = entry?.startedAt ?? null
      const entryEnd = entry?.endedAt ?? null
      const draftStart = draft.startedAt ?? entryStart
      const draftEnd = draft.endedAt ?? entryEnd
      const untouched =
        entryTask === draftTask &&
        entryGoal === draftGoal &&
        entryBucket === draftBucket &&
        entryStart === draftStart &&
        entryEnd === draftEnd

      if (untouched && entry) {
        // Remove the new entry since user dismissed without editing
        updateHistory((current) => current.filter((e) => e.id !== entry.id))
      }
      setPendingNewHistoryId(null)
      setSelectedHistoryId(null)
      setEditingHistoryId(null)
      setHoveredHistoryId(null)
      setHistoryDraft({ taskName: '', goalName: '', bucketName: '', startedAt: null, endedAt: null })
      return
    }
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
  }, [pendingNewHistoryId, selectedHistoryEntry, selectedHistoryId])

  const handleSaveHistoryDraft = useCallback(() => {
    // If we were editing a newly added entry, it's no longer pending after save
    if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
      setPendingNewHistoryId(null)
    }
    commitHistoryDraft()
  }, [commitHistoryDraft, pendingNewHistoryId, selectedHistoryId])

  const handleStartEditingHistoryEntry = useCallback((entry: HistoryEntry) => {
    setSelectedHistoryId(entry.id)
    setHoveredHistoryId(entry.id)
    setEditingHistoryId(entry.id)
    taskNameAutofilledRef.current = false
    setHistoryDraft({
      // Use the stored taskName verbatim so intentional blanks stay blank
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
      const portalEl = editingTooltipRef.current
      const editorEl = calendarEditorRef.current
      const targetNode = event.target as Node | null
      // Ignore clicks inside the dropdown overlay menu (rendered via portal)
      let withinDropdown = false
      if (targetNode instanceof HTMLElement) {
        let el: HTMLElement | null = targetNode
        while (el) {
          if (el.classList && el.classList.contains('history-dropdown__menu')) {
            withinDropdown = true
            break
          }
          el = el.parentElement
        }
      }
      if (withinDropdown) {
        return
      }
      if (
        (timelineEl && targetNode && timelineEl.contains(targetNode)) ||
        (portalEl && targetNode && portalEl.contains(targetNode)) ||
        (editorEl && targetNode && editorEl.contains(targetNode))
      ) {
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
    }, 60000) // update once per minute to reduce render churn
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
      activeSession.taskName.length > 0
        ? activeSession.taskName
        : activeSession.bucketName && activeSession.bucketName.trim().length > 0
          ? activeSession.bucketName
          : activeSession.goalName ?? UNCATEGORISED_LABEL
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
    [effectiveHistory, activeRange, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup],
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
    if (calendarView === '3d' && historyDayOffset !== 0) {
      const adjusted = new Date(date)
      adjusted.setDate(adjusted.getDate() + historyDayOffset)
      return adjusted.getTime()
    }
    if (historyDayOffset !== 0) {
      date.setDate(date.getDate() + historyDayOffset)
    }
    return date.getTime()
  }, [nowTick, historyDayOffset, calendarView])
  const dayEnd = dayStart + DAY_DURATION_MS
  const anchorDate = useMemo(() => new Date(dayStart), [dayStart])
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

  // --- Calendar event preview (popover) ---
  const [calendarPreview, setCalendarPreview] = useState<
    | null
    | {
        entryId: string
        top: number
        left: number
        anchorEl: HTMLElement | null
      }
  >(null)
  const calendarPreviewRef = useRef<HTMLDivElement | null>(null)
  const [calendarPopoverEditing, setCalendarPopoverEditing] = useState<CalendarPopoverEditingState | null>(null)
  const calendarPopoverFocusedEntryRef = useRef<string | null>(null)
  const calendarPopoverTitleRef = useRef<HTMLDivElement | null>(null)
  // Suppress one subsequent open caused by bubbling/click-after-close on mobile
  const suppressEventOpenRef = useRef(false)
  const suppressNextEventOpen = useCallback(() => {
    suppressEventOpenRef.current = true
    window.setTimeout(() => {
      suppressEventOpenRef.current = false
    }, 300)
  }, [])

  const positionCalendarPreview = useCallback((anchorEl: HTMLElement | null) => {
    if (!anchorEl) return
    const anchorRect = anchorEl.getBoundingClientRect()
    const padding = 8
    const pop = calendarPreviewRef.current
    // Use actual size if mounted, otherwise fall back to assumptions
    const popWidth = pop ? Math.ceil(pop.getBoundingClientRect().width) || 420 : 420
    const popHeight = pop ? Math.ceil(pop.getBoundingClientRect().height) || 220 : 220

    // Available space in each direction
    const rightSpace = Math.max(0, window.innerWidth - padding - anchorRect.right)
    const leftSpace = Math.max(0, anchorRect.left - padding)
    const belowSpace = Math.max(0, window.innerHeight - padding - anchorRect.bottom)
    const aboveSpace = Math.max(0, anchorRect.top - padding)

    // Try placements in priority order: right, left, below, above
    // Choose the first placement that fully fits; otherwise use the best partial and clamp
    type Placement = 'right' | 'left' | 'below' | 'above'
    const candidates: Placement[] = []
    if (rightSpace >= leftSpace) {
      candidates.push('right', 'left', 'below', 'above')
    } else {
      candidates.push('left', 'right', 'below', 'above')
    }

    let left = 0
    let top = 0
    let placed = false

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

    for (const placement of candidates) {
      if (placement === 'right') {
        if (rightSpace >= popWidth) {
          left = Math.round(anchorRect.right + padding)
          // align to anchor top by default, then clamp vertically
          top = Math.round(anchorRect.top)
          placed = true
          break
        }
      } else if (placement === 'left') {
        if (leftSpace >= popWidth) {
          left = Math.round(anchorRect.left - popWidth - padding)
          top = Math.round(anchorRect.top)
          placed = true
          break
        }
      } else if (placement === 'below') {
        if (belowSpace >= popHeight) {
          top = Math.round(anchorRect.bottom + padding)
          // Prefer aligning left edges; clamp within viewport
          left = Math.round(anchorRect.left)
          placed = true
          break
        }
      } else if (placement === 'above') {
        if (aboveSpace >= popHeight) {
          top = Math.round(anchorRect.top - popHeight - padding)
          left = Math.round(anchorRect.left)
          placed = true
          break
        }
      }
    }

    if (!placed) {
      // Fallback: choose the direction with the most space and clamp within viewport
      const bestHorizontal = rightSpace >= leftSpace ? 'right' : 'left'
      const bestVertical = belowSpace >= aboveSpace ? 'below' : 'above'
      const preferHorizontal = Math.max(rightSpace, leftSpace) >= Math.max(belowSpace, aboveSpace)
      const placement = preferHorizontal ? bestHorizontal : bestVertical
      switch (placement) {
        case 'right':
          left = Math.round(anchorRect.right + padding)
          top = Math.round(anchorRect.top)
          break
        case 'left':
          left = Math.round(anchorRect.left - popWidth - padding)
          top = Math.round(anchorRect.top)
          break
        case 'below':
          top = Math.round(anchorRect.bottom + padding)
          left = Math.round(anchorRect.left)
          break
        case 'above':
          top = Math.round(anchorRect.top - popHeight - padding)
          left = Math.round(anchorRect.left)
          break
      }
    }

    // Final clamp into the viewport
    left = clamp(left, padding, Math.max(padding, window.innerWidth - padding - popWidth))
    top = clamp(top, padding, Math.max(padding, window.innerHeight - padding - popHeight))

    if (pop) {
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
    }
  }, [])

  const handleOpenCalendarPreview = useCallback(
    (entry: HistoryEntry, targetEl: HTMLElement) => {
      // Select entry for consistency with other flows
      handleSelectHistorySegment(entry)
      // Compute an initial position immediately
      const rect = targetEl.getBoundingClientRect()
      const viewportPadding = 8
      const assumedWidth = 420
      const assumedHeight = 220
      const rightSpace = Math.max(0, window.innerWidth - viewportPadding - rect.right)
      const leftSpace = Math.max(0, rect.left - viewportPadding)
      const belowSpace = Math.max(0, window.innerHeight - viewportPadding - rect.bottom)
      const aboveSpace = Math.max(0, rect.top - viewportPadding)
      // Try right/left first, then below/above; pick best fit
      let left = 0
      let top = 0
      let placed = false
      if (rightSpace >= assumedWidth) {
        left = Math.round(rect.right + viewportPadding)
        top = Math.round(rect.top)
        placed = true
      } else if (leftSpace >= assumedWidth) {
        left = Math.round(rect.left - assumedWidth - viewportPadding)
        top = Math.round(rect.top)
        placed = true
      } else if (belowSpace >= assumedHeight) {
        top = Math.round(rect.bottom + viewportPadding)
        left = Math.round(rect.left)
        placed = true
      } else if (aboveSpace >= assumedHeight) {
        top = Math.round(rect.top - assumedHeight - viewportPadding)
        left = Math.round(rect.left)
        placed = true
      }
      if (!placed) {
        // Fallback: choose side with most space and clamp
        if (Math.max(rightSpace, leftSpace) >= Math.max(belowSpace, aboveSpace)) {
          if (rightSpace >= leftSpace) {
            left = Math.round(rect.right + viewportPadding)
          } else {
            left = Math.round(rect.left - assumedWidth - viewportPadding)
          }
          top = Math.round(rect.top)
        } else {
          if (belowSpace >= aboveSpace) {
            top = Math.round(rect.bottom + viewportPadding)
          } else {
            top = Math.round(rect.top - assumedHeight - viewportPadding)
          }
          left = Math.round(rect.left)
        }
        // Clamp into viewport
        left = Math.min(Math.max(left, viewportPadding), Math.max(viewportPadding, window.innerWidth - viewportPadding - assumedWidth))
        top = Math.min(Math.max(top, viewportPadding), Math.max(viewportPadding, window.innerHeight - viewportPadding - assumedHeight))
      }
      setCalendarPreview({ entryId: entry.id, top, left, anchorEl: targetEl })
      // Position on next frame to refine based on actual size
      requestAnimationFrame(() => positionCalendarPreview(targetEl))
    },
    [handleSelectHistorySegment, positionCalendarPreview],
  )

  const handleCloseCalendarPreview = useCallback(() => setCalendarPreview(null), [])

  useEffect(() => {
    if (!calendarPreview) return
    const onDocPointerDown = (e: PointerEvent) => {
      const node = e.target as Node | null
      if (!node) return
      // Ignore clicks inside the popover
      if (calendarPreviewRef.current && calendarPreviewRef.current.contains(node)) return
      // If tapping a calendar event while a popover is open, immediately open that event's popover (single tap behavior)
      if (node instanceof Element) {
        const evEl = node.closest('.calendar-event') as HTMLElement | null
        if (evEl && evEl.dataset.entryId) {
          const entry = effectiveHistory.find((h) => h.id === evEl.dataset.entryId)
          if (entry) {
            // Suppress the subsequent click from re-triggering
            suppressNextEventOpen()
            // If this is the same entry that's already open, toggle it closed
            if (calendarPreview && calendarPreview.entryId === entry.id) {
              handleCloseCalendarPreview()
              return
            }
            // Otherwise open the tapped entry
            handleOpenCalendarPreview(entry, evEl)
            return
          }
        }
      }
      handleCloseCalendarPreview()
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') handleCloseCalendarPreview()
    }
    const onReposition = () => {
      if (typeof window !== 'undefined' && 'visualViewport' in window) {
        const vv = window.visualViewport
        if (vv) {
          // Skip repositioning for tiny viewport heights (likely keyboard).
          if (vv.height < window.innerHeight * 0.6) {
            return
          }
        }
      }
      positionCalendarPreview(calendarPreview.anchorEl || null)
      // After moving, clamp again based on actual size (DOM-only)
      const pop = calendarPreviewRef.current
      if (!pop) return
      const rect = pop.getBoundingClientRect()
      const padding = 8
      let top = rect.top
      let left = rect.left
      if (rect.right > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - padding - rect.width)
      }
      if (rect.bottom > window.innerHeight - padding) {
        top = Math.max(padding, window.innerHeight - padding - rect.height)
      }
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKeyDown as any)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKeyDown as any)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [calendarPreview, handleCloseCalendarPreview, positionCalendarPreview, effectiveHistory, handleOpenCalendarPreview, suppressNextEventOpen])

  useEffect(() => {
    if (!calendarPreview) {
      setCalendarPopoverEditing(null)
      calendarPopoverFocusedEntryRef.current = null
      return
    }
    setCalendarPopoverEditing((current) => {
      if (!current) {
        return current
      }
      return current.entryId === calendarPreview.entryId ? current : null
    })
  }, [calendarPreview])

  useEffect(() => {
    if (!calendarPopoverEditing) {
      calendarPopoverFocusedEntryRef.current = null
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    if (calendarPopoverFocusedEntryRef.current === calendarPopoverEditing.entryId) {
      return
    }
    const editingState = calendarPopoverEditing
    calendarPopoverFocusedEntryRef.current = editingState.entryId
    const raf = window.requestAnimationFrame(() => {
      const editableEl = calendarPopoverTitleRef.current
      if (!editableEl) {
        return
      }
      try {
        editableEl.focus({ preventScroll: true })
      } catch {
        try { editableEl.focus() } catch {}
      }
      let snapshotApplied = false
      if (editingState.selectionSnapshot) {
        snapshotApplied = applySelectionSnapshot(editableEl, editingState.selectionSnapshot)
      }
      if (!snapshotApplied) {
        const selection = window.getSelection()
        if (selection) {
          const range = (editableEl.ownerDocument || document).createRange()
          range.selectNodeContents(editableEl)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
        }
      }
      if (editingState.selectionSnapshot) {
        setCalendarPopoverEditing((state) => {
          if (!state || state.entryId !== editingState.entryId || !state.selectionSnapshot) {
            return state
          }
          return { ...state, selectionSnapshot: null }
        })
      }
    })
    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [calendarPopoverEditing, setCalendarPopoverEditing])

  useLayoutEffect(() => {
    const editableEl = calendarPopoverTitleRef.current
    const editingState = calendarPopoverEditing
    if (!editableEl || !editingState) {
      return
    }
    const desired = editingState.value
    if (editableEl.textContent !== desired) {
      editableEl.textContent = desired
    }
  }, [calendarPopoverEditing])

  const anchoredTooltipId = hoveredHistoryId ?? selectedHistoryId
  const dayEntryCount = daySegments.length
  const monthAndYearLabel = useMemo(() => {
    return anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }, [anchorDate])
  const dayLabel = useMemo(() => {
    const date = new Date(dayStart)
    const weekday = date.toLocaleDateString(undefined, { weekday: 'long' })
    const dayNumber = date.getDate().toString().padStart(2, '0')
    return `${weekday} · ${dayNumber}`
  }, [dayStart])
  const daysInMonth = useMemo(() => {
    const d = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0)
    return d.getDate()
  }, [anchorDate])

  const stepSizeByView: Record<CalendarViewMode, number> = useMemo(
    () => ({ day: 1, '3d': Math.max(2, Math.min(multiDayCount, 14)), week: 7, month: daysInMonth, year: 365 }),
    [daysInMonth, multiDayCount],
  )

  useEffect(() => {
    historyDayOffsetRef.current = historyDayOffset
    calendarPanDesiredOffsetRef.current = historyDayOffset
  }, [historyDayOffset])

  const navigateByDelta = useCallback(
    (delta: number) => {
      if (delta === 0) {
        return
      }
      const baseOffset = calendarPanDesiredOffsetRef.current
      const targetOffset = baseOffset + delta
      if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      const area = calendarDaysAreaRef.current
      if (!area) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      const visibleDayCount =
        calendarView === '3d'
          ? Math.max(2, Math.min(multiDayCount, 14))
          : calendarView === 'week'
            ? 7
            : 1
      const dayWidth = area.clientWidth / Math.max(1, visibleDayCount)
      if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      stopCalendarPanAnimation({ commit: true })
      calendarPanDesiredOffsetRef.current = targetOffset
      historyDayOffsetRef.current = targetOffset
      const snapDays = -(targetOffset - baseOffset)
      animateCalendarPan(snapDays, dayWidth, baseOffset)
    },
    [animateCalendarPan, calendarView, multiDayCount, stopCalendarPanAnimation],
  )

  const handlePrevWindow = useCallback(() => {
    navigateByDelta(-stepSizeByView[calendarView])
  }, [calendarView, navigateByDelta, stepSizeByView])

  const handleNextWindow = useCallback(() => {
    navigateByDelta(stepSizeByView[calendarView])
  }, [calendarView, navigateByDelta, stepSizeByView])

  const handleJumpToToday = useCallback(() => {
    const currentOffset = historyDayOffsetRef.current
    navigateByDelta(-currentOffset)
  }, [navigateByDelta])

  const setView = useCallback((view: CalendarViewMode) => {
    setCalendarView(view)
  }, [])

  useEffect(() => {
    if (!showMultiDayChooser) {
      multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
    }
  }, [multiDayCount, showMultiDayChooser])

  useEffect(() => {
    if (!showMultiDayChooser) return
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      const container = multiChooserRef.current
      if (container && target && container.contains(target)) {
        return
      }
      setShowMultiDayChooser(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [showMultiDayChooser])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const DOUBLE_PRESS_THRESHOLD_MS = 450
    const options = Array.from(MULTI_DAY_OPTIONS) as Array<(typeof MULTI_DAY_OPTIONS)[number]>
    const getNormalizedSelection = (fallback?: number): (typeof MULTI_DAY_OPTIONS)[number] => {
      if (fallback !== undefined && isValidMultiDayOption(fallback)) {
        return fallback
      }
      if (isValidMultiDayOption(multiDayCount)) {
        return multiDayCount
      }
      return options[options.length - 1]
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        const isEditable = target.isContentEditable
        if (isEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return
        }
      }
      const key = event.key.toLowerCase()
      const keyboardState = multiDayKeyboardStateRef.current
      if (keyboardState?.active && showMultiDayChooser) {
        if (key === 'arrowleft' || key === 'arrowright') {
          event.preventDefault()
          const currentSelection = getNormalizedSelection(keyboardState.selection)
          const currentIndex = Math.max(0, options.indexOf(currentSelection))
          let nextIndex = currentIndex
          if (key === 'arrowleft') {
            nextIndex = Math.max(0, currentIndex - 1)
          } else if (key === 'arrowright') {
            nextIndex = Math.min(options.length - 1, currentIndex + 1)
          }
          const nextSelection = options[nextIndex]
          multiDayKeyboardStateRef.current = { active: true, selection: nextSelection }
          focusMultiDayOption(nextSelection)
          return
        }
        if (key === 'enter') {
          event.preventDefault()
          const selection = getNormalizedSelection(keyboardState.selection)
          setMultiDayCount(selection)
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection }
          return
        }
        if (key === 'escape') {
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          return
        }
      }
      switch (key) {
        case 'd': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'd', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('day')
          return
        }
        case 'x': {
          const now = Date.now()
          const last = lastCalendarHotkeyRef.current
          const isDouble = Boolean(last && last.key === 'x' && now - last.timestamp < DOUBLE_PRESS_THRESHOLD_MS)
          lastCalendarHotkeyRef.current = { key: 'x', timestamp: now }
          event.preventDefault()
          if (calendarView !== '3d') {
            setView('3d')
            setShowMultiDayChooser(false)
            multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
            return
          }
          if (isDouble) {
            const selection = getNormalizedSelection()
            setShowMultiDayChooser(true)
            multiDayKeyboardStateRef.current = { active: true, selection }
            if (typeof window !== 'undefined') {
              window.requestAnimationFrame(() => focusMultiDayOption(selection))
            }
          } else {
            setShowMultiDayChooser(false)
            multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          }
          return
        }
        case 'w': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'w', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('week')
          return
        }
        case 'm': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'm', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('month')
          return
        }
        case 'y': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'y', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('year')
          return
        }
        case 'p': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'p', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handlePrevWindow()
          return
        }
        case 'n': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'n', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handleNextWindow()
          return
        }
        case 't': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 't', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handleJumpToToday()
          return
        }
        default: {
          lastCalendarHotkeyRef.current = { key, timestamp: Date.now() }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    calendarView,
    focusMultiDayOption,
    multiDayCount,
    setMultiDayCount,
    setView,
    setShowMultiDayChooser,
    showMultiDayChooser,
  ])

  // Outside-React updater for the calendar now-line to keep UI smooth without full re-renders
  useEffect(() => {
    if (typeof window === 'undefined') return
    let rafId: number | null = null
    let intervalId: number | null = null
    const update = () => {
      const el = calendarNowLineRef.current
      if (!el) return
      const ds = Number((el as any).dataset.dayStart || 0)
      if (!Number.isFinite(ds) || ds <= 0) {
        el.style.display = 'none'
        return
      }
      const now = Date.now()
      const pct = ((now - ds) / DAY_DURATION_MS) * 100
      if (pct < 0 || pct > 100) {
        el.style.display = 'none'
        return
      }
      if (el.style.display === 'none') {
        el.style.display = ''
      }
      el.style.top = `${Math.min(Math.max(pct, 0), 100)}%`
    }
    const tick = () => {
      if (rafId !== null) {
        try { window.cancelAnimationFrame(rafId) } catch {}
      }
      rafId = window.requestAnimationFrame(update)
    }
    // Initial paint
    tick()
    // Update roughly once per second for smoothness without heavy cost
    intervalId = window.setInterval(tick, 1000)
    return () => {
      if (intervalId !== null) {
        try { window.clearInterval(intervalId) } catch {}
      }
      if (rafId !== null) {
        try { window.cancelAnimationFrame(rafId) } catch {}
      }
    }
  }, [calendarView, historyDayOffset])

  // Clamp the multi-day chooser popover within the viewport
  useEffect(() => {
    if (!showMultiDayChooser) return
    const node = multiChooserRef.current
    if (!node) return
    const clamp = () => {
      const pad = 8
      // Reset any previous overrides
      node.style.left = ''
      node.style.right = ''
      node.style.top = ''
      node.style.bottom = ''
      node.style.transform = ''
      let rect = node.getBoundingClientRect()
      // If overflowing bottom, flip above the toggle
      if (rect.bottom > window.innerHeight - pad) {
        node.style.top = 'auto'
        node.style.bottom = 'calc(100% + 6px)'
        rect = node.getBoundingClientRect()
      }
      // Compute translation needed to fully fit within viewport horizontally and vertically
      let dx = 0
      let dy = 0
      if (rect.right > window.innerWidth - pad) {
        dx = Math.min(dx, (window.innerWidth - pad) - rect.right)
      }
      if (rect.left < pad) {
        dx = Math.max(dx, pad - rect.left)
      }
      if (rect.top < pad) {
        dy = Math.max(dy, pad - rect.top)
      }
      if (rect.bottom > window.innerHeight - pad) {
        dy = Math.min(dy, (window.innerHeight - pad) - rect.bottom)
      }
      if (dx !== 0 || dy !== 0) {
        node.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
      }
    }
    // Clamp now and on resize/scroll
    const raf = requestAnimationFrame(clamp)
    const onReflow = () => clamp()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [showMultiDayChooser])

  const handleMultiDayDoubleClick = useCallback(() => {
    setView('3d')
    multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
    setShowMultiDayChooser(true)
  }, [multiDayCount, setView])

  const handleCalendarAreaPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) {
      return
    }
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target && (target.closest('.calendar-event') || target.closest('button'))) {
      return
    }
    const area = calendarDaysAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    if (rect.width <= 0) return
    stopCalendarPanAnimation()
    const daysEl = calendarDaysRef.current
    const hdrEl = calendarHeadersRef.current
    if (daysEl) {
      daysEl.style.transition = ''
    }
    if (hdrEl) {
      hdrEl.style.transition = ''
    }
    const dayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
    const baseOffset = calendarPanDesiredOffsetRef.current
    calendarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      areaWidth: rect.width,
      dayCount,
      baseOffset,
      mode: 'pending',
      lastAppliedDx: 0,
    }
    // Don't capture or preventDefault yet; wait until we detect horizontal intent
    const handleMove = (e: PointerEvent) => {
      const state = calendarDragRef.current
      if (!state || e.pointerId !== state.pointerId) return
      const dy = e.clientY - state.startY
      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
      if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
      const dx = e.clientX - state.startX
      // Intent detection
      if (state.mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        const threshold = 8
        if (absY > threshold && absY > absX) {
          // Vertical scroll intent: abort calendar drag and let page scroll
          window.removeEventListener('pointermove', handleMove)
          window.removeEventListener('pointerup', handleUp)
          window.removeEventListener('pointercancel', handleUp)
          calendarDragRef.current = null
          return
        }
        if (absX > threshold && absX > absY) {
          // Horizontal drag confirmed: capture and prevent default
          try { area.setPointerCapture?.(e.pointerId) } catch {}
          state.mode = 'hdrag'
        } else {
          return
        }
      }
      // From here, horizontal drag is active
      try { e.preventDefault() } catch {}
      const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
      state.lastAppliedDx = constrainedDx
      // Smooth pan: do not update historyDayOffset while dragging to avoid re-renders
      const totalPx = calendarBaseTranslateRef.current + constrainedDx
      const daysEl = calendarDaysRef.current
      if (daysEl) {
        daysEl.style.transform = `translateX(${totalPx}px)`
      }
      const hdrEl = calendarHeadersRef.current
      if (hdrEl) {
        hdrEl.style.transform = `translateX(${totalPx}px)`
      }
    }
    const handleUp = (e: PointerEvent) => {
      const state = calendarDragRef.current
      if (!state || e.pointerId !== state.pointerId) return
      area.releasePointerCapture?.(e.pointerId)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      const dx = e.clientX - state.startX
      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
      let resetImmediately = true
      if (state.mode === 'hdrag' && Number.isFinite(dayWidth) && dayWidth > 0) {
        const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
        state.lastAppliedDx = appliedDx
        const totalPx = calendarBaseTranslateRef.current + appliedDx
        const daysEl = calendarDaysRef.current
        if (daysEl) {
          daysEl.style.transform = `translateX(${totalPx}px)`
        }
        const hdrEl = calendarHeadersRef.current
        if (hdrEl) {
          hdrEl.style.transform = `translateX(${totalPx}px)`
        }
        const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
        if (snap !== 0) {
          animateCalendarPan(snap, dayWidth, state.baseOffset)
          resetImmediately = false
        } else {
          animateCalendarPan(0, dayWidth, state.baseOffset)
        }
      }
      if (resetImmediately) {
        const base = calendarBaseTranslateRef.current
        const daysEl = calendarDaysRef.current
        if (daysEl) {
          daysEl.style.transform = `translateX(${base}px)`
        }
        const hdrEl = calendarHeadersRef.current
        if (hdrEl) {
          hdrEl.style.transform = `translateX(${base}px)`
        }
      }
      calendarDragRef.current = null
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }, [calendarView, multiDayCount, stopCalendarPanAnimation, resolvePanSnap, animateCalendarPan])

  // Build minimal calendar content for non-day views
  const renderCalendarContent = useCallback(() => {
    const entries = effectiveHistory
    const dayHasSessions = (startMs: number, endMs: number) =>
      entries.some((e) => Math.min(e.endedAt, endMs) > Math.max(e.startedAt, startMs))

    const renderCell = (date: Date, isCurrentMonth: boolean) => {
      const start = new Date(date)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      const has = dayHasSessions(start.getTime(), end.getTime())
      return (
        <div
          key={`cell-${start.toISOString()}`}
          className={`calendar-cell${isCurrentMonth ? '' : ' calendar-cell--muted'}`}
          aria-label={start.toDateString()}
        >
          <div className="calendar-day-number">{start.getDate()}</div>
          {has ? <div className="calendar-session-dot" aria-hidden="true" /> : null}
        </div>
      )
    }

    if (calendarView === 'day' || calendarView === '3d' || calendarView === 'week') {
      const visibleDayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
      const bufferDays = getCalendarBufferDays(visibleDayCount)
      const totalCount = visibleDayCount + bufferDays * 2
      // Determine range start (shifted by buffer)
      const windowStart = new Date(anchorDate)
      if (calendarView === 'week') {
        const dow = windowStart.getDay() // 0=Sun
        windowStart.setDate(windowStart.getDate() - dow)
      }
      windowStart.setDate(windowStart.getDate() - bufferDays)
      const dayStarts: number[] = []
      for (let i = 0; i < totalCount; i += 1) {
        const d = new Date(windowStart)
        d.setDate(windowStart.getDate() + i)
        d.setHours(0, 0, 0, 0)
        dayStarts.push(d.getTime())
      }
      type DayEvent = {
        entry: HistoryEntry
        topPct: number
        heightPct: number
        color: string
        gradientCss?: string
        label: string
        rangeLabel: string
        clipPath?: string
        zIndex: number
        showLabel: boolean
        showTime: boolean
      }

      const computeDayEvents = (startMs: number): DayEvent[] => {
        const endMs = startMs + DAY_DURATION_MS
        const START_GROUP_EPS = 60 * 1000

        type RawEvent = {
          entry: HistoryEntry
          start: number
          end: number
          previewStart: number
          previewEnd: number
        }

        type Segment = { start: number; end: number; left: number; right: number }
        type SliceAssignment = { left: number; right: number }

        const raw: RawEvent[] = effectiveHistory
          .map((entry) => {
            const isPreviewed = dragPreview && dragPreview.entryId === entry.id
            const previewStart = isPreviewed ? dragPreview.startedAt : entry.startedAt
            const previewEnd = isPreviewed ? dragPreview.endedAt : entry.endedAt
            const clampedStart = Math.max(Math.min(previewStart, previewEnd), startMs)
            const clampedEnd = Math.min(Math.max(previewStart, previewEnd), endMs)
            if (clampedEnd <= clampedStart) {
              return null
            }
            return {
              entry,
              start: clampedStart,
              end: clampedEnd,
              previewStart,
              previewEnd,
            }
          })
          .filter((v): v is RawEvent => Boolean(v))
          .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start))

        if (raw.length === 0) {
          return []
        }

        const breakpointsSet = new Set<number>([startMs, endMs])
        raw.forEach(({ start, end }) => {
          breakpointsSet.add(start)
          breakpointsSet.add(end)
        })
        const breakpoints = Array.from(breakpointsSet).sort((a, b) => a - b)

        const allEvents = new Map<string, RawEvent>()
        raw.forEach((info) => {
          allEvents.set(info.entry.id, info)
        })

        const eventSlices = new Map<string, Segment[]>()
        const prevAssignments = new Map<string, SliceAssignment>()

        const clampSegment = (segment: Segment): Segment => ({
          start: clamp01(segment.start),
          end: clamp01(segment.end),
          left: clamp01(segment.left),
          right: clamp01(segment.right),
        })

        const approxEqual = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) <= epsilon

        const mergeSegments = (segments: Segment[]): Segment[] => {
          if (segments.length === 0) {
            return [{ start: 0, end: 1, left: 0, right: 1 }]
          }
          const sorted = segments
            .map(clampSegment)
            .filter((segment) => segment.end > segment.start)
            .sort((a, b) => a.start - b.start)
          if (sorted.length === 0) {
            return [{ start: 0, end: 1, left: 0, right: 1 }]
          }
          const merged: Segment[] = []
          sorted.forEach((segment) => {
            const current = { ...segment }
            if (merged.length === 0) {
              merged.push(current)
              return
            }
            const last = merged[merged.length - 1]
            if (
              approxEqual(last.right, current.right, 1e-4) &&
              approxEqual(last.left, current.left, 1e-4) &&
              approxEqual(last.end, current.start, 1e-4)
            ) {
              last.end = current.end
            } else {
              merged.push(current)
            }
          })
          // Ensure spans start at 0 and end at 1 for stable clip paths
          merged[0].start = 0
          merged[merged.length - 1].end = 1
          return merged
        }

        const buildClipPath = (segments: Segment[]): string | undefined => {
          if (segments.length === 1) {
            const [segment] = segments
            if (approxEqual(segment.left, 0) && approxEqual(segment.right, 1)) {
              return undefined
            }
          }
          const points: Array<{ x: number; y: number }> = []
          const first = segments[0]
          points.push({ x: clamp01(first.left), y: clamp01(first.start) })
          points.push({ x: clamp01(first.right), y: clamp01(first.start) })
          segments.forEach((segment) => {
            points.push({ x: clamp01(segment.right), y: clamp01(segment.end) })
          })
          const last = segments[segments.length - 1]
          points.push({ x: clamp01(last.left), y: clamp01(last.end) })
          for (let i = segments.length - 1; i >= 0; i -= 1) {
            const segment = segments[i]
            points.push({ x: clamp01(segment.left), y: clamp01(segment.start) })
          }

          const filtered: Array<{ x: number; y: number }> = []
          points.forEach((point, index) => {
            if (index === 0) {
              filtered.push(point)
              return
            }
            const prev = filtered[filtered.length - 1]
            if (!approxEqual(prev.x, point.x, 1e-4) || !approxEqual(prev.y, point.y, 1e-4)) {
              filtered.push(point)
            }
          })
          if (filtered.length > 0) {
            const firstPoint = filtered[0]
            const lastPoint = filtered[filtered.length - 1]
            if (approxEqual(firstPoint.x, lastPoint.x, 1e-4) && approxEqual(firstPoint.y, lastPoint.y, 1e-4)) {
              filtered.pop()
            }
          }
          if (filtered.length < 3) {
            return undefined
          }
          return `polygon(${filtered
            .map((point) => `${(point.x * 100).toFixed(3)}% ${(point.y * 100).toFixed(3)}%`)
            .join(', ')})`
        }

        for (let i = 0; i < breakpoints.length - 1; i += 1) {
          const sliceStart = breakpoints[i]
          const sliceEnd = breakpoints[i + 1]
          if (sliceEnd - sliceStart <= 0) {
            continue
          }

          const active = raw.filter(({ start, end }) => end > sliceStart && start < sliceEnd)
          if (active.length === 0) {
            continue
          }

          const sliceAssignments = new Map<string, SliceAssignment>()
          const continuing = active.filter(({ start }) => start < sliceStart - START_GROUP_EPS)
          const newStarters = active.filter(({ start }) => Math.abs(start - sliceStart) <= START_GROUP_EPS)

          continuing.forEach(({ entry }) => {
            const prev = prevAssignments.get(entry.id)
            if (prev) {
              sliceAssignments.set(entry.id, prev)
            } else {
              sliceAssignments.set(entry.id, { left: 0, right: 1 })
            }
          })

          if (continuing.length === 0) {
            const sorted = active
              .slice()
              .sort((a, b) => (a.start === b.start ? (b.end - b.start) - (a.end - a.start) : a.start - b.start))
            const width = sorted.length > 0 ? 1 / sorted.length : 1
            sorted.forEach((ev, index) => {
              const left = index * width
              sliceAssignments.set(ev.entry.id, { left, right: Math.min(1, left + width) })
            })
          } else if (newStarters.length > 0) {
            const sortedNew = newStarters
              .slice()
              .sort((a, b) => {
                const durationA = a.end - a.start
                const durationB = b.end - b.start
                if (durationA === durationB) {
                  return a.entry.id.localeCompare(b.entry.id)
                }
                return durationA - durationB
              })
            sortedNew.forEach((ev) => {
              sliceAssignments.set(ev.entry.id, { left: 0, right: 1 })
            })
          }

          active.forEach((ev) => {
            if (!sliceAssignments.has(ev.entry.id)) {
              const prev = prevAssignments.get(ev.entry.id) ?? { left: 0, right: 1 }
              sliceAssignments.set(ev.entry.id, prev)
            }
          })

          sliceAssignments.forEach((assignment, entryId) => {
            const info = allEvents.get(entryId)
            if (!info) {
              return
            }
            const clampedStart = Math.max(sliceStart, info.start)
            const clampedEnd = Math.min(sliceEnd, info.end)
            if (clampedEnd - clampedStart <= 0) {
              return
            }
            const duration = Math.max(info.end - info.start, 1)
            const segmentStart = (clampedStart - info.start) / duration
            const segmentEnd = (clampedEnd - info.start) / duration
            const segments = eventSlices.get(entryId) ?? []
            segments.push({
              start: segmentStart,
              end: segmentEnd,
              left: assignment.left,
              right: assignment.right,
            })
            eventSlices.set(entryId, segments)
          })

          prevAssignments.clear()
          sliceAssignments.forEach((assignment, entryId) => {
            prevAssignments.set(entryId, assignment)
          })
        }

        return raw.map((info, index) => {
          const metadata = resolveGoalMetadata(info.entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
          const gradientCss = metadata.colorInfo?.gradient?.css
          const solidColor = metadata.colorInfo?.solidColor
          const fallbackLabel = deriveEntryTaskName(info.entry)
          const color = gradientCss ?? solidColor ?? getPaletteColorForLabel(fallbackLabel)

          const segments = mergeSegments(eventSlices.get(info.entry.id) ?? [{ start: 0, end: 1, left: 0, right: 1 }])
          const clipPath = buildClipPath(segments)

          const topPct = ((info.start - startMs) / DAY_DURATION_MS) * 100
          const heightPct = Math.max(((info.end - info.start) / DAY_DURATION_MS) * 100, (MINUTE_MS / DAY_DURATION_MS) * 100)
          const rangeLabel = `${formatTimeOfDay(info.previewStart)} — ${formatTimeOfDay(info.previewEnd)}`

          const duration = Math.max(info.end - info.start, 1)
          const durationScore = Math.max(0, Math.round((DAY_DURATION_MS - duration) / MINUTE_MS))
          const startScore = Math.max(0, Math.round((info.start - startMs) / MINUTE_MS))
          const zIndex = 100000 + durationScore * 1000 - startScore + index

          const durationMinutes = duration / MINUTE_MS
          const showLabel = durationMinutes >= 8
          const showTime = durationMinutes >= 20

          return {
            entry: info.entry,
            topPct: Math.min(Math.max(topPct, 0), 100),
            heightPct: Math.min(Math.max(heightPct, 0.4), 100),
            color,
            gradientCss,
            label: fallbackLabel,
            rangeLabel,
            clipPath,
            zIndex,
            showLabel,
            showTime,
          }
        })
      }

      // Set CSS var for column count via inline style on container later
      const todayMidnight = (() => {
        const t = new Date()
        t.setHours(0, 0, 0, 0)
        return t.getTime()
      })()

      // Helper: toggle global scroll lock (prevents page scroll on touch during active drags)
      const setPageScrollLock = (locked: boolean) => {
        if (typeof document === 'undefined') return
        const root = document.documentElement
        const body = document.body as HTMLBodyElement & { dataset: DOMStringMap }
        const ua = navigator.userAgent || ''
        const isIOS = /iP(ad|hone|od)/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1)
        if (locked) {
          // If already locked, no-op
          if (body.dataset.scrollLockActive === '1') return
          body.dataset.scrollLockActive = '1'
          const y = (window.scrollY || root.scrollTop || (document.scrollingElement?.scrollTop ?? 0) || 0)
          body.dataset.scrollLockY = String(y)
          if (isIOS) {
            // iOS Safari: avoid position:fixed to prevent address bar/UI jumps; block scrolling via global touchmove preventer
            const preventer: EventListener = (e: Event) => {
              try { e.preventDefault() } catch {}
            }
            ;(window as any).__scrollLockTouchPreventer = preventer
            try { window.addEventListener('touchmove', preventer, { passive: false }) } catch {}
          } else {
            root.classList.add('scroll-lock')
            body.classList.add('scroll-lock')
            // Non-iOS fallback: freeze body to prevent any viewport scroll reliably
            body.style.position = 'fixed'
            body.style.top = `-${y}px`
            body.style.left = '0'
            body.style.right = '0'
            body.style.width = '100%'
            body.style.overflow = 'hidden'
          }
        } else {
          // If not locked, no-op
          if (body.dataset.scrollLockActive !== '1') return
          delete body.dataset.scrollLockActive
          const yStr = body.dataset.scrollLockY || root.dataset.scrollLockY
          delete body.dataset.scrollLockY
          delete root.dataset.scrollLockY
          // Remove iOS touchmove preventer if present
          const preventer = (window as any).__scrollLockTouchPreventer as EventListener | undefined
          if (preventer) {
            try { window.removeEventListener('touchmove', preventer) } catch {}
            delete (window as any).__scrollLockTouchPreventer
          }
          // Restore body styles (for non-iOS fallback)
          if (body.style.position === 'fixed') {
            body.style.position = ''
            body.style.top = ''
            body.style.left = ''
            body.style.right = ''
            body.style.width = ''
            body.style.overflow = ''
            root.classList.remove('scroll-lock')
            body.classList.remove('scroll-lock')
          }
          // Restore scroll position
          const y = yStr ? parseInt(yStr, 10) : (window.scrollY || 0)
          try { window.scrollTo(0, y) } catch {}
        }
      }

      // Drag state for calendar events (move only, vertical + cross-day)
      const calendarEventDragRef = {
        current: null as null | {
          pointerId: number
          entryId: string
          startX: number
          startY: number
          initialStart: number
          initialEnd: number
          initialTimeOfDayMs: number
          durationMs: number
          kind: DragKind
          columns: Array<{ rect: DOMRect; dayStart: number }>
          moved?: boolean
          activated?: boolean
        },
      }

      const handleCalendarEventPointerDown = (
        entry: HistoryEntry,
        entryDayStart: number,
      ) => (ev: ReactPointerEvent<HTMLDivElement>) => {
        if (entry.id === 'active-session') return
        if (ev.button !== 0) return
        const isTouch = (ev as any).pointerType === 'touch'
  const daysRoot = calendarDaysRef.current
        if (!daysRoot) return
        const columnEls = Array.from(daysRoot.querySelectorAll<HTMLDivElement>('.calendar-day-column'))
        if (columnEls.length === 0) return
        const columns = columnEls.map((el, idx) => ({ rect: el.getBoundingClientRect(), dayStart: dayStarts[idx] }))
  const area = calendarDaysAreaRef.current
        // Find the column we started in
        const startColIdx = columns.findIndex((c) => ev.clientX >= c.rect.left && ev.clientX <= c.rect.right)
        const col = startColIdx >= 0 ? columns[startColIdx] : columns[0]
        const colHeight = col.rect.height
        if (!(Number.isFinite(colHeight) && colHeight > 0)) return
        // Determine drag kind by edge proximity (top/bottom = resize, else move)
        const evRect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
        const edgePx = Math.min(12, Math.max(6, evRect.height * 0.2))
  let kind: DragKind = 'move'
        if (ev.clientY - evRect.top <= edgePx) kind = 'resize-start'
        else if (evRect.bottom - ev.clientY <= edgePx) kind = 'resize-end'
  // Mark intended drag kind on the element so CSS can show the right cursor once dragging begins
  const targetEl = ev.currentTarget as HTMLDivElement
  if (kind === 'move') targetEl.dataset.dragKind = 'move'
  else targetEl.dataset.dragKind = 'resize'
        // Compute time-of-day at drag start (use visible edge for resize)
        const clampedStart = Math.max(Math.min(entry.startedAt, entry.endedAt), entryDayStart)
        const clampedEnd = Math.min(Math.max(entry.startedAt, entry.endedAt), entryDayStart + DAY_DURATION_MS)
        const timeOfDayMs0 = (kind === 'resize-end' ? clampedEnd : clampedStart) - entryDayStart
        const state = {
          pointerId: ev.pointerId,
          entryId: entry.id,
          startX: ev.clientX,
          startY: ev.clientY,
          initialStart: entry.startedAt,
          initialEnd: entry.endedAt,
          initialTimeOfDayMs: timeOfDayMs0,
          durationMs: Math.max(entry.endedAt - entry.startedAt, MIN_SESSION_DURATION_DRAG_MS),
          kind,
          columns,
          moved: false,
          activated: false,
        }
        calendarEventDragRef.current = state
        // For mouse/pen: capture immediately. For touch: defer capture until long-press activates drag.
        if (!isTouch) {
          try {
            targetEl.setPointerCapture?.(ev.pointerId)
          } catch {}
        }
        // For touch, require a short hold before activating drag to prevent accidental drags while scrolling
  let touchHoldTimer: number | null = null
  let panningFromEvent = false
        const activateDrag = () => {
          const s = calendarEventDragRef.current
          if (!s || s.activated) return
          s.activated = true
          // Close any open calendar popover as soon as a drag is activated
          handleCloseCalendarPreview()
          // Lock page scroll on touch while dragging an event
          if (isTouch) setPageScrollLock(true)
          try { targetEl.setPointerCapture?.(ev.pointerId) } catch {}
        }
        const onMove = (e: PointerEvent) => {
          const s = calendarEventDragRef.current
          if (!s || e.pointerId !== s.pointerId) return
          // Movement threshold to preserve click semantics
          const dx = e.clientX - s.startX
          const dy = e.clientY - s.startY
          const threshold = 6
          if (!s.activated) {
            if (isTouch) {
              // If finger moves before hold completes, cancel the long-press activation
              if (Math.hypot(dx, dy) > threshold) {
                if (touchHoldTimer !== null) {
                  try { window.clearTimeout(touchHoldTimer) } catch {}
                  touchHoldTimer = null
                }
                // If horizontal movement dominates, treat this as a calendar pan even though we started on an event
                const absX = Math.abs(dx)
                const absY = Math.abs(dy)
                if (absX > absY && area) {
                  if (!panningFromEvent) {
                    const rect = area.getBoundingClientRect()
                    if (rect.width > 0) {
                      const dayCount = calendarView === '3d'
                        ? Math.max(2, Math.min(multiDayCount, 14))
                        : calendarView === 'week'
                          ? 7
                          : 1
                      stopCalendarPanAnimation()
                      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
                      const daysEl = calendarDaysRef.current
                      const hdrEl = calendarHeadersRef.current
                      if (daysEl) daysEl.style.transition = ''
                      if (hdrEl) hdrEl.style.transition = ''
                      const baseOffset = calendarPanDesiredOffsetRef.current
                      calendarDragRef.current = {
                        pointerId: s.pointerId,
                        startX: s.startX,
                        startY: s.startY,
                        startTime: now,
                        areaWidth: rect.width,
                        dayCount,
                        baseOffset,
                        mode: 'hdrag',
                        lastAppliedDx: 0,
                      }
                      try { area.setPointerCapture?.(s.pointerId) } catch {}
                      panningFromEvent = true
                    }
                  }
                  // Perform pan move
                  const state = calendarDragRef.current
                  if (state && state.mode === 'hdrag') {
                    const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                      if (Number.isFinite(dayWidth) && dayWidth > 0) {
                        try { e.preventDefault() } catch {}
                        const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                        state.lastAppliedDx = constrainedDx
                        const totalPx = calendarBaseTranslateRef.current + constrainedDx
                        const daysEl = calendarDaysRef.current
                        if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                        const hdrEl = calendarHeadersRef.current
                        if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                    }
                  }
                  return
                }
                return
              }
              // Not activated yet, and not moved enough — keep waiting for hold
              return
            } else {
              if (Math.hypot(dx, dy) <= threshold) {
                return
              }
              s.activated = true
              handleCloseCalendarPreview()
            }
          }
          // Prevent page/area scrolling while dragging an event
          try { e.preventDefault() } catch {}
          // Base column by X position (nearest if outside bounds)
          const baseIdx = s.columns.findIndex((c) => e.clientX >= c.rect.left && e.clientX <= c.rect.right)
          const nearestIdx = baseIdx >= 0 ? baseIdx : (e.clientX < s.columns[0].rect.left ? 0 : s.columns.length - 1)
          const baseCol = s.columns[nearestIdx]
          const colH = baseCol.rect.height
          if (!(Number.isFinite(colH) && colH > 0)) return
          // Vertical delta to time delta
          const deltaMsRaw = (dy / colH) * DAY_DURATION_MS
          // Snap to minute for stable movement
          const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
          const deltaMs = deltaMinutes * MINUTE_MS
          // Allow crossing midnight by converting overflow into day shifts
          let desiredTimeOfDay = s.initialTimeOfDayMs + deltaMs
          let dayShift = 0
          if (desiredTimeOfDay <= -MINUTE_MS || desiredTimeOfDay >= DAY_DURATION_MS + MINUTE_MS) {
            dayShift = Math.floor(desiredTimeOfDay / DAY_DURATION_MS)
            desiredTimeOfDay = desiredTimeOfDay - dayShift * DAY_DURATION_MS
          }
          // Compute target column after applying vertical overflow
          const targetIdx = Math.min(Math.max(nearestIdx + dayShift, 0), s.columns.length - 1)
          const target = s.columns[targetIdx]
          // Clamp within the day bounds; allow duration to overflow to adjacent day
          const timeOfDay = Math.min(Math.max(desiredTimeOfDay, 0), DAY_DURATION_MS)
          let newStart = s.initialStart
          let newEnd = s.initialEnd
          if (s.kind === 'move') {
            newStart = Math.round(target.dayStart + timeOfDay)
            newEnd = Math.round(newStart + s.durationMs)
          } else if (s.kind === 'resize-start') {
            newStart = Math.round(target.dayStart + timeOfDay)
            // Keep end fixed unless violating minimum duration
            if (newStart > newEnd - MIN_SESSION_DURATION_DRAG_MS) {
              newStart = newEnd - MIN_SESSION_DURATION_DRAG_MS
            }
          } else {
            // resize-end
            newEnd = Math.round(target.dayStart + timeOfDay)
            if (newEnd < newStart + MIN_SESSION_DURATION_DRAG_MS) {
              newEnd = newStart + MIN_SESSION_DURATION_DRAG_MS
            }
          }
          const current = dragPreviewRef.current
          if (current && current.entryId === s.entryId && current.startedAt === newStart && current.endedAt === newEnd) {
            return
          }
          const preview = { entryId: s.entryId, startedAt: newStart, endedAt: newEnd }
          dragPreviewRef.current = preview
          setDragPreview(preview)
          s.moved = true
        }
        const onUp = (e: PointerEvent) => {
          const s = calendarEventDragRef.current
          if (!s || e.pointerId !== s.pointerId) return
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          try { (targetEl as any).releasePointerCapture?.(s.pointerId) } catch {}
          if (panningFromEvent) {
            // Finish calendar pan gesture
            const state = calendarDragRef.current
            if (state && area) {
              try { area.releasePointerCapture?.(state.pointerId) } catch {}
              const dx = e.clientX - state.startX
              const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
              if (Number.isFinite(dayWidth) && dayWidth > 0) {
                const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                state.lastAppliedDx = appliedDx
                const totalPx = calendarBaseTranslateRef.current + appliedDx
                const daysEl = calendarDaysRef.current
                if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                const hdrEl = calendarHeadersRef.current
                if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
                if (snap !== 0) {
                  animateCalendarPan(snap, dayWidth, state.baseOffset)
                } else {
                  animateCalendarPan(0, dayWidth, state.baseOffset)
                }
              } else {
                const base = calendarBaseTranslateRef.current
                const daysEl = calendarDaysRef.current
                if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                const hdrEl = calendarHeadersRef.current
                if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
              }
            }
            calendarDragRef.current = null
            // Suppress click opening preview after a pan
            dragPreventClickRef.current = true
            return
          }
          const preview = dragPreviewRef.current
          if (preview && preview.entryId === s.entryId && (preview.startedAt !== s.initialStart || preview.endedAt !== s.initialEnd)) {
            // A drag occurred and resulted in a time change; commit the change and suppress the click
            dragPreventClickRef.current = true
            updateHistory((current) => {
              const idx = current.findIndex((h) => h.id === s.entryId)
              if (idx === -1) return current
              const target = current[idx]
              const next = [...current]
              next[idx] = {
                ...target,
                startedAt: preview.startedAt,
                endedAt: preview.endedAt,
                elapsed: Math.max(preview.endedAt - preview.startedAt, 1),
              }
              return next
            })
          } else {
            // If drag intent was activated (even if it snapped back to original), suppress the click-preview
            if (s.activated) {
              dragPreventClickRef.current = true
            }
          }
          calendarEventDragRef.current = null
          dragPreviewRef.current = null
          setDragPreview(null)
          // Clear drag kind marker so cursor returns to default/hover affordances
          delete targetEl.dataset.dragKind
          // Always release scroll lock at the end of a drag (noop if not locked)
          if (isTouch) setPageScrollLock(false)
        }
        // For touch, arm the hold timer to activate dragging
        if (isTouch) {
          touchHoldTimer = window.setTimeout(() => {
            touchHoldTimer = null
            activateDrag()
          }, 360)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        // Timer is cleared in onMove (when movement occurs) and onUp (when finishing)
      }
      const headers = dayStarts.map((start, i) => {
        const d = new Date(start)
        const dow = d.toLocaleDateString(undefined, { weekday: 'short' })
        const dateNum = d.getDate()
        const isToday = start === todayMidnight
        return (
          <div key={`hdr-${i}`} className={`calendar-day-header${isToday ? ' is-today' : ''}`} aria-label={d.toDateString()}>
            <div className="calendar-day-header__dow">{dow}</div>
            <div className="calendar-day-header__date">
              <span className="calendar-day-header__date-number" aria-current={isToday ? 'date' : undefined}>{dateNum}</span>
            </div>
          </div>
        )
      })

      const hours = Array.from({ length: 25 }).map((_, h) => h) // 0..24 (24 for bottom line)
      const body = (
        <div className="calendar-vertical__body">
          <div className="calendar-time-axis" aria-hidden>
            {hours.map((h) => (
              <div key={`t-${h}`} className="calendar-time-label" style={{ top: `${(h / 24) * 100}%` }}>
                {h < 24 ? formatHourLabel(h) : ''}
              </div>
            ))}
          </div>
          <div className="calendar-days-area" ref={calendarDaysAreaRef} onPointerDown={handleCalendarAreaPointerDown}>
            <div className="calendar-gridlines" aria-hidden>
              {hours.map((h) => (
                <div key={`g-${h}`} className="calendar-gridline" style={{ top: `${(h / 24) * 100}%` }} />
              ))}
            </div>
            <div
              className="calendar-days"
              ref={calendarDaysRef}
              style={{ width: `${(dayStarts.length / visibleDayCount) * 100}%` }}
            >
              {dayStarts.map((start, di) => {
                const events = computeDayEvents(start)
                const isTodayColumn = start === todayMidnight
                const initialNowTopPct = (() => {
                  if (!isTodayColumn) return null as number | null
                  const now = Date.now()
                  const raw = ((now - start) / DAY_DURATION_MS) * 100
                  return Math.min(Math.max(raw, 0), 100)
                })()
                const handleCalendarColumnPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
                  if (ev.button !== 0) return
                  const targetEl = ev.currentTarget as HTMLDivElement
                  // Ignore if starting on an existing event
                  const rawTarget = ev.target as HTMLElement | null
                  if (rawTarget && rawTarget.closest('.calendar-event')) return
                  const daysRoot = calendarDaysRef.current
                  const area = calendarDaysAreaRef.current
                  if (!daysRoot || !area) return
                  const columnEls = Array.from(daysRoot.querySelectorAll<HTMLDivElement>('.calendar-day-column'))
                  if (columnEls.length === 0) return
                  const columns = columnEls.map((el, idx) => ({ rect: el.getBoundingClientRect(), dayStart: dayStarts[idx] }))
                  // Identify column where drag begins
                  const startColIdx = columns.findIndex((c) => ev.clientX >= c.rect.left && ev.clientX <= c.rect.right)
                  const col = startColIdx >= 0 ? columns[startColIdx] : columns[0]
                  const colHeight = col.rect.height
                  if (!(Number.isFinite(colHeight) && colHeight > 0)) return
                  const yRatio = Math.min(Math.max((ev.clientY - col.rect.top) / colHeight, 0), 1)
                  const timeOfDayMs0 = Math.round(yRatio * DAY_DURATION_MS)
                  const initialStart = Math.round(col.dayStart + timeOfDayMs0)

                  // Intent detection: wait to decide between horizontal pan vs vertical create
                  const pointerId = ev.pointerId
                  const startX = ev.clientX
                  const startY = ev.clientY
                  let startedCreate = false
                  let startedPan = false
                  const isTouch = (ev as any).pointerType === 'touch'
                  let touchHoldTimer: number | null = null

                  const startCreate = () => {
                    if (startedCreate) return
                    startedCreate = true
                    const state = {
                      pointerId,
                      entryId: 'new-entry',
                      startX,
                      startY,
                      initialStart,
                      initialEnd: initialStart + MIN_SESSION_DURATION_DRAG_MS,
                      initialTimeOfDayMs: timeOfDayMs0,
                      durationMs: MIN_SESSION_DURATION_DRAG_MS,
                      kind: 'resize-end' as DragKind,
                      columns,
                    }
                    calendarEventDragRef.current = state as any
                    dragPreviewRef.current = { entryId: 'new-entry', startedAt: state.initialStart, endedAt: state.initialEnd }
                    setDragPreview(dragPreviewRef.current)
                    // Lock page scroll while dragging to create (touch only)
                    if (isTouch) setPageScrollLock(true)
                    try { targetEl.setPointerCapture?.(pointerId) } catch {}
                  }

                  const startPan = () => {
                    if (startedPan) return
                    startedPan = true
                    const rect = area.getBoundingClientRect()
                    if (rect.width <= 0) return
                    const dayCount = calendarView === '3d'
                      ? Math.max(2, Math.min(multiDayCount, 14))
                      : calendarView === 'week'
                        ? 7
                        : 1
                    stopCalendarPanAnimation()
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
                    const daysEl = calendarDaysRef.current
                    const hdrEl = calendarHeadersRef.current
                    if (daysEl) daysEl.style.transition = ''
                    if (hdrEl) hdrEl.style.transition = ''
                    const baseOffset = calendarPanDesiredOffsetRef.current
                    calendarDragRef.current = {
                      pointerId,
                      startX,
                      startY,
                      startTime: now,
                      areaWidth: rect.width,
                      dayCount,
                      baseOffset,
                      mode: 'hdrag',
                      lastAppliedDx: 0,
                    }
                    try { area.setPointerCapture?.(pointerId) } catch {}
                  }

                  const onMove = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    const dx = e.clientX - startX
                    const dy = e.clientY - startY
                    const absX = Math.abs(dx)
                    const absY = Math.abs(dy)
                    const threshold = 8
                    if (!startedCreate && !startedPan) {
                      if (isTouch) {
                        // On touch, require a hold before creating; allow horizontal pan if user slides before hold
                        if (absX > threshold && absX > absY) {
                          if (touchHoldTimer !== null) { try { window.clearTimeout(touchHoldTimer) } catch {} ; touchHoldTimer = null }
                          startPan()
                          return
                        }
                        // Vertical movement before hold — do nothing (avoid accidental create)
                        return
                      } else {
                        if (absX > threshold && absX > absY) {
                          startPan()
                        } else if (absY > threshold && absY > absX) {
                          startCreate()
                        } else {
                          return
                        }
                      }
                    }
                    if (startedPan) {
                      // Mirror handleCalendarAreaPointerDown's move behavior
                      const state = calendarDragRef.current
                      if (!state || e.pointerId !== state.pointerId) return
                      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                      if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
                      try { e.preventDefault() } catch {}
                      const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                      state.lastAppliedDx = constrainedDx
                      const totalPx = calendarBaseTranslateRef.current + constrainedDx
                      const daysEl = calendarDaysRef.current
                      if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                      const hdrEl = calendarHeadersRef.current
                      if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                      return
                    }
                    if (startedCreate) {
                      // Prevent page/area scrolling while dragging to create
                      try { e.preventDefault() } catch {}
                      const s = calendarEventDragRef.current as any
                      if (!s || e.pointerId !== s.pointerId) return
                      const baseIdx = s.columns.findIndex((c: any) => e.clientX >= c.rect.left && e.clientX <= c.rect.right)
                      const nearestIdx = baseIdx >= 0 ? baseIdx : (e.clientX < s.columns[0].rect.left ? 0 : s.columns.length - 1)
                      const baseCol = s.columns[nearestIdx]
                      const colH = baseCol.rect.height
                      if (!(Number.isFinite(colH) && colH > 0)) return
                      const deltaMsRaw = (dy / colH) * DAY_DURATION_MS
                      const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
                      const deltaMs = deltaMinutes * MINUTE_MS
                      let desiredTimeOfDay = s.initialTimeOfDayMs + deltaMs
                      let dayShift = 0
                      if (desiredTimeOfDay <= -MINUTE_MS || desiredTimeOfDay >= DAY_DURATION_MS + MINUTE_MS) {
                        dayShift = Math.floor(desiredTimeOfDay / DAY_DURATION_MS)
                        desiredTimeOfDay = desiredTimeOfDay - dayShift * DAY_DURATION_MS
                      }
                      const targetIdx = Math.min(Math.max(nearestIdx + dayShift, 0), s.columns.length - 1)
                      const target = s.columns[targetIdx]
                      const timeOfDay = Math.min(Math.max(desiredTimeOfDay, 0), DAY_DURATION_MS)
                      const newStart = s.initialStart
                      let newEnd = s.initialEnd
                      newEnd = Math.round(target.dayStart + timeOfDay)
                      if (newEnd < newStart + MIN_SESSION_DURATION_DRAG_MS) {
                        newEnd = newStart + MIN_SESSION_DURATION_DRAG_MS
                      }
                      const current = dragPreviewRef.current
                      if (current && current.entryId === 'new-entry' && current.startedAt === newStart && current.endedAt === newEnd) return
                      const preview = { entryId: 'new-entry', startedAt: newStart, endedAt: newEnd }
                      dragPreviewRef.current = preview
                      setDragPreview(preview)
                      return
                    }
                  }
                  const onUp = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                    window.removeEventListener('pointercancel', onUp)
                    if (touchHoldTimer !== null) { try { window.clearTimeout(touchHoldTimer) } catch {} ; touchHoldTimer = null }

                    if (startedPan) {
                      const state = calendarDragRef.current
                      if (state && e.pointerId === state.pointerId) {
                        area.releasePointerCapture?.(state.pointerId)
                        const dx = e.clientX - state.startX
                        const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                        if (Number.isFinite(dayWidth) && dayWidth > 0) {
                          const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                          state.lastAppliedDx = appliedDx
                          const totalPx = calendarBaseTranslateRef.current + appliedDx
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                          const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
                          animateCalendarPan(snap, dayWidth, state.baseOffset)
                        } else {
                          const base = calendarBaseTranslateRef.current
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
                        }
                      }
                      calendarDragRef.current = null
                      return
                    }

                    if (startedCreate) {
                      // Release page scroll lock at the end of create drag (noop if not locked)
                      if (isTouch) setPageScrollLock(false)
                      try { targetEl.releasePointerCapture?.(pointerId) } catch {}
                      const preview = dragPreviewRef.current
                      if (preview && preview.entryId === 'new-entry') {
                        const startedAt = Math.min(preview.startedAt, preview.endedAt)
                        const endedAt = Math.max(preview.startedAt, preview.endedAt)
                        const elapsed = Math.max(endedAt - startedAt, MIN_SESSION_DURATION_DRAG_MS)
                        const newId = makeHistoryId()
                        const newEntry: HistoryEntry = {
                          id: newId,
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
                        setPendingNewHistoryId(newId)
                        setTimeout(() => {
                          handleStartEditingHistoryEntry(newEntry)
                          // Open the full editor for new entries immediately
                          setCalendarEditorEntryId(newId)
                        }, 0)
                      }
                      calendarEventDragRef.current = null
                      dragPreviewRef.current = null
                      setDragPreview(null)
                      return
                    }
                    // No intent detected (tap) — do nothing
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                  window.addEventListener('pointercancel', onUp)
                  // For touch, require a brief hold to start creation; allow pan to start immediately
                  if (isTouch) {
                    touchHoldTimer = window.setTimeout(() => {
                      touchHoldTimer = null
                      startCreate()
                    }, 360)
                  }
                }
                return (
                  <div key={`col-${di}`} className="calendar-day-column" onPointerDown={handleCalendarColumnPointerDown}>
                    {isTodayColumn ? (
                      <div
                        className="calendar-now-line"
                        ref={(node) => {
                          calendarNowLineRef.current = node
                          if (node) {
                            ;(node as any).dataset.dayStart = String(start)
                            if (typeof initialNowTopPct === 'number') {
                              node.style.top = `${initialNowTopPct}%`
                              node.style.display = ''
                            } else {
                              node.style.display = 'none'
                            }
                          }
                        }}
                        aria-hidden
                      />
                    ) : null}
                    {events.map((ev, idx) => {
                      const isDragging = dragPreview?.entryId === ev.entry.id
                      const dragTime = isDragging ? ev.rangeLabel : undefined
                      const backgroundStyle: CSSProperties = {
                        background: ev.gradientCss ?? ev.color,
                      }
                      if (ev.clipPath) {
                        backgroundStyle.clipPath = ev.clipPath
                      }
                      return (
                      <div
                        key={`ev-${di}-${idx}-${ev.entry.id}`}
                        className={`calendar-event${isDragging ? ' calendar-event--dragging' : ''}`}
                        style={{
                          top: `${ev.topPct}%`,
                          height: `${ev.heightPct}%`,
                          left: '2px',
                          width: 'calc(100% - 4px)',
                          zIndex: ev.zIndex,
                        }}
                        data-drag-time={dragTime}
                        data-entry-id={ev.entry.id}
                        role="button"
                        aria-label={`${ev.label} ${ev.rangeLabel}`}
                        onClick={(e) => {
                          // Only open the preview on genuine clicks; suppress after any drag intent
                          if (dragPreventClickRef.current) {
                            dragPreventClickRef.current = false
                            return
                          }
                          // Suppress the first click if closing/opening race just occurred
                          if (suppressEventOpenRef.current) {
                            suppressEventOpenRef.current = false
                            return
                          }
                          // If clicking the same entry that's already previewed, toggle it closed
                          if (calendarPreview && calendarPreview.entryId === ev.entry.id) {
                            handleCloseCalendarPreview()
                            return
                          }
                          handleOpenCalendarPreview(ev.entry, e.currentTarget)
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          // Prepare draft + selection state and open the full editor modal
                          setSelectedHistoryId(ev.entry.id)
                          setHoveredHistoryId(ev.entry.id)
                          setEditingHistoryId(ev.entry.id)
                          taskNameAutofilledRef.current = false
                          setHistoryDraft({
                            taskName: ev.entry.taskName,
                            goalName: ev.entry.goalName ?? '',
                            bucketName: ev.entry.bucketName ?? '',
                            startedAt: ev.entry.startedAt,
                            endedAt: ev.entry.endedAt,
                          })
                          setCalendarEditorEntryId(ev.entry.id)
                          // Close any open preview popover to avoid stacking
                          handleCloseCalendarPreview()
                        }}
                        onPointerUp={() => {
                          // No-op: click handler will decide whether to open based on dragPreventClickRef
                        }}
                        onPointerDown={(pev) => {
                          // Clear any hover-set cursor before deciding drag kind
                          delete (pev.currentTarget as HTMLDivElement).dataset.cursor
                          handleCalendarEventPointerDown(ev.entry, start)(pev)
                        }}
                        onPointerMove={(pev) => {
                          // Update cursor affordance based on proximity to top/bottom edge
                          const target = pev.currentTarget as HTMLDivElement
                          const rect = target.getBoundingClientRect()
                          const edgePx = Math.min(12, Math.max(6, rect.height * 0.2))
                          const nearTop = pev.clientY - rect.top <= edgePx
                          const nearBottom = rect.bottom - pev.clientY <= edgePx
                          if (nearTop || nearBottom) {
                            if (target.dataset.cursor !== 'ns-resize') {
                              target.dataset.cursor = 'ns-resize'
                            }
                          } else if (target.dataset.cursor) {
                            // Use default arrow when not near edges
                            delete target.dataset.cursor
                          }
                        }}
                        onPointerLeave={(pev) => {
                          // Restore default cursor when leaving the block
                          const target = pev.currentTarget as HTMLDivElement
                          if (target.dataset.cursor) {
                            delete target.dataset.cursor
                          }
                        }}
                      >
                        <div className="calendar-event__background" style={backgroundStyle} aria-hidden />
                        {ev.showLabel ? (
                          <div className="calendar-event__content" style={{ justifyContent: ev.showTime ? 'flex-start' : 'center' }}>
                            <div className="calendar-event__title">{ev.label}</div>
                            {ev.showTime ? <div className="calendar-event__time">{ev.rangeLabel}</div> : null}
                          </div>
                        ) : null}
                      </div>
                    )})}
                    {(() => {
                      // Render creation preview if present and overlapping this day
                      const preview = dragPreview
                      if (!preview || preview.entryId !== 'new-entry') return null
                      const dayStart = start
                      const dayEnd = start + DAY_DURATION_MS
                      const startClamped = Math.max(Math.min(preview.startedAt, preview.endedAt), dayStart)
                      const endClamped = Math.min(Math.max(preview.startedAt, preview.endedAt), dayEnd)
                      if (endClamped <= startClamped) return null
                      const topPct = ((startClamped - dayStart) / DAY_DURATION_MS) * 100
                      const heightPct = Math.max(((endClamped - startClamped) / DAY_DURATION_MS) * 100, (MINUTE_MS / DAY_DURATION_MS) * 100)
                      const label = `${formatTimeOfDay(startClamped)} — ${formatTimeOfDay(endClamped)}`
                      return (
                        <div
                          className="calendar-event calendar-event--dragging"
                          style={{
                            top: `${topPct}%`,
                            height: `${heightPct}%`,
                            left: `0%`,
                            width: `calc(100% - 4px)`,
                            background: 'rgba(104, 124, 255, 0.6)',
                          }}
                          data-drag-kind="resize"
                          aria-hidden
                        >
                          <div className="calendar-event__title">New session</div>
                          <div className="calendar-event__time">{label}</div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )

      const styleVars = { ['--calendar-day-count' as any]: String(dayStarts.length) } as CSSProperties
      return (
        <div className="calendar-vertical" aria-label="Time grid" style={styleVars}>
          <div className="calendar-vertical__header">
            <div className="calendar-axis-header" />
            <div className="calendar-header-wrapper" onPointerDown={handleCalendarAreaPointerDown}>
              <div
                className="calendar-header-track"
                ref={calendarHeadersRef}
                style={{ width: `${(dayStarts.length / visibleDayCount) * 100}%` }}
              >
                {headers}
              </div>
            </div>
          </div>
          {body}
        </div>
      )
    }

    if (calendarView === 'month') {
      const firstOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1)
      const lastOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0)
      const start = new Date(firstOfMonth)
      const startDow = start.getDay() // 0=Sun
      start.setDate(start.getDate() - startDow)
      const end = new Date(lastOfMonth)
      const endDow = end.getDay()
      end.setDate(end.getDate() + (6 - endDow))
  const cells: any[] = []
      const headers = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const headerRow = (
        <div className="calendar-week-headers" key="hdr">
          {headers.map((h) => (
            <div className="calendar-week-header" key={h} aria-hidden>
              {h}
            </div>
          ))}
        </div>
      )
      cells.push(headerRow)
      const iter = new Date(start)
      while (iter <= end) {
        for (let i = 0; i < 7; i += 1) {
          const current = new Date(iter)
          cells.push(renderCell(current, current.getMonth() === anchorDate.getMonth()))
          iter.setDate(iter.getDate() + 1)
        }
      }
      return <div className="calendar-grid calendar-grid--month">{cells}</div>
    }

    if (calendarView === 'year') {
      const months = Array.from({ length: 12 }).map((_, idx) => {
        const d = new Date(anchorDate.getFullYear(), idx, 1)
        const label = d.toLocaleDateString(undefined, { month: 'short' })
        return (
          <div key={`m-${idx}`} className="calendar-year-cell">
            <div className="calendar-year-label">{label}</div>
          </div>
        )
      })
      return <div className="calendar-grid calendar-grid--year">{months}</div>
    }

    return null
  }, [calendarView, anchorDate, effectiveHistory, dragPreview, multiDayCount, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup, calendarPreview, handleOpenCalendarPreview, handleCloseCalendarPreview, animateCalendarPan, resolvePanSnap, stopCalendarPanAnimation])

  // Simple inline icons for popover actions
  const IconEdit = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  )
  const IconTrash = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"/>
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
    </svg>
  )
  const IconClose = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>
  )

  // Render the popover outside the heavy calendar grid to avoid re-running grid computations on open/close
  const renderCalendarPopover = useCallback(() => {
    if (!calendarPreview || typeof document === 'undefined') return null
    const entry = effectiveHistory.find((h) => h.id === calendarPreview.entryId) || null
    if (!entry) return null
    const dateLabel = (() => {
      const startD = new Date(entry.startedAt)
      const endD = new Date(entry.endedAt)
      const sameDay =
        startD.getFullYear() === endD.getFullYear() &&
        startD.getMonth() === endD.getMonth() &&
        startD.getDate() === endD.getDate()
      if (sameDay) {
        const dateFmt = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        return `${dateFmt} · ${formatTimeOfDay(entry.startedAt)} — ${formatTimeOfDay(entry.endedAt)}`
      }
      return formatDateRange(entry.startedAt, entry.endedAt)
    })()
    const title = deriveEntryTaskName(entry)
    const editingState = calendarPopoverEditing && calendarPopoverEditing.entryId === entry.id ? calendarPopoverEditing : null
    const startValue = entry.taskName ?? ''
    const initialDisplayValue = title || ''
    const duplicateHistoryEntry = (source: HistoryEntry): HistoryEntry => {
      const newEntry: HistoryEntry = { ...source, id: makeHistoryId() }
      updateHistory((current) => {
        const next = [...current, newEntry]
        next.sort((a, b) => a.startedAt - b.startedAt)
        return next
      })
      return newEntry
    }
    const startEditingTitle = (options?: { selectionSnapshot?: EditableSelectionSnapshot | null }) => {
      setCalendarPopoverEditing({
        entryId: entry.id,
        value: initialDisplayValue,
        initialTaskName: startValue,
        initialDisplayValue,
        dirty: false,
        selectionSnapshot: options?.selectionSnapshot ?? null,
      })
    }
    const getCaretSnapshotFromPoint = (clientX: number, clientY: number): EditableSelectionSnapshot | null => {
      const editableEl = calendarPopoverTitleRef.current
      if (!editableEl || typeof document === 'undefined') {
        return null
      }
      const doc = editableEl.ownerDocument || document
      let range: Range | null = null
      const anyDoc = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      if (typeof anyDoc.caretRangeFromPoint === 'function') {
        range = anyDoc.caretRangeFromPoint(clientX, clientY)
      } else if (typeof anyDoc.caretPositionFromPoint === 'function') {
        const pos = anyDoc.caretPositionFromPoint(clientX, clientY)
        if (pos) {
          range = doc.createRange()
          range.setStart(pos.offsetNode, pos.offset)
          range.collapse(true)
        }
      }
      return buildSelectionSnapshotFromRange(editableEl, range)
    }
    const handleTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editingState) {
        return
      }
      if (event.pointerType === 'mouse') {
        event.preventDefault()
        event.stopPropagation()
      }
      const snapshot =
        event.pointerType === 'mouse'
          ? getCaretSnapshotFromPoint(event.clientX, event.clientY)
          : null
      startEditingTitle({ selectionSnapshot: snapshot })
    }
    const handleTitleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (editingState) {
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        startEditingTitle()
      }
    }
    const handleTitleEditableInput = (event: FormEvent<HTMLDivElement>) => {
      if (!editingState) {
        return
      }
      const value = event.currentTarget.textContent ?? ''
      const nextDirty = value !== editingState.initialDisplayValue
      if (value === editingState.value && nextDirty === editingState.dirty) {
        return
      }
      setCalendarPopoverEditing({
        ...editingState,
        value,
        dirty: nextDirty,
        selectionSnapshot: null,
      })
      const desiredValue = nextDirty ? value : editingState.initialTaskName
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        if (target.taskName === desiredValue) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: desiredValue }
        return next
      })
    }
    const commitTitleChange = () => {
      if (!editingState) {
        return
      }
      const nextTrimmed = editingState.value.trim()
      const previousRaw = editingState.initialTaskName
      const previousTrimmed = previousRaw.trim()
      setCalendarPopoverEditing(null)
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        const desiredValue = editingState.dirty ? nextTrimmed : previousRaw
        if (editingState.dirty && nextTrimmed === previousTrimmed) {
          if (target.taskName === previousRaw) {
            return current
          }
          const next = [...current]
          next[index] = { ...target, taskName: previousRaw }
          return next
        }
        if (target.taskName === desiredValue) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: desiredValue }
        return next
      })
    }
    const cancelTitleChange = () => {
      setCalendarPopoverEditing(null)
      if (!editingState) {
        return
      }
      const original = editingState.initialTaskName
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        if (target.taskName === original) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: original }
        return next
      })
    }
    const handleTitleEditableBlur = () => {
      commitTitleChange()
    }
    const handleTitleEditableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitTitleChange()
        handleCloseCalendarPreview()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelTitleChange()
        handleCloseCalendarPreview()
      }
    }
    const goal = entry.goalName || 'No goal'
    const bucket = entry.bucketName || 'No bucket'
    return createPortal(
      <div
        className="calendar-popover"
        ref={calendarPreviewRef}
        style={{ top: `${calendarPreview.top}px`, left: `${calendarPreview.left}px` }}
        role="dialog"
        aria-label="Session details"
      >
        <div className="calendar-popover__header">
          <div
            ref={calendarPopoverTitleRef}
            className={`calendar-popover__title${editingState ? ' calendar-popover__title--editing' : ' calendar-popover__title--interactive'}`}
            role={editingState ? 'textbox' : 'button'}
            tabIndex={0}
            contentEditable={editingState ? 'true' : undefined}
            suppressContentEditableWarning
            aria-label="Session title"
            aria-multiline={editingState ? 'true' : undefined}
            onPointerDown={editingState ? undefined : handleTitlePointerDown}
            onKeyDown={(event) => {
              if (editingState) {
                handleTitleEditableKeyDown(event)
              } else {
                handleTitleKeyDown(event)
              }
            }}
            onInput={editingState ? handleTitleEditableInput : undefined}
            onBlur={editingState ? handleTitleEditableBlur : undefined}
          >
            {editingState ? undefined : title || 'Untitled session'}
          </div>
          <div className="calendar-popover__actions">
            <button
              type="button"
              className="calendar-popover__action"
              aria-label="Edit session"
              onPointerDown={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                setSelectedHistoryId(entry.id)
                setHoveredHistoryId(entry.id)
                setEditingHistoryId(entry.id)
                taskNameAutofilledRef.current = false
                setHistoryDraft({
                  taskName: entry.taskName,
                  goalName: entry.goalName ?? '',
                  bucketName: entry.bucketName ?? '',
                  startedAt: entry.startedAt,
                  endedAt: entry.endedAt,
                })
                setCalendarEditorEntryId(entry.id)
                handleCloseCalendarPreview()
              }}
            >
              <IconEdit />
            </button>
            <CalendarActionsKebab
              previewRef={calendarPreviewRef}
              onDuplicate={() => {
                const dup = duplicateHistoryEntry(entry)
                if (!dup) return
                setHoveredHistoryId(dup.id)
                setSelectedHistoryId(dup.id)
                setEditingHistoryId(dup.id)
                taskNameAutofilledRef.current = false
                setHistoryDraft({
                  taskName: dup.taskName,
                  goalName: dup.goalName ?? '',
                  bucketName: dup.bucketName ?? '',
                  startedAt: dup.startedAt,
                  endedAt: dup.endedAt,
                })
              }}
            />
            <button
              type="button"
              className="calendar-popover__action calendar-popover__action--danger"
              aria-label="Delete session"
              onPointerDown={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                suppressNextEventOpen()
                handleDeleteHistoryEntry(entry.id)(ev as any)
                handleCloseCalendarPreview()
              }}
            >
              <IconTrash />
            </button>
            <button
              type="button"
              className="calendar-popover__action calendar-popover__action--close"
              aria-label="Close"
              onPointerDown={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                suppressNextEventOpen()
                handleCloseCalendarPreview()
              }}
            >
              <IconClose />
            </button>
          </div>
        </div>
        <div className="calendar-popover__meta">
          <div className="calendar-popover__time">{dateLabel}</div>
          <div className="calendar-popover__goal">{goal}{bucket ? ` → ${bucket}` : ''}</div>
        </div>
      </div>,
      document.body,
    )
  }, [calendarPreview, calendarPopoverEditing, effectiveHistory, handleCloseCalendarPreview, handleDeleteHistoryEntry, handleStartEditingHistoryEntry, updateHistory])

  // Calendar editor modal
  useEffect(() => {
    if (!calendarEditorEntryId) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Cancel editing, reset draft
        handleCancelHistoryEdit()
        setCalendarEditorEntryId(null)
      }
    }
    document.addEventListener('keydown', onKeyDown as EventListener)
    return () => document.removeEventListener('keydown', onKeyDown as EventListener)
  }, [calendarEditorEntryId, handleCancelHistoryEdit])

  // When opening the calendar editor, if this is a freshly created (pending) entry,
  // focus the session name input and place the caret at the end.
  useEffect(() => {
    if (!calendarEditorEntryId) return
    if (!pendingNewHistoryId || pendingNewHistoryId !== calendarEditorEntryId) return
    const focusLater = () => {
      const input = calendarEditorNameInputRef.current
      if (input) {
        try {
          input.focus()
          const len = input.value?.length ?? 0
          input.setSelectionRange(len, len)
        } catch {}
      }
    }
    const raf = window.requestAnimationFrame(focusLater)
    return () => window.cancelAnimationFrame(raf)
  }, [calendarEditorEntryId, pendingNewHistoryId])

  const renderCalendarEditor = useCallback(() => {
    if (!calendarEditorEntryId || typeof document === 'undefined') return null
    const entry = history.find((h) => h.id === calendarEditorEntryId) || null
    if (!entry) return null
    // Resolve current values
    const startBase = entry.startedAt
    const endBase = entry.endedAt
    const resolvedStart = resolveTimestamp(historyDraft.startedAt, startBase)
    const resolvedEnd = resolveTimestamp(historyDraft.endedAt, endBase)
    const startDateInputValue = formatDateInputValue(resolvedStart)
    const endDateInputValue = formatDateInputValue(resolvedEnd)
    const startTimeInputValue = formatTimeInputValue(resolvedStart)
    const endTimeInputValue = formatTimeInputValue(resolvedEnd)

    return createPortal(
      <div
        className="calendar-editor-backdrop"
        role="dialog"
        aria-label="Edit session"
        onClick={() => {
          handleCancelHistoryEdit()
          setCalendarEditorEntryId(null)
        }}
      >
        <div
          className="calendar-editor"
          ref={calendarEditorRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="calendar-editor__header">
            <h4 className="calendar-editor__title">Edit session</h4>
            <button
              type="button"
              className="calendar-popover__action"
              title="Close"
              onClick={() => {
                handleCancelHistoryEdit()
                setCalendarEditorEntryId(null)
              }}
            >
              ×
            </button>
          </div>
          <div className="calendar-editor__body">
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">Session name</span>
              <input
                className="history-timeline__field-input"
                type="text"
                ref={calendarEditorNameInputRef}
                value={historyDraft.taskName}
                placeholder="Describe the focus block"
                onChange={handleHistoryFieldChange('taskName')}
                onKeyDown={handleHistoryFieldKeyDown}
              />
            </label>
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">Start</span>
              <div className="history-timeline__field-row">
                <input
                  className="history-timeline__field-input"
                  type="date"
                  value={startDateInputValue}
                  onChange={(event) => {
                    const value = event.target.value
                    setHistoryDraft((draft) => {
                      if (value.trim().length === 0) return draft
                      const parsed = parseLocalDateTime(value, startTimeInputValue)
                      return parsed === null ? draft : { ...draft, startedAt: parsed }
                    })
                  }}
                  onKeyDown={handleHistoryFieldKeyDown}
                />
                <input
                  className="history-timeline__field-input"
                  type="time"
                  step={60}
                  value={startTimeInputValue}
                  onChange={(event) => {
                    const { value } = event.target
                    setHistoryDraft((draft) => {
                      if (value.trim().length === 0) return { ...draft, startedAt: null }
                      const parsed = parseLocalDateTime(startDateInputValue, value)
                      return parsed === null ? draft : { ...draft, startedAt: parsed }
                    })
                  }}
                  onKeyDown={handleHistoryFieldKeyDown}
                />
              </div>
            </label>
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">End</span>
              <div className="history-timeline__field-row">
                <input
                  className="history-timeline__field-input"
                  type="date"
                  value={endDateInputValue}
                  onChange={(event) => {
                    const value = event.target.value
                    setHistoryDraft((draft) => {
                      if (value.trim().length === 0) return draft
                      const parsed = parseLocalDateTime(value, endTimeInputValue)
                      return parsed === null ? draft : { ...draft, endedAt: parsed }
                    })
                  }}
                  onKeyDown={handleHistoryFieldKeyDown}
                />
                <input
                  className="history-timeline__field-input"
                  type="time"
                  step={60}
                  value={endTimeInputValue}
                  onChange={(event) => {
                    const { value } = event.target
                    setHistoryDraft((draft) => {
                      if (value.trim().length === 0) return { ...draft, endedAt: null }
                      const parsed = parseLocalDateTime(endDateInputValue, value)
                      return parsed === null ? draft : { ...draft, endedAt: parsed }
                    })
                  }}
                  onKeyDown={handleHistoryFieldKeyDown}
                />
              </div>
            </label>
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
                placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                options={bucketDropdownOptions}
                onChange={(nextValue) => updateHistoryDraftField('bucketName', nextValue)}
                disabled={availableBucketOptions.length === 0}
              />
            </label>
          </div>
          <div className="calendar-editor__footer">
            <button
              type="button"
              className="history-timeline__action-button history-timeline__action-button--primary"
              onClick={() => {
                handleSaveHistoryDraft()
                setCalendarEditorEntryId(null)
              }}
            >
              Save changes
            </button>
            <button
              type="button"
              className="history-timeline__action-button"
              onClick={() => {
                handleCancelHistoryEdit()
                setCalendarEditorEntryId(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }, [calendarEditorEntryId, history, historyDraft.bucketName, historyDraft.goalName, historyDraft.taskName, availableBucketOptions.length, bucketDropdownId, bucketDropdownOptions, goalDropdownId, goalDropdownOptions, handleCancelHistoryEdit, handleHistoryFieldChange, handleHistoryFieldKeyDown, handleSaveHistoryDraft, updateHistoryDraftField])

  // Keep the buffered track centered on the visible window (apply base translate)
  useLayoutEffect(() => {
    if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) return
    const area = calendarDaysAreaRef.current
    const daysEl = calendarDaysRef.current
    const hdrEl = calendarHeadersRef.current
    if (!area || !daysEl || !hdrEl) return
    const visibleDayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
    const bufferDays = getCalendarBufferDays(visibleDayCount)
    const dayWidth = area.clientWidth / Math.max(1, visibleDayCount)
    const base = -bufferDays * dayWidth
    calendarBaseTranslateRef.current = base
    daysEl.style.transform = `translateX(${base}px)`
    hdrEl.style.transform = `translateX(${base}px)`
  }, [calendarView, multiDayCount, anchorDate])

  useEffect(() => {
    return () => {
      stopCalendarPanAnimation({ commit: false })
    }
  }, [stopCalendarPanAnimation])

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
      } else if (state.type === 'resize-start') {
        nextStart = Math.min(state.initialEnd - state.minDurationMs, state.initialStart + deltaMs)
        nextEnd = state.initialEnd
      } else {
        nextStart = state.initialStart
        nextEnd = Math.max(state.initialStart + state.minDurationMs, state.initialEnd + deltaMs)
      }

      if (nextEnd - nextStart < state.minDurationMs) {
        if (state.type === 'resize-start') {
          nextStart = nextEnd - state.minDurationMs
        } else {
          nextEnd = nextStart + state.minDurationMs
        }
      }

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
          setPendingNewHistoryId(newEntry.id)
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
      try {
        event.preventDefault()
        bar.setPointerCapture?.(event.pointerId)
      } catch {}
      // Close any open calendar popover when starting a drag from timeline blocks
      handleCloseCalendarPreview()
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

  // Start drag from native pointer event (used after mouse moves beyond threshold)
  const startDragFromPointer = useCallback(
    (nativeEvent: PointerEvent, segment: TimelineSegment, type: DragKind) => {
      if (segment.entry.id === 'active-session') {
        return
      }
      // Ensure primary button is pressed for mouse
      if (nativeEvent.pointerType === 'mouse' && (nativeEvent.buttons & 1) !== 1) {
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
      try {
        nativeEvent.preventDefault()
        bar.setPointerCapture?.(nativeEvent.pointerId)
      } catch {}
      // Close any open calendar popover when starting a drag via native pointer (timeline)
      handleCloseCalendarPreview()
      dragStateRef.current = {
        entryId: segment.entry.id,
        type,
        pointerId: nativeEvent.pointerId,
        rectWidth: rect.width,
        startX: nativeEvent.clientX,
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
        <div className="calendar-toolbar">
          <div className="calendar-toolbar__left">
            <button
              type="button"
              className="calendar-nav-button"
              onClick={handlePrevWindow}
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              type="button"
              className="calendar-nav-button"
              onClick={handleNextWindow}
              aria-label="Next"
            >
              ›
            </button>
            <h2 className="calendar-title" aria-live="polite">{monthAndYearLabel}</h2>
          </div>
          <div className="calendar-toolbar__right">
            <button
              type="button"
              className="calendar-today-button"
              onClick={handleJumpToToday}
              aria-label="Jump to today"
            >
              Today
            </button>
            <div className="calendar-toggle-group" role="tablist" aria-label="Calendar views">
              {(() => {
                const nDays = Math.max(2, Math.min(multiDayCount, 14))
                const options: Array<{
                  key: CalendarViewMode
                  full: string
                  short: string
                }> = [
                  { key: 'day', full: 'Day', short: 'D' },
                  { key: '3d', full: `${nDays} days`, short: `${nDays}D` },
                  { key: 'week', full: 'Week', short: 'W' },
                  { key: 'month', full: 'Month', short: 'M' },
                  { key: 'year', full: 'Year', short: 'Y' },
                ]
                return options.map((opt) => {
                  const button = (
                    <button
                      key={opt.key}
                      type="button"
                      role="tab"
                      aria-selected={calendarView === opt.key}
                      aria-label={opt.full}
                      className={`calendar-toggle${calendarView === opt.key ? ' calendar-toggle--active' : ''}`}
                      onClick={() => setView(opt.key)}
                      onDoubleClick={opt.key === '3d' ? handleMultiDayDoubleClick : undefined}
                    >
                      <span className="calendar-toggle__label calendar-toggle__label--full">{opt.full}</span>
                      <span className="calendar-toggle__label calendar-toggle__label--short" aria-hidden>
                        {opt.short}
                      </span>
                    </button>
                  )
                  if (opt.key !== '3d') {
                    return button
                  }
                  // Wrap the 3-day toggle so the chooser anchors under this button
                  return (
                    <div key={opt.key} className="calendar-toggle-wrap">
                      {button}
                      {calendarView === '3d' && showMultiDayChooser ? (
                        <div
                          className="calendar-multi-day-chooser"
                          ref={multiChooserRef}
                          role="dialog"
                          aria-label="Choose day count"
                        >
                          {Array.from(MULTI_DAY_OPTIONS).map((n) => (
                            <button
                              key={`chooser-${n}`}
                              type="button"
                              className={`calendar-multi-day-chooser__option${multiDayCount === n ? ' is-active' : ''}`}
                              data-day-count={n}
                              onClick={() => {
                                setMultiDayCount(n)
                                setShowMultiDayChooser(false)
                              }}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              })()}
            </div>
          </div>
        </div>

        <div className="history-calendar" aria-label="Calendar display">
          {renderCalendarContent()}
        </div>
        {renderCalendarPopover()}
        {renderCalendarEditor()}

  {false ? (
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
            <h3 className="history-section__date">{dayLabel}</h3>
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
            {daySegments.map((segment) => {
              const isSelected = segment.entry.id === selectedHistoryId
              const isActiveSegment = segment.entry.id === 'active-session'
              const isEditing = editingHistoryId === segment.entry.id
              const isActiveSessionSegment = segment.entry.id === 'active-session'
              const isDragging = dragPreview?.entryId === segment.entry.id
              const isNewEntryEditing = isEditing && selectedHistoryId === pendingNewHistoryId
              const trimmedTaskDraft = historyDraft.taskName.trim()
              const displayTask = isSelected
                ? trimmedTaskDraft.length > 0
                  ? trimmedTaskDraft
                  : segment.tooltipTask
                : segment.tooltipTask
              const baseStartedAt = segment.entry.startedAt
              const baseEndedAt = segment.entry.endedAt
              const draggedStartedAt = isDragging && dragPreview ? dragPreview.startedAt : baseStartedAt
              const draggedEndedAt = isDragging && dragPreview ? dragPreview.endedAt : baseEndedAt
              const shouldUseLiveStart = isActiveSessionSegment && activeSession?.isRunning && historyDraft.startedAt === null && !isDragging
              const resolvedStartedAt = isSelected
                ? isDragging
                  ? draggedStartedAt
                  : shouldUseLiveStart
                    ? baseStartedAt
                    : resolveTimestamp(historyDraft.startedAt, baseStartedAt)
                : draggedStartedAt
              const shouldUseLiveEnd = isActiveSessionSegment && activeSession?.isRunning && historyDraft.endedAt === null && !isDragging
              const resolvedEndedAt = isSelected
                ? isDragging
                  ? draggedEndedAt
                  : shouldUseLiveEnd
                    ? baseEndedAt
                    : resolveTimestamp(historyDraft.endedAt, baseEndedAt)
                : draggedEndedAt
              const trimmedGoalDraft = historyDraft.goalName.trim()
              const trimmedBucketDraft = historyDraft.bucketName.trim()
              const resolvedDurationMs = Math.max(resolvedEndedAt - resolvedStartedAt, 0)
              const displayGoal = trimmedGoalDraft.length > 0 ? trimmedGoalDraft : segment.goalLabel
              const displayBucket = trimmedBucketDraft.length > 0 ? trimmedBucketDraft : segment.bucketLabel
              const timeRangeLabel = (() => {
                const startDate = new Date(resolvedStartedAt)
                const endDate = new Date(resolvedEndedAt)
                const sameDay =
                  startDate.getFullYear() === endDate.getFullYear() &&
                  startDate.getMonth() === endDate.getMonth() &&
                  startDate.getDate() === endDate.getDate()
                if (sameDay) {
                  return `${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`
                }
                return formatDateRange(resolvedStartedAt, resolvedEndedAt)
              })()
              const durationLabel = formatDuration(resolvedDurationMs)
              const overlayTitleId = !isEditing ? `history-tooltip-title-${segment.id}` : undefined
              const startDateInputValue = formatDateInputValue(resolveTimestamp(historyDraft.startedAt, resolvedStartedAt))
              const endDateInputValue = formatDateInputValue(resolveTimestamp(historyDraft.endedAt, resolvedEndedAt))
              const startTimeInputValue = formatTimeInputValue(resolvedStartedAt)
              const endTimeInputValue = formatTimeInputValue(resolvedEndedAt)
              const durationMinutesValue = Math.max(1, Math.round(resolvedDurationMs / MINUTE_MS)).toString()
              const handleStartTimeInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const { value } = event.target
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                  if (value.trim().length === 0) return { ...draft, startedAt: null }
                  const parsed = parseLocalDateTime(startDateInputValue, value)
                  return parsed === null ? draft : { ...draft, startedAt: parsed }
                })
              }
              const handleEndTimeInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const { value } = event.target
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                  if (value.trim().length === 0) return { ...draft, endedAt: null }
                  const parsed = parseLocalDateTime(endDateInputValue, value)
                  return parsed === null ? draft : { ...draft, endedAt: parsed }
                })
              }
              const handleDurationInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const minutes = Number(event.target.value)
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                  if (!Number.isFinite(minutes) || minutes <= 0) return draft
                  const normalizedMinutes = Math.max(1, Math.round(minutes))
                  const baseStart = resolveTimestamp(draft.startedAt, baseStartedAt)
                  return { ...draft, endedAt: baseStart + normalizedMinutes * MINUTE_MS }
                })
              }
              const handleBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                const isTouch = (event as any).pointerType === 'touch'
                if (isTouch) {
                  // Enable long-press to move on touch; short tap will select (handled by onClick)
                  event.persist?.()
                  clearLongPressWatch()
                  longPressPointerIdRef.current = event.pointerId
                  longPressStartRef.current = { x: event.clientX, y: event.clientY }

                  const threshold = 8
                  const handleMove = (e: PointerEvent) => {
                    if (e.pointerId !== longPressPointerIdRef.current || !longPressStartRef.current) return
                    const dx = e.clientX - longPressStartRef.current.x
                    const dy = e.clientY - longPressStartRef.current.y
                    if (Math.hypot(dx, dy) > threshold) {
                      clearLongPressWatch()
                    }
                  }
                  const handleUpOrCancel = (e: PointerEvent) => {
                    if (e.pointerId !== longPressPointerIdRef.current) return
                    clearLongPressWatch()
                  }

                  window.addEventListener('pointermove', handleMove, { passive: true })
                  window.addEventListener('pointerup', handleUpOrCancel, { passive: true })
                  window.addEventListener('pointercancel', handleUpOrCancel, { passive: true })
                  longPressCancelHandlersRef.current = { move: handleMove, up: handleUpOrCancel, cancel: handleUpOrCancel }

                  longPressTimerRef.current = window.setTimeout(() => {
                    // Start move-drag after long press
                    try {
                      if (typeof (event as any).preventDefault === 'function') {
                        (event as any).preventDefault()
                      }
                      ;(event.currentTarget as any)?.setPointerCapture?.(event.pointerId)
                    } catch {}
                    clearLongPressWatch()
                    startDrag(event, segment, 'move')
                  }, 360)
                  return
                }
                // For mouse/pen: defer starting drag until movement exceeds threshold to preserve click/dblclick
                if ((event as any).pointerType === 'mouse' || (event as any).pointerType === 'pen') {
                  mousePreDragRef.current = { pointerId: event.pointerId, startX: event.clientX, segment }
                  const handleMove = (e: PointerEvent) => {
                    const pending = mousePreDragRef.current
                    if (!pending || e.pointerId !== pending.pointerId) return
                    const dx = e.clientX - pending.startX
                    if (Math.abs(dx) >= DRAG_DETECTION_THRESHOLD_PX) {
                      // Begin drag and stop pre-drag listeners
                      mousePreDragRef.current = null
                      if (mousePreDragHandlersRef.current) {
                        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
                        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
                        mousePreDragHandlersRef.current = null
                      }
                      startDragFromPointer(e, segment, 'move')
                    }
                  }
                  const handleUp = (e: PointerEvent) => {
                    const pending = mousePreDragRef.current
                    if (pending && e.pointerId === pending.pointerId) {
                      mousePreDragRef.current = null
                      if (mousePreDragHandlersRef.current) {
                        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
                        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
                        mousePreDragHandlersRef.current = null
                      }
                    }
                  }
                  mousePreDragHandlersRef.current = { move: handleMove, up: handleUp }
                  window.addEventListener('pointermove', handleMove, { passive: true })
                  window.addEventListener('pointerup', handleUp, { passive: true })
                  return
                }
                // Fallback: start drag immediately
                startDrag(event, segment, 'move')
              }
              const handleResizeStartPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-start')
              }
              const handleResizeEndPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-end')
              }
              const handleBlockPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
                const isTouch = (event as any).pointerType === 'touch'
                if (!isTouch) {
                  return
                }
                // If a drag is active, ignore
                if (dragStateRef.current && dragStateRef.current.entryId === segment.entry.id) {
                  return
                }
                const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
                const prev = lastTapRef.current
                const x = event.clientX
                const y = event.clientY
                const id = segment.entry.id
                if (
                  prev &&
                  prev.id === id &&
                  now - prev.time <= DOUBLE_TAP_DELAY_MS &&
                  Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_DISTANCE_PX
                ) {
                  // Double-tap detected: open edit panel (if not active session)
                  lastTapRef.current = null
                  if (!isActiveSessionSegment) {
                    // Prevent following click from toggling selection
                    dragPreventClickRef.current = true
                    event.preventDefault()
                    event.stopPropagation()
                    clearLongPressWatch()
                    handleStartEditingHistoryEntry(segment.entry)
                    setCalendarEditorEntryId(segment.entry.id)
                  }
                  return
                }
                lastTapRef.current = { time: now, id, x, y }
                if (lastTapTimeoutRef.current !== null) {
                  try { window.clearTimeout(lastTapTimeoutRef.current) } catch {}
                }
                lastTapTimeoutRef.current = window.setTimeout(() => {
                  lastTapRef.current = null
                  lastTapTimeoutRef.current = null
                }, DOUBLE_TAP_DELAY_MS + 40)
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
              }${isAnchoredTooltip && !isEditing && activeTooltipPlacement === 'below' ? ' history-timeline__tooltip--below' : ''}`
              const tooltipContent = (
                <div className="history-timeline__tooltip-content">
                  {!isEditing ? (
                    <>
                      <p className="history-timeline__tooltip-task" id={overlayTitleId}>
                        {displayTask}
                      </p>
                      <p className="history-timeline__tooltip-time">{timeRangeLabel}</p>
                      <p className="history-timeline__tooltip-meta">
                        {displayGoal}
                        {displayBucket && displayBucket !== displayGoal ? ` → ${displayBucket}` : ''}
                      </p>
                      <p className="history-timeline__tooltip-duration">{durationLabel}</p>
                    </>
                  ) : null}
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
                                placeholder="Describe the focus block"
                                onChange={handleHistoryFieldChange('taskName')}
                                onKeyDown={handleHistoryFieldKeyDown}
                              />
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Start</span>
                              <div className="history-timeline__field-row">
                                <input
                                  className="history-timeline__field-input"
                                  type="date"
                                  value={startDateInputValue}
                                  onChange={(event) => {
                                    const value = event.target.value
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      if (value.trim().length === 0) return draft
                                      const parsed = parseLocalDateTime(value, startTimeInputValue)
                                      return parsed === null ? draft : { ...draft, startedAt: parsed }
                                    })
                                  }}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                                <input
                                  className="history-timeline__field-input"
                                  type="time"
                                  step={60}
                                  value={startTimeInputValue}
                                  onChange={handleStartTimeInputChange}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                              </div>
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">End</span>
                              <div className="history-timeline__field-row">
                                <input
                                  className="history-timeline__field-input"
                                  type="date"
                                  value={endDateInputValue}
                                  onChange={(event) => {
                                    const value = event.target.value
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      if (value.trim().length === 0) return draft
                                      const parsed = parseLocalDateTime(value, endTimeInputValue)
                                      return parsed === null ? draft : { ...draft, endedAt: parsed }
                                    })
                                  }}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                                <input
                                  className="history-timeline__field-input"
                                  type="time"
                                  step={60}
                                  value={endTimeInputValue}
                                  onChange={handleEndTimeInputChange}
                                  onKeyDown={handleHistoryFieldKeyDown}
                                />
                              </div>
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Duration (minutes)</span>
                              <input
                                className="history-timeline__field-input history-timeline__field-input--compact"
                                type="number"
                                min={1}
                                inputMode="numeric"
                                value={durationMinutesValue}
                                onChange={handleDurationInputChange}
                                onKeyDown={handleHistoryFieldKeyDown}
                              />
                            </label>
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
                                placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                                options={bucketDropdownOptions}
                                onChange={(nextValue) => updateHistoryDraftField('bucketName', nextValue)}
                                disabled={availableBucketOptions.length === 0}
                              />
                            </label>
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
                            {!isNewEntryEditing && segment.deletable ? (
                              <button
                                type="button"
                                className="history-timeline__action-button"
                                onClick={handleDeleteHistoryEntry(segment.entry.id)}
                              >
                                Delete session
                              </button>
                            ) : null}
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
                          {!isNewEntryEditing ? (
                            <button
                              type="button"
                              className="history-timeline__action-button"
                              onClick={handleDeleteHistoryEntry(segment.entry.id)}
                            >
                              Delete session
                            </button>
                          ) : null}
                        </div>
                      )}
                      {isActiveSessionSegment ? (
                        <p className="history-timeline__tooltip-note">Active session updates live; finish to edit details.</p>
                      ) : null}
                    </>
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
                      <div ref={setEditingTooltipNode} {...tooltipCommonProps} className={`${tooltipClassName} history-timeline__tooltip--portal`}>
                        {tooltipContent}
                      </div>,
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
                  onPointerUp={handleBlockPointerUp}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (dragPreventClickRef.current) {
                      dragPreventClickRef.current = false
                      return
                    }
                    // If this is the second click in a double-click sequence, open edit immediately (desktop reliability)
                    if (event.detail === 2) {
                      if (!isActiveSessionSegment) {
                        handleStartEditingHistoryEntry(segment.entry)
                        // Open full-screen editor modal on double-click
                        setCalendarEditorEntryId(segment.entry.id)
                      }
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
                      setCalendarEditorEntryId(segment.entry.id)
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
                    className="history-timeline__block-label"
                    title={`${displayTask} · ${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`}
                    aria-hidden
                  >
                    <div className="history-timeline__block-title">{displayTask}</div>
                    <div className="history-timeline__block-time">
                      {formatTimeOfDay(resolvedStartedAt)} — {formatTimeOfDay(resolvedEndedAt)}
                    </div>
                  </div>
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
        ) : null}
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
