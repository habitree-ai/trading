-- 과도기 컬럼을 걷어낸다.
--
-- `okx_sync_enabled`는 "환경변수에 든 그 키 하나로 이 북을 받는다"는 뜻이었다.
-- 이제 어느 계정으로 받는지가 `books.exchange_account_id`에 적히므로, 켜짐/꺼짐만
-- 남은 이 컬럼은 진실 원천이 둘이 되게 할 뿐이다.
--
-- **scripts/seed-okx-account.mjs 를 돌린 뒤에 적용할 것.** 그 스크립트가 이 컬럼을
-- 읽어 새 연결로 옮긴다. 먼저 지우면 어느 북이 동기화 대상이었는지 알 수 없게 된다.

do $$
begin
  if exists (
    select 1 from public.books
     where okx_sync_enabled and exchange_account_id is null
  ) then
    raise exception 'OKX 동기화가 켜져 있는데 거래소 계정이 연결되지 않은 북이 있습니다. scripts/seed-okx-account.mjs 를 먼저 실행해 주세요.';
  end if;
end;
$$;

-- 컬럼을 지우면 그 위의 부분 유니크 인덱스(books_okx_sync_single)도 함께 사라진다.
alter table public.books drop column okx_sync_enabled;
