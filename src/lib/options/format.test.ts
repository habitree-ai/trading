import { describe, expect, it } from "vitest";

import { usdCompact } from "@/lib/options/format";

describe("usdCompact — B/M/K 축약, 음수는 − 접두, null 은 —", () => {
  it("자릿수에 따라 단위를 고른다", () => {
    expect(usdCompact(36_440_000_000)).toBe("$36.44B");
    expect(usdCompact(359_000_000)).toBe("$359M");
    expect(usdCompact(12_400)).toBe("$12K");
    expect(usdCompact(950)).toBe("$950");
  });

  it("음수는 − 를 앞에 붙이고, null·NaN 은 — 다", () => {
    expect(usdCompact(-359_000_000)).toBe("−$359M");
    expect(usdCompact(null)).toBe("—");
    expect(usdCompact(Number.NaN)).toBe("—");
  });
});
