import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './App.css'
import GoalsPage from './pages/GoalsPage'
import ReflectionPage from './pages/ReflectionPage'
import TaskwatchPage from './pages/TaskwatchPage'

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

  const toggleNav = () => {
    if (!isNavCollapsed) {
      return
    }
    setIsNavOpen((current) => !current)
  }

  const closeNav = () => {
    setIsNavOpen(false)
  }

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab)
    closeNav()
  }

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

  let page: ReactNode
  if (activeTab === 'goals') {
    page = <GoalsPage />
  } else if (activeTab === 'reflection') {
    page = <ReflectionPage />
  } else {
    page = <TaskwatchPage viewportWidth={viewportWidth} />
  }

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

      <main className={mainClassName}>{page}</main>
    </div>
  )
}

export default App
