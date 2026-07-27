-- Supabase가 기본 제공하는 이벤트 트리거 함수가 REST RPC 표면(/rest/v1/rpc/...)에
-- 노출되면서 security advisor 경고를 남긴다.
-- 이벤트 트리거는 소유자 권한으로 실행되므로 EXECUTE 회수는 동작에 영향이 없다.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
