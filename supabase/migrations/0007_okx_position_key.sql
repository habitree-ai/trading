-- 거래 중복 방지 열쇠를 바로잡는다.
--
-- posId 를 거래 하나를 가리키는 값으로 잘못 봤다. 실제로는 "종목·방향별 포지션
-- 슬롯 ID"라서 같은 종목을 다시 잡으면 그대로 재사용된다 — 실계좌 100건을 받아
-- 보니 고유 posId 가 6개뿐이었고, 두 번째 거래부터 유니크 제약에 걸렸다.
--
-- 거래 하나를 가리키는 건 posId + 청산 시각이다. 청산 시각은 이미 exit_at 으로
-- 저장하므로 새 컬럼 없이 제약만 넓힌다.
drop index if exists public.trades_okx_pos_id_uniq;

create unique index trades_okx_position_uniq
  on public.trades (user_id, okx_pos_id, exit_at)
  where okx_pos_id is not null;

comment on column public.trades.okx_pos_id is
  'OKX positions-history `posId` — 포지션 슬롯 id다. 같은 종목·방향을 다시 잡으면 재사용되므로 청산 시각(exit_at)과 함께여야 거래 하나를 가리킨다';
