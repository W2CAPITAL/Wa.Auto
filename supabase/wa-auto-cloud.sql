-- WA.Auto cloud persistence
-- Execute once in Supabase. After creating WA_DB_SECRET on the backend,
-- store only its SHA-256 hash in wa_auto_config.

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.wa_auto_config (
  id text primary key check (id = 'default'),
  secret_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.wa_auto_snapshots (
  id text primary key check (id = 'default'),
  payload text not null,
  updated_at timestamptz not null default now()
);

alter table public.wa_auto_config enable row level security;
alter table public.wa_auto_snapshots enable row level security;

drop policy if exists wa_auto_snapshots_select on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_insert on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_update on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_delete on public.wa_auto_snapshots;

drop function if exists public.wa_auto_access_ok();

create or replace function private.wa_auto_access_ok()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.wa_auto_config c
    where c.id = 'default'
      and c.secret_hash = encode(
        extensions.digest(
          convert_to(
            coalesce(
              (coalesce(current_setting('request.headers', true), '{}')::jsonb ->> 'x-wa-secret'),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
  );
$$;

revoke all on function private.wa_auto_access_ok() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.wa_auto_access_ok() to anon, authenticated;

drop policy if exists wa_auto_config_deny on public.wa_auto_config;
create policy wa_auto_config_deny
on public.wa_auto_config for all
to anon, authenticated
using (false)
with check (false);

create policy wa_auto_snapshots_select
on public.wa_auto_snapshots for select
to anon, authenticated
using (private.wa_auto_access_ok());

create policy wa_auto_snapshots_insert
on public.wa_auto_snapshots for insert
to anon, authenticated
with check (private.wa_auto_access_ok());

create policy wa_auto_snapshots_update
on public.wa_auto_snapshots for update
to anon, authenticated
using (private.wa_auto_access_ok())
with check (private.wa_auto_access_ok());

create policy wa_auto_snapshots_delete
on public.wa_auto_snapshots for delete
to anon, authenticated
using (private.wa_auto_access_ok());

revoke all on public.wa_auto_config from anon, authenticated;
grant select, insert, update, delete on public.wa_auto_snapshots to anon, authenticated;


-- Durable send intent journal.
-- This tiny row closes the crash window between "about to send" and the next full snapshot.
create table if not exists public.wa_auto_intents (
  id text primary key check (id = 'active'),
  kind text not null check (kind in ('campaign','legal')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.wa_auto_intents enable row level security;

drop policy if exists wa_auto_intents_select on public.wa_auto_intents;
drop policy if exists wa_auto_intents_insert on public.wa_auto_intents;
drop policy if exists wa_auto_intents_update on public.wa_auto_intents;
drop policy if exists wa_auto_intents_delete on public.wa_auto_intents;

create policy wa_auto_intents_select
on public.wa_auto_intents for select
to anon, authenticated
using (private.wa_auto_access_ok());

create policy wa_auto_intents_insert
on public.wa_auto_intents for insert
to anon, authenticated
with check (private.wa_auto_access_ok());

create policy wa_auto_intents_update
on public.wa_auto_intents for update
to anon, authenticated
using (private.wa_auto_access_ok())
with check (private.wa_auto_access_ok());

create policy wa_auto_intents_delete
on public.wa_auto_intents for delete
to anon, authenticated
using (private.wa_auto_access_ok());

grant select, insert, update, delete on public.wa_auto_intents to anon, authenticated;
