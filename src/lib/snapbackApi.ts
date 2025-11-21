import { supabase, ensureSingleUserSession } from './supabaseClient'

export type DbSnapbackOverview = {
  id: string
  user_id: string
  base_key: string
  trigger_name: string
  cue_text: string
  deconstruction_text: string
  plan_text: string
  sort_index: number
  created_at?: string
  updated_at?: string
}

export async function fetchSnapbackOverviewRows(): Promise<DbSnapbackOverview[]> {
  if (!supabase) return []
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return []
  const { data, error } = await supabase
    .from('snapback_overview')
    .select('id, user_id, base_key, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })
  if (error) {
    return []
  }
  return Array.isArray(data) ? (data as DbSnapbackOverview[]) : []
}

export async function upsertSnapbackOverviewByBaseKey(input: {
  base_key: string
  trigger_name?: string
  cue_text?: string
  deconstruction_text?: string
  plan_text?: string
  sort_index?: number
}): Promise<DbSnapbackOverview | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null
  const payload: any = {
    user_id: session.user.id,
    base_key: input.base_key,
  }
  if (typeof input.trigger_name === 'string') payload.trigger_name = input.trigger_name
  if (typeof input.cue_text === 'string') payload.cue_text = input.cue_text
  if (typeof input.deconstruction_text === 'string') payload.deconstruction_text = input.deconstruction_text
  if (typeof input.plan_text === 'string') payload.plan_text = input.plan_text
  if (typeof input.sort_index === 'number') payload.sort_index = input.sort_index
  const { data, error } = await supabase
    .from('snapback_overview')
    .upsert(payload, { onConflict: 'user_id,base_key' })
    .select('id, user_id, base_key, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
  if (error) {
    return null
  }
  const rows = Array.isArray(data) ? (data as DbSnapbackOverview[]) : []
  return rows[0] ?? null
}

export async function updateSnapbackTriggerNameById(id: string, trigger_name: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return false
  const { error } = await supabase
    .from('snapback_overview')
    .update({ trigger_name })
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  return true
}

export async function upsertSnapbackPlanByBaseKey(base_key: string, plan: {
  cue_text?: string
  deconstruction_text?: string
  plan_text?: string
  trigger_name?: string
}): Promise<DbSnapbackOverview | null> {
  return upsertSnapbackOverviewByBaseKey({ base_key, ...plan })
}

export async function createCustomSnapbackTrigger(trigger_name: string): Promise<DbSnapbackOverview | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null
  // Use a unique base_key to avoid collisions (custom::<uuid>)
  const uniqueKey = `custom:${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2,8)}`)}`
  const payload = {
    user_id: session.user.id,
    base_key: uniqueKey,
    trigger_name,
    cue_text: '',
    deconstruction_text: '',
    plan_text: '',
    sort_index: 0,
  }
  const { data, error } = await supabase
    .from('snapback_overview')
    .insert([payload])
    .select('id, user_id, base_key, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .single()
  if (error) {
    return null
  }
  return data as DbSnapbackOverview
}

export async function deleteSnapbackRowById(id: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return false
  const { error } = await supabase
    .from('snapback_overview')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  return true
}
