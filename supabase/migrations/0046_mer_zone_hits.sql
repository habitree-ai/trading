-- MER 시뮬레이션 관측값 — 진입 뒤 경로에서 구간 k 도달 시각, 도달 뒤 공통 손절 터치 시각 (REQ-0102).
--
-- 청산된 거래(최초 손절 있는 것)마다 구간 +1·1.5·2·2.5·3R 에 가상 추가를 했다면 어떻게 됐을지를 봉으로 시뮬하고,
-- 그 관측값(도달 여부·시각·쓴 봉·입력가)만 남긴다. 다리 R·MER 은 저장하지 않는다(0044 원칙) — 화면이 계산한다.
-- 입력가(entry_px·stop_px·fee_rate…)를 같이 두는 이유: 거래 행이 나중에 고쳐져도 이 관측이 무엇으로 계산됐는지 남는다.
--
-- 시뮬 규칙이 바뀌면 sim_version 을 올려 새로 쌓는다. 같은 버전 재계산은 지우고 다시 넣는다(update 정책 없음).

create table public.mer_zone_hits (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  trade_id           uuid not null references public.trades (id) on delete cascade,
  -- 최초 손절폭의 R 배수 구간
  zone_r             numeric not null,
  sim_version        int not null default 1,
  -- 시뮬에 쓴 봉(예 '1m', '5m')
  bar                text not null,
  entry_at           timestamptz not null,
  -- 첫 진입 체결, 없으면 entry_price
  entry_px           numeric not null,
  -- stop_px_0
  stop_px            numeric not null,
  common_stop_px     numeric not null,
  fee_rate           numeric not null,
  zone_px            numeric not null,
  outcome            text not null check (outcome in ('reached', 'stop_first', 'exit_first')),
  reached_at         timestamptz,
  common_stop_hit_at timestamptz,
  exit_at            timestamptz not null,
  exit_px            numeric not null,
  computed_at        timestamptz not null default now(),
  unique (trade_id, zone_r, sim_version)
);

create index mer_zone_hits_user_idx on public.mer_zone_hits (user_id, sim_version);

alter table public.mer_zone_hits enable row level security;

-- 관측값이라 고치는 경로는 없다. 다시 계산할 때는 지우고 넣는다.
create policy "mer_zone_hits_select" on public.mer_zone_hits for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "mer_zone_hits_insert" on public.mer_zone_hits for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "mer_zone_hits_delete" on public.mer_zone_hits for delete
  to authenticated using ((select auth.uid()) = user_id);
