/**
 * 정리 문서 제자리 검색 — 그려진 본문을 감추는 필터.
 *
 * 본문 HTML 은 `markdown.ts` 가 만들어 `dangerouslySetInnerHTML` 로 한 번 꽂히고 React 가
 * 다시 그리지 않는다. 그래서 검색은 표를 다시 만들지 않고 그 DOM 을 직접 감춘다 —
 * 마크다운 정본과 렌더 계약을 건드리지 않는 가장 얇은 길이다.
 *
 * 검색 대상은 화면에 이미 보이는 값뿐이다: 절 이름(게시판·주제·연도) · 날짜 · 제목 · logNo.
 * 본문(원문)은 저장소에 없다 — 타인 저작물이라 색인만 공개한다.
 */

/** 본문 `<article>` 의 id — 서버 컴포넌트가 붙이고 검색이 이것으로 찾는다. */
export const DOC_BODY_ID = "senior-doc";

/** 목차 nav — 데스크톱·모바일 두 벌이 같은 라벨을 쓴다. 둘 다 같이 접는다. */
const TOC_SELECTOR = 'nav[aria-label="목차"]';

const HEADING = /^H([1-4])$/;

interface Row {
  el: HTMLElement;
  /** 절 이름 + 행 텍스트 — 정규화해 둔다(입력마다 다시 만들지 않는다) */
  text: string;
  logNo: string;
  show: boolean;
}

interface Section {
  level: number;
  heading: HTMLElement;
  /** 한 단계 위 절 — 연도 절의 게시판 절, 주제 절의 대제목 */
  parent: Section | null;
  /** 헤딩 다음 형제들 — 다음 헤딩 전까지 */
  body: HTMLElement[];
  /** 글 표(`logNo` 열)를 품은 body 요소 → 그 표의 행 */
  tables: Map<HTMLElement, Row[]>;
  visible: boolean;
}

export interface DocIndex {
  sections: Section[];
  rows: Row[];
  /** 문서 전체 글 수 — logNo 중복을 뺀 값 */
  total: number;
  /** 헤딩 id → 목차 링크들 */
  toc: Map<string, HTMLElement[]>;
}

/** 대소문자·연속 공백을 고른다. 검색어와 대상에 똑같이 쓴다. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 헤딩에서 검색에 쓸 이름 — `—` 앞까지.
 *
 * 「07. 매매일지 — 262편 (2007-10-04 ~ 2015-01-09)」 을 통째로 쓰면 뒤의 기간 숫자가
 * 그 게시판 262행에 전부 걸린다(`2015-01` 을 찾았는데 2007년 글이 나온다).
 */
export function sectionLabel(text: string): string {
  const head = normalize(text.split("—")[0] ?? "");
  return head === "" ? normalize(text) : head;
}

function sectionPath(section: Section): string {
  const parts: string[] = [];
  for (let s: Section | null = section; s !== null; s = s.parent) {
    parts.push(sectionLabel(s.heading.textContent ?? ""));
  }
  return parts.reverse().join(" ");
}

/** 글 표인지 — 머리에 `logNo` 칸이 있으면 글 표다. 없으면 「한눈에」 요약표다. */
function logNoColumn(table: Element): number {
  return Array.from(table.querySelectorAll("thead th")).findIndex(
    (th) => (th.textContent ?? "").trim() === "logNo",
  );
}

function countPosts(rows: Row[]): number {
  const ids = new Set<string>();
  for (const row of rows) if (row.logNo !== "") ids.add(row.logNo);
  return ids.size;
}

function show(el: HTMLElement, visible: boolean): void {
  const next = visible ? "" : "none";
  if (el.style.display !== next) el.style.display = next;
}

/**
 * 본문을 한 번 훑어 절·행 색인을 만든다. 마운트 때 한 번만 부른다.
 *
 * 절은 헤딩 하나 + 다음 헤딩 전까지다. 문서 순서대로 쌓으면 자식 절이 부모보다 뒤에 온다 —
 * 보임 판정을 거꾸로 훑어 올릴 수 있게 하는 성질이다.
 */
export function buildDocIndex(root: HTMLElement, scope: ParentNode = root.ownerDocument): DocIndex {
  const sections: Section[] = [];
  const rows: Row[] = [];
  const stack: Section[] = [];
  let current: Section | null = null;

  for (const child of Array.from(root.children) as HTMLElement[]) {
    const heading = HEADING.exec(child.tagName);
    if (heading) {
      const level = Number(heading[1]);
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      current = {
        level,
        heading: child,
        parent: stack[stack.length - 1] ?? null,
        body: [],
        tables: new Map(),
        visible: true,
      };
      stack.push(current);
      sections.push(current);
      continue;
    }
    // 첫 헤딩 앞에는 아무것도 없다(문서는 h1 으로 시작한다). 있어도 검색과 상관없다.
    if (current !== null) current.body.push(child);
  }

  for (const section of sections) {
    const label = sectionPath(section);
    for (const el of section.body) {
      for (const table of Array.from(el.querySelectorAll("table"))) {
        const at = logNoColumn(table);
        if (at < 0) continue;
        const list = section.tables.get(el) ?? [];
        for (const tr of Array.from(table.querySelectorAll("tbody tr")) as HTMLElement[]) {
          const row: Row = {
            el: tr,
            text: `${label} ${normalize(tr.textContent ?? "")}`,
            logNo: (tr.children[at]?.textContent ?? "").trim(),
            show: true,
          };
          list.push(row);
          rows.push(row);
        }
        if (list.length > 0) section.tables.set(el, list);
      }
    }
  }

  const toc = new Map<string, HTMLElement[]>();
  for (const nav of Array.from(scope.querySelectorAll<HTMLElement>(TOC_SELECTOR))) {
    for (const link of Array.from(nav.querySelectorAll<HTMLElement>('a[href^="#"]'))) {
      const id = (link.getAttribute("href") ?? "").slice(1);
      if (id === "") continue;
      toc.set(id, [...(toc.get(id) ?? []), link]);
    }
  }

  return { sections, rows, total: countPosts(rows), toc };
}

/**
 * 검색어로 본문을 접는다. 빈 검색어는 전부 펴므로 되돌리기 경로가 따로 없다.
 *
 * 절은 자기 표에 남은 행이 있거나 아래 절 하나라도 남으면 보인다. 글 표가 아예 없는 절
 * (머리말, 「한눈에」 요약표)은 검색 중에는 접힌다 — 결과만 보이게.
 */
export function applyDocFilter(index: DocIndex, query: string): { posts: number } {
  const needle = normalize(query);
  const all = needle === "";

  for (const row of index.rows) row.show = all || row.text.includes(needle);
  for (const section of index.sections) section.visible = all;

  if (!all) {
    for (let i = index.sections.length - 1; i >= 0; i -= 1) {
      const section = index.sections[i];
      for (const rows of section.tables.values()) {
        if (rows.some((row) => row.show)) {
          section.visible = true;
          break;
        }
      }
      if (section.visible && section.parent !== null) section.parent.visible = true;
    }
  }

  for (const section of index.sections) {
    show(section.heading, section.visible);
    for (const el of section.body) {
      const rows = section.tables.get(el);
      show(el, section.visible && (rows === undefined || rows.some((row) => row.show)));
    }
    for (const link of index.toc.get(section.heading.id) ?? []) show(link, section.visible);
  }
  for (const row of index.rows) show(row.el, row.show);

  return { posts: countPosts(index.rows.filter((row) => row.show)) };
}
