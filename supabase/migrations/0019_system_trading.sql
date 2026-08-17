-- 시스템 트레이딩 봇의 상태와 기록 — 파일에서 데이터베이스로.
--
-- 지금까지 봇의 진실 원천은 봇을 돌리는 머신의 `system-trading/data/*.jsonl` 이었다.
-- 그래서 그 PC 밖에서는 상태를 볼 수 없었고, 서버에서 사이클을 돌릴 수도 없었다 —
-- 서버리스 함수에는 다음 호출까지 살아남는 파일이 없기 때문이다.
--
-- 옮기는 것은 저장 위치뿐이다. 판정·사이징·청산 규칙은 한 줄도 바뀌지 않는다.

create type public.system_mode as enum ('paper', 'demo', 'live');

/* ============ 상태 — 모드마다 한 행 ============ */

-- "봇이 지금 어디까지 왔는가". 사이클이 재개 지점을 여기서 읽는다.
create table public.system_state (
  user_id      uuid not null references auth.users (id) on delete cascade,
  mode         public.system_mode not null,

  -- 페이퍼의 가상 잔고. 데모·라이브는 거래소가 정본이라 null 이다.
  equity       numeric,

  -- 기준(gc·ob·fade·dc)마다 마지막으로 평가한 봉의 시각(epoch ms).
  -- 이 값이 어긋나면 같은 봉을 두 번 평가하거나 통째로 건너뛴다 — 재개 지점 그 자체다.
  last_bar_ts  jsonb not null default '{}'::jsonb,

  -- 열린 포지션. 기준 이름을 키로 하는 객체다.
  -- 정규화하지 않고 파일 시절의 구조를 그대로 옮긴다: 엔진이 이 객체를 통째로 읽고 쓰므로,
  -- 표로 펴는 순간 판정 코드까지 손대야 하고 그러면 백테스트와의 동치성 검증이 무너진다.
  positions    jsonb not null default '{}'::jsonb,

  -- 아래 둘은 서버에서 사이클을 돌리기 시작할 때를 위한 자리다. 지금은 쓰지 않는다.
  --
  -- locked_until: 크론과 수동 버튼이 겹쳐 같은 신호로 두 번 진입하는 것을 막는 잠금.
  --   조건부 UPDATE 로 잡고, 사이클이 죽어도 시각이 지나면 저절로 풀린다.
  locked_until timestamptz,
  -- live_enabled: 화면에서 끄고 켜는 킬스위치. 지금의 LIVE_TRADING_ACK 환경변수를 대신한다.
  --   환경변수는 서버에 올리는 순간 상시 켜짐이 되어 잠금 구실을 못 한다.
  --   기본값이 false 인 것은 의도다 — 켜는 것은 언제나 명시적인 행동이어야 한다.
  live_enabled boolean not null default false,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (user_id, mode)
);

create trigger system_state_touch_updated_at
  before update on public.system_state
  for each row execute function public.touch_updated_at();

/* ============ 평가 기록 ============ */

-- 모든 사이클의 판정 — 신호가 없던 봉도 남긴다.
-- "그때 왜 안 들어갔나"에 답할 수 있어야 기준을 고칠 수 있다.
create table public.system_decisions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  mode       public.system_mode not null,

  -- gc · ob · fade · dc. 경고만 남기는 행에서는 비어 있을 수 있다.
  member     text,
  tf         text,
  bar_ts     timestamptz,
  fired      boolean,
  -- none · enter · skip · missed
  action     text,
  -- 건너뛴 이유. 사람이 읽는 문장이다.
  skip       text,
  -- 사람 손이 필요한 사건(브래킷 조회 실패·미추적 포지션 등).
  warn       text,
  -- 판정 시점의 지표 스냅샷 — 고도화의 원재료.
  indicators jsonb,

  at         timestamptz not null default now()
);

create index system_decisions_recent_idx
  on public.system_decisions (user_id, mode, bar_ts desc);

/* ============ 거래 ============ */

-- 진입할 때 행을 만들고, 청산될 때 그 행을 덮어써서 닫는다.
-- 새 행을 만들지 않는 이유는 `trades` 와 같다 — 진입에 적어 둔 근거가 청산 기록과 끊긴다.
create table public.system_trades (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  mode           public.system_mode not null,

  -- 봇이 부여하는 식별자 `<기준>-<진입봉ts>`. 진입과 청산을 잇는 끈이다.
  trade_id       text not null,
  member         text not null,
  name           text not null,
  side           public.trade_side not null,

  entry_ts       timestamptz not null,
  exit_ts        timestamptz,
  entry_price    numeric not null,
  exit_price     numeric,
  -- tp · sl · time · unknown · algo
  exit_type      text,
  hold_bars      integer,

  stop           numeric,
  target         numeric,
  lev            numeric,
  risk_pct       numeric,

  net_pct        numeric,
  eq_at_entry    numeric,
  pnl_usd        numeric,
  equity_after   numeric,

  -- 판정 시점의 지표 — "왜 들어갔나"가 거래에 붙어 다녀야 복기가 된다.
  signal         jsonb,

  -- 거래소 쪽 식별자(페이퍼는 비어 있다).
  ord_id         text,
  algo_cl_ord_id text,
  sz             text,
  notional_usd   numeric,

  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,

  constraint system_trades_trade_id_unique unique (user_id, mode, trade_id),
  constraint system_trades_exit_after_entry check (exit_ts is null or exit_ts >= entry_ts)
);

create index system_trades_recent_idx
  on public.system_trades (user_id, mode, entry_ts desc);

/* ============ 잔고 스냅샷 ============ */

-- 사이클마다 한 줄. 잔고 곡선과 "그 시점에 무엇이 열려 있었나"를 남긴다.
create table public.system_equity (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  mode         public.system_mode not null,
  equity       numeric,
  -- 그 시점 열려 있던 기준 이름들.
  open_members text[] not null default '{}',
  at           timestamptz not null default now()
);

create index system_equity_recent_idx
  on public.system_equity (user_id, mode, at desc);

/* ============ RLS — 본인 데이터만 ============ */
--
-- 봇과 크론은 service_role 로 붙어 이 정책을 우회한다. 화면에서 읽는 경로만 여기에 걸린다.

alter table public.system_state     enable row level security;
alter table public.system_decisions enable row level security;
alter table public.system_trades    enable row level security;
alter table public.system_equity    enable row level security;

create policy "system_state_select" on public.system_state for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "system_state_insert" on public.system_state for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "system_state_update" on public.system_state for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "system_state_delete" on public.system_state for delete
  to authenticated using ((select auth.uid()) = user_id);

create policy "system_decisions_select" on public.system_decisions for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "system_decisions_insert" on public.system_decisions for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "system_decisions_update" on public.system_decisions for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "system_decisions_delete" on public.system_decisions for delete
  to authenticated using ((select auth.uid()) = user_id);

create policy "system_trades_select" on public.system_trades for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "system_trades_insert" on public.system_trades for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "system_trades_update" on public.system_trades for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "system_trades_delete" on public.system_trades for delete
  to authenticated using ((select auth.uid()) = user_id);

create policy "system_equity_select" on public.system_equity for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "system_equity_insert" on public.system_equity for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "system_equity_update" on public.system_equity for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "system_equity_delete" on public.system_equity for delete
  to authenticated using ((select auth.uid()) = user_id);
