-- 무포지션 — 내가 눌러서 시작한 "포지션 없음" 구간 (REQ-0087).
--
-- 포지션이 없는 상태는 지금까지 어디에도 기록되지 않았다. 볼 것이 없으니 포지션을 만든다.
-- 무포지션을 선택해서 드는 포지션으로 만들기 위해, 시작을 누른 시각만 남긴다.
--
-- 끝은 저장하지 않는다 — 시작 이후 처음 들어온 거래의 진입 시각이 끝이고, 그 거래는 OKX
-- 동기화가 넣는다. 끝을 따로 적으면 거래 행과 어긋날 수 있는 숫자가 하나 더 생긴다.
--
-- 북 단위다 — 직전 매매·재진입 실측이 전부 그 북의 거래에서 나온다.

create table public.flat_sessions (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 조회 축: 북 → 가장 최근 시작.
create index flat_sessions_book_started_idx
  on public.flat_sessions (book_id, started_at desc);

alter table public.flat_sessions enable row level security;

-- 고치거나 지우는 경로는 없다 — 시작은 누른 그대로 남고, 종결은 거래가 정한다.
create policy "flat_sessions_select" on public.flat_sessions for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "flat_sessions_insert" on public.flat_sessions for insert
  to authenticated with check ((select auth.uid()) = user_id);
