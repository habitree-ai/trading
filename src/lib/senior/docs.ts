/**
 * 정리 문서 — `선배님/` 의 마크다운이 정본이고 여기서는 읽어서 그릴 뿐이다.
 *
 * 문서를 DB 로 옮기지 않는 이유: 정본이 둘이 되면 로컬 `정리.html` 과 공개 페이지가
 * 서로 다른 글을 보여 주게 된다. 문서를 고치는 일은 커밋이다.
 *
 * 파일 경로 상수는 이 파일에만 둔다 — 폴더를 옮기면 여기 한 줄만 바꾼다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderMarkdown, type RenderedMarkdown } from "@/lib/senior/markdown";

/** 저장소 루트 기준. 공개 페이지가 읽는 파일은 전부 이 아래에 있다. */
export const SENIOR_DIR = "선배님";

export interface SeniorDoc {
  slug: string;
  title: string;
  desc: string;
  file: string;
}

/**
 * 공개하는 문서 — 내가 쓴 정리 3종.
 * `결손목록.md` 는 수집 내부 산출물이라 여기 없다. 본문·이미지는 애초에 저장소에 없다.
 */
export const SENIOR_DOCS: SeniorDoc[] = [
  {
    slug: "philosophy",
    title: "투자철학 정리",
    desc: "방법론 5층 구조와, 그대로 쓸 때 생길 문제",
    file: "투자철학정리.md",
  },
  {
    slug: "boards",
    title: "게시판별 정리",
    desc: "게시판 19개를 원 순서·원 이름 그대로",
    file: "게시판별정리.md",
  },
  {
    slug: "themes",
    title: "종목·테마 정리",
    desc: "종목 타임라인과 개념어의 등장 시점",
    file: "종목테마별정리.md",
  },
];

export function findSeniorDoc(slug: string): SeniorDoc | null {
  return SENIOR_DOCS.find((d) => d.slug === slug) ?? null;
}

/**
 * 문서를 읽어 그린다. 파일이 없으면 null — 배포 번들에서 빠졌다는 뜻이고, 화면이
 * 그 사실을 말해야 한다(조용한 빈 화면은 "글이 없다"로 오독된다).
 */
export function readSeniorDoc(doc: SeniorDoc): RenderedMarkdown | null {
  try {
    return renderMarkdown(readFileSync(join(process.cwd(), SENIOR_DIR, doc.file), "utf8"));
  } catch {
    return null;
  }
}
