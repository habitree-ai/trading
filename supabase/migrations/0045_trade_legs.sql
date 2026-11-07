-- 추가 진입 다리 — 추가를 결정한 순간의 의도·구간·공통 손절·체크리스트·시장 지표 원값 (MER 피라미딩, REQ-0102).
--
-- 체결(trade_fills)은 사실이고 이 표는 판단과 그 순간의 시장 관측값이다. 둘은 화면에서 시각 근접(±10분)으로
-- 잇는다 — 동기화(sync.ts)는 건드리지 않는다. 사람이 고르면 fill_id 로 고정한다.
--
-- 결과 R·MER 은 저장하지 않는다(0044 원칙). 원자료만 두고 화면이 계산한다 — 식을 고쳐도 기록을 다시 쓸 필요가 없다.
-- signals 는 LegSignals, checklist 는 CheckItem[] 8줄 — 앱이 legs.ts 의 parse 함수로 읽고, 한 칸이라도 깨지면 버린다.

create table public.trade_legs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  trade_id    uuid not null references public.trades (id) on delete cascade,
  -- 1부터. 최초 진입(다리 0)은 거래 행 자체
  leg_no      int  not null check (leg_no >= 1),
  -- 다리 기록 시각
  at          timestamptz not null,
  -- 추가가(의도)
  price       numeric not null check (price > 0),
  -- 코인 수량
  qty         numeric not null check (qty > 0),
  -- 최초 손절폭의 R 배수. 구간 밖이면 null
  zone_r      numeric,
  common_stop numeric check (common_stop > 0),
  fill_id     uuid references public.trade_fills (id) on delete set null,
  -- LegSignals
  signals     jsonb,
  -- CheckItem[] 8줄
  checklist   jsonb,
  note        text,
  created_at  timestamptz not null default now(),
  unique (trade_id, leg_no)
);

create index trade_legs_trade_idx on public.trade_legs (trade_id, leg_no);
create index trade_legs_user_at_idx on public.trade_legs (user_id, at);

alter table public.trade_legs enable row level security;

-- 판단 기록이라 잘못 적었으면 고치거나 지울 수 있다(체결 연결 fill_id 도 사람이 고른다).
create policy "trade_legs_select" on public.trade_legs for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trade_legs_insert" on public.trade_legs for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trade_legs_update" on public.trade_legs for update
  to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "trade_legs_delete" on public.trade_legs for delete
  to authenticated using ((select auth.uid()) = user_id);
