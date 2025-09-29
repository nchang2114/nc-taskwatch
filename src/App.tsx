import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import './App.css'
import GoalsPage from './pages/GoalsPage'
import ReflectionPage from './pages/ReflectionPage'
import TaskwatchPage from './pages/TaskwatchPage'

type Theme = 'light' | 'dark'
type TabKey = 'goals' | 'taskwatch' | 'reflection'

const THEME_STORAGE_KEY = 'nc-taskwatch-theme'
const NAV_BREAKPOINT = 1024

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

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [activeTab, setActiveTab] = useState<TabKey>('taskwatch')
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )
  const [isNavCollapsed, setIsNavCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= NAV_BREAKPOINT : false,
  )
  const [isNavOpen, setIsNavOpen] = useState(false)

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
      setIsNavCollapsed(width <= NAV_BREAKPOINT)
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

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

  let page: ReactNode
  if (activeTab === 'goals') {
    page = <GoalsPage onNavigate={selectTab} />
  } else if (activeTab === 'reflection') {
    page = <ReflectionPage />
  } else {
    page = <TaskwatchPage viewportWidth={viewportWidth} />
  }

  const mainClassName = useMemo(
    () => ['site-main', activeTab === 'goals' ? 'site-main--goals' : ''].filter(Boolean).join(' '),
    [activeTab],
  )

  return (
    <div className="page">
      {activeTab === 'goals' ? null : (
        <header className={headerClassName}>
          <div className="navbar__inner">
            <nav className={topBarClassName} aria-label="Primary navigation">
              <button
                className="brand brand--toggle"
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${nextThemeLabel} mode`}
              >
                <span className="brand-text">NC-TASKWATCH</span>
                <span className="brand-indicator" aria-hidden="true">
                  {theme === 'dark' ? '☾' : '☀︎'}
                </span>
              </button>
              {isNavCollapsed ? null : <div className="nav-links">{navLinkElements}</div>}
              <div className="top-bar__controls">
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
                {navLinkElements}
              </div>
            </div>
          ) : null}
        </header>
      )}

      <main className={mainClassName}>{page}</main>
    </div>
  )
}

export default App
