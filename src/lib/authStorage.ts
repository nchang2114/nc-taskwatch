import type { Session } from '@supabase/supabase-js'
import type { SupportedStorage } from '@supabase/auth-js'

export const AUTH_SESSION_STORAGE_KEY = 'nc-taskwatch-supabase-session-v1'
const AUTH_SESSION_COOKIE = 'nc-taskwatch-supabase-session'
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

const memoryStore = new Map<string, string>()

const getBrowserLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const readCookieValue = (name: string): string | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const cookies = document.cookie ? document.cookie.split(';') : []
  for (const entry of cookies) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.substring(name.length + 1))
    }
  }
  return null
}

const writeCookieValue = (name: string, value: string | null): void => {
  if (typeof document === 'undefined') {
    return
  }
  if (value === null) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
    return
  }
  const encoded = encodeURIComponent(value)
  const secureFlag =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encoded}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secureFlag}`
}

const readRawValue = (key: string): string | null => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      const value = storage.getItem(key)
      if (typeof value === 'string') {
        memoryStore.set(key, value)
        return value
      }
    } catch {}
  }
  const inMemory = memoryStore.get(key)
  if (typeof inMemory === 'string') {
    return inMemory
  }
  if (key === AUTH_SESSION_STORAGE_KEY) {
    const cookieValue = readCookieValue(AUTH_SESSION_COOKIE)
    if (typeof cookieValue === 'string') {
      memoryStore.set(key, cookieValue)
      return cookieValue
    }
  }
  return null
}

const writeRawValue = (key: string, value: string): void => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.setItem(key, value)
    } catch {}
  }
  memoryStore.set(key, value)
  if (key === AUTH_SESSION_STORAGE_KEY) {
    writeCookieValue(AUTH_SESSION_COOKIE, value)
  }
}

const removeRawValue = (key: string): void => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.removeItem(key)
    } catch {}
  }
  memoryStore.delete(key)
  if (key === AUTH_SESSION_STORAGE_KEY) {
    writeCookieValue(AUTH_SESSION_COOKIE, null)
  }
}

export const supabaseAuthStorage: SupportedStorage = {
  getItem: (key: string) => readRawValue(key),
  setItem: (key: string, value: string) => {
    writeRawValue(key, value)
  },
  removeItem: (key: string) => {
    removeRawValue(key)
  },
}

export type CachedSessionTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number | null
}

export const readCachedSupabaseSession = (): Session | null => {
  const raw = readRawValue(AUTH_SESSION_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as Session
    }
  } catch {}
  return null
}

export const readCachedSessionTokens = (): CachedSessionTokens | null => {
  const session = readCachedSupabaseSession()
  if (
    session &&
    typeof session.access_token === 'string' &&
    typeof session.refresh_token === 'string'
  ) {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt:
        typeof session.expires_at === 'number' && Number.isFinite(session.expires_at)
          ? session.expires_at
          : null,
    }
  }
  return null
}

export const clearCachedSupabaseSession = (): void => {
  removeRawValue(AUTH_SESSION_STORAGE_KEY)
}
