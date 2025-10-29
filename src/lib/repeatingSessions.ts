import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { HistoryEntry } from './sessionHistory'

export type RepeatingSessionRule = {
  id: string
  isActive: boolean
  frequency: 'daily' | 'weekly'
  // 0=Sun .. 6=Sat (required for weekly)
  dayOfWeek: number | null
  // Minutes from midnight 0..1439
  timeOfDayMinutes: number
  // Default to 60 if not provided
  durationMinutes: number
  // Optional labeling/context
  taskName: string
  goalName: string | null
  bucketName: string | null
  timezone: string | null
  // Activation boundary: only render guides for days on/after this local day start
  // If absent, we’ll fall back to DB created_at (if available) or assume active now
  createdAtMs?: number
}

const LOCAL_RULES_KEY = 'nc-taskwatch-repeating-rules'
const LOCAL_ACTIVATION_MAP_KEY = 'nc-taskwatch-repeating-activation-map'

const readLocalRules = (): RepeatingSessionRule[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(LOCAL_RULES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .map((row) => mapRowToRule(row))
      .filter(Boolean) as RepeatingSessionRule[]
  } catch {
    return []
  }
}

const writeLocalRules = (rules: RepeatingSessionRule[]) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_RULES_KEY, JSON.stringify(rules))
  } catch {}
}

type ActivationMap = Record<string, number>
const readActivationMap = (): ActivationMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(LOCAL_ACTIVATION_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as ActivationMap : {}
  } catch {
    return {}
  }
}
const writeActivationMap = (map: ActivationMap) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_ACTIVATION_MAP_KEY, JSON.stringify(map))
  } catch {}
}

const mapRowToRule = (row: any): RepeatingSessionRule | null => {
  if (!row) return null
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) return null
  const frequency = row.frequency === 'daily' || row.frequency === 'weekly' ? row.frequency : 'daily'
  // Accept both snake_case (DB) and camelCase (local fallback) shapes
  const dayOfWeek = typeof row.day_of_week === 'number' ? row.day_of_week : (typeof row.dayOfWeek === 'number' ? row.dayOfWeek : null)
  const timeOfDayMinutes = Number.isFinite(row.time_of_day_minutes)
    ? Number(row.time_of_day_minutes)
    : (Number.isFinite(row.timeOfDayMinutes) ? Number(row.timeOfDayMinutes) : 0)
  const durationMinutes = Number.isFinite(row.duration_minutes)
    ? Math.max(1, Number(row.duration_minutes))
    : (Number.isFinite(row.durationMinutes) ? Math.max(1, Number(row.durationMinutes)) : 60)
  const isActive = typeof row.is_active === 'boolean' ? row.is_active : (row.isActive !== false)
  const taskName = typeof row.task_name === 'string' ? row.task_name : (typeof row.taskName === 'string' ? row.taskName : '')
  const goalName = typeof row.goal_name === 'string' ? row.goal_name : (typeof row.goalName === 'string' ? row.goalName : null)
  const bucketName = typeof row.bucket_name === 'string' ? row.bucket_name : (typeof row.bucketName === 'string' ? row.bucketName : null)
  const timezone = typeof row.timezone === 'string' ? row.timezone : (typeof row.timeZone === 'string' ? row.timeZone : null)
  // DB created_at is ISO string; local fallback may store createdAtMs
  let createdAtMs: number | undefined
  if (typeof row.createdAtMs === 'number' && Number.isFinite(row.createdAtMs)) {
    createdAtMs = Math.max(0, row.createdAtMs)
  } else if (typeof row.created_at === 'string') {
    const t = Date.parse(row.created_at)
    if (Number.isFinite(t)) {
      createdAtMs = t
    }
  }
  return {
    id,
    isActive,
    frequency,
    dayOfWeek,
    timeOfDayMinutes,
    durationMinutes,
    taskName,
    goalName,
    bucketName,
    timezone,
    createdAtMs,
  }
}

