-- 지정가 청산 주문으로 건 TP 를 TP1~3 에 자동 입력 (REQ-0096, 11-02 사용자 지시).
--
-- 10-27 부터 TP 를 거래소 TP/SL(알고 주문)이 아니라 감소 전용 지정가 주문으로 건다. 동기화는 알고 TP 만 읽어
-- TP 칸이 비어 있었다. 보유 중 동기화가 걸려 있는 지정가 청산 주문(이익 쪽, 최대 3개)을 [{px, pct}] 로 싣고,
-- 이 함수가 **처음 본 묶음만** 지킨 뒤 TP1~3 가 모두 비어 있을 때 한 번 채운다 — 0042 와 같은 규칙.
-- 지정가 묶음이 알고 TP 보다 먼저다(가격·비중이 다 있다). 알고 TP 는 TP1 이 그래도 비어 있을 때만.

alter table public.trades
  add column okx_tp_limits_first jsonb;

comment on column public.trades.okx_tp_limits_first is
  '처음 본 지정가 청산(TP) 주문 묶음 — [{"px": 가격, "pct": 보유 수량 대비 %}], 진입가에서 가까운 순 최대 3개. 한 번 정해지면 트리거가 지킨다. REQ-0096';

create or replace function public.trades_prefill_plan_stop_tp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  lim jsonb;
begin
  if tg_op = 'UPDATE' then
    new.okx_tp_limits_first := coalesce(old.okx_tp_limits_first, new.okx_tp_limits_first);
  end if;

  if new.okx_stop_first is not null and new.stop_price is null
     and (tg_op = 'INSERT' or old.okx_stop_first is null) then
    new.stop_price := new.okx_stop_first;
  end if;

  lim := new.okx_tp_limits_first;
  if lim is not null and jsonb_typeof(lim) = 'array' and jsonb_array_length(lim) > 0
     and (tg_op = 'INSERT' or old.okx_tp_limits_first is null)
     and new.tp1_price is null and new.tp2_price is null and new.tp3_price is null then
    new.tp1_price := (lim -> 0 ->> 'px')::numeric;
    new.tp1_pct   := (lim -> 0 ->> 'pct')::numeric;
    new.tp2_price := (lim -> 1 ->> 'px')::numeric;
    new.tp2_pct   := (lim -> 1 ->> 'pct')::numeric;
    new.tp3_price := (lim -> 2 ->> 'px')::numeric;
    new.tp3_pct   := (lim -> 2 ->> 'pct')::numeric;
  end if;

  if new.okx_tp_first is not null and new.tp1_price is null
     and (tg_op = 'INSERT' or old.okx_tp_first is null) then
    new.tp1_price := new.okx_tp_first;
  end if;
  return new;
end;
$$;
