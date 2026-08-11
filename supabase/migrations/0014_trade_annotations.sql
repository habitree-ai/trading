-- 차트 메모 — 거래 차트 위에 남기는 텍스트와 도형.
--
-- 복기는 "그때 무엇을 봤는지"를 되짚는 일이다. 숫자만 남기면 지지선을 어디로 봤는지,
-- 어느 봉에서 손이 먼저 나갔는지가 사라진다. 그런 판단은 차트 위 좌표에 붙어 있어야
-- 뜻이 산다.
--
-- 좌표는 화면 픽셀이 아니라 (시각, 가격)으로 저장한다 — 봉 간격을 바꾸거나 확대해도
-- 같은 자리를 가리킨다.

create type public.annotation_kind as enum ('text', 'line', 'hline', 'rect');

create table public.trade_annotations (
  id         uuid primary key default gen_random_uuid(),
  trade_id   uuid not null references public.trades (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       public.annotation_kind not null,
  -- [{"t": 초 단위 epoch, "p": 가격}] — text·hline은 1점, line·rect는 2점
  points     jsonb not null,
  -- 도형에 붙는 라벨. text 종류에서는 이것이 내용 전부다
  text       text,
  -- CSS 토큰 이름 — 라이트/다크가 바뀌어도 같은 뜻의 색을 쓴다
  color      text not null default 'accent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint trade_annotations_points_shape check (
    jsonb_typeof(points) = 'array'
    and jsonb_array_length(points) = case when kind in ('text', 'hline') then 1 else 2 end
  ),
  constraint trade_annotations_color_known
    check (color in ('accent', 'profit', 'loss', 'beta')),
  -- 텍스트 메모는 내용이 있어야 뜻이 있다. 도형은 라벨이 없어도 자리 자체가 메모다
  constraint trade_annotations_text_present
    check (kind <> 'text' or btrim(coalesce(text, '')) <> '')
);

create index trade_annotations_trade_idx on public.trade_annotations (trade_id, created_at);

create trigger trade_annotations_touch_updated_at
  before update on public.trade_annotations
  for each row execute function public.touch_updated_at();

/* ============ RLS — 본인 데이터만 ============ */

alter table public.trade_annotations enable row level security;

create policy "trade_annotations_select" on public.trade_annotations for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trade_annotations_insert" on public.trade_annotations for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trade_annotations_update" on public.trade_annotations for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "trade_annotations_delete" on public.trade_annotations for delete
  to authenticated using ((select auth.uid()) = user_id);
