import {
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'

declare global {
  interface Window {
    __ncSetElapsed?: (ms: number) => void
  }
}

type Theme = 'light' | 'dark'

type HistoryEntry = {
  id: string
  taskName: string
  elapsed: number
  startedAt: number
  endedAt: number
}

const THEME_STORAGE_KEY = 'nc-stopwatch-theme'
const HISTORY_STORAGE_KEY = 'nc-stopwatch-history'
const CURRENT_TASK_STORAGE_KEY = 'nc-stopwatch-current-task'
const TASK_DISPLAY_LIMIT = 32
const MAX_TASK_STORAGE_LENGTH = 256
const SINGLE_CLICK_DELAY_MS = 250

const makeHistoryId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    console.warn('Failed to generate UUID, falling back to timestamp-based id', error)
  }

  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
      const taskName = typeof candidate.taskName === 'string' ? candidate.taskName : null
      const elapsed = typeof candidate.elapsed === 'number' ? candidate.elapsed : null
      const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
      const endedAt = typeof candidate.endedAt === 'number' ? candidate.endedAt : null

      if (!id || taskName === null || elapsed === null || startedAt === null || endedAt === null) {
        return null
      }

      return { id, taskName, elapsed, startedAt, endedAt }
    })
    .filter((entry): entry is HistoryEntry => Boolean(entry))
}

const getStoredHistory = (): HistoryEntry[] => {
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
  } catch (error) {
    console.warn('Failed to read stopwatch history from storage', error)
    return []
  }
}

const getStoredTaskName = (): string => {
  if (typeof window === 'undefined') {
    return 'New Task'
  }

  const stored = window.localStorage.getItem(CURRENT_TASK_STORAGE_KEY)
  if (!stored) {
    return 'New Task'
  }

  const trimmed = stored.trim()
  if (trimmed.length === 0) {
    return ''
  }
  return trimmed.slice(0, MAX_TASK_STORAGE_LENGTH)
}

const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'dark'
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') {
    return stored
  }

  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
  return prefersLight ? 'light' : 'dark'
}

