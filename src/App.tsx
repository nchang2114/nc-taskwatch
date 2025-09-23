import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'nc-stopwatch-theme'

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

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [elapsed, setElapsed] = useState(0)
  const [isRunning, setIsRunning] = useState(false)

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
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  const handleStartStop = () => {
    setIsRunning((current) => !current)
  }

  const handleReset = () => {
    setIsRunning(false)
    setElapsed(0)
    lastTickRef.current = null
  }

  const formattedTime = useMemo(() => formatTime(elapsed), [elapsed])
  const statusText = isRunning ? 'running' : elapsed > 0 ? 'paused' : 'idle'
  const primaryLabel = isRunning ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start'
  const nextThemeLabel = theme === 'dark' ? 'light' : 'dark'
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <span className="brand-pulse" aria-hidden="true" />
          <span className="brand-text">NC Stopwatch</span>
        </div>
        <button
          className="theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${nextThemeLabel} mode`}
        >
          <span className="theme-toggle-label">{nextThemeLabel}</span>
        </button>
      </header>

      <main className="stopwatch-card" role="region" aria-live="polite">
        <div className="time-display">
          <span className="time-label">elapsed</span>
          <span className="time-value">
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
      </main>

      <footer className="meta">
        <p>Built with React + Vite for seamless desktop and mobile use.</p>
      </footer>
    </div>
  )
}

export default App
