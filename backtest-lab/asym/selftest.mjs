/**
 * 엔진 자체 검사 — 백테스트를 돌리기 전에 통과해야 하는 7가지.
 * 합성 봉으로 돌린다. 실제 데이터로는 "맞다"를 증명할 수 없고 "안 틀렸다"만 말할 수 있다.
 */
import { walkAsym } from "./lib/asym-engine.mjs";
import * as ta from "../lib/indicators.mjs";

const mk = (closes, gapAt = -1, gapTo = 0) => {
  const out = [];
  let prev = closes[0];
  for (let i = 0; i < closes.length; i += 1) {
    const c = closes[i];
    let o = i === 0 ? c : prev;
    if (i === gapAt) o = gapTo;
    out.push({ t: i * 3600000, o, h: Math.max(o, c) * 1.0005, l: Math.min(o, c) * 0.9995, c, v: 1 });
    prev = c;
  }
  return out;
};
const extOf = (c) => ({
  atrN: ta.atr(c, 22),
  chHigh: ta.rollingExtreme(c.map((b) => b.h), 22, true),
  chLow: ta.rollingExtreme(c.map((b) => b.l), 22, false),
  dcHigh: ta.rollingExtreme(c.map((b) => b.h), 10, true),
  dcLow: ta.rollingExtreme(c.map((b) => b.l), 10, false),
});

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

const flat = new Array(40).fill(100);
const N = 1; // 1R = 1.5% (initSl 1.5)

// ① 하방 고정 — 갭 없이 내려가면 손실이 1R을 넘지 않는다.
{
  const c = mk([...flat, ...Array.from({ length: 40 }, (_, i) => 100 - i * 0.3)]);
  const p = { initSl: 1.5, tp: null, trail: null, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null };
  const r = walkAsym(c, extOf(c), 40, c[40].o, "long", p, N, 200);
  check("① 하방 고정(갭 없음)", r.grossPct >= -r.slDistPct * 1.001 && r.exitType === "sl",
    `손익 ${r.grossPct.toFixed(4)}% / 1R ${r.slDistPct.toFixed(4)}% / ${r.exitType}`);
}

// ② 갭 정직성 — 갭으로 스톱을 뛰어넘으면 손실이 1R을 초과해야 한다(숨기지 않는다).
{
  const c = mk([...flat, 100, 90, 89, 88, 87, ...new Array(20).fill(87)], 41, 90);
  const p = { initSl: 1.5, tp: null, trail: null, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null };
  const r = walkAsym(c, extOf(c), 40, c[40].o, "long", p, N, 200);
  check("② 갭 초과 손실 인정", r.grossPct < -r.slDistPct * 2,
    `손익 ${r.grossPct.toFixed(3)}% / 1R ${r.slDistPct.toFixed(3)}% — 스톱 체결을 낙관하지 않음`);
}

// ③ 추적 단조성 — 올랐다 내려오면 이익에서 청산되고, 느슨해지려던 시도는 전부 막혔다.
{
  const up = Array.from({ length: 60 }, (_, i) => 100 + i * 1.0);
  const down = Array.from({ length: 40 }, (_, i) => 159 - i * 1.5);
  const c = mk([...flat, ...up, ...down]);
  const p = { initSl: 1.5, tp: null, trail: { type: "chandelier", mult: 3 }, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null };
  const r = walkAsym(c, extOf(c), 40, c[40].o, "long", p, N, 300);
  check("③ 추적손절 단조성", r.grossPct > 0 && r.exitType === "trail" && r.stopClamps > 0,
    `손익 +${r.grossPct.toFixed(2)}% / 완화 시도 차단 ${r.stopClamps}회 / MFE ${r.mfePct.toFixed(2)}%`);
}

// ④ 부분청산 회계 항등 — frac=1 은 1R 목표가와 정확히 같아야 한다.
{
  const c = mk([...flat, ...Array.from({ length: 40 }, (_, i) => 100 + i * 0.3)]);
  const e = extOf(c);
  const base = { initSl: 1.5, tp: null, trail: null, trailArmR: 0, beArmR: null, timeCut: null, pyramid: null };
  const full = walkAsym(c, e, 40, c[40].o, "long", { ...base, partial: { atR: 1, frac: 1 } }, N, 200);
  const diff = Math.abs(full.grossPct - full.slDistPct);
  check("④ 부분청산 회계 항등", diff < 1e-9, `frac=1 손익 ${full.grossPct.toFixed(9)}% vs 1R ${full.slDistPct.toFixed(9)}% (차 ${diff.toExponential(2)})`);
}

