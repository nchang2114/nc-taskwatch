import { ensureSingleUserSession, supabase } from './supabaseClient'
import type { QuickItem, QuickSubtask } from './quickList'

export const QUICK_LIST_DB_GOAL_ID = '00000000-0000-4000-8000-0000000000a1'
export const QUICK_LIST_DB_BUCKET_ID = '00000000-0000-4000-8000-0000000000a2'

const QUICK_LIST_GOAL_NAME = 'Quick List (Hidden)'
const QUICK_LIST_BUCKET_NAME = 'Quick List'

let ensurePromise: Promise<{ goalId: string; bucketId: string } | null> | null = null

const normalizeDifficulty = (
  difficulty: unknown,
): QuickItem['difficulty'] => {
  if (difficulty === 'green' || difficulty === 'yellow' || difficulty === 'red') {
    return difficulty
  }
  return 'none'
}

const mapSubtasks = (subtasks: Array<any> | null | undefined): QuickSubtask[] => {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return []
  }
  return subtasks
    .map((subtask) => ({
      id: subtask.id,
      text: typeof subtask.text === 'string' ? subtask.text : '',
      completed: Boolean(subtask.completed),
      sortIndex: typeof subtask.sort_index === 'number' ? subtask.sort_index : 0,
      updatedAt: typeof subtask.updated_at === 'string' ? subtask.updated_at : undefined,
    }))
    .sort((a, b) => a.sortIndex - b.sortIndex)
}

const mapTasksToQuickItems = (tasks: any[], subtasksByTaskId: Map<string, QuickSubtask[]>): QuickItem[] => {
  return tasks.map((task, index) => {
    const subs = subtasksByTaskId.get(task.id) ?? []
    return {
      id: task.id,
      text: typeof task.text === 'string' ? task.text : '',
      completed: Boolean(task.completed),
      difficulty: normalizeDifficulty(task.difficulty),
      priority: Boolean(task.priority),
      sortIndex: index,
      updatedAt: typeof task.updated_at === 'string' ? task.updated_at : new Date().toISOString(),
      notes: typeof task.notes === 'string' ? task.notes : '',
      subtasks: subs,
      expanded: false,
      subtasksCollapsed: subs.length === 0,
      notesCollapsed: !(typeof task.notes === 'string' && task.notes.trim().length > 0),
    }
  })
}

export async function ensureQuickListRemoteStructures(): Promise<{ goalId: string; bucketId: string } | null> {
  if (!supabase) return null
  if (ensurePromise) {
    return ensurePromise
  }
  ensurePromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session?.user?.id) {
      ensurePromise = null
      return null
    }
    const userId = session.user.id
    const goalPayload = {
      id: QUICK_LIST_DB_GOAL_ID,
      user_id: userId,
      name: QUICK_LIST_GOAL_NAME,
      color: 'from-blue-500 to-indigo-600',
      sort_index: 10_000_000,
      card_surface: 'glass',
      starred: false,
      goal_archive: true,
    }
    const bucketPayload = {
      id: QUICK_LIST_DB_BUCKET_ID,
      user_id: userId,
      goal_id: QUICK_LIST_DB_GOAL_ID,
      name: QUICK_LIST_BUCKET_NAME,
      favorite: false,
      sort_index: 10_000_000,
      bucket_archive: true,
      buckets_card_style: 'glass',
    }
    try {
      await supabase.from('goals').upsert(goalPayload, { onConflict: 'id' })
      await supabase.from('buckets').upsert(bucketPayload, { onConflict: 'id' })
    } catch (error) {
      console.warn('[quickListRemote] Failed to ensure Quick List goal/bucket:', error)
      ensurePromise = null
      return null
    }
    ensurePromise = null
    return { goalId: QUICK_LIST_DB_GOAL_ID, bucketId: QUICK_LIST_DB_BUCKET_ID }
  })()
  return ensurePromise
}

export async function fetchQuickListRemoteItems(): Promise<{
  goalId: string
  bucketId: string
  items: QuickItem[]
} | null> {
  if (!supabase) return null
  const ids = (await ensureQuickListRemoteStructures()) ?? null
  if (!ids) {
    return null
  }
  const { bucketId, goalId } = ids
  try {
    const { data: tasks, error: taskError } = await supabase
      .from('tasks')
      .select('id, text, completed, difficulty, priority, sort_index, notes, updated_at')
      .eq('bucket_id', bucketId)
      .order('completed', { ascending: true })
      .order('priority', { ascending: false })
      .order('sort_index', { ascending: true })
    if (taskError || !tasks) {
      if (taskError) {
        console.warn('[quickListRemote] Failed to fetch quick list tasks:', taskError.message ?? taskError)
      }
      return { goalId, bucketId, items: [] }
    }
    const taskIds = tasks.map((task) => task.id)
    const { data: subtasks, error: subtaskError } = taskIds.length
      ? await supabase
          .from('task_subtasks')
          .select('id, task_id, text, completed, sort_index, updated_at')
          .in('task_id', taskIds)
          .order('sort_index', { ascending: true })
      : { data: [], error: null as any }
    if (subtaskError) {
      console.warn('[quickListRemote] Failed to fetch quick list subtasks:', subtaskError.message ?? subtaskError)
    }
    const subtasksByTaskId = new Map<string, QuickSubtask[]>()
    ;(subtasks ?? []).forEach((subtask) => {
      const list = subtasksByTaskId.get(subtask.task_id) ?? []
      list.push({
        id: subtask.id,
        text: typeof subtask.text === 'string' ? subtask.text : '',
        completed: Boolean(subtask.completed),
        sortIndex: typeof subtask.sort_index === 'number' ? subtask.sort_index : 0,
        updatedAt: typeof subtask.updated_at === 'string' ? subtask.updated_at : undefined,
      })
      subtasksByTaskId.set(subtask.task_id, list)
    })
    const items = mapTasksToQuickItems(tasks, subtasksByTaskId)
    return { goalId, bucketId, items }
  } catch (error) {
    console.warn('[quickListRemote] Unexpected error fetching remote quick list items:', error)
    return null
  }
}
