import type { StopSource } from "@/lib/domain";
import { DASH, num, pnlClass, signed } from "@/lib/format";
import { R_UNMEASURED_LABEL, type TradeR } from "@/lib/r-multiple";

const SOURCE_LABEL: Record<StopSource, string> = {
  plan: "계획 손절",
  okx_first: "거래소 손절(처음 본 값)",
  okx_last: "거래소 손절(마지막 값 · 추정)",
};

/** 가격 — 저가 코인은 소수 둘째 자리로 자르면 진입가와 손절이 같아 보인다. */
const price = (v: number | null) =>
  v === null ? DASH : num(v, Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6);

/**
 * 거래 상세의 R 카드(REQ-0089) — 목록에는 R 배수·위험 배수만 두고 나머지는 여기서 본다.
 *
 * R 배수 = 가격R − 비용R. 같은 손익이라도 최초 위험이 크면 R 배수가 작다 — 계좌 기준으로는
 * 기준R 손익(= 순손익 ÷ 진입 때 기준 R)을 본다.
 */
export function RCard({ r, rBase }: { r: TradeR; rBase: number | null }) {
  const rows: { label: string; value: string; tone?: string; hint?: string }[] = [
    {
      label: "최초 손절",
      value: price(r.stop0),
      hint: r.stop0Source ? SOURCE_LABEL[r.stop0Source] : undefined,
    },
    { label: "평균 진입가 · 진입 수량", value: r.entry0 === null ? DASH : `${price(r.entry0)} · ${num(r.qty0, 4)}` },
    { label: "최초 위험", value: r.initialRisk === null ? DASH : `${num(r.initialRisk)} USDT` },
    {
      label: "위험 배수",
      value: r.riskMultiple === null ? DASH : `${num(r.riskMultiple, 2)}×`,
      tone: r.riskMultiple !== null && r.riskMultiple > 2 ? "text-beta" : undefined,
      hint: rBase === null ? "진입 때 기준 R 없음" : `기준 R ${num(rBase)} USDT · 예상 왕복 수수료 포함`,
    },
    {
      label: "R 배수",
      value: r.rMultiple === null ? DASH : `${signed(r.rMultiple)}R`,
      tone: pnlClass(r.rMultiple),
    },
    { label: "가격R", value: r.priceR === null ? DASH : `${signed(r.priceR)}R` },
    { label: "비용R", value: r.costR === null ? DASH : `${num(r.costR)}R`, hint: "수수료 + 펀딩 등" },
    {
      label: "기준R 손익",
      value: r.baseRPnl === null ? DASH : `${signed(r.baseRPnl)}R`,
      tone: pnlClass(r.baseRPnl),
    },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-medium">
          R <span className="font-normal text-dim">— 감수한 위험 대비 결과</span>
        </h2>
        {r.reason !== null ? (
          <span className="rounded border border-border px-1.5 py-0.5 text-xs text-dim">
            R 미측정 · {R_UNMEASURED_LABEL[r.reason]}
          </span>
        ) : null}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-dim">{row.label}</dt>
            <dd className={`tnum ${row.tone ?? ""}`}>{row.value}</dd>
            {row.hint ? <dd className="text-xs text-dim">{row.hint}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}
