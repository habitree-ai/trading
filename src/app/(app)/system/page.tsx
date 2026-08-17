import Link from "next/link";

import { signed, dateTime } from "@/lib/format";
import { listBooks, listTrades } from "@/lib/queries";
import {
  SYSTEM_BOOK_NAMES,
  readSystemState,
  readSystemTrades,
  type SystemMode,
} from "@/lib/system-trading";

/**
 * 시스템 트레이딩 페이지 — 매매 기준과 자동화 체계의 정본을 화면으로.
 *
 * 기준 수치의 정본은 system-trading/docs/criteria.md 이고 이 페이지는 그 사본이다 —
 * 어긋나면 문서가 옳다. 봇 실시간 상태는 봇이 도는 머신에서만 보이고(파일 읽기),
 * 배포 환경에서는 DB로 동기화된 시스템 북 데이터만 보인다.
 */

const COMMON_RULES: { label: string; rule: string }[] = [
  { label: "판정 시점", rule: "봉이 마감된 뒤에만 판정 (OKX confirm=1 캔들) — 미확정 봉의 신호는 신호가 아니다" },
  { label: "진입", rule: "신호 봉 마감 직후 시장가 — 백테스트의 “다음 봉 시가”와 같은 자리" },
  { label: "사이징", rule: "레버리지 L = min(10, 리스크% ÷ (손절폭% + 0.1%)) · 명목가 = 진입 시점 잔고 × L" },
  { label: "리스크", rule: "거래당 손실 상한 = 리스크% (수수료 포함) · 쿼드 공격형 = 10%" },
  { label: "동시 상한", rule: "열린 포지션 리스크 합 > 20% 면 새 신호 건너뜀 (백테스트 실측 동시 최대 2개)" },
  { label: "중복 진입", rule: "한 기준 한 포지션 — 청산 봉 마감의 신호는 다음 봉 진입으로 유효" },
  { label: "마진", rule: "격리(isolated) — 청산 리스크를 포지션 안에 가둔다" },
];

const CRITERIA = [
  {
    key: "gc",
    name: "① 골든크로스",
    meta: "4시간봉 · 롱 · 추세추종",
    rule: "SMA20[i-1] ≤ SMA50[i-1]  AND  SMA20[i] > SMA50[i]",
    ruleDesc: "두 이동평균이 이번 봉에서 교차 마감했는가 — 판정 조건 1개.",
    exit: "손절 E − 1×ATR · 목표 E + 3×ATR (손익비 1:3) · 시한 60봉(10일)",
    stats: "45건 · 승률 37.8% · 기대값 +0.67%/건 · P/F 1.75 · 최대연패 10 · 평균보유 1.6일",
    edge: "+12.0%p",
    fail: "횡보장에서 교차가 반복되며 연속 손절 — 손익비 1:3이라 승률 37%로도 남지만 연패 구간을 견딜 리스크 관리가 전제.",
  },
  {
    key: "ob",
    name: "② RSI 과매도 반등",
    meta: "4시간봉 · 롱 · 평균회귀",
    rule: "RSI[i-1] < 30  AND  RSI[i] ≥ 30",
    ruleDesc: "30선 아래로 갔다가 위로 복귀 마감한 순간 — 내려가는 중(떨어지는 칼)에는 잡지 않는다.",
    exit: "손절 E − 1×ATR · 목표 E + 3×ATR (1:3) · 시한 60봉(10일)",
    stats: "55건 · 승률 36.4% · 기대값 +0.58%/건 · P/F 1.51 · 3구간(상승·하락·급락) 모두 플러스 — 유일",
    edge: "+8.9%p",
    fail: "강한 하락 추세에서 30 복귀가 데드캣 바운스로 끝남. 좁은 손절(1×ATR)+넓은 목표(3×ATR) 조합에서만 사는 신호 — 청산 폭을 바꾸면 다른 전략이다.",
  },
  {
    key: "fade",
    name: "③ RSI 과매수 반락",
    meta: "4시간봉 · 숏 · 평균회귀",
    rule: "RSI[i-1] > 70  AND  RSI[i] ≤ 70",
    ruleDesc: "70선 위로 갔다가 아래로 복귀 마감한 순간 — 과열의 꺾임을 파는 숏.",
    exit: "손절 E + 2×ATR · 목표 E − 4×ATR (1:2) · 시한 60봉(10일)",
    stats: "51건 · 승률 39.2% · 기대값 +0.23%/건 · P/F 1.14 · 최대연패 5 · 평균보유 3.0일",
    edge: "+3.1%p",
    fail: "여유분이 4개 중 가장 얇다 — 비용 가정이 어긋나면 가장 먼저 잠식. 전방 검증 최우선 관찰 대상.",
  },
  {
    key: "dc",
    name: "④ 20봉 신저가 이탈",
    meta: "일봉 · 숏 · 추세추종",
    rule: "종가[i] < min(저가[i-20 .. i-1])",
    ruleDesc: "종가가 직전 20일 최저가 아래로 마감 — 돈치안 채널 하단 이탈.",
    exit: "손절 E×1.02 · 목표 E×0.96 (고정 2%/4%, 1:2) · 시한 20봉(20일)",
    stats: "20건 · 승률 40% · 기대값 +0.30%/건 · P/F 1.24 · 최대연패 6 · 평균보유 1.75일",
    edge: "+5.0%p",
    fail: "표본이 가장 얇다(20건). 바닥 이탈 직후 V자 반등(베어트랩)이 실패 모드 — 트레일 청산 전환이 고도화 1순위 후보.",
  },
];

