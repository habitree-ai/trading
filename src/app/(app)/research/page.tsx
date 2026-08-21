import Link from "next/link";

import { BriefingButton } from "@/app/(app)/research/briefing-button";
import { CollectButton } from "@/app/(app)/research/collect-button";
import { NoteForm } from "@/app/(app)/research/note-form";
import { NoteRow } from "@/app/(app)/research/note-row";
import { StatTile } from "@/components/stat-tile";
import {
  RESEARCH_NOTE_CATEGORIES,
  RESEARCH_NOTE_CATEGORY_LABEL,
  type ResearchNote,
  type ResearchNoteCategory,
  type ResearchSnapshot,
} from "@/lib/domain";
import { DASH, dateTime, num } from "@/lib/format";
import {
  getLatestSnapshot,
  listResearchNotes,
  listResearchSymbols,
  listSnapshots,
} from "@/lib/queries";

/** 묶음마다 무엇을 적는 자리인지 — 빈 칸을 보고도 뭘 쓸지 알 수 있게. */
const CATEGORY_HINT: Record<ResearchNoteCategory, string> = {
  fundamental: "가치와 수급의 뼈대 — 발행 구조, 반감기, ETF 흐름",
  onchain: "체인 위의 움직임 — 보유 분포, 거래소 유출입, 채굴자",
  regulation: "규제·정책 — 법안, 소송, 정부·중앙은행 발언",
  social: "사회·채택 — 결제 도입, 기관 채택, 여론",
  macro: "매크로 — 달러, 금리, 유동성, 위험자산 심리",
  briefing: "AI가 수집 자료를 정리한 종합",
};

/** 시총·OI처럼 큰 금액은 T/B/M으로 줄인다 — 자릿수가 곧 정보라 그대로는 안 읽힌다. */
function usdCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  if (value >= 1e12) return `$${num(value / 1e12, 2)}T`;
  if (value >= 1e9) return `$${num(value / 1e9, 1)}B`;
  if (value >= 1e6) return `$${num(value / 1e6, 1)}M`;
  return `$${num(value, 0)}`;
}

function usdPrice(value: number | null): string {
  if (value === null) return DASH;
  return `$${num(value, value >= 100 ? 0 : 4)}`;
}

/** 펀딩비(8시간 소수) → %. 0.0001 = 0.01% */
function fundingPct(value: number | null): string {
  if (value === null) return DASH;
  return `${num(value * 100, 4)}%`;
}

