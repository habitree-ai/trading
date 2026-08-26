/**
 * M4 — OKX 전 이력을 켈리 기준으로 집계한다.
 *
 * `manual-analyze.mjs` 가 만든 `manual-review.json`(4,000건대, 45MB)에서 차원별로
 * 승·패·평균수익·평균손실만 뽑아 수십 KB 짜리 집계본으로 줄인다. 원본은 gitignore 라
 * 이 PC 밖에서는 열리지 않지만, 집계본은 커밋되므로 배포된 앱에서도 그대로 보인다.
 *
 * **켈리 값은 여기서 내지 않는다.** 산식(`f* = W − (1−W)/b`)은 앱의
 * `src/lib/metrics.ts` 에 하나만 두고, 이 파일은 그 입력만 만든다 — 구현이 둘이
 * 되면 대시보드와 이 화면이 같은 거래를 두고 다른 켈리를 말하게 된다.
 *
 * 실행: `node re_sys/kelly.mjs`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadData, ROOT } from "./lib/data.mjs";

// ROOT 는 re_sys/ — 저장소 루트는 그 부모다. 어디서 실행해도 같은 자리에 쓴다.
const OUT = join(dirname(ROOT), "docs/kelly/okx-kelly.json");

/** 손익은 수수료·펀딩비를 뺀 실현손익(`pnlUsd`)으로 잰다 — 앱의 `net` 과 같은 정의. */
const netOf = (t) => t.pnlUsd;

const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

/**
 * 한 묶음의 켈리 입력.
 *
 * 본전(손익 0)은 승률의 분모에서 뺀다 — 앱의 `computeMetrics` 와 같은 처리다.
 * 승이나 패 한쪽이 비면 손익비가 정의되지 않아 앱이 켈리를 `null` 로 돌린다.
 */
function statsOf(list) {
  const wins = list.filter((t) => netOf(t) > 0);
  const losses = list.filter((t) => netOf(t) < 0);
  const sum = (arr) => arr.reduce((a, t) => a + netOf(t), 0);

  return {
    n: list.length,
    wins: wins.length,
    losses: losses.length,
    avgWin: wins.length ? r2(sum(wins) / wins.length) : null,
    avgLoss: losses.length ? r2(Math.abs(sum(losses)) / losses.length) : null,
    netPnl: r2(sum(list)),
  };
}

/**
 * 차원 하나를 묶는다.
 *
 * 표본이 아주 얇은 칸(종목 2건짜리 같은)은 켈리가 +70% 처럼 튀어 표를 통째로 오염시킨다.
 * 지우지는 않는다 — 있었던 거래이므로. 대신 n 을 그대로 실어 화면이 흐리게 처리한다.
 */
function group(trades, keyOf) {
  const map = new Map();
  for (const t of trades) {
    const key = String(keyOf(t) ?? "(미기재)");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()].map(([key, list]) => ({ key, ...statsOf(list) }));
}

/** 보유시간 구간 — 이 데이터에서 부호가 갈리는 유일한 축이라 가장 잘게 썬다. */
const HOLD_BANDS = [
  [0, 1, "1분 미만"],
  [1, 5, "1–5분"],
  [5, 15, "5–15분"],
  [15, 30, "15–30분"],
  [30, 60, "30–60분"],
  [60, 120, "1–2시간"],
  [120, 360, "2–6시간"],
  [360, 720, "6–12시간"],
  [720, 1440, "12–24시간"],
  [1440, Infinity, "24시간 이상"],
];

function holdBand(t) {
  if (t.holdMin === null || t.holdMin === undefined) return "(미기재)";
  const band = HOLD_BANDS.find(([lo, hi]) => t.holdMin >= lo && t.holdMin < hi);
  return band ? band[2] : "(미기재)";
}

function leverBand(t) {
  if (t.lever === null || t.lever === undefined) return "(미기재)";
  if (t.lever <= 10) return "10배 이하";
  if (t.lever <= 20) return "20배";
  if (t.lever <= 50) return "50배";
  return "100배";
}

function rsiBand(t) {
  const v = t.context?.rsi;
  if (v === null || v === undefined) return "(미기재)";
  if (v < 30) return "30 미만 (과매도)";
  if (v < 50) return "30–50";
  if (v < 70) return "50–70";
  return "70 이상 (과매수)";
}

/**
 * 차원 목록 — 순서가 곧 화면의 순서다.
 *
 * 보유시간을 맨 앞에 둔다. 나머지 차원은 전 구간이 음수인데 이 축만 2시간을 경계로
 * 부호가 갈린다 — 이 데이터가 답하는 유일한 질문이라 먼저 보여야 한다.
 */
