import Link from "next/link";

import { MerSimButton, type MerSimLast } from "@/app/(app)/kelly/mer-sim-button";
import { CumulativeR } from "@/components/r-edge-charts";
import { StatTile } from "@/components/stat-tile";
import type { Book, Trade, TradeFill } from "@/lib/domain";
import { EDGE_MIN_SAMPLE, EDGE_VERDICT_LABEL } from "@/lib/edge";
import { DASH, dateTime, num, pct, pnlClass, signed } from "@/lib/format";
import { LEG_UNMEASURED_LABEL, legPoints, legResult, parseChecklist, parseLegSignals, type LegResult } from "@/lib/legs";
import type { MerZoneRow } from "@/lib/mer";
import { buildMerReport, merCandidate, merSimEntry, openGroupCount } from "@/lib/mer-report";
import { listBooks, listLegsByUser, listRBaseHistory, listTrades, listZoneHits, requireUser } from "@/lib/queries";
import type { RPoint } from "@/lib/r-edge-report";

const rText = (v: number | null) => (v === null ? DASH : `${signed(v, 2)}R`);
const zoneText = (z: number) => `+${z}R`;

type FillRow = Pick<TradeFill, "id" | "trade_id" | "role" | "filled_at" | "price" | "amount">;

/** 여러 거래의 체결 — id 를 나눠 읽는다(수백 건을 한 번에 `in` 으로 넣으면 주소가 길어진다). */
async function fillsFor(tradeIds: readonly string[]): Promise<Record<string, FillRow[]>> {
  const out: Record<string, FillRow[]> = {};
  if (tradeIds.length === 0) return out;
  const { supabase } = await requireUser();
  const CHUNK = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < tradeIds.length; i += CHUNK) chunks.push(tradeIds.slice(i, i + CHUNK));
  // 한 묶음의 체결이 조회 상한(1,000행)을 넘으면 잘린다 — 묶음 안에서도 쪽을 나눠 끝까지 읽는다(REQ-0103).
  const PAGE = 1000;
  const readChunk = async (ids: string[]): Promise<FillRow[]> => {
    const rows: FillRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("trade_fills")
        .select("id, trade_id, role, filled_at, price, amount")
        .in("trade_id", ids)
        .order("filled_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data as FillRow[]));
      if (data.length < PAGE) return rows;
    }
  };
  const results = await Promise.all(chunks.map(readChunk));
  for (const rows of results) for (const f of rows) (out[f.trade_id] ??= []).push(f);
  return out;
}

/**
 * MER 탭 — 구간 +1~+3R 에 가상 추가했다면 그 다리가 몇 R 을 벌었나(시뮬)와, 실제로 기록한 다리의 결과(REQ-0102).
 *
 * 표본은 전체 북이 기본이다(D10) — 활성 북 하나로는 구간별 50건이 오래 안 찬다. 시뮬 관측은 사용자 단위로
 * 쌓이고 범위는 화면에서 거른다.
 */
/** `sim` 주소 값(넣음.남음.실패) → 직전 시뮬 결과. 시뮬 버튼이 새로 불러올 때 붙인다(REQ-0103). */
function parseSimParam(raw: string | undefined): MerSimLast | null {
  const m = raw?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? { done: Number(m[1]), remaining: Number(m[2]), failed: Number(m[3]) } : null;
}