const formatTime = (milliseconds: number) => {
  const totalMs = Math.max(0, Math.floor(milliseconds))
  const days = Math.floor(totalMs / 86_400_000)
  const hours = Math.floor((totalMs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1_000)
  const centiseconds = Math.floor((totalMs % 1_000) / 10)

  const segments: string[] = []

  if (days > 0) {
    segments.push(`${days}D`)
    segments.push(hours.toString().padStart(2, '0'))
  } else if (hours > 0) {
    segments.push(hours.toString().padStart(2, '0'))
  }

  segments.push(minutes.toString().padStart(2, '0'))
  segments.push(seconds.toString().padStart(2, '0'))

  const timeCore = segments.join(':')
  const fraction = centiseconds.toString().padStart(2, '0')

  return `${timeCore}.${fraction}`
}

const formatDatePart = (timestamp: number) => {
  const date = new Date(timestamp)
  const day = date.getDate()
  const month = date.getMonth() + 1
  const year = date.getFullYear()

  const hours24 = date.getHours()
  const minutes = date.getMinutes()
  const period = hours24 >= 12 ? 'pm' : 'am'
  const hours12 = hours24 % 12 || 12
  const minuteString = minutes.toString().padStart(2, '0')

  return {
    dateLabel: `${day}/${month}/${year}`,
    timeLabel: `${hours12}:${minuteString}${period}`,
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

const formatClockTime = (timestamp: number) => {
  const date = new Date(timestamp)
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12

  return `${hours12.toString().padStart(2, '0')}:${minutes}:${seconds} ${period}`
}

const computeTaskHeadingMetrics = (length: number, viewportWidth: number) => {
  const containerWidth = Math.max(Math.min(viewportWidth * 0.88, 680), 220)
  const maxFont = viewportWidth >= 1600
    ? 2.8
    : viewportWidth >= 1280
    ? 2.5
    : viewportWidth >= 1024
    ? 2.3
    : viewportWidth >= 768
    ? 2.05
    : viewportWidth >= 560
    ? 1.85
    : viewportWidth >= 420
    ? 1.65
    : 1.45
  const minFont = viewportWidth >= 768 ? 0.55 : viewportWidth >= 560 ? 0.45 : 0.35
  const approxCharWidth = 0.68

  const safeLength = Math.max(length, 4)
  const fontSizeCandidatePx = containerWidth / (safeLength * approxCharWidth)
  let fontSize = Math.min(maxFont, fontSizeCandidatePx / 16)
  fontSize = Math.max(fontSize, minFont)

  const resolveLetterSpacing = (size: number) => {
    if (size >= 2.2) return 0.18
    if (size >= 1.9) return 0.15
    if (size >= 1.6) return 0.12
    if (size >= 1.3) return 0.1
    return 0.06
  }

  let letterSpacingEm = resolveLetterSpacing(fontSize)
  const estimateWidth = (size: number, spacingEm: number) =>
    size * 16 * (safeLength * approxCharWidth + Math.max(safeLength - 1, 0) * spacingEm)

  let estimated = estimateWidth(fontSize, letterSpacingEm)
  if (estimated > containerWidth) {
    const scale = containerWidth / estimated
    fontSize = Math.max(fontSize * scale, minFont)
    letterSpacingEm = resolveLetterSpacing(fontSize)
    estimated = estimateWidth(fontSize, letterSpacingEm)
    if (estimated > containerWidth) {
      const scaleAgain = containerWidth / estimated
      fontSize = Math.max(fontSize * scaleAgain, minFont)
    }
  }

  letterSpacingEm = resolveLetterSpacing(fontSize)

  const fontSizeValue = Number(fontSize.toFixed(3))
  const fontSizeStr = `${fontSizeValue}`.replace(/\.0+$/, '')
  const letterSpacing = `${letterSpacingEm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}em`

  return {
    fontSize: `${fontSizeStr}rem`,
    letterSpacing,
  }
}

function App() {
  const initialTaskName = useMemo(() => getStoredTaskName(), [])
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [elapsed, setElapsed] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(() => getStoredHistory())
  const [currentTaskName, setCurrentTaskName] = useState<string>(initialTaskName)
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [isTaskFocused, setIsTaskFocused] = useState(false)
  const [isTaskExpanded, setIsTaskExpanded] = useState(false)
  const [isToggleVisible, setIsToggleVisible] = useState(false)
  const [isTaskEditing, setIsTaskEditing] = useState(false)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280
  )
  const taskContentRef = useRef<HTMLSpanElement | null>(null)
  const taskHeadingRef = useRef<HTMLDivElement | null>(null)
  const singleClickTimerRef = useRef<number | null>(null)

  const frameRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return

    const root = document.documentElement
    root.setAttribute('data-theme', theme)

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    }
  }, [theme])

  useEffect(() => {
    if (typeof window === 'undefined') return

    setCurrentTime(Date.now())
    const intervalId = window.setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleResize = () => {
      setViewportWidth(window.innerWidth)
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
    } catch (error) {
      console.warn('Failed to persist stopwatch history', error)
    }
  }, [history])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const trimmed = currentTaskName.trim()
    const value = trimmed.length > 0 ? trimmed : ''

    try {
      window.localStorage.setItem(CURRENT_TASK_STORAGE_KEY, value)
    } catch (error) {
      console.warn('Failed to persist current task name', error)
    }
  }, [currentTaskName])

  useEffect(() => {
    if (!isRunning) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      lastTickRef.current = null
      return
    }

    const update = (timestamp: number) => {
      if (lastTickRef.current === null) {
        lastTickRef.current = timestamp
      }
      const delta = timestamp - lastTickRef.current
      lastTickRef.current = timestamp
      setElapsed((prev) => prev + delta)
      frameRef.current = requestAnimationFrame(update)
    }

    frameRef.current = requestAnimationFrame(update)

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [isRunning])

  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return

    window.__ncSetElapsed = (ms: number) => {
      setIsRunning(false)
      const safeElapsed = Math.max(0, Math.floor(ms))
      setElapsed(safeElapsed)
      const now = Date.now()
      setSessionStart(now - safeElapsed)
      lastTickRef.current = null
    }

    return () => {
      delete window.__ncSetElapsed
    }
  }, [])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (singleClickTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(singleClickTimerRef.current)
        singleClickTimerRef.current = null
      }
    }
  }, [])

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  const handleStartStop = () => {
    setIsRunning((current) => {
      if (current) {
        return false
      }

      if (sessionStart === null) {
        setSessionStart(Date.now())
      }

      return true
    })
  }

  const safeTaskName = useMemo(() => currentTaskName.trim(), [currentTaskName])

  const hasTaskOverflow = safeTaskName.length > TASK_DISPLAY_LIMIT
  const shouldShowFullTask = isTaskExpanded || isTaskFocused || isTaskEditing
  const displayTaskName = shouldShowFullTask
    ? safeTaskName
    : safeTaskName.slice(0, TASK_DISPLAY_LIMIT)

  const handleReset = () => {
    const recordedElapsed = elapsed
    setIsRunning(false)
    setElapsed(0)
    lastTickRef.current = null

    if (recordedElapsed > 0) {
      const now = Date.now()
      const startedAt = sessionStart ?? now - recordedElapsed
      const entry: HistoryEntry = {
        id: makeHistoryId(),
        taskName: safeTaskName,
        elapsed: recordedElapsed,
        startedAt,
        endedAt: now,
      }

      setHistory((current) => [entry, ...current])
    }

    setSessionStart(null)
    setCurrentTaskName('New Task')
    setIsTaskExpanded(false)
    setIsTaskEditing(false)
  }

  const handleTaskNameInput = (event: FormEvent<HTMLSpanElement>) => {
    const raw = event.currentTarget.textContent ?? ''
    const sanitized = raw.replace(/\n+/g, ' ')
    const limited = sanitized.slice(0, MAX_TASK_STORAGE_LENGTH)

    const selection = window.getSelection()
    let caretOffset: number | null = null
    if (selection && taskContentRef.current && selection.focusNode && taskContentRef.current.contains(selection.focusNode)) {
      caretOffset = selection.focusOffset
    }

    if (taskContentRef.current && taskContentRef.current.textContent !== limited) {
      taskContentRef.current.textContent = limited
    }

    const textNode = taskContentRef.current?.firstChild
    if (selection && textNode && textNode.nodeType === Node.TEXT_NODE) {
      const range = document.createRange()
      const pos = Math.min(caretOffset ?? limited.length, (textNode.textContent ?? '').length)
      range.setStart(textNode, pos)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (limited !== currentTaskName) {
      setCurrentTaskName(limited)
    }
  }

  const handleTaskNameFocus = () => {
    setIsTaskFocused(true)
    if (hasTaskOverflow) {
      setIsTaskExpanded(true)
      setIsToggleVisible(true)
    }
  }

  const handleTaskNameKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  const toggleTaskExpansion = () => {
    if (!hasTaskOverflow || isTaskEditing) {
      return
    }
    setIsTaskExpanded((current) => {
      const next = !current
      setIsToggleVisible(next)
      return next
    })
  }

  const handleTaskHeadingClick = () => {
    if (!hasTaskOverflow || isTaskEditing) {
      return
    }
    if (shouldShowFullTask) {
      setIsToggleVisible(true)
      return
    }
    if (singleClickTimerRef.current !== null) {
      return
    }
    if (typeof window === 'undefined') {
      toggleTaskExpansion()
      return
    }
    singleClickTimerRef.current = window.setTimeout(() => {
      singleClickTimerRef.current = null
      toggleTaskExpansion()
    }, SINGLE_CLICK_DELAY_MS)
  }

  const handleTaskHeadingDoubleClick = () => {
    if (isTaskEditing) {
      return
    }
    if (singleClickTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(singleClickTimerRef.current)
      singleClickTimerRef.current = null
    }
    setIsTaskExpanded(true)
    setIsToggleVisible(false)
    setIsTaskEditing(true)
  }

  const handleTaskHeadingKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (isTaskEditing) {
      return
    }
    if (!hasTaskOverflow) {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!shouldShowFullTask) {
        toggleTaskExpansion()
      } else {
        setIsToggleVisible(true)
      }
    }
  }

  const handleToggleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    toggleTaskExpansion()
  }

  const handleTaskNameBlur = (event: FocusEvent<HTMLSpanElement>) => {
    setIsTaskFocused(false)
    const value = (event.currentTarget.textContent ?? '').replace(/\n+/g, ' ').trim()
    const limited = value.slice(0, MAX_TASK_STORAGE_LENGTH)
    if (taskContentRef.current && taskContentRef.current.textContent !== limited) {
      taskContentRef.current.textContent = limited
    }
    if (limited !== currentTaskName) {
      setCurrentTaskName(limited)
    }
    const nextTarget = event.relatedTarget as HTMLElement | null
    const isMovingToToggle = Boolean(nextTarget?.closest('.task-heading__toggle'))
    if (!isMovingToToggle) {
      setIsToggleVisible(false)
    }
    setIsTaskEditing(false)
  }

  const beginEditing = (entry: HistoryEntry) => {
    if (editingEntryId && editingEntryId !== entry.id) {
      commitEditing()
    }

    setEditingEntryId(entry.id)
    setEditingValue(entry.taskName)
  }

  const commitEditing = () => {
    if (!editingEntryId) {
      return
    }

    const nextName = editingValue.trim() || 'New Task'
    setHistory((current) =>
      current.map((entry) => (entry.id === editingEntryId ? { ...entry, taskName: nextName } : entry))
    )
    setEditingEntryId(null)
    setEditingValue('')
  }

  const cancelEditing = () => {
    setEditingEntryId(null)
    setEditingValue('')
  }

  useEffect(() => {
    if (!taskContentRef.current) return
    const text = taskContentRef.current.textContent ?? ''
    if (text !== displayTaskName) {
      taskContentRef.current.textContent = displayTaskName
    }
  }, [displayTaskName])

  useEffect(() => {
    if (!isTaskEditing || typeof window === 'undefined') {
      return
    }
    const node = taskContentRef.current
    if (!node) {
      return
    }

    const focusTask = () => {
      node.focus()
      const selection = window.getSelection()
      if (!selection) {
        return
      }
      const range = document.createRange()
      range.selectNodeContents(node)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    const rafId = window.requestAnimationFrame(focusTask)
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [isTaskEditing])

  useEffect(() => {
    if (!shouldShowFullTask || !isToggleVisible || typeof window === 'undefined') {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const container = taskHeadingRef.current
      if (!container) {
        return
      }
      if (!container.contains(event.target as Node)) {
        setIsToggleVisible(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [shouldShowFullTask, isToggleVisible])

  const formattedTime = useMemo(() => formatTime(elapsed), [elapsed])
  const formattedClock = useMemo(() => formatClockTime(currentTime), [currentTime])
  const clockDateTime = useMemo(() => new Date(currentTime).toISOString(), [currentTime])
  const hasHistory = history.length > 0
  const previewTaskText = useMemo(() => {
    const preview = safeTaskName.slice(0, TASK_DISPLAY_LIMIT)
    return `Task: ${preview}${hasTaskOverflow ? '...' : ''}`
  }, [safeTaskName, hasTaskOverflow])
  const displayLength = previewTaskText.length
  const taskHeadingMetrics = useMemo(
    () => computeTaskHeadingMetrics(displayLength, viewportWidth),
    [displayLength, viewportWidth]
  )
  const taskHeadingStyle = useMemo(
    () => ({
      fontSize: taskHeadingMetrics.fontSize,
      letterSpacing: taskHeadingMetrics.letterSpacing,
      lineHeight: 1.2,
      whiteSpace: shouldShowFullTask ? 'normal' : 'nowrap',
      maxWidth: '100%',
    }),
    [taskHeadingMetrics, shouldShowFullTask]
  )
  const taskHeadingClassName = useMemo(
    () =>
      ['task-heading', shouldShowFullTask ? 'task-heading--expanded' : '', isTaskEditing ? 'task-heading--editing' : '']
        .filter(Boolean)
        .join(' '),
    [shouldShowFullTask, isTaskEditing]
  )
  const taskNameStyle = useMemo<CSSProperties>(
    () => ({
      whiteSpace: shouldShowFullTask ? 'normal' : 'nowrap',
      maxWidth: shouldShowFullTask ? '100%' : `${TASK_DISPLAY_LIMIT}ch`,
      wordBreak: shouldShowFullTask ? 'break-word' : 'normal',
    }),
    [shouldShowFullTask]
  )
  const taskHeadingTextStyle = useMemo<CSSProperties>(
    () => ({
      cursor: isTaskEditing ? 'text' : hasTaskOverflow ? 'pointer' : 'default',
    }),
    [isTaskEditing, hasTaskOverflow]
  )
  const shouldShowToggle = hasTaskOverflow && !isTaskEditing && (!shouldShowFullTask || isToggleVisible)
  const toggleIndicatorLabel = shouldShowFullTask ? 'show less' : '...'
  const toggleIndicatorAriaLabel = shouldShowFullTask ? 'Collapse full task name' : 'Expand full task name'
  const taskHeadingTitle = hasTaskOverflow
    ? 'Click to toggle the full task name or double-click to edit.'
    : 'Double-click to edit the task name.'
  const charCount = formattedTime.replace('.', '').length
  const colonCount = (formattedTime.match(/:/g) ?? []).length
  const hasDays = formattedTime.includes('D')

  const baseTimeClass = hasDays ? 'time-days' : colonCount >= 2 ? 'time-hours' : 'time-minutes'

  let lengthClass = ''
  if (charCount >= 15) {
    lengthClass = 'time-length-xxs'
  } else if (charCount >= 13) {
    lengthClass = 'time-length-xs'
  } else if (charCount >= 11) {
    lengthClass = 'time-length-sm'
  }

  const timeValueClassName = ['time-value', baseTimeClass, lengthClass].filter(Boolean).join(' ')
  const statusText = isRunning ? 'running' : elapsed > 0 ? 'paused' : 'idle'
  const primaryLabel = isRunning ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start'
  const nextThemeLabel = theme === 'dark' ? 'light' : 'dark'
  return (
    <div className="page">
      <header className="site-header">
        <div className="site-header__inner">
          <nav className="top-bar" aria-label="Primary">
            <div className="brand">
              <span className="brand-text">NC-STOPWATCH</span>
            </div>
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${nextThemeLabel} mode`}
            >
              <span className="theme-toggle-label">{nextThemeLabel}</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="site-main">
        <div className="site-main__inner">
          <h1 className="stopwatch-heading">Stopwatch</h1>
          <div
            className={taskHeadingClassName}
            role="group"
            aria-label="Task heading"
            style={taskHeadingStyle}
            ref={taskHeadingRef}
          >
            <span
              className="task-heading__text"
              style={taskHeadingTextStyle}
              onClick={handleTaskHeadingClick}
              onDoubleClick={handleTaskHeadingDoubleClick}
              onKeyDown={handleTaskHeadingKeyDown}
              role={!isTaskEditing && hasTaskOverflow ? 'button' : undefined}
              tabIndex={!isTaskEditing && hasTaskOverflow ? 0 : -1}
              aria-expanded={hasTaskOverflow ? shouldShowFullTask : undefined}
              aria-label={!isTaskEditing && hasTaskOverflow ? 'Toggle full task name' : undefined}
              title={!isTaskEditing ? taskHeadingTitle : undefined}
            >
              <span className="task-heading__prefix">Task:</span>
              <span
                className="task-heading__free"
                style={taskNameStyle}
                contentEditable={isTaskEditing}
                suppressContentEditableWarning
                ref={taskContentRef}
                onInput={handleTaskNameInput}
                onBlur={handleTaskNameBlur}
                onFocus={handleTaskNameFocus}
                onKeyDown={handleTaskNameKeyDown}
                role={isTaskEditing ? 'textbox' : undefined}
                tabIndex={isTaskEditing ? 0 : -1}
                aria-label="Task name"
                spellCheck={false}
              />
            </span>
            {shouldShowToggle ? (
              <button
                type="button"
                className="task-heading__toggle"
                onClick={handleToggleButtonClick}
                aria-label={toggleIndicatorAriaLabel}
                aria-expanded={shouldShowFullTask}
              >
                {toggleIndicatorLabel}
              </button>
            ) : null}
          </div>
          <section className="stopwatch-card" role="region" aria-live="polite">
            <time className="card-clock" dateTime={clockDateTime} aria-label="Current time">
              {formattedClock}
            </time>
            <div className="time-display">
              <span className="time-label">elapsed</span>
              <span className={timeValueClassName}>
                {formattedTime}
              </span>
            </div>

            <div className="status-row" aria-live="polite">
              <span className={`status-dot status-${statusText}`} aria-hidden="true" />
              <span className="status-text">{statusText}</span>
            </div>

            <div className="controls">
              <button
                className="control control-primary"
                type="button"
                onClick={handleStartStop}
              >
                {primaryLabel}
              </button>
              <button
                className="control control-secondary"
                type="button"
                onClick={handleReset}
                disabled={elapsed === 0}
              >
                Reset
              </button>
            </div>
          </section>

          <section
            className={`history-section${hasHistory ? '' : ' history-section--empty'}`}
            aria-label="History"
          >
            <div className="history-section__header">
              <h2 className="history-heading">History</h2>
              {hasHistory ? <span className="history-count">{history.length}</span> : null}
            </div>

            {hasHistory ? (
              <ol className="history-list">
                {history.map((entry) => (
                  <li key={entry.id} className="history-entry">
                    <div className="history-entry__top">
                      {editingEntryId === entry.id ? (
                        <input
                          className="history-entry__task-input"
                          type="text"
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          onBlur={commitEditing}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitEditing()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelEditing()
                            }
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="history-entry__task"
                          role="button"
                          tabIndex={0}
                          onDoubleClick={() => beginEditing(entry)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              beginEditing(entry)
                            }
                          }}
                          aria-label={`Rename task "${entry.taskName}"`}
                          title="Double-click to rename"
                        >
                          {entry.taskName}
                        </span>
                      )}
                      <span className="history-entry__duration">{formatTime(entry.elapsed)}</span>
                    </div>
                    <div className="history-entry__meta">{formatDateRange(entry.startedAt, entry.endedAt)}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="history-empty">No sessions yet. Start the stopwatch to build your timeline.</p>
            )}
          </section>

          <p className="meta meta-note">Built with React + Vite for seamless desktop and mobile use.</p>
        </div>
      </main>

    </div>
  )
}

export default App
