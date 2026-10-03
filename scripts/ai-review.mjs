#!/usr/bin/env node
/**
 * AI 분석 회차 CLI — 사용자가 대화로 지시할 때만 Claude Code 가 쓴다 (REQ-0088).
 * 화면 `/ai-review` 는 보기만 하고, 회차를 만드는 길은 이 스크립트 하나다. 절차는 docs/ai-review/README.md.
 *
 *   npm run ai-review -- dump <북 이름> <출력 json>     분석 재료(북의 기록 전부)를 파일로
 *   npm run ai-review -- list <북 이름>                 저장된 회차 목록
 *   npm run ai-review -- save <북 이름> <회차 json> [--dry-run]
 *
 * 회차 json: { title, periodFrom?, periodTo?, tradeCount, content }
 * content 는 src/lib/ai-review.ts 의 파서를 통과해야 저장된다. 회차 번호는 그 북의 마지막 + 1.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { parseAiReviewContent } from "../src/lib/ai-review.ts";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ ${name} 가 없습니다. .env.local 을 확인해 주세요.`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [command, bookName, file] = args.filter((a) => a !== "--dry-run");

if (!["dump", "list", "save"].includes(command) || !bookName || (command !== "list" && !file)) {
  console.error("사용법: ai-review.mjs dump <북> <출력> | list <북> | save <북> <회차 json> [--dry-run]");
  process.exit(1);
}

const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function findBook(name) {
  const books = await rows(supabase.from("books").select("*").eq("name", name));
  if (books.length !== 1) throw new Error(`이름이 "${name}" 인 북이 ${books.length}개입니다 — 정확히 1개여야 합니다.`);
  return books[0];
}

/** 북 하나의 기록 전부. 분석은 이 파일만 보고 한다 — 화면에 없는 칸도 그대로 담는다. */
async function dump(book, out) {
  const trades = await rows(supabase.from("trades").select("*").eq("book_id", book.id).order("entry_at"));
  const ids = trades.map((t) => t.id);
  const byTrades = (table) => (ids.length ? rows(supabase.from(table).select("*").in("trade_id", ids)) : []);
  const byBook = (table) => rows(supabase.from(table).select("*").eq("book_id", book.id));

  const [fills, notes, principles, checks, flats, flows, snapshots, reviews] = await Promise.all([
    byTrades("trade_fills"),
    byBook("journal_notes"),
    byBook("principles"),
    byTrades("trade_principle_checks"),
    byBook("flat_sessions"),
    byBook("cash_flows"),
    byBook("balance_snapshots"),
    byBook("ai_reviews"),
  ]);

  const data = { dumpedAt: new Date().toISOString(), book, trades, fills, notes, principles, checks, flats, flows, snapshots, reviews };
  writeFileSync(out, JSON.stringify(data, null, 1));
  console.log(
    `✔ ${out} — 거래 ${trades.length} · 체결 ${fills.length} · 기록 ${notes.length} · 원칙 ${principles.length} · 체크 ${checks.length} · 무포지션 ${flats.length} · 이전 회차 ${reviews.length}`,
  );
}

async function list(book) {
  const data = await rows(
    supabase.from("ai_reviews").select("round, title, trade_count, period_from, period_to, generated_at").eq("book_id", book.id).order("round"),
  );
  console.log(JSON.stringify(data, null, 2));
}

async function save(book, path) {
  const input = JSON.parse(readFileSync(path, "utf8"));
  const parsed = parseAiReviewContent(input.content);
  const problems = [...(parsed.ok ? [] : parsed.errors)];
  if (typeof input.title !== "string" || !input.title.trim()) problems.push("title: 필수");
  if (!Number.isInteger(input.tradeCount) || input.tradeCount < 0) problems.push("tradeCount: 0 이상 정수");
  if (problems.length) throw new Error(`형식 오류 ${problems.length}건\n  - ${problems.join("\n  - ")}`);

  const last = await rows(supabase.from("ai_reviews").select("round").eq("book_id", book.id).order("round", { ascending: false }).limit(1));
  const round = (last[0]?.round ?? 0) + 1;
  const row = {
    book_id: book.id,
    user_id: book.user_id,
    round,
    title: input.title.trim(),
    period_from: input.periodFrom ?? null,
    period_to: input.periodTo ?? null,
    trade_count: input.tradeCount,
    content: input.content,
  };
  const items = parsed.value.sections.reduce((n, s) => n + s.items.length, 0);
  if (dryRun) {
    console.log(`[dry-run] ${book.name} ${round}회차 "${row.title}" — 섹션 ${parsed.value.sections.length} · 항목 ${items}`);
    return;
  }
  await rows(supabase.from("ai_reviews").insert(row).select("id"));
  console.log(`✔ ${book.name} ${round}회차 저장 — 섹션 ${parsed.value.sections.length} · 항목 ${items} → /ai-review?round=${round}`);
}

findBook(bookName)
  .then((book) => (command === "dump" ? dump(book, file) : command === "list" ? list(book) : save(book, file)))
  .catch((cause) => {
    console.error(`✖ ${cause instanceof Error ? cause.message : cause}`);
    // process.exit 는 윈도에서 열린 소켓과 겹쳐 libuv 단언으로 죽는다 — 종료 코드만 남긴다.
    process.exitCode = 1;
  });
