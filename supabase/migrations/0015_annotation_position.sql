-- 손익 툴(롱·숏) — 트레이딩뷰의 Long/Short Position 도구에 대응한다.
--
-- 진입·손절·목표를 한 덩어리로 잡아 그 자리의 손익비를 바로 보여 준다. 수평선 3개로
-- 대신할 수도 있지만, 그러면 선은 남아도 "이 배치가 몇 대 일인지"는 여전히 머릿속에서
-- 계산해야 한다 — 복기에서 정작 알고 싶은 건 그 비율이다.
--
-- 좌표는 순서가 곧 역할이다: [진입, 손절, 목표]. 다른 종류처럼 시간순으로 세우면
-- 역할이 뒤바뀐다.

alter type public.annotation_kind add value if not exists 'long';
alter type public.annotation_kind add value if not exists 'short';

alter table public.trade_annotations
  drop constraint trade_annotations_points_shape;

-- 새로 붙인 값(`long`·`short`)을 여기서 이름으로 부르지 않는다. 같은 트랜잭션 안에서
-- 방금 추가한 enum 값을 쓰면 Postgres가 막는다 — 나머지를 다 짚고 else 로 받는다.
alter table public.trade_annotations
  add constraint trade_annotations_points_shape check (
    jsonb_typeof(points) = 'array'
    and jsonb_array_length(points) = case
      when kind in ('text', 'hline') then 1
      when kind in ('line', 'rect') then 2
      else 3
    end
  );
