/**
 * 진입·청산 배선 테스트 — 1분봉 RSI 기준, 최소 수량, 짧은 브래킷.
 *
 * 목적: 실전 기준(4H)과 무관하게 "주문 → 브래킷 부착 → 체결 → 청산 → 기록"의
 * 배선이 실제 거래소에서 도는지 확인한다. 수량은 항상 최소(minSz) 고정 —
 * 테스트의 목적은 손익이 아니라 왕복이다.
 *
 * 사용 (점검은 주문 없음, 실행은 사용자가 직접):
 *   node --env-file=.env.local system-trading/bot/test-trade.mjs                  # 준비 점검만
 *   node --env-file=.env.local system-trading/bot/test-trade.mjs --mode demo --run force
 *   node --env-file=.env.local system-trading/bot/test-trade.mjs --mode live --run force        # 즉시 1왕복
 *   node --env-file=.env.local system-trading/bot/test-trade.mjs --mode live --run signal --rounds 3
 *
 * run 모드:
 *   force  — 신호를 기다리지 않고 롱→숏 번갈아 즉시 진입 (기계 검증)
 *   signal — 1분봉 RSI(14)가 30 상향 복귀(롱)/70 하향 복귀(숏)하는 실제 신호 대기 (트리거 검증)
 *
 * 라이브는 봇과 같은 이중 안전장치(LIVE_TRADING_ACK)를 요구한다.
 * 모든 사건이 data/test-<mode>.jsonl 에 남고, test-report.mjs 가 HTML로 만든다.
 */
import { OkxClient } from "./okx.mjs";
import { appendLog } from "./state.mjs";

const INST = "BTC-USDT-SWAP";
const LEV = 10;
const TP_PCT = 0.15; // 목표 ±0.15% — 1분봉에서 수 분 안에 끝나는 폭
const SL_PCT = 0.10;
const RESOLVE_TIMEOUT_MS = 8 * 60_000; // 이 시간 안에 브래킷이 안 끝나면 시장가 정리
const SIGNAL_TIMEOUT_MS = 45 * 60_000; // 신호 대기 상한

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1] ?? "";
};
const mode = (flag("mode") ?? "check").toLowerCase();
const run = (flag("run") ?? "").toLowerCase();
const roundsRaw = Number(flag("rounds") ?? 3);
const rounds = Number.isFinite(roundsRaw) ? Math.max(1, Math.min(10, roundsRaw)) : 3;

