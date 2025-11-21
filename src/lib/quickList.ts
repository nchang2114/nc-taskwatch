export type QuickSubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
}

export type QuickItem = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
  // Optional details (to mirror bucket task capabilities visually)
  notes?: string
  subtasks?: QuickSubtask[]
  expanded?: boolean
  subtasksCollapsed?: boolean
  notesCollapsed?: boolean
  // Visual parity: difficulty and priority
  difficulty?: 'none' | 'green' | 'yellow' | 'red'
  priority?: boolean
}

export const QUICK_LIST_STORAGE_KEY = 'nc-taskwatch-quick-list-v1'
export const QUICK_LIST_UPDATE_EVENT = 'nc-quick-list:updated'
const QUICK_LIST_USER_STORAGE_KEY = 'nc-taskwatch-quick-list-user'

const readStoredQuickListUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(QUICK_LIST_USER_STORAGE_KEY)
    if (!value) return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

const setStoredQuickListUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (!userId) {
      window.localStorage.removeItem(QUICK_LIST_USER_STORAGE_KEY)
    } else {
      window.localStorage.setItem(QUICK_LIST_USER_STORAGE_KEY, userId)
    }
  } catch {}
}

const sanitizeSubtask = (value: unknown, index: number): QuickSubtask | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as any
  const id = typeof v.id === 'string' && v.id.trim().length > 0 ? v.id : `ql-sub-${index}`
  const text = typeof v.text === 'string' ? v.text : ''
  const completed = Boolean(v.completed)
  const sortIndex = Number.isFinite(v.sortIndex) ? Number(v.sortIndex) : index
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt : undefined
  return { id, text, completed, sortIndex, updatedAt }
}

const sanitizeSubtasks = (value: unknown): QuickSubtask[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: QuickSubtask[] = []
  value.forEach((item, i) => {
    const s = sanitizeSubtask(item, i)
    if (!s) return
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push(s)
  })
  return out
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((it, i) => ({ ...it, sortIndex: i }))
}

const sanitizeItem = (value: unknown, index: number): QuickItem | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as any
  const id = typeof v.id === 'string' && v.id.trim().length > 0 ? v.id : null
  const text = typeof v.text === 'string' ? v.text : ''
  const completed = Boolean(v.completed)
  const sortIndex = Number.isFinite(v.sortIndex) ? Number(v.sortIndex) : index
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt : undefined
  if (!id) return null
  const notes = typeof v.notes === 'string' ? v.notes : ''
  const subtasks = sanitizeSubtasks(v.subtasks)
  const expanded = Boolean(v.expanded)
  const subtasksCollapsed = Boolean(v.subtasksCollapsed)
  const notesCollapsed = Boolean(v.notesCollapsed)
  const difficulty: QuickItem['difficulty'] =
    v.difficulty === 'green' || v.difficulty === 'yellow' || v.difficulty === 'red' || v.difficulty === 'none'
      ? v.difficulty
      : 'none'
  const priority = Boolean(v.priority)
  return {
    id,
    text,
    completed,
    sortIndex,
    updatedAt,
    notes,
    subtasks,
    expanded,
    subtasksCollapsed,
    notesCollapsed,
    difficulty,
    priority,
  }
}

export const sanitizeQuickList = (value: unknown): QuickItem[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: QuickItem[] = []
  value.forEach((item, i) => {
    const s = sanitizeItem(item, i)
    if (!s) return
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push(s)
  })
  // normalize sortIndex sequentially
  return out
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((it, i) => ({ ...it, sortIndex: i }))
}

export const readStoredQuickList = (): QuickItem[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(QUICK_LIST_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const sanitized = sanitizeQuickList(parsed)
    if (sanitized.length > 0) {
      return sanitized
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      return []
    }
    return sanitized
  } catch {
    return []
  }
}

export const writeStoredQuickList = (items: QuickItem[]): QuickItem[] => {
  const normalized = sanitizeQuickList(items)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(QUICK_LIST_STORAGE_KEY, JSON.stringify(normalized))
      window.dispatchEvent(new CustomEvent<QuickItem[]>(QUICK_LIST_UPDATE_EVENT, { detail: normalized }))
    } catch {}
  }
  return normalized
}

export const ensureQuickListUser = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  const normalized = typeof userId === 'string' && userId.trim().length > 0 ? userId : null
  const current = readStoredQuickListUserId()
  if (current === normalized) {
    return
  }
  setStoredQuickListUserId(normalized)
  writeStoredQuickList([])
}

export const subscribeQuickList = (cb: (items: QuickItem[]) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {}
  const handler = (ev: Event) => {
    const ce = ev as CustomEvent<QuickItem[]>
    if (Array.isArray(ce.detail)) cb(sanitizeQuickList(ce.detail))
    else cb(readStoredQuickList())
  }
  window.addEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
  return () => window.removeEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
}
