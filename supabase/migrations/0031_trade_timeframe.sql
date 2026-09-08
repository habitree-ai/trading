-- 거래의 기준 시계열 — 방향을 어디서 보고 진입을 어디서 잡았는가 (REQ-0053).
--
-- 계측기(Repeatable 북)의 목적은 "규칙을 지켰는가"를 재는 것인데, 기준 캔들이 남지 않으면
-- 손절 폭이 그 시계열에 맞는 폭이었는지, 보유 시간이 그 시계열에 맞았는지를 판정할 수 없다.
-- 예: 4시간봉으로 방향을 봤다면서 20분 만에 청산했는가, 1시간봉 진입인데 손절이 0.2%인가.
--
-- 표기는 OKX bar 파라미터·캔들 캐시 파일명(oneway-4H.json)과 같은 형식이라 그대로 보여 준다.
-- 손 입력 전용: 동기화(src/lib/okx/map.ts)는 이 칸을 건드리지 않는다.
create type public.timeframe as enum ('15m', '1H', '4H', '1D', '1W');

-- DEFAULT 를 걸지 않는다. Postgres 11+ 의 `add column ... default` 는 기존 행까지 채우는데,
-- 시계열 기준은 2026-09-08 에 정해졌으므로 그 이전 거래에 값이 생기면 사실과 다른 기록이 된다.
-- 기본값(4H / 1H)은 UI 에서만 준다. null 은 미기재.
alter table public.trades add column timeframe_bias public.timeframe;
alter table public.trades add column timeframe_entry public.timeframe;

-- 방향은 진입보다 크거나 같은 시계열에서 본다. 값을 UI 에서만 제한하면 잘못된 조합이
-- 데이터에 남을 수 있고, 틀린 숫자를 보여 주는 것은 아무것도 안 보여 주는 것보다 나쁘다.
alter table public.trades add constraint trades_timeframe_bias_allowed
  check (timeframe_bias is null or timeframe_bias in ('4H', '1D', '1W'));
alter table public.trades add constraint trades_timeframe_entry_allowed
  check (timeframe_entry is null or timeframe_entry in ('15m', '1H', '4H'));

comment on column public.trades.timeframe_bias is
  '방향 판단 시계열 — 4H(기본) / 1D / 1W. 어느 봉에서 추세와 지지·저항을 봤는가. 손 입력 전용, null 은 미기재.';
comment on column public.trades.timeframe_entry is
  '진입 시계열 — 15m / 1H(기본) / 4H. 어느 봉에서 타이밍을 잡았는가. 손 입력 전용, null 은 미기재.';
