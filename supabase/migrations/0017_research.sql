-- 종목 리서치 — 매매 이전에 참고할 정량 스냅샷과 정성 노트.
--
-- 매매일지가 "이미 한 거래"를 되짚는 도구라면, 리서치는 "하기 전"의 자리다.
-- 스냅샷은 지표 추이를 되짚어야 하므로 핵심 수치를 컬럼으로 편다 — jsonb에 묶으면
-- 펀딩비 30일 추이 같은 조회마다 캐스팅이 낀다. 헤드라인은 가변 목록이고 개별
-- 조회가 없어 jsonb로 묶는다.
--
-- 북과 무관하다 — 리서치는 계좌/기간이 아니라 종목 단위다.

create type public.research_note_category as enum
  ('fundamental', 'onchain', 'regulation', 'social', 'macro', 'briefing');

-- 정량 스냅샷 1장 — 수집 시점의 시장 단면.
--
-- 소스 하나가 죽어도 나머지는 남긴다. 빈 컬럼(null)과 sources 기록이 그 흔적이다.
create table public.research_snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  -- 기초자산 티커. 'BTC'
  symbol            text not null,
  collected_at      timestamptz not null default now(),
  -- CoinGecko
  price_usd         numeric,
  market_cap_usd    numeric,
  volume_24h_usd    numeric,
  -- 글로벌 시총 점유율(%)
  dominance_pct     numeric,
  -- alternative.me — 시장 전체 지수라 심볼과 무관하게 같은 값이 기록된다
  fear_greed        smallint,
  fear_greed_label  text,
  -- OKX 공개 (해당 심볼의 USDT 무기한). 소수 — 0.0001 = 0.01%
  funding_rate      numeric,
  -- 계약 수 / 명목 USD
  open_interest     numeric,
  open_interest_usd numeric,
  -- 뉴스 [{title, link, source, published_at}]
  headlines         jsonb not null default '[]'::jsonb,
  -- 소스별 성공/실패 {"coingecko":"ok","okx":"error: ..."}
  sources           jsonb not null default '{}'::jsonb,

  constraint research_snapshots_symbol_not_blank check (btrim(symbol) <> '')
);

-- 추이 조회 축: 내 것 → 심볼 → 최신순. user_id 선두라 RLS 필터와도 맞물린다.
create index research_snapshots_user_symbol_at_idx
  on public.research_snapshots (user_id, symbol, collected_at desc);

-- 정성 노트 1개 — 기본적 분석·정치/사회 맥락을 축적한다.
create table public.research_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  category   public.research_note_category not null default 'fundamental',
  title      text not null,
  body       text,
  source_url text,
  -- 1(참고) ~ 3(핵심). 목록에서 중요한 것이 위로 온다.
  importance smallint not null default 2,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint research_notes_title_not_blank  check (btrim(title) <> ''),
  constraint research_notes_symbol_not_blank check (btrim(symbol) <> ''),
  constraint research_notes_importance_range check (importance between 1 and 3)
);

create index research_notes_user_symbol_idx
  on public.research_notes (user_id, symbol, category, importance desc, created_at desc);

create trigger research_notes_touch_updated_at
  before update on public.research_notes
  for each row execute function public.touch_updated_at();

/* ============ RLS — 본인 데이터만 ============ */

alter table public.research_snapshots enable row level security;
alter table public.research_notes     enable row level security;

create policy "research_snapshots_select" on public.research_snapshots for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "research_snapshots_insert" on public.research_snapshots for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "research_snapshots_delete" on public.research_snapshots for delete
  to authenticated using ((select auth.uid()) = user_id);
-- 스냅샷은 수집 결과라 update 정책을 두지 않는다 — 고칠 일이 없고, 없는 정책이 곧 금지다.

create policy "research_notes_select" on public.research_notes for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "research_notes_insert" on public.research_notes for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "research_notes_update" on public.research_notes for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "research_notes_delete" on public.research_notes for delete
  to authenticated using ((select auth.uid()) = user_id);
