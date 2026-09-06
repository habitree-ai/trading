/**
 * 이미지 판독 — `선배님/전사/` 의 페이지(HTML)에 든 판독 데이터를 공개 페이지가 찾는다.
 *
 * 정본은 그 HTML 한 장이다. 이미지 옆에 판독 텍스트를 두고 페이지 안에서 고치면 같은 파일을
 * 다시 내려받아 덮어쓰는 구조라, 데이터는 `<script id="data" type="application/json">` 에
 * 통째로 들어 있다. 여기서는 그 JSON 만 꺼내 읽는다 — 따로 사본을 두면 정본이 둘이 된다.
 *
 * 이미지 파일 자체(`선배님/이미지/`)는 타인 저작물이라 배포하지 않는다. 공개 페이지는
 * 항목의 `naverUrl`(네이버 원본 주소)을 그대로 띄운다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SENIOR_DIR } from "@/lib/senior/docs";

/** 저장소 루트 기준. */
export const SENIOR_TRANSCRIPT_DIR = join(SENIOR_DIR, "전사");

export type SeniorTranscriptStatus = "auto" | "checked" | "user";

export const SENIOR_TRANSCRIPT_STATUS_LABEL: Record<SeniorTranscriptStatus, string> = {
  auto: "판독 초안",
  checked: "확인함",
  user: "직접 작성",
};

export interface SeniorTranscriptItem {
  seq: number;
  /** 수집본 파일 이름(로컬 전용) */
  file: string;
  /** 네이버 원본 주소 — 공개 페이지가 띄우는 것. 없으면 null */
  naverUrl: string | null;
  /** 수집본도 원본 주소도 없는 이미지 */
  missing: boolean;
  date: string;
  status: SeniorTranscriptStatus;
  /** 판독 텍스트. `[?]` 는 확신 없는 낱말, `[판독 불가]` 는 못 읽은 곳 */
  text: string;
  notes: string;
  /** 이 이미지 바로 뒤에 붙은 선배님 본문 문단 */
  caption: string;
}

export interface SeniorTranscript {
  /** 파일 이름(확장자 제외). `선배님/전사/<name>.html` */
  name: string;
  logNo: string;
  title: string;
  board: string;
  posted: string;
  url: string;
  updated: string;
  items: SeniorTranscriptItem[];
}

const DATA_OPEN = '<script id="data" type="application/json">';
const DATA_CLOSE = "</script>";

/**
 * 페이지 HTML 에서 판독 데이터를 꺼낸다. 데이터 블록이 없거나 모양이 다르면 null.
 * 페이지가 저장할 때 `<` 를 유니코드 이스케이프(backslash u003c)로 적어 두므로(닫는 태그 오인 방지)
 * JSON.parse 가 그대로 되돌린다.
 */
export function parseSeniorTranscriptHtml(html: string, name: string): SeniorTranscript | null {
  const start = html.indexOf(DATA_OPEN);
  if (start < 0) return null;
  const from = start + DATA_OPEN.length;
  const end = html.indexOf(DATA_CLOSE, from);
  if (end < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(html.slice(from, end));
  } catch {
    return null;
  }
  if (!isTranscriptData(data)) return null;
  return {
    name,
    logNo: data.logNo,
    title: data.title,
    board: data.board,
    posted: data.posted,
    url: data.url,
    updated: data.updated,
    items: data.items.map((it) => ({
      seq: it.seq,
      file: it.file,
      naverUrl: typeof it.naverUrl === "string" && it.naverUrl !== "" ? it.naverUrl : null,
      missing: it.missing === true,
      date: it.date,
      status: it.status === "checked" || it.status === "user" ? it.status : "auto",
      text: it.text,
      notes: typeof it.notes === "string" ? it.notes : "",
      caption: typeof it.caption === "string" ? it.caption : "",
    })),
  };
}

/**
 * 폴더의 페이지를 읽어 목록을 만든다. 글 게시일 내림차순.
 * 폴더가 없거나(배포 번들에서 빠짐) 데이터가 깨졌으면 그 항목만 건너뛴다.
 */
export function listSeniorTranscripts(): SeniorTranscript[] {
  let files: string[];
  try {
    files = readdirSync(join(process.cwd(), SENIOR_TRANSCRIPT_DIR));
  } catch {
    return [];
  }
  const out: SeniorTranscript[] = [];
  for (const f of files) {
    if (!f.endsWith(".html") || f.startsWith("_")) continue;
    try {
      const html = readFileSync(join(process.cwd(), SENIOR_TRANSCRIPT_DIR, f), "utf8");
      const t = parseSeniorTranscriptHtml(html, f.slice(0, -".html".length));
      if (t) out.push(t);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.posted.localeCompare(a.posted));
}

/** 어떤 글(네이버 글 번호)의 판독들 — 노트 페이지가 "이 글의 이미지와 판독"으로 잇는다. */
export function listSeniorTranscriptsForPost(logNo: string | null | undefined): SeniorTranscript[] {
  if (!logNo) return [];
  return listSeniorTranscripts().filter((t) => t.logNo === logNo);
}

interface TranscriptData {
  logNo: string;
  title: string;
  board: string;
  posted: string;
  url: string;
  updated: string;
  items: TranscriptItemData[];
}

interface TranscriptItemData {
  seq: number;
  file: string;
  naverUrl?: unknown;
  missing?: unknown;
  date: string;
  status?: unknown;
  text: string;
  notes?: unknown;
  caption?: unknown;
}

function isTranscriptData(x: unknown): x is TranscriptData {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.logNo === "string" &&
    typeof o.title === "string" &&
    typeof o.board === "string" &&
    typeof o.posted === "string" &&
    typeof o.url === "string" &&
    typeof o.updated === "string" &&
    Array.isArray(o.items) &&
    o.items.every(isTranscriptItemData)
  );
}

function isTranscriptItemData(x: unknown): x is TranscriptItemData {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.seq === "number" && typeof o.file === "string" && typeof o.date === "string" && typeof o.text === "string"
  );
}
