import { supabase, ensureSingleUserSession } from './supabaseClient'

export type DbGoal = {
  id: string
  name: string
  color: string
  sort_index: number
  card_surface: string | null
  starred: boolean
  goal_archive?: boolean
}
export type DbBucket = {
  id: string
  user_id: string
  goal_id: string
  name: string
  favorite: boolean
  sort_index: number
  buckets_card_style: string | null
  bucket_archive?: boolean
}
export type DbTask = {
  id: string
  user_id: string
  bucket_id: string
  text: string
  completed: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  priority: boolean
  sort_index: number
  // Notes can be large; avoid fetching by default in list APIs
  notes: string | null
}

export type DbTaskSubtask = {
  id: string
  user_id: string
  task_id: string
  text: string
  completed: boolean
  sort_index: number
}

type TaskSeed = {
  text: string
  completed?: boolean
  difficulty?: DbTask['difficulty']
  priority?: boolean
  notes?: string
}

type BucketSeed = {
  name: string
  favorite?: boolean
  archived?: boolean
  surfaceStyle?: string | null
  tasks?: TaskSeed[]
}

export type GoalSeed = {
  name: string
  color?: string | null
  surfaceStyle?: string | null
  starred?: boolean
  archived?: boolean
  buckets?: BucketSeed[]
}

/** Fetch Goals → Buckets → Tasks for the current session user, ordered for UI. */
export async function fetchGoalsHierarchy(): Promise<
  | null
  | {
      goals: Array<{
        id: string
        name: string
        color: string
        createdAt?: string
        surfaceStyle?: string | null
        starred?: boolean
        archived?: boolean
        buckets: Array<{
          id: string
          name: string
          favorite: boolean
          archived?: boolean
          surfaceStyle?: string | null
          tasks: Array<{
            id: string
            text: string
            completed: boolean
            difficulty?: 'none' | 'green' | 'yellow' | 'red'
            priority?: boolean
            notes?: string | null
            subtasks?: Array<{
              id: string
              text: string
              completed: boolean
              sort_index?: number | null
            }>
          }>
        }>
      }>
    }
> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session) return null

  // Goals
  const { data: goals, error: gErr } = await supabase
    .from('goals')
    .select('id, name, color, sort_index, card_surface, starred, goal_archive, created_at')
    .order('sort_index', { ascending: true })
  if (gErr) return null
  if (!goals || goals.length === 0) return { goals: [] }

  const goalIds = goals.map((g) => g.id)

  // Buckets
  const { data: buckets, error: bErr } = await supabase
    .from('buckets')
    .select('id, user_id, goal_id, name, favorite, sort_index, buckets_card_style, bucket_archive')
    .in('goal_id', goalIds)
    .order('sort_index', { ascending: true })
  if (bErr) return null

  const bucketIds = (buckets ?? []).map((b) => b.id)

  // Tasks (order by completed then sort_index so active first)
  const { data: tasks, error: tErr } = bucketIds.length
    ? await supabase
        .from('tasks')
        // Omit notes here to reduce payload; fetch lazily per-task when needed
        .select('id, user_id, bucket_id, text, completed, difficulty, priority, sort_index')
        .in('bucket_id', bucketIds)
        .order('completed', { ascending: true })
        .order('priority', { ascending: false })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (tErr) {
    console.error('[goalsApi] fetchGoalsHierarchy tasks error', tErr.message ?? tErr, tErr)
    return null
  }

  const taskIds = (tasks ?? []).map((task) => task.id)

  const { data: taskSubtasks, error: sErr } = taskIds.length
    ? await supabase
        .from('task_subtasks')
        .select('id, user_id, task_id, text, completed, sort_index')
        .in('task_id', taskIds)
        .order('task_id', { ascending: true })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (sErr) {
    console.error('[goalsApi] fetchGoalsHierarchy subtasks error', sErr.message ?? sErr, sErr)
    return null
  }

  const subtasksByTaskId = new Map<string, DbTaskSubtask[]>()
  ;(taskSubtasks ?? []).forEach((subtask) => {
    const list = subtasksByTaskId.get(subtask.task_id) ?? []
    list.push(subtask as DbTaskSubtask)
    subtasksByTaskId.set(subtask.task_id, list)
  })

  // Build hierarchy
  const bucketsByGoal = new Map<
    string,
    Array<{ id: string; name: string; favorite: boolean; surfaceStyle?: string | null; tasks: any[] }>
  >()
  const bucketMap = new Map<
    string,
    { id: string; name: string; favorite: boolean; surfaceStyle?: string | null; tasks: any[] }
  >()
  ;(buckets ?? []).forEach((b) => {
    const node = {
      id: b.id,
      name: b.name,
      favorite: b.favorite,
      surfaceStyle: (b as any).buckets_card_style ?? null,
      archived: Boolean((b as any).bucket_archive),
      tasks: [] as any[],
    }
    bucketMap.set(b.id, node)
    const list = bucketsByGoal.get(b.goal_id) ?? []
    list.push(node)
    bucketsByGoal.set(b.goal_id, list)
  })

  ;(tasks ?? []).forEach((t) => {
    const bucket = bucketMap.get(t.bucket_id)
    if (bucket) {
      const subtasks = subtasksByTaskId.get(t.id) ?? []
      bucket.tasks.push({
        id: t.id,
        text: t.text,
        completed: !!t.completed,
        difficulty: (t.difficulty as any) ?? 'none',
        priority: !!(t as any).priority,
        // Notes intentionally omitted in bulk fetch; loaded on demand
        subtasks: subtasks.map((subtask) => ({
          id: subtask.id,
          text: subtask.text ?? '',
          completed: !!subtask.completed,
          sort_index: subtask.sort_index ?? 0,
        })),
      })
    }
  })

  const tree = goals.map((g) => {
    const rawSurface = (g as any).card_surface
    const surfaceStyle = typeof rawSurface === 'string' && rawSurface.length > 0 ? rawSurface : 'glass'
    return {
      id: g.id,
      name: g.name,
      color: g.color,
      createdAt: typeof (g as any).created_at === 'string' ? ((g as any).created_at as string) : undefined,
      starred: Boolean((g as any).starred),
      surfaceStyle,
      archived: Boolean((g as any).goal_archive),
      buckets: (bucketsByGoal.get(g.id) ?? []).map((bucket) => ({
        ...bucket,
        surfaceStyle:
          typeof bucket.surfaceStyle === 'string' && bucket.surfaceStyle.length > 0
            ? bucket.surfaceStyle
            : 'glass',
      })),
    }
  })

  return { goals: tree }
}

/** Fetch notes for a single task lazily to avoid large egress during list loads. */
export async function fetchTaskNotes(taskId: string): Promise<string> {
  if (!supabase) return ''
  await ensureSingleUserSession()
  const { data, error } = await supabase
    .from('tasks')
    .select('notes')
    .eq('id', taskId)
    .maybeSingle()
  if (error) {
    console.warn('[goalsApi] fetchTaskNotes error', error.message ?? error)
    return ''
  }
  const raw = (data as any)?.notes
  return typeof raw === 'string' ? raw : ''
}

// ---------- Helpers: sort index utilities ----------
const STEP = 1024
const mid = (a: number, b: number) => Math.floor((a + b) / 2)

async function nextSortIndex(table: 'goals' | 'buckets' | 'tasks', filters?: Record<string, any>) {
  if (!supabase) return STEP
  let query = supabase.from(table).select('sort_index').order('sort_index', { ascending: false }).limit(1)
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      // Cast to any to allow dynamic column filtering
      query = (query as any).eq(k, v)
    }
  }
  const { data } = await query
  const mx = data && data.length > 0 ? (data[0] as any).sort_index ?? 0 : 0
  return (mx || 0) + STEP
}

// Compute a sort index that will place a new row at the TOP of an ordered list
async function prependSortIndexForTasks(bucketId: string, completed: boolean) {
  if (!supabase) return STEP
  const { data } = await supabase
    .from('tasks')
    .select('sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', completed)
    .order('sort_index', { ascending: true })
    .limit(1)
  const minIdx = data && data.length > 0 ? (data[0] as any).sort_index ?? null : null
  if (minIdx === null || typeof minIdx !== 'number') return STEP
  return minIdx - STEP
}

