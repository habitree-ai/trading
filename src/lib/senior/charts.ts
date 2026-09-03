/**
 * 시세 대조 차트 — `선배님/차트/` 의 스펙(JSON)과 산출물(HTML·CSV)을 공개 페이지가 찾는다.
 *
 * 정본은 폴더의 파일이다. 스펙 하나가 차트 한 장이고, `make_chart.py` 가 스펙에서 같은 이름의
 * HTML 을 만든다. 목록도 스펙에서 읽는다 — 카탈로그를 따로 두면 정본이 둘이 된다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SENIOR_DIR } from "@/lib/senior/docs";

/** 저장소 루트 기준. route 와 목록이 같은 폴더를 본다. */
export const SENIOR_CHART_DIR = join(SENIOR_DIR, "차트");

/** 공개 페이지가 열어 주는 파일 종류 — 이 밖의 확장자는 404. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
};

/**
 * 경로 세그먼트가 열어도 되는 차트 파일이면 content-type 을, 아니면 null.
 * 폴더 안 한 단계만 허용하고(`a/b.html` 불가), `..`·빈 세그먼트·모르는 확장자는 거른다.
 */
export function isSeniorChartFile(segments: string[]): string | null {
  if (segments.length !== 1) return null;
  const name = segments[0];
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith("_")) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!name.includes(".") || ext === name) return null;
  return CONTENT_TYPES[ext] ?? null;
}

export interface SeniorChart {
  /** 파일 이름(확장자 제외). `/blog/charts/<name>.html` */
  name: string;
  title: string;
  symbol: string;
  eventDate: string;
  post: { title: string; board: string; date: string; url: string };
  /** 스펙에 options 가 있으면 `<name>_옵션.html` 옵션 자료 페이지가 같이 생성돼 있다. */
  hasOptions: boolean;
}

/**
 * 폴더의 스펙을 읽어 목록을 만든다. 이벤트 날짜 내림차순.
 * 폴더가 없거나(배포 번들에서 빠짐) 스펙이 깨졌으면 그 항목만 건너뛴다.
 */
export function listSeniorCharts(): SeniorChart[] {
  let files: string[];
  try {
    files = readdirSync(join(process.cwd(), SENIOR_CHART_DIR));
  } catch {
    return [];
  }
  const out: SeniorChart[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const spec: unknown = JSON.parse(readFileSync(join(process.cwd(), SENIOR_CHART_DIR, f), "utf8"));
      if (!isSpec(spec)) continue;
      out.push({
        name: f.slice(0, -".json".length),
        title: spec.title,
        symbol: spec.symbol,
        eventDate: spec.event_date,
        post: spec.post,
        hasOptions: typeof spec.options === "object" && spec.options !== null,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.eventDate.localeCompare(a.eventDate));
}

/** 어떤 글(네이버 원문 URL)을 되짚은 차트들 — 노트 페이지가 "이 글의 시세 대조"로 잇는다. */
export function listSeniorChartsForPost(postUrl: string | null | undefined): SeniorChart[] {
  if (!postUrl) return [];
  return listSeniorCharts().filter((c) => c.post.url === postUrl);
}

interface ChartSpec {
  title: string;
  symbol: string;
  event_date: string;
  post: { title: string; board: string; date: string; url: string };
  options?: unknown;
}

function isSpec(x: unknown): x is ChartSpec {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const post = o.post as Record<string, unknown> | undefined;
  return (
    typeof o.title === "string" &&
    typeof o.symbol === "string" &&
    typeof o.event_date === "string" &&
    typeof post === "object" &&
    post !== null &&
    typeof post.title === "string" &&
    typeof post.board === "string" &&
    typeof post.date === "string" &&
    typeof post.url === "string"
  );
}
