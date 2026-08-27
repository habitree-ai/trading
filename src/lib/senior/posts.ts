/**
 * 글 색인 — 760편의 번호·날짜·게시판·제목·원문 URL.
 *
 * 정본은 `선배님/인덱스.csv` 다. 노트는 글 번호만 들고 있고, 제목·날짜는 여기서 푼다.
 * 본문은 없다 — 색인은 내가 만든 목록이고, 본문은 원저자의 것이라 네이버 링크로만 잇는다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SENIOR_DIR } from "@/lib/senior/docs";

export interface SeniorPost {
  /** 네이버 글 번호 — 원문 URL 의 마지막 조각 */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  board: string;
  title: string;
  url: string;
}

/** RFC 4180 — 따옴표로 감싼 칸 안의 쉼표·줄바꿈·겹따옴표를 처리한다. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const REQUIRED = ["게시판", "날짜", "제목", "원문URL"] as const;

/** 색인 CSV → 글 목록. 헤더 이름으로 칸을 찾는다 — 열 순서가 바뀌어도 깨지지 않게. */
export function parseIndexCsv(text: string): SeniorPost[] {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) return [];
  const col: Record<(typeof REQUIRED)[number], number> = {
    게시판: header.indexOf("게시판"),
    날짜: header.indexOf("날짜"),
    제목: header.indexOf("제목"),
    원문URL: header.indexOf("원문URL"),
  };
  for (const name of REQUIRED) {
    if (col[name] < 0) throw new Error(`인덱스.csv 에 '${name}' 열이 없습니다.`);
  }

  const posts: SeniorPost[] = [];
  for (const r of body) {
    const url = (r[col.원문URL] ?? "").trim();
    const id = url.split("/").pop() ?? "";
    if (!/^\d+$/.test(id)) continue;
    posts.push({
      id,
      date: (r[col.날짜] ?? "").trim(),
      board: (r[col.게시판] ?? "").trim(),
      title: (r[col.제목] ?? "").trim(),
      url,
    });
  }
  return posts;
}

let cached: SeniorPost[] | null = null;

/**
 * 색인 전체 — 프로세스당 한 번 읽는다. 파일이 없으면 빈 목록: 노트는 글 번호만 보여 주고
 * 글 고르기는 닫힌다.
 */
export function listSeniorPosts(): SeniorPost[] {
  if (cached === null) {
    try {
      cached = parseIndexCsv(readFileSync(join(process.cwd(), SENIOR_DIR, "인덱스.csv"), "utf8"));
    } catch {
      cached = [];
    }
  }
  return cached;
}

export function findSeniorPost(id: string | null): SeniorPost | null {
  if (!id) return null;
  return listSeniorPosts().find((p) => p.id === id) ?? null;
}
