/**
 * M5 — 매매 진단. 전 이력을 "발견(Finding)" 레코드로 줄인다.
 *
 * `manual-review.json`(로컬 45MB, gitignore)을 읽어 커밋 가능한 집계본
 * `docs/diagnosis/okx-diagnosis.json` 을 만든다. `kelly.mjs`(M4)와 같은 규칙이다 —
 * 원본은 이 PC 에만 있고 집계본만 저장소에 들어가므로 배포된 앱에서도 열린다.
 *
 * **답을 담지 않는다.** 리프트·표준오차·t·신뢰등급·심각도·승률은 전부 앱
 * (`src/lib/okx-diagnosis.ts`)이 계산한다. 여기서 내보내는 것은 그 계산에 필요한
 * 충분통계량뿐이다. 문턱을 고치면 앱 한 곳만 바꾸면 되고, 과거 회차까지 같은 기준으로
 * 다시 매겨진다 — 집계본에 등급을 박아 두면 회차마다 기준이 달라진다.
 *
 * 이 스크립트가 지키는 세 가지 규율:
 *
 * 1. **원시 합계로 줄 세우지 않는다.** 손실 총액이 큰 칸은 대개 거래가 많았을 뿐이다.
 *    모든 발견은 같은 코호트의 기준선과 견줄 수 있도록 `sumNet` 과 `n` 을 함께 낸다.
 * 2. **결과로 정의된 라벨을 발견으로 세지 않는다.** `manual-analyze.mjs` 의 `failure`
 *    분류는 전부 패배 거래에만 붙는다 — 승률 0% 는 결과가 아니라 정의다. 그런 축에는
 *    `tautological` 을 달고, 같은 술어를 승패 무관하게 다시 잰 `twinId` 를 함께 낸다.
 * 3. **미래를 훔쳐보는 축을 쓰지 않는다.** `과잉거래일(하루 N건)` 태그는 그날이 몇 건으로
 *    끝나는지를 세 번째 거래 시점에 이미 아는 것처럼 군다. `nthOfDay` 로 대체한다.
 *
 * 실행: `node re_sys/diagnose.mjs [--round "이번 회차가 답할 질문"]`
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadData, ROOT } from "./lib/data.mjs";

const OUT = join(dirname(ROOT), "docs/diagnosis/okx-diagnosis.json");

/**
 * 표본을 시각으로 가르는 경계.
 *
 * 전 축이 같은 경계를 써야 축끼리, 회차끼리 비교된다. 축마다 중앙값으로 자르면
 * 축마다 다른 시점이 되어 "표본 밖에서도 유지된다"가 서로 다른 뜻이 된다.
 */
const SPLIT_BOUNDARY = "2025-01-01";

/** 회차를 보존하는 최대 개수. 그 이전은 git 이 들고 있다. */
const HISTORY_MAX = 12;

const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

/* ============ 충분통계량 ============ */

const netOf = (t) => t.pnlUsd;

/**
 * 한 묶음의 충분통계량 — 앱이 평균·표준편차·표준오차·t·승률·손익비를 되살릴 수 있는 최소집합.
 *
 * `sumSqDev` 는 2-pass 로 낸다. 한 번에 내는 식(Σx² − nμ²)은 손익처럼 값이 크고 부호가
 * 섞인 표본에서 자릿수가 상쇄돼 정밀도를 잃는다.
 */
