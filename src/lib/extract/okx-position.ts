import type { ExchangeAdapter, ExtractedFields } from "@/lib/extract/types";
import { toIsoKst, toNumber, valueAfter } from "@/lib/extract/normalize";

/**
 * OKX 모바일 `Position details` 화면 어댑터 — 상단 요약 + `Order history`.
 *
 * 주문 상세(`okx.ts`)와 달리 **진입과 청산이 한 화면에 다 있어 거래 하나가 완성된다.**
 * 분할 진입·분할 청산이면 주문이 여러 건 쌓이므로 가중평균으로 합쳐야 한다.
 *
 * 화면에서 확인한 규칙:
 * - `Close short` 배지가 초록, `Open short`가 빨강이다. **색으로 방향을 판단하면 안 된다.**
 * - `Filled`는 기초자산 수량이 아니라 **USDT 금액**이다. 그래서 평균가는 단순평균이 아니라
 *   `Σ금액 ÷ Σ(금액/가격)`(수량가중)이어야 한다.
 * - `Closed`가 `--`면 포지션이 아직 열려 있다(부분청산).
 * - `Funding fee`는 없을 때 `--`로 찍힌다.
 */

interface Fill {
  role: "open" | "close";
  side: "long" | "short";
  time: string;
  filled: number;
  price: number;
  fee: number;
}

const FILL_HEAD = /(Open|Close)\s+(long|short)\s+(\d{1,2}\/\d{1,2}[,\s]+\d{1,2}:\d{2}(?::\d{2})?)/i;

/** `Order history` 아래를 주문 단위로 쪼갠다. */
function parseFills(body: string): Fill[] {
  const lines = body.split(/\r?\n/);
  const fills: Fill[] = [];
  let current: Partial<Fill> | null = null;

  const flush = () => {
    if (
      current?.role &&
      current.side &&
      current.time &&
      typeof current.filled === "number" &&
      typeof current.price === "number"
    ) {
      fills.push({ ...current, fee: current.fee ?? 0 } as Fill);
    }
    current = null;
  };

  for (const line of lines) {
    const head = line.match(FILL_HEAD);
    if (head) {
      flush();
      current = {
        role: head[1].toLowerCase() === "open" ? "open" : "close",
        side: head[2].toLowerCase() === "short" ? "short" : "long",
        time: head[3],
      };
      continue;
    }
    if (!current) continue;

    if (/^\s*Filled\b/i.test(line)) current.filled = toNumber(valueAfter(line, /^\s*Filled\b/i));
    else if (/^\s*Fill\s*price\b/i.test(line))
      current.price = toNumber(valueAfter(line, /^\s*Fill\s*price\b/i));
    else if (/^\s*Fee\b/i.test(line)) current.fee = toNumber(valueAfter(line, /^\s*Fee\b/i)) ?? 0;
  }
  flush();

  return fills;
}

/**
 * 수량가중 평균가.
 *
 * `Filled`가 USDT 금액이라 수량은 `금액 / 가격`이다. 단순평균을 쓰면 큰 체결에
 * 가중이 실리지 않아 손익 검산이 어긋난다.
 */
function vwap(fills: readonly Fill[]): { price: number; notional: number } | null {
  const usable = fills.filter((f) => f.price > 0 && f.filled > 0);
  if (usable.length === 0) return null;

  const notional = usable.reduce((a, f) => a + f.filled, 0);
  const quantity = usable.reduce((a, f) => a + f.filled / f.price, 0);
  if (quantity === 0) return null;

  // 나눗셈이 남긴 부동소수 꼬리를 잘라 체결가와 같은 자리수로 맞춘다.
  // (`64915.08571794914` 같은 값이 폼에 그대로 뜨면 읽기 어렵다.)
  const decimals = Math.min(
    8,
    Math.max(...usable.map((f) => (String(f.price).split('.')[1] ?? '').length)),
  );

  return { price: Number((notional / quantity).toFixed(decimals)), notional };
}

