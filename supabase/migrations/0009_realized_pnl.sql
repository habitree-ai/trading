-- 실현손익을 거래소가 준 값 그대로 보관한다.
--
-- 지금까지는 `손익 + 수수료 + 펀딩비`로 되짚어 계산했다. 그런데 그 셋 어디에도 실리지
-- 않는 비용이 있다 — 청산 수수료와 ADL이 그렇다.
--
-- 실계좌 46건(2026-07-25 이후)으로 대조한 결과:
--   되짚은 값      pnl(+65.385) + fee(-190.205) + funding(-0.343) = -125.163
--   거래소 realizedPnl                                            = -130.385
-- 5.22 만큼 자금 곡선이 실제 잔액보다 후하게 그려지고 있었다.
--
-- 비워 두면 예전처럼 되짚는다 — 수기 입력 경로에는 이 값이 없기 때문이다.
alter table public.trades add column realized_pnl numeric;

comment on column public.trades.realized_pnl is
  'OKX positions-history `realizedPnl` — 청산 수수료·ADL까지 반영된 실현손익. 비어 있으면 pnl+fee+funding_fee로 되짚는다';
