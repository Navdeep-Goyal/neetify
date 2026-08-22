-- ============================================================
-- Fix: "invalid base64 end sequence" when calling verify_session (and anything that
-- depends on it: set_week_override, get_my_history, get_all_history_admin,
-- get_user_history_admin).
--
-- Root cause: Postgres's built-in encode(data, 'base64') automatically line-wraps its
-- output with a newline every 76 characters (an old MIME/RFC 2045 convention) -- unlike
-- most other languages' base64 encoders, which just return one continuous string. The
-- session token's payload segment is long enough to cross that threshold, so it always
-- came out with an embedded '\n'. The padding math in verify_session counted that
-- newline as if it were a real character, throwing off the modulo-4 calculation and
-- breaking the decode -- every time, for every token, 100% reproducibly.
--
-- Fix: strip all whitespace from the result of every encode(..., 'base64') call before
-- doing anything else with it, in both mint_session_token (so new tokens never contain
-- one) and verify_session (defensively, and to restore already-issued sessions rather
-- than requiring everyone to log in again).
--
-- Already applied directly against your live database while debugging this -- this
-- file just documents it and keeps supabase_schema.sql's source of truth in sync.
-- Safe to run again if needed (same signatures, no DROP required).
-- ============================================================

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

  header_b64 := rtrim(translate(regexp_replace(encode(convert_to(header, 'utf8'), 'base64'), '\s', '', 'g'), '+/', '-_'), '=');
  payload_b64 := rtrim(translate(regexp_replace(encode(convert_to(payload, 'utf8'), 'base64'), '\s', '', 'g'), '+/', '-_'), '=');
  signing_input := header_b64 || '.' || payload_b64;

  sig := extensions.hmac(signing_input::bytea, public.app_jwt_secret()::bytea, 'sha256');
  sig_b64 := rtrim(translate(regexp_replace(encode(sig, 'base64'), '\s', '', 'g'), '+/', '-_'), '=');

  return signing_input || '.' || sig_b64;
end;
$$;

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
  expected_sig_b64 := rtrim(translate(regexp_replace(encode(expected_sig, 'base64'), '\s', '', 'g'), '+/', '-_'), '=');

  if expected_sig_b64 != sig_b64 then
    return; -- bad signature -- reject
  end if;

  payload_b64 := regexp_replace(payload_b64, '\s', '', 'g'); -- strip whitespace before padding math
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
