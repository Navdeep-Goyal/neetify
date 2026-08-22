-- ============================================================
-- Security fix #2: close the open admin/write holes.
-- Run this on top of your existing schema (safe, additive/idempotent).
--
-- What this fixes: previously, week_overrides and exam_history accepted writes from
-- ANYONE with the public anon key -- no login, no token, nothing. Anyone could force-
-- unlock any week for everyone, or insert fake exam results under any user's name,
-- just by calling the Supabase REST API directly (not even through the site's UI).
--
-- After this: week_overrides can only be changed through set_week_override(), which
-- verifies the caller's session token really belongs to an ADMIN before writing.
-- exam_history can only be inserted through submit_exam_result(), which derives the
-- user_id/user_name from the verified token itself -- a caller can no longer claim to
-- be someone else. Reads go through get_my_history() (your own results only) and, for
-- admins, get_all_history_admin()/get_user_history_admin() (verified admin-only).
-- ============================================================

-- ---------------- Exam result submission (identity comes from the verified token) ----------------
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

-- ---------------- Reading your own results ----------------
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

-- ---------------- Admin: read every user's results, or one user's results ----------------
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

-- ---------------- Admin-only week unlock control ----------------
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

-- ---------------- Remove the open policies -- all writes now go through the functions above ----------------
drop policy if exists "Open insert" on public.exam_history;
drop policy if exists "Open write" on public.week_overrides;
-- exam_history and week_overrides keep zero table-level write policies now (RLS with no
-- policy = default-deny), so direct API writes are blocked entirely -- only the
-- SECURITY DEFINER functions above (which run with elevated privilege internally) can write.

-- exam_history's direct "Open read" policy is also removed: reads now go through
-- get_my_history()/get_all_history_admin()/get_user_history_admin() instead, so a
-- regular user can no longer read anyone else's results via a direct API call.
drop policy if exists "Open read" on public.exam_history;

-- week_overrides read access stays open (just booleans per week, nothing sensitive,
-- and every visitor needs to check these before login to render the correct lock state).
