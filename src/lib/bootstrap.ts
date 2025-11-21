import { supabase, ensureSingleUserSession } from './supabaseClient'
import { readStoredHistory, pushAllHistoryToSupabase, SAMPLE_SLEEP_ROUTINE_ID } from './sessionHistory'
import { readLocalRepeatingRules, pushRepeatingRulesToSupabase } from './repeatingSessions'
import { readStoredQuickList, type QuickItem } from './quickList'
import { ensureQuickListRemoteStructures } from './quickListRemote'
import {
  createTask,
  updateTaskNotes,
  setTaskDifficulty,
  setTaskPriorityAndResort,
  setTaskCompletedAndResort,
  upsertTaskSubtask,
} from './goalsApi'
import { readStoredLifeRoutines, pushLifeRoutinesToSupabase } from './lifeRoutines'

let bootstrapPromises = new Map<string, Promise<void>>()

const sortByIndex = (a: { sortIndex?: number }, b: { sortIndex?: number }) => {
  const left = typeof a.sortIndex === 'number' ? a.sortIndex : 0
  const right = typeof b.sortIndex === 'number' ? b.sortIndex : 0
  return left - right
}

const uploadQuickListItems = async (items: QuickItem[]): Promise<void> => {
  if (!supabase || items.length === 0) {
    return
  }
  const remote = await ensureQuickListRemoteStructures()
  if (!remote) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const { bucketId } = remote
  // Start from a clean slate so we don't duplicate default content
  await supabase
    .from('tasks')
    .delete()
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)

  const ordered = [
    ...items.filter((item) => !item.completed).sort(sortByIndex),
    ...items.filter((item) => item.completed).sort(sortByIndex),
  ]
  for (const item of ordered) {
    try {
      const baseText = item.text?.trim().length ? item.text.trim() : 'Quick task'
      const created = await createTask(bucketId, baseText)
      const taskId = created?.id
      if (!taskId) continue
      const subtasks = Array.isArray(item.subtasks) ? [...item.subtasks].sort(sortByIndex) : []
      for (let idx = 0; idx < subtasks.length; idx += 1) {
        const sub = subtasks[idx]
        const sortIndex = typeof sub.sortIndex === 'number' ? sub.sortIndex : idx
        await upsertTaskSubtask(taskId, {
          id: sub.id,
          text: sub.text,
          completed: Boolean(sub.completed),
          sort_index: sortIndex,
          updated_at: sub.updatedAt,
        })
      }
      if (item.notes && item.notes.trim().length > 0) {
        await updateTaskNotes(taskId, item.notes)
      }
      if (item.difficulty && item.difficulty !== 'none') {
        await setTaskDifficulty(taskId, item.difficulty)
      }
      if (item.priority) {
        await setTaskPriorityAndResort(taskId, bucketId, false, true)
      }
      if (item.completed) {
        await setTaskCompletedAndResort(taskId, bucketId, true)
        if (item.priority) {
          await setTaskPriorityAndResort(taskId, bucketId, true, true)
        }
      }
    } catch {
      // Ignore individual task migration errors so others can proceed
    }
  }
}

const migrateGuestData = async (): Promise<void> => {
  try {
    const history = readStoredHistory()
    if (history.length > 0) {
      await pushAllHistoryToSupabase()
    }
  } catch {}

  try {
    const routines = readStoredLifeRoutines()
    if (routines.length > 0) {
      await pushLifeRoutinesToSupabase(routines)
    }
  } catch {}

  try {
    const rules = readLocalRepeatingRules().filter((rule) => rule.id !== SAMPLE_SLEEP_ROUTINE_ID)
    if (rules.length > 0) {
      await pushRepeatingRulesToSupabase(rules)
    }
  } catch {}

  try {
    const quickItems = readStoredQuickList()
    if (quickItems.length > 0) {
      await uploadQuickListItems(quickItems)
    }
  } catch {}
}

export const bootstrapGuestDataIfNeeded = async (userId: string | null | undefined): Promise<void> => {
  if (!userId || !supabase) {
    return
  }
  if (bootstrapPromises.has(userId)) {
    await bootstrapPromises.get(userId)
    return
  }
  const task = (async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('bootstrap_completed')
        .eq('id', userId)
        .maybeSingle()
      if (error || data?.bootstrap_completed) {
        return
      }
      await migrateGuestData()
      await supabase.from('profiles').update({ bootstrap_completed: true }).eq('id', userId)
    } catch {
      // Ignore bootstrap errors to avoid blocking login
    }
  })()
  bootstrapPromises.set(userId, task)
  try {
    await task
  } finally {
    bootstrapPromises.delete(userId)
  }
}
