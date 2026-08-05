#!/usr/bin/env node
/**
 * 환경변수에 있던 OKX 키를 소유자의 거래소 계정으로 옮긴다 — 한 번만 돌리면 된다.
 *
 *   node --env-file=.env.local scripts/seed-okx-account.mjs
 *   (npm run seed:okx-account)
 *
 * 하는 일은 둘이다.
 *   1) OKX_API_KEY/SECRET/PASSPHRASE 를 Vault 에 넣고 exchange_accounts 행을 만든다.
 *   2) 예전에 `okx_sync_enabled` 로 표시해 두었던 북을 그 계정에 연결한다.
 *
 * 마이그레이션 0010 과 0011 **사이에서** 돌려야 한다. 0011 이 그 표시 컬럼을 지우기
 * 때문이다. 두 번 돌려도 결과는 같다 — 키는 덮어쓰고 연결은 이미 되어 있으면 넘어간다.
 *
 * 키 원문은 화면에 찍지 않는다.
 */

import { createClient } from "@supabase/supabase-js";

const OWNER_EMAIL = process.argv[2] ?? "cdhrich@gmail.com";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ ${name} 가 없습니다. .env.local 을 확인해 주세요.`);
    process.exit(1);
  }
  return value;
}

const url = required("NEXT_PUBLIC_SUPABASE_URL");
const secretKey = required("SUPABASE_SECRET_KEY");
const apiKey = required("OKX_API_KEY");
const apiSecret = required("OKX_API_SECRET");
const passphrase = required("OKX_API_PASSPHRASE");

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 이메일로 사용자를 찾는다 — admin API 는 목록만 주므로 페이지를 넘겨 가며 훑는다. */
async function findUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`사용자 목록을 읽지 못했습니다: ${error.message}`);

    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * 예전 표시 컬럼을 읽는다. 0011 이 이미 적용됐으면 컬럼이 없다 — 그건 오류가 아니라
 * "옮길 것이 남아 있지 않다"는 뜻이므로 빈 목록으로 본다.
 */
async function legacyEnabledBooks(userId) {
  const { data, error } = await supabase
    .from("books")
    .select("id, name, exchange_account_id")
    .eq("user_id", userId)
    .eq("okx_sync_enabled", true);

  if (error) {
    if (/okx_sync_enabled/.test(error.message)) return null;
    throw new Error(`북을 읽지 못했습니다: ${error.message}`);
  }
  return data;
}

const owner = await findUserByEmail(OWNER_EMAIL);
if (!owner) {
  console.error(`✖ ${OWNER_EMAIL} 사용자가 없습니다. 먼저 그 계정으로 한 번 로그인해 주세요.`);
  process.exit(1);
}

const { data: accountId, error: saveError } = await supabase.rpc("save_okx_account_for", {
  p_user_id: owner.id,
  p_label: "OKX",
  p_api_key: apiKey,
  p_api_secret: apiSecret,
  p_passphrase: passphrase,
});

if (saveError) {
  console.error(`✖ 거래소 계정을 저장하지 못했습니다: ${saveError.message}`);
  process.exit(1);
}

console.log(`✓ ${OWNER_EMAIL} 의 OKX 계정을 Vault 에 저장했습니다. (id ${accountId})`);

const books = await legacyEnabledBooks(owner.id);

if (books === null) {
  console.log("· books.okx_sync_enabled 가 이미 없습니다 — 북 연결은 건너뜁니다.");
} else if (books.length === 0) {
  console.log("· OKX 동기화가 켜져 있던 북이 없습니다. 설정 화면에서 북을 연결해 주세요.");
} else {
  for (const book of books) {
    if (book.exchange_account_id === accountId) {
      console.log(`· '${book.name}' 은 이미 연결돼 있습니다.`);
      continue;
    }
    const { error } = await supabase
      .from("books")
      .update({ exchange_account_id: accountId })
      .eq("id", book.id);

    if (error) {
      console.error(`✖ '${book.name}' 연결 실패: ${error.message}`);
      process.exit(1);
    }
    console.log(`✓ '${book.name}' 을 OKX 계정에 연결했습니다.`);
  }
}

console.log("\n다음: supabase/migrations/0011_drop_okx_sync_enabled.sql 를 적용하고,");
console.log("      .env 에서 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 를 지우세요.");
