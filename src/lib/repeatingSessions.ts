import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { HistoryEntry } from './sessionHistory'
import { readStoredHistory, pruneFuturePlannedForRuleAfter, SAMPLE_SLEEP_ROUTINE_ID } from './sessionHistory'
import { readRepeatingExceptions } from './repeatingExceptions'

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
  // Client activation boundary: only render guides for days strictly AFTER this local day start
  // Used to suppress the creation day when creating from an existing entry.
  createdAtMs?: number
  // Server-defined start/end boundaries (mapped from start_date/end_date). Used to bound
  // guide synthesis window. These are interpreted in local time (best-effort) unless
  // explicit timezone handling is added later.
  startAtMs?: number
  endAtMs?: number
}

const LOCAL_RULES_KEY = 'nc-taskwatch-repeating-rules'
const LOCAL_ACTIVATION_MAP_KEY = 'nc-taskwatch-repeating-activation-map'
// We also persist a local end-boundary override to ensure offline correctness.
const LOCAL_END_MAP_KEY = 'nc-taskwatch-repeating-end-map'

const randomRuleId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {}
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const getSampleRepeatingRules = (): RepeatingSessionRule[] => {
  const now = new Date()
  now.setSeconds(0, 0)
  now.setMilliseconds(0)
  const anchor = new Date(now.getTime())
  anchor.setDate(anchor.getDate() - 3)
  anchor.setHours(23, 0, 0, 0)
  const activationStartMs = anchor.getTime()
  const timeOfDayMinutes = 23 * 60
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  return [
    {
      id: SAMPLE_SLEEP_ROUTINE_ID,
      isActive: true,
      frequency: 'daily',
      dayOfWeek: null,
      timeOfDayMinutes,
      durationMinutes: 8 * 60,
      taskName: 'Sleep',
      goalName: 'Daily Life',
      bucketName: 'Sleep',
      timezone,
      createdAtMs: activationStartMs,
      startAtMs: activationStartMs,
      endAtMs: undefined,
    },
  ]
}

export const readLocalRepeatingRules = (): RepeatingSessionRule[] => {
  if (typeof window === 'undefined') return getSampleRepeatingRules()
  try {
    const raw = window.localStorage.getItem(LOCAL_RULES_KEY)
    if (!raw) {
      const sample = getSampleRepeatingRules()
      writeLocalRules(sample)
      return sample
    }
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const mapped = arr
      .map((row) => mapRowToRule(row))
      .filter(Boolean) as RepeatingSessionRule[]
    if (mapped.length === 0) {
      const sample = getSampleRepeatingRules()
      writeLocalRules(sample)
      return sample
    }
    return mapped
  } catch {
    const sample = getSampleRepeatingRules()
    writeLocalRules(sample)
    return sample
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

type EndMap = Record<string, number>
const readEndMap = (): EndMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(LOCAL_END_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? (parsed as EndMap) : {}
  } catch {
    return {}
  }
}
const writeEndMap = (map: EndMap) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_END_MAP_KEY, JSON.stringify(map))
  } catch {}
}

