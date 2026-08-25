/**
 * 자금 비중 기법 8종.
 *
 * 전부 같은 것을 돌려준다: **이 거래에 걸 자기자본 대비 리스크 비율(%)**.
 * 그래야 8종을 같은 축(riskPct)에서 비교할 수 있다. 어떤 기법은 riskPct 를
 * 목표치로 쓰고(고정비율), 어떤 기법은 상한으로 쓴다(켈리) — 각 주석에 명시했다.
 *
 * 모든 기법은 **그 시점까지 닫힌 거래만** 본다. 한 건이라도 미래를 보면
 * 이 회차 전체가 무효다. state.history 는 청산 시각 기준으로만 채워진다.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 표본 표준편차 — 표본이 얇으면 null. */
function sd(arr, min = 8) {
  if (arr.length < min) return null;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * 켈리 분수 — R 단위로 계산한다.
 *   f* = W − (1−W)/b,  b = 평균이익R ÷ |평균손실R|
 * 금액이 아니라 R로 계산해야 손절폭이 다른 부품끼리 섞여도 뜻이 유지된다.
 */
function kellyFrac(rs, minN = 30) {
  if (rs.length < minN) return null;
  const w = rs.filter((r) => r > 0);
  const l = rs.filter((r) => r <= 0);
  if (!w.length || !l.length) return null;
  const W = w.length / rs.length;
  const aw = w.reduce((s, r) => s + r, 0) / w.length;
  const al = Math.abs(l.reduce((s, r) => s + r, 0) / l.length);
  if (!(al > 0)) return null;
  const b = aw / al;
  if (!(b > 0)) return null;
  return W - (1 - W) / b;
}

export const METHODS = {
  m0: {
    key: "m0", name: "고정 금액", family: "기준선",
    why: "복리를 끄고 초기 자본 기준으로만 건다. 나머지 7종이 만든 차이 중 얼마가 '복리 그 자체'인지 가르는 기준선.",
    source: "fixed amount / constant notional",
    fn: (st, base) => (base * st.start) / Math.max(1e-9, st.equity),
  },
  m1: {
    key: "m1", name: "고정 비율", family: "기본",
    why: "매 거래 자기자본의 riskPct% 를 건다. 현행 라이브가 쓰는 방식이며 8~12회차 전부의 기본값.",
    source: "fixed fractional (2% rule)",
    fn: (st, base) => base,
  },
  m2: {
    key: "m2", name: "1/2 켈리", family: "성장 최적",
    why: "부품별 최근 60거래의 R 분포에서 f*를 추정해 절반만 건다. 문헌은 1/2 켈리가 성장의 약 75%를 절반의 크기로 얻는다고 본다. riskPct 는 상한으로 쓴다.",
    source: "fractional Kelly — half Kelly ≈ 75% growth at 50% size",
    fn: (st, base, tr) => {
      const f = kellyFrac(st.partR(tr.part, 60));
      if (f === null) return base; // 표본 미달이면 고정 비율로 대기
      return clamp(f * 0.5 * 100, 0, base);
    },
  },
  m3: {
    key: "m3", name: "1/4 켈리", family: "성장 최적",
    why: "같은 추정에 4분의 1. 엣지 추정이 틀렸을 때의 손상을 줄이는 보수판 — 실무자들이 실제로 쓰는 쪽.",
    source: "quarter Kelly — 추정오차에 대한 보수 조정",
    fn: (st, base, tr) => {
      const f = kellyFrac(st.partR(tr.part, 60));
      if (f === null) return base;
      return clamp(f * 0.25 * 100, 0, base);
    },
  },
  m4: {
    key: "m4", name: "변동성 타깃", family: "변동성",
    why: "최근 40거래의 실현 변동성이 목표(거래당 2%)보다 크면 줄이고 작으면 키운다. 왼쪽 꼬리는 변동성이 높을 때 오므로 그때 노출을 줄이면 극단 손실이 얕아진다.",
    source: "volatility targeting — Sharpe 0.40→0.48~0.51 (주식), 극단 손실 완화는 전 자산군",
    fn: (st, base) => {
      const v = sd(st.recentReturns(40));
      if (v === null || !(v > 0)) return base;
      return base * clamp(2.0 / v, 0.25, 2);
    },
  },
  m5: {
    key: "m5", name: "낙폭 스로틀", family: "자본 보존",
    why: "실현 낙폭에 비례해 리스크를 줄인다(하한 25%). 앙상블 회차에서 6/6 조합의 낙폭을 개선한 오버레이.",
    source: "anti-martingale / drawdown throttle — 손실 후 증량은 파산확률만 올린다",
    fn: (st, base) => base * clamp(st.equity / Math.max(1e-9, st.peak), 0.25, 1),
  },
  m6: {
    key: "m6", name: "리스크 패리티", family: "분산",
    why: "부품마다 최근 40거래 변동성이 다르다. 변동성 역가중으로 걸어 한 부품이 책 전체의 위험을 지배하지 못하게 한다.",
    source: "risk parity — 위험 기여를 균등화",
    fn: (st, base, tr) => {
      const mine = sd(st.partReturns(tr.part, 40));
      const avg = st.avgPartVol();
      if (mine === null || avg === null || !(mine > 0)) return base;
      return base * clamp(avg / mine, 0.5, 2);
    },
  },
  m7: {
    key: "m7", name: "고정 비율(Jones)", family: "성장",
    why: "이익이 delta 만큼 쌓일 때마다 계약을 한 단위씩 늘린다. 초기 자본이 작을수록 보수적이고 커질수록 공격적 — 고정 비율과 정반대의 궤적.",
    source: "Ryan Jones fixed ratio — delta 단위 증량",
    fn: (st, base) => {
      const delta = st.start * 0.5; // 자본의 50%가 쌓일 때마다 한 단위
      const gain = Math.max(0, st.equity - st.start);
      const units = (Math.sqrt(1 + (8 * gain) / delta) + 1) / 2;
      return (base * units * st.start) / Math.max(1e-9, st.equity);
    },
  },
  m8: {
    key: "m8", name: "CPPI 쿠션", family: "자본 보존",
    why: "고점 대비 바닥선(고점×0.75)을 두고, 그 위 쿠션에만 배수를 걸어 위험을 잡는다. 바닥에 가까워질수록 자동으로 꺼진다.",
    source: "CPPI — constant proportion portfolio insurance",
    fn: (st, base) => {
      const floor = st.peak * 0.75;
      const cushion = Math.max(0, st.equity - floor);
      const mult = 3;
      return base * clamp((mult * cushion) / Math.max(1e-9, st.equity), 0, 1.5);
    },
  },
};

export const METHOD_KEYS = Object.keys(METHODS);