export const okxPositionAdapter: ExchangeAdapter = {
  id: "okx-position",
  label: "OKX 포지션 상세",

  detect(text) {
    let score = 0;
    if (/Order\s*history/i.test(text)) score += 0.45;
    if (/Realized\s*PnL/i.test(text)) score += 0.3;
    if (/(Time\s*opened|Trading\s*fee|Funding\s*fee)/i.test(text)) score += 0.2;
    if (/(Open|Close)\s+(long|short)/i.test(text)) score += 0.05;
    return Math.min(score, 1);
  },

  parse(text) {
    const fields: ExtractedFields = {};
    const suspect: string[] = [];
    const notes: string[] = [];

    const splitAt = text.search(/Order\s*history/i);
    const header = splitAt >= 0 ? text.slice(0, splitAt) : text;
    const body = splitAt >= 0 ? text.slice(splitAt) : "";

    // 연도는 헤더의 `Time opened`에만 붙는다 — 주문 줄의 시각에 채워 넣을 기준.
    const openedRaw = valueAfter(header, /^\s*Time\s*opened\b/i);
    // `Closed PnL`과 `Closed (USDT)` 두 라벨이 같은 접두사를 쓴다.
    // 부정 예측은 공백까지 함께 삼켜야 한다 — `\s*` 뒤에 두면 0글자로 되돌아가 통과해 버린다.
    const closedRaw = valueAfter(header, /^\s*Closed(?!\s*(?:PnL|\())/i);
    const headerYear = Number(openedRaw?.match(/\/(\d{4})/)?.[1]);
    const fallbackYear = Number.isFinite(headerYear) ? headerYear : new Date().getUTCFullYear();

    const inst = header.match(/\b([A-Z]{2,10})[-/]?(USDT|USDC|USD)\b/);
    if (inst) fields.symbol = inst[1].toUpperCase();

    const fills = parseFills(body);
    const opens = fills.filter((f) => f.role === "open");
    const closes = fills.filter((f) => f.role === "close");

    // 방향은 배지 색이 아니라 글자로만 판단한다 — 숏은 색이 뒤집혀 나온다.
    const badge = header.match(/\b(Long|Short)\b/);
    fields.side =
      fills[0]?.side ?? (badge ? (badge[1].toLowerCase() as "long" | "short") : undefined);

    const entry = vwap(opens);
    const exit = vwap(closes);

    // 낱개 체결을 그대로 넘긴다 — 차트는 평균가가 아니라 이 좌표에 점을 찍어야 한다.
    fields.fills = fills
      .map((f) => {
        const at = toIsoKst(f.time, fallbackYear);
        return at ? { role: f.role, at, price: f.price, amount: f.filled, fee: f.fee } : null;
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    if (entry) {
      fields.entry_price = entry.price;
      fields.notional = entry.notional;
    }
    if (exit) fields.exit_price = exit.price;

    // 진입 시각은 헤더의 `Time opened`(연도 포함)가 가장 믿을 만하다.
    fields.entry_at =
      toIsoKst(openedRaw, fallbackYear) ??
      toIsoKst(opens.at(-1)?.time, fallbackYear); // 주문은 최신순이라 마지막이 첫 진입

    const positionStillOpen = !closedRaw || /^-+$/.test(closedRaw.trim());
    fields.exit_at = positionStillOpen
      ? toIsoKst(closes[0]?.time, fallbackYear) // 주문 목록의 첫 줄이 마지막 청산
      : toIsoKst(closedRaw, fallbackYear);

    // 손익은 총액(Closed PnL), 수수료는 거래+펀딩 합계로 나눠 담는다.
    // 계좌가 실제로 움직인 값 = Closed PnL + 수수료 = Realized PnL.
    fields.pnl = toNumber(valueAfter(header, /^\s*Closed\s*PnL\b/i));
    const tradingFee = toNumber(valueAfter(header, /^\s*Trading\s*fee\b/i)) ?? 0;
    const fundingFee = toNumber(valueAfter(header, /^\s*Funding\s*fee\b/i)) ?? 0;
    if (tradingFee !== 0 || fundingFee !== 0) fields.fee = tradingFee + fundingFee;

    const realized = toNumber(valueAfter(header, /^\s*Realized\s*PnL/i));

    if (fills.length === 0) {
      notes.push("`Order history`에서 체결 내역을 읽지 못했습니다.");
      suspect.push("entry_price", "exit_price");
    } else if (opens.length > 1 || closes.length > 1) {
      notes.push(
        `분할 체결(진입 ${opens.length}건 · 청산 ${closes.length}건)을 수량가중 평균가로 합쳤습니다.`,
      );
    }

    if (positionStillOpen && closes.length > 0) {
      fields.orderRole = "close";
      notes.push(
        "`Closed`가 비어 있어 포지션이 아직 열려 있습니다(부분청산). 확정된 거래로 기록할지 확인해 주세요.",
      );
      suspect.push("exit_at", "exit_price");
    }

    // 화면이 직접 알려주는 실현손익과 대조한다 — 어긋나면 숫자를 잘못 읽은 것이다.
    if (realized !== undefined && fields.pnl !== undefined) {
      const computed = fields.pnl + (fields.fee ?? 0);
      if (Math.abs(computed - realized) > 0.02) {
        suspect.push("pnl", "fee");
        notes.push(
          `실현손익 대조가 어긋납니다 — 화면 ${realized}, 손익+수수료 ${computed.toFixed(2)}.`,
        );
      }
    }

    const required = [fields.symbol, fields.side, fields.entry_price, fields.exit_price, fields.pnl];
    const filled = required.filter((v) => v !== undefined).length;

    return {
      fields,
      confidence: filled / required.length,
      suspect: [...new Set(suspect)],
      notes,
      adapter: "okx-position",
    };
  },
};
