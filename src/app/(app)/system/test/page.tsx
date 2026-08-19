import Link from "next/link";

import { LiveTestPanel } from "@/app/(app)/system/live-test-panel";
import {
  LIVE_TEST_LEV,
  accountId,
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

/**
 * 패널에 넘길 계좌 상태 — 키가 없거나 조회가 막히면 그 사실만 전한다.
 *
 * uid 를 함께 읽는 것은 2026-08-19 사고 때문이다. 이 화면과 봇이 같은 이름의
 * 환경변수를 읽던 시절, 배포된 버튼은 봇 서브계정이 아니라 주 매매계정을 향했고
 * 화면 어디에도 그 사실이 없었다. 주문이 나갈 계좌는 숫자로 보여야 한다.
 */
async function readLiveStatus() {
  if (!hasLiveKeys()) return null;
  try {
    const [eq, px, inst, open, id] = await Promise.all([
      equityUsd(),
      lastPrice("BTC-USDT-SWAP"),
      instrument("BTC-USDT-SWAP"),
      positions("BTC-USDT-SWAP"),
      accountId(),
    ]);
    const minNotional = inst.minSz * inst.ctVal * px;
    return {
      equity: eq,
      price: px,
      minNotional,
      needBalance: (minNotional / LIVE_TEST_LEV) * 1.3 + 0.1,
      openPositions: open,
      statusError: null as string | null,
      account: id,
    };
  } catch (e) {
    return {
      equity: null,
      price: null,
      minNotional: null,
      needBalance: null,
      openPositions: [],
      statusError: e instanceof Error ? e.message : "계좌 조회 실패",
      account: null,
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
        <>
          <section className="rounded-xl border border-beta/40 bg-surface p-4">
            <h2 className="text-sm font-medium">주문이 나갈 계좌</h2>
            {liveStatus.account ? (
              <p className="tnum mt-1 text-[13px]">
                uid <b>{liveStatus.account.uid}</b>
                {liveStatus.account.mainUid && liveStatus.account.mainUid !== liveStatus.account.uid ? (
                  <span className="text-dim"> · 서브계정 (메인 {liveStatus.account.mainUid})</span>
                ) : (
                  <span className="text-dim"> · 메인 계정</span>
                )}
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-dim">계좌를 확인하지 못했습니다.</p>
            )}
            <p className="mt-2 text-[11.5px] text-dim">
              봇이 매매하는 계좌와 같아야 합니다 — 배선 검증의 뜻이 “봇에게 맡기기 전에 같은 길을
              사람이 먼저 태워 본다”이기 때문입니다. 다르면{" "}
              <code className="rounded bg-surface-2 px-1">OKX_LIVE_API_KEY</code> 계열 환경변수가
              어느 계정 것인지 확인해 주세요.
            </p>
          </section>

          {/* 계좌 정보는 위 카드가 쓰고 패널에는 넘기지 않는다 — 패널은 주문만 안다. */}
          <LiveTestPanel
            equity={liveStatus.equity}
            price={liveStatus.price}
            minNotional={liveStatus.minNotional}
            needBalance={liveStatus.needBalance}
            openPositions={liveStatus.openPositions}
            statusError={liveStatus.statusError}
          />
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          실주문 키(<code className="rounded bg-surface-2 px-1">OKX_LIVE_API_KEY</code> ·
          <code className="rounded bg-surface-2 px-1">OKX_LIVE_API_SECRET</code> ·
          <code className="rounded bg-surface-2 px-1">OKX_LIVE_API_PASSPHRASE</code>)가 설정돼 있지
          않습니다 — 이 화면은 키가 있을 때만 동작합니다.
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
