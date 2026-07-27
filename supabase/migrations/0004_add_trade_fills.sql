-- 개별 체결 내역.
--
-- 분할 진입·분할 청산이면 거래의 entry_price/exit_price 는 가중평균가인데,
-- 평균가는 어느 한 시점의 가격이 아니다. 그래서 차트에 한 점으로 찍으면
-- 캔들 범위 밖으로 떠버린다(청산 평균 65,265 vs 그 시각 캔들 고가 65,063).
-- 체결을 낱개로 남겨 실제 (시각, 가격) 좌표에 찍을 수 있게 한다.
create type public.fill_role as enum ('open', 'close');

create table public.trade_fills (
  id         uuid primary key default gen_random_uuid(),
  trade_id   uuid not null references public.trades (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.fill_role not null,
  filled_at  timestamptz not null,
  price      numeric not null,
  amount     numeric,   -- 체결 금액(견적통화). OKX `Filled`
  fee        numeric,
  created_at timestamptz not null default now()
);

create index trade_fills_trade_idx on public.trade_fills (trade_id, filled_at);

alter table public.trade_fills enable row level security;

create policy "trade_fills_select" on public.trade_fills for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trade_fills_insert" on public.trade_fills for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trade_fills_update" on public.trade_fills for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "trade_fills_delete" on public.trade_fills for delete
  to authenticated using ((select auth.uid()) = user_id);