async function updateTaskWithGuard(
  taskId: string,
  bucketId: string,
  updates: Partial<DbTask>,
  selectColumns?: string,
): Promise<any[]> {
  if (!supabase) {
    throw new Error('Supabase client unavailable')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session')
  }
  let guarded = supabase
    .from('tasks')
    .update(updates)
    .eq('id', taskId)
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
  let data: any[] | null = null
  let error: any = null
  if (selectColumns) {
    const { data: withSelect, error: withSelectError } = await guarded.select(selectColumns)
    data = withSelect as any[] | null
    error = withSelectError
  } else {
    const { error: updateError } = await guarded
    error = updateError
  }
  if (error) {
    throw error
  }
  if (data && Array.isArray(data) && data.length > 0) {
    return data as any[]
  }
  // Fallback path for legacy rows that may not have a user_id populated.
  const fallback = supabase.from('tasks').update(updates).eq('id', taskId).eq('bucket_id', bucketId)
  if (selectColumns) {
    const { data: fallbackData, error: fallbackError } = await fallback.select(selectColumns)
    if (fallbackError) {
      throw fallbackError
    }
    if (!fallbackData || !Array.isArray(fallbackData) || fallbackData.length === 0) {
      throw new Error('Task not found during update')
    }
    return fallbackData as any[]
  }
  const { error: fallbackError } = await fallback
  if (fallbackError) {
    throw fallbackError
  }
  return []
}

// ---------- Goals ----------
export async function createGoal(name: string, color: string, surface: string = 'glass') {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    console.warn('[goalsApi] Unable to create goal without an authenticated session.')
    return null
  }
  const sort_index = await nextSortIndex('goals')
  const { data, error } = await supabase
    .from('goals')
    .insert([{ user_id: session.user.id, name, color, sort_index, card_surface: surface, starred: false, goal_archive: false }])
    .select('id, name, color, sort_index, card_surface, starred, goal_archive')
    .single()
  if (error) return null
  return data as DbGoal
}

export async function setGoalColor(goalId: string, color: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('goals').update({ color }).eq('id', goalId)
}

export async function setGoalSurface(goalId: string, surface: string | null) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('goals').update({ card_surface: surface }).eq('id', goalId)
}

export async function setGoalStarred(goalId: string, starred: boolean) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('goals').update({ starred }).eq('id', goalId)
}

export async function setGoalArchived(goalId: string, archived: boolean) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('goals').update({ goal_archive: archived }).eq('id', goalId)
}

export async function renameGoal(goalId: string, name: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('goals').update({ name }).eq('id', goalId)
}

export async function deleteGoalById(goalId: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  // Collect bucket ids under this goal
  const { data: buckets } = await supabase
    .from('buckets')
    .select('id')
    .eq('goal_id', goalId)
  const bucketIds = (buckets ?? []).map((b: any) => b.id as string)
  if (bucketIds.length > 0) {
    // Delete tasks in those buckets
    await supabase.from('tasks').delete().in('bucket_id', bucketIds)
    // Delete the buckets
    await supabase.from('buckets').delete().in('id', bucketIds)
  }
  // Finally delete the goal
  await supabase.from('goals').delete().eq('id', goalId)
}

export async function setGoalSortIndex(goalId: string, toIndex: number) {
  if (!supabase) return
  await ensureSingleUserSession()
  // Load ordered goals
  const { data: rows } = await supabase.from('goals').select('id, sort_index').order('sort_index', { ascending: true })
  if (!rows || rows.length === 0) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await supabase.from('goals').update({ sort_index: newSort }).eq('id', goalId)
}

// ---------- Buckets ----------
export async function createBucket(goalId: string, name: string, surface: string = 'glass') {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    console.warn('[goalsApi] Unable to create bucket without an authenticated session.')
    return null
  }
  const sort_index = await nextSortIndex('buckets', { goal_id: goalId })
  const { data, error } = await supabase
    .from('buckets')
    .insert([
      {
        user_id: session.user.id,
        goal_id: goalId,
        name,
        favorite: false,
        bucket_archive: false,
        sort_index,
        buckets_card_style: surface,
      },
    ])
    .select('id, name, favorite, bucket_archive, sort_index, buckets_card_style')
    .single()
  if (error) return null
  return data as { id: string; name: string; favorite: boolean; bucket_archive?: boolean; sort_index: number }
}

