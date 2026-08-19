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
import { notify } from "./notify.mjs";
import { OkxClient } from "./okx.mjs";
import { loadState } from "./state-db.mjs";

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
const state = await loadState(mode, cfg.paperStartEquity);

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

  /*
   * 어느 계좌에 붙었는지 — 이것이 없어서 2026-08-19 에 데었다.
   *
   * .env.local 에 OKX_API_KEY 가 두 번 적혀 있었다(주 매매계정 → 봇 서브계정). 나중
   * 값이 이겨서 앞 블록은 조용히 죽어 있었는데, 순서가 바뀌거나 뒤 블록이 지워지면
   * 봇은 아무 신호 없이 주 계정에 주문을 내기 시작한다 — 키가 유효하니 오류도 안 난다.
   * uid 를 못 박아 두면 그 순간 사이클이 시작되지 않는다.
   */
  const sub = conf.mainUid && conf.mainUid !== conf.uid;
  console.log(`계좌: uid ${conf.uid}${sub ? ` (서브 · 메인 ${conf.mainUid})` : " (메인)"}`);

  const expectedUid = (process.env.OKX_EXPECTED_UID ?? "").trim();
  if (expectedUid && expectedUid !== conf.uid) {
    console.error(
      `계좌가 다릅니다 — 기대한 uid ${expectedUid}, 실제 uid ${conf.uid}.\n` +
      "OKX_API_KEY 계열 환경변수가 어느 계정 것인지 확인하세요. 주문을 내지 않고 멈춥니다.",
    );
    process.exit(1);
  }
  if (!expectedUid) {
    console.warn(
      "경고: OKX_EXPECTED_UID 가 없습니다 — 키가 바뀌어도 봇이 알아채지 못합니다.\n" +
      `이 계좌가 맞다면 .env.local 에 OKX_EXPECTED_UID=${conf.uid} 를 넣어 두세요.`,
    );
  }
}

const TAG = `[${mode.toUpperCase()}]`;

async function once() {
  const started = new Date().toISOString();
  try {
    const s = await runCycle(client, state);
    console.log(`[${started}] ${mode} 사이클 완료 — 잔고 ${s.equity === null ? "?" : "$" + s.equity} · 열린 포지션 ${s.openPositions.join(", ") || "없음"}`);
    for (const a of s.actions) console.log("  · " + a);
    for (const e of s.evaluated) console.log("  평가 " + e);
    // 진입·청산·경고가 있던 사이클만 알린다 — 무사건 사이클까지 울리면 알림이 소음이 된다.
    if (s.actions.length) await notify(`${TAG} ${s.actions.join("\n")}`);
    return s;
  } catch (e) {
    console.error(`[${started}] 사이클 실패:`, e.message);
    await notify(`${TAG} 사이클 실패: ${e.message}`);
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
  // 재시도까지 소진하고도 봉이 안 확정됐으면 그 봉의 신호는 유실될 수 있다 — 알려야 한다.
  if (s?.stale?.length) await notify(`${TAG} 봉 확정 지연(${s.stale.join(",")}) — 재시도 소진, 이 봉의 신호는 건너뛸 수 있음`);
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
