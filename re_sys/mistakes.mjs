/**
 * M6 — 오답노트. 전 이력에서 "다음에 하지 말 것"의 후보를 유형으로 묶는다.
 *
 * `manual-review.json`(로컬, gitignore)을 읽어 커밋 가능한 집계본
 * `docs/mistakes/okx-mistakes.json` 을 만든다. `kelly.mjs`(M4)·`diagnose.mjs`(M5)와
 * 같은 규칙이다 — 원본은 이 PC 에만 있고 집계본만 저장소에 들어가므로 배포된 앱에서도 열린다.
 *
 * `/diagnosis` 와 무엇이 다른가: 진단은 "무엇이 통계적으로 확정됐나"에 답하느라 등급·리프트·
 * FDR 을 거친다. 여기는 그 앞단이다 — **이미 이름이 붙어 있는 오답 유형을 세어 보여 준다.**
 * 판정 기준은 전부 원장 필드 한 줄로 적히고, 그 줄이 곧 "하지 말 것"의 초안이 된다.
 *
 * 이 스크립트가 지키는 네 가지:
 *
 * 1. **답을 담지 않는다.** 승률·평균·비교군 대비 차이는 앱(`src/lib/mistakes.ts`)이 낸다.
 *    여기서 내보내는 것은 건수와 합계뿐이다.
 * 2. **미래를 훔쳐보는 축을 쓰지 않는다.** 원장의 `과잉거래일(하루 N건)` 태그는 그날이 몇
 *    건으로 끝나는지를 6번째 거래 시점에 이미 아는 것처럼 군다. `nthOfDay >= 6` 으로
 *    대체한다 — 이건 진입 순간에 알 수 있다. (`diagnose.mjs` 규율 3과 같다)
 * 3. **결과로 정의된 유형을 행동으로 세지 않는다.** 「이익 반납」·「강제청산」은 손실 거래에만
 *    붙는다 — 승률 0% 는 결과가 아니라 정의다. `control: "outcome"` 을 달아 구분하고
 *    비교군을 내지 않는다.
 * 4. **오답이 아닌 것을 오답이라 하지 않는다.** 유형별 합계가 플러스로 나오면 그대로 낸다.
 *    화면이 "데이터는 이걸 오답이라 하지 않는다"고 말할 근거가 그 숫자다.
 *
 * 봇 계정(`account === "live"`)은 대상이 아니다 — 오답노트는 내 손이 낸 주문을 본다.
 *
 * 실행: `node re_sys/mistakes.mjs`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadData, ROOT } from "./lib/data.mjs";

const OUT = join(dirname(ROOT), "docs/mistakes/okx-mistakes.json");

/** 유형마다 실제 거래를 몇 건까지 담을지 — 손실이 큰 쪽부터. */
const WORST = 10;

/** 그날 몇 번째 진입부터 과잉으로 보는가. 진단서 규칙 6(하루 3건)보다 느슨한 관측선이다. */
const OVERTRADE_NTH = 6;

/** 빠른매매의 경계 — 이 아래로 닫은 거래를 빠른매매로 센다. */
const FAST_MIN = 120;

const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const netOf = (t) => t.pnlUsd ?? 0;

/**
 * 한 묶음의 합계 — 앱이 승률·평균·거래당 손익·표준오차를 되살릴 수 있는 최소집합.
 *
 * `sumSqDev` 를 함께 낸다. 이게 없으면 "거래당 3달러 차이"가 진짜 차이인지 표본이
 * 흔들린 것인지 가릴 수 없고, 건수만 많은 유형이 전부 오답으로 둔갑한다.
 * 2-pass 로 낸다 — Σx² − nμ² 는 손익처럼 값이 크고 부호가 섞인 표본에서 자릿수가
 * 상쇄돼 정밀도를 잃는다. (`diagnose.mjs` 와 같은 이유)
 */
function stats(list) {
  const n = list.length;
  const sumNet = list.reduce((a, t) => a + netOf(t), 0);
  const mean = n ? sumNet / n : 0;
  return {
    n,
    wins: list.filter((t) => netOf(t) > 0).length,
    sumNet: r2(sumNet),
    sumSqDev: r2(list.reduce((a, t) => a + (netOf(t) - mean) ** 2, 0)),
    sumFee: r2(list.reduce((a, t) => a + (t.feeUsd ?? 0), 0)),
    sumFunding: r2(list.reduce((a, t) => a + (t.fundingUsd ?? 0), 0)),
  };
}

