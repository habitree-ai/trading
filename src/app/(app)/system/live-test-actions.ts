"use server";

import { requireUser } from "@/lib/queries";
import {
  LIVE_TEST_LEV,
  LIVE_TEST_SL_PCT,
  LIVE_TEST_TP_PCT,
  accountConfig,
  algoDetails,
  cancelAlgo,
  closeMarket,
  equityUsd,
  instrument,
  lastPrice,
  openWithBracket,
  positions,
  setLeverage,
} from "@/lib/okx-live";
import { appendTestEvent } from "@/lib/system-trading";

/**
 * 실주문 테스트 액션 — 버튼이 누른 그 순간에만, 최소 수량으로만 나간다.
 *
 * 배선은 시스템 봇과 동일하다(시장가 + 손절·목표 브래킷 원자 부착, 격리 10배).
 * 여기서 검증된 경로가 이후 라이브 봇 제어(시작·정지·수동 정리)의 공용 통로가 된다.
 * 사이징을 잔고에 걸지 않는 이유: 테스트의 목적은 왕복이지 손익이 아니다.
 */

const INST = "BTC-USDT-SWAP";
const LEV = LIVE_TEST_LEV;
const TP_PCT = LIVE_TEST_TP_PCT;
const SL_PCT = LIVE_TEST_SL_PCT;

/**
 * 배포 환경 불변식 — 허용목록 없이 실주문 액션을 열지 않는다.
 * allowlist 는 미설정 시 로컬 편의로 전체 허용(fail-open)이라, 키가 있는 배포에서
 * 이 변수를 빠뜨리면 구글 로그인만으로 누구나 주문할 수 있게 된다.
 */
function deployGuard(): string | null {
  if (process.env.NODE_ENV === "production" && !(process.env.ALLOWED_EMAILS ?? "").trim()) {
    return "배포 환경에서는 ALLOWED_EMAILS 설정 없이 실주문을 열 수 없습니다.";
  }
  return null;
}

export interface LiveTestState {
  error?: string;
  ok?: {
    action: "open" | "close" | "flat";
    side: "long" | "short";
    detail: string;
    algoClOrdId?: string;
  };
}

