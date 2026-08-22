-- Run this in the Supabase SQL Editor (Project -> SQL Editor -> New query -> Run)

create table if not exists public.exam_history (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
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

-- Row Level Security: each signed-in user can only ever see/write their own rows.
alter table public.exam_history enable row level security;

create policy "Users can view their own history"
  on public.exam_history for select
  using (auth.uid() = user_id);

create policy "Users can insert their own history"
  on public.exam_history for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own history"
  on public.exam_history for delete
  using (auth.uid() = user_id);

-- Helpful for pulling a user's history quickly.
create index if not exists exam_history_user_id_idx on public.exam_history (user_id);
