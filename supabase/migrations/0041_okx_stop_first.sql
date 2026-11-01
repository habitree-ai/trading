-- 처음 건 손절·TP (REQ-0093).
--
-- okx_stop_price·okx_tp_price 는 **마지막에** 걸린 값이다(차트 손절선). 손절을 옮긴 거래는 그 값이 진입 때
-- 위험이 아니라, R 의 최초 손절(stop_px_0)이 「마지막 거래소 손절(okx_last, 추정)」으로 220건이 잡혀 있었다.
-- OKX 알고 주문 이력(보관 3개월)에는 처음 건 손절이 남아 있다(REQ-0092: Repeatable 143/159 손실 쪽).
-- 동기화가 처음 값을 따로 싣고, 최초 손절은 계획 손절 → 처음 건 거래소 손절 → 마지막 거래소 손절 순으로 정한다.

alter table public.trades
  add column okx_stop_first numeric,
  add column okx_tp_first   numeric;

comment on column public.trades.okx_stop_first is
  '처음 건 거래소 손절 트리거가 — 부착 주문 또는 알고 주문 이력의 가장 이른 값. 한 번 정해지면 트리거가 지킨다. REQ-0093';
comment on column public.trades.okx_tp_first is
  '처음 건 거래소 익절 트리거가. 한 번 정해지면 트리거가 지킨다. REQ-0093';

-- 과거 거래 보정 전 값 — 되돌릴 수 있게. 보정 스크립트(service role)가 쓰고, 화면은 읽기만.
create table public.trade_stop_backfill (
  id             uuid primary key default gen_random_uuid(),
  trade_id       uuid not null references public.trades (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  old_stop_px_0  numeric,
  old_source     text,
  new_stop_px_0  numeric,
  new_source     text,
  created_at     timestamptz not null default now()
);

create index trade_stop_backfill_trade_idx on public.trade_stop_backfill (trade_id);

alter table public.trade_stop_backfill enable row level security;

create policy "trade_stop_backfill_select" on public.trade_stop_backfill for select
  to authenticated using ((select auth.uid()) = user_id);

create or replace function public.trades_pin_stop_px_0()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  first_is_loss boolean;
begin
  if tg_op = 'UPDATE' then
    new.stop_px_0 := coalesce(new.stop_px_0, old.stop_px_0);
    new.stop_px_0_source := coalesce(new.stop_px_0_source, old.stop_px_0_source);
    -- 처음 값은 처음 정해진 것을 지킨다 — 나중 동기화가 늦게 본 값으로 덮지 못하게.
    new.okx_stop_first := coalesce(old.okx_stop_first, new.okx_stop_first);
    new.okx_tp_first := coalesce(old.okx_tp_first, new.okx_tp_first);
  end if;

  -- 처음 건 거래소 손절이 진입가 기준 손실 쪽인가 — 이익 쪽이면 이미 옮겨진 값이라 최초 위험이 아니다.
  first_is_loss := new.okx_stop_first is not null and new.entry_price is not null and (
    (new.side = 'long' and new.okx_stop_first < new.entry_price) or
    (new.side = 'short' and new.okx_stop_first > new.entry_price)
  );

  if new.stop_px_0 is null then
    if new.stop_price is not null then
      new.stop_px_0 := new.stop_price;
      new.stop_px_0_source := 'plan';
    elsif first_is_loss then
      new.stop_px_0 := new.okx_stop_first;
      new.stop_px_0_source := 'okx_first';
    elsif new.okx_stop_price is not null then
      new.stop_px_0 := new.okx_stop_price;
      new.stop_px_0_source := case when new.exit_at is null then 'okx_first' else 'okx_last' end;
    end if;
  elsif tg_op = 'UPDATE' and old.okx_stop_first is null and first_is_loss
        and new.stop_px_0_source in ('okx_first', 'okx_last') then
    -- 처음 값이 이번에 처음 들어왔다 — 거래소 손절로 잡아 둔 최초 손절을 그 값으로 올린다(계획 손절은 그대로).
    new.stop_px_0 := new.okx_stop_first;
    new.stop_px_0_source := 'okx_first';
  end if;
  return new;
end;
$$;
