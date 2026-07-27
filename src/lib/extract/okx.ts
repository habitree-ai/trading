import type { ExchangeAdapter, ExtractedFields, ExtractResult } from "@/lib/extract/types";
import { toIsoKst, toLeverage, toNumber, toPercent, valueAfter } from "@/lib/extract/normalize";

/**
 * OKX 모바일 `Order details` 화면 어댑터.
 *
 * 이 화면은 **주문 1건**을 보여준다. `Close long`이면 청산 주문이라 청산가·손익·레버리지는
 * 있지만 **진입가와 진입 시각이 없다**. 캡쳐 한 장으로 거래가 완성되지 않는다는 뜻이라,
 * 빠진 항목을 `notes`로 되돌려 폼에서 안내한다.
 */
export const okxAdapter: ExchangeAdapter = {
  id: "okx",
  label: "OKX",

  detect(text) {
    let score = 0;
    if (/Order\s*details/i.test(text)) score += 0.4;
    if (/(Closed\s*PnL|Reduce-?only|Fill\s*price|Order\s*value)/i.test(text)) score += 0.4;
    if (/(Close|Open)\s+(long|short)/i.test(text)) score += 0.2;
    if (/Perp\b/i.test(text)) score += 0.1;
    return Math.min(score, 1);
  },

  parse(text) {
    const fields: ExtractedFields = {};
    const suspect: string[] = [];
    const notes: string[] = [];
    // 연도를 생략한 시각(`07/27, 10:48:15`)을 만났을 때 채워 넣을 기준.
    const fallbackYear = new Date().getUTCFullYear();

    // `Close long` / `Open short` — 포지션 방향과 이 주문의 역할을 함께 알려준다.
    const role = text.match(/\b(Close|Open)\s+(long|short)\b/i);
    if (role) {
      fields.orderRole = role[1].toLowerCase() === "close" ? "close" : "open";
      fields.side = role[2].toLowerCase() === "short" ? "short" : "long";
    }

    // `BTCUSDT Perp` → BTC (USDT 무기한은 기초자산만 남긴다)
    const inst = text.match(/\b([A-Z]{2,10})[-/]?(USDT|USDC|USD)\b/);
    if (inst) fields.symbol = inst[1].toUpperCase();

    fields.leverage = toLeverage(text.match(/\b\d+(?:\.\d+)?\s*[xX×]/)?.[0]);

    // 청산가 — `Fill price`가 실제 체결가라 `Order price`보다 우선한다.
    const fillPrice = toNumber(valueAfter(text, /^\s*Fill\s*price\b/i));
    const orderPrice = toNumber(valueAfter(text, /^\s*Order\s*price\b/i));
    const price = fillPrice ?? orderPrice;

    // `Order value $8,486.01` — 명목가. 없으면 `Order amount`로 대체한다.
    fields.notional =
      toNumber(valueAfter(text, /^\s*Order\s*value\b/i)) ??
      toNumber(valueAfter(text, /^\s*Order\s*amount\b/i));

    fields.pnl = toNumber(valueAfter(text, /^\s*Closed\s*PnL(?!\s*%)\b/i));
    fields.pnl_pct = toPercent(valueAfter(text, /^\s*Closed\s*PnL\s*%/i));
    fields.fee = toNumber(valueAfter(text, /^\s*Fee\b/i));

    // 체결 시각 — `Fill details`의 타임스탬프에만 연도가 붙는다.
    const fillStamp = text.match(/\d{1,2}\/\d{1,2}\/\d{4}[,\s]+\d{1,2}:\d{2}(?::\d{2})?/);
    const creationLine = valueAfter(text, /^\s*Creation\s*time\b/i);
    const filledAt = toIsoKst(fillStamp?.[0], fallbackYear) ?? toIsoKst(creationLine, fallbackYear);

    if (fields.orderRole === "close") {
      fields.exit_price = price;
      fields.exit_at = filledAt;
      notes.push(
        "청산 주문 캡쳐입니다 — 진입가와 진입 시각은 이 화면에 없습니다. 직접 입력하거나 진입 주문 캡쳐를 추가해 주세요.",
      );
      suspect.push("entry_price", "entry_at");
    } else if (fields.orderRole === "open") {
      fields.entry_price = price;
      fields.entry_at = filledAt;
      notes.push("진입 주문 캡쳐입니다 — 청산가·손익은 청산 후 캡쳐에서 채워집니다.");
      suspect.push("exit_price", "pnl");
    } else {
      // 방향을 못 읽었으면 가격을 어느 쪽에 넣을지 정할 수 없다.
      suspect.push("side", "entry_price", "exit_price");
      notes.push("주문 방향(Close long / Open short)을 읽지 못했습니다.");
    }

    if (creationLine && !/\d{4}/.test(creationLine)) {
      notes.push(
        `\`Creation time\`에 연도가 없어 ${fallbackYear}년으로 가정했습니다. 다른 해의 거래라면 고쳐 주세요.`,
      );
    }

    // 거래소가 표시한 손익률과 우리 계산이 어긋나면 사람이 봐야 한다.
    if (fields.pnl !== undefined && fields.pnl_pct !== undefined && fields.notional) {
      const implied = fields.pnl / fields.notional;
      // 손익률은 명목가가 아니라 증거금 기준이라 값 자체는 다르다 — 부호만 대조한다.
      if (Math.sign(implied) !== Math.sign(fields.pnl_pct)) suspect.push("pnl");
    }

    const required = [fields.symbol, fields.side, fields.pnl, price];
    const filled = required.filter((v) => v !== undefined).length;

    return {
      fields,
      confidence: filled / required.length,
      suspect: [...new Set(suspect)],
      notes,
      adapter: "okx",
    };
  },
};

export type { ExtractResult };
