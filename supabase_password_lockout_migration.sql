-- ============================================================
-- Security fix #4: account lockout (brute-force protection) + strong password rules.
-- Run this on top of your existing schema (safe, additive/idempotent).
--
-- Part A -- Lockout: after 10 failed login attempts on an account, that account is
-- locked for 15 minutes (even if the correct password is tried during the lockout).
-- A successful login resets the counter. This turns "crackable in seconds" into
-- "capped at ~1000 guesses/day" regardless of how fast an attacker can send requests.
--
-- Part B -- Password rules: registration now requires 8+ characters with at least one
-- uppercase letter, one lowercase letter, one number, and one special character.
-- Existing accounts (created under the old 4-digit PIN rule) are NOT affected -- they
-- can still log in with whatever they already have; the new rules only apply to new
-- registrations going forward.
-- ============================================================

alter table public.users add column if not exists failed_attempts int not null default 0;
alter table public.users add column if not exists locked_until timestamptz;

create or replace function public.login_user(p_name text, p_pin text)
returns table(id uuid, name text, user_type text, token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := lower(trim(p_name));
  v_row record;
  v_seconds_remaining int;
begin
  select * into v_row from public.users where name_key = v_key;

  if v_row.id is null then
    return; -- no such account -- zero rows, same as before
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    v_seconds_remaining := ceil(extract(epoch from (v_row.locked_until - now())));
    raise exception 'ACCOUNT_LOCKED:%', v_seconds_remaining;
  end if;

  if v_row.pin_hash = crypt(p_pin, v_row.pin_hash) then
    -- correct credentials -- clear any failure tracking
    update public.users u set failed_attempts = 0, locked_until = null where u.id = v_row.id;
    return query select v_row.id, v_row.name, v_row.user_type, public.mint_session_token(v_row.id, v_row.user_type);
  else
    -- wrong credentials -- count it, and lock out once the threshold is hit
    update public.users u
      set failed_attempts = case when u.failed_attempts + 1 >= 10 then 0 else u.failed_attempts + 1 end,
          locked_until = case when u.failed_attempts + 1 >= 10 then now() + interval '15 minutes' else u.locked_until end
      where u.id = v_row.id;
    return; -- zero rows, same as before (doesn't reveal whether lockout just triggered)
  end if;
end;
$$;
grant execute on function public.login_user(text, text) to anon, authenticated;

-- Postgres won't let CREATE OR REPLACE change a function's return type, and this one's
-- signature stays identical (text, text) -- so no explicit DROP is needed here, but
-- register_user's BODY is changing to enforce the new password rules server-side (so a
-- bypassed client can't skip them by calling the RPC directly).
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
  if length(p_pin) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;
  if p_pin !~ '[A-Z]' then
    raise exception 'Password must contain at least one uppercase letter';
  end if;
  if p_pin !~ '[a-z]' then
    raise exception 'Password must contain at least one lowercase letter';
  end if;
  if p_pin !~ '[0-9]' then
    raise exception 'Password must contain at least one number';
  end if;
  if p_pin !~ '[^A-Za-z0-9]' then
    raise exception 'Password must contain at least one special character';
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
