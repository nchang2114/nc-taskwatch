-- Migration: Extend allowed surface_style values for life_routines
-- Date: 2025-11-10
-- PURPOSE
-- The frontend added new surface style ids (cool-blue, soft-magenta, muted-lavender,
-- neutral-grey-blue, fresh-teal, etc.). The life_routines.surface_style column likely
-- uses a Postgres ENUM or CHECK constraint that does not yet include these.
-- This migration updates the constraint. Choose the block matching your schema style.

-- 1. IF USING A POSTGRES ENUM TYPE (preferred approach):
-- This block discovers the enum type attached to life_routines.surface_style (if any)
-- and adds the new values idempotently.
DO $$
DECLARE enum_name text;
BEGIN
  SELECT t.typname INTO enum_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace ns ON c.relnamespace = ns.oid
  JOIN pg_type t  ON a.atttypid = t.oid
  WHERE ns.nspname = 'public'
    AND c.relname = 'life_routines'
    AND a.attname = 'surface_style'
    AND t.typtype = 'e';

  IF enum_name IS NOT NULL THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'cool-blue');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'soft-magenta');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'muted-lavender');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'neutral-grey-blue');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'fresh-teal');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'deep-indigo');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'warm-amber');
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_name, 'sunset-orange');
  END IF;
END $$;

-- 2. IF USING A CHECK CONSTRAINT (text column + CHECK):
-- This block auto-detects an existing CHECK constraint that references surface_style
-- on public.life_routines, drops it, and recreates it with the expanded set.
DO $$
DECLARE check_name text;
BEGIN
  SELECT c.conname INTO check_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace ns ON r.relnamespace = ns.oid
  WHERE ns.nspname = 'public'
    AND r.relname = 'life_routines'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%surface_style%';

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', 'public', 'life_routines', check_name);
  END IF;

  EXECUTE 'ALTER TABLE public.life_routines
    ADD CONSTRAINT life_routines_surface_style_check
    CHECK (surface_style IN (
      ''midnight'',''grove'',''slate'',''ember'',''glass'',''linen'',''charcoal'',
      ''cool-blue'',''soft-magenta'',''muted-lavender'',''neutral-grey-blue'',''fresh-teal'',
      ''deep-indigo'',''warm-amber'',''sunset-orange''
    ))';
END $$;

-- 3. (Optional) Backfill existing NULL or legacy values to a safe default:
-- UPDATE life_routines SET surface_style = 'midnight' WHERE surface_style IS NULL;

-- 4. (Optional) Grant usage if a new enum type was created elsewhere:
-- GRANT USAGE ON TYPE surface_style_enum TO anon, authenticated, service_role; -- adjust roles

-- After running, test with: SELECT DISTINCT surface_style FROM life_routines ORDER BY 1;
