import { createClient, type Session } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase = url && anon ? createClient(url, anon) : null

// Strip accidental wrapping quotes from env credentials so Supabase login succeeds.
const normalizeEnvCredential = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

let cachedSession: Session | null = null
let pendingSessionPromise: Promise<Session | null> | null = null
let attemptedSignUp = false
let lastAuthErrorTimestamp = 0

const isSessionValid = (session: Session | null): boolean => {
  if (!session) return false
  if (!session.expires_at) return true
  // Allow 60s of clock drift before considering the session expired.
  return session.expires_at * 1000 > Date.now() + 60_000
}

const resolveSession = async (): Promise<Session | null> => {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    const active = data.session
    if (isSessionValid(active)) {
      cachedSession = active
      return active
    }

    const email = normalizeEnvCredential(import.meta.env.VITE_SINGLE_USER_EMAIL as string | undefined)
    const password = normalizeEnvCredential(import.meta.env.VITE_SINGLE_USER_PASSWORD as string | undefined)
    if (!email || !password) {
      console.warn('[supabaseClient] Missing single-user credentials. Configure VITE_SINGLE_USER_EMAIL and VITE_SINGLE_USER_PASSWORD to enable persistence.')
      cachedSession = null
      return null
    }

    const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError || !signIn?.session) {
      lastAuthErrorTimestamp = Date.now()
      if (signInError) {
        console.warn('[supabaseClient] Supabase sign-in failed:', signInError.message)
      }
      if (!attemptedSignUp) {
        attemptedSignUp = true
        const { data: signUp, error: signUpError } = await supabase.auth.signUp({ email, password })
        if (signUpError) {
          console.warn('[supabaseClient] Supabase sign-up attempt failed:', signUpError.message)
          cachedSession = null
          return null
        }
        if (signUp?.session && isSessionValid(signUp.session)) {
          cachedSession = signUp.session
          return signUp.session
        }
        console.warn(
          '[supabaseClient] Supabase sign-up completed without an active session. Check email confirmation settings for the project.',
        )
      }
      cachedSession = null
      return null
    }

    cachedSession = signIn.session
    return signIn.session
  } catch (error) {
    lastAuthErrorTimestamp = Date.now()
    console.warn('[supabaseClient] Unexpected error while resolving Supabase session:', error)
    cachedSession = null
    return null
  }
}

/**
 * Ensures a session for a single dev user (no UI). Returns the active session
 * or null if credentials are not configured.
 */
export async function ensureSingleUserSession(): Promise<Session | null> {
  if (!supabase) return null
  if (isSessionValid(cachedSession)) {
    return cachedSession
  }
  if (pendingSessionPromise) {
    return pendingSessionPromise
  }
  if (Date.now() - lastAuthErrorTimestamp < 2_000) {
    // Avoid hammering Supabase with repeated failed attempts in quick succession.
    return null
  }
  pendingSessionPromise = resolveSession().finally(() => {
    pendingSessionPromise = null
  })
  try {
    const session = await pendingSessionPromise
    cachedSession = isSessionValid(session) ? session : null
    return cachedSession
  } catch {
    cachedSession = null
    return null
  }
}
