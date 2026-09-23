import { describe, expect, it } from "vitest";

import { joinTranscript, mergeSpoken, speechErrorMessage } from "@/lib/speech";

describe("mergeSpoken — 인식 조각 잇기", () => {
  it("빈 앞말에는 조각만 남는다", () => {
    expect(mergeSpoken("", "지지선 깨져서")).toBe("지지선 깨져서");
  });

  it("조각 사이는 공백 하나", () => {
    expect(mergeSpoken("지지선 깨져서", "숏 잡았다")).toBe("지지선 깨져서 숏 잡았다");
  });

  it("조각이 공백을 달고 와도 공백이 겹치지 않는다", () => {
    expect(mergeSpoken("지지선 깨져서 ", "  숏 잡았다 ")).toBe("지지선 깨져서 숏 잡았다");
  });

  it("빈 조각은 앞말을 바꾸지 않는다", () => {
    expect(mergeSpoken("지지선 깨져서", "")).toBe("지지선 깨져서");
    expect(mergeSpoken("지지선 깨져서", "   ")).toBe("지지선 깨져서");
  });
});

describe("joinTranscript — 적어 둔 글을 덮지 않는다", () => {
  it("빈 칸이면 말한 것만 들어간다", () => {
    expect(joinTranscript("", "숏 잡았다")).toBe("숏 잡았다");
  });

  it("적어 둔 글이 있으면 줄을 바꿔 뒤에 붙인다", () => {
    expect(joinTranscript("손으로 적던 근거", "숏 잡았다")).toBe("손으로 적던 근거\n숏 잡았다");
  });

  it("적어 둔 글 끝의 빈 줄 때문에 빈 줄이 늘지 않는다", () => {
    expect(joinTranscript("손으로 적던 근거\n\n  ", "숏 잡았다")).toBe(
      "손으로 적던 근거\n숏 잡았다",
    );
  });

  it("말한 것이 없으면 적어 둔 글을 그대로 돌려준다 — 공백도 건드리지 않는다", () => {
    expect(joinTranscript("손으로 적던 근거\n", "")).toBe("손으로 적던 근거\n");
    expect(joinTranscript("손으로 적던 근거", "   ")).toBe("손으로 적던 근거");
  });

  it("여러 줄로 적어 둔 글도 마지막 줄만 이어진다", () => {
    expect(joinTranscript("첫 줄\n둘째 줄", "셋째")).toBe("첫 줄\n둘째 줄\n셋째");
  });
});

describe("speechErrorMessage — 코드가 아니라 할 일을 보여준다", () => {
  it("권한 거부는 어디서 푸는지 알려준다", () => {
    expect(speechErrorMessage("not-allowed")).toContain("권한");
    expect(speechErrorMessage("service-not-allowed")).toContain("권한");
  });

  it("모르는 코드도 빈 문자열이 되지 않는다", () => {
    expect(speechErrorMessage("무언가-새-코드").length).toBeGreaterThan(0);
  });

  it("코드를 그대로 노출하지 않는다", () => {
    expect(speechErrorMessage("audio-capture")).not.toContain("audio-capture");
  });
});
