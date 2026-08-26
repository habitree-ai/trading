import { describe, expect, it } from 'vitest';

import {
  byRank,
  enrichFinding,
  findingById,
  loadDiagnosis,
  rankScore,
} from '@/lib/okx-diagnosis';

/** 손으로 검산할 수 있는 최소 발견. */
function raw(over: Record<string, unknown> = {}) {
  return {
    id: 'test/bucket',
    kind: 'axis' as const,
    axis: 'test',
    axisLabel: '테스트',
    bucket: 'bucket',
    bucketOrder: null,
    cohort: 'all',
    actionability: 'entry' as const,
    basis: '테스트',
    n: 100,
    wins: 40,
    losses: 55,
    sumNet: 500,
    sumSqDev: 9900, // sd = sqrt(9900/99) = 10
    sumWin: 2000,
    sumLoss: -1500,
    sumFee: -300,
    sumFunding: 10,
    sumGross: 790,
    split: {
      boundary: '2025-01-01',
      inN: 50, inSumNet: 250, inSumSqDev: 4900,
      outN: 50, outSumNet: 250, outSumSqDev: 4900,
    },
    conditional: null,
    tautological: false,
    tautologyReason: null,
    pathDependent: false,
    twinId: null,
    defects: [],
    evidence: null,
    firstSeenRound: 1,
    ...over,
  };
}

function cohort(over: Record<string, unknown> = {}) {
  return {
    key: 'all',
    label: '전체',
    filter: '전부',
    baseline: {
      n: 1000, wins: 300, losses: 650,
      sumNet: 0, sumSqDev: 0, sumWin: 0, sumLoss: 0, sumFee: 0, sumFunding: 0, sumGross: 0,
      boundary: '2025-01-01',
      inN: 500, inSumNet: 0, inSumSqDev: 0,
      outN: 500, outSumNet: 0, outSumSqDev: 0,
      ...over,
    },
  };
}

describe('enrichFinding — 집계본에서 답을 되살린다', () => {
  it('리프트는 이 칸의 거래당 손익에서 코호트 기준선을 뺀 값이다', () => {
    // 이 칸 500/100 = 5, 기준선 −1000/1000 = −1 → 리프트 6
    const f = enrichFinding(raw(), cohort({ sumNet: -1000 }));

    expect(f.mean).toBeCloseTo(5, 10);
    expect(f.lift).toBeCloseTo(6, 10);
    expect(f.attributable).toBeCloseTo(600, 10);
  });

  it('표준편차·표준오차·t 를 충분통계량에서 낸다', () => {
    // sumSqDev 9900, n 100 → sd 10, se 1, 리프트 6 → t 6
    const f = enrichFinding(raw(), cohort({ sumNet: -1000 }));

    expect(f.sd).toBeCloseTo(10, 10);
    expect(f.se).toBeCloseTo(1, 10);
    expect(f.t).toBeCloseTo(6, 10);
  });

  it('앞뒤 절반은 각 절반의 기준선과 견준다 — 통합 기준선으로 재면 없던 안정성이 생긴다', () => {
    // 앞 기준선 −2, 뒤 기준선 +2. 이 칸은 앞뒤 모두 거래당 5.
    const f = enrichFinding(
      raw(),
      cohort({ sumNet: 0, inSumNet: -1000, outSumNet: 1000 }),
    );

    expect(f.inLift).toBeCloseTo(7, 10); // 5 − (−2)
    expect(f.outLift).toBeCloseTo(3, 10); // 5 − 2
    expect(f.held).toBe(true);
  });

  it('한쪽 표본이 30건 미만이면 기간 검증을 하지 않는다', () => {
    const f = enrichFinding(
      raw({ split: { boundary: '2025-01-01', inN: 10, inSumNet: 50, inSumSqDev: 900, outN: 90, outSumNet: 450, outSumSqDev: 8100 } }),
      cohort({ sumNet: -1000 }),
    );

    expect(f.held).toBeNull();
  });

  it('표본이 1건이면 산포를 잴 수 없어 t 가 없다 — 0으로 두면 t 가 무한대로 튄다', () => {
    const f = enrichFinding(raw({ n: 1, wins: 1, losses: 0, sumNet: 50, sumSqDev: 0 }), cohort());

    expect(f.sd).toBeNull();
    expect(f.t).toBeNull();
  });

  it('승률은 본전을 분모에서 뺀다', () => {
    // n 100 인데 승 40 · 패 55 → 나머지 5건은 본전
    const f = enrichFinding(raw(), cohort());

    expect(f.winRate).toBeCloseTo(40 / 95, 10);
  });

  it('조건부 발견은 비율을 낸다', () => {
    const f = enrichFinding(
      raw({ conditional: { given: 'x', then: 'y', givenN: 200, thenN: 50, thenSumNet: -1000 } }),
      cohort(),
    );

    expect(f.conditionalRate).toBeCloseTo(0.25, 10);
  });
});