const log = (event, data = {}) => {
  const row = { event, ...data };
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${event}`, JSON.stringify(data));
  if (mode !== "check") appendLog(`test-${mode}`, "events", row);
};

/* ---------- 지표 ---------- */

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
  }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}

/** 마지막 두 마감 1분봉의 RSI — 교차 판정에 쓴다. */
async function rsiPair(client) {
  const candles = await client.candles(INST, "1m", 120);
  const closes = candles.map((c) => c.c);
  return {
    prev: rsi(closes.slice(0, -1)),
    curr: rsi(closes),
    lastTs: candles[candles.length - 1].t,
    lastClose: closes[closes.length - 1],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 준비 점검 (주문 없음) ---------- */

async function check() {
  console.log("테스트 준비 점검 — 주문을 내지 않습니다.\n");
  const pub = new OkxClient("paper");
  const inst = await pub.instrument(INST);
  const px = await pub.lastPrice(INST);
  const { prev, curr } = await rsiPair(pub);
  const minNotional = inst.minSz * inst.ctVal * px;
  console.log(`  현재가 ${px} · 1분봉 RSI ${curr?.toFixed(1)} (직전 ${prev?.toFixed(1)})`);
  console.log(`  최소 수량 ${inst.minSz}계약 = ${(inst.minSz * inst.ctVal)} BTC ≈ $${minNotional.toFixed(2)} 명목`);
  const needMargin = minNotional / LEV;
  const needBalance = needMargin * 1.3 + 0.1; // 수수료·증거금 버퍼
  console.log(`  ${LEV}배 기준 필요 증거금 ≈ $${needMargin.toFixed(2)} → 권장 최소 잔고 ≈ $${needBalance.toFixed(2)}`);

  for (const m of ["live", "demo"]) {
    try {
      const c = new OkxClient(m);
      const eq = await c.equityUsd();
      const ok = eq >= needBalance;
      console.log(`  ${m === "live" ? "라이브" : "데모"} 잔고: $${eq.toFixed(2)} → ${ok ? "테스트 가능" : `부족 (최소 $${needBalance.toFixed(2)} 필요)`}`);
    } catch (e) {
      console.log(`  ${m === "live" ? "라이브" : "데모"}: 인증 안 됨 (${e.message.slice(0, 60)})`);
    }
  }
  console.log("\n실행은 --mode live|demo --run force|signal 로 직접 하세요 (라이브는 LIVE_TRADING_ACK 필요).");
}

/* ---------- 1왕복 — 진입 → 브래킷 → 해소(체결 또는 시장가 정리) ---------- */

async function oneRoundTrip(client, inst, side, roundNo) {
  const t0 = Date.now();
  const px = await client.lastPrice(INST);
  const dir = side === "long" ? 1 : -1;
  const stop = px * (1 - (dir * SL_PCT) / 100);
  const target = px * (1 + (dir * TP_PCT) / 100);
  const sz = inst.minSz.toFixed(inst.szDecimals);
  const algoClOrdId = `qt${Date.now()}`;

  log("entry-try", { roundNo, side, refPx: px, stop: +stop.toFixed(1), target: +target.toFixed(1), sz });
  await client.setLeverage(INST, LEV, side, "isolated");
  const ordId = await client.openWithBracket({
    instId: INST,
    side: side === "long" ? "buy" : "sell",
    posSide: side,
    sz,
    stop,
    target,
    mgnMode: "isolated",
    algoClOrdId,
    tickSz: inst.tickSz,
    pxDecimals: inst.pxDecimals,
  });
  log("entry-ok", { roundNo, ordId, algoClOrdId, latencyMs: Date.now() - t0 });

  // 브래킷이 걸렸는지로 청산을 분류한다.
  const classify = (det) => (det.actualSide === "tp" ? "tp" : det.actualSide === "sl" ? "sl" : "algo");

  /**
   * 시장가 정리 — 예외에도 포지션을 벗은 채 두지 않는다.
   *
   * 정리 직전에 브래킷을 한 번 더 확인한다(그 사이 걸렸으면 이중 청산 금지),
   * 포지션이 실제로 남아 있을 때만 닫고, 실패하면 재시도한다. 끝까지 실패하면
   * 프로세스를 죽이는 대신 크게 알린다 — 브래킷이 살아 있으면 보호는 유지된다.
   */
  const forceClose = async (reason) => {
    const fresh = await client.algoDetails(algoClOrdId);
    if (fresh && !fresh.error && fresh.state === "effective") {
      const exitType = classify(fresh);
      log("exit-bracket", { roundNo, exitType, actualPx: fresh.actualPx ?? null, heldMs: Date.now() - t0, note: "정리 직전 체결 확인" });
      return { resolved: exitType, heldMs: Date.now() - t0 };
    }
    if (fresh && !fresh.error && fresh.algoId && fresh.state !== "canceled") {
      await client.cancelAlgo(INST, fresh.algoId).catch(() => {});
    }
    const open = await client.positions(INST).catch(() => []);
    const still = open.some((p) => p.posSide === side && Number(p.pos) > 0);
    if (!still) {
      log("exit-assumed-flat", { roundNo, reason, heldMs: Date.now() - t0 });
      return { resolved: "assumed-flat", heldMs: Date.now() - t0 };
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await client.closeMarket({ instId: INST, posSide: side, sz, mgnMode: "isolated" });
        log("exit-timeout-close", { roundNo, reason, heldMs: Date.now() - t0 });
        return { resolved: "timeout-close", heldMs: Date.now() - t0 };
      } catch (e) {
        log("exit-close-retry", { roundNo, attempt, error: e.message });
        await sleep(3_000);
      }
    }
    log("exit-close-FAILED", { roundNo, note: "수동 정리 필요 — 거래소 앱에서 포지션 확인!" });
    return { resolved: "close-failed", heldMs: Date.now() - t0 };
  };

  // 해소 대기 — 브래킷이 걸리거나(effective) 시한이 지나면 시장가 정리.
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  for (;;) {
    await sleep(5_000);
    const det = await client.algoDetails(algoClOrdId);
    if (det && !det.error && det.state === "effective") {
      const exitType = classify(det);
      log("exit-bracket", { roundNo, exitType, actualPx: det.actualPx ?? null, heldMs: Date.now() - t0 });
      return { resolved: exitType, heldMs: Date.now() - t0 };
    }
    if (det && !det.error && det.state === "canceled") {
      // 브래킷이 걷혔다 — 보호 없는 포지션을 8분씩 들고 있을 이유가 없다. 즉시 정리.
      log("exit-anomaly", { roundNo, note: "브래킷 취소 감지 — 즉시 정리" });
      return forceClose("bracket-canceled");
    }
    if (Date.now() >= deadline) return forceClose("timeout");
  }
}

/* ---------- 실행 모드 ---------- */

async function main() {
  if (mode === "check") return check();

  if (!["demo", "live"].includes(mode)) {
    console.error(`알 수 없는 모드: ${mode} (check | demo | live)`);
    process.exit(1);
  }
  if (!["force", "signal"].includes(run)) {
    console.error("--run force 또는 --run signal 을 지정하세요.");
    process.exit(1);
  }
  if (mode === "live" && process.env.LIVE_TRADING_ACK !== "I_UNDERSTAND_THE_RISK") {
    console.error("라이브 테스트가 차단되었습니다. LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK 를 셸에서 직접 설정하세요.");
    process.exit(1);
  }

  const client = new OkxClient(mode);
  const conf = await client.accountConfig();
  if (conf.posMode !== "long_short_mode") {
    console.error(`포지션 모드가 ${conf.posMode} — 롱/숏 모드로 바꾼 뒤 실행하세요.`);
    process.exit(1);
  }
  const inst = await client.instrument(INST);
  const px0 = await client.lastPrice(INST);
  const eq = await client.equityUsd();
  const needBalance = (inst.minSz * inst.ctVal * px0) / LEV * 1.3 + 0.1;
  if (eq < needBalance) {
    console.error(`잔고 $${eq.toFixed(2)} — 최소 $${needBalance.toFixed(2)} 필요 (최소 수량 ${inst.minSz}계약 ≈ $${(inst.minSz * inst.ctVal * px0).toFixed(2)} 명목).`);
    process.exit(1);
  }

  log("test-start", { mode, run, rounds, equity: eq, minSz: inst.minSz, lev: LEV, tpPct: TP_PCT, slPct: SL_PCT });

  // 같은 1분봉으로 두 라운드가 연달아 트리거되지 않게 — 라운드 밖에서 기억한다.
  let lastSeen = 0;
  for (let r = 1; r <= rounds; r += 1) {
    let side;
    if (run === "force") {
      side = r % 2 === 1 ? "long" : "short"; // 롱·숏 번갈아 — 양방향 배선을 다 본다.
      log("force-side", { roundNo: r, side });
    } else {
      // 1분봉 RSI 교차 대기 — 30 상향 복귀=롱, 70 하향 복귀=숏.
      log("signal-wait", { roundNo: r, rule: "1m RSI(14) 30↑=롱 · 70↓=숏" });
      const waitUntil = Date.now() + SIGNAL_TIMEOUT_MS;
      side = null;
      while (!side && Date.now() < waitUntil) {
        await sleep(10_000);
        const p = await rsiPair(client).catch(() => null);
        if (!p || p.prev === null || p.curr === null || p.lastTs === lastSeen) continue;
        lastSeen = p.lastTs;
        if (p.prev < 30 && p.curr >= 30) side = "long";
        else if (p.prev > 70 && p.curr <= 70) side = "short";
        if (side) log("signal-fired", { roundNo: r, side, prevRsi: +p.prev.toFixed(1), rsi: +p.curr.toFixed(1), close: p.lastClose });
      }
      if (!side) {
        log("signal-timeout", { roundNo: r, waitedMin: SIGNAL_TIMEOUT_MS / 60000 });
        continue;
      }
    }
    // 한 라운드의 실패가 프로세스를 죽이게 두지 않는다 — 죽으면 포지션이 방치된다.
    try {
      const out = await oneRoundTrip(client, inst, side, r);
      log("round-done", { roundNo: r, ...out, equity: await client.equityUsd().catch(() => null) });
    } catch (e) {
      log("round-ERROR", { roundNo: r, error: e.message, note: "거래소 앱에서 포지션·브래킷 수동 확인 필요" });
    }
    await sleep(3_000);
  }

  log("test-end", { equity: await client.equityUsd().catch(() => null) });
  console.log(`\n완료 — 기록: system-trading/data/events-test-${mode}.jsonl`);
  console.log("리포트: node system-trading/bot/test-report.mjs " + mode);
}

await main();