export async function setBucketSurface(bucketId: string, surface: string | null) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('buckets').update({ buckets_card_style: surface }).eq('id', bucketId)
}

export async function renameBucket(bucketId: string, name: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('buckets').update({ name }).eq('id', bucketId)
}

export async function setBucketFavorite(bucketId: string, favorite: boolean) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('buckets').update({ favorite }).eq('id', bucketId)
}

export async function setBucketArchived(bucketId: string, archived: boolean) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('buckets').update({ bucket_archive: archived }).eq('id', bucketId)
}

export async function deleteBucketById(bucketId: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('buckets').delete().eq('id', bucketId)
}

export async function setBucketSortIndex(goalId: string, bucketId: string, toIndex: number) {
  if (!supabase) return
  await ensureSingleUserSession()
  const { data: rows } = await supabase
    .from('buckets')
    .select('id, sort_index')
    .eq('goal_id', goalId)
    .order('sort_index', { ascending: true })
  if (!rows || rows.length === 0) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await supabase.from('buckets').update({ sort_index: newSort }).eq('id', bucketId)
}

export async function deleteCompletedTasksInBucket(bucketId: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('tasks').delete().eq('bucket_id', bucketId).eq('completed', true)
}

export async function deleteTaskById(taskId: string, bucketId: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('[goalsApi] Missing Supabase session for task deletion')
  }
  await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
}

// ---------- Tasks ----------
export async function createTask(bucketId: string, text: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    console.warn('[goalsApi] Unable to create task without an authenticated session.')
    throw new Error('Missing Supabase session')
  }
  // Insert new active tasks at the END of the non-priority region by default
  const sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed: false })
  const { data, error } = await supabase
    .from('tasks')
    .insert([
      {
        user_id: session.user.id,
        bucket_id: bucketId,
        text,
        completed: false,
        difficulty: 'none',
        priority: false,
        sort_index,
        notes: '',
      },
    ])
    .select('id, text, completed, difficulty, priority, sort_index, notes')
    .single()
  if (error || !data) {
    throw error ?? new Error('Failed to create task')
  }
  return data as {
    id: string
    text: string
    completed: boolean
    difficulty: DbTask['difficulty']
    priority: boolean
    sort_index: number
    notes: string | null
  }
}

export async function updateTaskText(taskId: string, text: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  await ensureSingleUserSession()
  const { error } = await supabase.from('tasks').update({ text }).eq('id', taskId)
  if (error) {
    throw error
  }
}

export async function updateTaskNotes(taskId: string, notes: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  await ensureSingleUserSession()
  const { error } = await supabase.from('tasks').update({ notes }).eq('id', taskId)
  if (error) {
    throw error
  }
}

export async function setTaskDifficulty(taskId: string, difficulty: DbTask['difficulty']) {
  if (!supabase) throw new Error('Supabase client unavailable')
  await ensureSingleUserSession()
  const { error } = await supabase.from('tasks').update({ difficulty }).eq('id', taskId)
  if (error) {
    throw error
  }
}

/** Toggle priority and reassign sort_index to position the task at the top of its section when enabling,
 * or as the first non-priority when disabling. */
export async function setTaskPriorityAndResort(
  taskId: string,
  bucketId: string,
  completed: boolean,
  priority: boolean,
) {
  if (!supabase) throw new Error('Supabase client unavailable')
  if (priority) {
    // Enabling priority: place at the top of its section
    const sort_index = await prependSortIndexForTasks(bucketId, completed)
  await updateTaskWithGuard(taskId, bucketId, { priority: true, sort_index }, 'id')
    return
  }
  // Disabling priority: place at the first non-priority position
  const { data } = await supabase
    .from('tasks')
    .select('sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', completed)
    .eq('priority', false)
    .order('sort_index', { ascending: true })
    .limit(1)
  let sort_index: number
  if (data && data.length > 0) {
    const minIdx = (data[0] as any).sort_index ?? 0
    sort_index = Math.floor(minIdx) - STEP
  } else {
    sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed, priority: false })
  }
  await updateTaskWithGuard(taskId, bucketId, { priority: false, sort_index }, 'id')
}

