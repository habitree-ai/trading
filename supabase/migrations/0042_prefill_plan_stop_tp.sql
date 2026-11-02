-- 거래소 처음 건 손절·TP 를 계획 칸에 자동 입력 (REQ-0094, 11-02 사용자 결정).
--
-- 동기화는 손으로 적는 칸(stop_price·tp1_price)을 건드리지 않는다. 그래서 거래소에 건 손절·TP 가 있어도
-- 거래 수정 화면의 칸은 비어 있었다. 처음 건 값(okx_stop_first·okx_tp_first)이 **처음 들어오는 순간**,
-- 칸이 비어 있을 때만 채운다 — 이후 사용자가 고치거나 지운 값은 다시 덮지 않는다.
-- 과거 거래는 처음 값이 이미 들어 있어 이 트리거가 채우지 않는다(기존 데이터는 그대로).
--
-- 트리거 이름 순서상 trades_pin_stop_px_0 **뒤에** 돈다(pin < prefill). 그래서 최초 손절의 출처는
-- 거래소(okx_first)로 남고, 여기서 채운 stop_price 때문에 'plan' 으로 바뀌지 않는다.

create function public.trades_prefill_plan_stop_tp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.okx_stop_first is not null and new.stop_price is null
     and (tg_op = 'INSERT' or old.okx_stop_first is null) then
    new.stop_price := new.okx_stop_first;
  end if;
  if new.okx_tp_first is not null and new.tp1_price is null
     and (tg_op = 'INSERT' or old.okx_tp_first is null) then
    new.tp1_price := new.okx_tp_first;
  end if;
  return new;
end;
$$;

create trigger trades_prefill_plan_stop_tp
  before insert or update on public.trades
  for each row execute function public.trades_prefill_plan_stop_tp();
