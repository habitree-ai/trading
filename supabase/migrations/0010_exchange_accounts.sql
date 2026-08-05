-- 거래소 계정을 사람마다 따로 관리한다 — API 키가 환경변수 하나였던 구조를 걷어낸다.
--
-- 지금까지 OKX 키는 `.env`의 OKX_API_KEY/SECRET/PASSPHRASE 한 벌뿐이었다. 그래서
-- 누가 로그인하든 동기화를 켜면 **같은 거래소 계정**을 긁어 왔다. 그 사실을
-- `books.okx_sync_enabled`에 "사용자당 하나만" 유니크를 걸어 덮어 두고 있었을 뿐,
-- 계정이 둘 이상 되는 순간 남의 거래가 내 일지에 쌓이는 구조였다.
--
-- 키 원문은 이 표에 없다. Supabase Vault가 암호화해 보관하고 표에는 비밀의 uuid만
-- 남는다 — 표를 통째로 읽어도 키는 나오지 않는다. 복호화는 service_role 전용이다.
--
-- 적용 순서가 있다:
--   0010(이 파일) → scripts/seed-okx-account.mjs → 0011
-- 0010은 `okx_sync_enabled`를 남겨 둔다. 시드 스크립트가 "어느 북이 동기화 대상이었는지"를
-- 그 컬럼에서 읽어 새 연결로 옮기기 때문이다. 옮긴 뒤 0011이 컬럼을 지운다.

create extension if not exists supabase_vault with schema vault;

/* ============ 1. 거래소 계정 ============ */

create table public.exchange_accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  exchange   text not null default 'okx' check (exchange in ('okx')),
  -- 화면에 뜨는 이름. 키를 구분하기 위한 것이지 거래소가 주는 값이 아니다.
  label      text not null,
  -- Vault 비밀의 uuid — 원문이 아니다.
  api_key_secret_id    uuid not null,
  api_secret_secret_id uuid not null,
  passphrase_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 한 사람이 같은 거래소 키를 두 벌 두면 어느 쪽으로 동기화할지 정해지지 않는다.
  constraint exchange_accounts_one_per_exchange unique (user_id, exchange),
  -- books 가 (계정, 소유자) 짝으로 참조하기 위한 대상. 남의 계정 연결을 FK가 막는다.
  constraint exchange_accounts_id_user_uniq unique (id, user_id)
);

create index exchange_accounts_user_idx on public.exchange_accounts (user_id);

create trigger exchange_accounts_touch_updated_at
  before update on public.exchange_accounts
  for each row execute function public.touch_updated_at();

alter table public.exchange_accounts enable row level security;

create policy "exchange_accounts_select" on public.exchange_accounts for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "exchange_accounts_insert" on public.exchange_accounts for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "exchange_accounts_update" on public.exchange_accounts for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "exchange_accounts_delete" on public.exchange_accounts for delete
  to authenticated using ((select auth.uid()) = user_id);

/* ============ 2. 북 ↔ 거래소 계정 ============ */

alter table public.books add column exchange_account_id uuid;

-- 소유자까지 함께 참조한다 — 컬럼 하나만 걸면 남의 계정 id를 넣어도 통과한다.
alter table public.books
  add constraint books_exchange_account_fkey
  foreign key (exchange_account_id, user_id)
  references public.exchange_accounts (id, user_id);

-- 같은 계정을 두 북에 붙이면 같은 거래가 양쪽에 들어가 자금 곡선이 두 배로 부푼다.
create unique index books_exchange_account_uniq
  on public.books (exchange_account_id)
  where exchange_account_id is not null;

comment on column public.books.exchange_account_id is
  '이 북이 내려받는 거래소 계정. 비어 있으면 수동 기록 전용 북이다';

-- 어느 계정으로 받아 온 실행인지 남긴다 — 계정을 바꾼 뒤 이력을 되짚을 때 필요하다.
alter table public.sync_runs add column exchange_account_id uuid
  references public.exchange_accounts (id) on delete set null;

create index sync_runs_exchange_account_idx
  on public.sync_runs (exchange_account_id, started_at desc);

/* ============ 3. Vault 경유 키 저장·조회 ============

   security definer 함수는 만든 사람(postgres) 권한으로 돈다. 그래야 authenticated 가
   vault 스키마에 아무 권한이 없어도 자기 키를 넣을 수 있다. 대신 함수 안에서
   auth.uid()를 반드시 직접 확인하고, 필요 없는 역할의 EXECUTE는 회수한다.        */

