create table public.profiles (
  id uuid not null,
  display_name text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint profiles_pkey primary key (id)
) TABLESPACE pg_default;