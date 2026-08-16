"use server";

import { revalidatePath } from "next/cache";

import { switchBook } from "@/app/(app)/books/actions";
import type { PrincipleCategory } from "@/lib/domain";
import { equityUsd, hasLiveKeys } from "@/lib/okx-live";
import { requireUser, nextSeq } from "@/lib/queries";
import {
  SYSTEM_BOOK_NAMES,
  readSystemState,
  readSystemTrades,
  type SystemMode,
} from "@/lib/system-trading";

const EXIT_LABEL: Record<string, string> = {
  tp: "목표",
  sl: "손절",
  time: "시간",
  unknown: "미상",
  algo: "브래킷",
};

/** 기준별 판정 규칙 — 진입근거 문장의 뼈대. 정본은 system-trading/docs/criteria.md */
const MEMBER_RULE: Record<string, string> = {
  gc: "SMA20이 SMA50을 상향 돌파 마감 (4H·추세추종)",
  ob: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감 (4H·평균회귀)",
  fade: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감 (4H·평균회귀 숏)",
  dc: "종가가 직전 20봉 최저가 아래로 마감 (1D·추세추종 숏)",
};

/** 진입근거 — 규칙 + 판정 시점 지표를 한 문장으로. 복기 화면의 `근거` 칸에 들어간다. */
function buildRationale(t: {
  member: string;
  signal?: { rsi: number | null; atr: number | null; sma20: number | null; sma50: number | null; ll20: number | null } | undefined;
}): string {
  const rule = MEMBER_RULE[t.member] ?? "시스템 기준";
  const s = t.signal;
  if (!s) return `[자동] ${rule}`;
  const parts: string[] = [];
  if (s.rsi !== null) parts.push(`RSI ${s.rsi}`);
  if (s.atr !== null) parts.push(`ATR ${s.atr}`);
  if (t.member === "gc" && s.sma20 !== null && s.sma50 !== null) {
    parts.push(`SMA20 ${s.sma20} / SMA50 ${s.sma50}`);
  }
  if (t.member === "dc" && s.ll20 !== null) parts.push(`20봉최저 ${s.ll20}`);
  return `[자동] ${rule}${parts.length ? ` — 신호봉 ${parts.join(" · ")}` : ""}`;
}

export interface SystemSyncState {
  error?: string;
  message?: string;
}

const MODE_LABEL: Record<SystemMode, string> = { paper: "페이퍼", demo: "데모", live: "라이브" };

/**
 * 시스템 북 생성 시 심는 매매 원칙 — 기준의 정본은 system-trading/docs/criteria.md 이고,
 * 여기 심는 이유는 거래마다 원칙 체크리스트가 붙어 "기준대로 했는가"를 복기할 수 있게다.
 */
const SYSTEM_PRINCIPLES: { category: PrincipleCategory; title: string; detail: string }[] = [
  { category: "risk", title: "거래당 손실 상한 10% — 레버리지는 min(10, 10÷(손절폭%+0.1))로 역산", detail: "승격 사다리(2→5→10%)의 최종 단계. 소액 검증 구간은 최소 수량 제약으로 10%에서 시작 (사용자 지시, 2026-08-16)." },
  { category: "risk", title: "동시 포지션 최대 2개 · 열린 리스크 합 20% 상한", detail: "백테스트 실측 동시 최대가 2개였다 — 그 이상은 검증 밖." },
  { category: "risk", title: "격리 마진 고정 — 청산 파급을 포지션 안에 가둔다", detail: "한 포지션의 최대 손실은 그 포지션 증거금까지." },
  { category: "entry", title: "골든크로스 (4H 롱): SMA20이 SMA50을 상향 돌파 마감", detail: "청산 손절 1×ATR / 목표 3×ATR. 백테스트 여유분(실측 승률−손익분기) +12.0%p — 시리즈 최상위." },
  { category: "entry", title: "RSI 과매도 반등 (4H 롱): RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감", detail: "청산 손절 1×ATR / 목표 3×ATR. 백테스트 여유분 +8.9%p." },
  { category: "entry", title: "RSI 과매수 반락 (4H 숏): RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감", detail: "청산 손절 2×ATR / 목표 4×ATR. 백테스트 여유분 +3.1%p." },
  { category: "entry", title: "20봉 신저가 이탈 (1D 숏): 종가가 직전 20봉 최저가 아래로 마감", detail: "청산 손절 2% / 목표 4%. 백테스트 여유분 +5.0%p." },
  { category: "exit", title: "브래킷 자동 청산 — 진입과 동시에 손절·목표가 거래소에 걸린다", detail: "봇이 꺼져 있어도 거래소가 집행한다. 수동 개입은 청산이 아니라 점검." },
  { category: "exit", title: "보유 시한 초과 시 시장가 정리 — 4H 60봉(10일) / 1D 20봉", detail: "백테스트와 같은 시한. 시한 청산도 엣지의 일부다." },
  { category: "routine", title: "하루 1회 라이브 로그·경고 점검", detail: "'보호 없음'·'미추적 포지션' 경고는 자동 복구가 없다 — 발견 즉시 수동 처리." },
];

