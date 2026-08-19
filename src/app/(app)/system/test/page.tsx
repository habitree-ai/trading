import Link from "next/link";

import { LiveTestPanel } from "@/app/(app)/system/live-test-panel";
import {
  LIVE_TEST_LEV,
  equityUsd,
  hasLiveKeys,
  instrument,
  lastPrice,
  positions,
} from "@/lib/okx-live";

/**
 * 실주문 배선 검증 — 최소 수량으로 왕복을 태워 주문 경로가 살아 있는지 확인한다.
 *
 * 수동 거래 목록에 붙어 있던 자리를 여기로 옮겼다. 이 버튼이 하는 일은 기록이 아니라
 * 주문이고, 배선은 시스템 봇과 같다(시장가 + 손절·목표 브래킷 원자 부착, 격리 10배).
 * 승격 사다리에서 "봇에게 실주문을 맡기기 전에 사람이 먼저 태워 보는" 단계다.
 */

/** 패널에 넘길 계좌 상태 — 키가 없거나 조회가 막히면 그 사실만 전한다. */
async function readLiveStatus() {
  if (!hasLiveKeys()) return null;
  try {
    const [eq, px, inst, open] = await Promise.all([
      equityUsd(),
      lastPrice("BTC-USDT-SWAP"),
      instrument("BTC-USDT-SWAP"),
      positions("BTC-USDT-SWAP"),
    ]);
    const minNotional = inst.minSz * inst.ctVal * px;
    return {
      equity: eq,
      price: px,
      minNotional,
      needBalance: (minNotional / LIVE_TEST_LEV) * 1.3 + 0.1,
      openPositions: open,
      statusError: null as string | null,
    };
  } catch (e) {
    return {
      equity: null,
      price: null,
      minNotional: null,
      needBalance: null,
      openPositions: [],
      statusError: e instanceof Error ? e.message : "계좌 조회 실패",
    };
  }
}

export default async function SystemTestPage() {
  const liveStatus = await readLiveStatus();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">실주문 배선 검증</h1>
        <p className="mt-1 text-sm text-dim">
          최소 수량(0.01계약)으로 진입·청산을 한 바퀴 돌려 주문 경로를 확인합니다. 목적은 왕복이지
          손익이 아닙니다 — 사이징을 잔고에 걸지 않습니다.
        </p>
      </header>

      {liveStatus ? (
        <LiveTestPanel {...liveStatus} />
      ) : (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          거래소 키가 설정돼 있지 않습니다 — 이 화면은 키가 있을 때만 동작합니다.
        </p>
      )}

      <p className="text-[11px] text-dim">
        여기서 검증된 경로가 라이브 봇 제어(진입·수동 정리)의 공용 통로입니다. 기준과 운영 규칙은{" "}
        <Link href="/system/criteria" className="text-alpha">
          매매 기준
        </Link>
        에, 봇이 실제로 낸 주문은{" "}
        <Link href="/system/trades" className="text-alpha">
          자동 거래
        </Link>
        에 있습니다.
      </p>
    </div>
  );
}
