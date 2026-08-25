-- 분할 청산 계획 — TP 단계마다 덜어낼 비중(%).
--
-- 가격만으로는 "TP1에서 얼마를 챙기려 했나"가 없어 금액·수익률을 낼 수 없다.
-- 파생값이 아니라 사람이 정한 계획(원자값)이라 저장한다 — 금액·R·수익률은 화면에서 계산한다.
-- 손 입력 전용: 동기화(src/lib/okx/map.ts toOpenUpdate/toCloseUpdate)는 이 칸을 건드리지 않는다.
--
-- 셋 다 비어 있으면 "가격이 있는 TP 수로 균등"으로 읽고, 하나라도 적혀 있으면 빈 칸은 0 이다 —
-- 그래서 default 를 두지 않는다. 합이 100 이 아닌 것은 폼이 경고할 뿐 DB 는 막지 않는다
-- (계획은 고쳐 가며 적는다). 단위는 폼에 적은 그대로 % 다(0~1 소수로 바꾸면 폼 왕복에서 흔들린다).
alter table public.trades
  add column tp1_pct numeric check (tp1_pct > 0 and tp1_pct <= 100),
  add column tp2_pct numeric check (tp2_pct > 0 and tp2_pct <= 100),
  add column tp3_pct numeric check (tp3_pct > 0 and tp3_pct <= 100);

comment on column public.trades.tp1_pct is
  'TP1에서 청산할 비중(%, 0 초과 100 이하). 손 입력 계획값. 셋 다 null 이면 가격 있는 TP 수로 균등, 하나라도 있으면 null 은 0.';
comment on column public.trades.tp2_pct is 'TP2 비중. tp1_pct 와 같은 규칙.';
comment on column public.trades.tp3_pct is 'TP3 비중. tp1_pct 와 같은 규칙.';
