import { describe, expect, it } from "vitest";

import {
  parseDailyCloses,
  parseOkxHistory,
  parseOkxIndexPrice,
  parseOkxInstId,
  parseOkxOptionRows,
  parseTakerBlock,
} from "@/lib/options/okx";

/** 2026-09-18 00:00 UTC — 픽스처의 만기(9/17 지남, 9/19·9/25 남음)를 가르는 기준. */
const NOW = Date.UTC(2026, 8, 18);

describe("parseOkxInstId — OKX 종목 코드를 만기·행사가·종류로 편다", () => {
  it("콜: 만기는 UTC 날짜와 08:00 정산 시각, 행사가는 숫자", () => {
    expect(parseOkxInstId("BTC-USD-260925-80000-C")).toEqual({
      expiry: "2026-09-25",
      expiryMs: Date.UTC(2026, 8, 25, 8),
      strike: 80000,
      type: "C",
    });
  });

  it("풋도 같은 규칙", () => {
    expect(parseOkxInstId("BTC-USD-270326-85000-P")).toEqual({
      expiry: "2027-03-26",
      expiryMs: Date.UTC(2027, 2, 26, 8),
      strike: 85000,
      type: "P",
    });
  });

  it("형식이 다르면 null — 무기한·빈 문자열·종류가 C/P 가 아닌 것", () => {
    expect(parseOkxInstId("BTC-USDT-SWAP")).toBeNull();
    expect(parseOkxInstId("")).toBeNull();
    expect(parseOkxInstId("BTC-USD-260925-80000-X")).toBeNull();
    expect(parseOkxInstId("BTC-USD-2609-80000-C")).toBeNull();
  });
});

describe("parseOkxOptionRows — 세 응답을 instId 로 조인한다", () => {
  // 실측(2026-09-18) 응답에서 줄인 픽스처 — 값은 전부 문자열이다.
  const oi = {
    code: "0",
    data: [
      { instId: "BTC-USD-260903-72000-C", instType: "OPTION", oi: "0", oiCcy: "0", oiUsd: "0" },
      { instId: "BTC-USD-260917-76000-C", instType: "OPTION", oi: "310", oiCcy: "3.1", oiUsd: "241800" },
      { instId: "BTC-USD-260919-66000-P", instType: "OPTION", oi: "5420", oiCcy: "54.2", oiUsd: "4228944.16" },
      { instId: "BTC-USD-260925-80000-C", instType: "OPTION", oi: "1200", oiCcy: "12", oiUsd: "936000" },
      { instId: "BTC-USD-260925-70000-P", instType: "OPTION", oi: "800", oiCcy: "8", oiUsd: "624000" },
      { instId: "BTC-USDT-SWAP", instType: "SWAP", oi: "100", oiCcy: "1", oiUsd: "78000" },
    ],
  };
  const summary = {
    code: "0",
    data: [
      { instId: "BTC-USD-260919-66000-P", markVol: "0.5210", fwdPx: "78030.5", delta: "-0.02" },
      { instId: "BTC-USD-260925-80000-C", markVol: "0.37883571136884225", fwdPx: "78120.25" },
      // 만기 직전 종목처럼 IV 가 0 으로 찍힌 행 — 값 없음으로 본다.
      { instId: "BTC-USD-260925-70000-P", markVol: "0", fwdPx: "" },
    ],
  };
  const tickers = {
    code: "0",
    data: [
      { instId: "BTC-USD-260919-66000-P", last: "0.0011", volCcy24h: "25.25", vol24h: "2525" },
      { instId: "BTC-USD-260925-80000-C", last: "", volCcy24h: "0", vol24h: "0" },
    ],
  };

  const rows = parseOkxOptionRows({ oi, summary, tickers }, NOW);
  const byId = new Map(rows.map((row) => [row.instId, row]));

  it("OI 0 · 만기 지난 것 · 형식이 다른 종목은 빠진다", () => {
    expect(rows.map((row) => row.instId)).toEqual([
      "BTC-USD-260919-66000-P",
      "BTC-USD-260925-80000-C",
      "BTC-USD-260925-70000-P",
    ]);
  });

  it("OI 는 계약수가 아니라 oiCcy(BTC), 거래량은 volCcy24h(BTC)", () => {
    const put = byId.get("BTC-USD-260919-66000-P");
    expect(put?.oi).toBe(54.2);
    expect(put?.vol24h).toBe(25.25);
    expect(put?.markIv).toBe(0.521);
    expect(put?.forward).toBe(78030.5);
    expect(put).toMatchObject({
      venue: "okx",
      expiry: "2026-09-19",
      expiryMs: Date.UTC(2026, 8, 19, 8),
      strike: 66000,
      type: "P",
    });
  });

  it("거래량 0 은 0 으로 남는다 — 못 받은 것과 다르다", () => {
    expect(byId.get("BTC-USD-260925-80000-C")?.vol24h).toBe(0);
  });

  it("markVol 이 0 이거나 fwdPx 가 빈 문자열이면 null, tickers 에 없으면 vol24h 도 null", () => {
    const put = byId.get("BTC-USD-260925-70000-P");
    expect(put?.markIv).toBeNull();
    expect(put?.forward).toBeNull();
    expect(put?.vol24h).toBeNull();
    expect(put?.oi).toBe(8);
  });

  it("응답이 봉투 모양이 아니면 빈 배열", () => {
    expect(parseOkxOptionRows({ oi: null, summary: {}, tickers: [] }, NOW)).toEqual([]);
  });
});

