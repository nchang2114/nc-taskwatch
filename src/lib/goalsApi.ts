import { supabase, ensureSingleUserSession } from './supabaseClient'

export type DbGoal = { id: string; name: string; color: string; sort_index: number }
export type DbBucket = {
  id: string
  user_id: string
  goal_id: string
  name: string
  favorite: boolean
  sort_index: number
}
export type DbTask = {
  id: string
  user_id: string
  bucket_id: string
  text: string
  completed: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  sort_index: number
}

/** Fetch Goals → Buckets → Tasks for the current session user, ordered for UI. */
export async function fetchGoalsHierarchy(): Promise<
  | null
  | {
      goals: Array<{
        id: string
        name: string
        color: string
        buckets: Array<{
          id: string
          name: string
          favorite: boolean
          tasks: Array<{
            id: string
            text: string
            completed: boolean
            difficulty?: 'none' | 'green' | 'yellow' | 'red'
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
    .select('id, name, color, sort_index')
    .order('sort_index', { ascending: true })
  if (gErr) return null
  if (!goals || goals.length === 0) return { goals: [] }

  const goalIds = goals.map((g) => g.id)

  // Buckets
  const { data: buckets, error: bErr } = await supabase
    .from('buckets')
    .select('id, user_id, goal_id, name, favorite, sort_index')
    .in('goal_id', goalIds)
    .order('sort_index', { ascending: true })
  if (bErr) return null

  const bucketIds = (buckets ?? []).map((b) => b.id)

  // Tasks (order by completed then sort_index so active first)
  const { data: tasks, error: tErr } = bucketIds.length
    ? await supabase
        .from('tasks')
        .select('id, user_id, bucket_id, text, completed, difficulty, sort_index')
        .in('bucket_id', bucketIds)
        .order('completed', { ascending: true })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (tErr) return null

  // Build hierarchy
  const bucketsByGoal = new Map<string, Array<{ id: string; name: string; favorite: boolean; tasks: any[] }>>()
  const bucketMap = new Map<string, { id: string; name: string; favorite: boolean; tasks: any[] }>()
  ;(buckets ?? []).forEach((b) => {
    const node = { id: b.id, name: b.name, favorite: b.favorite, tasks: [] as any[] }
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
      })
    }
  })

  const tree = goals.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    buckets: bucketsByGoal.get(g.id) ?? [],
  }))

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

// ---------- Goals ----------
export async function createGoal(name: string, color: string) {
  if (!supabase) return null
  await ensureSingleUserSession()
  const sort_index = await nextSortIndex('goals')
  const { data, error } = await supabase
    .from('goals')
    .insert([{ name, color, sort_index }])
    .select('id, name, color, sort_index')
    .single()
  if (error) return null
  return data as DbGoal
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
export async function createBucket(goalId: string, name: string) {
  if (!supabase) return null
  await ensureSingleUserSession()
  const sort_index = await nextSortIndex('buckets', { goal_id: goalId })
  const { data, error } = await supabase
    .from('buckets')
    .insert([{ goal_id: goalId, name, favorite: false, sort_index }])
    .select('id, name, favorite, sort_index')
    .single()
  if (error) return null
  return data as { id: string; name: string; favorite: boolean; sort_index: number }
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
  if (!supabase) return null
  await ensureSingleUserSession()
  // Insert new active tasks at the TOP by assigning a sort_index smaller than current minimum
  const sort_index = await prependSortIndexForTasks(bucketId, false)
  const { data, error } = await supabase
    .from('tasks')
    .insert([{ bucket_id: bucketId, text, completed: false, difficulty: 'none', sort_index }])
    .select('id, text, completed, difficulty, sort_index')
    .single()
  if (error) return null
  return data as { id: string; text: string; completed: boolean; difficulty: DbTask['difficulty']; sort_index: number }
}

export async function updateTaskText(taskId: string, text: string) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('tasks').update({ text }).eq('id', taskId)
}

export async function setTaskDifficulty(taskId: string, difficulty: DbTask['difficulty']) {
  if (!supabase) return
  await ensureSingleUserSession()
  await supabase.from('tasks').update({ difficulty }).eq('id', taskId)
}

export async function setTaskCompletedAndResort(taskId: string, bucketId: string, completed: boolean) {
  if (!supabase) return
  await ensureSingleUserSession()
  const sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed })
  await supabase.from('tasks').update({ completed, sort_index }).eq('id', taskId)
}

export async function setTaskSortIndex(bucketId: string, section: 'active' | 'completed', toIndex: number, taskId: string) {
  if (!supabase) return
  await ensureSingleUserSession()
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
  await supabase.from('tasks').update({ sort_index: newSort }).eq('id', taskId)
}
