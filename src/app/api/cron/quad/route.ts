import { NextResponse } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";

// 봇의 판정·주문 배선을 그대로 부른다. 여기서 다시 구현하면 백테스트와의 동치성이
// 깨진다 — 이 저장소가 지키는 유일한 계약이 그것이다.
import { CONFIG as cfg } from "../../../../../system-trading/bot/config.mjs";
import { runCycle } from "../../../../../system-trading/bot/engine.mjs";
import { OkxClient } from "../../../../../system-trading/bot/okx.mjs";
import { loadState } from "../../../../../system-trading/bot/state-db.mjs";

/**
 * 쿼드 봇의 한 사이클 — 서버에서 돈다.
 *
 * 왜 옮겼나: 사이클은 4H 봉 마감마다 한 번인데, 실행기가 집 PC 의 작업 스케줄러라
 * PC 가 자는 동안 봉이 통째로 비었다(2026-08-18~20 나흘간 4봉). 놓친 봉의 신호는
 * "지나간 신호"로 기록만 되고 진입하지 않으므로, 그 시간만큼 전략이 꺼져 있던 셈이다.
 * 이 라우트는 항상 켜져 있는 곳에서 같은 코드를 돌린다. 호출은 n8n 스케줄이 한다.
 *
 * 봇 코드는 파일을 쓰지 않는다(상태·기록 모두 Supabase). 그래서 서버리스에서도
 * 그대로 돈다 — 옮긴 것은 실행 위치뿐이고 판정·사이징·주문 경로는 한 줄도 다르지 않다.
 *
 * 안전장치 셋:
 *   1) `Authorization: Bearer $CRON_SECRET` — 남이 사이클을 돌릴 수 없다.
 *   2) `system_state.live_enabled` — 실주문 킬스위치. 서버에서는 환경변수(LIVE_TRADING_ACK)가
 *      올리는 순간 상시 켜짐이 되어 잠금 구실을 못 하므로, 화면에서 끄고 켜는 이 칸이 게이트다.
 *   3) `system_state.locked_until` — 두 실행기가 겹쳐 같은 신호로 두 번 진입하는 것을 막는다.
 *      사이클이 죽어도 시각이 지나면 저절로 풀린다.
 *
 * 그리고 `OKX_EXPECTED_UID` 가 계좌를 못 박는다. 2026-08-19 에 환경변수 이름이 겹쳐
 * 주문이 엉뚱한 계정으로 갈 뻔했다 — 배포 환경은 그 사고가 조용히 되살아나기 가장 쉬운 곳이다.
 */

/** 봉 확정 지연 재시도까지 한 번은 기다린다(120초) — 그 여유를 함수 한도에 담는다. */
export const maxDuration = 300;

const MODES = ["paper", "demo", "live"] as const;
type Mode = (typeof MODES)[number];

/** 잠금 유지 — 사이클은 보통 수 초다. 넉넉히 잡되 다음 봉(4시간)보다는 훨씬 짧게. */
const LOCK_MS = 10 * 60_000;

/** 봉이 아직 확정되지 않았을 때 기다리는 시간 — 실행기(run.mjs)와 같은 값이다. */
const STALE_RETRY_MS = 120_000;

/**
 * 엔진이 돌려주는 사이클 요약.
 *
 * `equity`·`openPositions` 는 엔진이 객체 리터럴을 만든 뒤에 채워 넣어서 추론에 안 잡힌다 —
 * 교차 타입으로 그 둘만 얹는다(엔진 쪽 구조가 바뀌면 앞쪽 추론에서 먼저 깨진다).
 */
type CycleSummary = Awaited<ReturnType<typeof runCycle>> & {
  equity: number | null;
  openPositions: string[];
};

