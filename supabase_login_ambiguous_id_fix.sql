-- ============================================================
-- Fix: "column reference id is ambiguous" in login_user.
--
-- Cause: login_user's RETURNS TABLE(id uuid, name text, user_type text, token text)
-- implicitly creates a PL/pgSQL variable named "id" in the function's own scope
-- (a quirk of RETURNS TABLE -- it declares each column as an OUT parameter/variable).
-- The UPDATE statements' bare "where id = v_row.id" couldn't tell whether "id" meant
-- that OUT variable or the users.id column, so Postgres correctly refused to guess.
--
-- Fix: qualify the column with a table alias so there's no ambiguity.
-- Safe to run on top of your current schema -- same signature, no DROP needed.
-- ============================================================

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
    return; -- no such account -- zero rows
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    v_seconds_remaining := ceil(extract(epoch from (v_row.locked_until - now())));
    raise exception 'ACCOUNT_LOCKED:%', v_seconds_remaining;
  end if;

  if v_row.pin_hash = crypt(p_pin, v_row.pin_hash) then
    update public.users u set failed_attempts = 0, locked_until = null where u.id = v_row.id;
    return query select v_row.id, v_row.name, v_row.user_type, public.mint_session_token(v_row.id, v_row.user_type);
  else
    update public.users u
      set failed_attempts = case when u.failed_attempts + 1 >= 10 then 0 else u.failed_attempts + 1 end,
          locked_until = case when u.failed_attempts + 1 >= 10 then now() + interval '15 minutes' else u.locked_until end
      where u.id = v_row.id;
    return; -- zero rows
  end if;
end;
$$;
grant execute on function public.login_user(text, text) to anon, authenticated;