const OPERATIONS: { label: string; desc: string }[] = [
  { label: "판정 주기", desc: "4H 봉 마감 +90초 — KST 01·05·09·13·17·21시. 1D 기준은 새 마감 봉 감지로 같은 사이클에서 처리" },
  { label: "주문 방식", desc: "시장가 진입에 손절·목표 브래킷을 한 요청으로 원자 부착 — 무보호 창이 없고, 봇이 꺼져도 거래소가 집행" },
  { label: "청산 경로", desc: "① 목표/손절 브래킷(거래소 자율) ② 보유 시한 초과 시 시장가 정리 ③ 수동 정리(버튼)" },
  { label: "알림", desc: "진입·청산·경고·사이클 실패가 디스코드 #시스템-트레이딩 채널로 발송 (무사건 사이클은 조용)" },
  { label: "기록", desc: "모든 판정·주문·청산이 Supabase(진실 원천)에 남는다 — 봇이 어느 머신에서 돌든 이 화면에서 보인다. 동기화로 모드별 시스템 북에 사본이 쌓인다" },
  { label: "승격 사다리", desc: "페이퍼 → 데모 → 라이브 2% → 5% → 10%. 파라미터를 바꾸면 검증 시계를 리셋한다" },
];

const QUAD_SUMMARY: { label: string; value: string }[] = [
  { label: "최종 (백테스트 720일, $100 시작)", value: "$996 (+896%) — 리스크 5%면 $511" },
  { label: "최대낙폭", value: "−72.3% — 리스크 5%면 −46.4%" },
  { label: "거래", value: "171건 · 월 7.5건 · 승률 38.0%" },
  { label: "동시 포지션", value: "최대 2개 (리스크 합 20% 상한)" },
  { label: "벤치마크", value: "같은 기간 BTC 보유 = $96" },
];

/** 모드별 시스템 북의 요약 — DB 사본 기준(배포에서도 보인다). */
interface BookSummary {
  mode: SystemMode;
  bookName: string;
  exists: boolean;
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  lastExitAt: string | null;
}

/** 봇 파일 상태 — 봇이 도는 머신에서만 값이 있다. */
interface BotStatus {
  mode: SystemMode;
  equity: number | null;
  openPositions: string[];
  lastEvalAt: number | null;
  closedCount: number;
}

