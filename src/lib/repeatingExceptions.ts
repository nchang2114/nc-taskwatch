import { supabase, ensureSingleUserSession } from './supabaseClient'

export type RepeatingExceptionAction = 'skipped' | 'rescheduled'

export type RepeatingException = {
	id: string
	routineId: string
	// Local date for the occurrence (YYYY-MM-DD, in user's local timezone)
	occurrenceDate: string
	action: RepeatingExceptionAction
	// Optional reschedule info (local timestamps in ms)
	newStartedAt?: number | null
	newEndedAt?: number | null
	notes?: string | null
	createdAtMs: number
	updatedAtMs: number
}

const EXC_STORAGE_KEY = 'nc-taskwatch-repeating-exceptions'
export const EXC_EVENT = 'nc-taskwatch:repeating-exceptions-update'

const nowMs = () => Date.now()
const genId = () => {
	try {
		if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
	} catch {}
	return `rex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const sanitizeExceptions = (value: unknown): RepeatingException[] => {
	if (!Array.isArray(value)) return []
		return value
			.map((row) => {
			if (!row || typeof row !== 'object') return null
			const r = row as any
			const id = typeof r.id === 'string' ? r.id : null
			const routineId = typeof r.routineId === 'string' ? r.routineId : (typeof r.routine_id === 'string' ? r.routine_id : null)
			const occurrenceDate = typeof r.occurrenceDate === 'string' ? r.occurrenceDate : (typeof r.occurrence_date === 'string' ? r.occurrence_date : null)
			const action = r.action === 'skipped' || r.action === 'rescheduled' ? (r.action as RepeatingExceptionAction) : null
			if (!id || !routineId || !occurrenceDate || !action) return null
			const createdAtMs = Number.isFinite(r.createdAtMs) ? Number(r.createdAtMs) : Date.parse(r.created_at) || nowMs()
			const updatedAtMs = Number.isFinite(r.updatedAtMs) ? Number(r.updatedAtMs) : Date.parse(r.updated_at) || createdAtMs
				const newStartedAt: number | null = Number.isFinite(r.newStartedAt)
					? Number(r.newStartedAt)
					: (Number.isFinite(r.new_started_at) ? Number(r.new_started_at) : null)
				const newEndedAt: number | null = Number.isFinite(r.newEndedAt)
					? Number(r.newEndedAt)
					: (Number.isFinite(r.new_ended_at) ? Number(r.new_ended_at) : null)
				const notes: string | null = typeof r.notes === 'string' ? r.notes : null
				const obj: RepeatingException = { id, routineId, occurrenceDate, action, newStartedAt, newEndedAt, notes, createdAtMs, updatedAtMs }
				return obj
		})
		.filter((e): e is RepeatingException => Boolean(e))
}

const readLocal = (): RepeatingException[] => {
	if (typeof window === 'undefined') return []
	try {
		const raw = window.localStorage.getItem(EXC_STORAGE_KEY)
		if (!raw) return []
		return sanitizeExceptions(JSON.parse(raw))
	} catch {
		return []
	}
}

const writeLocal = (rows: RepeatingException[]) => {
	if (typeof window === 'undefined') return
	try {
		window.localStorage.setItem(EXC_STORAGE_KEY, JSON.stringify(rows))
		const evt = new CustomEvent<RepeatingException[]>(EXC_EVENT, { detail: rows })
		window.dispatchEvent(evt)
	} catch {}
}

export const subscribeRepeatingExceptions = (cb: (rows: RepeatingException[]) => void) => {
	if (typeof window === 'undefined') return () => {}
	const onUpdate = (ev: Event) => {
		const e = ev as CustomEvent<RepeatingException[]>
		cb(Array.isArray(e.detail) ? e.detail : readLocal())
	}
	window.addEventListener(EXC_EVENT, onUpdate as EventListener)
	return () => window.removeEventListener(EXC_EVENT, onUpdate as EventListener)
}

export const readRepeatingExceptions = (): RepeatingException[] => readLocal()

export const upsertRepeatingException = async (
	exc: Omit<RepeatingException, 'id' | 'createdAtMs' | 'updatedAtMs'> & { id?: string | null },
): Promise<RepeatingException> => {
	const id = exc.id || genId()
	const now = nowMs()
	const row: RepeatingException = { ...exc, id, createdAtMs: now, updatedAtMs: now }

	// Try Supabase if available and schema exists. Gate by env to avoid unknown column errors.
	const ENABLE_REMOTE = Boolean((import.meta as any)?.env?.VITE_ENABLE_REPEATING_EXCEPTIONS)
	if (supabase && ENABLE_REMOTE) {
		const session = await ensureSingleUserSession()
		if (session) {
			const payload: any = {
				id,
				user_id: session.user.id,
				routine_id: row.routineId,
				occurrence_date: row.occurrenceDate,
				action: row.action,
				new_started_at: row.newStartedAt ? new Date(row.newStartedAt).toISOString() : null,
				new_ended_at: row.newEndedAt ? new Date(row.newEndedAt).toISOString() : null,
				notes: row.notes ?? null,
				created_at: new Date(row.createdAtMs).toISOString(),
				updated_at: new Date(row.updatedAtMs).toISOString(),
			}
			const { error } = await supabase.from('repeating_exceptions').upsert(payload, { onConflict: 'id' })
			if (error) {
				// Fall back to local-only if remote fails
				console.warn('[repeatingExceptions] upsert error', error)
			}
		}
	}

	// Local persistence (source of truth if remote disabled)
	const current = readLocal()
	const idx = current.findIndex((r) => r.id === id)
	const next = idx >= 0 ? current.map((r) => (r.id === id ? row : r)) : [...current, row]
	writeLocal(next)
	return row
}

export const hasExceptionFor = (routineId: string, occurrenceDate: string): boolean => {
	const list = readLocal()
	return list.some((r) => r.routineId === routineId && r.occurrenceDate === occurrenceDate)
}