/** 화면이 "그때 그 거래"를 보여 줄 수 있는 최소 필드. */
function row(t) {
  return {
    id: t.id,
    day: t.day,
    hourKst: t.hourKst,
    symbol: t.instId.split("-")[0],
    side: t.side,
    lever: t.lever,
    holdMin: t.holdMin,
    net: r2(netOf(t)),
    fee: r2(t.feeUsd),
    entryPx: t.entryPx,
    exitPx: t.exitPx,
    intent: t.intent,
    basis: t.intentBasis,
    mfeMarginPct: t.path ? r2(t.path.mfeMarginPct) : null,
    maeMarginPct: t.path ? r2(t.path.maeMarginPct) : null,
    liq: t.liq === true,
  };
}

const worstOf = (list) => [...list].sort((a, b) => netOf(a) - netOf(b)).slice(0, WORST).map(row);

/**
 * 오답 유형 하나.
 *
 * `control` 은 이 유형을 어디서 고를 수 있는가다 — 진입 순간(`entry`), 들고 있는
 * 동안(`exit`), 아니면 결과가 정의에 들어 있어 애초에 고를 수 없는가(`outcome`).
 * 규칙으로 옮길 수 있는 것은 앞의 둘뿐이고, 이 구분이 없으면 "손실 거래는 손실이었다"가
 * 오답으로 둔갑한다.
 */
function group({ id, control, title, rule, taboo, match, baselineLabel }, trades) {
  const hit = trades.filter(match);
  const rest = trades.filter((t) => !match(t));
  return {
    id,
    control,
    title,
    rule,
    taboo,
    ...stats(hit),
    // 결과로 정의된 유형은 비교군이 없다 — 상대가 전부 승리 거래라 비교가 성립하지 않는다.
    baseline: control === "outcome" ? null : { label: baselineLabel, ...stats(rest) },
    worst: worstOf(hit),
  };
}

/* ============ 유형 정의 — 이 목록이 화면의 정본이다 ============ */

const hasTag = (tag) => (t) => (t.tags ?? []).includes(tag);

const GROUPS = [
  {
    id: "fast-exit",
    control: "exit",
    title: "빠른매매 — 2시간 안에 닫았다",
    rule: `보유 시간 ${FAST_MIN}분 미만`,
    taboo: "2시간 안에 닫지 않는다 — 방향이 맞으면 봉을 넘겨서 들고 간다",
    match: (t) => t.holdMin < FAST_MIN,
    baselineLabel: "2시간 이상 들고 있던 거래",
  },
  {
    id: "counter-trend",
    control: "entry",
    title: "역추세 진입 — 추세를 거슬러 들어갔다",
    rule: "진입 시점 SMA20·SMA50 이 만든 추세와 반대 방향",
    taboo: "추세를 거슬러 들어가지 않는다",
    match: (t) => t.intentGroup === "역추세",
    baselineLabel: "그 밖의 진입",
  },
  {
    id: "chase",
    control: "entry",
    title: "추격 진입 — 이미 간 것을 따라 들어갔다",
    rule: "진입 시점 60봉 범위의 끝(돌파·급등락)에서 그 방향으로",
    taboo: "이미 간 것을 따라 들어가지 않는다",
    match: (t) => t.intentGroup === "추격",
    baselineLabel: "그 밖의 진입",
  },
  {
    id: "flip",
    control: "entry",
    title: "방향 뒤집기 — 10분 안에 반대로 들어갔다",
    rule: "같은 종목 직전 거래와 반대 방향 · 직전 청산 후 10분 이내",
    taboo: "직전 거래를 닫고 10분 안에 반대로 들어가지 않는다",
    match: hasTag("방향 뒤집기(≤10분)"),
    baselineLabel: "그 밖의 진입",
  },
  {
    id: "revenge",
    control: "entry",
    title: "손실 직후 재진입 — 30분 안에 다시 들어갔다",
    rule: "같은 종목 직전 거래가 손실 · 직전 청산 후 30분 이내",
    taboo: "잃은 직후 30분 안에 다시 들어가지 않는다",
    match: hasTag("손실 직후 재진입(≤30분)"),
    baselineLabel: "그 밖의 진입",
  },
  {
    id: "overtrade",
    control: "entry",
    title: `과잉거래 — 그날 ${OVERTRADE_NTH}번째 이후 진입`,
    rule: `한국 시간 하루 안에서 ${OVERTRADE_NTH}번째부터의 진입`,
    taboo: "하루 6번째부터는 들어가지 않는다",
    // 원장의 `과잉거래일(하루 N건)` 태그를 쓰지 않는다 — 그날의 총 건수를 진입 시점에
    // 아는 척하는 축이다. 순번은 진입 순간에 실제로 알 수 있다.
    match: (t) => t.nthOfDay >= OVERTRADE_NTH,
    baselineLabel: `그날 ${OVERTRADE_NTH}번째 앞의 진입`,
  },
  {
    id: "lever-up",
    control: "entry",
    title: "손실 후 레버리지 증가 — 잃고 나서 더 걸었다",
    rule: "같은 종목 직전 거래가 손실 · 이번 레버리지가 그보다 높다",
    taboo: "잃은 다음 거래에서 레버리지를 올리지 않는다",
    match: hasTag("손실 후 레버리지 증가"),
    baselineLabel: "그 밖의 진입",
  },
  {
    id: "nostop",
    control: "exit",
    title: "무손절 버티기 — 손절 없이 역행을 감내했다",
    rule: "손절 주문 없음 · 보유 중 증거금 대비 최대 역행 50% 이상 · 강제청산 아님",
    taboo: "손절 없이 역행을 버티지 않는다",
    match: hasTag("무손절 버티기"),
    baselineLabel: "그 밖의 거래",
  },
  {
    id: "giveback",
    control: "outcome",
    title: "이익 반납 — 벌어 놓고 손실로 닫았다",
    rule: "보유 중 증거금 대비 최대 평가익 30% 이상 · 그러고도 손실 마감",
    taboo: "평가익 30%를 넘긴 포지션을 손실로 닫지 않는다",
    match: hasTag("이익 반납"),
    baselineLabel: null,
  },
  {
    id: "liq",
    control: "outcome",
    title: "강제청산 — 증거금이 전부 날아갔다",
    rule: "거래소 강제청산 처리",
    taboo: "강제청산이 나올 만큼 걸지 않는다",
    match: (t) => t.liq === true,
    baselineLabel: null,
  },
];