export async function fetchRepeatingSessionRules(): Promise<RepeatingSessionRule[]> {
  if (!supabase) return readLocalRules()
  const session = await ensureSingleUserSession()
  if (!session) return readLocalRules()
  const { data, error } = await supabase
    .from('repeating_sessions')
    .select(
      'id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, created_at, updated_at',
    )
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true })
  if (error) {
    console.warn('[repeatingSessions] fetch error', error)
    return readLocalRules()
  }
  let remote = (data ?? []).map(mapRowToRule).filter(Boolean) as RepeatingSessionRule[]
  // Merge persisted activation boundaries by rule id (client-side sticky value)
  const act = readActivationMap()
  if (act && typeof act === 'object') {
    remote = remote.map((r) => (act[r.id] ? { ...r, createdAtMs: Math.max(0, Number(act[r.id])) } : r))
  }
  return remote
}

export async function createRepeatingRuleForEntry(
  entry: HistoryEntry,
  frequency: 'daily' | 'weekly',
): Promise<RepeatingSessionRule | null> {
  const startLocal = new Date(entry.startedAt)
  const hours = startLocal.getHours()
  const minutes = startLocal.getMinutes()
  const timeOfDayMinutes = hours * 60 + minutes
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const dayOfWeek = frequency === 'weekly' ? startLocal.getDay() : null
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null

  // Try Supabase; if not available, persist locally
  if (!supabase) {
    const localRule: RepeatingSessionRule = {
      id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `local-${Date.now()}`) as string,
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: entry.taskName ?? '',
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
  createdAtMs: Math.max(0, entry.startedAt),
    }
    const current = readLocalRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    const localRule: RepeatingSessionRule = {
      id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `local-${Date.now()}`) as string,
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: entry.taskName ?? '',
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
  createdAtMs: Math.max(0, entry.startedAt),
    }
    const current = readLocalRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  const payload = {
    user_id: session.user.id,
    is_active: true,
    frequency,
    day_of_week: dayOfWeek,
    time_of_day_minutes: timeOfDayMinutes,
    duration_minutes: durationMinutes,
    task_name: entry.taskName ?? '',
    goal_name: entry.goalName,
    bucket_name: entry.bucketName,
    timezone: tz,
  }
  const { data, error } = await supabase
    .from('repeating_sessions')
    .insert(payload)
    .select('id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, created_at')
    .single()
  if (error) {
    console.warn('[repeatingSessions] create error', error)
    // Fallback: store locally so user still sees guides
    const localRule: RepeatingSessionRule = {
      id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `local-${Date.now()}`) as string,
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: entry.taskName ?? '',
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
  createdAtMs: Math.max(0, entry.startedAt),
    }
    const current = readLocalRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  // Attach activation boundary to the returned rule and persist the mapping by id
  const rule = mapRowToRule(data as any)
  if (rule) {
    const activationMs = Math.max(0, entry.startedAt)
    const merged: RepeatingSessionRule = { ...rule, createdAtMs: activationMs }
    const act = readActivationMap()
    act[merged.id] = activationMs
    writeActivationMap(act)
    return merged
  }
  return rule
}

export async function deactivateRepeatingRule(id: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session) return false
  const { error } = await supabase
    .from('repeating_sessions')
    .update({ is_active: false })
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (error) {
    console.warn('[repeatingSessions] deactivate error', error)
    return false
  }
  return true
}

