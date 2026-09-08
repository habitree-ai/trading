-- 복기와 기록에 사진 — 손으로 적은 메모·다른 화면의 캡쳐를 그 기록에 붙인다(REQ-0057).
--
-- 사진은 이미 있는 비공개 버킷 `captures` 에 올린다(`user_id/book_id/uuid.ext`, 0001 의
-- RLS 가 첫 폴더를 uid 로 잠근다). 어느 기록의 것인지는 표를 따로 두지 않고 그 행에 경로
-- 배열로 적는다 — `trade_images` 는 OCR·AI 추출 전용(ocr_raw·extracted·confidence)이라
-- 메모 사진이 섞이면 두 흐름이 한 표에서 엉킨다. 조인 없이 행 하나만 읽으면 되는 쪽이
-- 목록·상세 어디서든 싸다.
--
-- URL 이 아니라 **경로**를 담는다. 버킷이 비공개라 URL 은 서명이 붙어 만료되므로,
-- 저장해 두면 언젠가 죽은 문자열이 된다.

alter table public.trades
  add column image_paths text[] not null default '{}';

alter table public.journal_notes
  add column image_paths text[] not null default '{}';

-- 사진만 있고 글이 없는 기록도 기록이다 — 찍은 메모가 곧 내용인 경우.
-- 다만 사진도 글도 없는 빈 행은 여전히 막는다.
alter table public.journal_notes
  drop constraint journal_notes_body_present;

alter table public.journal_notes
  add constraint journal_notes_body_or_image
  check (btrim(body) <> '' or array_length(image_paths, 1) is not null);
