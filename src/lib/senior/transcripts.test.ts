import { describe, expect, it } from "vitest";

import { parseSeniorTranscriptHtml } from "@/lib/senior/transcripts";

const DATA = {
  logNo: "223368026131",
  title: "4년전 그날.",
  board: "단상 (斷想 )",
  posted: "2024-02-28",
  url: "https://blog.naver.com/pillion21/223368026131",
  updated: "2026-09-05T02:50:00.000Z",
  items: [
    {
      seq: 1,
      file: "a_01.jpg",
      naverUrl: "https://blogfiles.pstatic.net/x/a.jpg?type=w1",
      date: "2020-02-28 (금)",
      status: "checked",
      text: "<260p ~ 270p> 이 구간에서만",
      notes: "메모",
      caption: "본문",
    },
    { seq: 3, file: "a_03.jpg", naverUrl: "", missing: true, date: "(추정)", status: "weird", text: "" },
  ],
};

function page(json: string): string {
  return `<!doctype html><html><body><main id="list"></main><script id="data" type="application/json">${json}</script><script>render()</script></body></html>`;
}

describe("parseSeniorTranscriptHtml", () => {
  it("데이터 블록의 JSON 을 꺼내고 빠진 칸은 기본값으로 채운다", () => {
    const html = page(JSON.stringify(DATA, null, 1).replace(/</g, "\\u003c"));
    const t = parseSeniorTranscriptHtml(html, "a");
    expect(t?.name).toBe("a");
    expect(t?.logNo).toBe("223368026131");
    expect(t?.items).toHaveLength(2);
    expect(t?.items[0]).toMatchObject({
      seq: 1,
      naverUrl: "https://blogfiles.pstatic.net/x/a.jpg?type=w1",
      missing: false,
      status: "checked",
      text: "<260p ~ 270p> 이 구간에서만",
    });
    expect(t?.items[1]).toMatchObject({ seq: 3, naverUrl: null, missing: true, status: "auto", notes: "", caption: "" });
  });

  it("데이터 블록이 없거나 JSON 이 깨졌거나 모양이 다르면 null", () => {
    expect(parseSeniorTranscriptHtml("<html></html>", "a")).toBeNull();
    expect(parseSeniorTranscriptHtml(page("{not json"), "a")).toBeNull();
    expect(parseSeniorTranscriptHtml(page(JSON.stringify({ logNo: "1" })), "a")).toBeNull();
  });
});
