import { seedGoalsIfEmpty, type GoalSeed } from './goalsApi'
import { readStoredGoalsSnapshot, type GoalSnapshot } from './goalsSync'
import { readStoredQuickList, type QuickItem } from './quickList'
import { ensureQuickListRemoteStructures, generateUuid, QUICK_LIST_GOAL_NAME } from './quickListRemote'
import { readStoredLifeRoutines, pushLifeRoutinesToSupabase, getDefaultLifeRoutines } from './lifeRoutines'
import { pushAllHistoryToSupabase, hasRemoteHistory } from './sessionHistory'
import { readLocalRepeatingRules, pushRepeatingRulesToSupabase } from './repeatingSessions'
import { supabase, ensureSingleUserSession } from './supabaseClient'
import { DEMO_GOAL_SEEDS } from './demoGoals'
import { DEFAULT_SURFACE_STYLE } from './surfaceStyles'

const BOOTSTRAP_STATE_PREFIX = 'nc-taskwatch-bootstrap-v1'
const QUICK_LIST_SORT_STEP = 1024
export const ACCOUNT_BOOTSTRAP_EVENT = 'nc-taskwatch:account-bootstrap'

const dispatchBootstrapEvent = (detail: { status: 'complete' | 'error'; userId?: string }): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.dispatchEvent(new CustomEvent(ACCOUNT_BOOTSTRAP_EVENT, { detail }))
  } catch {
    // Swallow event dispatch failures (older browsers)
  }
}

const buildBootstrapKey = (userId: string): string => `${BOOTSTRAP_STATE_PREFIX}:${userId}`

const readBootstrapState = (userId: string): string | null => {
  if (typeof window === 'undefined') return 'complete'
  try {
    return window.localStorage.getItem(buildBootstrapKey(userId))
  } catch {
    return null
  }
}

const writeBootstrapState = (userId: string, state: string): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(buildBootstrapKey(userId), state)
  } catch {
    // ignore storage failures — bootstrap can run again if needed
  }
}

const convertSnapshotToSeeds = (snapshot: GoalSnapshot[]): GoalSeed[] =>
  snapshot.map((goal) => ({
    name: goal.name,
    color: goal.color ?? null,
    surfaceStyle: goal.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
    starred: Boolean(goal.starred),
    archived: Boolean(goal.archived),
    buckets: goal.buckets.map((bucket) => ({
      name: bucket.name,
      favorite: bucket.favorite,
      archived: bucket.archived,
      surfaceStyle: bucket.surfaceStyle ?? DEFAULT_SURFACE_STYLE,
      tasks: bucket.tasks.map((task) => ({
        text: task.text,
        completed: task.completed,
        difficulty: task.difficulty ?? 'none',
        priority: Boolean(task.priority),
        notes: typeof task.notes === 'string' ? task.notes : '',
      })),
    })),
  }))

const userHasRemoteGoals = async (userId: string): Promise<boolean> => {
  if (!supabase) return true
  try {
    const { count, error } = await supabase
      .from('goals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .neq('name', QUICK_LIST_GOAL_NAME)
    if (error) {
      console.warn('[accountBootstrap] Unable to inspect existing goals:', error)
      return true
    }
    console.info('[accountBootstrap] Remote goal count', count)
    return typeof count === 'number' && count > 0
  } catch (error) {
    console.warn('[accountBootstrap] Failed to inspect existing goals:', error)
    return true
  }
}

const pushQuickListToSupabase = async (items: QuickItem[]): Promise<void> => {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session) return
  const ensured = await ensureQuickListRemoteStructures()
  if (!ensured?.bucketId) {
    console.warn('[accountBootstrap] Unable to resolve Quick List bucket for bootstrap.')
    return
  }
  const bucketId = ensured.bucketId
  try {
    const { data: existingTasks, error: tasksError } = await supabase
      .from('tasks')
      .select('id')
      .eq('bucket_id', bucketId)
    if (tasksError) {
      console.warn('[accountBootstrap] Unable to inspect Quick List tasks before bootstrap:', tasksError)
      return
    }
    const existingIds = (existingTasks ?? []).map((row) => row.id).filter((id): id is string => typeof id === 'string')
    if (existingIds.length > 0) {
      await supabase.from('task_subtasks').delete().in('task_id', existingIds)
      await supabase.from('tasks').delete().in('id', existingIds)
    }
    if (items.length === 0) {
      console.info('[accountBootstrap] Quick List snapshot empty; skipping push.')
      return
    }
    const nowIso = new Date().toISOString()
    const taskPayloads = items.map((item, index) => {
      const id = generateUuid()
      return {
        id,
        user_id: session.user.id,
        bucket_id: bucketId,
        text: item.text,
        completed: Boolean(item.completed),
        difficulty: item.difficulty ?? 'none',
        priority: Boolean(item.priority),
        sort_index: (index + 1) * QUICK_LIST_SORT_STEP,
        notes: item.notes ?? '',
        created_at: nowIso,
        updated_at: item.updatedAt ?? nowIso,
      }
    })
    const { error: insertError } = await supabase.from('tasks').insert(taskPayloads)
    if (insertError) {
      console.warn('[accountBootstrap] Failed to seed Quick List tasks:', insertError)
      return
    }
    const subtaskPayloads: Array<Record<string, unknown>> = []
    items.forEach((item, itemIndex) => {
      if (!Array.isArray(item.subtasks) || item.subtasks.length === 0) {
        return
      }
      const taskId = taskPayloads[itemIndex].id
      item.subtasks.forEach((subtask, subIndex) => {
        subtaskPayloads.push({
          id: generateUuid(),
          user_id: session.user.id,
          task_id: taskId,
          text: subtask.text,
          completed: Boolean(subtask.completed),
          sort_index: subIndex,
          created_at: nowIso,
          updated_at: subtask.updatedAt ?? nowIso,
        })
      })
    })
    if (subtaskPayloads.length > 0) {
      const { error: subtaskError } = await supabase.from('task_subtasks').insert(subtaskPayloads)
      if (subtaskError) {
        console.warn('[accountBootstrap] Failed to seed Quick List subtasks:', subtaskError)
      }
    }
  } catch (error) {
    console.warn('[accountBootstrap] Unexpected error while seeding Quick List items:', error)
  }
}

