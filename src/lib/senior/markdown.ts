/**
 * 정리 문서 마크다운 → HTML.
 *
 * `선배님/_수집스크립트/md2html.py` 를 그대로 옮긴 것이다. 로컬 `정리.html` 과 공개
 * 페이지가 같은 문서를 같은 모양으로 그려야 하므로 출력 계약을 그쪽에 맞춘다 —
 * 헤딩 id 규칙, 표의 `.tw` 래퍼, 인용의 `<br>` 이어 붙이기까지 같다.
 *
 * 범용 마크다운 라이브러리를 들이지 않는 이유도 같다: 이 문서 형식에 필요한 것만,
 * 같은 규칙으로. 입력은 저장소에 커밋된 내 문서뿐이라 신뢰하되 본문은 이스케이프한다.
 */

export interface TocEntry {
  /** 1~3. 4단 헤딩은 본문에는 나오지만 목차에는 오르지 않는다. */
  level: number;
  text: string;
  id: string;
}

export interface RenderedMarkdown {
  html: string;
  toc: TocEntry[];
}

/** python `html.escape(quote=False)` */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** python `html.escape()` — 코드펜스 안에서만 쓴다. */
function escapeAll(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/**
 * 인라인 — 코드 → 링크 → 굵게 → 기울임 순. 순서가 바뀌면 코드 안의 `*` 가 기울임으로 잡힌다.
 *
 * 파이썬의 `\w` 는 유니코드 글자를 포함하므로 `[\p{L}\p{N}_]` 로 옮긴다 —
 * 한글 바로 뒤의 `*` 는 기울임 시작이 아니어야 한다.
 */
function inline(s: string): string {
  let out = escapeText(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<![\p{L}\p{N}_*])\*([^*\n]+)\*(?![\p{L}\p{N}_*])/gu, "<em>$1</em>");
  return out;
}

/** 헤딩 텍스트 → id. 같은 제목이 두 번 나오면 `-2`, `-3` 을 붙인다. */
function slugify(text: string, used: Set<string>): string {
  const base =
    text
      .replace(/[^\p{L}\p{N}_]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "h";
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const LIST_START = /^(\s*)([-*]|\d+\.)\s+/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export function renderMarkdown(md: string): RenderedMarkdown {
  // 파이썬은 `\r` 을 공백으로 다루지만 JS 의 `.` 은 `\r` 앞에서 멈춘다 — 먼저 걷어 낸다.
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  const n = lines.length;
  let i = 0;
  let para: string[] = [];

  const flush = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };

  while (i < n) {
    const ln = lines[i];
    const st = ln.trim();

    // 코드펜스
    if (st.startsWith("```")) {
      flush();
      i += 1;
      const buf: string[] = [];
      while (i < n && !lines[i].trim().startsWith("```")) {
        buf.push(escapeAll(lines[i]));
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // 헤딩
    const heading = /^(#{1,4})\s+(.*)$/.exec(st);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text, used);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      if (level <= 3) toc.push({ level, text, id });
      i += 1;
      continue;
    }

    // 구분선
    if (/^(-{3,}|\*{3,})$/.test(st)) {
      flush();
      out.push("<hr>");
      i += 1;
      continue;
    }

    // 표 — 다음 줄이 구분 행이어야 표다.
    if (st.startsWith("|") && i + 1 < n && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
      flush();
      const head = cells(ln);
      const aligns = cells(lines[i + 1]).map((c) =>
        c.endsWith(":") && !c.startsWith(":")
          ? "right"
          : c.startsWith(":") && c.endsWith(":")
            ? "center"
            : "left",
      );
      i += 2;
      const rows: string[][] = [];
      while (i < n && lines[i].trim().startsWith("|")) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      const t: string[] = ['<div class="tw"><table><thead><tr>'];
      head.forEach((c, j) => {
        t.push(`<th style="text-align:${aligns[j] ?? "left"}">${inline(c)}</th>`);
      });
      t.push("</tr></thead><tbody>");
      for (const r of rows) {
        t.push("<tr>");
        r.forEach((c, j) => {
          t.push(`<td style="text-align:${aligns[j] ?? "left"}">${inline(c)}</td>`);
        });
        t.push("</tr>");
      }
      t.push("</tbody></table></div>");
      out.push(t.join(""));
      continue;
    }

    // 인용
    if (st.startsWith(">")) {
      flush();
      const buf: string[] = [];
      while (i < n && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>+/, "").trim());
        i += 1;
      }
      out.push(`<blockquote>${buf.filter((x) => x !== "").map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    // 리스트 — 들여쓴 이어지는 줄은 같은 항목에 붙인다.
    const item = LIST_ITEM.exec(ln);
    if (item) {
      flush();
      const tag = /^\d+\.$/.test(item[2]) ? "ol" : "ul";
      const items: string[] = [];
      while (i < n) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m) break;
        items.push(m[3]);
        i += 1;
        while (
          i < n &&
          lines[i].trim() !== "" &&
          !LIST_START.test(lines[i]) &&
          lines[i].startsWith("  ") &&
          !lines[i].trim().startsWith("|")
        ) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }

    // 빈 줄 / 본문
    if (st === "") {
      flush();
      i += 1;
      continue;
    }
    para.push(st);
    i += 1;
  }
  flush();

  return { html: out.join("\n"), toc };
}