function stats(list) {
  const n = list.length;
  if (n === 0) {
    return { n: 0, wins: 0, losses: 0, sumNet: 0, sumSqDev: 0, sumWin: 0, sumLoss: 0, sumFee: 0, sumFunding: 0, sumGross: 0 };
  }
  const sumNet = list.reduce((a, t) => a + netOf(t), 0);
  const mean = sumNet / n;

  return {
    n,
    wins: list.filter((t) => netOf(t) > 0).length,
    losses: list.filter((t) => netOf(t) < 0).length,
    sumNet: r2(sumNet),
    sumSqDev: r2(list.reduce((a, t) => a + (netOf(t) - mean) ** 2, 0)),
    sumWin: r2(list.filter((t) => netOf(t) > 0).reduce((a, t) => a + netOf(t), 0)),
    sumLoss: r2(list.filter((t) => netOf(t) < 0).reduce((a, t) => a + netOf(t), 0)),
    sumFee: r2(list.reduce((a, t) => a + (t.feeUsd ?? 0), 0)),
    sumFunding: r2(list.reduce((a, t) => a + (t.fundingUsd ?? 0), 0)),
    sumGross: r2(list.reduce((a, t) => a + (t.pnlGrossUsd ?? 0), 0)),
  };
}

/** 같은 묶음을 시각으로 갈라 표본 밖 검증의 입력을 만든다. */
function splitOf(list) {
  const inn = list.filter((t) => t.day < SPLIT_BOUNDARY);
  const out = list.filter((t) => t.day >= SPLIT_BOUNDARY);
  const a = stats(inn);
  const b = stats(out);
  return {
    boundary: SPLIT_BOUNDARY,
    inN: a.n, inSumNet: a.sumNet, inSumSqDev: a.sumSqDev,
    outN: b.n, outSumNet: b.sumNet, outSumSqDev: b.sumSqDev,
  };
}

/* ============ 코호트 ============ */

/**
 * 모집단을 셋으로 나눈다 — 기준선이 하나면 마진 축이 통째로 틀린다.
 *
 * 아카이브 1,071건은 `lever` 가 비어 있어 `manual-analyze` 가 `lever ?? 1` 로 계산한다.
 * 그 결과 마진 대비 지표가 가격 대비 값과 같아지고, 그 거래들의 평균 손익(−6.37)이
 * 나머지(−12.19)보다 5.8 높다. 마진 축을 전역 기준선(−10.64)에서 빼면 전 축에
 * 가짜 리프트 +1.55 가 실린다.
 */
const COHORTS = [
  {
    key: "all",
    label: "전체",
    filter: "pnlUsd 가 숫자인 청산 거래 전부",
    test: () => true,
  },
  {
    key: "lever",
    label: "레버 확인",
    filter: "lever 가 기록된 거래 — 레버 축 전용",
    test: (t) => t.lever !== null && t.lever !== undefined,
  },
  {
    key: "margin",
    label: "마진 지표 가능",
    filter: "lever 와 가격 경로(MFE/MAE)가 모두 있는 거래",
    test: (t) => t.lever !== null && t.lever !== undefined && t.path !== null && t.path !== undefined,
  },
];

/* ============ 데이터 결함 ============ */

const DEFECTS = {
  leverNull: {
    key: "leverNull",
    label: "아카이브 거래에 레버리지가 없다",
    effect:
      "1,071건(전체의 27%)은 OKX 분기 원장에서 복원한 거래라 lever 가 비어 있다. " +
      "manual-analyze 가 lever ?? 1 로 계산해 증거금 대비 지표가 가격 대비 값과 같아진다 — " +
      "마진 기반 축은 이 거래들을 뺀 모집단에서만 잰다.",
  },
  inferredIntent: {
    key: "inferredIntent",
    label: "진입 의도는 기록이 아니라 역추정이다",
    effect:
      "원장의 근거·기준 칸이 전 건 비어 있어, 진입 시점 차트 상태(SMA·RSI·연속봉)로 의도를 " +
      "역추정했다. 다른 축보다 약하게 읽어야 한다.",
  },
  noStopPrice: {
    key: "noStopPrice",
    label: "손절가가 기록된 거래가 없다",
    effect:
      "stopPx 가 4,023건 전부 null 이라 '손절 부재' 는 실제로 " +
      "'증거금 대비 50% 이상 역행했고 강제청산은 아님' 을 뜻한다.",
  },
};

/* ============ 축 정의 ============ */

const band = (v, edges, labels) => {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  for (let i = 0; i < edges.length; i += 1) if (v < edges[i]) return labels[i];
  return labels[edges.length];
};