const runBootstrapForUser = async (): Promise<void> => {
  const snapshot = readStoredGoalsSnapshot()
  const seeds = snapshot.length > 0 ? convertSnapshotToSeeds(snapshot) : DEMO_GOAL_SEEDS
  console.info('[accountBootstrap] Prepared goal seeds', {
    snapshotCount: snapshot.length,
    seedGoalCount: seeds.length,
    names: seeds.map((seed) => seed.name),
  })
  try {
    await seedGoalsIfEmpty(seeds)
    console.info('[accountBootstrap] Goal seed push complete.')
  } catch (error) {
    console.warn('[accountBootstrap] Failed to seed goals for new account:', error)
  }

  try {
    const quickItems = readStoredQuickList()
    console.info('[accountBootstrap] Seeding Quick List items', { count: quickItems.length })
    await pushQuickListToSupabase(quickItems)
    console.info('[accountBootstrap] Quick List seed push complete')
  } catch (error) {
    console.warn('[accountBootstrap] Failed to seed Quick List for new account:', error)
  }

  try {
    let routines = readStoredLifeRoutines()
    if (!Array.isArray(routines) || routines.length === 0) {
      routines = getDefaultLifeRoutines()
    }
    console.info('[accountBootstrap] Seeding life routines', { count: routines.length })
    await pushLifeRoutinesToSupabase(routines)
    console.info('[accountBootstrap] Life routines seed push complete')
  } catch (error) {
    console.warn('[accountBootstrap] Failed to seed life routines for new account:', error)
  }

  try {
    const remoteHistoryExists = await hasRemoteHistory()
    if (remoteHistoryExists) {
      console.info('[accountBootstrap] Remote session history already present; skipping seed.')
    } else {
      console.info('[accountBootstrap] Seeding session history')
      await pushAllHistoryToSupabase()
      console.info('[accountBootstrap] Session history seed push complete')
    }
  } catch (error) {
    console.warn('[accountBootstrap] Failed to seed session history for new account:', error)
  }

  try {
    const localRules = readLocalRepeatingRules()
    console.info('[accountBootstrap] Seeding repeating rules', { count: localRules.length })
    await pushRepeatingRulesToSupabase(localRules)
    console.info('[accountBootstrap] Repeating rules seed push complete')
  } catch (error) {
    console.warn('[accountBootstrap] Failed to seed repeating rules for new account:', error)
  }
}

let bootstrapPromise: Promise<void> | null = null

export const ensureInitialAccountBootstrap = async (): Promise<void> => {
  if (!supabase) return
  if (bootstrapPromise) {
    return bootstrapPromise
  }
  bootstrapPromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session?.user?.id) {
      console.info('[accountBootstrap] No session available; skipping bootstrap.')
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const userId = session.user.id
    console.info('[accountBootstrap] Evaluating bootstrap for user', userId)
    const state = readBootstrapState(userId)
    if (state === 'complete') {
      console.info('[accountBootstrap] Bootstrap already completed for user', userId)
      dispatchBootstrapEvent({ status: 'complete', userId })
      return
    }
    if (await userHasRemoteGoals(userId)) {
      writeBootstrapState(userId, 'complete')
       console.info('[accountBootstrap] Remote goals already exist; marking bootstrap complete.')
      dispatchBootstrapEvent({ status: 'complete', userId })
      return
    }
    writeBootstrapState(userId, 'pending')
    try {
      await runBootstrapForUser()
      writeBootstrapState(userId, 'complete')
      dispatchBootstrapEvent({ status: 'complete', userId })
    } catch (error) {
      console.warn('[accountBootstrap] Failed to bootstrap new account data:', error)
      writeBootstrapState(userId, 'error')
      dispatchBootstrapEvent({ status: 'error', userId })
    }
  })()
  try {
    await bootstrapPromise
  } finally {
    bootstrapPromise = null
  }
}