export const pushRepeatingRulesToSupabase = async (
  rules: RepeatingSessionRule[],
): Promise<Record<string, string>> => {
  if (!supabase) return {}
  if (!rules || rules.length === 0) return {}
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return {}
  const idMap: Record<string, string> = {}
  const normalizedRules = rules.map((rule) => {
    if (!rule.id || rule.id === SAMPLE_SLEEP_ROUTINE_ID) {
      const newId = randomRuleId()
      idMap[rule.id ?? SAMPLE_SLEEP_ROUTINE_ID] = newId
      return { ...rule, id: newId }
    }
    return rule
  })
  if (Object.keys(idMap).length > 0) {
    try {
      writeLocalRules(normalizedRules)
    } catch {
      // ignore local write issues
    }
  }
  const payloads = normalizedRules.map((rule) => {
    const startIso =
      typeof rule.startAtMs === 'number'
        ? new Date(rule.startAtMs).toISOString()
        : typeof rule.createdAtMs === 'number'
          ? new Date(rule.createdAtMs).toISOString()
          : new Date().toISOString()
    const endIso = typeof rule.endAtMs === 'number' ? new Date(rule.endAtMs).toISOString() : null
    return {
      id: rule.id,
      user_id: session.user.id,
      is_active: rule.isActive,
      frequency: rule.frequency,
      day_of_week: rule.dayOfWeek,
      time_of_day_minutes: rule.timeOfDayMinutes,
      duration_minutes: rule.durationMinutes,
      task_name: rule.taskName,
      goal_name: rule.goalName,
      bucket_name: rule.bucketName,
      timezone: rule.timezone,
      start_date: startIso,
      end_date: endIso,
      created_at: startIso,
      updated_at: new Date().toISOString(),
    }
  })
  try {
    const { error } = await supabase.from('repeating_sessions').upsert(payloads, { onConflict: 'id' })
    if (error) {
      console.warn('[repeatingSessions] Failed to seed repeating rules:', error)
    }
  } catch (error) {
    console.warn('[repeatingSessions] Unexpected error seeding repeating rules:', error)
  }
  return idMap
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
  // Optional start_date / end_date from DB
  let startAtMs: number | undefined
  let endAtMs: number | undefined
  if (typeof row.startAtMs === 'number' && Number.isFinite(row.startAtMs)) {
    startAtMs = Math.max(0, row.startAtMs)
  } else if (typeof row.start_date === 'string') {
    const t = Date.parse(row.start_date)
    if (Number.isFinite(t)) startAtMs = t
  }
  if (typeof row.endAtMs === 'number' && Number.isFinite(row.endAtMs)) {
    endAtMs = Math.max(0, row.endAtMs)
  } else if (typeof row.end_date === 'string') {
    const t = Date.parse(row.end_date)
    if (Number.isFinite(t)) endAtMs = t
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
    startAtMs,
    endAtMs,
  }
}