/** 보유 시간 구간 — 빠른매매가 어디서부터 나빠지는지 한 표로 본다. */
const HOLD_BUCKETS = [
  { id: "h0", label: "5분 미만", lo: 0, hi: 5 },
  { id: "h1", label: "5–30분", lo: 5, hi: 30 },
  { id: "h2", label: "30분–2시간", lo: 30, hi: 120 },
  { id: "h3", label: "2–12시간", lo: 120, hi: 720 },
  { id: "h4", label: "12시간 이상", lo: 720, hi: Infinity },
];

/* ============ 실행 ============ */

const review = loadData("manual-review.json");
if (!review) {
  console.error("re_sys/data/manual-review.json 이 없습니다 — manual-analyze.mjs 를 먼저 돌리세요.");
  process.exit(1);
}

const all = review.trades ?? [];
const trades = all.filter((t) => t.account !== "live");
const excludedBot = all.length - trades.length;

if (trades.length === 0) {
  console.error("대상 거래가 없습니다.");
  process.exit(1);
}

const days = [...new Set(trades.map((t) => t.day))].sort();
const fingerprint = `${trades.length}:${Math.max(...trades.map((t) => t.exitTs ?? t.entryTs ?? 0))}`;

const output = {
  note:
    "오답노트 — re_sys/mistakes.mjs 가 만든다. 손으로 고치지 않는다. " +
    "승률·평균·비교군 대비 차이는 여기 없고 앱이 계산한다.",
  round: {
    no: 1,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    tradeCount: trades.length,
    excludedBot,
    worstPerGroup: WORST,
    period: { from: days[0], to: days[days.length - 1], tradingDays: days.length },
    totals: stats(trades),
  },
  source: {
    file: "re_sys/data/manual-review.json",
    analyzedAt: review.generatedAt ?? null,
    origins: [...new Set(trades.map((t) => t.sourceName))],
  },
  holdBuckets: HOLD_BUCKETS.map((b) => ({
    id: b.id,
    label: b.label,
    ...stats(trades.filter((t) => t.holdMin >= b.lo && t.holdMin < b.hi)),
  })),
  groups: GROUPS.map((g) => group(g, trades)),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(output, null, 1)}\n`, "utf8");

/* ---------- 대조 출력 — 집계본이 원장과 어긋나면 여기서 드러난다 ---------- */

const bucketSum = output.holdBuckets.reduce((a, b) => a + b.n, 0);
const t = output.round.totals;
console.log(
  `거래 ${t.n}건 (봇 ${excludedBot}건 제외) · 승 ${t.wins}건 · 순손익 ${t.sumNet} · ` +
    `기간 ${output.round.period.from}~${output.round.period.to} (${output.round.period.tradingDays}일)`,
);
console.log(`보유시간 구간 합 ${bucketSum}건 — 전체와 ${bucketSum === t.n ? "일치" : "불일치 ⚠"}`);
for (const g of output.groups) {
  const wr = g.n ? ((100 * g.wins) / g.n).toFixed(1) : "-";
  const base = g.baseline ? ` (비교군 ${g.baseline.n}건 승률 ${((100 * g.baseline.wins) / g.baseline.n).toFixed(1)}% 순손익 ${g.baseline.sumNet})` : " (결과 정의)";
  console.log(`  ${g.id.padEnd(14)} ${String(g.n).padStart(5)}건 승률 ${wr.padStart(5)}% 순손익 ${String(g.sumNet).padStart(10)}${base}`);
}
console.log(`저장 완료 → docs/mistakes/okx-mistakes.json`);
