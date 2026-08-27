#!/usr/bin/env node
/**
 * 로컬 뷰어(선배님/내생각.html)가 쓰던 노트 — `선배님/_수집원본/notes-data.json` — 를
 * `senior_notes` 로 옮긴다. 이후 정본은 DB 다. json 은 손대지 않는다.
 *
 *   node --env-file=.env.local scripts/seed-senior-notes.mjs [관리자 이메일]
 *   (npm run seed:senior-notes)
 *
 * 마이그레이션 0023 을 적용한 뒤 돌린다. 두 번 돌려도 결과는 같다 —
 * 같은 글 번호·같은 인용의 노트가 이미 있으면 건너뛴다.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

const OWNER_EMAIL = process.argv[2] ?? "cdhrich@gmail.com";
const SOURCE = "선배님/_수집원본/notes-data.json";

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

/** 로컬 노트의 `YYYY-MM-DD` — 시각이 없으니 서울 자정으로 둔다. 없으면 DB 기본값. */
function stamp(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ? `${day}T00:00:00+09:00` : undefined;
}

async function main() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(SOURCE, "utf8"));
  } catch (cause) {
    console.error(`✖ ${SOURCE} 를 읽지 못했습니다: ${cause.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error(`✖ ${SOURCE} 는 배열이어야 합니다.`);
    process.exit(1);
  }

  const user = await findUserByEmail(OWNER_EMAIL);
  if (!user) {
    console.error(`✖ ${OWNER_EMAIL} 사용자를 찾지 못했습니다. 한 번 로그인한 뒤 다시 돌려 주세요.`);
    process.exit(1);
  }

  let inserted = 0;
  let skipped = 0;
  for (const n of raw) {
    const post_id = /^\d+$/.test(n.post ?? "") ? n.post : null;
    const quote = (n.quote ?? "").trim();

    let dup = supabase.from("senior_notes").select("id").eq("quote", quote).limit(1);
    dup = post_id === null ? dup.is("post_id", null) : dup.eq("post_id", post_id);
    const { data: existing, error: findError } = await dup;
    if (findError) throw new Error(`중복 확인 실패: ${findError.message}`);
    if (existing.length > 0) {
      skipped += 1;
      continue;
    }

    const { error } = await supabase.from("senior_notes").insert({
      user_id: user.id,
      post_id,
      quote,
      think: (n.think ?? "").trim(),
      apply: (n.apply ?? "").trim(),
      differ: (n.differ ?? "").trim(),
      ask: (n.ask ?? "").trim(),
      links: [...new Set((n.links ?? []).filter((id) => /^\d+$/.test(id) && id !== post_id))],
      tags: [...new Set((n.tags ?? []).map((t) => String(t).trim()).filter(Boolean))],
      status: n.status === "done" ? "done" : "draft",
      created_at: stamp(n.created),
      updated_at: stamp(n.updated),
    });
    if (error) throw new Error(`삽입 실패(${n.id ?? "?"}): ${error.message}`);
    inserted += 1;
  }

  console.log(`✔ senior_notes 시드 완료 — 추가 ${inserted}, 건너뜀 ${skipped} (원본 ${raw.length}건)`);
}

main().catch((cause) => {
  console.error(`✖ ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
});
