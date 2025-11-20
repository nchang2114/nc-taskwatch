import { GOALS_SNAPSHOT_STORAGE_KEY, GOALS_SNAPSHOT_REQUEST_EVENT } from './goalsSync'
import { QUICK_LIST_STORAGE_KEY } from './quickList'
import { LIFE_ROUTINE_STORAGE_KEY } from './lifeRoutines'
import { HISTORY_STORAGE_KEY, purgeDeletedHistoryRecords } from './sessionHistory'
import {
  REPEATING_RULES_STORAGE_KEY,
  REPEATING_RULES_ACTIVATION_KEY,
  REPEATING_RULES_END_KEY,
} from './repeatingSessions'
import { GUEST_SNAPSHOT_CACHE_KEY } from './guestSnapshotKeys'

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

const waitForFlush = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export const cacheGuestSnapshotForBootstrap = async (): Promise<void> => {
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(GOALS_SNAPSHOT_REQUEST_EVENT))
    } catch {}
  }
  await waitForFlush()
  purgeDeletedHistoryRecords()
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
    stores.session.setItem(GUEST_SNAPSHOT_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore write errors (e.g., quota)
  }
}

export const restoreGuestSnapshotFromCache = (): void => {
  const stores = canUseStorage()
  if (!stores) return
  const raw = stores.session.getItem(GUEST_SNAPSHOT_CACHE_KEY)
  if (!raw) {
    return
  }
  stores.session.removeItem(GUEST_SNAPSHOT_CACHE_KEY)
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
