import { describe, expect, it } from "vitest";

import { parseCsv, parseIndexCsv } from "@/lib/senior/posts";

describe("parseCsv", () => {
  it("따옴표 안의 쉼표·겹따옴표·줄바꿈을 칸으로 지킨다", () => {
    expect(parseCsv('a,"b, c","d ""e""",\n1,2,3,4')).toEqual([
      ["a", "b, c", 'd "e"', ""],
      ["1", "2", "3", "4"],
    ]);
  });

  it("CRLF 와 마지막 줄바꿈 유무에 흔들리지 않는다", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseIndexCsv", () => {
  const HEADER = "번호,게시판,날짜,제목,글자수,이미지수,결손이미지,태그,원문URL,MD파일";

  it("BOM 을 걷어 내고 헤더 이름으로 칸을 찾아 글 번호를 URL 에서 뽑는다", () => {
    const csv = `﻿${HEADER}\n1,트레이딩,2006-06-17,"[공유] [알바트로스- 성필규, Theta Power 대표이사]",100,0,0,,https://blog.naver.com/pillion21/120025612268,아카이브/x.md\n`;
    expect(parseIndexCsv(csv)).toEqual([
      {
        id: "120025612268",
        date: "2006-06-17",
        board: "트레이딩",
        title: "[공유] [알바트로스- 성필규, Theta Power 대표이사]",
        url: "https://blog.naver.com/pillion21/120025612268",
      },
    ]);
  });

  it("URL 끝이 숫자가 아닌 행은 버린다", () => {
    const csv = `${HEADER}\n1,a,2020-01-01,t,0,0,0,,https://blog.naver.com/pillion21/,x\n`;
    expect(parseIndexCsv(csv)).toEqual([]);
  });

  it("필수 열이 없으면 조용히 빈 목록이 아니라 오류다", () => {
    expect(() => parseIndexCsv("번호,게시판,날짜,제목\n1,a,b,c\n")).toThrow("원문URL");
  });
});
