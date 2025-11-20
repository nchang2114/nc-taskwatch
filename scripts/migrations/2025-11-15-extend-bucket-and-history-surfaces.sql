-- Migration: Extend allowed surface styles for buckets + session_history
-- Date: 2025-11-15
-- PURPOSE
-- The UI now ships a much larger palette (deep-indigo, coral, papaya, etc.).
-- Supabase still enforces the legacy list via ENUM or CHECK constraints on
--   - public.buckets.buckets_card_style
--   - public.session_history.goal_surface
--   - public.session_history.bucket_surface
-- Run the blocks below to add every new value. They are idempotent and cover
-- both ENUM-based and CHECK-based schemas.

-- Shared surface list (keep in sync with src/lib/surfaceStyles.ts)
-- glass, midnight, slate, charcoal, linen, frost, grove, lagoon, ember,
-- deep-indigo, warm-amber, fresh-teal, sunset-orange, cool-blue, soft-magenta,
-- muted-lavender, neutral-grey-blue, leaf, sprout, fern, sage, meadow, willow,
-- pine, basil, mint, coral, peach, apricot, salmon, tangerine, papaya

-- 1A. Buckets: add values to ENUM (if the column uses an enum type)
DO $$
DECLARE
  enum_name text;
  val text;
BEGIN
  SELECT t.typname INTO enum_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace ns ON c.relnamespace = ns.oid
  JOIN pg_type t  ON a.atttypid = t.oid
  WHERE ns.nspname = 'public'
    AND c.relname = 'buckets'
    AND a.attname = 'buckets_card_style'
    AND t.typtype = 'e';

  IF enum_name IS NOT NULL THEN
    FOR val IN SELECT unnest(ARRAY[
      'deep-indigo','warm-amber','fresh-teal','sunset-orange','cool-blue',
      'soft-magenta','muted-lavender','neutral-grey-blue','leaf','sprout',
      'fern','sage','meadow','willow','pine','basil','mint','coral',
      'peach','apricot','salmon','tangerine','papaya'
    ]) LOOP
      EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, val);
    END LOOP;
  END IF;
END $$;

-- 1B. Buckets: CHECK constraint variant
DO $$
DECLARE check_name text;
BEGIN
  SELECT c.conname INTO check_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace ns ON r.relnamespace = ns.oid
  WHERE ns.nspname = 'public'
    AND r.relname = 'buckets'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%buckets_card_style%';

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', 'public', 'buckets', check_name);
  END IF;

  EXECUTE $$
    ALTER TABLE public.buckets
    ADD CONSTRAINT buckets_card_style_check
    CHECK (buckets_card_style IS NULL OR buckets_card_style IN (
      'glass','midnight','slate','charcoal','linen','frost','grove','lagoon','ember',
      'deep-indigo','warm-amber','fresh-teal','sunset-orange','cool-blue','soft-magenta',
      'muted-lavender','neutral-grey-blue','leaf','sprout','fern','sage','meadow','willow',
      'pine','basil','mint','coral','peach','apricot','salmon','tangerine','papaya'
    ))
  $$;
END $$;

-- 2A. session_history.goal_surface ENUM block
DO $$
DECLARE
  enum_name text;
  val text;
BEGIN
  SELECT t.typname INTO enum_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace ns ON c.relnamespace = ns.oid
  JOIN pg_type t  ON a.atttypid = t.oid
  WHERE ns.nspname = 'public'
    AND c.relname = 'session_history'
    AND a.attname = 'goal_surface'
    AND t.typtype = 'e';

  IF enum_name IS NOT NULL THEN
    FOR val IN SELECT unnest(ARRAY[
      'deep-indigo','warm-amber','fresh-teal','sunset-orange','cool-blue',
      'soft-magenta','muted-lavender','neutral-grey-blue','leaf','sprout',
      'fern','sage','meadow','willow','pine','basil','mint','coral',
      'peach','apricot','salmon','tangerine','papaya'
    ]) LOOP
      EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, val);
    END LOOP;
  END IF;
END $$;

-- 2B. session_history.goal_surface CHECK block
DO $$
DECLARE check_name text;
BEGIN
  SELECT c.conname INTO check_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace ns ON r.relnamespace = ns.oid
  WHERE ns.nspname = 'public'
    AND r.relname = 'session_history'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%goal_surface%';

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', 'public', 'session_history', check_name);
  END IF;

  EXECUTE $$
    ALTER TABLE public.session_history
    ADD CONSTRAINT session_history_goal_surface_check
    CHECK (goal_surface IS NULL OR goal_surface IN (
      'glass','midnight','slate','charcoal','linen','frost','grove','lagoon','ember',
      'deep-indigo','warm-amber','fresh-teal','sunset-orange','cool-blue','soft-magenta',
      'muted-lavender','neutral-grey-blue','leaf','sprout','fern','sage','meadow','willow',
      'pine','basil','mint','coral','peach','apricot','salmon','tangerine','papaya'
    ))
  $$;
END $$;

-- 3. session_history.bucket_surface (same pattern)
DO $$
DECLARE check_name text;
BEGIN
  SELECT c.conname INTO check_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace ns ON r.relnamespace = ns.oid
  WHERE ns.nspname = 'public'
    AND r.relname = 'session_history'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%bucket_surface%';

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', 'public', 'session_history', check_name);
  END IF;

  EXECUTE $$
    ALTER TABLE public.session_history
    ADD CONSTRAINT session_history_bucket_surface_check
    CHECK (bucket_surface IS NULL OR bucket_surface IN (
      'glass','midnight','slate','charcoal','linen','frost','grove','lagoon','ember',
      'deep-indigo','warm-amber','fresh-teal','sunset-orange','cool-blue','soft-magenta',
      'muted-lavender','neutral-grey-blue','leaf','sprout','fern','sage','meadow','willow',
      'pine','basil','mint','coral','peach','apricot','salmon','tangerine','papaya'
    ))
  $$;
END $$;

-- 4. Optional backfill: re-tag any NULL/legacy values before syncing again.
-- UPDATE public.buckets SET buckets_card_style = 'glass' WHERE buckets_card_style IS NULL;
-- UPDATE public.session_history SET bucket_surface = 'glass' WHERE bucket_surface NOT IN (...list...);
