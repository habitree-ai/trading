-- 거래소 청산 캡쳐(OKX Order details)의 1급 정보 두 가지를 담는다.
-- 시트에는 없던 항목이지만, pnl ≒ 투입 × (청산가 − 진입가) / 진입가 교차검증에 필요하다.
alter table public.trades
  add column exit_price numeric,   -- OKX `Fill price`
  add column fee        numeric;   -- OKX `Fee` (음수)

comment on column public.trades.exit_price is '청산가 — 거래소 캡쳐의 Fill price';
comment on column public.trades.fee is '수수료 — 부호 포함(보통 음수)';