export async function fetchRepeatingSessionRules(): Promise<RepeatingSessionRule[]> {
  if (!supabase) return readLocalRepeatingRules()
  const session = await ensureSingleUserSession()
  if (!session) return readLocalRepeatingRules()
  const { data, error } = await supabase
    .from('repeating_sessions')
    .select(
      'id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, start_date, end_date, created_at, updated_at',
    )
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true })
  if (error) {
    console.warn('[repeatingSessions] fetch error', error)
    return readLocalRepeatingRules()
  }
  let remote = (data ?? []).map(mapRowToRule).filter(Boolean) as RepeatingSessionRule[]
  // Merge persisted activation boundaries by rule id (client-side sticky value)
  const act = readActivationMap()
  if (act && typeof act === 'object') {
    remote = remote.map((r) => (act[r.id] ? { ...r, createdAtMs: Math.max(0, Number(act[r.id])) } : r))
  }
  // Merge locally persisted end boundaries
  const endMap = readEndMap()
  if (endMap && typeof endMap === 'object') {
    remote = remote.map((r) => (endMap[r.id] ? { ...r, endAtMs: Math.max(0, Number(endMap[r.id])) } : r))
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
  // Canonicalize series start to the scheduled minute (truncate seconds/ms) so it matches
  // guide occurrence timestamps exactly. This avoids start/end millisecond mismatches later.
  const dayStart = (() => { const d = new Date(entry.startedAt); d.setHours(0,0,0,0); return d.getTime() })()
  const ruleStartMs = dayStart + timeOfDayMinutes * 60000
  // To avoid creating a guide on top of the source entry, start the series at the
  // NEXT occurrence after this entry (next day for daily, next same weekday for weekly).
  const nextStartMs = ruleStartMs + (frequency === 'daily' ? 1 : 7) * 24 * 60 * 60 * 1000

  // Try Supabase; if not available, persist locally
  if (!supabase) {
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
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
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
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
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
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
    start_date: new Date(nextStartMs).toISOString(),
  }
  const { data, error } = await supabase
    .from('repeating_sessions')
    .insert(payload)
    .select('id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, start_date, end_date, created_at')
    .single()
  if (error) {
    console.warn('[repeatingSessions] create error', error)
    // Fallback: store locally so user still sees guides
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
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
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  // Attach activation boundary to the returned rule and persist the mapping by id
  const rule = mapRowToRule(data as any)
  if (rule) {
    const activationMs = Math.max(0, entry.startedAt)
    const merged: RepeatingSessionRule = { ...rule, createdAtMs: activationMs, startAtMs: rule.startAtMs ?? activationMs }
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
    const rules = readLocalRepeatingRules()
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
    const rules = readLocalRepeatingRules()
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

// --- Utilities for date math (local) ---
const DAY_MS = 24 * 60 * 60 * 1000
const toLocalDayStart = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const parseLocalYmd = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map((t) => Number(t))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN
  const dt = new Date(y, (m - 1), d)
  dt.setHours(0, 0, 0, 0)
  return dt.getTime()
}
const formatLocalYmd = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Update the end boundary for a rule by id. Persists locally and remotely when possible.
export async function updateRepeatingRuleEndDate(ruleId: string, endAtMs: number): Promise<boolean> {
  // Persist local end map for offline correctness
  const endMap = readEndMap()
  endMap[ruleId] = Math.max(0, endAtMs)
  writeEndMap(endMap)
  // Also update the cached local rules blob if present
  const local = readLocalRepeatingRules()
  const idx = local.findIndex((r) => r.id === ruleId)
  if (idx >= 0) {
    local[idx] = { ...local[idx], endAtMs: Math.max(0, endAtMs) }
    writeLocalRules(local)
  }
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true // local-only fallback ok
  const { error } = await supabase
    .from('repeating_sessions')
    .update({ end_date: new Date(endAtMs).toISOString() })
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
  if (error) {
    console.warn('[repeatingSessions] update end_date error', error)
    return false
  }
  // After updating, fetch start_date and end_date. If equal, delete the row since nothing repeats.
  const { data: row, error: fetchErr } = await supabase
    .from('repeating_sessions')
    .select('id, start_date, end_date')
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (!fetchErr && row) {
    const s = typeof (row as any).start_date === 'string' ? Date.parse((row as any).start_date) : NaN
    const e = typeof (row as any).end_date === 'string' ? Date.parse((row as any).end_date) : NaN
    if (Number.isFinite(s) && Number.isFinite(e) && s === e) {
      // Clean up local caches first
      const current = readLocalRepeatingRules()
      const filtered = current.filter((r) => r.id !== ruleId)
      if (filtered.length !== current.length) writeLocalRules(filtered)
      const act = readActivationMap()
      if (ruleId in act) { delete act[ruleId]; writeActivationMap(act) }
      const em = readEndMap()
      if (ruleId in em) { delete em[ruleId]; writeEndMap(em) }
      // Delete remotely
      const { error: delErr } = await supabase
        .from('repeating_sessions')
        .delete()
        .eq('id', ruleId)
        .eq('user_id', session.user.id)
      if (delErr) {
        console.warn('[repeatingSessions] delete after equal start/end error', delErr)
      }
    }
  }
  return true
}

// Delete a single repeating rule by id on server; remove from local cache too.
export async function deleteRepeatingRuleById(ruleId: string): Promise<boolean> {
  // Local remove first
  const local = readLocalRepeatingRules()
  const next = local.filter((r) => r.id !== ruleId)
  if (next.length !== local.length) writeLocalRules(next)
  const act = readActivationMap()
  if (ruleId in act) {
    delete act[ruleId]
    writeActivationMap(act)
  }
  const endMap = readEndMap()
  if (ruleId in endMap) {
    delete endMap[ruleId]
    writeEndMap(endMap)
  }
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true
  const { error } = await supabase
    .from('repeating_sessions')
    .delete()
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
  if (error) {
    console.warn('[repeatingSessions] delete by id error', error)
    return false
  }
  return true
}

// Determine whether all occurrences within a rule's bounded window are resolved (confirmed or excepted).
export function isRuleWindowFullyResolved(
  rule: RepeatingSessionRule,
  options: { history: Array<{ routineId?: string | null; occurrenceDate?: string | null }>; exceptions: Array<{ routineId: string; occurrenceDate: string }> },
): boolean {
  // Require an end boundary to consider retirement
  if (!Number.isFinite(rule.endAtMs as number)) return false
  const endDay = toLocalDayStart(rule.endAtMs as number)
  // Window start: prefer explicit startAtMs; else use createdAtMs but skip activation day
  let startDay = Number.isFinite(rule.startAtMs as number) ? toLocalDayStart(rule.startAtMs as number) : undefined
  if (startDay === undefined || !Number.isFinite(startDay)) {
    if (Number.isFinite(rule.createdAtMs as number)) {
      startDay = toLocalDayStart(rule.createdAtMs as number) + DAY_MS // skip activation day
    }
  }
  if (!Number.isFinite(startDay as number)) return false
  const start = startDay as number
  const confirmed = new Set<string>()
  options.history.forEach((h) => {
    if (h.routineId && h.occurrenceDate) confirmed.add(`${h.routineId}:${h.occurrenceDate}`)
  })
  const excepted = new Set<string>()
  options.exceptions.forEach((e) => excepted.add(`${e.routineId}:${e.occurrenceDate}`))

  const makeKey = (ruleId: string, dayMs: number) => {
    const d = new Date(dayMs)
    const y = d.getFullYear()
    const m = (d.getMonth() + 1).toString().padStart(2, '0')
    const dd = d.getDate().toString().padStart(2, '0')
    return `${ruleId}:${y}-${m}-${dd}`
  }

  if (rule.frequency === 'daily') {
    for (let day = start; day <= endDay; day += DAY_MS) {
      const key = makeKey(rule.id, day)
      if (!confirmed.has(key) && !excepted.has(key)) return false
    }
    return true
  }
  // weekly
  const firstDow = new Date(start).getDay()
  const targetDow = Number.isFinite(rule.dayOfWeek as number) ? (rule.dayOfWeek as number) : firstDow
  // advance from start to the first target dow
  let day = start
  while (new Date(day).getDay() !== targetDow && day <= endDay) {
    day += DAY_MS
  }
  for (; day <= endDay; day += 7 * DAY_MS) {
    const key = makeKey(rule.id, day)
    if (!confirmed.has(key) && !excepted.has(key)) return false
  }
  return true
}

// Set repeat to none for all future occurrences after the selected occurrence date (YYYY-MM-DD, local).
// This updates the rule's end boundary to the day BEFORE the selected occurrence and cleans up planned entries.
export async function setRepeatToNoneAfterOccurrence(
  ruleId: string,
  occurrenceDateYmd: string,
  prunePlanned: (ruleId: string, afterYmd: string) => Promise<void> | void,
): Promise<boolean> {
  const occStart = parseLocalYmd(occurrenceDateYmd)
  if (!Number.isFinite(occStart)) return false
  // Per requirement: set end_date to the SELECTED entry's start time (timestampz). Using local day start
  // would be imprecise for DST; here we persist the exact start timestamp boundary expected by the UI.
  const ok = await updateRepeatingRuleEndDate(ruleId, occStart)
  try {
    await prunePlanned(ruleId, occurrenceDateYmd)
  } catch {}
  return ok
}

// Convenience wrapper that uses the built-in planned-entry pruner
export async function setRepeatToNoneAfterOccurrenceDefault(ruleId: string, occurrenceDateYmd: string): Promise<boolean> {
  return await setRepeatToNoneAfterOccurrence(ruleId, occurrenceDateYmd, pruneFuturePlannedForRuleAfter)
}

// Variant that uses a precise selected startedAt timestamp (ms). end_date is set to this timestamp,
// and planned entries after the selected LOCAL day are pruned.
export async function setRepeatToNoneAfterTimestamp(ruleId: string, selectedStartMs: number): Promise<boolean> {
  const ymd = formatLocalYmd(selectedStartMs)
  const ok = await updateRepeatingRuleEndDate(ruleId, Math.max(0, selectedStartMs))
  try {
    await pruneFuturePlannedForRuleAfter(ruleId, ymd)
  } catch {}
  return ok
}

// Evaluate a single rule by id and delete it if it has an end boundary and all occurrences in the
// bounded window are resolved (confirmed/skipped/rescheduled). Returns true if deleted.
export async function evaluateAndMaybeRetireRule(ruleId: string): Promise<boolean> {
  const rules = await fetchRepeatingSessionRules()
  const rule = rules.find((r) => r.id === ruleId)
  if (!rule) return false
  if (!Number.isFinite(rule.endAtMs as number)) return false
  const history = readStoredHistory()
  const exceptions = readRepeatingExceptions()
  const resolved = isRuleWindowFullyResolved(rule, {
    history: history.map((h) => ({ routineId: (h as any).routineId ?? null, occurrenceDate: (h as any).occurrenceDate ?? null })),
    exceptions: exceptions.map((e) => ({ routineId: e.routineId, occurrenceDate: e.occurrenceDate })),
  })
  if (!resolved) return false
  return await deleteRepeatingRuleById(ruleId)
}
