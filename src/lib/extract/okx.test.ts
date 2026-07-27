import { describe, expect, it } from "vitest";

import { okxAdapter } from "@/lib/extract/okx";

/**
 * OKX 모바일 `Order details`(청산 주문) 화면을 OCR이 읽어냈을 때 나오는 텍스트.
 *
 * 실제 캡쳐에서 그대로 옮겼고, 주문번호만 0으로 가렸다(공개 저장소이고
 * 파싱 계약과는 무관한 식별자라서).
 */
const OKX_CLOSE_LONG = `15:09
Order details

BTCUSDT Perp
Close long Cross 100x
Trade

Status Filled
Order type Limit order
Order amount 8,494.16 USDT
Order price ₮65,390
Filled 8,494.16 USDT
Fill price ₮65,390
Order value $8,486.01
Reduce-only Yes

Closed PnL 35.31 USDT
Closed PnL% 41.75%
Fee -1.27412415 USDT
Creation time 07/27, 10:48:15
Order number 0000000000000000000

Fill details
Amount (USDT) Price (USDT) Fee (USDT)
8,494.16 65,390 -1.27412415
07/27/2026, 13:20:35`;

describe("OKX 어댑터 — Order details(청산) 화면", () => {
  const result = okxAdapter.parse(OKX_CLOSE_LONG);

  it("자기 화면임을 알아본다", () => {
    expect(okxAdapter.detect(OKX_CLOSE_LONG)).toBeGreaterThan(0.8);
    expect(okxAdapter.detect("러닝 3.27km 5'35\"")).toBeLessThan(0.3);
  });

  it("종목은 기초자산만 남긴다 (BTCUSDT Perp → BTC)", () => {
    expect(result.fields.symbol).toBe("BTC");
  });

  it("`Close long`에서 방향과 주문 역할을 읽는다", () => {
    expect(result.fields.side).toBe("long");
    expect(result.fields.orderRole).toBe("close");
  });

  it("레버리지 100x를 읽는다", () => {
    expect(result.fields.leverage).toBe(100);
  });

  it("₮는 원화가 아니라 테더 기호다 — 65,390으로 읽어야 한다", () => {
    expect(result.fields.exit_price).toBe(65390);
  });

  it("`Order price`가 아니라 실제 체결가 `Fill price`를 청산가로 쓴다", () => {
    const orderPriceDiffers = OKX_CLOSE_LONG.replace("Order price ₮65,390", "Order price ₮65,000");
    expect(okxAdapter.parse(orderPriceDiffers).fields.exit_price).toBe(65390);
  });

  it("손익·수수료·명목가를 읽는다", () => {
    expect(result.fields.pnl).toBe(35.31);
    expect(result.fields.fee).toBeCloseTo(-1.27412415, 8);
    expect(result.fields.notional).toBe(8486.01);
  });

  it("`Closed PnL%`를 `Closed PnL`로 잘못 읽지 않는다", () => {
    expect(result.fields.pnl).toBe(35.31);
    expect(result.fields.pnl_pct).toBeCloseTo(0.4175, 6);
  });

  it("연도가 있는 Fill details 타임스탬프를 청산 시각으로 쓴다 (KST → UTC)", () => {
    // 2026-07-27 13:20:35 KST == 04:20:35Z
    expect(result.fields.exit_at).toBe("2026-07-27T04:20:35.000Z");
  });

  it("청산 캡쳐엔 진입 정보가 없다는 사실을 알린다", () => {
    expect(result.fields.entry_price).toBeUndefined();
    expect(result.fields.entry_at).toBeUndefined();
    expect(result.suspect).toContain("entry_price");
    expect(result.suspect).toContain("entry_at");
    expect(result.notes.join(" ")).toContain("진입가와 진입 시각은 이 화면에 없습니다");
  });

  it("연도 없는 `Creation time`을 가정했다고 알린다", () => {
    expect(result.notes.join(" ")).toMatch(/연도가 없어 \d{4}년으로 가정/);
  });

  it("필수 항목이 다 찼으므로 신뢰도가 높다", () => {
    expect(result.confidence).toBe(1);
  });

  it("`Cross 100x` 배지에서 마진 모드를 읽는다 — 청산 위험이 달라 복기 축이 된다", () => {
    expect(result.fields.marginMode).toBe("cross");
    expect(okxAdapter.parse(OKX_CLOSE_LONG.replace("Cross", "Isolated")).fields.marginMode).toBe(
      "isolated",
    );
  });

  it("주문번호를 체결로 남긴다 — 포지션 캡쳐와 같은 거래인지 알아보는 열쇠", () => {
    const fills = result.fields.fills ?? [];
    expect(fills).toHaveLength(1);
    expect(fills[0].role).toBe("close");
    expect(fills[0].orderNo).toMatch(/^\d{6,}$/);
  });
});

describe("OKX 어댑터 — 진입 주문 화면", () => {
  const openShort = OKX_CLOSE_LONG.replace("Close long", "Open short").replace(
    "Closed PnL 35.31 USDT",
    "",
  );
  const result = okxAdapter.parse(openShort);

  it("가격을 진입가 쪽에 넣는다", () => {
    expect(result.fields.side).toBe("short");
    expect(result.fields.orderRole).toBe("open");
    expect(result.fields.entry_price).toBe(65390);
    expect(result.fields.exit_price).toBeUndefined();
  });

  it("손익이 없으므로 신뢰도가 떨어지고 확인 대상에 오른다", () => {
    expect(result.confidence).toBeLessThan(1);
    expect(result.suspect).toContain("pnl");
  });
});

describe("OKX 어댑터 — 읽기 실패", () => {
  it("방향을 못 읽으면 가격을 아무 쪽에도 넣지 않는다", () => {
    const noRole = OKX_CLOSE_LONG.replace("Close long Cross 100x", "Cross 100x");
    const result = okxAdapter.parse(noRole);

    expect(result.fields.side).toBeUndefined();
    expect(result.fields.entry_price).toBeUndefined();
    expect(result.fields.exit_price).toBeUndefined();
    expect(result.suspect).toContain("side");
    expect(result.confidence).toBeLessThan(1);
  });
});
