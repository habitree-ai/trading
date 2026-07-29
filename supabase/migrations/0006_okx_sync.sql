-- OKX API 동기화 — 캡쳐 OCR 대신 거래소에서 직접 긁어와 쌓기 위한 스키마.

-- 1) 어느 북에 붙일지.
--    API 키는 환경변수로 계정 하나만 두므로 사용자당 켜진 북도 하나여야 한다.
--    둘을 켜면 같은 거래가 두 북에 들어가 자금 곡선이 두 배로 부푼다.
alter table public.books add column okx_sync_enabled boolean not null default false;

create unique index books_okx_sync_single
  on public.books (user_id)
  where okx_sync_enabled;

comment on column public.books.okx_sync_enabled is 'OKX 자동 동기화 대상 북 — 사용자당 하나만 켤 수 있다';

-- 2) 재동기화 멱등성 — OKX 포지션 하나가 거래 하나다.
--    같은 구간을 두 번 훑어도 손익이 두 번 잡히지 않게 막는 열쇠.
alter table public.trades add column okx_pos_id text;

create unique index trades_okx_pos_id_uniq
  on public.trades (user_id, okx_pos_id)
  where okx_pos_id is not null;

comment on column public.trades.okx_pos_id is 'OKX positions-history `posId`';

-- 3) 체결 고유키를 주문번호에서 체결번호로 옮긴다.
--
--    캡쳐 화면에서는 주문 하나에 체결이 하나로 보였다. 그런데 API로 받으면
--    부분체결 때문에 같은 `ordId`가 여러 행으로 온다 — 기존 주문번호 유니크로는
--    두 번째 체결이 막힌다. 체결 단위로 유일한 `billId`를 새 열쇠로 쓴다.
alter table public.trade_fills add column okx_bill_id text;

comment on column public.trade_fills.okx_bill_id is 'OKX fills-history `billId` — 체결 1건마다 유일하다';

create unique index trade_fills_okx_bill_id_uniq
  on public.trade_fills (user_id, okx_bill_id)
  where okx_bill_id is not null;

-- 캡쳐로 넣는 경로는 여전히 주문 하나에 체결 하나라, 그쪽 중복 방지는 그대로 둔다.
drop index if exists public.trade_fills_order_no_uniq;

create unique index trade_fills_order_no_uniq
  on public.trade_fills (user_id, order_no)
  where order_no is not null and okx_bill_id is null;

-- 4) 잔고 스냅샷의 출처에 API를 더한다 — 캡쳐로 찍던 자산을 이제 직접 읽어 온다.
alter table public.balance_snapshots drop constraint balance_snapshots_source_check;
alter table public.balance_snapshots
  add constraint balance_snapshots_source_check check (source in ('capture', 'manual', 'okx'));

-- 5) 동기화 실행 기록.
--
--    OKX는 3개월치만 돌려준다. 어디까지 훑었는지 남겨 두지 않으면 다음 실행이
--    어디서부터 이어야 할지 알 수 없고, 실패한 구간이 조용히 유실된다.
create table public.sync_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  book_id      uuid not null references public.books (id) on delete cascade,
  source       text not null default 'okx' check (source in ('okx')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- 이번 실행이 훑은 구간의 끝 — 다음 실행은 여기서 이어 간다.
  cursor_at    timestamptz,
  trades_added integer not null default 0,
  fills_added  integer not null default 0,
  error        text
);

create index sync_runs_book_idx on public.sync_runs (book_id, started_at desc);

alter table public.sync_runs enable row level security;

create policy "sync_runs_select" on public.sync_runs for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "sync_runs_insert" on public.sync_runs for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "sync_runs_update" on public.sync_runs for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
