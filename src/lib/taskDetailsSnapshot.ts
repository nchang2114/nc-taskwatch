export type TaskDetailSubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
}

export type TaskDetailSnapshot = {
  notes: string
  subtasks: TaskDetailSubtask[]
  expanded: boolean
  subtasksCollapsed: boolean
  notesCollapsed: boolean
}

const TASK_DETAILS_STORAGE_KEY = 'nc-taskwatch-task-details-v1'

const sanitizeSubtask = (value: unknown, index: number): TaskDetailSubtask | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id : null
  if (!id) {
    return null
  }
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return null
  }
  const completed = Boolean(candidate.completed)
  const sortIndex =
    typeof candidate.sortIndex === 'number'
      ? candidate.sortIndex
      : typeof (candidate as any).sort_index === 'number'
        ? ((candidate as any).sort_index as number)
        : index
  const updatedAt =
    typeof candidate.updatedAt === 'string'
      ? (candidate.updatedAt as string)
      : typeof (candidate as any).updated_at === 'string'
        ? ((candidate as any).updated_at as string)
        : undefined
  return {
    id,
    text: trimmed,
    completed,
    sortIndex,
    updatedAt,
  }
}

const sanitizeSubtasks = (value: unknown): TaskDetailSubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: TaskDetailSubtask[] = []
  value.forEach((item, index) => {
    const sanitized = sanitizeSubtask(item, index)
    if (!sanitized) {
      return
    }
    if (seen.has(sanitized.id)) {
      return
    }
    seen.add(sanitized.id)
    result.push(sanitized)
  })
  return result
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((item, idx) => ({ ...item, sortIndex: idx }))
}

const sanitizeDetailsState = (value: unknown): Record<string, TaskDetailSnapshot> => {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const source = value as Record<string, unknown>
  const next: Record<string, TaskDetailSnapshot> = {}
  Object.entries(source).forEach(([taskId, raw]) => {
    if (typeof raw !== 'object' || raw === null) {
      return
    }
    const candidate = raw as Record<string, unknown>
    const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
    const subtasks = sanitizeSubtasks(candidate.subtasks)
    const expanded = Boolean(candidate.expanded)
    const subtasksCollapsed = Boolean((candidate as any).subtasksCollapsed)
    const notesCollapsed = Boolean((candidate as any).notesCollapsed)
    next[taskId] = { notes, subtasks, expanded, subtasksCollapsed, notesCollapsed }
  })
  return next
}

export const readStoredTaskDetailsSnapshot = (): Record<string, TaskDetailSnapshot> => {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(TASK_DETAILS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    return sanitizeDetailsState(parsed)
  } catch {
    return {}
  }
}

export { TASK_DETAILS_STORAGE_KEY }
