-- 거래소에 실제로 걸려 있던 손절·익절을 거래 행에 남긴다.
--
-- 손으로 적는 `stop_price`/`tp1_price` 와 칸을 나누는 이유는 둘이 다른 값이기 때문이다.
-- 앞의 것은 "얼마에 끊으려 했나"(계획)이고, 이 칸은 "실제로 얼마가 걸려 있었나"(사실)다.
-- 한 칸에 섞으면 계획 대비 결과를 되짚을 수 없고, 무엇보다 `stop_price` 는 동기화가
-- 건드리지 않기로 정해 둔 칸이다(src/lib/okx/map.ts toCloseUpdate).
--
-- 값의 출처가 세 갈래고 신뢰도가 다르다. `okx_sl_source` 로 어느 경로였는지 남긴다 —
-- `algo` 는 알고 주문에 posId 가 없어 종목·방향·시간창으로 이어붙인 추정이고,
-- 나머지 둘은 식별자가 일치한 사실이다. 나중에 숫자가 이상하면 여기부터 의심한다.
create type public.okx_sl_source as enum ('attached', 'position', 'algo');

alter table public.trades
  add column okx_stop_price numeric,
  add column okx_tp_price   numeric,
  add column okx_sl_source  public.okx_sl_source;

comment on column public.trades.okx_stop_price is
  '거래소에 등록돼 있던 손절 트리거가(slTriggerPx). 한 포지션에 손절이 여러 번 걸렸으면 **마지막에 등록된 값**이다 — 진입 시점 값이 아니다. 못 찾았거나 어느 포지션의 것인지 가릴 수 없으면 null.';

comment on column public.trades.okx_tp_price is
  '거래소에 등록돼 있던 익절 트리거가(tpTriggerPx). 손절과 같은 레코드에서 읽는다. 익절을 걸지 않은 거래가 대부분이라 보통 null 이다.';

comment on column public.trades.okx_sl_source is
  '위 두 값을 어느 경로로 얻었는지. attached=진입 주문에 부착된 브래킷(ordId 일치), position=미청산 포지션의 closeOrderAlgo(posId 일치), algo=알고 주문 이력을 종목·방향·시간창으로 매칭(추정).';
