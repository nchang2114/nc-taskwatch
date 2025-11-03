-- Auto-retire repeating_sessions when their bounded window is fully covered
-- Safe to run multiple times; uses IF NOT EXISTS where applicable.

-- 1) Helpful indexes for coverage checks
CREATE INDEX IF NOT EXISTS idx_session_history_repeat_original
  ON public.session_history (user_id, repeating_session_id, original_time);

CREATE INDEX IF NOT EXISTS idx_repeating_exceptions_lookup
  ON public.repeating_exceptions (user_id, routine_id, occurrence_date);

-- 2) Core function: delete rule when all occurrences in [start_date..end_date] are covered
CREATE OR REPLACE FUNCTION public.maybe_retire_repeating_session(p_rule_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_user uuid;
  v_freq text;
  v_dow int;
  v_minutes int;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_start_date date;
  v_end_date date;
  v_hour int;
  v_minute int;
  v_expected int;
  v_covered int;
BEGIN
  SELECT user_id, frequency, day_of_week, time_of_day_minutes, COALESCE(timezone, 'UTC'), start_date, end_date
    INTO v_user, v_freq, v_dow, v_minutes, v_tz, v_start, v_end
  FROM public.repeating_sessions
  WHERE id = p_rule_id;

  IF v_user IS NULL THEN
    RETURN false;
  END IF;

  -- Only retire when both bounds are present (closed interval)
  IF v_start IS NULL OR v_end IS NULL THEN
    RETURN false;
  END IF;

  v_start_date := (v_start AT TIME ZONE v_tz)::date;
  v_end_date := (v_end AT TIME ZONE v_tz)::date;

  IF v_end_date < v_start_date THEN
    -- Degenerate window: delete defensively
    DELETE FROM public.repeating_sessions WHERE id = p_rule_id;
    RETURN true;
  END IF;

  v_hour := (v_minutes / 60);
  v_minute := (v_minutes % 60);

  WITH dates AS (
    SELECT d::date AS d
    FROM (
      SELECT
        CASE
          WHEN v_freq = 'daily' THEN v_start_date
          ELSE (v_start_date + (((v_dow - EXTRACT(dow FROM v_start_date)::int + 7) % 7))::int)
        END AS first_date,
        v_end_date AS last_date
    ) b,
    LATERAL (
      SELECT CASE
        WHEN v_freq = 'daily' THEN generate_series(b.first_date, b.last_date, interval '1 day')
        ELSE generate_series(b.first_date, b.last_date, interval '7 days')
      END
    ) g(d)
  ),
  occ AS (
    SELECT
      d AS local_date,
      make_timestamptz(
        EXTRACT(YEAR FROM d)::int,
        EXTRACT(MONTH FROM d)::int,
        EXTRACT(DAY FROM d)::int,
        v_hour, v_minute, 0::double precision, v_tz
      ) AS scheduled_ts
    FROM dates
    WHERE v_freq = 'daily' OR (EXTRACT(dow FROM d)::int = v_dow)
  ),
  covered AS (
    SELECT o.scheduled_ts
    FROM occ o
    LEFT JOIN public.session_history h
      ON h.user_id = v_user
     AND h.repeating_session_id = p_rule_id
     AND h.original_time = o.scheduled_ts
    LEFT JOIN public.repeating_exceptions e
      ON e.user_id = v_user
     AND e.routine_id = p_rule_id
     AND to_date(e.occurrence_date, 'YYYY-MM-DD') = o.local_date
    WHERE h.id IS NOT NULL OR e.id IS NOT NULL
  )
  SELECT COUNT(*) INTO v_expected FROM occ;

  IF v_expected = 0 THEN
    -- No occurrences in window: delete as a no-op
    DELETE FROM public.repeating_sessions WHERE id = p_rule_id;
    RETURN true;
  END IF;

  SELECT COUNT(*) INTO v_covered FROM covered;

  IF v_expected = v_covered THEN
    DELETE FROM public.repeating_sessions WHERE id = p_rule_id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- 3) Trigger: evaluate after session_history insert/update
CREATE OR REPLACE FUNCTION public.maybe_retire_repeating_session_from_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.repeating_session_id IS NOT NULL THEN
    PERFORM public.maybe_retire_repeating_session(NEW.repeating_session_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maybe_retire_from_history ON public.session_history;

CREATE TRIGGER trg_maybe_retire_from_history
AFTER INSERT OR UPDATE OF repeating_session_id, original_time
ON public.session_history
FOR EACH ROW
EXECUTE FUNCTION public.maybe_retire_repeating_session_from_history();

-- 4) Trigger: evaluate after exception insert
CREATE OR REPLACE FUNCTION public.maybe_retire_repeating_session_from_exception()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.routine_id IS NOT NULL THEN
    PERFORM public.maybe_retire_repeating_session(NEW.routine_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maybe_retire_from_exception ON public.repeating_exceptions;

CREATE TRIGGER trg_maybe_retire_from_exception
AFTER INSERT ON public.repeating_exceptions
FOR EACH ROW
EXECUTE FUNCTION public.maybe_retire_repeating_session_from_exception();

-- 5) Optional: periodic sweep to catch any missed evaluations
CREATE OR REPLACE FUNCTION public.sweep_repeating_sessions_for_retirement()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.repeating_sessions WHERE end_date IS NOT NULL LOOP
    PERFORM public.maybe_retire_repeating_session(r.id);
  END LOOP;
END;
$$;
