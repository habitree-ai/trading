import { describe, expect, it } from "vitest";

import { date, dateTime, fromLocalInput, keepIfSameMinute, price, priceDecimals, toLocalInput } from "@/lib/format";

describe("시각 포맷 — 서버/브라우저가 같은 문자열을 만들어야 한다", () => {
  it("표시 타임존(KST) 기준으로 찍는다", () => {
    // 2026-07-25 11:15Z == 2026-07-25 20:15 KST
    expect(dateTime("2026-07-25T11:15:00Z")).toBe("26.07.25 20:15");
    expect(date("2026-07-25T11:15:00Z")).toBe("26.07.25");
  });

  it("로케일 단어(오후/PM)를 쓰지 않는다 — 하이드레이션 불일치의 원인", () => {
    expect(dateTime("2026-07-25T11:15:00Z")).not.toMatch(/오전|오후|AM|PM/);
  });

  it("자정을 24시가 아닌 00시로 쓴다", () => {
    // 2026-07-24 15:00Z == 2026-07-25 00:00 KST
    expect(dateTime("2026-07-24T15:00:00Z")).toBe("26.07.25 00:00");
  });

  it("null은 대시로 떨어진다", () => {
    expect(dateTime(null)).toBe("—");
    expect(date(null)).toBe("—");
  });
});

describe("fromLocalInput — datetime-local 입력을 KST 벽시계로 해석한다", () => {
  it("서버가 UTC로 돌아도 입력한 시각이 밀리지 않는다", () => {
    // 09:15로 입력했으면 09:15 KST여야 한다 (= 00:15Z)
    expect(fromLocalInput("2026-07-02T09:15")).toBe("2026-07-02T00:15:00.000Z");
  });

  it("자정 직후 입력이 전날로 밀리지 않는다", () => {
    expect(fromLocalInput("2026-07-02T00:30")).toBe("2026-07-01T15:30:00.000Z");
  });

  it("toLocalInput과 왕복해도 값이 보존된다", () => {
    const iso = "2026-07-25T11:15:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("빈 값이나 형식이 어긋나면 null", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("2026-07-02")).toBeNull();
    expect(fromLocalInput("nonsense")).toBeNull();
  });
});

describe("keepIfSameMinute — 시각을 안 바꾼 저장이 초를 잘라먹지 않게", () => {
  // 실사례(2026-09-01): 진입 18:17:58.121 KST 거래를 수정 저장하자 18:17:00으로 잘려,
  // 같은 분의 이체(18:17:48)보다 앞으로 가며 자금 곡선·MDD가 통째로 어긋났다.
  const stored = "2026-09-01T09:17:58.121+00:00"; // 18:17:58.121 KST

  it("재현 — 폼 왕복만으로 초가 잘린다 (이 유실을 걸러야 한다)", () => {
    expect(fromLocalInput(toLocalInput(stored))).toBe("2026-09-01T09:17:00.000Z");
  });

  it("같은 분이면 기존 시각을 지킨다 — 안 바꾼 것이다", () => {
    const submitted = fromLocalInput(toLocalInput(stored));
    expect(keepIfSameMinute(submitted, stored)).toBe(stored);
  });

  it("분이 다르면 제출값이 이긴다 — 실제로 바꾼 것이다", () => {
    const submitted = fromLocalInput("2026-09-01T18:20");
    expect(keepIfSameMinute(submitted, stored)).toBe(submitted);
  });

  it("어느 쪽이든 비어 있으면 제출값 그대로", () => {
    expect(keepIfSameMinute(null, stored)).toBeNull();
    expect(keepIfSameMinute("2026-09-01T09:17:00.000Z", null)).toBe("2026-09-01T09:17:00.000Z");
  });
});

describe("price — 크기에 맞춘 자릿수", () => {
  it("저가 코인은 5자리 — 진입가와 손절이 같아 보이지 않게", () => {
    expect(price(0.4096629)).toBe("0.40966");
    expect(price(0.4121)).toBe("0.41210");
  });

  it("1 이상 100 미만은 4자리, 100 이상은 2자리", () => {
    expect(price(2.5)).toBe("2.5000");
    expect(price(100_000)).toBe("100,000.00");
  });

  it("값이 없으면 —", () => {
    expect(price(null)).toBe("—");
  });

  it("차트 가격축 자릿수도 같은 기준 — 음수(가격 차)는 크기로 본다", () => {
    expect(priceDecimals(0.4097)).toBe(5);
    expect(priceDecimals(15.2)).toBe(4);
    expect(priceDecimals(100_000)).toBe(2);
    expect(priceDecimals(-250)).toBe(2);
  });
});
