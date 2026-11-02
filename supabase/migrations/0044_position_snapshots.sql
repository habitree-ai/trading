-- 보유 포지션 스냅샷 — 포지션 흐름(책 표 3-6) 의 손절 이동 단계 재료 (REQ-0090).
--
-- 체결(trade_fills)은 진입·추가·청산을 정확한 시각으로 남기지만 손절을 옮긴 기록은 어디에도 없다
-- (거래 행에는 처음 값 okx_stop_first 와 마지막 값 okx_stop_price 뿐). 그래서 동기화가 보유 포지션을 볼 때마다
-- 수량·평단·시세·손절을 한 줄 남긴다 — 직전 줄과 수량·평단·손절이 모두 같으면 남기지 않는다(앱 코드).
--
-- 계산값(CR·E·미실현…)은 저장하지 않는다. 원자료만 두고 화면이 계산한다 — 식을 고쳐도 기록을 다시 쓸 필요가 없다.
-- 한계: 동기화 사이(하루 1회 + 수동)에 옮겼다가 되돌린 손절은 보이지 않는다.

create table public.position_snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  trade_id   uuid not null references public.trades (id) on delete cascade,
  -- 동기화 시각
  at         timestamptz not null,
  -- 코인 수량(계약 수 × 계약 크기)
  qty        numeric not null check (qty >= 0),
  avg_px     numeric not null check (avg_px > 0),
  -- 그 순간 시세 — 없으면 null
  mark_px    numeric,
  -- 그 순간 걸려 있던 손절 — 없으면 null
  stop_px    numeric,
  created_at timestamptz not null default now()
);

create index position_snapshots_trade_at_idx on public.position_snapshots (trade_id, at);
create index position_snapshots_user_idx on public.position_snapshots (user_id);

alter table public.position_snapshots enable row level security;

-- 기록이라 고치는 경로는 없다. 지우는 것은 거래 삭제(cascade)로만.
create policy "position_snapshots_select" on public.position_snapshots for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "position_snapshots_insert" on public.position_snapshots for insert
  to authenticated with check ((select auth.uid()) = user_id);
