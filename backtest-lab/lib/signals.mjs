/**
 * 진입 신호 31계열 × 롱/숏 미러 = 62. 그리고 국면 필터 4종.
 *
 * 설계 원칙 셋:
 *  ① 모든 신호는 "상태"가 아니라 "전환"이다 — RSI<30 이 아니라 30을 되밟고 올라올 때.
 *    상태 신호는 같은 국면에서 수백 번 켜져 표본이 부풀고 통계가 거짓말을 한다.
 *  ② 숏은 롱의 기계적 미러다. 숏만 따로 튜닝하면 그 자체가 과적합이다.
 *  ③ 판정은 봉 i 마감 기준. i+1 이후를 참조하는 순간 백테스트는 무효다.
 */
import * as ta from "./indicators.mjs";

/** 봉 하나에 필요한 지표를 전부 미리 계산한다 — 4,464회 재계산을 막는 곳. */
export function buildContext(candles, htfCandles, htfMs, d1Candles, d1Ms, dayBars) {
  const closes = candles.map((b) => b.c);
  const highs = candles.map((b) => b.h);
  const lows = candles.map((b) => b.l);
  const vols = candles.map((b) => b.v);

  const bb = ta.bollinger(closes, 20, 2);
  const kc = ta.keltner(candles, closes, 20, 1.5);
  const md = ta.macd(closes);
  const st = ta.supertrend(candles, 10, 3);
  const dmi = ta.adx(candles, 14);
  const ps = ta.psar(candles);
  const ich = ta.ichimoku(candles);
  const ar = ta.aroon(candles, 25);
  const vx = ta.vortex(candles, 14);
  const srsi = ta.stochRsi(closes, 14);
  const ts = ta.tsi(closes);
  const ov = ta.obv(candles);
  const atr14 = ta.atr(candles, 14);

  const ctx = {
    candles,
    n: candles.length,
    closes,
    o: candles.map((b) => b.o),
    h: highs,
    l: lows,
    v: vols,
    atr: atr14,
    atrMA: ta.sma(atr14.map((x) => x ?? 0), 100),
    ema20: ta.ema(closes, 20),
    ema50: ta.ema(closes, 50),
    sma200: ta.sma(closes, 200),
    rsi: ta.rsi(closes, 14),
    macdLine: md.line,
    macdSig: md.signal,
    bbUp: bb.up,
    bbLo: bb.lo,
    bbMid: bb.mid,
    bbW: bb.width,
    kcUp: kc.up,
    kcLo: kc.lo,
    stDir: st.dir,
    adx: dmi.adx,
    pDI: dmi.plusDI,
    mDI: dmi.minusDI,
    psarDir: ps.dir,
    tenkan: ich.tenkan,
    kijun: ich.kijun,
    spanA: ich.spanA,
    spanB: ich.spanB,
    aroonUp: ar.up,
    aroonDn: ar.down,
    viP: vx.plus,
    viM: vx.minus,
    srsiK: srsi.k,
    srsiD: srsi.d,
    cci: ta.cci(candles, 20),
    wr: ta.williamsR(candles, 14),
    roc: ta.roc(closes, 10),
    tsiLine: ts.line,
    tsiSig: ts.signal,
    fisher: ta.fisher(candles, 9),
    ultosc: ta.ultOsc(candles),
    obv: ov,
    obvHH: ta.rollingExtreme(ov, 20, true),
    obvLL: ta.rollingExtreme(ov, 20, false),
    mfi: ta.mfi(candles, 14),
    cmf: ta.cmf(candles, 20),
    vwap: ta.rollingVwap(candles, Math.max(20, dayBars)),
    dcHigh: ta.rollingExtreme(highs, 20, true),
    dcLow: ta.rollingExtreme(lows, 20, false),
    z: ta.rollingZ(closes, 48),
    volMA: ta.sma(vols, 20),
    pivHH: ta.rollingExtreme(highs, 10, true),
    pivLL: ta.rollingExtreme(lows, 10, false),
  };

  // 상위봉 정렬 — 마감 완료된 상위봉만 본다.
  const attachHtf = (name, htfC, ms) => {
    if (!htfC?.length) {
      ctx[`${name}Up`] = new Array(candles.length).fill(null);
      return;
    }
    const map = ta.htfIndexMap(candles, htfC, ms);
    const hCloses = htfC.map((b) => b.c);
    const hFast = ta.ema(hCloses, 20);
    const hSlow = ta.ema(hCloses, 50);
    const up = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i += 1) {
      const j = map[i];
      if (j < 0 || hFast[j] === null || hSlow[j] === null) continue;
      up[i] = hFast[j] > hSlow[j];
    }
    ctx[`${name}Up`] = up;
  };
  attachHtf("htf", htfCandles, htfMs);
  attachHtf("d1", d1Candles, d1Ms);

  // TTM 스퀴즈 — BB가 KC 안에 들어간 상태. 해제 순간이 신호다.
  const sq = new Array(candles.length).fill(false);
  for (let i = 0; i < candles.length; i += 1) {
    if (bb.up[i] === null || kc.up[i] === null) continue;
    sq[i] = bb.up[i] < kc.up[i] && bb.lo[i] > kc.lo[i];
  }
  ctx.ttmSqueeze = sq;

  return ctx;
}

