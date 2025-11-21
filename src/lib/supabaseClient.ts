import { createClient, type Session } from '@supabase/supabase-js'
import { AUTH_SESSION_STORAGE_KEY, supabaseAuthStorage } from './authStorage'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase =
  url && anon
    ? createClient(url, anon, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          storageKey: AUTH_SESSION_STORAGE_KEY,
          storage: supabaseAuthStorage,
        },
      })
    : null

export async function ensureSingleUserSession(): Promise<Session | null> {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    return data.session ?? null
  } catch {
    return null
  }
}
