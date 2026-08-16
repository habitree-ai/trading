-- 차트 메모의 선 스타일 — 색만 고르던 것을 굵기·선 종류까지 넓힌다.
--
-- 4분할 차트에서 시작한 스타일 편집(색·굵기·실선/파선/점선)을 복기 차트에도 얹는다.
-- 복기 메모는 DB에 살므로 값이 여기 남아야 새로고침해도 유지된다.
--
-- 둘 다 null 허용 — 기존 행과 값을 안 고른 메모는 화면 기본값(실선·기본 굵기)으로
-- 그려진다. 기본값을 DB에 박으면 화면 기본을 바꿀 때마다 마이그레이션이 필요해진다.

alter table public.trade_annotations
  add column line_width smallint
    check (line_width between 1 and 4),
  add column line_style text
    check (line_style in ('solid', 'dashed', 'dotted'));
