-- ============================================================
-- NEET PG site: custom name+PIN accounts (no Supabase Auth at all)
-- Run this whole file once in the Supabase SQL Editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------------- Users (name + PIN, hashed) ----------------
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,   -- normalized (trim + lowercase) name; enforces one account per name
  pin_hash text not null,
  user_type text not null default 'NORMAL' check (user_type in ('NORMAL', 'ADMIN')),
  created_at timestamptz default now()
);

-- Lock the raw table down completely -- nobody can SELECT/INSERT/UPDATE it directly,
-- not even with the public anon key. All access goes through the two functions below,
-- which is what actually keeps pin_hash from being fetchable via the public API.
alter table public.users enable row level security;
-- (intentionally no policies -- RLS with zero policies = default-deny for everyone)

-- Safe-to-expose view of users (no pin_hash) for the admin panel's user list.
create or replace view public.users_public as
  select id, name, user_type, created_at from public.users;
grant select on public.users_public to anon, authenticated;

-- Register a brand-new user. Fails if the name is already taken.
create or replace function public.register_user(p_name text, p_pin text)
returns table(id uuid, name text, user_type text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := lower(trim(p_name));
  v_id uuid;
begin
  if v_key = '' then
    raise exception 'Name required';
  end if;
  if length(p_pin) < 4 then
    raise exception 'PIN must be at least 4 characters';
  end if;
  if exists (select 1 from public.users where name_key = v_key) then
    raise exception 'NAME_TAKEN';
  end if;

  insert into public.users (name, name_key, pin_hash)
  values (trim(p_name), v_key, crypt(p_pin, gen_salt('bf')))
  returning users.id into v_id;

  return query select v_id, trim(p_name), 'NORMAL'::text;
end;
$$;
grant execute on function public.register_user(text, text) to anon, authenticated;

-- Log in an existing user. Returns zero rows if the name/PIN combination is wrong.
create or replace function public.login_user(p_name text, p_pin text)
returns table(id uuid, name text, user_type text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := lower(trim(p_name));
begin
  return query
    select u.id, u.name, u.user_type
    from public.users u
    where u.name_key = v_key
      and u.pin_hash = crypt(p_pin, u.pin_hash);
end;
$$;
grant execute on function public.login_user(text, text) to anon, authenticated;


-- ---------------- Exam results (kept fully open -- no per-row security, per project scope) ----------------
create table if not exists public.exam_history (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  user_name text not null,
  week_id text not null,
  exam_title text,
  score int,
  total_marks int,
  percentage numeric,
  correct_count int,
  wrong_count int,
  unattempted_count int,
  violations int default 0,
  auto_submitted_for_violations boolean default false,
  section_breakdown jsonb,
  per_question jsonb,
  attempt_date timestamptz not null,
  created_at timestamptz default now()
);
create index if not exists exam_history_user_id_idx on public.exam_history (user_id);

alter table public.exam_history enable row level security;
create policy "Open read" on public.exam_history for select using (true);
create policy "Open insert" on public.exam_history for insert with check (true);


-- ---------------- Week unlock overrides (admin-controlled, applies to everyone) ----------------
create table if not exists public.week_overrides (
  week_id text primary key,
  force_unlocked boolean not null default false,
  updated_at timestamptz default now()
);

alter table public.week_overrides enable row level security;
create policy "Open read" on public.week_overrides for select using (true);
create policy "Open write" on public.week_overrides for all using (true) with check (true);


-- ---------------- The one admin account: name "alpha", PIN "1010" ----------------
select public.register_user('alpha', '1010');
update public.users set user_type = 'ADMIN' where name_key = 'alpha';
