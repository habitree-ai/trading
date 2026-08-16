/**
 * 쿼드 공격형 설정 — 복리 운용 5방식 검토의 ⑤ 구성 그대로.
 *
 * 리스크 사다리(docs/operations.md): 페이퍼 → 데모 → 라이브 2% → 5% → 10%.
 * riskPct 기본값은 요청대로 10이지만, 라이브 첫 진입은 2에서 시작할 것.
 */
export const CONFIG = {
  instId: "BTC-USDT-SWAP",

  /** 4개 기준 — 판정·청산 폭은 백테스트(플레이북·복리 검토)와 동일해야 한다. */
  members: {
    gc: { tf: "4H", name: "골든크로스", side: "long", exit: { type: "atr", sl: 1, tp: 3 } },
    ob: { tf: "4H", name: "RSI 과매도 반등", side: "long", exit: { type: "atr", sl: 1, tp: 3 } },
    fade: { tf: "4H", name: "RSI 과매수 반락", side: "short", exit: { type: "atr", sl: 2, tp: 4 } },
    dc: { tf: "1D", name: "20봉 신저가 이탈", side: "short", exit: { type: "pct", sl: 2, tp: 4 } },
  },

  /** 거래당 손실 상한(%) — 수수료 포함. 레버리지는 여기서 역산된다. */
  riskPct: 10,
  maxLev: 10,
  /** 왕복 수수료+슬리피지 추정 — 사이징 역산에 들어간다. */
  feePct: 0.1,
  /**
   * 동시 포지션·리스크 상한 — 넘으면 새 신호를 건너뛴다.
   * 백테스트 실측 동시 최대가 2개(리스크 합 20%)였다 — 그 이상은 검증 밖이다.
   * riskPct 를 낮춰도(승격 사다리 2·5%) 포지션 수 상한 2개는 그대로 유지된다.
   */
  maxConcurrent: 2,
  maxOpenRiskPct: 20,

  /** 보유 시한(봉) — 초과 시 시장가 정리. */
  maxHoldBars: { "4H": 60, "1D": 20 },

  barMs: { "4H": 4 * 3600_000, "1D": 24 * 3600_000 },
  /** 캔들 요청 개수 — SMA50·RSI 워밍업에 충분하고 시한(60봉) 추적도 덮는다. */
  candleLimit: 300,

  /** 페이퍼 모드 시작 자본($). */
  paperStartEquity: 100,

  /** 격리 마진 모드 — 청산 리스크를 포지션 안에 가둔다. */
  marginMode: "isolated",
};
