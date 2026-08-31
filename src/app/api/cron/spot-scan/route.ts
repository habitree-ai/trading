import { NextResponse } from "next/server";

import { rsi } from "@/lib/indicators";
import { sendDiscordFallback, sendKakaoToMe } from "@/lib/kakao";
import { CRASH_RULE, STABLE_SYMBOLS, evaluateCrash, medianDailyTurnover } from "@/lib/spot-signals";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchDayCandles, fetchKrwMarkets, fetchMinuteCandles, pacedMap } from "@/lib/upbit";
import type { Database } from "@/lib/supabase/database.types";

/**
 * 현물신호 스캔 — 매시 1H 봉 마감 후 n8n 이 호출한다 (REQ-0023).
 *
 * 업비트 KRW 전 종목(유의·주의·스테이블 제외)의 방금 확정된 1H 봉을 채택 규칙
 * (crash × T1 — 게이트 2026-08-31)으로 판정하고, 새 신호만 저장·카톡 발송한다.
 * 판정 산식은 백테스트(scripts/backtest/spot-signal2.mjs)와 동치여야 하며,
 * 그 정본은 src/lib/spot-signals.ts 한 곳이다.
 *
 * 쿼드 사이클과 같은 관례: CRON_SECRET 인증 · ?probe=1 은 저장·발송 없는 드라이런 ·
 * 실패는 500 으로 드러내고 알림 판단은 호출자(n8n)에 넘긴다. 매 실행을
 * spot_scan_runs 에 남긴다 — "마지막 스캔이 언제였나"가 화면의 건강 판이다.
 */

export const maxDuration = 300;

const H1 = 3600_000;
const DAY = 86_400_000;
/** 판정에 필요한 봉 수 — 72봉 낙폭 + volMA20 + 여유. */
const BARS_1H = 96;

interface Hit {
  market: string;
  drop72Pct: number;
  volumeMult: number;
  price: number;
  turnoverMed30: number;
  rsi: number | null;
}

