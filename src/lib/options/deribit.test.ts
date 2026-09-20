import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  fetchDeribitIndexPrice,
  fetchDeribitOptions,
  fetchDvol,
  parseBookSummary,
  parseDeribitIndexPrice,
  parseDeribitInstrumentName,
  parseDvol,
} from "@/lib/options/deribit";

/** 2026-09-18 12:00 UTC — 실측일. 만기 필터의 기준 시각. */
const NOW = Date.UTC(2026, 8, 18, 12);

/** 실측 한 행을 줄인 것 — 값은 숫자로 오고 high/low/price_change 에 null 이 섞인다. */
function bookRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    high: null,
    low: null,
    last: 0.041,
    instrument_name: "BTC-27NOV26-73000-P",
    bid_price: 0.0315,
    ask_price: 0.0325,
    open_interest: 31.5,
    mark_price: 0.03203522,
    interest_rate: 0,
    creation_timestamp: 1789737224272,
    estimated_delivery_price: 77942.96,
    price_change: null,
    volume: 0,
    mark_iv: 36.62,
    underlying_price: 78668.03,
    underlying_index: "BTC-27NOV26",
    base_currency: "BTC",
    quote_currency: "BTC",
    volume_usd: 0,
    mid_price: 0.032,
    ...overrides,
  };
}

function envelope(result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", result, usIn: 1, usOut: 2, usDiff: 1, testnet: false };
}

/** 실측 오류 봉투 — 잘못된 파라미터. */
const ERROR_ENVELOPE = {
  jsonrpc: "2.0",
  error: { code: -32602, data: { reason: "invalid currency", param: "currency" }, message: "Invalid params" },
  testnet: false,
};

describe("parseDeribitInstrumentName — 종목 코드에서 만기·행사가·종류를 편다", () => {
  it("한 자리 일자(2OCT26)", () => {
    expect(parseDeribitInstrumentName("BTC-2OCT26-80000-C")).toEqual({
      expiry: "2026-10-02",
      expiryMs: Date.UTC(2026, 9, 2, 8),
      strike: 80000,
      type: "C",
    });
  });

  it("두 자리 일자와 풋", () => {
    expect(parseDeribitInstrumentName("BTC-25SEP26-80000-P")).toEqual({
      expiry: "2026-09-25",
      expiryMs: Date.UTC(2026, 8, 25, 8),
      strike: 80000,
      type: "P",
    });
  });

  it("만기 시각은 08:00 UTC 다 — OKX 와 같은 날짜 키로 합쳐지는 근거", () => {
    const parsed = parseDeribitInstrumentName("BTC-25JUN27-120000-C");
    expect(parsed).not.toBeNull();
    const at = new Date(parsed!.expiryMs);
    expect([at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()]).toEqual([2027, 5, 25]);
    expect(at.getUTCHours()).toBe(8);
    expect(at.getUTCMinutes()).toBe(0);
  });

  it("형식이 다르면 null", () => {
    expect(parseDeribitInstrumentName("BTC-USD-260925-80000-C")).toBeNull(); // OKX 형식
    expect(parseDeribitInstrumentName("BTC-25SEP26-80000-X")).toBeNull(); // 종류
    expect(parseDeribitInstrumentName("BTC-25XYZ26-80000-C")).toBeNull(); // 월
    expect(parseDeribitInstrumentName("BTC-31SEP26-80000-C")).toBeNull(); // 달력에 없는 날
    expect(parseDeribitInstrumentName("ETH-25SEP26-3000-C")).toBeNull(); // 다른 코인
    expect(parseDeribitInstrumentName("BTC-PERPETUAL")).toBeNull();
    expect(parseDeribitInstrumentName("")).toBeNull();
  });
});

