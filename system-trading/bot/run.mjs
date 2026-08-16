/**
 * 실행기 — 쿼드 공격형 봇의 유일한 진입점.
 *
 *   node system-trading/bot/run.mjs                     # 페이퍼 · 1회 실행
 *   node system-trading/bot/run.mjs --loop              # 페이퍼 · 4시간마다 자동
 *   node system-trading/bot/run.mjs --mode demo --loop  # OKX 모의거래 (데모 API 키 필요)
 *   node system-trading/bot/run.mjs --mode live --loop  # 실거래 — 아래 안전장치 참조
 *
 * 키는 .env 파일에 두고 `node --env-file=system-trading/bot/.env ...` 로 주입한다.
 *
 * 라이브 안전장치(둘 다 필요):
 *   1) --mode live 명시
 *   2) 환경변수 LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK
 * 이 장치는 실수로 실거래가 켜지는 것을 막기 위한 것이다. 라이브 전에
 * docs/operations.md 의 승격 사다리(페이퍼 → 데모 → 2% → 5% → 10%)를 따를 것.
 */
import { CONFIG as cfg } from "./config.mjs";
import { runCycle } from "./engine.mjs";
import { OkxClient } from "./okx.mjs";
import { loadState } from "./state.mjs";

const args = process.argv.slice(2);
// `--mode demo` 와 `--mode=demo` 둘 다 받는다 — 한쪽만 받고 조용히 paper 로
// 떨어지면 사용자는 데모를 돌리고 있다고 믿게 된다.
let mode = "paper";
const mi = args.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
if (mi >= 0) {
  mode = (args[mi].includes("=") ? args[mi].split("=")[1] : args[mi + 1] ?? "").toLowerCase();
}
const loop = args.includes("--loop");

if (!["paper", "demo", "live"].includes(mode)) {
  console.error(`알 수 없는 모드: "${mode}" (paper | demo | live)`);
  process.exit(1);
}
console.log(`모드: ${mode.toUpperCase()}${mode === "paper" ? " (주문 없음·키 불필요)" : mode === "demo" ? " (OKX 모의거래)" : " (실거래!)"}`);
if (mode === "live" && process.env.LIVE_TRADING_ACK !== "I_UNDERSTAND_THE_RISK") {
  console.error(
    "라이브 모드가 차단되었습니다.\n" +
    "실거래는 실제 손실을 만듭니다. 백테스트 기준 이 구성(리스크 10%)의 최대낙폭은 -72%였습니다.\n" +
    "진행하려면 환경변수 LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK 를 직접 설정하세요.\n" +
    "먼저 docs/operations.md 의 승격 사다리를 읽을 것.",
  );
  process.exit(1);
}

const client = new OkxClient(mode);
const state = loadState(mode, cfg.paperStartEquity);

// 데모·라이브 사전 점검 — 계정이 롱숏 분리 모드가 아니면 모든 주문이 실패한다.
if (mode !== "paper") {
  let conf;
  try {
    conf = await client.accountConfig();
  } catch (e) {
    console.error(
      `계정 설정 조회 실패: ${e.message}\n` +
      "키·시크릿·패스프레이즈가 맞는지, 데모 모드라면 '데모 전용' 키인지 확인하세요.",
    );
    process.exit(1);
  }
  if (conf.posMode !== "long_short_mode") {
    console.error(
      `계정 포지션 모드가 "${conf.posMode}" 입니다. 이 봇은 롱숏 분리 모드가 필요합니다.\n` +
      "OKX 앱 > 거래 설정 > 포지션 모드에서 '롱/숏 모드'로 바꾼 뒤 다시 실행하세요.",
    );
    process.exit(1);
  }
}

async function once() {
  const started = new Date().toISOString();
  try {
    const s = await runCycle(client, state);
    console.log(`[${started}] ${mode} 사이클 완료 — 잔고 ${s.equity === null ? "?" : "$" + s.equity} · 열린 포지션 ${s.openPositions.join(", ") || "없음"}`);
    for (const a of s.actions) console.log("  · " + a);
    for (const e of s.evaluated) console.log("  평가 " + e);
    return s;
  } catch (e) {
    console.error(`[${started}] 사이클 실패:`, e.message);
    return null;
  }
}

/** 봉 확정이 늦으면 조금 기다렸다 다시 본다 — 안 그러면 그 봉은 영영 평가되지 않는다. */
async function onceWithRetry() {
  let s = await once();
  for (let r = 0; r < 2 && s?.stale?.length; r += 1) {
    console.log(`봉 확정 대기(${s.stale.join(",")}) — 2분 뒤 재시도`);
    await new Promise((res) => setTimeout(res, 120_000));
    s = await once();
  }
  return s;
}

function msToNext4hClose() {
  // 4H 봉은 UTC 0·4·8·12·16·20시에 닫힌다. 마감 90초 뒤에 돈다 —
  // 거래소가 봉을 확정(confirm)할 시간을 준다. 1D는 새 봉 감지로 같은 사이클에서 처리된다.
  const period = 4 * 3600_000;
  return period - (Date.now() % period) + 90_000;
}

await onceWithRetry();
if (loop) {
  const schedule = () => {
    const wait = msToNext4hClose();
    console.log(`다음 사이클: ${new Date(Date.now() + wait).toISOString()} (${Math.round(wait / 60000)}분 뒤)`);
    setTimeout(async () => {
      await onceWithRetry();
      schedule();
    }, wait);
  };
  schedule();
}