export default async function SystemPage() {
  const books = await listBooks();
  const summaries: BookSummary[] = [];
  for (const mode of ["paper", "live"] as const) {
    const book = books.find((b) => b.name === SYSTEM_BOOK_NAMES[mode]) ?? null;
    if (!book) {
      summaries.push({ mode, bookName: SYSTEM_BOOK_NAMES[mode], exists: false, count: 0, wins: 0, losses: 0, netPnl: 0, lastExitAt: null });
      continue;
    }
    const trades = await listTrades(book.id);
    summaries.push({
      mode,
      bookName: book.name,
      exists: true,
      count: trades.length,
      wins: trades.filter((t) => t.result === "win").length,
      losses: trades.filter((t) => t.result === "loss").length,
      netPnl: trades.reduce((s, t) => s + (t.realized_pnl ?? t.pnl ?? 0), 0),
      lastExitAt: trades.at(-1)?.exit_at ?? null,
    });
  }

  // 봇 실시간 상태 — 봇이 Supabase 에 남긴 것을 읽는다. 어느 기기에서 보든 같다.
  const bots: BotStatus[] = [];
  for (const mode of ["paper", "live"] as const) {
    const st = await readSystemState(mode);
    if (!st) continue;
    bots.push({
      mode,
      equity: st.equity,
      openPositions: Object.values(st.positions).map((p) => `${p.name} ${p.side === "long" ? "롱" : "숏"}`),
      lastEvalAt: Math.max(0, ...Object.values(st.lastBarTs)) || null,
      closedCount: (await readSystemTrades(mode)).length,
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">시스템 트레이딩 — 쿼드 공격형</h1>
        <p className="mt-1 text-sm text-dim">
          BTC-USDT-SWAP · 검증된 4개 기준의 병행 자동매매 · 기준 정본은{" "}
          <code className="rounded bg-surface-2 px-1">system-trading/docs/criteria.md</code>
        </p>
      </header>

      {/* ── 지금 상태 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">지금 상태</h2>
        {bots.length > 0 ? (
          <div className="mt-2 space-y-1">
            {bots.map((b) => (
              <p key={b.mode} className="tnum text-[12px] text-dim">
                <span className={`mr-1.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${b.mode === "live" ? "border-loss text-loss" : "border-accent text-accent"}`}>
                  {b.mode}
                </span>
                {b.equity !== null ? <>봇 잔고 <b className="text-text">${b.equity}</b> · </> : null}
                포지션 <b className="text-text">{b.openPositions.length ? b.openPositions.join(", ") : "없음"}</b>
                {" · "}완결 <b className="text-text">{b.closedCount}건</b>
                {b.lastEvalAt !== null
                  ? ` · 마지막 평가 ${new Date(b.lastEvalAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-dim">
            아직 봇이 한 사이클도 돌지 않았습니다 — 첫 사이클이 끝나면 여기에 잔고와 포지션이 나옵니다.
          </p>
        )}

        <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          {summaries.map((s) => (
            <div key={s.mode} className="rounded-lg border border-border p-3">
              <div className="text-[11px] text-dim">{s.bookName}</div>
              {s.exists ? (
                <p className="tnum mt-1 text-sm">
                  <b>{s.count}건</b> · {s.wins}승 {s.losses}패 ·{" "}
                  <b className={s.netPnl > 0 ? "text-profit" : s.netPnl < 0 ? "text-loss" : ""}>{signed(s.netPnl, 2)}</b>
                  {s.lastExitAt ? <span className="text-dim"> · 마지막 청산 {dateTime(s.lastExitAt)}</span> : null}
                </p>
              ) : (
                <p className="mt-1 text-sm text-dim">북 미생성 — 첫 동기화 때 만들어집니다</p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-dim">
          거래 내역·차트는 상단 북 선택에서 시스템 북으로 바꾼 뒤 <Link href="/trades" className="text-accent">거래 목록</Link>에서,
          기준 준수 체크는 <Link href="/principles" className="text-accent">원칙</Link>에서 봅니다.
        </p>
      </section>

      {/* ── 공통 규칙 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">공통 규칙 <span className="font-normal text-dim">— 4개 기준 모두에 적용</span></h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <tbody>
              {COMMON_RULES.map((r) => (
                <tr key={r.label} className="border-t border-border first:border-t-0">
                  <td className="w-24 py-2 pr-3 whitespace-nowrap text-dim">{r.label}</td>
                  <td className="py-2">{r.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 4개 기준 ─────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">진입 기준 4개 <span className="font-normal text-dim">— 판정 조건은 각 1개, 심플함이 기준 선정의 조건이었다</span></h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {CRITERIA.map((c) => (
            <div key={c.key} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium">{c.name}</h3>
                <span className="text-[11px] text-dim">{c.meta}</span>
                <span className="tnum ml-auto rounded border border-profit/40 px-1.5 py-0.5 text-[10px] font-semibold text-profit">여유 {c.edge}</span>
              </div>
              <pre className="tnum mt-2 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-[12px]">{c.rule}</pre>
              <p className="mt-1.5 text-[12px] text-dim">{c.ruleDesc}</p>
              <p className="mt-2 text-[12px]"><span className="text-dim">청산 </span>{c.exit}</p>
              <p className="tnum mt-1 text-[12px]"><span className="text-dim">백테스트(720일) </span>{c.stats}</p>
              <p className="mt-2 border-t border-border pt-2 text-[11.5px] text-dim">실패 모드 — {c.fail}</p>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-dim">
          “여유” = 실측 승률 − 손익분기 승률. 손익비 구조가 이미 비용을 이기고 있는 폭이다.
        </p>
      </section>

      {/* ── 병행 전체 그림 ─────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">병행 시 전체 그림 <span className="font-normal text-dim">— 쿼드 공격형, 리스크 10%</span></h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {QUAD_SUMMARY.map((q) => (
            <div key={q.label} className="rounded-lg border border-border p-3">
              <div className="text-[11px] text-dim">{q.label}</div>
              <div className="tnum mt-0.5 text-[13px]">{q.value}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 rounded-lg border border-beta/40 bg-surface-2 p-3 text-[12px] text-dim">
          <b className="text-text">이 수치는 인샘플 상한이다.</b> 신호·청산·구성을 모두 같은 2년에서 골랐고, 최고 t=1.74도
          우연 기준선(≈1.9~2.5)을 넘지 못했다. 그래서 실전은 승격 사다리를 따른다 — 지금은 소액 라이브 검증 구간이며,
          이 페이지의 성과 데이터가 그 전방 검증의 성적표다.
        </p>
      </section>

      {/* ── 자동화 운영 체계 ────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">자동화 운영 체계</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <tbody>
              {OPERATIONS.map((o) => (
                <tr key={o.label} className="border-t border-border first:border-t-0">
                  <td className="w-24 py-2 pr-3 whitespace-nowrap text-dim">{o.label}</td>
                  <td className="py-2">{o.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-dim">
          검증 계보: 132조합 그리드(720일) → 플레이북 Top 5 → 청산 관리 25조합 → 복리 병행 5방식 → 실주문 배선 검증 → 라이브.
        </p>
      </section>
    </div>
  );
}
