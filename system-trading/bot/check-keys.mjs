/**
 * 키 검증 — 주문 없이 읽기 전용으로만 확인한다.
 *
 * 확인 항목: 키 유형(라이브/데모), API 권한, 포지션 모드(롱숏 필요), USDT 잔고,
 * 공개 데이터(캔들·계약정보) 접근. 키 값 자체는 어디에도 출력하지 않는다.
 *
 * 사용: node --env-file=<키가 있는 env 파일> system-trading/bot/check-keys.mjs
 */
import { CONFIG as cfg } from "./config.mjs";
import { OkxClient } from "./okx.mjs";

const results = { publicApi: null, keyType: null, checks: [] };
const ok = (name, detail) => { results.checks.push({ name, pass: true, detail }); console.log(`  ✓ ${name} — ${detail}`); };
const fail = (name, detail) => { results.checks.push({ name, pass: false, detail }); console.log(`  ✗ ${name} — ${detail}`); };

console.log("OKX 키 검증 (주문 없음 · 읽기 전용)\n");

// 0) 키 존재 여부 — 값은 절대 출력하지 않는다.
const hasKeys = !!(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE);
if (!hasKeys) {
  fail("환경변수", "OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 중 빠진 것이 있음");
  process.exit(1);
}
ok("환경변수", "세 값 모두 존재 (값은 표시하지 않음)");

// 1) 공개 API — 봇의 데이터 경로.
try {
  const pub = new OkxClient("paper");
  const candles = await pub.candles(cfg.instId, "4H", 10);
  const inst = await pub.instrument(cfg.instId);
  const px = await pub.lastPrice(cfg.instId);
  ok("공개 데이터", `4H 캔들 ${candles.length}개 · ${cfg.instId} ctVal ${inst.ctVal}, lotSz ${inst.lotSz}, tickSz ${inst.tickSz} · 현재가 ${px}`);
  results.publicApi = true;
} catch (e) {
  fail("공개 데이터", e.message);
}

// 2) 키 유형 판별 — 라이브 헤더와 데모 헤더로 각각 인증해 본다. 읽기 요청뿐이다.
async function probe(mode) {
  try {
    const c = new OkxClient(mode);
    const conf = await c.accountConfig();
    let eq = null;
    try { eq = await c.equityUsd(); } catch { /* 잔고 0이거나 통화 없음일 수 있다 */ }
    return { ok: true, conf, eq, client: c };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const live = await probe("live");
const demo = await probe("demo");

let active = null;
if (live.ok && !demo.ok) { results.keyType = "live"; active = live; }
else if (demo.ok && !live.ok) { results.keyType = "demo"; active = demo; }
else if (live.ok && demo.ok) { results.keyType = "live"; active = live; ok("키 유형", "라이브·데모 양쪽 응답 — 라이브로 간주"); }

if (!active) {
  fail("인증", `라이브: ${live.error} / 데모: ${demo.error}`);
  console.log("\n결론: 키가 유효하지 않거나 IP 화이트리스트에 이 PC가 없습니다.");
  process.exit(1);
}

ok("인증", results.keyType === "live" ? "실거래 키 (라이브)" : "모의거래 키 (데모)");

// 3) 권한 — 거래 권한이 있어야 하고, 출금 권한은 없어야 안전하다.
const perm = active.conf.perm ?? "";
if (perm.includes("trade")) ok("거래 권한", `perm="${perm}"`);
else fail("거래 권한", `perm="${perm}" — 거래 권한이 없어 주문 불가`);
if (perm.includes("withdraw")) fail("출금 권한", "켜져 있음 — 보안상 끄기를 강력 권장");
else ok("출금 권한", "없음 (권장 상태)");

// 4) 포지션 모드 — 봇은 롱숏 분리 모드가 필요하다.
if (active.conf.posMode === "long_short_mode") ok("포지션 모드", "롱/숏 분리 — 준비됨");
else fail("포지션 모드", `"${active.conf.posMode}" — OKX 거래 설정에서 '롱/숏 모드'로 변경 필요`);

// 5) 잔고.
if (active.eq !== null && active.eq !== undefined && !Number.isNaN(active.eq)) {
  ok("USDT 잔고", `$${Math.round(active.eq * 100) / 100}`);
  if (active.eq < 10) console.log("    (참고: 잔고가 매우 작으면 최소 주문 수량 미달로 진입이 생략될 수 있음)");
} else {
  fail("USDT 잔고", "조회 불가 또는 USDT 없음 — 트레이딩 계정에 USDT 이체 필요");
}

const failed = results.checks.filter((c) => !c.pass);
console.log(
  `\n결론: ${failed.length === 0
    ? `모든 검증 통과 — ${results.keyType === "live" ? "라이브" : "데모"} 트레이딩 가능 상태`
    : `${failed.length}개 항목 조치 필요 (${failed.map((f) => f.name).join(", ")})`}`,
);
console.log("이 검증은 주문을 내지 않았다. 실제 주문 경로는 봇의 첫 신호에서 확인된다.");
