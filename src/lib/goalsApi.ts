import { supabase, ensureSingleUserSession } from './supabaseClient'

export type DbGoal = {
  id: string
  name: string
  color: string
  sort_index: number
  card_surface: string | null
  starred: boolean
}
export type DbBucket = {
  id: string
  user_id: string
  goal_id: string
  name: string
  favorite: boolean
  sort_index: number
  buckets_card_style: string | null
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
}

type TaskSeed = {
  text: string
  completed?: boolean
  difficulty?: DbTask['difficulty']
  priority?: boolean
}

type BucketSeed = {
  name: string
  favorite?: boolean
  surfaceStyle?: string | null
  tasks?: TaskSeed[]
}

export type GoalSeed = {
  name: string
  color?: string | null
  surfaceStyle?: string | null
  starred?: boolean
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
        surfaceStyle?: string | null
        starred?: boolean
        buckets: Array<{
          id: string
          name: string
          favorite: boolean
          surfaceStyle?: string | null
          tasks: Array<{
            id: string
            text: string
            completed: boolean
            difficulty?: 'none' | 'green' | 'yellow' | 'red'
            priority?: boolean
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
    .select('id, name, color, sort_index, card_surface, starred')
    .order('sort_index', { ascending: true })
  if (gErr) return null
  if (!goals || goals.length === 0) return { goals: [] }

  const goalIds = goals.map((g) => g.id)

  // Buckets
  const { data: buckets, error: bErr } = await supabase
    .from('buckets')
    .select('id, user_id, goal_id, name, favorite, sort_index, buckets_card_style')
    .in('goal_id', goalIds)
    .order('sort_index', { ascending: true })
  if (bErr) return null

  const bucketIds = (buckets ?? []).map((b) => b.id)

  // Tasks (order by completed then sort_index so active first)
  const { data: tasks, error: tErr } = bucketIds.length
    ? await supabase
        .from('tasks')
        .select('id, user_id, bucket_id, text, completed, difficulty, priority, sort_index')
        .in('bucket_id', bucketIds)
        .order('completed', { ascending: true })
        .order('priority', { ascending: false })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (tErr) return null

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
      bucket.tasks.push({
        id: t.id,
        text: t.text,
        completed: !!t.completed,
        difficulty: (t.difficulty as any) ?? 'none',
        priority: !!(t as any).priority,
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
      starred: Boolean((g as any).starred),
      surfaceStyle,
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
    .insert([{ user_id: session.user.id, name, color, sort_index, card_surface: surface, starred: false }])
    .select('id, name, color, sort_index, card_surface, starred')
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
    .insert([{ user_id: session.user.id, goal_id: goalId, name, favorite: false, sort_index, buckets_card_style: surface }])
    .select('id, name, favorite, sort_index, buckets_card_style')
    .single()
  if (error) return null
  return data as { id: string; name: string; favorite: boolean; sort_index: number }
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
    .insert([{ user_id: session.user.id, bucket_id: bucketId, text, completed: false, difficulty: 'none', priority: false, sort_index }])
    .select('id, text, completed, difficulty, priority, sort_index')
    .single()
  if (error || !data) {
    throw error ?? new Error('Failed to create task')
  }
  return data as { id: string; text: string; completed: boolean; difficulty: DbTask['difficulty']; priority: boolean; sort_index: number }
}

export async function updateTaskText(taskId: string, text: string) {
  if (!supabase) throw new Error('Supabase client unavailable')
  await ensureSingleUserSession()
  const { error } = await supabase.from('tasks').update({ text }).eq('id', taskId)
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
  if (completed) {
    updates.priority = false
  }

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