describe("parseBookSummary — 북 요약을 OptionRow 로 정규화한다", () => {
  it("IV 는 소수로, forward 는 underlying_price, 거래량은 volume", () => {
    const rows = parseBookSummary(envelope([bookRow({ volume: 12.3 })]), NOW);

    expect(rows).toEqual([
      {
        venue: "deribit",
        instId: "BTC-27NOV26-73000-P",
        expiry: "2026-11-27",
        expiryMs: Date.UTC(2026, 10, 27, 8),
        strike: 73000,
        type: "P",
        oi: 31.5,
        vol24h: 12.3,
        markIv: expect.closeTo(0.3662, 10),
        forward: 78668.03,
      },
    ]);
  });

  it("OI 0 과 만기가 지난 종목은 뺀다", () => {
    const rows = parseBookSummary(
      envelope([
        bookRow({ instrument_name: "BTC-25SEP26-80000-C", open_interest: 0 }),
        bookRow({ instrument_name: "BTC-11SEP26-80000-C", open_interest: 5 }), // 지난 만기
        bookRow({ instrument_name: "BTC-18SEP26-80000-C", open_interest: 5 }), // 오늘 08:00 — 이미 정산
        bookRow({ instrument_name: "BTC-19SEP26-80000-C", open_interest: 5 }),
      ]),
      NOW,
    );

    expect(rows.map((row) => row.instId)).toEqual(["BTC-19SEP26-80000-C"]);
  });

  it("IV 가 0 이거나 없으면 null — 0% 변동성이 아니라 값 없음이다", () => {
    const rows = parseBookSummary(
      envelope([
        bookRow({ instrument_name: "BTC-25SEP26-80000-C", mark_iv: 0 }),
        bookRow({ instrument_name: "BTC-25SEP26-90000-C", mark_iv: null }),
        bookRow({ instrument_name: "BTC-25SEP26-70000-C", underlying_price: null }),
      ]),
      NOW,
    );

    expect(rows.map((row) => row.markIv)).toEqual([null, null, expect.closeTo(0.3662, 10)]);
    expect(rows[2].forward).toBeNull();
  });

  it("종목 코드가 이상한 행은 건너뛴다", () => {
    const rows = parseBookSummary(
      envelope([bookRow({ instrument_name: "BTC-PERPETUAL" }), bookRow({ instrument_name: 7 })]),
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("오류 봉투면 throw, 봉투가 아니면 빈 목록", () => {
    expect(() => parseBookSummary(ERROR_ENVELOPE, NOW)).toThrow("Deribit 오류: Invalid params");
    expect(parseBookSummary(null, NOW)).toEqual([]);
    expect(parseBookSummary(envelope("nope"), NOW)).toEqual([]);
  });
});

describe("parseDvol — 마지막 봉의 종가를 소수로", () => {
  it("실측 모양: [ts, open, high, low, close] 오래된 것부터", () => {
    const json = envelope({
      data: [
        [1789650000000, 34.19, 35.26, 34.19, 34.25],
        [1789736400000, 34.15, 34.15, 34.03, 34.15],
      ],
      continuation: null,
    });
    expect(parseDvol(json)).toBeCloseTo(0.3415, 10);
  });

  it("비어 있거나 오류 봉투", () => {
    expect(parseDvol(envelope({ data: [], continuation: null }))).toBeNull();
    expect(parseDvol(envelope({}))).toBeNull();
    expect(() => parseDvol(ERROR_ENVELOPE)).toThrow("Deribit 오류: Invalid params");
  });
});

describe("parseDeribitIndexPrice", () => {
  it("실측 모양", () => {
    expect(
      parseDeribitIndexPrice(envelope({ estimated_delivery_price: 78026.79, index_price: 78026.79 })),
    ).toBe(78026.79);
    expect(parseDeribitIndexPrice(envelope({}))).toBeNull();
    expect(() => parseDeribitIndexPrice(ERROR_ENVELOPE)).toThrow("Deribit 오류: Invalid params");
  });
});

describe("fetch* — HTTP 상태와 요청 모양", () => {
  function stubFetch(status: number, body: unknown): Mock<typeof fetch> {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: status < 400, status, json: async () => body } as unknown as Response);
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("!ok 면 상태 코드로 throw — 실측상 잘못된 파라미터는 400 으로 먼저 걸린다", async () => {
    stubFetch(400, ERROR_ENVELOPE);
    await expect(fetchDeribitIndexPrice()).rejects.toThrow("Deribit 응답 오류 400");
  });

  it("지수가 — 요청 URL 과 옵션", async () => {
    const mock = stubFetch(200, envelope({ index_price: 78026.79 }));
    await expect(fetchDeribitIndexPrice()).resolves.toBe(78026.79);

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd");
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(init?.next).toEqual({ revalidate: 60 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("옵션 목록 — nowMs 를 넘겨 만기 필터가 그 시각 기준으로 돈다", async () => {
    const mock = stubFetch(
      200,
      envelope([bookRow({ instrument_name: "BTC-19SEP26-80000-C" }), bookRow({ open_interest: 0 })]),
    );
    const rows = await fetchDeribitOptions(NOW);

    expect(mock.mock.calls[0][0]).toBe(
      "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",
    );
    expect(rows.map((row) => row.instId)).toEqual(["BTC-19SEP26-80000-C"]);
  });

  it("DVOL — 창은 최근 24h, 끝은 분 단위로 내린다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 42_345); // 12:00:42.345 UTC
    const mock = stubFetch(200, envelope({ data: [[NOW, 34, 34, 34, 34.15]], continuation: null }));

    await expect(fetchDvol()).resolves.toBeCloseTo(0.3415, 10);

    const url = String(mock.mock.calls[0][0]);
    expect(url).toBe(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${NOW - 86_400_000}&end_timestamp=${NOW}`,
    );
  });
});
