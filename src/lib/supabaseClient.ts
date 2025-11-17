import { createClient, type Session } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase = url && anon ? createClient(url, anon) : null

export async function ensureSingleUserSession(): Promise<Session | null> {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    return data.session ?? null
  } catch (error) {
    console.warn('[supabaseClient] Failed to resolve session', error)
    return null
  }
}
