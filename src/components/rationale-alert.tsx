import Link from "next/link";

import { SIDE_LABEL, type Side } from "@/lib/domain";
import { dateTime } from "@/lib/format";
import { RATIONALE_ALERT_DAYS } from "@/lib/rationale";

export interface UnjustifiedTradeRow {
  id: string;
  seq: number;
  symbol: string;
  side: Side;
  entry_at: string;
  open: boolean;
}

/**
 * 근거 없는 매매 경고 — 일부러 크다.
 *
 * 이 블록의 일은 정보 전달이 아니라 압박이다. 근거 없이 들어간 거래가 있는 한 첫 화면에서
 * 피할 수 없어야 하고, 누르면 바로 그 거래의 근거 칸으로 간다. 비어 있으면 아무것도
 * 그리지 않는다 — 조건부로 작아지는 경고는 경고가 아니다.
 */
export function RationaleAlert({ trades }: { trades: readonly UnjustifiedTradeRow[] }) {
  if (trades.length === 0) return null;

  return (
    <section
      role="alert"
      className="rounded-2xl border-4 border-loss bg-loss/10 p-5 sm:p-7"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-loss">뇌동매매 경보</p>
      <h2 className="mt-1 text-3xl font-bold leading-tight text-loss sm:text-5xl">
        근거 없는 매매 {trades.length}건
      </h2>
      <p className="mt-3 text-base font-medium sm:text-lg">
        왜 들어갔는지 적혀 있지 않은 거래입니다. <b>지금 근거를 등록하세요.</b> 근거가 없는 진입은
        기준이 아니라 충동입니다 — 적을 수 없다면 그 거래는 하지 말았어야 합니다.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {trades.map((t) => (
          <li key={t.id}>
            <Link
              href={`/trades/${t.id}`}
              className="flex items-center gap-3 rounded-xl border border-loss/50 bg-surface px-4 py-3 text-sm hover:border-loss"
            >
              <span className="tnum text-dim">#{t.seq}</span>
              <span className={t.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[t.side]}</span>
              <span className="font-medium">{t.symbol}</span>
              {t.open ? (
                <span className="rounded border border-beta/50 px-1.5 py-0.5 text-[10px] text-beta">보유중</span>
              ) : null}
              <span className="tnum ml-auto text-xs text-dim">{dateTime(t.entry_at)}</span>
              <span className="text-xs font-semibold text-loss">근거 등록 →</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-dim">
        보유중이거나 최근 {RATIONALE_ALERT_DAYS}일 안에 진입한 거래만 올립니다. 더 오래된 빈칸은 거래 목록의
        &ldquo;복기 대기&rdquo; 필터에 있습니다.
      </p>
    </section>
  );
}
