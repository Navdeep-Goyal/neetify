-- ============================================================
-- NEET PG site: complete fresh schema (run once against a clean database).
-- Custom name+PIN accounts, no Supabase Auth. Signed session tokens (24h expiry)
-- so "being logged in" is verified server-side, not just trusted from localStorage.
--
-- IMPORTANT -- read this before running:
-- Step 1 below stores a secret used to sign session tokens, in a table that's locked
-- down so nothing can read it except the functions further down. Do NOT commit the
-- real secret value into this file or any file in your git repo. Instead:
--   1. Generate/keep a long random value privately (e.g. store it in GitHub -> your
--      repo -> Settings -> Secrets and variables -> Actions, as a personal secure
--      note -- your static site can't read it from there automatically, there's no
--      build step, but it keeps a safe backup copy of it that never touches git history).
--   2. Run the INSERT in Step 1 with that value pasted in directly, typed straight
--      into the SQL Editor -- never save that filled-in version to a file.
--   3. Everything below this file is safe to commit as-is: it never contains the
--      actual secret, only a reference to the table it's stored in.
-- ============================================================

-- ---------------- STEP 1: store the secret (run this by itself first) ----------------
create table if not exists public.app_secrets (
  key text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
-- (intentionally no policies -- RLS with zero policies = default-deny for everyone,
-- same protection this file already uses for pin_hash in the users table below)

-- Replace the placeholder with a real random value before running, e.g. generate one with:
--   python3 -c "import secrets; print(secrets.token_hex(32))"
-- Then run ONLY this insert, typed directly (don't save the filled-in version to a file).
-- Safe to re-run later to rotate the secret (it'll just replace the old value):
--
--   insert into public.app_secrets (key, value) values ('jwt_secret', 'PASTE_YOUR_OWN_RANDOM_SECRET_HERE')
--   on conflict (key) do update set value = excluded.value;
--
-- Then continue with everything below.


-- ---------------- Users (name + PIN, hashed) ----------------
create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,   -- normalized (trim + lowercase) name; enforces one account per name
  pin_hash text not null,
  user_type text not null default 'NORMAL' check (user_type in ('NORMAL', 'ADMIN')),
  created_at timestamptz default now()
);

-- Lock the raw table down completely -- nobody can SELECT/INSERT/UPDATE it directly,
-- not even with the public anon key. All access goes through the functions below,
-- which is what actually keeps pin_hash from being fetchable via the public API.
alter table public.users enable row level security;
-- (intentionally no policies -- RLS with zero policies = default-deny for everyone)

-- Safe-to-expose view of users (no pin_hash) for the admin panel's user list.
create or replace view public.users_public as
  select id, name, user_type, created_at from public.users;
grant select on public.users_public to anon, authenticated;


-- ---------------- JWT-style session tokens (HMAC-SHA256, 24h expiry) ----------------
-- Reads the secret from the app_secrets table set up in Step 1 above -- never
-- hardcoded here, so this file is safe to commit to a public repo as-is. SECURITY
-- DEFINER lets this function read that RLS-locked table internally; it's never
-- granted to anon/authenticated directly, so nothing outside this file can call it.
create or replace function public.app_jwt_secret()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select value from public.app_secrets where key = 'jwt_secret';
$$;

create or replace function public.mint_session_token(p_user_id uuid, p_user_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  header text := '{"alg":"HS256","typ":"JWT"}';
  payload text;
  header_b64 text;
  payload_b64 text;
  signing_input text;
  sig bytea;
  sig_b64 text;
begin
  payload := json_build_object(
    'sub', p_user_id::text,
    'user_type', p_user_type,
    'exp', extract(epoch from (now() + interval '24 hours'))::bigint
  )::text;

  header_b64 := rtrim(translate(encode(convert_to(header, 'utf8'), 'base64'), '+/', '-_'), '=');
  payload_b64 := rtrim(translate(encode(convert_to(payload, 'utf8'), 'base64'), '+/', '-_'), '=');
  signing_input := header_b64 || '.' || payload_b64;

  sig := extensions.hmac(signing_input::bytea, public.app_jwt_secret()::bytea, 'sha256');
  sig_b64 := rtrim(translate(encode(sig, 'base64'), '+/', '-_'), '=');

  return signing_input || '.' || sig_b64;
end;
$$;

-- Verify a session token and return the CURRENT, real id/name/user_type from the
-- database (not whatever the client claims) -- or zero rows if invalid/expired.
create or replace function public.verify_session(p_token text)
returns table(user_id uuid, name text, user_type text)
language plpgsql
security definer
set search_path = public
as $$
declare
  parts text[];
  header_b64 text;
  payload_b64 text;
  sig_b64 text;
  signing_input text;
  expected_sig bytea;
  expected_sig_b64 text;
  padded text;
  payload_json json;
  v_uid uuid;
begin
  if p_token is null or p_token = '' then
    return;
  end if;

  parts := string_to_array(p_token, '.');
  if array_length(parts, 1) != 3 then
    return; -- malformed
  end if;
  header_b64 := parts[1];
  payload_b64 := parts[2];
  sig_b64 := parts[3];
  signing_input := header_b64 || '.' || payload_b64;

  expected_sig := extensions.hmac(signing_input::bytea, public.app_jwt_secret()::bytea, 'sha256');
  expected_sig_b64 := rtrim(translate(encode(expected_sig, 'base64'), '+/', '-_'), '=');

  if expected_sig_b64 != sig_b64 then
    return; -- bad signature -- reject
  end if;

  padded := payload_b64 || repeat('=', (4 - length(payload_b64) % 4) % 4);
  payload_json := convert_from(decode(translate(padded, '-_', '+/'), 'base64'), 'utf8')::json;

  if (payload_json->>'exp')::bigint < extract(epoch from now())::bigint then
    return; -- expired -- reject, forcing re-login
  end if;

  v_uid := (payload_json->>'sub')::uuid;
  return query select u.id, u.name, u.user_type from public.users u where u.id = v_uid;
end;
$$;
grant execute on function public.verify_session(text) to anon, authenticated;


-- ---------------- Register / login (now return a session token too) ----------------
create or replace function public.register_user(p_name text, p_pin text)
returns table(id uuid, name text, user_type text, token text)
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

  return query select v_id, trim(p_name), 'NORMAL'::text, public.mint_session_token(v_id, 'NORMAL');
end;
$$;
grant execute on function public.register_user(text, text) to anon, authenticated;

create or replace function public.login_user(p_name text, p_pin text)
returns table(id uuid, name text, user_type text, token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := lower(trim(p_name));
  v_row record;
begin
  select u.id, u.name, u.user_type into v_row
  from public.users u
  where u.name_key = v_key
    and u.pin_hash = crypt(p_pin, u.pin_hash);

  if v_row.id is null then
    return; -- zero rows -- wrong name/PIN
  end if;

  return query select v_row.id, v_row.name, v_row.user_type, public.mint_session_token(v_row.id, v_row.user_type);
end;
$$;
grant execute on function public.login_user(text, text) to anon, authenticated;


-- ---------------- Exam results ----------------
-- No open read/write policies here: all access goes through the verified functions
-- below (submit_exam_result, get_my_history, get_all_history_admin,
-- get_user_history_admin). RLS is enabled with zero policies, which is a default-deny
-- for direct table access -- only those SECURITY DEFINER functions can touch this table.
create table public.exam_history (
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
create index exam_history_user_id_idx on public.exam_history (user_id);
alter table public.exam_history enable row level security;
-- (intentionally no policies -- see note above)

-- Identity for exam_history writes/reads always comes from a verified session token,
-- never from a client-supplied user_id -- so a caller can't claim to be someone else.
create or replace function public.submit_exam_result(
  p_token text,
  p_id uuid,
  p_week_id text,
  p_exam_title text,
  p_score int,
  p_total_marks int,
  p_percentage numeric,
  p_correct_count int,
  p_wrong_count int,
  p_unattempted_count int,
  p_violations int,
  p_auto_submitted_for_violations boolean,
  p_section_breakdown jsonb,
  p_per_question jsonb,
  p_attempt_date timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session from public.verify_session(p_token);
  if v_session.user_id is null then
    raise exception 'Invalid or expired session -- please log in again';
  end if;

  insert into public.exam_history (
    id, user_id, user_name, week_id, exam_title, score, total_marks, percentage,
    correct_count, wrong_count, unattempted_count, violations,
    auto_submitted_for_violations, section_breakdown, per_question, attempt_date
  ) values (
    p_id, v_session.user_id, v_session.name, p_week_id, p_exam_title, p_score, p_total_marks, p_percentage,
    p_correct_count, p_wrong_count, p_unattempted_count, p_violations,
    p_auto_submitted_for_violations, p_section_breakdown, p_per_question, p_attempt_date
  )
  on conflict (id) do nothing; -- idempotent if a sync retries the same entry
end;
$$;
grant execute on function public.submit_exam_result(
  text, uuid, text, text, int, int, numeric, int, int, int, int, boolean, jsonb, jsonb, timestamptz
) to anon, authenticated;

create or replace function public.get_my_history(p_token text)
returns setof public.exam_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session from public.verify_session(p_token);
  if v_session.user_id is null then
    return; -- invalid/expired session -- empty result, no error
  end if;
  return query select * from public.exam_history where user_id = v_session.user_id;
end;
$$;
grant execute on function public.get_my_history(text) to anon, authenticated;

create or replace function public.get_all_history_admin(p_token text)
returns setof public.exam_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session from public.verify_session(p_token);
  if v_session.user_id is null or v_session.user_type != 'ADMIN' then
    return; -- not an admin -- empty result, no error (avoid confirming admin existence)
  end if;
  return query select * from public.exam_history order by attempt_date desc;
end;
$$;
grant execute on function public.get_all_history_admin(text) to anon, authenticated;

create or replace function public.get_user_history_admin(p_token text, p_target_user_id uuid)
returns setof public.exam_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session from public.verify_session(p_token);
  if v_session.user_id is null or v_session.user_type != 'ADMIN' then
    return;
  end if;
  return query select * from public.exam_history where user_id = p_target_user_id order by attempt_date desc;
end;
$$;
grant execute on function public.get_user_history_admin(text, uuid) to anon, authenticated;


-- ---------------- Week unlock overrides (admin-controlled, applies to everyone) ----------------
-- Reads stay open (just booleans per week, nothing sensitive, and every visitor needs
-- to check these before login to render the correct lock state). Writes only go
-- through set_week_override(), which verifies the caller is really an admin.
create table public.week_overrides (
  week_id text primary key,
  force_unlocked boolean not null default false,
  updated_at timestamptz default now()
);
alter table public.week_overrides enable row level security;
create policy "Open read" on public.week_overrides for select using (true);
-- (no write policy -- writes only via set_week_override() below)

create or replace function public.set_week_override(p_token text, p_week_id text, p_force_unlocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session from public.verify_session(p_token);
  if v_session.user_id is null or v_session.user_type != 'ADMIN' then
    raise exception 'Not authorized';
  end if;

  insert into public.week_overrides (week_id, force_unlocked, updated_at)
  values (p_week_id, p_force_unlocked, now())
  on conflict (week_id) do update set force_unlocked = excluded.force_unlocked, updated_at = now();
end;
$$;
grant execute on function public.set_week_override(text, text, boolean) to anon, authenticated;


-- ---------------- The one admin account: name "alpha", PIN "1010" ----------------
-- Change the PIN below to something less guessable before running, if you like --
-- this is the only credential in this whole file, so it's fine to edit in place.
select public.register_user('alpha', '1010');
update public.users set user_type = 'ADMIN' where name_key = 'alpha';
