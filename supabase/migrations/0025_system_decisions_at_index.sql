/* 0025 — 판정로그 인덱스 정합 (REQ-0026)
   readSystemDecisions 는 (user_id[RLS], mode) 필터 + at desc 정렬인데
   기존 인덱스는 bar_ts desc 라 어떤 쿼리도 돕지 못했다. 쿼리는 화면 의미
   (기록 시각순, bar_ts 는 nullable)가 정본이므로 인덱스를 쿼리에 맞춘다. */

create index system_decisions_at_idx
  on public.system_decisions (user_id, mode, at desc);

drop index if exists public.system_decisions_recent_idx;
