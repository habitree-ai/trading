#!/usr/bin/env node
/**
 * `senior_notes` 읽기·쓰기 CLI — 선배님 노트 에이전트(`.claude/agents/senior-blog.md`)가 쓴다.
 * 공개 페이지 `/blog` 의 "내 생각 노트" 정본이 이 표다. 화면의 관리자 폼과 같은 칸을 같은 규칙으로 쓴다.
 *
 *   node --env-file=.env.local scripts/senior-notes.mjs list [post_id]
 *   node --env-file=.env.local scripts/senior-notes.mjs upsert <json 파일> [--dry-run] [--owner 이메일]
 *   (npm run senior-notes -- list 222391599644)
 *
 * json 은 노트 하나(객체) 또는 여러 개(배열). 칸 이름은 표의 열과 같다:
 *   id · post_id · quote · think · apply · differ · ask · links[] · tags[] · status(draft|done)
 *
 * 고칠 행을 찾는 순서:
 *   1. `id` 가 있으면 그 행 — 적힌 칸만 바꾼다(없는 칸은 그대로).
 *   2. 없으면 같은 `post_id` + 같은 `quote` 인 행 — 있으면 위와 같이 고친다.
 *   3. 그것도 없으면 새 행. 쓴 사람은 `--owner`(기본 cdhrich@gmail.com).
 * `--dry-run` 은 무엇을 어떻게 할지만 찍고 표를 건드리지 않는다.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

const FIELDS = ["quote", "think", "apply", "differ", "ask"];

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ ${name} 가 없습니다. .env.local 을 확인해 주세요.`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv) {
  const positional = [];
  const flags = { dryRun: false, owner: "cdhrich@gmail.com" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--owner") {
      flags.owner = argv[i + 1] ?? flags.owner;
      i += 1;
    } else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, target] = positional;

if (command !== "list" && command !== "upsert") {
  console.error("사용법: senior-notes.mjs list [post_id] | upsert <json> [--dry-run] [--owner 이메일]");
  process.exit(1);
}

const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const digits = (v) => (/^\d+$/.test(String(v ?? "").trim()) ? String(v).trim() : null);
/** 브라우저 폼으로 쓴 행은 줄바꿈이 CRLF 다 — 비교·저장은 LF 로 맞춘다. */
const nl = (v) => String(v ?? "").replace(/\r\n?/g, "\n");

/** 입력 → 표의 열. 적힌 칸만 담는다 — 부분 갱신이 가능해야 에이전트가 한 칸만 고칠 수 있다. */
function normalize(input) {
  const row = {};
  const post_id = "post_id" in input ? digits(input.post_id) : undefined;
  if (post_id !== undefined) row.post_id = post_id;
  for (const f of FIELDS) if (f in input) row[f] = nl(input[f]).trim();
  if ("links" in input) {
    row.links = [...new Set((input.links ?? []).map(digits).filter((id) => id !== null))];
  }
  if ("tags" in input) {
    row.tags = [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))];
  }
  if ("status" in input) row.status = input.status === "done" ? "done" : "draft";
  return { id: typeof input.id === "string" && input.id ? input.id : null, row };
}

async function findUserByEmail(email) {
  const want = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`사용자 목록을 읽지 못했습니다: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === want);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function list(postId) {
  let q = supabase.from("senior_notes").select("*").order("updated_at", { ascending: false });
  const id = digits(postId);
  if (postId !== undefined) q = id === null ? q.is("post_id", null) : q.eq("post_id", id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  console.log(JSON.stringify(data, null, 2));
}

async function findExisting(id, row) {
  if (id) {
    const { data, error } = await supabase.from("senior_notes").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`id ${id} 인 노트가 없습니다.`);
    return data;
  }
  if (row.post_id === undefined || row.quote === undefined) return null;
  let q = supabase.from("senior_notes").select("*");
  q = row.post_id === null ? q.is("post_id", null) : q.eq("post_id", row.post_id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data.find((n) => nl(n.quote).trim() === row.quote) ?? null;
}

async function upsert(path) {
  if (!path) throw new Error("json 파일 경로가 필요합니다.");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const inputs = Array.isArray(parsed) ? parsed : [parsed];
  let owner = null;

  for (const input of inputs) {
    const { id, row } = normalize(input);
    if (row.post_id !== undefined && row.links) row.links = row.links.filter((l) => l !== row.post_id);
    const existing = await findExisting(id, row);

    if (existing) {
      // 대상 글이 바뀌지 않았다면 기존 post_id 기준으로도 자기 연결을 뺀다.
      const pid = row.post_id === undefined ? existing.post_id : row.post_id;
      if (row.links) row.links = row.links.filter((l) => l !== pid);
      const same = (k) =>
        typeof row[k] === "string" ? row[k] === nl(existing[k]).trim() : JSON.stringify(row[k]) === JSON.stringify(existing[k]);
      const changed = Object.keys(row).filter((k) => !same(k));
      if (flags.dryRun) {
        console.log(`[dry-run] 갱신 ${existing.id} (글 ${pid ?? "미지정"}) — 바뀌는 칸: ${changed.join(", ") || "없음"}`);
        continue;
      }
      if (changed.length === 0) {
        console.log(`= 변화 없음 ${existing.id} → /blog/notes/${existing.id}`);
        continue;
      }
      const { error } = await supabase.from("senior_notes").update(row).eq("id", existing.id);
      if (error) throw new Error(`갱신 실패(${existing.id}): ${error.message}`);
      console.log(`✔ 갱신 ${existing.id} [${changed.join(", ")}] → /blog/notes/${existing.id}`);
      continue;
    }

    const fresh = { post_id: null, quote: "", think: "", apply: "", differ: "", ask: "", links: [], tags: [], status: "draft", ...row };
    if (flags.dryRun) {
      console.log(`[dry-run] 신규 (글 ${fresh.post_id ?? "미지정"}) tags=${JSON.stringify(fresh.tags)} links=${fresh.links.length}개 status=${fresh.status}`);
      continue;
    }
    owner ??= await findUserByEmail(flags.owner);
    if (!owner) throw new Error(`${flags.owner} 사용자를 찾지 못했습니다. 한 번 로그인한 뒤 다시 돌려 주세요.`);
    const { data, error } = await supabase
      .from("senior_notes")
      .insert({ ...fresh, user_id: owner.id })
      .select("id")
      .single();
    if (error) throw new Error(`삽입 실패: ${error.message}`);
    console.log(`✔ 신규 ${data.id} (글 ${fresh.post_id ?? "미지정"}) → /blog/notes/${data.id}`);
  }
}

(command === "list" ? list(target) : upsert(target)).catch((cause) => {
  console.error(`✖ ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
});
