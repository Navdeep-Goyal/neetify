-- ============================================================
-- Security fix #1 of N: real session tokens instead of a trusted-blind localStorage object.
-- Run this in the SQL Editor AFTER supabase_schema.sql (safe to run on top of your
-- existing tables -- this only adds things, it doesn't touch users/exam_history/week_overrides).
--
-- What this fixes: previously, "being logged in" was just a plain JS object saved in
-- the browser's localStorage, and nothing ever re-checked it against the server. Anyone
-- could open dev tools and set that object's userType to "ADMIN" directly -- no PIN, no
-- login, nothing -- and the app would believe them. Now, register/login return a signed
-- token (24h expiry) that the app re-verifies with the server on every visit. Even if
-- someone edits localStorage, verify_session() below always re-derives the *real* id/
-- name/user_type from the database via the token's cryptographic signature -- a forged
-- localStorage object no longer has any effect.
--
-- What this does NOT yet fix: exam_history and week_overrides are still open to writes
-- from anyone with the public key, token or not. That's the next "one by one" step --
-- ask for it whenever you're ready and I'll route those through this same token check.
-- ============================================================

create extension if not exists pgjwt cascade;

-- This secret is ours alone -- entirely unrelated to any Supabase-managed key, and not
-- affected by anything Supabase does with their own JWT signing infrastructure. Treat it
-- like a password: don't post it publicly. Rotating it just logs everyone out at once.
-- (Generated once for this project: keep this exact value unless you deliberately rotate it.)
create or replace function public.app_jwt_secret()
returns text
language sql
immutable
as $$
  select '3a0569979dc46a0dee51214630d90d30c377188cfc3b58174e4644cd679dc91a'::text;
$$;

-- Mint a 24-hour session token for a given user.
create or replace function public.mint_session_token(p_user_id uuid, p_user_type text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return sign(
    json_build_object(
      'sub', p_user_id::text,
      'user_type', p_user_type,
      'exp', extract(epoch from (now() + interval '24 hours'))::integer
    ),
    public.app_jwt_secret()
  );
end;
$$;

-- Verify a session token and return the CURRENT, real id/name/user_type from the
-- database (not whatever the client claims) -- or zero rows if invalid/expired.
create or replace function public.verify_session(p_token text)
returns table(user_id uuid, name text, user_type text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row record;
  v_uid uuid;
begin
  if p_token is null or p_token = '' then
    return;
  end if;

  select * into v_row from verify(p_token, public.app_jwt_secret());
  if v_row.valid is not true then
    return; -- bad signature -- reject
  end if;
  if (v_row.payload->>'exp')::bigint < extract(epoch from now())::bigint then
    return; -- expired -- reject, forcing re-login
  end if;

  v_uid := (v_row.payload->>'sub')::uuid;
  return query select u.id, u.name, u.user_type from public.users u where u.id = v_uid;
end;
$$;
grant execute on function public.verify_session(text) to anon, authenticated;

-- register_user / login_user now also return a token alongside id/name/user_type.
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
