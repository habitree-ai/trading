/* ============================================================
   0024 — 현물신호 (REQ-0023)
   업비트 KRW 현물 스캐너(crash × T1)의 산출·스캔 건강 기록·카카오 토큰.
   쓰기는 전부 서버 스캐너(service_role), 화면은 읽기만 한다.
   ============================================================ */

/* 신호 — 채택 규칙(crash: 72봉 −25% + 양봉 + 거래량, T1 유동성)의 발화 기록 */
create table public.spot_signals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  market         text not null,              -- KRW-BTC
  signal         text not null,              -- crash (v1 단일)
  bar_ts         timestamptz not null,       -- 신호가 확정된 1H 봉 시각(UTC)
  price          numeric not null,           -- 신호 봉 종가(KRW)
  drop72_pct     numeric,                    -- 72봉(3일) 낙폭 %
  volume_mult    numeric,                    -- 신호 봉 거래량 / volMA20
  turnover_med30 numeric,                    -- 일 거래대금 30일 중앙값(KRW) — T1 판정 근거
  indicators     jsonb,                      -- 그 외 지표 스냅샷 {rsi, atr, ...}
  notified_at    timestamptz,                -- 카톡 발송 시각(묶음)
  created_at     timestamptz not null default now(),
  -- 같은 봉 재스캔 시 중복 발화·재발송 방지
  unique (user_id, market, signal, bar_ts)
);

create index spot_signals_recent_idx
  on public.spot_signals (user_id, bar_ts desc);

/* 스캔 실행 기록 — "마지막 스캔이 언제였나"가 화면의 건강 판이다 (쿼드봇 절전 사고 교훈) */
create table public.spot_scan_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  ran_at          timestamptz not null default now(),
  bar_ts          timestamptz,               -- 스캔 대상 1H 봉
  markets_scanned integer not null default 0,
  signals_found   integer not null default 0,
  duration_ms     integer,
  error           text,                      -- 실패 시 원인 (성공이면 null)
  notify_status   text                       -- sent · none(신호 없음) · failed:<사유>
);

create index spot_scan_runs_recent_idx
  on public.spot_scan_runs (user_id, ran_at desc);

/* 카카오 나에게 보내기 토큰 — 서버 전용 비밀 */
create table public.kakao_tokens (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  access_token       text not null,
  refresh_token      text not null,
  expires_at         timestamptz not null,
  refresh_expires_at timestamptz,
  updated_at         timestamptz not null default now()
);

/* ============ RLS ============
   spot_signals·spot_scan_runs: 화면은 본인 것 읽기만. 쓰기는 service_role(정책 우회).
   kakao_tokens: 정책 없음 = authenticated 전면 차단. service_role 만 접근한다. */

alter table public.spot_signals  enable row level security;
alter table public.spot_scan_runs enable row level security;
alter table public.kakao_tokens  enable row level security;

create policy "spot_signals_select" on public.spot_signals for select
  to authenticated using ((select auth.uid()) = user_id);

create policy "spot_scan_runs_select" on public.spot_scan_runs for select
  to authenticated using ((select auth.uid()) = user_id);
