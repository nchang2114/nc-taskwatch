import { createClient, type Session } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase = url && anon ? createClient(url, anon) : null

/**
 * Ensures a session for a single dev user (no UI). Returns the active session
 * or null if credentials are not configured.
 */
export async function ensureSingleUserSession(): Promise<Session | null> {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    if (data.session) return data.session
    const email = import.meta.env.VITE_SINGLE_USER_EMAIL as string | undefined
    const password = import.meta.env.VITE_SINGLE_USER_PASSWORD as string | undefined
    if (!email || !password) return null
    const { data: signIn } = await supabase.auth.signInWithPassword({ email, password })
    return signIn.session ?? null
  } catch {
    return null
  }
}