describe("parseOkxHistory — 두 rubik 이력을 ts 로 조인한다", () => {
  // 실측 모양: 최신이 먼저, [ts, oi(BTC), vol(BTC)] / [ts, 풋콜 OI 비, 풋콜 거래량 비].
  const oiVol = {
    code: "0",
    data: [
      ["1789718400000", "37839.04", "1351.01"],
      ["1789689600000", "37433", "761.71"],
      ["1789660800000", "37066.56", "3417.67"],
    ],
  };
  const ratio = {
    code: "0",
    data: [
      ["1789718400000", "0.8896", "0.8606"],
      ["1789689600000", "0.8981", "0.618"],
      // 한쪽에만 있는 ts — 버려야 한다.
      ["1789632000000", "0.9045", "0.9512"],
    ],
  };

  it("오래된 것부터 정렬되고, 한쪽에만 있는 ts 는 빠지며, OKX 의 콜/풋 비율은 풋/콜로 뒤집힌다", () => {
    expect(parseOkxHistory(oiVol, ratio)).toEqual([
      { t: 1789689600000, oi: 37433, vol: 761.71, pcrOi: 1 / 0.8981, pcrVol: 1 / 0.618 },
      { t: 1789718400000, oi: 37839.04, vol: 1351.01, pcrOi: 1 / 0.8896, pcrVol: 1 / 0.8606 },
    ]);
  });

  it("비율이 0 인 행은 비율이 아니라 버린다", () => {
    const zero = { code: "0", data: [["1789718400000", "0", "0.8606"]] };
    expect(parseOkxHistory(oiVol, zero)).toEqual([]);
  });

  it("한쪽이 비면 빈 배열", () => {
    expect(parseOkxHistory(oiVol, { code: "0", data: [] })).toEqual([]);
    expect(parseOkxHistory(null, ratio)).toEqual([]);
  });
});

describe("parseTakerBlock — 납작한 배열과 2차원 배열 둘 다 읽는다", () => {
  const expected = {
    ts: 1789660800000,
    callBuy: 909.49,
    callSell: 915.33,
    putBuy: 1008.95,
    putSell: 848.755,
    callBlock: 3518.64,
    putBlock: 3587.29,
  };

  it("실측 모양 — data 가 납작한 배열 하나", () => {
    expect(
      parseTakerBlock({
        code: "0",
        data: ["1789660800000", "909.49", "915.33", "1008.95", "848.755", "3518.64", "3587.29"],
        msg: "",
      }),
    ).toEqual(expected);
  });

  it("문서 모양 — 2차원이면 첫 행", () => {
    expect(
      parseTakerBlock({
        code: "0",
        data: [
          ["1789660800000", "909.49", "915.33", "1008.95", "848.755", "3518.64", "3587.29"],
          ["1789574400000", "1", "2", "3", "4", "5", "6"],
        ],
      }),
    ).toEqual(expected);
  });

  it("칸이 모자라거나 숫자가 아니면 null", () => {
    expect(parseTakerBlock({ code: "0", data: ["1789660800000", "909.49"] })).toBeNull();
    expect(parseTakerBlock({ code: "0", data: ["ts", "1", "2", "3", "4", "5", "6"] })).toBeNull();
    expect(parseTakerBlock({ code: "0", data: [] })).toBeNull();
    expect(parseTakerBlock(null)).toBeNull();
  });
});

describe("parseDailyCloses — 마감 봉 종가만, 오래된 것부터", () => {
  it("confirm 0 인 진행 중 봉은 빼고 순서를 뒤집는다", () => {
    const json = {
      code: "0",
      data: [
        ["1789660800000", "76750", "78456.1", "76217.7", "78059.9", "5434558.67", "54345.5867", "4208788992.14", "0"],
        ["1789574400000", "75750.2", "77137", "75000", "76750", "9076412.87", "90764.1287", "6915633979.08", "1"],
        ["1789488000000", "76474.1", "77324.9", "74896.6", "75750.2", "8505799.71", "85057.9971", "6457732471.16", "1"],
        ["1789401600000", "78536.7", "79569", "75557", "76474", "10001876.01", "100018.7601", "7733732356.30", "1"],
      ],
    };
    expect(parseDailyCloses(json)).toEqual([76474, 75750.2, 76750]);
  });

  it("봉투가 아니면 빈 배열", () => {
    expect(parseDailyCloses({ code: "0", data: [] })).toEqual([]);
    expect(parseDailyCloses(undefined)).toEqual([]);
  });
});

describe("parseOkxIndexPrice — 지수가", () => {
  it("문자열 idxPx 를 숫자로", () => {
    expect(
      parseOkxIndexPrice({
        code: "0",
        data: [{ instId: "BTC-USD", idxPx: "78024.1", high24h: "78413.9", ts: "1789738051412" }],
      }),
    ).toBe(78024.1);
  });

  it("행이 없거나 봉투가 아니면 null", () => {
    expect(parseOkxIndexPrice({ code: "0", data: [] })).toBeNull();
    expect(parseOkxIndexPrice(null)).toBeNull();
  });
});