describe('rankScore — 금액만으로 세우면 거래가 많은 칸이 늘 위로 온다', () => {
  it('등급이 낮으면 같은 금액이라도 뒤로 밀린다', () => {
    const confirmed = enrichFinding(raw(), cohort({ sumNet: -1000 }));
    const thin = enrichFinding(
      // 같은 귀속금액이지만 표본이 얇아 가설
      raw({ n: 20, sumNet: 220, sumSqDev: 1900, split: { boundary: '2025-01-01', inN: 10, inSumNet: 110, inSumSqDev: 900, outN: 10, outSumNet: 110, outSumSqDev: 900 } }),
      cohort({ sumNet: -1000 }),
    );

    expect(confirmed.confidence).toBe('confirmed');
    expect(thin.confidence).toBe('hypothesis');
    expect(rankScore(confirmed)).toBeGreaterThan(rankScore(thin));
  });

  it('가설이라도 금액이 크면 완전히 밀려나지는 않는다', () => {
    const big = enrichFinding(
      raw({ n: 20, sumNet: 20000, sumSqDev: 1900, split: { boundary: '2025-01-01', inN: 10, inSumNet: 10000, inSumSqDev: 900, outN: 10, outSumNet: 10000, outSumSqDev: 900 } }),
      cohort({ sumNet: -1000 }),
    );
    const small = enrichFinding(raw(), cohort({ sumNet: -1000 }));

    expect(big.confidence).toBe('hypothesis');
    expect([big, small].sort(byRank)[0].id).toBe(big.id);
  });
});

describe('loadDiagnosis — 커밋된 집계본', () => {
  const report = loadDiagnosis();

  it('회차와 검정 수를 싣는다 — 다중비교를 화면이 말할 수 있어야 한다', () => {
    expect(report.round.no).toBeGreaterThanOrEqual(1);
    expect(report.round.testCount).toBe(report.findings.length);
  });

  it('축별 거래 수 합계가 그 축의 커버리지와 일치한다', () => {
    for (const cov of report.coverage) {
      const axis = report.findings.filter((f) => f.axis === cov.axis && f.kind === 'axis');
      // 실패 분류는 한 거래에 여러 라벨이 붙어 합계가 커버리지를 넘는다.
      if (cov.axis === 'failure') {
        expect(axis.reduce((a, f) => a + f.n, 0)).toBeGreaterThanOrEqual(cov.covered);
        continue;
      }
      expect(axis.reduce((a, f) => a + f.n, 0), `${cov.axis} 합계`).toBe(cov.covered);
    }
  });

  it('마진 축은 마진 코호트 기준선에서 뺀다 — 전역 기준선으로 재면 가짜 리프트가 실린다', () => {
    const marginFindings = report.findings.filter((f) => f.cohort === 'margin');
    const marginCohort = report.cohorts.find((c) => c.key === 'margin')!;
    const globalCohort = report.cohorts.find((c) => c.key === 'all')!;

    expect(marginFindings.length).toBeGreaterThan(0);
    // 두 기준선이 실제로 다르다 — 다르지 않다면 이 구분이 무의미하다
    expect(marginCohort.baseline.sumNet / marginCohort.baseline.n).not.toBeCloseTo(
      globalCohort.baseline.sumNet / globalCohort.baseline.n,
      1,
    );
  });

  it('실패 분류는 전부 동어반복으로 표시되고 확정 등급을 받지 못한다', () => {
    const failures = report.findings.filter((f) => f.axis === 'failure');

    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) {
      expect(f.tautological, f.bucket).toBe(true);
      expect(f.confidence, f.bucket).not.toBe('confirmed');
    }
  });

  it('이익 반납의 정직한 쌍둥이는 부호가 반대다 — 이 진단의 핵심 사각지대', () => {
    const gaveback = report.findings.find((f) => f.bucket === '이익 반납(청산 실패)')!;
    const twin = findingById(report, gaveback.twinId)!;

    expect(twin).not.toBeNull();
    // 손실 전용 라벨은 음수, 승패 무관 술어는 양수
    expect(twin.lift).toBeGreaterThan(0);
  });

  it('경로 의존 축은 순위에서 뺄 수 있게 표시된다', () => {
    const hold = report.findings.find((f) => f.axis === 'hold')!;
    const lever = report.findings.find((f) => f.axis === 'lever')!;

    expect(hold.pathDependent).toBe(true);
    expect(lever.pathDependent).toBe(false);
  });
});
