import { describe, expect, it } from "vitest";

import {
  byAttributable,
  judgeGroup,
  loadMistakes,
  seedDraft,
  welchT,
  type MistakeGroup,
} from "@/lib/mistakes";

const stats = (n: number, sumNet: number, sumSqDev: number) => ({
  n,
  wins: 0,
  sumNet,
  sumSqDev,
  sumFee: 0,
  sumFunding: 0,
});

describe("welchT", () => {
  it("평균이 같으면 0", () => {
    expect(welchT(stats(100, 100, 1000), stats(100, 100, 1000))).toBeCloseTo(0, 10);
  });

  it("표본이 1건 이하면 재지 않는다", () => {
    expect(welchT(stats(1, 5, 0), stats(100, 100, 1000))).toBeNull();
  });

  it("분산이 0이면 재지 않는다 — 나눗셈이 무한이 된다", () => {
    expect(welchT(stats(100, 100, 0), stats(100, 200, 0))).toBeNull();
  });

  it("같은 평균 차이라도 분산이 크면 t 가 작아진다", () => {
    const tight = welchT(stats(100, 0, 100), stats(100, 1000, 100));
    const loose = welchT(stats(100, 0, 100_000), stats(100, 1000, 100_000));
    expect(Math.abs(tight!)).toBeGreaterThan(Math.abs(loose!));
  });
});

describe("judgeGroup", () => {
  it("결과로 정의된 유형은 규칙이 되지 못한다", () => {
    const v = judgeGroup({ control: "outcome", n: 500 }, -9, -30);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("결과로 정의된");
  });

  it("표본이 30건에 못 미치면 차이를 재지 않는다", () => {
    expect(judgeGroup({ control: "entry", n: 12 }, -9, -30).tone).toBe("neutral");
  });

  it("t 가 2 미만이면 합계가 커도 '차이 없음'", () => {
    const v = judgeGroup({ control: "entry", n: 2000 }, -1.2, -4);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("차이 없음");
  });

  it("t 가 3 이상이고 더 잃었으면 오답 확인", () => {
    expect(judgeGroup({ control: "exit", n: 2000 }, -7.2, -31).tone).toBe("bad");
  });

  it("t 가 2~3 이면 조짐으로만 둔다 — 후보 10개를 열 번 재기 때문", () => {
    expect(judgeGroup({ control: "entry", n: 500 }, -2.4, -8).tone).toBe("warn");
  });

  it("더 번 쪽이면 오답이라 하지 않는다", () => {
    expect(judgeGroup({ control: "exit", n: 500 }, 3.4, 23).tone).toBe("good");
  });
});

describe("byAttributable", () => {
  it("귀속 손실이 큰 쪽이 앞에 온다", () => {
    const g = (attributable: number) => ({ attributable }) as MistakeGroup;
    const sorted = [g(-100), g(-9000), g(50)].sort(byAttributable);
    expect(sorted.map((x) => x.attributable)).toEqual([-9000, -100, 50]);
  });
});

describe("loadMistakes", () => {
  const report = loadMistakes();

  it("보유 시간 구간의 합이 표본 전체와 같다", () => {
    const sum = report.holdBuckets.reduce((a, b) => a + b.n, 0);
    expect(sum).toBe(report.round.tradeCount);
  });

  it("유형과 비교군을 더하면 표본 전체가 된다", () => {
    for (const g of report.groups) {
      if (!g.baseline) continue;
      expect(g.n + g.baseline.n).toBe(report.round.tradeCount);
    }
  });

  it("승률은 비율(0~1)로 나온다 — 화면의 pct() 가 그 형태를 받는다", () => {
    for (const g of report.groups) {
      if (g.winRate === null) continue;
      expect(g.winRate).toBeGreaterThanOrEqual(0);
      expect(g.winRate).toBeLessThanOrEqual(1);
    }
  });

  it("귀속은 건수 × 거래당 차이다", () => {
    for (const g of report.groups) {
      if (g.gap === null) continue;
      expect(g.attributable).toBeCloseTo(g.gap * g.n, 6);
    }
  });

  it("결과로 정의된 유형은 비교군도 없고 규칙으로도 못 옮긴다", () => {
    for (const g of report.groups.filter((x) => x.control === "outcome")) {
      expect(g.baseline).toBeNull();
      expect(g.canSeed).toBe(false);
    }
  });

  it("회차 1 — 빠른매매만 오답으로 확인된다", () => {
    // 이 단언은 회차 1의 결과다. 원장이 갱신돼 바뀌면 화면의 이야기도 바뀐 것이므로
    // 테스트를 고치기 전에 무엇이 달라졌는지 먼저 본다.
    const bad = report.groups.filter((g) => g.verdict.tone === "bad").map((g) => g.id);
    expect(bad).toEqual(["fast-exit"]);
  });
});

describe("seedDraft", () => {
  const report = loadMistakes();
  const fast = report.groups.find((g) => g.id === "fast-exit")!;
  const draft = seedDraft(fast, report.round.no, "2026-09-08T00:00:00.000Z");

  it("「하지 말 것」 묶음으로 들어간다", () => {
    expect(draft.category).toBe("taboo");
  });

  it("제목은 금지 문장이지 유형 이름이 아니다", () => {
    expect(draft.title).toBe(fast.taboo);
  });

  it("근거에 회차·판정 기준·수치가 남는다 — 나중에 어디서 왔는지 되짚을 자리", () => {
    expect(draft.detail).toContain("오답노트 회차 1");
    expect(draft.detail).toContain(fast.rule);
    expect(draft.detail).toContain("귀속");
  });
});
