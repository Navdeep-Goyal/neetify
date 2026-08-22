-- ============================================================
-- NEET PG site: complete fresh schema (run once against a clean database).
-- Custom name+PIN accounts, no Supabase Auth. Signed session tokens (24h expiry)
-- so "being logged in" is verified server-side, not just trusted from localStorage.
--
-- IMPORTANT -- read this before running:
-- Step 1 below sets a secret used to sign session tokens. Do NOT commit the real
-- secret value into this file or any file in your git repo. Instead:
--   1. Generate/keep a long random value privately (e.g. store it in GitHub ->
--      your repo -> Settings -> Secrets and variables -> Actions, as a personal
--      secure note -- your static site can't read it from there automatically,
--      there's no build step, but it keeps a safe backup copy of it that never
--      touches git history).
--   2. Run the ALTER DATABASE command in Step 1 with that value pasted in directly,
--      typed straight into the SQL Editor -- never save that filled-in version to a file.
--   3. Everything below this file is safe to commit as-is: it never contains the
--      actual secret, only a reference to the database setting.
-- ============================================================

-- ---------------- STEP 1: set the secret (run this line by itself first) ----------------
-- Replace the placeholder with a real random value before running, e.g. generate one with:
--   python3 -c "import secrets; print(secrets.token_hex(32))"
-- Then run ONLY this one line, typed directly (don't save the filled-in version to a file):
--
--   alter database postgres set app.jwt_secret = 'PASTE_YOUR_OWN_RANDOM_SECRET_HERE';
--
-- (If your Supabase project's database is named something other than "postgres", use
-- `select current_database();` to check, and substitute that name instead.)
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
-- Reads the secret from the database setting configured in Step 1 above -- never
-- hardcoded here, so this file is safe to commit to a public repo as-is.
create or replace function public.app_jwt_secret()
returns text
language sql
stable
as $$
  select current_setting('app.jwt_secret', true);
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


-- ---------------- Exam results (kept fully open -- no per-row security, per project scope) ----------------
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
create policy "Open read" on public.exam_history for select using (true);
create policy "Open insert" on public.exam_history for insert with check (true);


-- ---------------- Week unlock overrides (admin-controlled, applies to everyone) ----------------
create table public.week_overrides (
  week_id text primary key,
  force_unlocked boolean not null default false,
  updated_at timestamptz default now()
);

alter table public.week_overrides enable row level security;
create policy "Open read" on public.week_overrides for select using (true);
create policy "Open write" on public.week_overrides for all using (true) with check (true);


-- ---------------- The one admin account: name "alpha", PIN "1010" ----------------
-- Change the PIN below to something less guessable before running, if you like --
-- this is the only credential in this whole file, so it's fine to edit in place.
select public.register_user('alpha', '1010');
update public.users set user_type = 'ADMIN' where name_key = 'alpha';
