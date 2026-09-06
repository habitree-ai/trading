-- 일반 기록 — 포지션과 무관한 관찰·감정 메모(REQ-0048).
--
-- 기록은 두 가지뿐이다. 포지션에 대한 기록은 거래 행(rationale·review·emotion)에 직접
-- 적는다 — 그 판단은 거래에 붙어 있어야 복기 통계가 묶인다. 포지션이 없는 기록은 지금까지
-- 남길 자리가 없었다. 종목(선택)·내용·감정만 담는 얇은 표를 둔다.
--
-- 북 단위다 — 기록 추가 화면이 북 위에서 열리고, 원칙·목표처럼 그 북의 맥락에 붙는다.

create table public.journal_notes (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- 기초자산 티커('BTC'). 종목이 없는 기록이면 null
  symbol     text,
  body       text not null,
  emotion    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint journal_notes_body_present check (btrim(body) <> ''),
  constraint journal_notes_symbol_not_blank check (symbol is null or btrim(symbol) <> '')
);

-- 목록 축: 북 → 최신순.
create index journal_notes_book_created_idx
  on public.journal_notes (book_id, created_at desc);

create trigger journal_notes_touch_updated_at
  before update on public.journal_notes
  for each row execute function public.touch_updated_at();

alter table public.journal_notes enable row level security;

create policy "journal_notes_select" on public.journal_notes for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "journal_notes_insert" on public.journal_notes for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "journal_notes_update" on public.journal_notes for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "journal_notes_delete" on public.journal_notes for delete
  to authenticated using ((select auth.uid()) = user_id);

-- 차트 메모의 소유자를 넓힌다 — 거래 또는 일반 기록, 둘 중 하나.
--
-- 일반 기록의 차트(종목 현재 차트)에 그린 도형도 저장돼야 "차트의 기록 내용이 기록에
-- 반영"된다. 표를 하나 더 만들면 그리기·되돌리기·목록 코드가 통째로 둘이 된다 —
-- 같은 표에 소유자 칸만 하나 더 둔다. 기존 행은 전부 trade_id 라 그대로다.

alter table public.trade_annotations
  alter column trade_id drop not null,
  add column note_id uuid references public.journal_notes (id) on delete cascade,
  add constraint trade_annotations_one_owner check ((trade_id is null) <> (note_id is null));

create index trade_annotations_note_idx
  on public.trade_annotations (note_id, created_at)
  where note_id is not null;