/**
 * 축 목록. `actionability` 가 이 문서의 중심이다.
 *
 * - `entry`   진입 전에 알 수 있고 고를 수 있다 — 규칙으로 바로 옮겨진다
 * - `exit`    들고 있는 동안 고칠 수 있다 — 청산 규율로 옮겨진다
 * - `outcome` 정의에 결과가 들어 있다 — 규칙으로 옮길 수 없다
 * - `context` 고를 수 없는 배경 — 표류 점검용
 */
const AXES = [
  /* ---- 진입 시점에 통제 가능 ---- */
  {
    key: "lever", label: "레버리지", cohort: "lever", actionability: "entry",
    basis: "진입 배율", order: ["10배 이하", "20배", "50배", "100배"],
    of: (t) => band(t.lever, [11, 21, 51], ["10배 이하", "20배", "50배", "100배"]),
  },
  {
    key: "symbol", label: "종목", cohort: "all", actionability: "entry",
    basis: "instId", of: (t) => t.instId?.replace(/-USDT-SWAP$/, "") ?? null,
  },
  {
    key: "session", label: "세션", cohort: "all", actionability: "entry",
    basis: "한국시각 기준 시간대", of: (t) => t.session ?? null,
  },
  {
    key: "hour", label: "진입 시각", cohort: "all", actionability: "entry",
    basis: "한국시각 정시", order: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}시`),
    of: (t) => (t.hourKst === null || t.hourKst === undefined ? null : `${String(t.hourKst).padStart(2, "0")}시`),
  },
  {
    key: "weekday", label: "요일", cohort: "all", actionability: "entry",
    basis: "한국시각 기준", order: ["월", "화", "수", "목", "금", "토", "일"],
    of: (t) => ["일", "월", "화", "수", "목", "금", "토"][t.weekdayKst] ?? null,
  },
  {
    key: "side", label: "방향", cohort: "all", actionability: "entry",
    basis: "롱/숏", order: ["롱", "숏"],
    of: (t) => (t.side === "long" ? "롱" : t.side === "short" ? "숏" : null),
  },
  {
    key: "intentGroup", label: "진입 의도 (묶음)", cohort: "all", actionability: "entry",
    basis: "진입 시점 차트 상태로 역추정", defects: ["inferredIntent"],
    of: (t) => t.intentGroup ?? null,
  },
  {
    key: "intent", label: "진입 의도 (상세)", cohort: "all", actionability: "entry",
    basis: "같은 역추정을 더 잘게", defects: ["inferredIntent"],
    of: (t) => t.intent ?? null,
  },
  {
    key: "trendAlign", label: "추세 정렬", cohort: "all", actionability: "entry",
    basis: "진입 방향이 그때 추세와 같았는가", of: (t) => t.trendAlign ?? null,
  },
  {
    key: "regime", label: "시장 국면", cohort: "all", actionability: "entry",
    basis: "일봉이 SMA200 위인가", of: (t) => t.regime ?? null,
  },
  {
    key: "rsi", label: "진입 시점 RSI", cohort: "all", actionability: "entry",
    basis: "진입 직전 확정봉", order: ["30 미만", "30–50", "50–70", "70 이상"],
    of: (t) => band(t.context?.rsi, [30, 50, 70], ["30 미만", "30–50", "50–70", "70 이상"]),
  },
  {
    key: "atrPct", label: "진입 시점 변동성", cohort: "all", actionability: "entry",
    basis: "ATR ÷ 종가", order: ["저변동 0.4% 미만", "중변동 0.4–0.8%", "고변동 0.8% 이상"],
    of: (t) => band(t.context?.atrPct, [0.4, 0.8], ["저변동 0.4% 미만", "중변동 0.4–0.8%", "고변동 0.8% 이상"]),
  },
  {
    key: "consecLoss", label: "직전 연패 수", cohort: "all", actionability: "entry",
    basis: "이 거래 전에 연달아 진 횟수 — 진입 전에 안다", order: ["0", "1", "2", "3", "4 이상"],
    of: (t) => band(t.consecLossBefore ?? 0, [1, 2, 3, 4], ["0", "1", "2", "3", "4 이상"]),
  },
  {
    key: "nthOfDay", label: "그날 몇 번째", cohort: "all", actionability: "entry",
    basis: "그날의 진입 순번 — 과잉거래 태그와 달리 미래를 보지 않는다",
    order: ["1–2번째", "3–5번째", "6–9번째", "10번째 이상"],
    of: (t) => band(t.nthOfDay, [3, 6, 10], ["1–2번째", "3–5번째", "6–9번째", "10번째 이상"]),
  },
  {
    key: "sincePrev", label: "직전 청산과의 간격", cohort: "all", actionability: "entry",
    basis: "재진입까지 걸린 시간", order: ["첫 거래", "10분 이하", "10–30분", "30분–2시간", "2시간 이상"],
    of: (t) => (t.sinceprevMin === null || t.sinceprevMin === undefined
      ? "첫 거래"
      : band(t.sinceprevMin, [10.0001, 30, 120], ["10분 이하", "10–30분", "30분–2시간", "2시간 이상"])),
  },
  {
    key: "account", label: "계정", cohort: "all", actionability: "entry",
    basis: "주 매매계정 / 봇 서브계정",
    of: (t) => (t.account === "live" ? "봇 서브계정" : "주 매매계정"),
  },

  /* ---- 청산 규율로 통제 가능 ---- */
  {
    key: "hold", label: "보유시간", cohort: "all", actionability: "exit", pathDependent: true,
    basis: "진입부터 청산까지",
    order: ["5분 미만", "5–30분", "30분–2시간", "2–12시간", "12시간 이상"],
    of: (t) => band(t.holdMin, [5, 30, 120, 720], ["5분 미만", "5–30분", "30분–2시간", "2–12시간", "12시간 이상"]),
  },
  {
    key: "mfeMargin", label: "보유 중 최대 평가익", cohort: "margin", actionability: "exit", pathDependent: true,
    basis: "증거금 대비 최대 이익폭", defects: ["leverNull"],
    order: ["10% 미만", "10–20%", "20–30%", "30–50%", "50–100%", "100% 이상"],
    of: (t) => band(t.path?.mfeMarginPct, [10, 20, 30, 50, 100],
      ["10% 미만", "10–20%", "20–30%", "30–50%", "50–100%", "100% 이상"]),
  },
  {
    key: "maeMargin", label: "보유 중 최대 역행", cohort: "margin", actionability: "exit", pathDependent: true,
    basis: "증거금 대비 최대 손실폭", defects: ["leverNull"],
    order: ["10% 미만", "10–30%", "30–50%", "50% 이상"],
    of: (t) => band(t.path?.maeMarginPct, [10, 30, 50], ["10% 미만", "10–30%", "30–50%", "50% 이상"]),
  },
  /*
   * 정직한 쌍둥이 — 손실 조건을 뗀 같은 술어.
   *
   * `failure` 축의 라벨은 패배 거래에만 붙는다. 같은 술어를 승패 무관하게 재적용하면
   * `이익 반납`은 리프트 +38, `손절 부재`는 +21 로 부호가 뒤집힌다. 두 값을 나란히
   * 두는 것이 이 진단이 답할 수 있는 가장 값진 것이라, 쌍둥이를 축으로 명시한다.
   */
  {
    key: "twinGaveback", label: "평가익 30% 도달 여부", cohort: "margin", actionability: "exit", pathDependent: true,
    basis: "mfeMarginPct >= 30 (승패 무관)", defects: ["leverNull"], order: ["도달", "미도달"],
    of: (t) => (t.path?.mfeMarginPct >= 30 ? "도달" : "미도달"),
  },
  {
    key: "twinNostop", label: "역행 50% 감내 여부", cohort: "margin", actionability: "exit", pathDependent: true,
    basis: "maeMarginPct >= 50 && !liq (승패 무관)", defects: ["leverNull", "noStopPrice"],
    order: ["감내", "아님"],
    of: (t) => (t.path?.maeMarginPct >= 50 && !t.liq ? "감내" : "아님"),
  },

  /* ---- 정의에 결과가 들어 있다 ---- */
  {
    key: "failure", label: "실패 분류", cohort: "all", actionability: "outcome",
    basis: "manual-analyze 의 classifyFailure — 패배 거래에만 붙는다",
    tautological: true,
    tautologyReason: "패배한 거래에만 붙는 라벨입니다. 승률 0%는 결과가 아니라 정의입니다.",
    twins: { gaveback: "twinGaveback/도달", nostop: "twinNostop/감내", counter: "intentGroup/역추세", chase: "intentGroup/추격" },
    multi: (t) => (t.failure ?? []).map((f) => f.label),
  },
  {
    key: "liq", label: "강제청산", cohort: "all", actionability: "outcome",
    basis: "t.liq", tautological: true,
    tautologyReason: "강제청산은 증거금 전손이므로 손실이 정의에 들어 있습니다.",
    order: ["강제청산", "정상청산"],
    of: (t) => (t.liq ? "강제청산" : "정상청산"),
  },

  /* ---- 고를 수 없는 배경 ---- */
  {
    key: "year", label: "연도", cohort: "all", actionability: "context",
    basis: "표류 점검", of: (t) => t.day?.slice(0, 4) ?? null,
  },
];

/* ============ 조건부 발견 (사각지대) ============ */

/**
 * 리프트로는 잡히지 않는 것들.
 *
 * 평가익 20% 이상 도달한 거래의 리프트는 **양수**다(잘 간 거래니까). 문제는 그 안에서
 * 51%가 손실로 닫힌다는 것이고, 그건 조건부 비율이지 리프트가 아니다. 축 순위에 넣으면
 * 영영 안 보이므로 따로 만든다.
 */
const CONDITIONALS = [
  {
    id: "exit/giveback20",
    label: "평가익 20%를 넘긴 뒤 손실로 닫은 거래",
    cohort: "margin",
    given: "mfeMarginPct >= 20",
    then: "pnlUsd < 0",
    defects: ["leverNull"],
    evidence: "이 몫은 진입 기준을 고쳐도 그대로 남습니다 — 방향은 이미 맞았던 거래입니다.",
    givenTest: (t) => t.path?.mfeMarginPct >= 20,
    thenTest: (t) => netOf(t) < 0,
  },
  {
    id: "exit/giveback30",
    label: "평가익 30%를 넘긴 뒤 손실로 닫은 거래",
    cohort: "margin",
    given: "mfeMarginPct >= 30",
    then: "pnlUsd < 0",
    defects: ["leverNull"],
    evidence: "문턱을 올려도 비율이 크게 떨어지지 않으면, 특정 구간이 아니라 청산 규율 자체의 문제입니다.",
    givenTest: (t) => t.path?.mfeMarginPct >= 30,
    thenTest: (t) => netOf(t) < 0,
  },
  {
    id: "entry/neverMfe10",
    label: "평가익 10%조차 못 가고 진 거래",
    cohort: "margin",
    given: "mfeMarginPct < 10",
    then: "pnlUsd < 0",
    defects: ["leverNull"],
    evidence: "여기가 진입 오판의 크기입니다 — 청산 규율로는 줄일 수 없는 몫입니다.",
    givenTest: (t) => t.path?.mfeMarginPct < 10,
    thenTest: (t) => netOf(t) < 0,
  },
  {
    id: "exit/liqAfterProfit",
    label: "평가익 20%를 넘겼는데 강제청산된 거래",
    cohort: "margin",
    given: "mfeMarginPct >= 20",
    then: "liq",
    defects: ["leverNull"],
    evidence: "이익 구간을 지나고도 청산까지 간 경우 — 규율 부재가 가장 극단으로 드러난 자리입니다.",
    givenTest: (t) => t.path?.mfeMarginPct >= 20,
    thenTest: (t) => Boolean(t.liq),
  },
];

/* ============ 실행 ============ */

const review = loadData("manual-review.json");
if (!review) {
  console.error("manual-review.json 이 없습니다 — node re_sys/manual-analyze.mjs 를 먼저 돌리세요.");
  process.exit(1);
}

const trades = review.trades.filter((t) => typeof t.pnlUsd === "number");
const days = [...new Set(trades.map((t) => t.day).filter(Boolean))].sort();
const question = (() => {
  const i = process.argv.indexOf("--round");
  return i >= 0 ? process.argv[i + 1] ?? null : null;
})();

/** 회차를 가르는 지문 — 거래 수와 마지막 청산 시각. 같으면 같은 데이터다. */
const fingerprint = `${trades.length}:${Math.max(...trades.map((t) => t.exitTs ?? t.entryTs ?? 0))}`;

const cohorts = COHORTS.map((c) => {
  const list = trades.filter(c.test);
  return {
    key: c.key,
    label: c.label,
    filter: c.filter,
    baseline: { ...stats(list), ...splitOf(list) },
    _list: list,
  };
});
const cohortOf = (key) => cohorts.find((c) => c.key === key);

const findings = [];
const coverage = [];

for (const axis of AXES) {
  const list = cohortOf(axis.cohort)._list;
  const map = new Map();

  for (const t of list) {
    const keys = axis.multi ? axis.multi(t) : [axis.of(t)];
    for (const k of keys) {
      if (k === null || k === undefined) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    }
  }

  // 이 축이 판정할 수 있었던 거래 수 — 지표 워밍업·국면 미판정으로 빠지는 칸이 있다.
  // 화면이 "4,023건 중 3,587건만 판정 가능"을 말할 수 있어야 축마다 모수가 다른 이유가 설명된다.
  const covered = axis.multi
    ? list.filter((t) => (axis.multi(t) ?? []).length > 0).length
    : list.filter((t) => axis.of(t) !== null && axis.of(t) !== undefined).length;
  coverage.push({ axis: axis.key, cohort: axis.cohort, covered, total: list.length });

  for (const [bucket, rows] of map) {
    // 30건 미만도 버리지 않는다 — 사용자가 가설까지 원했고, 등급으로 구분한다.
    const order = axis.order ? axis.order.indexOf(bucket) : -1;

    findings.push({
      id: `${axis.key}/${bucket}`,
      kind: "axis",
      axis: axis.key,
      axisLabel: axis.label,
      bucket,
      bucketOrder: order >= 0 ? order : null,
      cohort: axis.cohort,
      actionability: axis.actionability,
      basis: axis.basis,
      ...stats(rows),
      split: splitOf(rows),
      conditional: null,
      tautological: Boolean(axis.tautological),
      tautologyReason: axis.tautologyReason ?? null,
      pathDependent: Boolean(axis.pathDependent),
      twinId: null,
      defects: axis.defects ?? [],
      evidence: null,
    });
  }
}

// 실패 분류의 쌍둥이 연결 — 라벨로 들어온 버킷을 키로 되짚는다.
const FAILURE_TWIN_BY_LABEL = {
  "이익 반납(청산 실패)": "twinGaveback/도달",
  "손절 부재 — 손실 방치": "twinNostop/감내",
  "역추세 진입 → 추세 지속": "intentGroup/역추세",
  "돌파 추격 → 되돌림": "intentGroup/추격",
  "강제청산(레버리지 과다)": "liq/강제청산",
};
for (const f of findings) {
  if (f.axis === "failure") f.twinId = FAILURE_TWIN_BY_LABEL[f.bucket] ?? null;
}

for (const c of CONDITIONALS) {
  const list = cohortOf(c.cohort)._list;
  const given = list.filter(c.givenTest);
  const then = given.filter(c.thenTest);

  findings.push({
    id: c.id,
    kind: "conditional",
    axis: c.id.split("/")[0],
    axisLabel: c.label,
    bucket: c.given,
    bucketOrder: null,
    cohort: c.cohort,
    actionability: c.id.startsWith("exit") ? "exit" : "entry",
    basis: `${c.given} → ${c.then}`,
    ...stats(given),
    split: splitOf(given),
    conditional: {
      given: c.given,
      then: c.then,
      givenN: given.length,
      thenN: then.length,
      thenSumNet: r2(then.reduce((a, t) => a + netOf(t), 0)),
    },
    tautological: false,
    tautologyReason: null,
    pathDependent: true,
    twinId: null,
    defects: c.defects ?? [],
    evidence: c.evidence,
  });
}

/* ---- 회차 병합 ---- */

let prev = null;
try {
  prev = JSON.parse(readFileSync(OUT, "utf8"));
} catch {
  prev = null;
}

const sameData = prev?.round?.sourceFingerprint === fingerprint;
const roundNo = prev ? (sameData ? prev.round.no : prev.round.no + 1) : 1;

// 같은 데이터를 다시 돌린 것이면 회차를 늘리지 않는다 — 코드만 고쳤을 때 이력이 부풀지 않게.
const history = (() => {
  if (!prev || sameData) return prev?.history ?? [];
  const ids = prev.findingIds ?? prev.findings.map((f) => f.id);
  const rows = prev.findings.map((f) => [ids.indexOf(f.id), f.n, f.sumNet]);
  const baselines = Object.fromEntries(
    (prev.cohorts ?? []).map((c) => [c.key, [c.baseline.n, c.baseline.sumNet]]),
  );
  return [
    ...(prev.history ?? []),
    { no: prev.round.no, generatedAt: prev.round.generatedAt, sourceFingerprint: prev.round.sourceFingerprint, tradeCount: prev.round.tradeCount, ids, baselines, rows },
  ].slice(-HISTORY_MAX);
})();

const firstSeen = new Map();
for (const h of history) for (const id of h.ids ?? []) if (!firstSeen.has(id)) firstSeen.set(id, h.no);
if (prev && sameData) for (const f of prev.findings ?? []) firstSeen.set(f.id, f.firstSeenRound ?? roundNo);
for (const f of findings) f.firstSeenRound = firstSeen.get(f.id) ?? roundNo;

const output = {
  note: "매매 진단 — re_sys/diagnose.mjs 가 만든다. 손으로 고치지 않는다. 리프트·t·등급은 여기 없고 앱이 계산한다.",
  round: {
    no: roundNo,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    tradeCount: trades.length,
    period: { from: days[0] ?? null, to: days.at(-1) ?? null, tradingDays: days.length },
    question: question ?? prev?.round?.question ?? null,
    splitBoundary: SPLIT_BOUNDARY,
    testCount: findings.length,
  },
  source: {
    file: "re_sys/data/manual-review.json",
    analyzedAt: review.generatedAt ? new Date(review.generatedAt).toISOString() : null,
    origins: [...new Set(trades.map((t) => t.sourceName))].sort(),
    symbols: new Set(trades.map((t) => t.instId)).size,
  },
  defects: Object.values(DEFECTS),
  cohorts: cohorts.map(({ _list, ...c }) => c),
  coverage,
  findingIds: findings.map((f) => f.id),
  findings,
  history,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(output, null, 1)}\n`, "utf8");

const bytes = JSON.stringify(output).length;
console.log(`회차 ${roundNo}${sameData ? " (같은 데이터 — 회차 유지)" : ""} · 거래 ${trades.length}건 (${output.round.period.from} ~ ${output.round.period.to})`);
console.log(`축 ${AXES.length}개 + 조건부 ${CONDITIONALS.length}개 → 발견 ${findings.length}건 · 이력 ${history.length}회차 · ${Math.round(bytes / 1024)}KB`);
console.log(`→ docs/diagnosis/okx-diagnosis.json`);
