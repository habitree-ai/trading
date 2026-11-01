-- 기준 R 과 진입 순간 스냅샷 (REQ-0089).
--
-- R 배수 = 순손익 ÷ 최초 위험(최초 손절폭 × 최초 수량). 최초 위험은 진입 순간의 손절로 정해지는데,
-- 지금은 그 값을 잃는다: `stop_price` 는 손으로 고쳐 쓰는 칸이고, `okx_stop_price` 는 **마지막에**
-- 걸린 손절이다(이익 쪽으로 옮긴 뒤면 처음 위험을 알 수 없다 — 10/17 분석에서 21건 제외).
-- 그래서 처음 적힌 계획 손절을 `stop_px_0` 에 한 번만 고정한다.
--
-- 기준 R(사용자가 정한 1회 위험 금액)은 바뀔 수 있고, 바뀌어도 지난 거래는 다시 계산하지 않는다.
-- 그래서 이력으로 두고, 거래가 들어오는 순간의 값을 거래 행에 찍는다.
--
-- 스냅샷은 DB 트리거가 한다 — 수동 입력과 OKX 동기화 두 경로가 같은 규칙을 지나도록.

create table public.r_base_history (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  -- 기준 R 금액(USDT)
  amount         numeric not null check (amount > 0),
  -- 예상 수수료율(한쪽 체결, 예 0.0005). 위험 배수의 예상 왕복 비용에만 쓴다
  fee_rate       numeric not null default 0.0005 check (fee_rate >= 0 and fee_rate < 0.01),
  effective_from timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index r_base_history_user_from_idx
  on public.r_base_history (user_id, effective_from desc);

alter table public.r_base_history enable row level security;

-- 이력이라 고치거나 지우는 경로는 없다 — 바꾸려면 새 행을 넣는다.
create policy "r_base_history_select" on public.r_base_history for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "r_base_history_insert" on public.r_base_history for insert
  to authenticated with check ((select auth.uid()) = user_id);

alter table public.trades
  add column stop_px_0         numeric,
  add column r_base_at_entry   numeric,
  add column fee_rate_at_entry numeric;

comment on column public.trades.stop_px_0 is
  '최초 손절가 — stop_price(계획 손절)가 처음 채워질 때 트리거가 고정한 값. 이후 stop_price 를 고쳐도 유지된다. R 배수 분모(최초 위험)의 근거. REQ-0089';
comment on column public.trades.r_base_at_entry is
  '진입 시각(entry_at) 기준 r_base_history 의 기준 R(USDT). 삽입 때 한 번 찍는다. 이력 이전 거래는 null. REQ-0089';
comment on column public.trades.fee_rate_at_entry is
  '같은 이력 행의 예상 수수료율 — 위험 배수의 예상 왕복 비용에만 쓴다. REQ-0089';

-- 기존 거래: 지금의 계획 손절을 최초 손절로 본다(11-01 사용자 결정 — 거래소 손절은 쓰지 않는다).
update public.trades set stop_px_0 = stop_price where stop_price is not null;

-- 최초 손절 고정: 처음 채워진 stop_price 만 받고, 한 번 정해진 값은 null 로 덮이지 않는다.
create function public.trades_pin_stop_px_0()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.stop_px_0 := coalesce(new.stop_px_0, old.stop_px_0);
  end if;
  if new.stop_px_0 is null and new.stop_price is not null then
    new.stop_px_0 := new.stop_price;
  end if;
  return new;
end;
$$;

create trigger trades_pin_stop_px_0
  before insert or update on public.trades
  for each row execute function public.trades_pin_stop_px_0();

-- 기준 R 스냅샷: 삽입 때만. 진입 시각 기준 가장 최근 이력 행.
create function public.trades_snapshot_r_base()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  hit record;
begin
  if new.r_base_at_entry is null then
    select h.amount, h.fee_rate into hit
      from public.r_base_history h
     where h.user_id = new.user_id
       and h.effective_from <= new.entry_at
     order by h.effective_from desc
     limit 1;
    if found then
      new.r_base_at_entry := hit.amount;
      new.fee_rate_at_entry := coalesce(new.fee_rate_at_entry, hit.fee_rate);
    end if;
  end if;
  return new;
end;
$$;

create trigger trades_snapshot_r_base
  before insert on public.trades
  for each row execute function public.trades_snapshot_r_base();
