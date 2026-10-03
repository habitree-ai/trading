-- AI 분석 — 사용자가 지시할 때만 Claude Code 가 만드는 북 단위 종합 분석 회차 (REQ-0088).
--
-- 화면(`/ai-review`)은 보기만 한다. 회차는 `scripts/ai-review.mjs save` 가 서비스 롤로 넣는다 —
-- 자동으로 만들지 않는 것이 요구사항이라, 앱에 쓰기 경로를 두지 않는다.
--
-- 내용은 jsonb 하나다. 섹션·항목 구조는 `src/lib/ai-review.ts` 파서가 정본이고,
-- 회차마다 관점이 늘거나 줄 수 있어 열로 쪼개지 않는다.

create table public.ai_reviews (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references public.books (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  round        int  not null check (round > 0),
  title        text not null,
  period_from  timestamptz,
  period_to    timestamptz,
  trade_count  int  not null default 0,
  content      jsonb not null,
  generated_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (book_id, round)
);

-- 조회 축: 북 → 최신 회차. unique (book_id, round) 인덱스가 같은 축을 덮는다.

alter table public.ai_reviews enable row level security;

-- 읽기만 연다. 쓰기는 서비스 롤 CLI 뿐이다.
create policy "ai_reviews_select" on public.ai_reviews for select
  to authenticated using ((select auth.uid()) = user_id);
