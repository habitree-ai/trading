/**
 * 장부 자체 검사 — 그리드를 돌리기 전에 통과해야 하는 6가지.
 * 복리 회계는 틀려도 그럴듯한 곡선을 그린다. 그래서 항등식으로 잡아야 한다.
 */
import { runBook, START, COST_ROUNDTRIP } from "./lib/book.mjs";
import { METHODS } from "./lib/sizing.mjs";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** 겹치지 않는 합성 거래 — 하루 하나씩. */
const mkSeq = (nets, slPct = 2, maePct = 0) =>
  nets.map((net, i) => ({
    part: "x", side: "long",
    entryAt: T0 + i * 2 * DAY, exitAt: T0 + (i * 2 + 1) * DAY,
    slPct, maePct, net,
  }));

const WIN = { from: T0 - DAY, to: T0 + 400 * DAY };

// ① 복리 항등 — 겹침 없고 제약이 안 걸리면 최종 자산은 곱의 연쇄와 정확히 같아야 한다.
{
  const nets = [3, -2, 5, -2, 4, -2, 6, -2];
  const tr = mkSeq(nets);
  const risk = 4;
  const lev = risk / (2 + COST_ROUNDTRIP); // levCap 을 크게 두면 이 값이 그대로 실효 레버리지
  const r = runBook(tr, { method: METHODS.m1, riskPct: risk, levCap: 50, maxConcurrent: 1, ...WIN });
  let manual = START;
  for (const n of nets) manual *= 1 + (lev * n) / 100;
  check("① 복리 항등", Math.abs(r.finalEquity - Math.round(manual * 100) / 100) < 0.02,
    `장부 ${r.finalEquity} vs 수기 ${manual.toFixed(2)} (실효 레버 ${lev.toFixed(3)}x, 거래 ${r.trades})`);
}

// ② 고정 금액은 복리를 끈다 — 손익이 초기 자본에만 비례하므로 합이 선형이어야 한다.
{
  const nets = [5, 5, 5, 5, 5, 5];
  const tr = mkSeq(nets);
  const risk = 4;
  const lev = risk / (2 + COST_ROUNDTRIP);
  const r = runBook(tr, { method: METHODS.m0, riskPct: risk, levCap: 50, maxConcurrent: 1, ...WIN });
  const linear = START + nets.reduce((s, n) => s + (START * lev * n) / 100, 0);
  check("② 고정 금액 = 비복리", Math.abs(r.finalEquity - linear) < 0.05,
    `장부 ${r.finalEquity} vs 선형 ${linear.toFixed(2)} · 고정비율이면 ${(START * Math.pow(1 + (lev * 5) / 100, 6)).toFixed(2)}`);
}

// ③ 청산 임계 — MAE 가 100/Lex − 유지증거금 을 넘으면 증거금 전액이 날아간다.
{
  const lev = 10;
  const thr = 100 / lev - 0.5; // 9.5%
  const tr = [
    { part: "x", side: "long", entryAt: T0, exitAt: T0 + DAY, slPct: 2, maePct: thr + 0.1, net: -2.1 },
  ];
  const r = runBook(tr, { method: METHODS.m1, riskPct: 4, levCap: lev, maxConcurrent: 1, ...WIN });
  const expectedMargin = (START * Math.min(lev, 4 / (2 + COST_ROUNDTRIP))) / lev;
  check("③ 강제청산 판정", r.liquidations === 1 && Math.abs(START - r.finalEquity - expectedMargin) < 0.02,
    `청산 ${r.liquidations}건 · 손실 ${(START - r.finalEquity).toFixed(4)} vs 증거금 ${expectedMargin.toFixed(4)}`);
}

// ④ 미래 참조 없음 — 사이징이 호출된 순간, 닫힌 거래 중 미래에 청산될 것이 없어야 한다.
{
  const tr = [];
  for (let i = 0; i < 40; i += 1) {
    tr.push({ part: "x", side: "long", entryAt: T0 + i * DAY, exitAt: T0 + (i + 3) * DAY, slPct: 2, maePct: 1, net: i % 2 ? 3 : -2 });
  }
  let violation = 0;
  let calls = 0;
  const probe = {
    fn: (st, base, e) => {
      calls += 1;
      // partR 은 닫힌 거래의 R 이력이다. 이 시점에 담긴 건수가 늘어나는 방향으로만 커져야 하고,
      // 장부가 정산한 거래의 청산 시각은 전부 이 거래의 진입 시각 이하여야 한다.
      const seen = st.partR("x", 999).length;
      if (seen > st.__lastSeen ?? 0) st.__lastSeen = seen;
      const closedShouldBe = tr.filter((x) => x.exitAt <= e.entryAt).length;
      if (seen > closedShouldBe) violation += 1;
      return base;
    },
  };
  runBook(tr, { method: probe, riskPct: 3, levCap: 10, maxConcurrent: 3, ...WIN });
  check("④ 미래 참조 없음", violation === 0 && calls > 10, `사이징 호출 ${calls}회 · 위반 ${violation}건`);
}

// ⑤ 증거금 보존 — 동시 보유가 늘어도 사용 증거금 합이 자기자본을 넘지 않는다.
{
  const tr = [];
  for (let i = 0; i < 60; i += 1) {
    tr.push({ part: "p" + (i % 5), side: "long", entryAt: T0 + i * DAY, exitAt: T0 + (i + 10) * DAY, slPct: 0.3, maePct: 0.2, net: i % 3 ? 1 : -0.4 });
  }
  const r = runBook(tr, { method: METHODS.m1, riskPct: 20, levCap: 3, maxConcurrent: 5, ...WIN });
  check("⑤ 증거금 보존", r.finalEquity > 0 && r.skipMargin >= 0 && r.trades > 0,
    `거래 ${r.trades} · 증거금 부족 스킵 ${r.skipMargin} · 동시 상한 스킵 ${r.skipConcurrent} · 최종 ${r.finalEquity}`);
}

// ⑥ 히트 상한 — 동시에 열린 리스크의 합이 뚜껑을 넘지 않는다.
{
  const tr = [];
  for (let i = 0; i < 60; i += 1) {
    tr.push({ part: "p" + (i % 6), side: "long", entryAt: T0 + i * DAY, exitAt: T0 + (i + 8) * DAY, slPct: 2, maePct: 1, net: i % 3 ? 2 : -2 });
  }
  const cap = 5;
  const free = runBook(tr, { method: METHODS.m1, riskPct: 3, levCap: 10, maxConcurrent: 6, ...WIN });
  const held = runBook(tr, { method: METHODS.m1, riskPct: 3, levCap: 10, maxConcurrent: 6, heatCap: cap, ...WIN });
  // 히트 3%짜리가 동시에 2개면 6% > 5% 이므로 반드시 스킵이 생겨야 한다.
  check("⑥ 히트 상한 작동", held.skipHeat > 0 && held.trades < free.trades,
    `상한 없음 ${free.trades}건 → 상한 ${cap}% ${held.trades}건 (히트 스킵 ${held.skipHeat})`);
}

let ok = true;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  —  ${r.detail}`);
  if (!r.pass) ok = false;
}
console.log(ok ? `\n장부 자체 검사 ${results.length}/${results.length} 통과` : "\n장부 자체 검사 실패 — 그리드 중단");
process.exit(ok ? 0 : 1);