// ⑤ 부분청산 중립성 — frac=0 은 부분청산 없음과 완전히 같아야 한다.
{
  const c = mk([...flat, ...Array.from({ length: 30 }, (_, i) => 100 + i * 0.4), ...Array.from({ length: 30 }, (_, i) => 112 - i * 0.8)]);
  const e = extOf(c);
  const base = { initSl: 1.5, tp: null, trail: { type: "atr", mult: 3 }, trailArmR: 0, beArmR: null, timeCut: null, pyramid: null };
  const a = walkAsym(c, e, 40, c[40].o, "long", { ...base, partial: null }, N, 200);
  const b = walkAsym(c, e, 40, c[40].o, "long", { ...base, partial: { atR: 1, frac: 0 } }, N, 200);
  check("⑤ 부분청산 중립성", Math.abs(a.grossPct - b.grossPct) < 1e-9, `없음 ${a.grossPct.toFixed(9)}% vs frac=0 ${b.grossPct.toFixed(9)}%`);
}

// ⑥ 피라미딩 회계 — 4유닛 램프에서 손익이 로트별 독립 계산의 합과 일치한다.
{
  // 돈치안(10) 청산선이 진입가 아래 충분히 떨어져 있어야 터틀 규약이 성립한다 — 사전 램프를 준다.
  const ramp = Array.from({ length: 40 }, (_, i) => 80 + i * 0.5);
  const c = mk([...ramp, ...Array.from({ length: 60 }, (_, i) => 100 + i * 0.5), ...Array.from({ length: 20 }, (_, i) => 129 - i * 3)]);
  const p = { initSl: 2, tp: null, trail: { type: "donchian" }, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: { stepN: 0.5, max: 3 } };
  const r = walkAsym(c, extOf(c), 40, c[40].o, "long", p, N, 300);
  const entry = c[40].o;
  const lots = [entry, entry + 0.5, entry + 1.0, entry + 1.5];
  const manual = lots.reduce((s, e0) => s + ((r.exitPrice - e0) / e0) * 100, 0);
  check("⑥ 피라미딩 회계 합치", r.peakUnits === 4 && Math.abs(r.grossPct - manual) < 1e-9,
    `유닛 ${r.peakUnits} / 엔진 ${r.grossPct.toFixed(9)}% vs 수기 ${manual.toFixed(9)}%`);
}

// ⑦ 상한고정 피라미딩 — 증량 후 급반전에서도 총 손실이 1R을 넘지 않는다.
{
  const ramp = Array.from({ length: 40 }, (_, i) => 80 + i * 0.5);
  const up = Array.from({ length: 12 }, (_, i) => 100 + i * 0.5);
  const crash = Array.from({ length: 30 }, (_, i) => 105 - i * 1.2);
  const c = mk([...ramp, ...up, ...crash]);
  // 추적손절을 끈다 — 켜 두면 추적선이 먼저 구해 버려서 상한 자체가 시험되지 않는다.
  const base = { initSl: 2, tp: null, trail: null, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: { stepN: 0.5, max: 3 } };
  const e = extOf(c);
  const raw = walkAsym(c, e, 40, c[40].o, "long", base, N, 300);
  const cap = walkAsym(c, e, 40, c[40].o, "long", { ...base, capRisk: true }, N, 300);
  check("⑦ 상한고정 피라미딩", cap.grossPct >= -cap.slDistPct * 1.001 && cap.peakUnits > 1 && raw.grossPct < -raw.slDistPct * 1.5,
    `상한고정 ${cap.grossPct.toFixed(3)}% (1R ${cap.slDistPct.toFixed(3)}%, ${cap.peakUnits}유닛) vs 무제한 ${raw.grossPct.toFixed(3)}%`);
}

let ok = true;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  —  ${r.detail}`);
  if (!r.pass) ok = false;
}
console.log(ok ? "\n자체 검사 7/7 통과" : "\n자체 검사 실패 — 스윕 중단");
process.exit(ok ? 0 : 1);