-- 키를 넣거나 갈아 끼운다. 이미 있으면 원문만 덮어쓴다 — 비밀 uuid가 바뀌면
-- 그 uuid를 들고 있는 exchange_accounts 행과 어긋난다.
--
-- 소유자를 인자로 받는 쪽은 service_role 전용이다. 시드 스크립트처럼 로그인 세션이
-- 없는 실행에는 auth.uid()가 없어 아래 authenticated 용 함수를 쓸 수 없기 때문이다.
create function public.save_okx_account_for(
  p_user_id    uuid,
  p_label      text,
  p_api_key    text,
  p_api_secret text,
  p_passphrase text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.exchange_accounts%rowtype;
  v_id       uuid;
  v_label    text := coalesce(nullif(btrim(p_label), ''), 'OKX');
begin
  if p_user_id is null then
    raise exception '소유자가 필요합니다.';
  end if;

  if coalesce(btrim(p_api_key), '') = ''
     or coalesce(btrim(p_api_secret), '') = ''
     or coalesce(btrim(p_passphrase), '') = '' then
    raise exception 'API 키·시크릿·패스프레이즈를 모두 입력해 주세요.';
  end if;

  select * into v_existing
    from public.exchange_accounts
   where user_id = p_user_id and exchange = 'okx';

  if found then
    perform vault.update_secret(v_existing.api_key_secret_id,    btrim(p_api_key));
    perform vault.update_secret(v_existing.api_secret_secret_id, btrim(p_api_secret));
    perform vault.update_secret(v_existing.passphrase_secret_id, btrim(p_passphrase));

    update public.exchange_accounts
       set label = v_label
     where id = v_existing.id;

    return v_existing.id;
  end if;

  v_id := gen_random_uuid();

  insert into public.exchange_accounts (
    id, user_id, exchange, label,
    api_key_secret_id, api_secret_secret_id, passphrase_secret_id
  )
  values (
    v_id, p_user_id, 'okx', v_label,
    vault.create_secret(btrim(p_api_key),    'okx_api_key:'    || v_id, 'OKX API key'),
    vault.create_secret(btrim(p_api_secret), 'okx_api_secret:' || v_id, 'OKX API secret'),
    vault.create_secret(btrim(p_passphrase), 'okx_passphrase:' || v_id, 'OKX API passphrase')
  );

  return v_id;
end;
$$;

revoke all on function public.save_okx_account_for(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_okx_account_for(uuid, text, text, text, text)
  to service_role;

-- 로그인한 사람이 자기 키를 넣는 통로. 소유자를 인자로 받지 않는다 —
-- 받으면 남의 계정에 키를 꽂을 수 있다.
create function public.save_okx_account(
  p_label      text,
  p_api_key    text,
  p_api_secret text,
  p_passphrase text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception '인증이 필요합니다.';
  end if;

  return public.save_okx_account_for(v_user, p_label, p_api_key, p_api_secret, p_passphrase);
end;
$$;

revoke all on function public.save_okx_account(text, text, text, text) from public, anon;
grant execute on function public.save_okx_account(text, text, text, text) to authenticated;

-- 복호화된 키를 돌려준다. **service_role 전용** — 브라우저에 세션이 있는 authenticated
-- 에게 열어 두면 XSS 한 번에 거래소 키가 통째로 새 나간다.
create function public.okx_credentials(p_account_id uuid)
returns table (api_key text, api_secret text, passphrase text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.exchange_accounts%rowtype;
begin
  select * into v_account
    from public.exchange_accounts
   where id = p_account_id and exchange = 'okx';

  if not found then
    raise exception '거래소 계정을 찾을 수 없습니다.';
  end if;

  return query
    select
      (select s.decrypted_secret from vault.decrypted_secrets s where s.id = v_account.api_key_secret_id),
      (select s.decrypted_secret from vault.decrypted_secrets s where s.id = v_account.api_secret_secret_id),
      (select s.decrypted_secret from vault.decrypted_secrets s where s.id = v_account.passphrase_secret_id);
end;
$$;

revoke all on function public.okx_credentials(uuid) from public, anon, authenticated;
grant execute on function public.okx_credentials(uuid) to service_role;

-- 계정을 지우면 Vault 비밀도 함께 지운다. 안 그러면 아무도 참조하지 않는 키가
-- 복호화 가능한 채로 남는다.
create function public.drop_exchange_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets
   where id in (
     old.api_key_secret_id,
     old.api_secret_secret_id,
     old.passphrase_secret_id
   );
  return old;
end;
$$;

revoke execute on function public.drop_exchange_secrets() from public, anon, authenticated;

create trigger exchange_accounts_drop_secrets
  after delete on public.exchange_accounts
  for each row execute function public.drop_exchange_secrets();

/* ============ 4. 현재 데이터는 cdhrich@gmail.com 것이다 ============

   지금까지 쌓인 거래는 전부 환경변수에 있던 그 OKX 계정에서 온 것이다.
   소유자를 명시적으로 못 박아 두지 않으면, 계정별 관리로 바꾼 뒤에도 누구 것인지
   모르는 행이 남는다.

   주의: `trade_images.storage_path`는 `{user_id}/{book_id}/...` 규칙이고 Storage RLS가
   첫 폴더로 소유자를 판정한다. 소유자가 실제로 바뀌는 행이 있으면 그 캡쳐는 보이지
   않게 되므로, 아래 NOTICE 건수가 0이 아니면 Storage 객체도 옮겨야 한다.          */

do $$
declare
  v_owner uuid;
  v_moved bigint;
  v_total bigint := 0;
begin
  select id into v_owner from auth.users where email = 'cdhrich@gmail.com';

  if v_owner is null then
    raise exception 'cdhrich@gmail.com 사용자가 없습니다. 먼저 그 계정으로 한 번 로그인한 뒤 다시 적용해 주세요.';
  end if;

  update public.books             set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.trades            set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.trade_fills       set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.trade_images      set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.balance_snapshots set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.cash_flows        set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.goals             set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  update public.sync_runs         set user_id = v_owner where user_id <> v_owner;
  get diagnostics v_moved = row_count; v_total := v_total + v_moved;

  raise notice '소유자를 cdhrich@gmail.com 으로 옮긴 행: %건', v_total;
end;
$$;
