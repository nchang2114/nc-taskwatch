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
  if (!remote) {
    throw new Error('Quick List remote structures unavailable')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for Quick List migration')
  }
  const { bucketId } = remote
  // Start from a clean slate so we don't duplicate default content
  const { error: deleteError } = await supabase
    .from('tasks')
    .delete()
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
  if (deleteError) {
    throw deleteError
  }

  const ordered = [
    ...items.filter((item) => !item.completed).sort(sortByIndex),
    ...items.filter((item) => item.completed).sort(sortByIndex),
  ]
  for (const item of ordered) {
    const baseText = item.text?.trim().length ? item.text.trim() : 'Quick task'
    const created = await createTask(bucketId, baseText)
    const taskId = created?.id
    if (!taskId) {
      throw new Error('Failed to create Quick List task during migration')
    }
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
  }
}

const migrateGuestData = async (): Promise<void> => {
  const rules = readLocalRepeatingRules().filter((rule) => rule.id !== SAMPLE_SLEEP_ROUTINE_ID)
  const ruleIdMap =
    rules.length > 0 ? await pushRepeatingRulesToSupabase(rules, { strict: true }) : ({} as Record<string, string>)

  const history = readStoredHistory()
  if (history.length > 0) {
    await pushAllHistoryToSupabase(ruleIdMap, undefined, { skipRemoteCheck: true, strict: true })
  }

  const routines = readStoredLifeRoutines()
  if (routines.length > 0) {
    await pushLifeRoutinesToSupabase(routines, { strict: true })
  }

  const quickItems = readStoredQuickList()
  if (quickItems.length > 0) {
    await uploadQuickListItems(quickItems)
  }
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
    const { data, error } = await supabase
      .from('profiles')
      .select('bootstrap_completed')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    if (data?.bootstrap_completed) {
      return
    }
    await migrateGuestData()
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ bootstrap_completed: true })
      .eq('id', userId)
    if (updateError) {
      throw updateError
    }
  })()
  bootstrapPromises.set(userId, task)
  try {
    await task
  } finally {
    bootstrapPromises.delete(userId)
  }
}
