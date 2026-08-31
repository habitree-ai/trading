import Link from "next/link";

import { DASH, dateTime, num } from "@/lib/format";
import { readSpotScanHealth, readSpotSignals } from "@/lib/spot";
import { ADOPTED_STATS } from "@/lib/spot-signals";

/**
 * 현물신호 — 업비트 급락 반전(crash × T1) 알람의 이력.
 *
 * 여기 뜨는 신호는 백테스트 게이트(2026-08-31)를 통과한 단일 규칙의 발화 기록이고,
 * 카톡 묶음 알람이 가리키는 곳이다. 스캔이 죽으면 신호도 조용히 사라지므로
 * "마지막 스캔이 언제였나"를 맨 위에 둔다 — 쿼드봇 절전 사고의 교훈이다.
 */

export default async function SpotSignalsPage() {
  const [signals, { lastRun, stale }] = await Promise.all([readSpotSignals(200), readSpotScanHealth()]);

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">현물신호</h1>
          <span className="rounded border border-alpha px-1.5 py-0.5 text-[10px] font-semibold text-alpha">
            업비트 현물 · 알람만
          </span>
          <p className="tnum text-sm text-dim">최근 {signals.length}건</p>
        </div>
        <p className="tnum text-[12px] text-dim">
          마지막 스캔{" "}
          {lastRun ? (
            <span className={stale ? "text-loss" : "text-text"}>
              {dateTime(lastRun.ranAt)} · {lastRun.marketsScanned}종 · 신호 {lastRun.signalsFound}건
              {lastRun.error ? ` · 오류: ${lastRun.error}` : ""}
            </span>
          ) : (
            <span className="text-loss">기록 없음 — 스캐너가 아직 돈 적이 없습니다</span>
          )}
          {stale && lastRun ? <span className="text-loss"> · 지연 — 스캐너 확인 필요</span> : null}
        </p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-4 text-[12px] text-dim">
        <p>
          <span className="font-medium text-text">규칙</span> — {ADOPTED_STATS.rule} · {ADOPTED_STATS.horizon}
        </p>
        <p className="tnum mt-1">
          백테스트 {ADOPTED_STATS.period}: 평균 <span className="text-profit">+{ADOPTED_STATS.avgPct}%</span> ·
          승률 {ADOPTED_STATS.winPct}% · PF {ADOPTED_STATS.pf} (표본 {ADOPTED_STATS.n}) ·
          2026년 +{ADOPTED_STATS.y2026.avgPct}% · 승률 {ADOPTED_STATS.y2026.winPct}%
        </p>
        <p className="mt-1">과거 통계이며 미래를 보장하지 않습니다. 자동 매수 없음 — 판단은 사람 몫입니다.</p>
      </section>

      {signals.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 신호가 없습니다. 급락 반전은 시장이 무너진 날에만 나온다 — 조용한 것이 정상입니다.
        </p>
      ) : (
        <div className="scroll-x rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[46rem] text-[12.5px]">
            <thead className="border-b border-border text-[11px] text-dim">
              <tr>
                <th className="px-3 py-2 text-left font-medium">봉 시각</th>
                <th className="px-3 py-2 text-left font-medium">종목</th>
                <th className="px-3 py-2 text-right font-medium">가격</th>
                <th className="px-3 py-2 text-right font-medium">3일 낙폭</th>
                <th className="px-3 py-2 text-right font-medium">거래량</th>
                <th className="px-3 py-2 text-right font-medium">일 거래대금</th>
                <th className="px-3 py-2 text-left font-medium">알림</th>
                <th className="px-3 py-2 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="tnum px-3 py-1.5 whitespace-nowrap text-dim">
                    {dateTime(s.barTs).slice(5)}
                  </td>
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{s.market.slice(4)}</td>
                  <td className="tnum px-3 py-1.5 text-right whitespace-nowrap">{num(s.price, s.price < 10 ? 2 : 0)}</td>
                  <td className="tnum px-3 py-1.5 text-right text-loss">
                    {s.drop72Pct !== null ? `${num(s.drop72Pct, 1)}%` : DASH}
                  </td>
                  <td className="tnum px-3 py-1.5 text-right">
                    {s.volumeMult !== null ? `${num(s.volumeMult, 1)}배` : DASH}
                  </td>
                  <td className="tnum px-3 py-1.5 text-right text-dim">
                    {s.turnoverMed30 !== null ? `${num(s.turnoverMed30 / 1e8, 0)}억` : DASH}
                  </td>
                  <td className="px-3 py-1.5 text-[11px]">
                    {s.notifiedAt ? <span className="text-profit">발송</span> : <span className="text-dim">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <Link href={`/system/spot/${s.id}`} className="text-[11px] text-alpha hover:underline">
                      상세 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
