# SQL for auto-retiring repeating sessions

This folder contains SQL you can run in Supabase to auto-delete rows from `public.repeating_sessions`
once every occurrence between `start_date` and `end_date` is covered (confirmed or skipped/rescheduled).

Files
- `2025-11-04-repeating-retire.sql` – Creates:
  - Helpful indexes
  - Function: `public.maybe_retire_repeating_session(rule_id uuid)`
  - Triggers: evaluate on `session_history` upserts and `repeating_exceptions` inserts
  - Optional sweep function

How to apply (Supabase SQL Editor)
1) Open your Supabase project → SQL Editor
2) Paste the contents of `2025-11-04-repeating-retire.sql` and run
3) Verify no errors are reported

Schema prerequisites
- `public.session_history` has columns:
  - `repeating_session_id uuid` (FK to `public.repeating_sessions(id)`)
  - `original_time timestamptz`
- `public.repeating_exceptions` exists with:
  - `routine_id uuid`, `occurrence_date text (YYYY-MM-DD)`, and `user_id uuid`

What it does
- For any rule with both `start_date` and `end_date` set, it generates all expected occurrence timestamps in the rule's timezone
- Marks an occurrence covered if either:
  - A row in `session_history` has `(repeating_session_id = rule_id AND original_time = that occurrence timestamp)`, or
  - A row in `repeating_exceptions` exists for `(routine_id = rule_id AND occurrence_date = that local YYYY-MM-DD)`
- If all occurrences in the window are covered, it deletes the rule row

Quick verify
1) In the app, set a repeating rule to None on one of its guides (this sets its end_date)
2) Confirm/Skip each remaining guide within the window
3) Inspect `public.repeating_sessions`: the rule row should be deleted automatically

Optional scheduled sweep
- Call `select public.sweep_repeating_sessions_for_retirement();` periodically (pg_cron or Edge Function)
- This is just a safety net; the triggers should handle it automatically


Disable / enable the auto-retire behavior

- Temporarily disable triggers (no automatic deletes):

```sql
ALTER TABLE public.session_history DISABLE TRIGGER trg_maybe_retire_from_history;
ALTER TABLE public.repeating_exceptions DISABLE TRIGGER trg_maybe_retire_from_exception;
```

- Re‑enable triggers:

```sql
ALTER TABLE public.session_history ENABLE TRIGGER trg_maybe_retire_from_history;
ALTER TABLE public.repeating_exceptions ENABLE TRIGGER trg_maybe_retire_from_exception;
```

- Hard stop (drop triggers); you can recreate them later by re-running the SQL file:

```sql
DROP TRIGGER IF EXISTS trg_maybe_retire_from_history ON public.session_history;
DROP TRIGGER IF EXISTS trg_maybe_retire_from_exception ON public.repeating_exceptions;
```

- Remove functions completely (optional):

```sql
DROP FUNCTION IF EXISTS public.maybe_retire_repeating_session(uuid);
DROP FUNCTION IF EXISTS public.maybe_retire_repeating_session_from_history();
DROP FUNCTION IF EXISTS public.maybe_retire_repeating_session_from_exception();
DROP FUNCTION IF EXISTS public.sweep_repeating_sessions_for_retirement();
```

- Check trigger status:

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.session_history'::regclass
  OR tgrelid = 'public.repeating_exceptions'::regclass;
```

Recommendation

- Use DISABLE/ENABLE TRIGGER to pause/resume behavior without losing the functions. Keep the functions so you can still run the manual sweep when needed:

```sql
SELECT public.sweep_repeating_sessions_for_retirement();
```

---

## Goals – Milestones Layer visibility (optional)

If you want the Goals page to persist whether the Milestones Layer is shown for each goal, add a boolean column to `public.goals`:

```sql
ALTER TABLE public.goals
ADD COLUMN IF NOT EXISTS milestones_shown boolean NOT NULL DEFAULT false;
```

Notes
- The app auto-detects this column. If present, the toggle is saved to `goals.milestones_shown`; if missing, the app falls back to local-only storage.
- You can seed or bulk update as needed, e.g. set it true for a specific goal:

```sql
UPDATE public.goals SET milestones_shown = true WHERE id = '<goal-id>';
```