const parseBooleanish = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 't' || normalized === '1') {
      return true
    }
    if (normalized === 'false' || normalized === 'f' || normalized === '0') {
      return false
    }
  }
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  return null
}

export async function setTaskCompletedAndResort(taskId: string, bucketId: string, completed: boolean) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('[goalsApi] Missing Supabase session for completion toggle')
  }

  const sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed })
  const updates: Partial<DbTask> = { completed, sort_index }

  const completionRows = await updateTaskWithGuard(taskId, bucketId, updates, 'id, completed')
  const persisted = completionRows[0]
  if (!persisted) {
    throw new Error(`[goalsApi] Task ${taskId} not found for completion toggle`)
  }
  const persistedCompleted = parseBooleanish((persisted as any).completed)
  if (persistedCompleted !== completed) {
    const { data: refetch, error } = await supabase
      .from('tasks')
      .select('id, completed')
      .eq('id', taskId)
      .eq('bucket_id', bucketId)
      .maybeSingle()
    if (error) {
      throw error
    }
    const finalCompleted = parseBooleanish(refetch?.completed)
    if (finalCompleted !== completed) {
      throw new Error(
        `[goalsApi] Completion update mismatch for task ${taskId}: expected ${completed} but received ${refetch?.completed}`,
      )
    }
    return refetch
  }
  return persisted
}

export async function setTaskSortIndex(bucketId: string, section: 'active' | 'completed', toIndex: number, taskId: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const { data: rows } = await supabase
    .from('tasks')
    .select('id, sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', section === 'completed')
    .order('sort_index', { ascending: true })
  if (!rows) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await updateTaskWithGuard(taskId, bucketId, { sort_index: newSort }, 'id')
}

/** Move a task to a different bucket while preserving completion/priority and assigning a sensible sort_index.
 * Priority tasks are placed at the top of their new section; non-priority tasks are appended to the end. */
export async function moveTaskToBucket(taskId: string, fromBucketId: string, toBucketId: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('[goalsApi] Missing Supabase session for task move')
  }
  if (fromBucketId === toBucketId) return
  // Fetch current flags to compute section placement
  const { data: taskRow, error } = await supabase
    .from('tasks')
    .select('id, completed, priority')
    .eq('id', taskId)
    .eq('bucket_id', fromBucketId)
    .maybeSingle()
  if (error) throw error
  const completed = Boolean((taskRow as any)?.completed)
  const priority = Boolean((taskRow as any)?.priority)
  // Compute new sort index in destination bucket
  let sort_index: number
  if (priority) {
    sort_index = await prependSortIndexForTasks(toBucketId, completed)
  } else {
    sort_index = await nextSortIndex('tasks', { bucket_id: toBucketId, completed })
  }
  // Guarded update that ensures the row still belongs to the expected source bucket
  await updateTaskWithGuard(taskId, fromBucketId, { bucket_id: toBucketId, sort_index }, 'id, bucket_id, sort_index')
}

export async function upsertTaskSubtask(
  taskId: string,
  subtask: { id: string; text: string; completed: boolean; sort_index: number },
) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('[goalsApi] Missing Supabase session for subtask upsert')
  }
  const payload = {
    id: subtask.id,
    task_id: taskId,
    user_id: session.user.id,
    text: subtask.text,
    completed: subtask.completed,
    sort_index: subtask.sort_index,
  }
  const { error } = await supabase.from('task_subtasks').upsert(payload, { onConflict: 'id' })
  if (error) {
    throw error
  }
}

export async function deleteTaskSubtask(taskId: string, subtaskId: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('[goalsApi] Missing Supabase session for subtask delete')
  }
  const { error } = await supabase
    .from('task_subtasks')
    .delete()
    .eq('id', subtaskId)
    .eq('task_id', taskId)
    .eq('user_id', session.user.id)
  if (error) {
    throw error
  }
}

