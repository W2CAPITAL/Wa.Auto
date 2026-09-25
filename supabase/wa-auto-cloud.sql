-- WA.Auto cloud persistence
-- Execute once in Supabase. After creating WA_DB_SECRET on the backend,
-- store only its SHA-256 hash in wa_auto_config.

create extension if not exists pgcrypto;

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

create or replace function public.wa_auto_access_ok()
returns boolean
language sql
stable
security definer
set search_path = public
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

revoke all on function public.wa_auto_access_ok() from public;
grant execute on function public.wa_auto_access_ok() to anon, authenticated;

drop policy if exists wa_auto_snapshots_select on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_insert on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_update on public.wa_auto_snapshots;
drop policy if exists wa_auto_snapshots_delete on public.wa_auto_snapshots;

create policy wa_auto_snapshots_select
on public.wa_auto_snapshots for select
to anon, authenticated
using (public.wa_auto_access_ok());

create policy wa_auto_snapshots_insert
on public.wa_auto_snapshots for insert
to anon, authenticated
with check (public.wa_auto_access_ok());

create policy wa_auto_snapshots_update
on public.wa_auto_snapshots for update
to anon, authenticated
using (public.wa_auto_access_ok())
with check (public.wa_auto_access_ok());

create policy wa_auto_snapshots_delete
on public.wa_auto_snapshots for delete
to anon, authenticated
using (public.wa_auto_access_ok());

revoke all on public.wa_auto_config from anon, authenticated;
grant select, insert, update, delete on public.wa_auto_snapshots to anon, authenticated;
