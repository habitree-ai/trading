-- 시장 위·아래 열림/닫힘 — 진입 시점에 사람이 고른 4분류(REQ-0050, 선배님 「질문과 답 2.」).
--
-- 장기추세(trend)가 고점·저점 갱신 방향을 묻는다면, 이 칸은 위·아래 각각이 막혀 있는가를 묻는다.
-- 네 경우가 모든 조합을 덮지 않아("둘 다 모름" 없음) 근거 게이트 필수가 아니다 — null 은 미기재.
-- 손 입력 전용: 동기화(src/lib/okx/map.ts)는 이 칸을 건드리지 않는다.
create type public.market_openness as enum ('both_open', 'both_closed', 'top_closed', 'bottom_closed');

alter table public.trades add column openness public.market_openness;

comment on column public.trades.openness is
  '진입 시점의 시장 위·아래 판단 — both_open 위·아래 열림 / both_closed 위·아래 닫힘 / top_closed 위 닫힘(아래 모름) / bottom_closed 아래 닫힘(위 모름). 손 입력 전용, null 은 미기재.';
