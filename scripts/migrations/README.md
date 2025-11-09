# Database migrations for life_routines surface_style

This folder contains SQL you can run in the Supabase SQL Editor (or psql) to keep the backend in sync with new frontend theme ids.

## Why
Selecting newly added Life Routine themes was failing with a 400 Bad Request during `upsert` to `life_routines`. The most common cause is a Postgres ENUM or CHECK constraint on `life_routines.surface_style` that doesn’t include the new values.

## What to run
Open Supabase > SQL Editor and run the migration file:

- `2025-11-10-extend-surface-style.sql`

It includes two approaches:
- ENUM: `ALTER TYPE surface_style_enum ADD VALUE IF NOT EXISTS ...` for each new value.
- CHECK: Recreate the CHECK constraint with the expanded set.

Pick the section that matches how `surface_style` is defined in your project. If unsure, run `\d+ life_routines` in psql or inspect the column in Table Editor to see whether it’s an enum.

## Verification
- Re-try selecting a new color in the app; the 400 should be gone.
- Optional SQL sanity checks:
  - `SELECT DISTINCT surface_style FROM life_routines ORDER BY 1;`
  - Ensure new values appear and inserts succeed.

## Notes
- The frontend has a temporary defensive fallback: if the upsert fails due to a surface_style constraint, it retries once using the default theme so sync of titles/ordering isn’t blocked. Applying the migration removes the need for this fallback and preserves the selected theme server-side.
