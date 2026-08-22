-- Run this in the Supabase SQL Editor AFTER supabase_schema.sql has already been applied.

-- Denormalized email on each result row, so the admin panel can show "who" without
-- needing to query the separate auth schema (which isn't exposed to the client anyway).
alter table public.exam_history add column if not exists user_email text;

-- The (single) admin is just a specific real account, tied to their Supabase Auth user id.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.admins enable row level security;

create policy "Admins can see their own admin row"
  on public.admins for select
  using (auth.uid() = user_id);

-- SECURITY DEFINER function: lets any signed-in user safely ask "am I an admin?"
-- without needing broad read access to the admins table itself.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to authenticated;

-- Admins can additionally see every row in exam_history (regular users still only
-- ever see their own rows, via the existing policy in supabase_schema.sql -- Postgres
-- combines multiple SELECT policies with OR, so nothing about that policy changes).
create policy "Admins can view all history"
  on public.exam_history for select
  using (public.is_admin());


-- ---- Add the one admin ----
-- The admin must have signed in at least once via the site's normal magic-link flow
-- first (so their auth.users row exists), then run this with their email:

insert into public.admins (user_id)
select id from auth.users where email = 'PUT_ADMIN_EMAIL_HERE@example.com';