export async function seedGoalsIfEmpty(seeds: GoalSeed[]): Promise<boolean> {
  if (!supabase) return false
  if (!seeds || seeds.length === 0) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    console.warn('[goalsApi] Cannot seed goals without an authenticated session.')
    return false
  }
  const userId = session.user.id
  try {
    const { data: existing, error: existingError } = await supabase.from('goals').select('id').limit(1)
    if (existingError) {
      console.warn('[goalsApi] Unable to inspect existing goals before seeding:', existingError.message)
      return false
    }
    if (existing && existing.length > 0) {
      return false
    }

    const goalInserts = seeds.map((goal, index) => ({
      user_id: userId,
      name: goal.name,
      color: goal.color ?? 'from-fuchsia-500 to-purple-500',
      sort_index: (index + 1) * STEP,
      card_surface: goal.surfaceStyle ?? 'glass',
      starred: Boolean(goal.starred),
      goal_archive: Boolean(goal.archived),
    }))

    const { data: insertedGoals, error: goalsError } = await supabase
      .from('goals')
      .insert(goalInserts)
      .select('id')
    if (goalsError || !insertedGoals) {
      if (goalsError) {
        console.warn('[goalsApi] Failed to seed goals:', goalsError.message)
      }
      return false
    }

    const goalIdBySeedIndex = insertedGoals.map((row) => row.id as string)

    const bucketInserts: Array<{
      user_id: string
      goal_id: string
      name: string
      favorite: boolean
      bucket_archive: boolean
      sort_index: number
      buckets_card_style: string | null
    }> = []

    seeds.forEach((goal, goalIndex) => {
      const goalId = goalIdBySeedIndex[goalIndex]
      if (!goalId) return
      goal.buckets?.forEach((bucket, bucketIndex) => {
        bucketInserts.push({
          user_id: userId,
          goal_id: goalId,
          name: bucket.name,
          favorite: Boolean(bucket.favorite),
          bucket_archive: Boolean(bucket.archived),
          sort_index: (bucketIndex + 1) * STEP,
          buckets_card_style: bucket.surfaceStyle ?? 'glass',
        })
      })
    })

    const insertedBuckets =
      bucketInserts.length > 0
        ? await supabase
            .from('buckets')
            .insert(bucketInserts)
            .select('id')
        : { data: [] as any[], error: null as any }

    if (insertedBuckets.error) {
      console.warn('[goalsApi] Failed to seed buckets:', insertedBuckets.error.message)
      return false
    }

    const bucketIdByMetaIndex = (insertedBuckets.data ?? []).map((row) => row.id as string)
    let bucketCursor = 0
    const taskInserts: Array<{
      user_id: string
      bucket_id: string
      text: string
      completed: boolean
      difficulty: DbTask['difficulty']
      priority: boolean
      sort_index: number
      notes: string
    }> = []

    seeds.forEach((goal) => {
      goal.buckets?.forEach((bucket) => {
        const bucketId = bucketIdByMetaIndex[bucketCursor]
        bucketCursor += 1
        if (!bucketId) return
        const active = (bucket.tasks ?? []).filter((task) => !task.completed)
        const completed = (bucket.tasks ?? []).filter((task) => !!task.completed)
        const ordered = [...active, ...completed]
        ordered.forEach((task, taskIndex) => {
          taskInserts.push({
            user_id: userId,
            bucket_id: bucketId,
            text: task.text,
            completed: Boolean(task.completed),
            difficulty: task.difficulty ?? 'none',
            priority: Boolean(task.priority),
            sort_index: (taskIndex + 1) * STEP,
            notes: task.notes ?? '',
          })
        })
      })
    })

    if (taskInserts.length > 0) {
      const { error: tasksError } = await supabase.from('tasks').insert(taskInserts)
      if (tasksError) {
        console.warn('[goalsApi] Failed to seed tasks:', tasksError.message)
        return false
      }
    }

    return true
  } catch (error) {
    console.warn('[goalsApi] Unexpected error while seeding defaults:', error)
    return false
  }
}
