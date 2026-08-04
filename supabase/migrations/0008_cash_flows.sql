-- 계좌를 드나든 돈 — 매매 손익과 섞이면 성과가 흐려진다.
--
-- 자금 곡선은 초기자금 + 누적손익으로만 그렸다. 그래서 돈을 넣거나 빼면 계산 자금이
-- 거래소 실제 잔액과 조용히 벌어졌고, 그 차이를 매매 성과로 오해할 여지가 있었다.
--
-- 종류를 나누는 이유: 거래계좌 잔액을 움직이는 건 매매 손익과 '이체'(자금계좌 ↔
-- 거래계좌)뿐이다. 온체인 입금/출금은 자금계좌에 먼저 닿으므로 이체가 일어나기
-- 전까지는 거래계좌 잔액에 반영되지 않는다 — 둘을 한 덩어리로 묶으면 곡선이 틀어진다.
create table public.cash_flows (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  book_id    uuid not null references public.books (id) on delete cascade,
  -- deposit/withdrawal = 온체인 입출금(자금계좌), transfer = 거래계좌 이체
  kind       text not null check (kind in ('deposit', 'withdrawal', 'transfer')),
  at         timestamptz not null,
  ccy        text not null default 'USDT',
  -- 부호 포함 — 들어오면 +, 나가면 −
  amount     numeric not null,
  -- 출금 수수료 등 부대비용. 부호 포함(보통 음수)
  fee        numeric,
  note       text,
  -- OKX 원본 식별자(billId / depId / wdId) — 재동기화 멱등성의 열쇠
  okx_ref    text,
  source     text not null default 'okx' check (source in ('okx', 'manual')),
  created_at timestamptz not null default now()
);

create index cash_flows_book_at_idx on public.cash_flows (book_id, at desc);

-- 같은 구간을 두 번 훑어도 입출금이 겹치지 않게 막는다.
-- 종류를 열쇠에 포함한다 — depId 와 wdId 는 서로 다른 번호 체계라 값이 겹칠 수 있다.
create unique index cash_flows_okx_ref_uniq
  on public.cash_flows (user_id, kind, okx_ref)
  where okx_ref is not null;

alter table public.cash_flows enable row level security;

create policy "cash_flows_select" on public.cash_flows for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "cash_flows_insert" on public.cash_flows for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "cash_flows_update" on public.cash_flows for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "cash_flows_delete" on public.cash_flows for delete
  to authenticated using ((select auth.uid()) = user_id);

-- 동기화 실행 기록에도 입출금 건수를 남긴다 — 거래·체결만 세면 유실을 못 알아챈다.
alter table public.sync_runs add column flows_added integer not null default 0;
