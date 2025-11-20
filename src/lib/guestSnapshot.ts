import { GOALS_SNAPSHOT_STORAGE_KEY } from './goalsSync'
import { QUICK_LIST_STORAGE_KEY } from './quickList'
import { LIFE_ROUTINE_STORAGE_KEY } from './lifeRoutines'
import { HISTORY_STORAGE_KEY } from './sessionHistory'
import {
  REPEATING_RULES_STORAGE_KEY,
  REPEATING_RULES_ACTIVATION_KEY,
  REPEATING_RULES_END_KEY,
} from './repeatingSessions'

const SNAPSHOT_CACHE_KEY = 'nc-taskwatch-guest-bootstrap-cache'

const SNAPSHOT_KEYS = [
  GOALS_SNAPSHOT_STORAGE_KEY,
  QUICK_LIST_STORAGE_KEY,
  LIFE_ROUTINE_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  REPEATING_RULES_STORAGE_KEY,
  REPEATING_RULES_ACTIVATION_KEY,
  REPEATING_RULES_END_KEY,
]

const canUseStorage = (): { local: Storage; session: Storage } | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const local = window.localStorage
  const session = window.sessionStorage
  if (!local || !session) {
    return null
  }
  return { local, session }
}

export const cacheGuestSnapshotForBootstrap = (): void => {
  const stores = canUseStorage()
  if (!stores) return
  const payload: Record<string, string> = {}
  SNAPSHOT_KEYS.forEach((key) => {
    try {
      const value = stores.local.getItem(key)
      if (value !== null) {
        payload[key] = value
      }
    } catch {
      // ignore read errors
    }
  })
  if (Object.keys(payload).length === 0) {
    return
  }
  try {
    stores.session.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore write errors (e.g., quota)
  }
}

export const restoreGuestSnapshotFromCache = (): void => {
  const stores = canUseStorage()
  if (!stores) return
  const raw = stores.session.getItem(SNAPSHOT_CACHE_KEY)
  if (!raw) {
    return
  }
  stores.session.removeItem(SNAPSHOT_CACHE_KEY)
  try {
    const payload = JSON.parse(raw) as Record<string, string> | null
    if (!payload || typeof payload !== 'object') {
      return
    }
    Object.entries(payload).forEach(([key, value]) => {
      if (typeof value !== 'string') {
        return
      }
      try {
        stores.local.setItem(key, value)
      } catch {
        // ignore write errors
      }
    })
  } catch {
    // ignore corrupt cache
  }
}
