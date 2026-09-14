-- 방향·진입 시계열 허용값 넓히기 (REQ-0063).
--
--   방향: 4H / 1D / 1W   →  15m / 1H / 4H / 1D / 1W
--   진입: 15m / 1H / 4H  →  1m / 5m / 15m / 1H / 4H
--
-- 0031 은 두 목록이 겹치지 않게 잡아 "방향 ≥ 진입"이 저절로 지켜졌다. 이제 방향 15분 · 진입 4시간
-- 같은 조합도 저장된다 — 조합은 막지 않기로 했다(2026-09-14 사용자 결정). 각 칸의 허용값만 검사한다.
-- 목록은 src/lib/domain.ts 의 BIAS_TIMEFRAMES / ENTRY_TIMEFRAMES 와 같아야 한다. 어긋나면 화면에서
-- 고를 수 있는 값이 저장에서 거부된다.
--
-- 기존 행의 값은 모두 새 목록의 부분집합이라 제약을 다시 걸 때 거부되는 행이 없다.
alter table public.trades drop constraint trades_timeframe_bias_allowed;
alter table public.trades add constraint trades_timeframe_bias_allowed
  check (timeframe_bias is null or timeframe_bias in ('15m', '1H', '4H', '1D', '1W'));

alter table public.trades drop constraint trades_timeframe_entry_allowed;
alter table public.trades add constraint trades_timeframe_entry_allowed
  check (timeframe_entry is null or timeframe_entry in ('1m', '5m', '15m', '1H', '4H'));

comment on column public.trades.timeframe_bias is
  '방향 판단 시계열 — 15m / 1H / 4H(기본) / 1D / 1W. 어느 봉에서 추세와 지지·저항을 봤는가. 손 입력 전용, null 은 미기재.';
comment on column public.trades.timeframe_entry is
  '진입 시계열 — 1m / 5m / 15m / 1H(기본) / 4H. 어느 봉에서 타이밍을 잡았는가. 손 입력 전용, null 은 미기재.';
