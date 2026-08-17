-- 페이퍼 북(cand·ens·swing)과 수동 체결(manual)도 데이터베이스에 비치게.
--
-- 0019 가 본대(paper·demo·live)를 옮겼다. 전방 검증 러너들은 파일이 진실 원천으로
-- 남았는데(러너 북 이름이 enum 밖이라), 그래서 매매 진행이 그 PC 밖에서는 안 보였다.
-- 이 마이그레이션은 enum 에 북 이름을 더할 뿐이다 — 러너는 파일을 정본으로 유지하고
-- DB 에는 "거울"만 만든다(state-mirror.mjs, 실패해도 사이클을 깨지 않는 최선-노력 쓰기).
--
-- ALTER TYPE ... ADD VALUE 는 같은 트랜잭션 안에서 그 값을 쓰지만 않으면 안전하다(PG12+).

alter type public.system_mode add value if not exists 'cand';
alter type public.system_mode add value if not exists 'ens';
alter type public.system_mode add value if not exists 'swing';
alter type public.system_mode add value if not exists 'manual';
