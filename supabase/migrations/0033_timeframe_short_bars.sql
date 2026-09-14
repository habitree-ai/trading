-- 짧은 봉 시계열 — 진입 1분·5분봉 (REQ-0063).
--
-- 방향 15분·1시간봉은 enum 에 이미 있어 0034 에서 허용 목록만 넓힌다.
--
-- `add value` 로 넣은 값은 같은 트랜잭션 안에서 쓸 수 없다(unsafe use of new value). 새 값을
-- 가리키는 CHECK 제약을 여기 함께 두면 적용이 실패하므로 0034 로 파일을 나눈다.
--
-- 위치는 15m 앞이다. enum 정렬 순서가 봉 길이 순서(1m < 5m < 15m < 1H < 4H < 1D < 1W)와 같아야
-- `order by` 로 뽑을 때 사람이 기대하는 순서가 나온다.
alter type public.timeframe add value if not exists '1m' before '15m';
alter type public.timeframe add value if not exists '5m' before '15m';