/** 한 모드의 완결 거래를 그 모드의 북으로 가져온다. 반환은 사람이 읽는 한 줄. */
async function syncMode(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  user: Awaited<ReturnType<typeof requireUser>>["user"],
  mode: SystemMode,
): Promise<{ error?: string; message?: string }> {
  const state = readSystemState(mode);
  if (!state) return {};
  const closed = readSystemTrades(mode).sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);

  // 1) 북 확보.
  const bookName = SYSTEM_BOOK_NAMES[mode];
  const { data: found, error: findError } = await supabase
    .from("books")
    .select("id")
    .eq("name", bookName)
    .maybeSingle();
  if (findError) return { error: findError.message };

  let bookId = found?.id ?? null;
  if (!bookId) {
    // 시작 자본 — 페이퍼는 가상 $100, 라이브는 실계좌 잔고가 정본이다.
    let initialCapital: number | null = mode === "paper" ? 100 : null;
    if (initialCapital === null && hasLiveKeys()) {
      try {
        initialCapital = Math.round((await equityUsd()) * 100) / 100;
      } catch {
        initialCapital = null;
      }
    }
    if (initialCapital === null) initialCapital = closed[0]?.eqAtEntry ?? null;
    if (initialCapital === null) {
      return { error: "시작 자본을 정할 수 없습니다 — 거래소 잔고 조회가 막혀 있습니다." };
    }
    const startDate = new Date(state.createdAt + 9 * 3600_000).toISOString().slice(0, 10);
    const { data: created, error: createError } = await supabase
      .from("books")
      .insert({
        user_id: user.id,
        name: bookName,
        exchange: "OKX·시스템",
        base_currency: "USDT",
        initial_capital: initialCapital,
        start_date: startDate,
        memo: `쿼드 공격형 자동매매 (${MODE_LABEL[mode]}) — system-trading/data 가 진실 원천, 이 북은 가져온 사본. 기준 정본: system-trading/docs/criteria.md`,
      })
      .select("id")
      .single();
    if (createError) return { error: createError.message };
    bookId = created.id;
    // 기준을 원칙으로 심는다 — 거래마다 체크리스트로 붙어 복기의 잣대가 된다.
    const { error: seedError } = await supabase.from("principles").insert(
      SYSTEM_PRINCIPLES.map((p, i) => ({
        book_id: created.id,
        user_id: user.id,
        category: p.category,
        title: p.title,
        detail: p.detail,
        sort_order: i,
      })),
    );
    if (seedError) return { error: `원칙 심기 실패: ${seedError.message}` };
    await switchBook(bookId);
  }

  if (closed.length === 0) {
    return { message: "북 준비됨 — 완결 거래 대기 중" };
  }

  // 2) 이미 가져온 거래 걸러내기 — note 의 [sys:거래ID] 표식.
  const { data: existing, error: noteError } = await supabase
    .from("trades")
    .select("note")
    .eq("book_id", bookId)
    .not("note", "is", null);
  if (noteError) return { error: noteError.message };
  const imported = new Set(
    (existing ?? [])
      .map((r) => /\[sys:([^\]]+)\]/.exec(r.note ?? "")?.[1])
      .filter((v): v is string => Boolean(v)),
  );

  const fresh = closed.filter((t) => !imported.has(t.tradeId));
  if (fresh.length === 0) {
    return { message: `새 거래 없음 (누적 ${imported.size}건)` };
  }

  // 3) 붙이기 — 잔고 체계는 봇 회계 그대로: 손익은 진입 시점 잔고 기준.
  let seq = await nextSeq(bookId);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const t of fresh) {
    const eqAtEntry = t.eqAtEntry ?? null;
    const pnlUsd = t.pnlUsd ?? (eqAtEntry !== null ? r2((eqAtEntry * t.netPct) / 100) : null);
    // 왕복 0.1% × 레버리지가 순손익에 이미 빠져 있다 — 앱의 비용 칸에 맞춰 되살린다.
    const feeUsd = eqAtEntry !== null ? r2((eqAtEntry * 0.1 * t.lev) / 100) : null;
    const { error } = await supabase.from("trades").insert({
      book_id: bookId,
      user_id: user.id,
      seq,
      side: t.side,
      symbol: "BTC",
      entry_at: new Date(t.entryTs).toISOString(),
      exit_at: new Date(t.exitTs).toISOString(),
      result: pnlUsd === null || pnlUsd === 0 ? "be" : pnlUsd > 0 ? "win" : "loss",
      equity_before: eqAtEntry,
      equity_after: t.equityAfter ?? null,
      pnl: pnlUsd !== null && feeUsd !== null ? r2(pnlUsd + feeUsd) : null,
      fee: feeUsd !== null ? -feeUsd : null,
      realized_pnl: pnlUsd,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      // 손절·목표는 진입 주문에 함께 걸렸던 값 — 차트가 기준선으로 그린다.
      stop_price: t.stop ?? null,
      tp1_price: t.target ?? null,
      notional: eqAtEntry !== null ? r2(eqAtEntry * t.lev) : null,
      leverage: r2(t.lev),
      margin_mode: "isolated" as const,
      setup: t.name,
      rationale: buildRationale(t),
      note: `[sys:${t.tradeId}] ${EXIT_LABEL[t.exitType] ?? t.exitType} 청산 · 자동 기록`,
    });
    if (error) return { error: `${seq}번째 거래에서 실패: ${error.message}` };
    seq += 1;
  }

  return { message: `${fresh.length}건 가져옴 (누적 ${imported.size + fresh.length}건)` };
}

/**
 * 봇의 완결 거래를 시스템 북으로 가져온다 — 데이터가 있는 모든 모드를 한 번에.
 *
 * 진실 원천은 `system-trading/data/` 파일이고, 여기서는 아직 없는 거래만 붙인다 —
 * 중복 판정은 note 에 심은 `[sys:거래ID]` 표식으로 한다. 모드마다 북을 나누고,
 * 북을 처음 만든 그 순간에만 활성 북을 그쪽으로 돌린다(이후 동기화는 보던 북을 존중).
 */
export async function syncSystemBook(): Promise<SystemSyncState> {
  const { supabase, user } = await requireUser();

  const parts: string[] = [];
  for (const mode of ["paper", "live"] as const) {
    const res = await syncMode(supabase, user, mode);
    if (res.error) return { error: `[${MODE_LABEL[mode]}] ${res.error}` };
    if (res.message) parts.push(`${MODE_LABEL[mode]}: ${res.message}`);
  }
  if (parts.length === 0) {
    return { error: "봇 데이터가 없습니다 — 루프가 한 번은 돌아야 합니다." };
  }
  revalidatePath("/", "layout");
  return { message: parts.join(" · ") };
}