function bad(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

/** 알람 링크 — 프로덕션은 Vercel SSO 보호가 걸려 있어 우회 쿠키 파라미터를 붙인다. */
function buildLink(): string {
  const base = process.env.SPOT_APP_URL ?? "https://trading-habitree-ai.vercel.app";
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const path = `${base}/system/spot`;
  if (!bypass) return path;
  return `${path}?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`;
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return bad(401, { error: "인증이 필요합니다." });
  }
  const probe = new URL(request.url).searchParams.get("probe") === "1";

  const supabase = createServiceClient();
  const userId = process.env.SYSTEM_BOT_USER_ID;
  if (!supabase || !userId) {
    return bad(501, { error: "SUPABASE_SECRET_KEY · SYSTEM_BOT_USER_ID 가 없어 스캔할 수 없습니다." });
  }

  const started = Date.now();
  const currentBarStart = Math.floor(started / H1) * H1;
  const targetBar = currentBarStart - H1; // 방금 확정된 봉
  const targetBarIso = new Date(targetBar).toISOString();

  let scanned = 0;
  let hits: Hit[] = [];
  let insertedCount = 0;
  let notifyStatus: string = "none";
  let scanError: string | null = null;

  try {
    // 1) 유니버스 — 현재 플래그로 거른다(과거 백테스트와 달리 실시간은 지금 상태가 기준이다).
    const markets = (await fetchKrwMarkets()).filter(
      (m) => !m.warning && m.caution.length === 0 && !STABLE_SYMBOLS.has(m.market.slice(4)),
    );

    // 2) 쿨다운 — 같은 종목의 24봉 내 재발화는 백테스트와 동일하게 억제한다.
    const { data: recent, error: recentError } = await supabase
      .from("spot_signals")
      .select("market")
      .eq("user_id", userId)
      .eq("signal", "crash")
      .gt("bar_ts", new Date(targetBar - CRASH_RULE.cooldownBars * H1).toISOString());
    if (recentError) throw new Error(`쿨다운 조회 실패: ${recentError.message}`);
    const cooling = new Set((recent ?? []).map((r) => r.market));

    // 3) 종목별 판정 — 1H 는 전 종목, 1D(유동성)는 발화한 종목만 (시간·요청 절약).
    const results = await pacedMap(markets, async (m): Promise<Hit | null> => {
      if (cooling.has(m.market)) return null;
      const bars = await fetchMinuteCandles(m.market, 60, BARS_1H, currentBarStart);
      const last = bars[bars.length - 1];
      // 그 시간대 체결이 없거나 아직 집계 전이면 봉이 없다 — 판정 불가로 조용히 넘긴다.
      if (!last || last.t !== targetBar) return null;
      const crash = evaluateCrash(bars);
      if (!crash) return null;

      const days = (await fetchDayCandles(m.market, 31)).filter(
        (d) => d.t < Math.floor(started / DAY) * DAY, // 진행 중인 오늘 봉 제외
      );
      const med = medianDailyTurnover(days);
      if (med === null || med < CRASH_RULE.minTurnoverKrw) return null;

      const closes = bars.map((b) => b.c);
      const lastRsi = rsi(closes)[closes.length - 1];
      return { market: m.market, ...crash, turnoverMed30: Math.round(med), rsi: lastRsi };
    });

    scanned = markets.length;
    hits = results.filter((r): r is Hit => r !== null);

    if (!probe && hits.length > 0) {
      // 4) 저장 — unique(user_id, market, signal, bar_ts)가 재스캔 중복을 막는다.
      const rows: Database["public"]["Tables"]["spot_signals"]["Insert"][] = hits.map((h) => ({
        user_id: userId,
        market: h.market,
        signal: "crash",
        bar_ts: targetBarIso,
        price: h.price,
        drop72_pct: h.drop72Pct,
        volume_mult: h.volumeMult,
        turnover_med30: h.turnoverMed30,
        indicators: { rsi: h.rsi },
      }));
      const { data: inserted, error: insertError } = await supabase
        .from("spot_signals")
        .upsert(rows, { onConflict: "user_id,market,signal,bar_ts", ignoreDuplicates: true })
        .select("id, market");
      if (insertError) throw new Error(`신호 저장 실패: ${insertError.message}`);
      insertedCount = inserted?.length ?? 0;

      // 5) 발송 — 새로 저장된 신호가 있을 때만, 스캔당 묶음 1건.
      if (insertedCount > 0) {
        const lines = hits
          .filter((h) => inserted?.some((r) => r.market === h.market))
          .map((h) => `${h.market.slice(4)} ${h.drop72Pct.toFixed(1)}% · 량 ${h.volumeMult.toFixed(1)}배`);
        const text = `[현물신호 ${insertedCount}건 · 급락 반전]\n${lines.slice(0, 8).join("\n")}${
          lines.length > 8 ? `\n… 외 ${lines.length - 8}건` : ""
        }`;
        const sent = await sendKakaoToMe(supabase, userId, text, buildLink());
        if (sent.ok) {
          notifyStatus = "sent";
          const ids = (inserted ?? []).map((r) => r.id);
          await supabase
            .from("spot_signals")
            .update({ notified_at: new Date().toISOString() })
            .in("id", ids);
        } else {
          const backedUp = await sendDiscordFallback(`⚠ 카톡 발송 실패(${sent.detail})\n${text}`);
          notifyStatus = `failed:${sent.detail}${backedUp ? " (discord 백업됨)" : ""}`;
        }
      }
    }

    return NextResponse.json({
      at: new Date().toISOString(),
      barTs: targetBarIso,
      probe,
      scanned,
      cooling: cooling.size,
      signals: hits,
      inserted: insertedCount,
      notify: notifyStatus,
    });
  } catch (cause) {
    scanError = cause instanceof Error ? cause.message : String(cause);
    return bad(500, { error: scanError, barTs: targetBarIso });
  } finally {
    // 실패했어도 실행 기록은 남긴다 — 기록이 없으면 "스캔이 죽었다"를 아무도 모른다.
    if (!probe) {
      await supabase.from("spot_scan_runs").insert({
        user_id: userId,
        bar_ts: targetBarIso,
        markets_scanned: scanned,
        signals_found: insertedCount,
        duration_ms: Date.now() - started,
        error: scanError,
        notify_status: notifyStatus,
      });
    }
  }
}