const x = (v) => v !== null && v !== undefined;
/** 상향 교차 — 직전 봉은 아래(또는 같음), 이번 봉은 위. */
const crossUp = (a, b, i) => x(a[i - 1]) && x(b[i - 1]) && x(a[i]) && x(b[i]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a, b, i) => x(a[i - 1]) && x(b[i - 1]) && x(a[i]) && x(b[i]) && a[i - 1] >= b[i - 1] && a[i] < b[i];
/** 임계선 되밟기 — 밖에 있다가 안으로 복귀하는 순간. */
const reclaim = (s, i, lvl) => x(s[i - 1]) && x(s[i]) && s[i - 1] < lvl && s[i] >= lvl;
const lose = (s, i, lvl) => x(s[i - 1]) && x(s[i]) && s[i - 1] > lvl && s[i] <= lvl;

/**
 * 31계열. 각 항목은 long/short 함수 쌍을 갖는다.
 * `family` 는 리포트 분류용, `novel` 은 이 저장소 최초 검증 표시.
 */
export const FAMILIES = {
  "ema-cross": {
    family: "추세", name: "EMA 20/50 교차", rule: "EMA20이 EMA50을 상향(롱)·하향(숏) 교차 마감",
    long: (i, c) => crossUp(c.ema20, c.ema50, i),
    short: (i, c) => crossDn(c.ema20, c.ema50, i),
  },
  "macd-cross": {
    family: "추세", name: "MACD 시그널 교차", rule: "MACD(12,26,9) 라인이 시그널을 교차 마감",
    long: (i, c) => crossUp(c.macdLine, c.macdSig, i),
    short: (i, c) => crossDn(c.macdLine, c.macdSig, i),
  },
  "supertrend-flip": {
    family: "추세", name: "슈퍼트렌드 전환", rule: "Supertrend(10,3) 방향이 전환된 봉", novel: true,
    long: (i, c) => c.stDir[i - 1] === -1 && c.stDir[i] === 1,
    short: (i, c) => c.stDir[i - 1] === 1 && c.stDir[i] === -1,
  },
  "adx-di-cross": {
    family: "추세", name: "ADX 추세 개시", rule: "ADX(14)>20 이면서 +DI/−DI 교차 마감", novel: true,
    long: (i, c) => x(c.adx[i]) && c.adx[i] > 20 && crossUp(c.pDI, c.mDI, i),
    short: (i, c) => x(c.adx[i]) && c.adx[i] > 20 && crossDn(c.pDI, c.mDI, i),
  },
  "psar-flip": {
    family: "추세", name: "포물선 SAR 전환", rule: "Parabolic SAR(0.02,0.2) 점이 반대편으로 이동", novel: true,
    long: (i, c) => c.psarDir[i - 1] === -1 && c.psarDir[i] === 1,
    short: (i, c) => c.psarDir[i - 1] === 1 && c.psarDir[i] === -1,
  },
  "ichimoku-tk": {
    family: "추세", name: "일목 전환/기준 교차", rule: "전환선이 기준선 교차 + 종가가 구름 위(롱)·아래(숏)", novel: true,
    long: (i, c) => crossUp(c.tenkan, c.kijun, i) && x(c.spanA[i]) && x(c.spanB[i]) && c.closes[i] > Math.max(c.spanA[i], c.spanB[i]),
    short: (i, c) => crossDn(c.tenkan, c.kijun, i) && x(c.spanA[i]) && x(c.spanB[i]) && c.closes[i] < Math.min(c.spanA[i], c.spanB[i]),
  },
  "aroon-cross": {
    family: "추세", name: "아룬 교차", rule: "Aroon Up이 Aroon Down을 교차 마감", novel: true,
    long: (i, c) => crossUp(c.aroonUp, c.aroonDn, i),
    short: (i, c) => crossDn(c.aroonUp, c.aroonDn, i),
  },
  "vortex-cross": {
    family: "추세", name: "볼텍스 교차", rule: "VI+ 가 VI− 를 교차 마감", novel: true,
    long: (i, c) => crossUp(c.viP, c.viM, i),
    short: (i, c) => crossDn(c.viP, c.viM, i),
  },

  "rsi-revert": {
    family: "모멘텀", name: "RSI 과매도/과매수 복귀", rule: "RSI(14)가 30을 되밟고 상승(롱)·70을 되밟고 하락(숏)",
    long: (i, c) => reclaim(c.rsi, i, 30),
    short: (i, c) => lose(c.rsi, i, 70),
  },
  "stochrsi-cross": {
    family: "모멘텀", name: "스토캐스틱RSI 교차", rule: "StochRSI K가 D를 극단구간(<20·>80)에서 교차", novel: true,
    long: (i, c) => x(c.srsiK[i - 1]) && c.srsiK[i - 1] < 20 && crossUp(c.srsiK, c.srsiD, i),
    short: (i, c) => x(c.srsiK[i - 1]) && c.srsiK[i - 1] > 80 && crossDn(c.srsiK, c.srsiD, i),
  },
  "cci-revert": {
    family: "모멘텀", name: "CCI 극단 복귀", rule: "CCI(20)가 −100을 되밟고 상승(롱)·+100을 되밟고 하락(숏)", novel: true,
    long: (i, c) => reclaim(c.cci, i, -100),
    short: (i, c) => lose(c.cci, i, 100),
  },
  "williams-revert": {
    family: "모멘텀", name: "윌리엄스 %R 복귀", rule: "%R(14)이 −80 되밟고 상승(롱)·−20 되밟고 하락(숏)", novel: true,
    long: (i, c) => reclaim(c.wr, i, -80),
    short: (i, c) => lose(c.wr, i, -20),
  },
  "roc-thrust": {
    family: "모멘텀", name: "ROC 추진", rule: "ROC(10)이 +2%(롱)·−2%(숏) 선을 처음 넘는 봉", novel: true,
    long: (i, c) => reclaim(c.roc, i, 2),
    short: (i, c) => lose(c.roc, i, -2),
  },
  "tsi-cross": {
    family: "모멘텀", name: "TSI 시그널 교차", rule: "TSI(25,13) 라인이 시그널(7)을 교차 마감", novel: true,
    long: (i, c) => crossUp(c.tsiLine, c.tsiSig, i),
    short: (i, c) => crossDn(c.tsiLine, c.tsiSig, i),
  },
  "fisher-flip": {
    family: "모멘텀", name: "피셔 변환 부호 전환", rule: "Fisher Transform(9)이 0선을 통과", novel: true,
    long: (i, c) => reclaim(c.fisher, i, 0),
    short: (i, c) => lose(c.fisher, i, 0),
  },
  "ultosc-revert": {
    family: "모멘텀", name: "얼티밋 오실레이터 복귀", rule: "UO(7,14,28)가 35 되밟고 상승(롱)·65 되밟고 하락(숏)", novel: true,
    long: (i, c) => reclaim(c.ultosc, i, 35),
    short: (i, c) => lose(c.ultosc, i, 65),
  },

  "bb-breakout": {
    family: "변동성", name: "볼린저 밴드 이탈", rule: "종가가 BB(20,2σ) 상단 밖(롱)·하단 밖(숏) 마감, 직전 봉은 안쪽",
    long: (i, c) => x(c.bbUp[i]) && x(c.bbUp[i - 1]) && c.closes[i - 1] <= c.bbUp[i - 1] && c.closes[i] > c.bbUp[i],
    short: (i, c) => x(c.bbLo[i]) && x(c.bbLo[i - 1]) && c.closes[i - 1] >= c.bbLo[i - 1] && c.closes[i] < c.bbLo[i],
  },
  "bb-revert": {
    family: "변동성", name: "볼린저 밴드 회귀", rule: "밴드 밖에서 안으로 복귀한 봉 — 이탈의 반대 가설",
    long: (i, c) => x(c.bbLo[i]) && x(c.bbLo[i - 1]) && c.closes[i - 1] < c.bbLo[i - 1] && c.closes[i] >= c.bbLo[i],
    short: (i, c) => x(c.bbUp[i]) && x(c.bbUp[i - 1]) && c.closes[i - 1] > c.bbUp[i - 1] && c.closes[i] <= c.bbUp[i],
  },
  "keltner-break": {
    family: "변동성", name: "켈트너 채널 이탈", rule: "종가가 KC(20,1.5×ATR) 밖으로 마감", novel: true,
    long: (i, c) => x(c.kcUp[i]) && x(c.kcUp[i - 1]) && c.closes[i - 1] <= c.kcUp[i - 1] && c.closes[i] > c.kcUp[i],
    short: (i, c) => x(c.kcLo[i]) && x(c.kcLo[i - 1]) && c.closes[i - 1] >= c.kcLo[i - 1] && c.closes[i] < c.kcLo[i],
  },
  "donchian-break": {
    family: "변동성", name: "돈치안 20봉 돌파", rule: "종가가 직전 20봉 최고(롱)·최저(숏) 돌파 마감",
    long: (i, c) => x(c.dcHigh[i]) && c.closes[i] > c.dcHigh[i],
    short: (i, c) => x(c.dcLow[i]) && c.closes[i] < c.dcLow[i],
  },
  "ttm-squeeze": {
    family: "변동성", name: "TTM 스퀴즈 해제", rule: "BB가 KC 안에 들어간 수축이 풀리는 봉 + 모멘텀 방향", novel: true,
    long: (i, c) => c.ttmSqueeze[i - 1] && !c.ttmSqueeze[i] && x(c.macdLine[i]) && c.macdLine[i] > 0,
    short: (i, c) => c.ttmSqueeze[i - 1] && !c.ttmSqueeze[i] && x(c.macdLine[i]) && c.macdLine[i] < 0,
  },
  "atr-expansion": {
    family: "변동성", name: "ATR 확장 + 방향봉", rule: "ATR이 100봉 평균을 상향 돌파하는 봉의 몸통 방향", novel: true,
    long: (i, c) => x(c.atr[i]) && x(c.atrMA[i]) && c.atr[i - 1] <= c.atrMA[i - 1] && c.atr[i] > c.atrMA[i] && c.closes[i] > c.o[i],
    short: (i, c) => x(c.atr[i]) && x(c.atrMA[i]) && c.atr[i - 1] <= c.atrMA[i - 1] && c.atr[i] > c.atrMA[i] && c.closes[i] < c.o[i],
  },

  "obv-break": {
    family: "거래량", name: "OBV 20봉 돌파", rule: "OBV가 직전 20봉 극값 돌파 + 종가 방향 일치", novel: true,
    long: (i, c) => x(c.obvHH[i]) && c.obv[i] > c.obvHH[i] && c.closes[i] > c.closes[i - 1],
    short: (i, c) => x(c.obvLL[i]) && c.obv[i] < c.obvLL[i] && c.closes[i] < c.closes[i - 1],
  },
  "mfi-revert": {
    family: "거래량", name: "MFI 극단 복귀", rule: "MFI(14)가 20 되밟고 상승(롱)·80 되밟고 하락(숏)", novel: true,
    long: (i, c) => reclaim(c.mfi, i, 20),
    short: (i, c) => lose(c.mfi, i, 80),
  },
  "cmf-flip": {
    family: "거래량", name: "CMF 0선 통과", rule: "Chaikin Money Flow(20)가 0선을 통과", novel: true,
    long: (i, c) => reclaim(c.cmf, i, 0),
    short: (i, c) => lose(c.cmf, i, 0),
  },
  "vwap-reclaim": {
    family: "거래량", name: "VWAP 탈환/상실", rule: "종가가 롤링 VWAP(1일)을 아래→위(롱)·위→아래(숏)로 통과", novel: true,
    long: (i, c) => x(c.vwap[i]) && x(c.vwap[i - 1]) && c.closes[i - 1] < c.vwap[i - 1] && c.closes[i] >= c.vwap[i],
    short: (i, c) => x(c.vwap[i]) && x(c.vwap[i - 1]) && c.closes[i - 1] > c.vwap[i - 1] && c.closes[i] <= c.vwap[i],
  },
  "volspike-cont": {
    family: "거래량", name: "거래량 급증 추종", rule: "거래량 ≥2×MA20 + 몸통 60% 이상 방향봉",
    long: (i, c) => {
      if (!x(c.volMA[i]) || c.v[i] < 2 * c.volMA[i]) return false;
      const b = c.candles[i];
      const r = b.h - b.l;
      return r > 0 && b.c > b.o && (b.c - b.o) / r >= 0.6;
    },
    short: (i, c) => {
      if (!x(c.volMA[i]) || c.v[i] < 2 * c.volMA[i]) return false;
      const b = c.candles[i];
      const r = b.h - b.l;
      return r > 0 && b.c < b.o && (b.o - b.c) / r >= 0.6;
    },
  },

  "inside-bar": {
    family: "구조", name: "인사이드바 돌파", rule: "인사이드바 형성 후 종가가 모봉 고가 위(롱)·저가 아래(숏)",
    long: (i, c) =>
      i >= 2 && c.h[i - 1] < c.h[i - 2] && c.l[i - 1] > c.l[i - 2] && c.closes[i] > c.h[i - 2],
    short: (i, c) =>
      i >= 2 && c.h[i - 1] < c.h[i - 2] && c.l[i - 1] > c.l[i - 2] && c.closes[i] < c.l[i - 2],
  },
  "big-bar": {
    family: "구조", name: "장대봉 추종", rule: "범위 ≥2.5×ATR, 몸통 70% 이상, 직전 봉 극값 돌파",
    long: (i, c) => {
      if (!x(c.atr[i])) return false;
      const b = c.candles[i];
      const r = b.h - b.l;
      return r >= 2.5 * c.atr[i] && r > 0 && b.c > b.o && (b.c - b.o) / r >= 0.7 && b.c > c.h[i - 1];
    },
    short: (i, c) => {
      if (!x(c.atr[i])) return false;
      const b = c.candles[i];
      const r = b.h - b.l;
      return r >= 2.5 * c.atr[i] && r > 0 && b.c < b.o && (b.o - b.c) / r >= 0.7 && b.c < c.l[i - 1];
    },
  },
  "pivot-hh": {
    family: "구조", name: "고점 갱신 구조", rule: "종가가 직전 10봉 고점 돌파 + 종가>EMA50(롱), 미러(숏)", novel: true,
    long: (i, c) => x(c.pivHH[i]) && x(c.ema50[i]) && c.closes[i] > c.pivHH[i] && c.closes[i] > c.ema50[i],
    short: (i, c) => x(c.pivLL[i]) && x(c.ema50[i]) && c.closes[i] < c.pivLL[i] && c.closes[i] < c.ema50[i],
  },
  "zscore-revert": {
    family: "구조", name: "z-스코어 과이격 복귀", rule: "종가 z(48)가 −2를 되밟고 상승(롱)·+2를 되밟고 하락(숏)",
    long: (i, c) => reclaim(c.z, i, -2),
    short: (i, c) => lose(c.z, i, 2),
  },
};

