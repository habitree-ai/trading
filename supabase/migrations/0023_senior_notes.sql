-- 선배님 아카이브 노트 — 원문(네이버 블로그 pillion21, 760편)에 내 답을 다는 노트.
--
-- 다섯 칸(인용 / 내 생각 / 나에게 적용하면 / 다른 점 / 남는 질문)은 로컬 뷰어
-- `선배님/내생각.html` 의 구조 그대로다. 그 뷰어는 브라우저 저장소에만 남겨 기기마다
-- 달랐다 — 이 표가 정본이 되고, 공개 페이지 `/blog` 가 이것을 읽는다.
--
-- 글 번호(post_id·links)는 네이버 글 URL 끝의 숫자다. 글 목록은 DB 에 두지 않는다 —
-- `선배님/인덱스.csv` 가 정본이고 앱이 그것을 읽어 번호를 제목·날짜로 푼다.

create type public.senior_note_status as enum ('draft', 'done');

create table public.senior_notes (
  id         uuid primary key default gen_random_uuid(),
  -- 쓴 사람 = 관리자. 누가 관리자인지는 앱이 BLOG_ADMIN_EMAILS 로 가른다.
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- 네이버 글 번호. null = 아직 글을 고르지 않은 노트
  post_id    text,
  quote      text not null default '',
  think      text not null default '',
  apply      text not null default '',
  differ     text not null default '',
  ask        text not null default '',
  -- 연결되는 글 번호들 — 20년치 안에서 같은 이야기가 반복되는 지점
  links      text[] not null default '{}',
  tags       text[] not null default '{}',
  status     public.senior_note_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 목록은 최근 고친 순이다.
create index senior_notes_updated_idx on public.senior_notes (updated_at desc);

create trigger senior_notes_touch_updated_at
  before update on public.senior_notes
  for each row execute function public.touch_updated_at();

/* ============ RLS — 읽기는 공개, 쓰기는 본인 행만 ============ */

alter table public.senior_notes enable row level security;

-- 이 표의 내용이 곧 공개 페이지다. 비로그인(anon)도 읽는다 — 다른 표들과 다른 유일한 점.
create policy "senior_notes_public_select" on public.senior_notes for select
  to anon, authenticated using (true);

-- 쓰기는 기존 표들과 같은 소유자 정책. 관리자 판정은 앱(서버 액션)이 먼저 하고,
-- 여기는 액션이 뚫려도 남의 행을 못 건드리게 하는 마지막 방어선이다.
create policy "senior_notes_insert" on public.senior_notes for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "senior_notes_update" on public.senior_notes for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "senior_notes_delete" on public.senior_notes for delete
  to authenticated using ((select auth.uid()) = user_id);
