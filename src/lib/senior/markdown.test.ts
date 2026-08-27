import { describe, expect, it } from "vitest";

import { renderMarkdown } from "@/lib/senior/markdown";

describe("renderMarkdown — md2html.py 와 같은 출력", () => {
  it("헤딩은 id 를 얻고 3단까지만 목차에 오른다", () => {
    const { html, toc } = renderMarkdown("# 제목 A\n## 1. 방법론\n#### 깊은 것\n");
    expect(html).toBe('<h1 id="제목-a">제목 A</h1>\n<h2 id="1-방법론">1. 방법론</h2>\n<h4 id="깊은-것">깊은 것</h4>');
    expect(toc).toEqual([
      { level: 1, text: "제목 A", id: "제목-a" },
      { level: 2, text: "1. 방법론", id: "1-방법론" },
    ]);
  });

  it("같은 제목이 반복되면 -2, -3 을 붙인다", () => {
    const { toc } = renderMarkdown("## 요약\n## 요약\n## 요약\n");
    expect(toc.map((t) => t.id)).toEqual(["요약", "요약-2", "요약-3"]);
  });

  it("인라인 — 코드·링크·굵게·기울임, 그리고 이스케이프", () => {
    const { html } = renderMarkdown("`a<b` **굵게** *기울임* [글](https://x.io/1) 3 & 4\n");
    expect(html).toBe(
      '<p><code>a&lt;b</code> <strong>굵게</strong> <em>기울임</em> <a href="https://x.io/1" target="_blank" rel="noopener">글</a> 3 &amp; 4</p>',
    );
  });

  it("한글에 붙은 별표는 기울임이 아니다 — 파이썬 \\w 의 유니코드 규칙", () => {
    const { html } = renderMarkdown("가*나*다\n");
    expect(html).toBe("<p>가*나*다</p>");
  });

  it("표 — 정렬 행을 읽고 .tw 로 감싼다", () => {
    const { html } = renderMarkdown("| 항목 | 값 |\n|---|---:|\n| 이탈선 | **-20%** |\n");
    expect(html).toBe(
      '<div class="tw"><table><thead><tr><th style="text-align:left">항목</th><th style="text-align:right">값</th></tr></thead><tbody><tr><td style="text-align:left">이탈선</td><td style="text-align:right"><strong>-20%</strong></td></tr></tbody></table></div>',
    );
  });

  it("인용은 빈 줄을 버리고 <br> 로 잇는다", () => {
    const { html } = renderMarkdown("> 첫 줄\n>\n> 둘째 줄\n");
    expect(html).toBe("<blockquote>첫 줄<br>둘째 줄</blockquote>");
  });

  it("리스트 — 들여쓴 이어지는 줄은 같은 항목, 번호 목록은 ol", () => {
    const { html } = renderMarkdown("- 하나\n  이어서\n- 둘\n\n1. 첫째\n2. 둘째\n");
    expect(html).toBe("<ul><li>하나 이어서</li><li>둘</li></ul>\n<ol><li>첫째</li><li>둘째</li></ol>");
  });

  it("코드펜스는 따옴표까지 이스케이프하고 구분선은 hr", () => {
    const { html } = renderMarkdown("```\nif a < \"b\":\n```\n---\n본문 한 줄\n둘째 줄\n");
    expect(html).toBe(
      "<pre><code>if a &lt; &quot;b&quot;:</code></pre>\n<hr>\n<p>본문 한 줄<br>둘째 줄</p>",
    );
  });

  it("CRLF 입력도 LF 와 같은 결과", () => {
    expect(renderMarkdown("- 하나\r\n- 둘\r\n")).toEqual(renderMarkdown("- 하나\n- 둘\n"));
  });
});
