-- 매매 원칙 — 지키기로 정한 규칙을 북마다 관리하고, 거래마다 지켰는지 남긴다.
--
-- 원칙만 적어 두면 지켰는지 알 수 없고, 성과만 보면 왜 그랬는지 알 수 없다. 둘을 잇는
-- 표가 `trade_principle_checks`다 — 복기에서 "어떤 원칙을 어겼을 때 얼마를 잃었나"를
-- 되짚는 축이 된다.

create type public.principle_category as enum ('entry', 'exit', 'risk', 'mental', 'routine');

-- 원칙 1개 — 북마다 다르다. 북은 계좌/기간 단위라 전략도 그 단위로 갈린다.
create table public.principles (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  category   public.principle_category not null default 'risk',
  title      text not null,
  -- 왜 이 원칙인지 / 어겼을 때 무슨 일이 있었는지
  detail     text,
  -- 묶음 안에서의 표시 순서. 중요한 것을 위로 올린다.
  sort_order integer not null default 0,
  -- 지금 지키는 원칙인지. false는 지운 게 아니라 접어 둔 것이다 —
  -- 과거 거래에 남은 체크는 그대로 두고 새 거래에서만 빠진다.
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint principles_title_not_blank check (btrim(title) <> '')
);

create index principles_book_idx on public.principles (book_id, category, sort_order);

create trigger principles_touch_updated_at
  before update on public.principles
  for each row execute function public.touch_updated_at();

-- 거래 × 원칙 — 지켰는지(true) 어겼는지(false).
--
-- 행이 없는 건 '어겼음'이 아니라 '아직 판단하지 않음'이다. 셋을 구분해야 복기에서
-- 체크를 안 한 거래가 위반으로 잡혀 통계를 끌고 가는 일이 없다.
create table public.trade_principle_checks (
  trade_id     uuid not null references public.trades (id) on delete cascade,
  principle_id uuid not null references public.principles (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  kept         boolean not null,
  note         text,
  created_at   timestamptz not null default now(),

  primary key (trade_id, principle_id)
);

create index trade_principle_checks_principle_idx
  on public.trade_principle_checks (principle_id, kept);

/* ============ RLS — 본인 데이터만 ============ */

alter table public.principles             enable row level security;
alter table public.trade_principle_checks enable row level security;

create policy "principles_select" on public.principles for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "principles_insert" on public.principles for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "principles_update" on public.principles for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "principles_delete" on public.principles for delete
  to authenticated using ((select auth.uid()) = user_id);

create policy "trade_principle_checks_select" on public.trade_principle_checks for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trade_principle_checks_insert" on public.trade_principle_checks for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trade_principle_checks_update" on public.trade_principle_checks for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "trade_principle_checks_delete" on public.trade_principle_checks for delete
  to authenticated using ((select auth.uid()) = user_id);