/** 국면 필터 — 신호를 만들지 않고 거르기만 한다. */
export const FILTERS = {
  f0: { name: "무필터", desc: "신호 원시값", fn: () => true },
  f1: {
    name: "상위봉 정렬",
    desc: "15m·1H는 4H, 4H는 1D의 EMA20/50 방향이 매매 방향과 일치할 때만",
    fn: (i, c, side) => (side === "long" ? c.htfUp[i] === true : c.htfUp[i] === false),
  },
  f2: {
    name: "저변동 선행",
    desc: "ATR(14) < 100봉 평균 — 수축 국면에서만 진입",
    fn: (i, c) => x(c.atr[i]) && x(c.atrMA[i]) && c.atr[i] < c.atrMA[i],
  },
  f3: {
    name: "거래량 확장",
    desc: "거래량 ≥ 1.5 × MA20 — 참여가 실린 신호만",
    fn: (i, c) => x(c.volMA[i]) && c.v[i] >= 1.5 * c.volMA[i],
  },
};

/** 청산 기하 6종 — sl/tp는 ATR 배수. trail 은 샹들리에 추적손절. */
export const EXITS = [
  { key: "x1", name: "손절1·목표1", sl: 1, tp: 1, trail: null, rr: 1 },
  { key: "x2", name: "손절1·목표2", sl: 1, tp: 2, trail: null, rr: 2 },
  { key: "x3", name: "손절1.5·목표3", sl: 1.5, tp: 3, trail: null, rr: 2 },
  { key: "x4", name: "손절2·목표6", sl: 2, tp: 6, trail: null, rr: 3 },
  { key: "x5", name: "손절3·목표9", sl: 3, tp: 9, trail: null, rr: 3 },
  { key: "x6", name: "손절2·추적2", sl: 2, tp: null, trail: 2, rr: null },
];
