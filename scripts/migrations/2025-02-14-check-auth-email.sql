-- Migration: Expose helper to check whether an auth email already exists
-- Date: 2025-02-14
-- PURPOSE
-- The frontend email-first flow needs a lightweight way to determine whether an email
-- is already registered before deciding which UX branch (existing sign-in vs signup)
-- to show. This helper function queries auth.users (requires SECURITY DEFINER) so
-- the anon client can call it safely via supabase.rpc('check_auth_email_exists', {...}).

-- Make sure to run this in your Supabase project (psql or the SQL editor).
-- After running, grant execute permissions so anon/authenticated clients can call it.

CREATE OR REPLACE FUNCTION public.check_auth_email_exists(target_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  normalized text;
BEGIN
  normalized := lower(trim(target_email));
  IF normalized IS NULL OR length(normalized) = 0 THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM auth.users
    WHERE lower(email) = normalized
    LIMIT 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_auth_email_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_auth_email_exists(text) TO anon, authenticated, service_role;

-- Verification:
-- select check_auth_email_exists('someone@example.com');
-- => true if auth email exists, false otherwise.