export async function placeLiveTestOrder(
  _prev: LiveTestState,
  formData: FormData,
): Promise<LiveTestState> {
  await requireUser(); // 로그인한 사용자의 명시적 클릭만 이 경로에 닿는다.

  const side = String(formData.get("side") ?? "");
  if (side !== "long" && side !== "short") return { error: "방향을 선택해 주세요." };
  // 2단계 확인 — 체크박스 없이 온 요청은 실행하지 않는다.
  if (formData.get("ack") !== "on") return { error: "실제 주문 확인에 체크해 주세요." };

  const blocked = deployGuard();
  if (blocked) return { error: blocked };

  try {
    const conf = await accountConfig();
    if (conf.posMode !== "long_short_mode") {
      return { error: `포지션 모드가 ${conf.posMode} — OKX에서 롱/숏 모드로 바꿔 주세요.` };
    }
    const [inst, px, eq] = await Promise.all([instrument(INST), lastPrice(INST), equityUsd()]);
    // NaN 은 부등호를 전부 통과한다(fail-open) — 숫자가 아니면 주문 자체를 거절한다.
    if (![eq, px, inst.minSz, inst.ctVal, inst.tickSz].every(Number.isFinite)) {
      return { error: "계좌·시세 응답이 온전하지 않습니다 — 잠시 후 다시 시도해 주세요." };
    }
    const notional = inst.minSz * inst.ctVal * px;
    const need = (notional / LEV) * 1.3 + 0.1;
    if (eq < need) {
      return { error: `잔고 $${eq.toFixed(2)} — 최소 $${need.toFixed(2)} 필요 (최소 수량 ≈ $${notional.toFixed(2)} 명목).` };
    }

    const dir = side === "long" ? 1 : -1;
    const stop = px * (1 - (dir * SL_PCT) / 100);
    const target = px * (1 + (dir * TP_PCT) / 100);
    if (!Number.isFinite(stop) || !Number.isFinite(target)) {
      return { error: "손절·목표 계산이 온전하지 않습니다 — 다시 시도해 주세요." };
    }
    const sz = inst.minSz.toFixed(inst.szDecimals);
    const algoClOrdId = `qb${Date.now()}`; // 버튼 발 주문 표식 — CLI(qt)·봇(qa)과 구분

    appendTestEvent("entry-try", { source: "app", side, refPx: px, stop: +stop.toFixed(1), target: +target.toFixed(1), sz });
    await setLeverage(INST, LEV, side);
    const t0 = Date.now();
    const ordId = await openWithBracket({
      instId: INST,
      posSide: side,
      sz,
      stop,
      target,
      algoClOrdId,
      tickSz: inst.tickSz,
      pxDecimals: inst.pxDecimals,
    });
    appendTestEvent("entry-ok", { source: "app", side, ordId, algoClOrdId, latencyMs: Date.now() - t0 });

    return {
      ok: {
        action: "open",
        side,
        algoClOrdId,
        detail: `주문 접수 (ordId ${ordId}) — ${sz}계약 ≈ $${notional.toFixed(2)}, 손절 ${stop.toFixed(1)} · 목표 ${target.toFixed(1)} 브래킷 부착됨`,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    appendTestEvent("entry-error", { source: "app", side, error: msg });
    return { error: `주문 실패: ${msg}` };
  }
}

export async function closeLiveTestPosition(
  _prev: LiveTestState,
  formData: FormData,
): Promise<LiveTestState> {
  await requireUser();

  const side = String(formData.get("side") ?? "");
  if (side !== "long" && side !== "short") return { error: "방향을 선택해 주세요." };
  // 우리가 만든 표식 형식만 통과 — 서명 요청 경로에 임의 문자열을 싣지 않는다.
  const rawAlgoId = String(formData.get("algoClOrdId") ?? "").trim();
  const algoClOrdId = /^[a-zA-Z0-9]{1,32}$/.test(rawAlgoId) ? rawAlgoId : "";

  const blocked = deployGuard();
  if (blocked) return { error: blocked };

  try {
    // 브래킷이 이미 걸렸으면(effective) 이중 청산하지 않는다 — 봇과 같은 규칙.
    let bracketNote = "";
    if (algoClOrdId) {
      const det = await algoDetails(algoClOrdId);
      if (det && "error" in det) {
        bracketNote = " (브래킷 상태 조회 실패 — 체결됐다면 거래소가 정리 주문을 거절한다)";
      } else if (det?.state === "effective") {
        const label = det.actualSide === "tp" ? "목표" : det.actualSide === "sl" ? "손절" : "브래킷";
        appendTestEvent("exit-bracket", { source: "app", exitType: det.actualSide ?? "algo", actualPx: det.actualPx ?? null });
        return { ok: { action: "flat", side, detail: `이미 ${label} 체결로 청산됨 (체결가 ${det.actualPx ?? "?"}) — 정리할 것 없음.` } };
      } else if (det?.algoId && (det.state === "live" || det.state === "pause")) {
        await cancelAlgo(INST, String(det.algoId));
      }
    }
    const [open, inst] = await Promise.all([positions(INST), instrument(INST)]);
    const mine = open.find((p) => p.posSide === side);
    if (!mine) {
      appendTestEvent("exit-assumed-flat", { source: "app", side });
      return { ok: { action: "flat", side, detail: "포지션 없음 — 브래킷 체결로 이미 청산된 것으로 보임." } };
    }
    // 테스트가 연 수량(최소 단위)만큼만 닫는다 — 같은 방향에 라이브 봇의 재고가
    // 합산돼 있어도 그쪽을 쓸어가지 않는다. 남으면 반복 클릭으로 정리.
    const szToClose = Math.min(mine.pos, inst.minSz);
    if (!Number.isFinite(szToClose) || szToClose <= 0) {
      return { error: "정리 수량 계산이 온전하지 않습니다 — 거래소 앱에서 확인해 주세요." };
    }
    await closeMarket(INST, side as "long" | "short", szToClose.toFixed(inst.szDecimals));
    appendTestEvent("exit-manual-close", { source: "app", side, sz: szToClose, avgPx: mine.avgPx });
    const remain = Math.round((mine.pos - szToClose) * 1e6) / 1e6;
    return {
      ok: {
        action: "close",
        side,
        detail: `${szToClose}계약 시장가 정리 완료 (평단 ${mine.avgPx}).${remain > 0 ? ` 남은 ${side === "long" ? "롱" : "숏"} ${remain}계약은 반복 클릭으로.` : ""}${bracketNote}`,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    appendTestEvent("exit-error", { source: "app", side, error: msg });
    return { error: `정리 실패: ${msg} — 거래소 앱에서 직접 확인해 주세요.` };
  }
}
