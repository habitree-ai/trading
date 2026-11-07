import type { Trade, TradeFill, TradeLeg } from "@/lib/domain";
import { DASH, dateTime, num, pnlClass, price, signed } from "@/lib/format";
import { LEG_UNMEASURED_LABEL, legResult, parseChecklist, parseLegSignals } from "@/lib/legs";

const rText = (v: number | null) => (v === null ? DASH : `${signed(v, 2)}R`);

/**
 * 추가 진입 다리 카드(REQ-0102) — 이 거래에 「다리 기록」으로 남긴 추가 진입마다 구간·공통 손절·결과 R·체크리스트 통과.
 * 결과 R 은 연결된 체결가 기준이라, 체결이 아직 동기화되지 않았으면 비운다(의도가로 계산하지 않는다).
 */
export function LegsCard({
  trade,
  legs,
  fills,
  feeRateNow,
}: {
  trade: Trade;
  legs: TradeLeg[];
  fills: TradeFill[];
  feeRateNow: number | null;
}) {
  if (legs.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">
        추가 진입 다리 <span className="font-normal text-dim">— 다리마다 자기 1R(추가가 − 공통 손절) 기준</span>
      </h2>
      <div className="mt-3 scroll-x">
        <table className="w-full min-w-[40rem] text-sm tnum">
          <thead className="text-xs text-dim">
            <tr>
              <th className="py-1 text-left font-normal">다리</th>
              <th className="py-1 text-left font-normal">시각</th>
              <th className="py-1 text-right font-normal">구간</th>
              <th className="py-1 text-right font-normal">추가가 · 체결</th>
              <th className="py-1 text-right font-normal">수량</th>
              <th className="py-1 text-right font-normal">공통 손절</th>
              <th className="py-1 text-right font-normal">결과</th>
              <th className="py-1 text-right font-normal">체크리스트</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg) => {
              const res = feeRateNow === null && trade.fee_rate_at_entry === null ? null : legResult(trade, leg, fills, feeRateNow ?? 0);
              const items = parseChecklist(leg.checklist);
              const ok = items?.filter((i) => i.ok === true).length ?? null;
              const signals = parseLegSignals(leg.signals);
              return (
                <tr key={leg.id} className="border-t border-border">
                  <td className="py-1.5">#{leg.leg_no}</td>
                  <td className="py-1.5 text-dim">{dateTime(leg.at)}</td>
                  <td className="py-1.5 text-right">{leg.zone_r === null ? "구간 밖" : `+${leg.zone_r}R`}</td>
                  <td className="py-1.5 text-right">
                    {price(leg.price)}
                    <div className="text-xs text-dim">{res?.fill ? price(res.fill.price) : "체결 미연결"}</div>
                  </td>
                  <td className="py-1.5 text-right">{num(leg.qty, 4)}</td>
                  <td className="py-1.5 text-right">{leg.common_stop === null ? DASH : price(leg.common_stop)}</td>
                  <td className={`py-1.5 text-right font-medium ${pnlClass(res?.netR ?? null)}`}>
                    {res === null
                      ? "수수료율 없음"
                      : res.reason !== null
                        ? <span className="font-normal text-dim">{LEG_UNMEASURED_LABEL[res.reason]}</span>
                        : rText(res.netR)}
                  </td>
                  <td className="py-1.5 text-right">
                    {ok === null ? DASH : <span className={ok === items?.length ? "text-profit" : "text-loss"}>{ok}/{items?.length}</span>}
                    <div className="text-xs text-dim">
                      {signals === null ? "지표 없음" : `경고 ${signals.warnings.length} · 롱 ${signals.onLong} · 숏 ${signals.onShort}`}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {legs.some((l) => l.note) ? (
        <ul className="mt-2 space-y-0.5 text-xs text-dim">
          {legs.filter((l) => l.note).map((l) => (
            <li key={l.id}>
              #{l.leg_no} {l.note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
