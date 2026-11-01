-- 최초 손절의 출처 (REQ-0089 후속, 11-01 사용자 결정).
--
-- 0039 는 계획 손절(stop_price)만 최초 손절로 받았는데, 계획 손절을 적은 거래가 드물다
-- (Repeatable 청산 159건 중 26건, 지금 북 53건 중 1건). 명세 데이터 표대로
-- "계획 손절, 없으면 거래소 손절"로 넓히고, 어느 쪽인지 칸으로 남긴다:
--
--   plan      — 계획 손절이 처음 적힌 값
--   okx_first — 보유 중 동기화가 처음 본 거래소 손절(진입 순간에 가장 가까운 사실)
--   okx_last  — 과거·청산 거래에 남아 있던 거래소 손절. 한 포지션에 여러 번 걸렸으면 **마지막** 값이라
--               손절을 옮긴 거래는 최초 위험이 틀린다. 이익 쪽이면 R 계산이 미측정으로 뺀다. 화면은 이 건수를 따로 보인다

alter table public.trades
  add column stop_px_0_source text
    check (stop_px_0_source in ('plan', 'okx_first', 'okx_last'));

comment on column public.trades.stop_px_0_source is
  '최초 손절(stop_px_0)의 출처 — plan(계획 손절) / okx_first(보유 중 처음 본 거래소 손절) / okx_last(과거 거래의 마지막 거래소 손절, 추정). REQ-0089';

update public.trades set stop_px_0_source = 'plan' where stop_px_0 is not null;

update public.trades
   set stop_px_0 = okx_stop_price, stop_px_0_source = 'okx_last'
 where stop_px_0 is null and okx_stop_price is not null;

create or replace function public.trades_pin_stop_px_0()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.stop_px_0 := coalesce(new.stop_px_0, old.stop_px_0);
    new.stop_px_0_source := coalesce(new.stop_px_0_source, old.stop_px_0_source);
  end if;
  if new.stop_px_0 is null then
    if new.stop_price is not null then
      new.stop_px_0 := new.stop_price;
      new.stop_px_0_source := 'plan';
    elsif new.okx_stop_price is not null then
      new.stop_px_0 := new.okx_stop_price;
      -- 청산된 행에 뒤늦게 붙은 거래소 손절은 처음 본 값이 아니다
      new.stop_px_0_source := case when new.exit_at is null then 'okx_first' else 'okx_last' end;
    end if;
  end if;
  return new;
end;
$$;
