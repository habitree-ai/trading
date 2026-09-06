-- 포지션에 기록을 쌓는다 — 추가 진입·변경·메모 기준의 추가 기록(REQ-0049).
--
-- 포지션 기록은 거래 행의 근거·복기·감정 한 벌이었다(0027). 들고 있는 동안 추가 진입을
-- 하거나 손절·TP 를 옮기면 "그때 왜 그랬는지"를 적을 자리가 없었다 — 적으면 진입 근거가
-- 지워진다. 일반 기록 표에 거래를 가리키는 칸을 더해 같은 표에 쌓는다. 진입 기록은 거래
-- 행에 그대로 둔다 — 복기 통계와 주문 게이트가 그것을 본다.
--
-- basis 는 기록 시점의 포지션 수치 스냅샷(진입가·투입·Lv·손절·TP·평가손익)이고, 추가
-- 진입이면 그 체결, 변경이면 직전 기록 대비 달라진 항목이 함께 든다. 동기화가 거래 행을
-- 덮어쓰므로 "그때 값"은 여기에만 남는다.

alter table public.journal_notes
  add column trade_id uuid references public.trades (id) on delete cascade,
  -- 'add' 추가 진입 / 'change' 변경 / 'note' 메모 — 거래에 붙는 기록에만 있다
  add column event text,
  add column basis jsonb,
  add constraint journal_notes_event_kind check (event is null or event in ('add', 'change', 'note')),
  -- 거래에 붙는 기록은 기준이 있고, 일반 기록은 없다. 둘 중 하나만 반쯤 채운 행은 거절
  add constraint journal_notes_trade_event check ((trade_id is null) = (event is null)),
  add constraint journal_notes_basis_owner check (basis is null or trade_id is not null);

-- 포지션 탭이 "이 거래의 기록"을 시간순으로 읽는 축.
create index journal_notes_trade_created_idx
  on public.journal_notes (trade_id, created_at)
  where trade_id is not null;
