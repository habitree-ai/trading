import { CASH_FLOW_LABEL, type CashFlow } from "@/lib/domain";
import { dateTime, num, pnlClass, signed } from "@/lib/format";

/**
 * 입출금 · 이체 — 계좌를 드나든 돈.
 *
 * 매매 손익과 갈라 놓는 게 이 화면의 전부다. 자금이 늘어난 게 잘 벌어서인지
 * 돈을 더 넣어서인지 구분되지 않으면 성과를 읽을 수 없다.
 *
 * `transfer`(거래계좌 이체)만 자금 곡선을 움직인다. 온체인 입금·출금은 자금계좌에
 * 먼저 닿으므로 이체가 일어나기 전까지 곡선과 무관하다.
 */
export function CashFlowPanel({
  flows,
  currency,
  deposits,
  withdrawals,
  netTransfer,
}: {
  flows: CashFlow[];
  currency: string;
  deposits: number;
  withdrawals: number;
  netTransfer: number;
}) {
  // 최근 것부터 12건 — 그보다 오래된 건 합계로 충분하다.
  const recent = [...flows].reverse().slice(0, 12);

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">
        입출금 · 이체{" "}
        <span className="font-normal text-dim">
          — 매매로 번 돈과 넣고 뺀 돈을 갈라 봅니다 ({currency})
        </span>
      </h2>

      <dl className="mt-3 grid grid-cols-3 gap-3">
        <Total label="총 입금" value={deposits} hint="온체인으로 들어온 현금" />
        <Total label="총 출금" value={withdrawals} hint="온체인으로 빠져나간 현금" />
        <Total label="거래계좌 순이체" value={netTransfer} hint="자금 곡선을 움직인 금액" />
      </dl>

      {recent.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border p-6 text-center text-xs text-dim">
          아직 입출금 기록이 없습니다. 거래목록에서 OKX 동기화를 돌리면 채워집니다.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {recent.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
              <span
                className={`rounded border px-1.5 py-0.5 text-[11px] ${
                  f.kind === "transfer" ? "border-accent/40 text-accent" : "border-border text-dim"
                }`}
              >
                {CASH_FLOW_LABEL[f.kind]}
              </span>
              <span className="truncate text-xs text-dim" title={f.note ?? ""}>
                {f.note ?? "—"}
              </span>
              <span className="tnum ml-auto text-xs text-dim">{dateTime(f.at)}</span>
              <span className={`tnum w-28 text-right font-medium ${pnlClass(f.amount)}`}>
                {signed(f.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {flows.length > recent.length ? (
        <p className="mt-2 text-[11px] text-dim">
          최근 {recent.length}건만 표시 — 전체 {flows.length}건은 합계에 모두 반영됩니다.
        </p>
      ) : null}
    </section>
  );
}

function Total({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className={`tnum mt-0.5 text-sm font-medium ${pnlClass(value)}`}>
        {signed(value, 2)}
      </dd>
      <p className="mt-0.5 text-[10px] text-dim">{hint}</p>
    </div>
  );
}

/** 계산 자금과 거래소 실제 잔액의 차이 — 벌어지면 놓친 거래나 입출금이 있다는 뜻. */
export function BalanceGap({
  computed,
  actual,
  at,
  currency,
}: {
  computed: number;
  actual: number | null;
  at: string | null;
  currency: string;
}) {
  if (actual === null) {
    return (
      <p className="text-[11px] text-dim">
        거래소 잔액을 아직 받지 못했습니다 — OKX 동기화를 돌리면 채워집니다.
      </p>
    );
  }

  const gap = actual - computed;
  // 소수 반올림 정도의 차이는 어긋난 게 아니다.
  const aligned = Math.abs(gap) < 0.01;

  return (
    <p className="text-[11px] text-dim">
      거래소 잔액 <span className="tnum text-text">{num(actual)}</span> {currency}
      {at ? ` · ${dateTime(at)}` : ""} ·{" "}
      {aligned ? (
        <span className="text-profit">계산 자금과 일치</span>
      ) : (
        <span className={pnlClass(gap)}>
          계산 자금과 {signed(gap)} 차이 — 놓친 거래나 입출금이 있을 수 있습니다
        </span>
      )}
    </p>
  );
}
