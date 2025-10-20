import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import GoalsPage from './pages/GoalsPage'
import ReflectionPage from './pages/ReflectionPage'
import TaskwatchPage from './pages/TaskwatchPage'
import { FOCUS_EVENT_TYPE } from './lib/focusChannel'

type Theme = 'light' | 'dark'
type TabKey = 'goals' | 'taskwatch' | 'reflection'

const THEME_STORAGE_KEY = 'nc-taskwatch-theme'
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

const COMPACT_BRAND_BREAKPOINT = 640
const DEFAULT_NAV_BUFFER = 56
const COMPACT_NAV_BUFFER = 24

const TAB_PANEL_IDS: Record<TabKey, string> = {
  goals: 'tab-panel-goals',
  taskwatch: 'tab-panel-taskwatch',
  reflection: 'tab-panel-reflection',
}

const ENABLE_TAB_SWIPE = false

const SWIPE_SEQUENCE: TabKey[] = ['reflection', 'taskwatch', 'goals']


function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [activeTab, setActiveTab] = useState<TabKey>('taskwatch')
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )
  const [isNavCollapsed, setIsNavCollapsed] = useState(false)
  const [isNavOpen, setIsNavOpen] = useState(false)

  const navContainerRef = useRef<HTMLElement | null>(null)
  const navBrandRef = useRef<HTMLButtonElement | null>(null)
  const navControlsRef = useRef<HTMLDivElement | null>(null)
  const navMeasureRef = useRef<HTMLDivElement | null>(null)

  const isCompactBrand = viewportWidth <= COMPACT_BRAND_BREAKPOINT

  const evaluateNavCollapse = useCallback(() => {
    const container = navContainerRef.current
    const measure = navMeasureRef.current

    if (!container || !measure) {
      setIsNavCollapsed((current) => (current ? false : current))
      return
    }

    const brandWidth = navBrandRef.current?.offsetWidth ?? 0
    const controlsWidth = navControlsRef.current?.offsetWidth ?? 0
    const navWidth = container.clientWidth
    const linksWidth = measure.scrollWidth
    const buffer = isCompactBrand ? COMPACT_NAV_BUFFER : DEFAULT_NAV_BUFFER
    const available = Math.max(0, navWidth - brandWidth - controlsWidth - buffer)
    const shouldCollapse = linksWidth > available

    setIsNavCollapsed((current) => (current !== shouldCollapse ? shouldCollapse : current))
  }, [isCompactBrand])

  const applyTheme = useCallback(
    (value: Theme) => {
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', value)
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, value)
      }
    },
    [],
  )

  useEffect(() => {
    applyTheme(theme)
  }, [applyTheme, theme])

  // Gate hover-only visuals with a root class to avoid accidental previews on touch devices
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const mq1 = window.matchMedia('(hover: hover) and (pointer: fine)')
    const mq2 = window.matchMedia('(any-hover: hover) and (any-pointer: fine)')
    const update = () => {
      const supportsHover = mq1.matches || mq2.matches
      document.documentElement.classList.toggle('has-hover', supportsHover)
    }
    update()
    if (typeof mq1.addEventListener === 'function') {
      mq1.addEventListener('change', update)
      mq2.addEventListener('change', update)
      return () => {
        mq1.removeEventListener('change', update)
        mq2.removeEventListener('change', update)
      }
    }
    // Fallback for older Safari
    if (typeof mq1.addListener === 'function') {
      mq1.addListener(update)
      mq2.addListener(update)
      return () => {
        mq1.removeListener(update)
        mq2.removeListener(update)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const width = window.innerWidth
      setViewportWidth(width)
      evaluateNavCollapse()
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        evaluateNavCollapse()
      })

      const observeNodes = () => {
        const nodes: Array<Element | null> = [
          navContainerRef.current,
          navMeasureRef.current,
          navBrandRef.current,
          navControlsRef.current,
        ]

        nodes.forEach((node) => {
          if (node) {
            observer.observe(node)
          }
        })
      }

      observeNodes()

      return () => {
        window.removeEventListener('resize', handleResize)
        observer.disconnect()
      }
    }

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [evaluateNavCollapse])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    evaluateNavCollapse()
  }, [activeTab, theme, evaluateNavCollapse])

  useEffect(() => {
    if (!isNavCollapsed && isNavOpen) {
      setIsNavOpen(false)
    }
  }, [isNavCollapsed, isNavOpen])

  useEffect(() => {
    if (!isNavOpen) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsNavOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isNavOpen])

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  const closeNav = useCallback(() => {
    setIsNavOpen(false)
  }, [])

  const selectTab = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab)
      closeNav()
    },
    [closeNav],
  )

  const toggleNav = useCallback(() => {
    if (!isNavCollapsed) {
      return
    }
    setIsNavOpen((current) => !current)
  }, [isNavCollapsed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleFocusSwitch = () => {
      setActiveTab('taskwatch')
      setIsNavOpen(false)
    }
    window.addEventListener(FOCUS_EVENT_TYPE, handleFocusSwitch)
    return () => {
      window.removeEventListener(FOCUS_EVENT_TYPE, handleFocusSwitch)
    }
  }, [])

  const nextThemeLabel = theme === 'dark' ? 'light' : 'dark'
  const brandButtonClassName = useMemo(
    () => ['brand', 'brand--toggle', isCompactBrand ? 'brand--compact' : ''].filter(Boolean).join(' '),
    [isCompactBrand],
  )
  const navItems: Array<{ key: TabKey; label: string }> = [
    { key: 'goals', label: 'Goals' },
    { key: 'taskwatch', label: 'Taskwatch' },
    { key: 'reflection', label: 'Reflection' },
  ]
  const swipeStateRef = useRef<{
    pointerId: number | null
    startX: number
    startY: number
    active: boolean
    handled: boolean
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    active: false,
    handled: false,
  })
  const SWIPE_ACTIVATION_DISTANCE = 16
  const SWIPE_TRIGGER_DISTANCE = 72
  const SWIPE_MAX_OFF_AXIS = 80


  const handleSwipePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') {
        return
      }
      if (isNavOpen) {
        return
      }
      const state = swipeStateRef.current
      if (state.pointerId !== null) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        target.closest?.(
          'input, textarea, select, [contenteditable="true"], [data-disable-tab-swipe], .goal-task-input',
        )
      ) {
        return
      }
      swipeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        handled: false,
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [isNavOpen],
  )

  const handleSwipePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = swipeStateRef.current
    if (event.pointerId !== state.pointerId || state.handled) {
      return
    }
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.active) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_ACTIVATION_DISTANCE) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        swipeStateRef.current = {
          pointerId: null,
          startX: 0,
          startY: 0,
          active: false,
          handled: true,
        }
        return
      }
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_ACTIVATION_DISTANCE) {
        state.active = true
      }
    }
    if (state.active && Math.abs(dy) > SWIPE_MAX_OFF_AXIS) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      swipeStateRef.current = {
        pointerId: null,
        startX: 0,
        startY: 0,
        active: false,
        handled: true,
      }
      return
    }
    if (state.active) {
      event.preventDefault()
    }
  }, [])

  const finalizeSwipe = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = swipeStateRef.current
      if (event.pointerId !== state.pointerId) {
        return
      }
      if (state.active && !state.handled) {
        const dx = event.clientX - state.startX
        if (Math.abs(dx) >= SWIPE_TRIGGER_DISTANCE) {
          const currentIndex = SWIPE_SEQUENCE.indexOf(activeTab)
          if (currentIndex !== -1) {
            const length = SWIPE_SEQUENCE.length
            const nextIndex = dx > 0
              ? (currentIndex + 1) % length
              : (currentIndex - 1 + length) % length
            const next = SWIPE_SEQUENCE[nextIndex]
            if (next !== activeTab) {
              selectTab(next)
            }
          }
        }
      }
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      swipeStateRef.current = {
        pointerId: null,
        startX: 0,
        startY: 0,
        active: false,
        handled: false,
      }
    },
    [activeTab, selectTab],
  )

  const handleSwipePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finalizeSwipe(event)
    },
    [finalizeSwipe],
  )

  const handleSwipePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finalizeSwipe(event)
    },
    [finalizeSwipe],
  )

  const topBarClassName = useMemo(
    () =>
      ['top-bar', isNavCollapsed ? 'top-bar--collapsed' : '', isNavCollapsed && isNavOpen ? 'top-bar--drawer-open' : '']
        .filter(Boolean)
        .join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const headerClassName = useMemo(
    () => ['navbar', isNavCollapsed && isNavOpen ? 'navbar--drawer-open' : ''].filter(Boolean).join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const drawerContainerClassName = useMemo(
    () => ['top-bar__drawer', isNavCollapsed && isNavOpen ? 'top-bar__drawer--open' : ''].filter(Boolean).join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const collapsedNavClassName = useMemo(() => ['nav-links', 'nav-links--drawer'].join(' '), [])

  const navLinkElements = navItems.map((item) => {
    const isActive = item.key === activeTab
    return (
      <button
        key={item.key}
        type="button"
        className={`nav-link${isActive ? ' nav-link--active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => selectTab(item.key)}
        aria-controls={TAB_PANEL_IDS[item.key]}
      >
        {item.label}
      </button>
    )
  })

  const navMeasureElements = navItems.map((item) => (
    <span key={item.key} className="nav-link nav-link--ghost">
      {item.label}
    </span>
  ))

  const swipeHandlers = ENABLE_TAB_SWIPE
    ? {
        onPointerDownCapture: handleSwipePointerDown,
        onPointerMoveCapture: handleSwipePointerMove,
        onPointerUpCapture: handleSwipePointerUp,
        onPointerCancelCapture: handleSwipePointerCancel,
      }
    : undefined

  const mainClassName = 'site-main'

  return (
    <div className="page">
      <header className={headerClassName}>
        <div className="navbar__inner">
            <nav
              className={topBarClassName}
              aria-label="Primary navigation"
              ref={navContainerRef}
            >
              <button
                className={brandButtonClassName}
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${nextThemeLabel} mode`}
                ref={navBrandRef}
              >
                <span className={`brand-text${isCompactBrand ? ' sr-only' : ''}`}>NC-TASKWATCH</span>
                <span className="brand-indicator" aria-hidden="true">
                  {theme === 'dark' ? '☾' : '☀︎'}
                </span>
              </button>
              <div className="nav-links" hidden={isNavCollapsed}>
                {navLinkElements}
              </div>
              <div className="nav-links nav-links--measure" aria-hidden ref={navMeasureRef}>
                {navMeasureElements}
              </div>
              <div className="top-bar__controls" ref={navControlsRef}>
                <button
                  className="nav-toggle"
                  type="button"
                  aria-label="Toggle navigation"
                  aria-expanded={isNavCollapsed ? isNavOpen : undefined}
                  aria-controls={isNavCollapsed ? 'primary-navigation' : undefined}
                  onClick={toggleNav}
                  hidden={!isNavCollapsed}
                >
                  <span className={`hamburger${isNavOpen ? ' open' : ''}`} />
                </button>
              </div>
            </nav>
        </div>
        {isNavCollapsed ? (
          <div className={drawerContainerClassName} aria-hidden={!isNavOpen}>
            <div className={collapsedNavClassName} id="primary-navigation" aria-hidden={!isNavOpen}>
              {navItems.map((item) => {
                const isActive = item.key === activeTab
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`nav-link nav-link--drawer${isActive ? ' nav-link--active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    aria-controls={TAB_PANEL_IDS[item.key]}
                    onClick={() => selectTab(item.key)}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </header>

      <main
        className={mainClassName}
        {...(swipeHandlers ?? {})}
      >
        <section
          id={TAB_PANEL_IDS.goals}
          role="tabpanel"
          aria-hidden={activeTab !== 'goals'}
          className="tab-panel"
          hidden={activeTab !== 'goals'}
        >
          <GoalsPage />
        </section>

        <section
          id={TAB_PANEL_IDS.taskwatch}
          role="tabpanel"
          aria-hidden={activeTab !== 'taskwatch'}
          className="tab-panel"
          hidden={activeTab !== 'taskwatch'}
        >
          <TaskwatchPage viewportWidth={viewportWidth} />
        </section>

        <section
          id={TAB_PANEL_IDS.reflection}
          role="tabpanel"
          aria-hidden={activeTab !== 'reflection'}
          className="tab-panel"
          hidden={activeTab !== 'reflection'}
        >
          <ReflectionPage />
        </section>
      </main>
    </div>
  )
}

export default App
