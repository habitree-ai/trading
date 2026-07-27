-- 트레이딩 누적기록 — 초기 스키마
--
-- 구글시트 매매일지의 항목 체계를 정규화한다.
-- 원칙: 원자값만 저장하고 파생지표(누적 최고치·MDD·RR·수익율)는 앱에서 계산한다.

create type public.trade_side   as enum ('long', 'short');
create type public.trade_result as enum ('win', 'loss', 'be', 'open');
create type public.book_status  as enum ('active', 'closed');
create type public.capture_kind as enum ('position', 'chart', 'balance');
create type public.extract_engine as enum ('ocr', 'ai', 'manual');
create type public.goal_tier   as enum ('beta', 'alpha');
create type public.goal_period as enum ('week', 'month', 'year');
create type public.goal_metric as enum (
  'return_pct', 'max_drawdown_pct', 'win_rate',
  'expectancy', 'risk_per_trade_pct', 'trade_count'
);

-- 계좌/기간별 일지 1권 — 시트의 탭 하나에 대응
create table public.books (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  name            text not null,
  exchange        text,
  base_currency   text not null default 'USDT',
  initial_capital numeric not null default 0,   -- 시트의 `초기자금`
  start_date      date not null default current_date,
  status          public.book_status not null default 'active',
  memo            text,
  created_at      timestamptz not null default now()
);

-- 거래 1건 — 시트 거래 로그의 한 행
create table public.trades (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  seq           integer not null,                  -- 시트의 `순번`
  side          public.trade_side not null,        -- 시트의 `방향` (L/S)
  symbol        text not null,                     -- 시트의 `종목`
  entry_at      timestamptz not null,              -- 시트의 `진입`
  exit_at       timestamptz,                       -- 시트의 `종료`
  result        public.trade_result not null default 'open',  -- 시트의 `승`/`패` 통합
  equity_before numeric,                           -- 시트의 `자금` (진입 직전)
  equity_after  numeric,                           -- 시트의 `자금` (청산 직후)
  withdrawal    numeric,                           -- 시트의 `출금`
  notional      numeric,                           -- 시트의 `투입`
  leverage      numeric,                           -- 시트의 `Lv`/`Rv`
  pnl           numeric,                           -- 시트의 `TP/SP` (수익금·손실금 통합, 부호 포함)
  entry_price   numeric,                           -- 시트의 `진입가`
  stop_price    numeric,                           -- 시트의 `손절가`
  tp1_price     numeric,                           -- 시트의 `TP1` (익절1)
  tp2_price     numeric,
  tp3_price     numeric,
  setup         text,                              -- 시트의 `기준`
  rationale     text,                              -- 시트의 `근거`
  review        text,                              -- 시트의 `복기`
  emotion       text,                              -- 시트의 `감정`
  note          text,                              -- 시트의 `비고`
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint trades_seq_unique unique (book_id, seq),
  -- 청산된 거래는 종료 시각과 손익이 있어야 한다
  constraint trades_closed_complete check (
    result = 'open' or (exit_at is not null and pnl is not null)
  ),
  constraint trades_exit_after_entry check (exit_at is null or exit_at >= entry_at)
);

create index trades_book_entry_idx  on public.trades (book_id, entry_at desc);
create index trades_book_result_idx on public.trades (book_id, result);

-- 캡쳐 이미지 — 포지션 종료 / 차트(진입 근거) / 계좌 잔고
create table public.trade_images (
  id           uuid primary key default gen_random_uuid(),
  trade_id     uuid references public.trades (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  kind         public.capture_kind not null,
  storage_path text not null,
  ocr_raw      text,
  extracted    jsonb,
  confidence   numeric,
  engine       public.extract_engine not null default 'manual',
  created_at   timestamptz not null default now()
);

create index trade_images_trade_idx on public.trade_images (trade_id);

-- 잔고 캡쳐에서 읽은 자산 추이 (거래와 무관하게 찍히는 스냅샷)
create table public.balance_snapshots (
  id       uuid primary key default gen_random_uuid(),
  book_id  uuid not null references public.books (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  at       timestamptz not null,
  equity   numeric not null,
  source   text not null default 'manual' check (source in ('capture', 'manual')),
  image_id uuid references public.trade_images (id) on delete set null
);

create index balance_snapshots_book_at_idx on public.balance_snapshots (book_id, at desc);

-- 계획 β(반드시 지킬 기준) / 목표 α(도전 기준) 2중 목표
create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references public.books (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  tier         public.goal_tier not null,
  period       public.goal_period not null,
  metric       public.goal_metric not null,
  target_value numeric not null,

  constraint goals_unique unique (book_id, tier, period, metric)
);

-- updated_at 자동 갱신
create function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trades_touch_updated_at
  before update on public.trades
  for each row execute function public.touch_updated_at();

/* ============ RLS — 전 테이블 본인 데이터만 ============ */

alter table public.books             enable row level security;
alter table public.trades            enable row level security;
alter table public.trade_images      enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.goals             enable row level security;

-- books
create policy "books_select" on public.books for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "books_insert" on public.books for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "books_update" on public.books for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "books_delete" on public.books for delete
  to authenticated using ((select auth.uid()) = user_id);

-- trades
create policy "trades_select" on public.trades for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trades_insert" on public.trades for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trades_update" on public.trades for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "trades_delete" on public.trades for delete
  to authenticated using ((select auth.uid()) = user_id);

-- trade_images
create policy "trade_images_select" on public.trade_images for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "trade_images_insert" on public.trade_images for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "trade_images_update" on public.trade_images for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "trade_images_delete" on public.trade_images for delete
  to authenticated using ((select auth.uid()) = user_id);

-- balance_snapshots
create policy "balance_snapshots_select" on public.balance_snapshots for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "balance_snapshots_insert" on public.balance_snapshots for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "balance_snapshots_update" on public.balance_snapshots for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "balance_snapshots_delete" on public.balance_snapshots for delete
  to authenticated using ((select auth.uid()) = user_id);

-- goals
create policy "goals_select" on public.goals for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "goals_insert" on public.goals for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "goals_update" on public.goals for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "goals_delete" on public.goals for delete
  to authenticated using ((select auth.uid()) = user_id);

/* ============ Storage — 캡쳐 비공개 버킷 ============ */

insert into storage.buckets (id, name, public)
values ('captures', 'captures', false)
on conflict (id) do nothing;

-- 경로 규칙: {user_id}/{book_id}/{filename}
-- upsert에는 insert + select + update가 모두 필요하다.
create policy "captures_select" on storage.objects for select
  to authenticated
  using (bucket_id = 'captures' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "captures_insert" on storage.objects for insert
  to authenticated
  with check (bucket_id = 'captures' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "captures_update" on storage.objects for update
  to authenticated
  using (bucket_id = 'captures' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'captures' and (select auth.uid())::text = (storage.foldername(name))[1]);

create policy "captures_delete" on storage.objects for delete
  to authenticated
  using (bucket_id = 'captures' and (select auth.uid())::text = (storage.foldername(name))[1]);
