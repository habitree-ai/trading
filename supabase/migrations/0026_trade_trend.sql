-- 장기추세 판단 — 진입 시점에 사람이 고른 중장기 국면(REQ-0045).
--
-- 근거 문장 안에 "장기적 상승구간"처럼 묻혀 있던 판단을 칸으로 뽑는다. 역추세 진입(상승 판단 + 숏)을
-- 복기에서 걸러내고, 자동매매로 옮길 때 "허용 방향" 필터의 입력이 된다.
-- 거래 단위다 — 북·시장 단위 설정은 이력이 남지 않아 "그때 무엇으로 봤나"를 되짚을 수 없다.
-- 손 입력 전용: 동기화(src/lib/okx/map.ts)는 이 칸을 건드리지 않는다. 기존 거래는 null(미기재).
create type public.trend_regime as enum ('up', 'down', 'range');

alter table public.trades add column trend public.trend_regime;

comment on column public.trades.trend is
  '진입 시점의 장기추세 판단 — up 상승추세 / down 하락추세 / range 기간조정. 손 입력 전용, null 은 미기재.';