const DIMENSIONS = [
  {
    key: "hold",
    label: "보유시간",
    hint: "진입부터 청산까지. 이 데이터에서 켈리 부호가 갈리는 유일한 축입니다",
    order: HOLD_BANDS.map(([, , name]) => name),
    keyOf: holdBand,
  },
  {
    key: "lever",
    label: "레버리지",
    hint: "진입 배율",
    order: ["10배 이하", "20배", "50배", "100배"],
    keyOf: leverBand,
  },
  {
    key: "intentGroup",
    label: "진입 의도 (묶음)",
    hint: "진입 시점 차트 상태로 역추정한 의도 — 기록에 근거가 비어 있어 유추한 값입니다",
    keyOf: (t) => t.intentGroup,
  },
  {
    key: "intent",
    label: "진입 의도 (상세)",
    hint: "같은 유추를 더 잘게 나눈 것",
    keyOf: (t) => t.intent,
  },
  {
    key: "year",
    label: "연도",
    hint: "방식이 시간에 따라 달라졌는지",
    keyOf: (t) => t.day?.slice(0, 4),
  },
  {
    key: "regime",
    label: "시장 국면",
    hint: "일봉이 SMA200 위인가 아래인가",
    keyOf: (t) => t.regime,
  },
  {
    key: "trendAlign",
    label: "추세 정렬",
    hint: "진입 방향이 그때 추세와 같았는가",
    keyOf: (t) => t.trendAlign,
  },
  {
    key: "session",
    label: "세션",
    hint: "한국시각 기준 시간대 묶음",
    keyOf: (t) => t.session,
  },
  {
    key: "hourKst",
    label: "진입 시각 (KST)",
    hint: "하루 중 언제 들어갔는가",
    order: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}시`),
    keyOf: (t) => `${String(t.hourKst).padStart(2, "0")}시`,
  },
  {
    key: "weekday",
    label: "요일",
    hint: "",
    order: ["월", "화", "수", "목", "금", "토", "일"],
    keyOf: (t) => ["일", "월", "화", "수", "목", "금", "토"][t.weekdayKst],
  },
  {
    key: "rsi",
    label: "진입 시점 RSI",
    hint: "진입 직전 확정봉 기준",
    order: ["30 미만 (과매도)", "30–50", "50–70", "70 이상 (과매수)"],
    keyOf: rsiBand,
  },
  {
    key: "side",
    label: "방향",
    hint: "롱/숏 편향",
    keyOf: (t) => (t.side === "long" ? "롱" : t.side === "short" ? "숏" : "(미기재)"),
  },
  {
    key: "symbol",
    label: "종목",
    hint: "",
    keyOf: (t) => t.instId?.replace(/-USDT-SWAP$/, ""),
  },
  {
    key: "consecLoss",
    label: "직전 연패 수",
    hint: "이 거래 전에 연달아 몇 번 졌는가 — 물타기·복구 매매를 가른다",
    order: ["0", "1", "2", "3", "4", "5", "6", "7 이상"],
    keyOf: (t) => {
      const c = t.consecLossBefore ?? 0;
      return c >= 7 ? "7 이상" : String(c);
    },
  },
  {
    key: "account",
    label: "계정",
    hint: "주 매매계정과 봇 서브계정",
    keyOf: (t) => (t.account === "live" ? "봇 서브계정" : "주 매매계정"),
  },
];

/* ---------- 실행 ---------- */

const review = loadData("manual-review.json");
if (!review) {
  console.error("manual-review.json 이 없습니다 — node re_sys/manual-analyze.mjs 를 먼저 돌리세요.");
  process.exit(1);
}

// 손익이 숫자로 확정된 거래만 — 아직 안 닫힌 건 성적이 없다.
const trades = review.trades.filter((t) => typeof t.pnlUsd === "number");
const days = [...new Set(trades.map((t) => t.day).filter(Boolean))].sort();

/**
 * 손실 거래가 증거금의 몇 %를 가져갔나.
 *
 * 켈리의 f* 는 **자기자본** 대비 비율인데 이 원장에는 거래 시점 잔액이 없어(자금 곡선이
 * 누적 손익만 담는다) 그 축으로는 견줄 수 없다. 증거금 대비 값은 분모가 달라 켈리와 같은
 * 자리에 놓을 수 없으므로, 참고 수치로만 따로 싣는다.
 */
const lossMargins = trades
  .filter((t) => netOf(t) < 0 && typeof t.finalMarginPct === "number")
  .map((t) => Math.abs(t.finalMarginPct))
  .sort((a, b) => a - b);

const output = {
  generatedAt: new Date().toISOString(),
  source: {
    file: "re_sys/data/manual-review.json",
    analyzedAt: review.generatedAt ? new Date(review.generatedAt).toISOString() : null,
    origins: [...new Set(trades.map((t) => t.sourceName))].sort(),
    symbols: new Set(trades.map((t) => t.instId)).size,
  },
  period: { from: days[0] ?? null, to: days.at(-1) ?? null, tradingDays: days.length },
  overall: {
    ...statsOf(trades),
    grossWin: r2(trades.filter((t) => netOf(t) > 0).reduce((a, t) => a + netOf(t), 0)),
    grossLoss: r2(trades.filter((t) => netOf(t) < 0).reduce((a, t) => a + netOf(t), 0)),
    feeUsd: r2(trades.reduce((a, t) => a + (t.feeUsd ?? 0), 0)),
    fundingUsd: r2(trades.reduce((a, t) => a + (t.fundingUsd ?? 0), 0)),
    liqCount: trades.filter((t) => t.liq).length,
  },
  lossMargin: {
    median: r2(lossMargins[Math.floor(lossMargins.length / 2)] ?? null),
    mean: lossMargins.length
      ? r2(lossMargins.reduce((a, b) => a + b, 0) / lossMargins.length)
      : null,
    n: lossMargins.length,
  },
  dimensions: DIMENSIONS.map((d) => {
    const rows = group(trades, d.keyOf);
    // 정해진 순서가 있으면 그대로 따른다 — 보유시간·시각은 크기순으로 읽어야 흐름이 보인다.
    if (d.order) {
      const rank = new Map(d.order.map((k, i) => [k, i]));
      rows.sort((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
    } else {
      rows.sort((a, b) => b.n - a.n);
    }
    return { key: d.key, label: d.label, hint: d.hint, ordered: Boolean(d.order), rows };
  }),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");

const bytes = JSON.stringify(output).length;
console.log(
  `거래 ${output.overall.n}건 (${output.period.from} ~ ${output.period.to}, ${output.period.tradingDays}거래일)`,
);
console.log(`차원 ${output.dimensions.length}개 · ${Math.round(bytes / 1024)}KB → docs/kelly/okx-kelly.json`);