export async function MerTab({ book, scope, sim }: { book: Book; scope?: string; sim?: string }) {
  const bookOnly = scope === "book";
  const [books, hits, legs, rHistory] = await Promise.all([
    listBooks(),
    listZoneHits(),
    listLegsByUser(),
    listRBaseHistory(),
  ]);
  const allTrades: Trade[] = (await Promise.all(books.map((b) => listTrades(b.id)))).flat();
  const tradeById = new Map(allTrades.map((t) => [t.id, t]));
  const bookName = new Map(books.map((b) => [b.id, b.name]));
  const feeRateNow = rHistory[0]?.fee_rate ?? null;

  const scoped = bookOnly ? allTrades.filter((t) => t.book_id === book.id) : allTrades;
  const scopedIds = new Set(scoped.map((t) => t.id));

  // 미계산 — 시뮬은 범위와 무관하게 전부 돌리므로 전체 기준. 첫 진입가로 시뮬이 못 하는 거래는
  // 미계산이 아니라 「제외」다 — 시뮬 액션과 같은 merSimEntry 로 가른다(REQ-0103).
  const simulated = new Set(hits.map((h) => h.trade_id));
  const unsimulated = allTrades.filter((t) => merCandidate(t) && !simulated.has(t.id));

  const scopedLegs = legs.filter((l) => scopedIds.has(l.trade_id));
  const sampleIds = [...new Set(hits.map((h) => h.trade_id))].filter((id) => scopedIds.has(id));
  const fills = await fillsFor([
    ...new Set([...sampleIds, ...scopedLegs.map((l) => l.trade_id), ...unsimulated.map((t) => t.id)]),
  ]);
  const excluded = unsimulated.flatMap((t) => {
    const check = merSimEntry(t, fills[t.id] ?? []);
    return check.ok ? [] : [{ seq: t.seq, symbol: t.symbol, reason: check.reason }];
  });
  const pendingCount = unsimulated.length - excluded.length;
  const openGroups: Record<string, number> = {};
  for (const id of sampleIds) openGroups[id] = openGroupCount(fills[id] ?? []);

  const report = buildMerReport(scoped, hits, openGroups);
  const SELECT = "rounded-lg border border-border bg-surface px-2 py-1 text-xs";
  const barMix = Object.entries(report.bars)
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `${b} ${n}`)
    .join(" · ");
  const bookMix = Object.entries(report.byBook)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${bookName.get(id) ?? "?"} ${n}`)
    .join(" · ");

  // 실제 다리 — 체결가로만 잰다(체결 미연결이면 미측정, 함정 14).
  const legRows = scopedLegs.flatMap((leg) => {
    const trade = tradeById.get(leg.trade_id);
    if (!trade) return [];
    const noFee = trade.fee_rate_at_entry === null && feeRateNow === null;
    const result: LegResult | null = noFee ? null : legResult(trade, leg, fills[leg.trade_id] ?? [], feeRateNow ?? 0);
    const checklist = parseChecklist(leg.checklist);
    const signals = parseLegSignals(leg.signals);
    return [{ leg, trade, result, checklist, signals }];
  });
  const points: RPoint[] = legPoints(
    legRows.flatMap((r) => (r.result ? [{ leg: r.leg, result: r.result }] : [])),
  ).map((p) => {
    const t = tradeById.get(p.tradeId);
    return { t: p.t, seq: t?.seq ?? 0, symbol: t?.symbol ?? "", r: p.r, cum: p.cum, roll20: null, roll50: null };
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-dim">표본</span>
        <Link
          href="/kelly?tab=mer"
          className={`${SELECT} ${bookOnly ? "text-dim" : "border-accent text-accent"}`}
          aria-current={bookOnly ? undefined : "true"}
        >
          전체 북
        </Link>
        <Link
          href="/kelly?tab=mer&scope=book"
          className={`${SELECT} ${bookOnly ? "border-accent text-accent" : "text-dim"}`}
          aria-current={bookOnly ? "true" : undefined}
        >
          활성 북 · {book.name}
        </Link>
        <div className="ml-auto">
          <MerSimButton pending={pendingCount} excluded={excluded} last={parseSimParam(sim)} />
        </div>
      </div>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          한계 기대 수익 (MER){" "}
          <span className="font-normal text-dim">— 구간 +kR 에 1R 크기로 추가했다면 그 다리가 번 R 의 평균</span>
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="MER₀ (첫 진입 엣지)"
            value={rText(report.mer0)}
            valueClass={pnlClass(report.mer0)}
            sub={`같은 표본 중 거래 R 을 잰 ${num(report.mer0N, 0)}건`}
          />
          <StatTile
            label="표본 거래"
            value={`${num(report.sampleTrades, 0)}건`}
            sub={bookMix === "" ? "시뮬 관측 없음" : bookMix}
          />
          <StatTile
            label="추정 손절 (okx_last)"
            value={`${num(report.estimated, 0)}건`}
            valueClass={report.estimated > 0 ? "text-beta" : ""}
            sub="마지막 거래소 손절로 잰 최초 손절 — 손절을 옮긴 거래는 구간이 틀린다"
          />
          <StatTile
            label="실제 추가가 있던 거래"
            value={`${num(report.actualAdds, 0)}건`}
            sub="진입 체결 묶음 2개 이상"
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          봉 구성: {barMix === "" ? DASH : barMix}. 같은 봉 안에서 구간 도달과 최초 손절 터치가 같이 있으면 손절 먼저로
          봅니다(보수). 다리 손절은 공통 손절(첫 진입가 + 왕복 수수료, 본전), 청산가는 거래의 평균 청산가 근사입니다.
          {report.invalidHits > 0 ? ` 읽지 못한 관측 ${report.invalidHits}행은 뺐습니다.` : ""}
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          구간별 MER{" "}
          <span className="font-normal text-dim">
            — 통과 = 엣지 확인 · MER 이 MER₀ 보다 큼. ★ = 통과 구간 중 ΔMER 최대(추가 자리)
          </span>
        </h2>
        {report.sampleTrades === 0 ? (
          <p className="mt-3 text-xs text-dim">
            시뮬 관측이 없습니다 — 「시뮬 갱신」을 누르면 청산 거래의 진입 뒤 경로로 구간을 계산합니다.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-xs text-dim">
                <tr>
                  <th className="py-1 text-left font-medium">구간</th>
                  <th className="py-1 text-right font-medium">N</th>
                  <th className="py-1 text-right font-medium">P</th>
                  <th className="py-1 text-right font-medium">W̄</th>
                  <th className="py-1 text-right font-medium">L̄</th>
                  <th className="py-1 text-right font-medium">MER</th>
                  <th className="py-1 text-right font-medium">95% 구간</th>
                  <th className="py-1 text-right font-medium">ΔMER</th>
                  <th className="py-1 pl-3 text-left font-medium">판정</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <MerRow key={row.zoneR} row={row} best={report.best === row.zoneR} total={report.sampleTrades} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs leading-snug text-dim">
          N 은 그 구간에 닿은 거래 수입니다(분모 = 표본 거래). {EDGE_MIN_SAMPLE}건이 안 되는 구간은 판정하지 않습니다 — 표본
          부족이 오래 가는 것은 정상입니다. ΔMER 첫 칸은 MER₀ 대비입니다.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          추가 포함 vs 없음 <span className="font-normal text-dim">— 다리를 1R 크기로 넣었다고 보고 거래 R 에 더함</span>
        </h2>
        {report.withAdd === null ? (
          <p className="mt-2 text-xs text-dim">
            통과한 구간(추가 자리)이 없어 비교하지 않습니다 — 지금 표본으로는 어느 자리 추가도 첫 진입보다 낫다고 말할 수
            없습니다.
          </p>
        ) : report.withAdd.n === 0 ? (
          <p className="mt-2 text-xs text-dim">
            {zoneText(report.withAdd.zoneR)} 에 닿은 거래 중 거래 R 을 잰 것이 없어 비교하지 않습니다.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-dim">대상</dt>
              <dd className="tnum">
                {zoneText(report.withAdd.zoneR)} 도달 {num(report.withAdd.n, 0)}건
              </dd>
            </div>
            <div>
              <dt className="text-xs text-dim">원래 평균 R</dt>
              <dd className={`tnum ${pnlClass(report.withAdd.original)}`}>{rText(report.withAdd.original)}</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">추가 포함 평균 R</dt>
              <dd className={`tnum ${pnlClass(report.withAdd.withAdd)}`}>{rText(report.withAdd.withAdd)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          실제 다리 <span className="font-normal text-dim">— 기록한 추가 진입, 체결가로 잰 순 R</span>
        </h2>
        {legRows.length === 0 ? (
          <p className="mt-2 text-xs text-dim">
            기록한 다리가 없습니다. 추가 진입은 현재 포지션 카드의 「다리 기록」으로 남깁니다.
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-xs text-dim">
                  <tr>
                    <th className="py-1 text-left font-medium">기록 시각</th>
                    <th className="py-1 text-left font-medium">거래</th>
                    <th className="py-1 text-left font-medium">구간</th>
                    <th className="py-1 text-right font-medium">결과</th>
                    <th className="py-1 text-right font-medium">체크리스트</th>
                    <th className="py-1 text-right font-medium">경고</th>
                  </tr>
                </thead>
                <tbody>
                  {legRows.map(({ leg, trade, result, checklist, signals }) => (
                    <tr key={leg.id} className="border-t border-border">
                      <td className="tnum py-1.5 text-dim">{dateTime(leg.at)}</td>
                      <td className="py-1.5">
                        <Link href={`/trades/${trade.id}`} className="hover:underline">
                          #{trade.seq} {trade.symbol}
                        </Link>
                        <span className="ml-1 text-xs text-dim">다리 {leg.leg_no}</span>
                      </td>
                      <td className="tnum py-1.5">{leg.zone_r === null ? <span className="text-dim">구간 밖</span> : zoneText(leg.zone_r)}</td>
                      <td className="tnum py-1.5 text-right">
                        {result === null ? (
                          <span className="text-xs text-dim">수수료율 없음</span>
                        ) : result.reason !== null ? (
                          <span className="text-xs text-dim">{LEG_UNMEASURED_LABEL[result.reason]}</span>
                        ) : (
                          <span className={pnlClass(result.netR)}>{rText(result.netR)}</span>
                        )}
                      </td>
                      <td className="tnum py-1.5 text-right">
                        {checklist === null ? (
                          <span className="text-xs text-dim">기록 없음</span>
                        ) : (
                          `${checklist.filter((c) => c.ok === true).length}/${checklist.length}`
                        )}
                      </td>
                      <td className={`tnum py-1.5 text-right ${signals && signals.warnings.length > 0 ? "text-beta" : ""}`}>
                        {signals === null ? DASH : signals.warnings.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {points.length > 0 ? (
              <div className="mt-4">
                <h3 className="mb-2 text-xs text-dim">누적 다리 R — 기록 순서 · 잰 다리 {points.length}개</h3>
                <CumulativeR points={points} />
              </div>
            ) : (
              <p className="mt-3 text-xs text-dim">순 R 을 잰 다리가 아직 없어 누적 곡선은 그리지 않습니다.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function MerRow({ row, best, total }: { row: MerZoneRow; best: boolean; total: number }) {
  const { stats, interval, verdict } = row;
  const thin = verdict === "insufficient";
  const verdictText = thin
    ? `N ${stats.n}/${EDGE_MIN_SAMPLE} — 시뮬레이션만`
    : `${EDGE_VERDICT_LABEL[verdict]}${row.pass ? " · 통과" : ""}`;
  return (
    <tr className={`border-t border-border ${thin ? "text-dim" : ""}`}>
      <td className="tnum py-1.5">
        {best ? <span className="mr-1 text-accent" aria-label="추가 자리">★</span> : null}
        {zoneText(row.zoneR)}
      </td>
      <td className="tnum py-1.5 text-right">
        {num(stats.n, 0)}
        <span className="ml-1 text-xs text-dim">/{total}</span>
      </td>
      <td className="tnum py-1.5 text-right">{pct(stats.winRate)}</td>
      <td className="tnum py-1.5 text-right">{rText(stats.avgWinR)}</td>
      <td className="tnum py-1.5 text-right">{stats.avgLossR === null ? DASH : `${num(stats.avgLossR, 2)}R`}</td>
      <td className={`tnum py-1.5 text-right font-medium ${thin ? "" : pnlClass(row.mer)}`}>{rText(row.mer)}</td>
      <td className="tnum py-1.5 text-right">
        {interval === null ? DASH : `${signed(interval[0], 2)} ~ ${signed(interval[1], 2)}`}
      </td>
      <td className="tnum py-1.5 text-right">{rText(row.deltaMer)}</td>
      <td className={`py-1.5 pl-3 text-xs ${row.pass ? "text-profit" : verdict === "negative" ? "text-loss" : ""}`}>
        {verdictText}
      </td>
    </tr>
  );
}