// Deactivate all rules that match the given entry's labeling, time of day, duration,
// and (for weekly) the same day-of-week. Returns the list of rule ids deactivated.
export async function deactivateMatchingRulesForEntry(entry: HistoryEntry): Promise<string[]> {
  const startLocal = new Date(entry.startedAt)
  const minutes = startLocal.getHours() * 60 + startLocal.getMinutes()
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const dow = startLocal.getDay()
  const task = entry.taskName ?? ''
  const goal = entry.goalName ?? null
  const bucket = entry.bucketName ?? null

  // Local fallback path: mark matching rules inactive and persist
  const deactivateLocal = (): string[] => {
    const rules = readLocalRules()
    const ids: string[] = []
    const next = rules.map((r) => {
      const labelMatch = (r.taskName ?? '') === task && (r.goalName ?? null) === goal && (r.bucketName ?? null) === bucket
      const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durationMinutes
      const freqMatch = r.frequency === 'daily' || (r.frequency === 'weekly' && r.dayOfWeek === dow)
      if (r.isActive && labelMatch && timeMatch && freqMatch) {
        ids.push(r.id)
        return { ...r, isActive: false }
      }
      return r
    })
    writeLocalRules(next)
    return ids
  }

  if (!supabase) {
    return deactivateLocal()
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return deactivateLocal()
  }

  const ids: string[] = []
  // Daily
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('repeating_sessions')
    .update({ is_active: false })
    .eq('user_id', session.user.id)
    .eq('frequency', 'daily')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (dailyErr) {
    console.warn('[repeatingSessions] deactivate daily match error', dailyErr)
  } else if (Array.isArray(dailyRows)) {
    ids.push(...dailyRows.map((r: any) => String(r.id)))
  }

  // Weekly (same dow)
  const { data: weeklyRows, error: weeklyErr } = await supabase
    .from('repeating_sessions')
    .update({ is_active: false })
    .eq('user_id', session.user.id)
    .eq('frequency', 'weekly')
    .eq('day_of_week', dow)
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (weeklyErr) {
    console.warn('[repeatingSessions] deactivate weekly match error', weeklyErr)
  } else if (Array.isArray(weeklyRows)) {
    ids.push(...weeklyRows.map((r: any) => String(r.id)))
  }

  return ids
}

// Delete all rules that match the given entry (label/time/duration and weekly dow when applicable).
// Returns the list of deleted rule ids. Local fallback removes from local cache.
export async function deleteMatchingRulesForEntry(entry: HistoryEntry): Promise<string[]> {
  const startLocal = new Date(entry.startedAt)
  const minutes = startLocal.getHours() * 60 + startLocal.getMinutes()
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const dow = startLocal.getDay()
  const task = entry.taskName ?? ''
  const goal = entry.goalName ?? null
  const bucket = entry.bucketName ?? null

  const deleteLocal = (): string[] => {
    const rules = readLocalRules()
    const ids: string[] = []
    const next = rules.filter((r) => {
      const labelMatch = (r.taskName ?? '') === task && (r.goalName ?? null) === goal && (r.bucketName ?? null) === bucket
      const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durationMinutes
      const freqMatch = r.frequency === 'daily' || (r.frequency === 'weekly' && r.dayOfWeek === dow)
      const match = labelMatch && timeMatch && freqMatch
      if (match) ids.push(r.id)
      return !match
    })
    writeLocalRules(next)
    return ids
  }

  if (!supabase) {
    return deleteLocal()
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return deleteLocal()
  }

  const ids: string[] = []
  // Daily
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('repeating_sessions')
    .delete()
    .eq('user_id', session.user.id)
    .eq('frequency', 'daily')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (dailyErr) {
    console.warn('[repeatingSessions] delete daily match error', dailyErr)
  } else if (Array.isArray(dailyRows)) {
    ids.push(...dailyRows.map((r: any) => String(r.id)))
  }

  // Weekly (same dow)
  const { data: weeklyRows, error: weeklyErr } = await supabase
    .from('repeating_sessions')
    .delete()
    .eq('user_id', session.user.id)
    .eq('frequency', 'weekly')
    .eq('day_of_week', dow)
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (weeklyErr) {
    console.warn('[repeatingSessions] delete weekly match error', weeklyErr)
  } else if (Array.isArray(weeklyRows)) {
    ids.push(...weeklyRows.map((r: any) => String(r.id)))
  }

  return ids
}