function bad(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return bad(401, { error: "인증이 필요합니다." });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("mode") ?? "paper";
  if (!(MODES as readonly string[]).includes(requested)) {
    return bad(400, { error: `알 수 없는 모드: ${requested} (paper | demo | live)` });
  }
  const mode = requested as Mode;
  // 주문 없이 배선만 확인한다 — 키·계좌·포지션 모드가 맞는지 보는 용도.
  const probe = url.searchParams.get("probe") === "1";

  const supabase = createServiceClient();
  const userId = process.env.SYSTEM_BOT_USER_ID;
  if (!supabase || !userId) {
    return bad(501, { error: "SUPABASE_SECRET_KEY · SYSTEM_BOT_USER_ID 가 없어 사이클을 돌릴 수 없습니다." });
  }

  const { data: row, error: readError } = await supabase
    .from("system_state")
    .select("live_enabled, locked_until")
    .eq("user_id", userId)
    .eq("mode", mode)
    .maybeSingle();
  if (readError) return bad(500, { error: `상태 조회 실패: ${readError.message}` });

  // 킬스위치 — 실계좌만. 페이퍼·데모는 실제 돈이 움직이지 않으므로 게이트가 없다.
  // probe 는 통과시킨다: 주문을 내지 않는 읽기 전용 점검이고, 스위치를 켜기 **전에**
  // 배선을 확인하는 것이 그 용도다 — 여기서 막으면 순서가 거꾸로 된다.
  if (mode === "live" && !row?.live_enabled && !probe) {
    return NextResponse.json({
      mode,
      skipped: "killswitch",
      detail: "실주문이 차단되어 있습니다(system_state.live_enabled = false). 시스템 화면에서 켜야 사이클이 돕니다.",
    });
  }

  // 잠금 — 행이 아직 없으면(첫 사이클) 겹칠 상대도 없고, probe 는 아무것도 바꾸지 않는다.
  let locked = false;
  if (row && !probe) {
    const now = new Date().toISOString();
    const { data: got, error: lockError } = await supabase
      .from("system_state")
      .update({ locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
      .eq("user_id", userId)
      .eq("mode", mode)
      .or(`locked_until.is.null,locked_until.lt."${now}"`)
      .select("mode");
    if (lockError) return bad(500, { error: `잠금 실패: ${lockError.message}` });
    if (!got?.length) {
      return NextResponse.json({
        mode,
        skipped: "locked",
        detail: `다른 사이클이 도는 중입니다(locked_until ${row.locked_until}). 이번 호출은 아무것도 하지 않았습니다.`,
      });
    }
    locked = true;
  }

  try {
    const client = new OkxClient(mode);

    // 계좌 사전 점검 — 롱숏 분리 모드가 아니면 모든 주문이 실패하고,
    // uid 가 다르면 남의 계좌에 주문이 나간다. 둘 다 주문 전에 막는다.
    let account: { uid?: string; mainUid?: string; posMode?: string } = {};
    if (mode !== "paper") {
      account = await client.accountConfig();
      if (account.posMode !== "long_short_mode") {
        return bad(409, {
          error: `계정 포지션 모드가 "${account.posMode}" 입니다 — 이 봇은 롱/숏 모드가 필요합니다.`,
        });
      }
      const expected = (process.env.OKX_EXPECTED_UID ?? "").trim();
      if (!expected) {
        return bad(409, {
          error: "OKX_EXPECTED_UID 가 없습니다 — 어느 계좌인지 못 박지 않은 채로는 주문을 내지 않습니다.",
        });
      }
      if (expected !== account.uid) {
        return bad(409, {
          error: `계좌가 다릅니다 — 기대한 uid ${expected}, 실제 uid ${account.uid}. 주문을 내지 않고 멈춥니다.`,
        });
      }
    }

    if (probe) {
      return NextResponse.json({
        mode,
        probe: true,
        uid: account.uid ?? null,
        mainUid: account.mainUid ?? null,
        posMode: account.posMode ?? null,
        equity: mode === "paper" ? null : await client.equityUsd(),
        liveEnabled: row?.live_enabled ?? false,
      });
    }

    const state = await loadState(mode, cfg.paperStartEquity);
    let summary = (await runCycle(client, state)) as CycleSummary;

    // 봉이 아직 확정되지 않았으면 한 번 더 본다 — 안 그러면 그 봉은 영영 평가되지 않는다.
    // 실행기는 두 번 재시도하지만 여기서는 한 번이다(함수 시간 한도). 그래도 놓치면
    // 다음 사이클이 "지나간 봉"으로 따라잡고, 응답의 stale 이 그 사실을 알린다.
    if (summary.stale?.length) {
      await new Promise((r) => setTimeout(r, STALE_RETRY_MS));
      summary = (await runCycle(client, state)) as CycleSummary;
    }

    return NextResponse.json({
      mode,
      at: new Date().toISOString(),
      uid: account.uid ?? null,
      equity: summary.equity,
      openPositions: summary.openPositions,
      // n8n 은 이 배열이 비어 있지 않을 때만 알린다 — 무사건 사이클까지 울리면 소음이 된다.
      actions: summary.actions,
      evaluated: summary.evaluated,
      stale: summary.stale,
    });
  } catch (cause) {
    // 실패는 숨기지 않는다 — 호출자(n8n)가 재시도·알림을 결정해야 한다.
    return bad(500, { mode, error: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    if (locked) {
      await supabase
        .from("system_state")
        .update({ locked_until: null })
        .eq("user_id", userId)
        .eq("mode", mode);
    }
  }
}