/** 이 스냅샷에서 실패한 소스 이름들 — 없으면 빈 문자열. */
function failedSources(snapshot: ResearchSnapshot): string {
  return Object.entries(snapshot.sources)
    .filter(([, status]) => status !== "ok")
    .map(([key]) => key)
    .join(", ");
}

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string }>;
}) {
  const { symbol: raw } = await searchParams;
  const requested = (raw ?? "").trim().toUpperCase();
  const symbol = /^[A-Z0-9]{1,10}$/.test(requested) ? requested : "BTC";

  const [snapshot, history, notes, symbols] = await Promise.all([
    getLatestSnapshot(symbol),
    listSnapshots(symbol),
    listResearchNotes(symbol),
    listResearchSymbols(),
  ]);

  const byCategory = new Map<ResearchNoteCategory, ResearchNote[]>();
  for (const note of notes) {
    byCategory.set(note.category, [...(byCategory.get(note.category) ?? []), note]);
  }

  // 소스가 실패한 타일은 값 대신 그 사실을 말한다 — 조용한 공백은 0으로 오독된다.
  const failed = (key: string) =>
    snapshot !== null && snapshot.sources[key] !== undefined && snapshot.sources[key] !== "ok";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">종목 리서치</h1>
        <p className="mt-1 text-sm text-dim">
          매매 이전에 보는 자리 — 현재 데이터를 걷어 오고, 기본적 분석과 정치·사회 맥락을
          쌓습니다.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {symbols.map((s) => (
          <Link
            key={s}
            href={`/research?symbol=${s}`}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              s === symbol
                ? "bg-surface-2 font-medium text-text"
                : "border border-border text-dim hover:text-text"
            }`}
          >
            {s}
          </Link>
        ))}
        {/* GET 폼 — 새 심볼은 URL로 이동만 하면 되므로 클라이언트 코드가 필요 없다. */}
        <form action="/research" className="flex items-center gap-1.5">
          <input
            name="symbol"
            placeholder="새 심볼"
            pattern="[A-Za-z0-9]{1,10}"
            className="w-24 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-dim hover:text-text"
          >
            조회
          </button>
        </form>
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            {symbol} 정량 스냅샷
            {snapshot ? (
              <span className="tnum ml-2 text-xs font-normal text-dim">
                수집 {dateTime(snapshot.collected_at)}
              </span>
            ) : null}
          </h2>
          <CollectButton symbol={symbol} />
        </div>

        {snapshot ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile
              label="가격"
              value={usdPrice(snapshot.price_usd)}
              sub={failed("coingecko") ? "이번 수집 실패" : "CoinGecko"}
            />
            <StatTile
              label="시가총액"
              value={usdCompact(snapshot.market_cap_usd)}
              sub={failed("coingecko") ? "이번 수집 실패" : `24h 거래량 ${usdCompact(snapshot.volume_24h_usd)}`}
            />
            <StatTile
              label="도미넌스"
              value={snapshot.dominance_pct === null ? DASH : `${num(snapshot.dominance_pct, 1)}%`}
              sub={failed("coingecko") ? "이번 수집 실패" : "글로벌 시총 점유율"}
            />
            <StatTile
              label="공포탐욕지수"
              value={snapshot.fear_greed === null ? DASH : String(snapshot.fear_greed)}
              sub={
                failed("fng")
                  ? "이번 수집 실패"
                  : `${snapshot.fear_greed_label ?? ""} · 시장 전체 지수`.trim()
              }
            />
            <StatTile
              label="펀딩비 (8h)"
              value={fundingPct(snapshot.funding_rate)}
              sub={
                failed("okx")
                  ? "이번 수집 실패"
                  : snapshot.funding_rate === null
                    ? "OKX 무기한"
                    : `연환산 ≈ ${num(snapshot.funding_rate * 3 * 365 * 100, 1)}%`
              }
            />
            <StatTile
              label="미결제약정"
              value={usdCompact(snapshot.open_interest_usd)}
              sub={failed("okx") ? "이번 수집 실패" : "OKX 무기한 명목"}
            />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
            아직 스냅샷이 없습니다. &lsquo;지금 수집&rsquo;을 누르면 시세·심리·파생 지표와 뉴스
            헤드라인을 한 장으로 걷어 옵니다.
          </p>
        )}
      </section>

      {snapshot && snapshot.headlines.length > 0 ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">뉴스 헤드라인</h2>
          <ul className="mt-2 space-y-1.5">
            {snapshot.headlines.map((headline) => (
              <li key={headline.link} className="text-sm">
                <a
                  href={headline.link}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {headline.title}
                </a>
                <span className="tnum ml-2 text-[11px] text-dim">
                  {headline.source}
                  {headline.published_at ? ` · ${dateTime(headline.published_at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {process.env.AI_GATEWAY_API_KEY ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">AI 브리핑</h2>
              <p className="mt-1 text-xs text-dim">
                최신 스냅샷과 헤드라인만으로 기본적 분석·정치사회 맥락을 정리해 노트로
                남깁니다.
              </p>
            </div>
            <BriefingButton symbol={symbol} />
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">노트 추가</h2>
        <NoteForm symbol={symbol} />
      </section>

      {notes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 자료가 없습니다. 기사·보고서·생각을 묶음별로 쌓아 두면, 매매 전에 이 화면
          하나로 상황을 되짚을 수 있습니다.
        </p>
      ) : (
        RESEARCH_NOTE_CATEGORIES.map((category) => {
          const rows = byCategory.get(category) ?? [];
          if (rows.length === 0) return null;

          return (
            <section key={category} className="space-y-2">
              <h2 className="text-sm font-medium">
                {RESEARCH_NOTE_CATEGORY_LABEL[category]}
                <span className="ml-2 text-xs font-normal text-dim">
                  {CATEGORY_HINT[category]}
                </span>
              </h2>
              {rows.map((note) => (
                <NoteRow key={note.id} note={note} />
              ))}
            </section>
          );
        })
      )}

      {history.length > 1 ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">
            스냅샷 이력
            <span className="ml-2 text-xs font-normal text-dim">최근 {history.length}건</span>
          </h2>
          <div className="mt-2 scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-dim">
                  <th className="py-1 pr-3 font-normal">수집 시각</th>
                  <th className="py-1 pr-3 font-normal">가격</th>
                  <th className="py-1 pr-3 font-normal">공포탐욕</th>
                  <th className="py-1 pr-3 font-normal">펀딩비</th>
                  <th className="py-1 pr-3 font-normal">OI(USD)</th>
                  <th className="py-1 font-normal">실패 소스</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="tnum py-1.5 pr-3">{dateTime(s.collected_at)}</td>
                    <td className="tnum py-1.5 pr-3">{usdPrice(s.price_usd)}</td>
                    <td className="tnum py-1.5 pr-3">{s.fear_greed ?? DASH}</td>
                    <td className="tnum py-1.5 pr-3">{fundingPct(s.funding_rate)}</td>
                    <td className="tnum py-1.5 pr-3">{usdCompact(s.open_interest_usd)}</td>
                    <td className="py-1.5 text-[11px] text-loss">{failedSources(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
