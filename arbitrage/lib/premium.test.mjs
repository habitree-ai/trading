/**
 * premium.mjs 손계산 픽스처. 사용: node --test arbitrage/lib/premium.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annualizedBasis, ar1, cycles, premiumCoin, premiumUsd, quantile, relPremium, runs, tetherPremium, triangle } from "./premium.mjs";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("업비트 삼각 — 2026-08-26 실측 스냅샷은 +0.37% 근처", () => {
  // KRW-BTC 109,062,000 · USDT-BTC 78,175.61 · KRW-USDT 1,390 (Plan 에이전트 실측)
  const d = triangle(109_062_000, 78_175.61, 1390);
  near(d, 0.003662, 1e-5);
});

test("달러 김프 손계산", () => {
  // 1억원 / (70,000$ × 1,400원) = 1e8 / 9.8e7 → +2.0408%
  near(premiumUsd(100_000_000, 70_000, 1400), 0.020408163, 1e-8);
});

test("테더 김프와 테더 프리미엄의 합성 — (1+P_usd) = (1+P_coin)(1+P_usdt)", () => {
  const krw = 100_000_000;
  const usdt = 70_000;
  const krwUsdt = 1420;
  const usdkrw = 1400;
  const pCoin = premiumCoin(krw, usdt, krwUsdt);
  const pUsdt = tetherPremium(krwUsdt, usdkrw);
  const pUsd = premiumUsd(krw, usdt, usdkrw);
  near((1 + pCoin) * (1 + pUsdt), 1 + pUsd, 1e-12);
  near(relPremium(pCoin, pCoin), 0);
});

test("만기 베이시스 연환산 — 36.5일 남은 1% 는 연 10%", () => {
  near(annualizedBasis(101_000, 100_000, 36.5), 0.1, 1e-9);
});

test("AR(1) 반감기 — φ=0.5 인 시드 난수열에서 φ≈0.5, 반감기≈1스텝", () => {
  // 순수 감쇠열은 표본평균을 빼면 φ 가 0.5 가 아니다. 평균 0 주위의 AR(1) 을 시드 LCG 로 만든다.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };
  const xs = [0];
  for (let i = 1; i < 20000; i += 1) xs.push(0.5 * xs[i - 1] + rnd());
  const r = ar1(xs);
  near(r.phi, 0.5, 0.03);
  near(r.halfLife, 1, 0.1);
});

test("연속 구간 길이", () => {
  assert.deepEqual(runs([1, 1, 0, 1, 0, 0, 1, 1, 1]), [2, 1, 3]);
  assert.deepEqual(runs([0, 0]), []);
});

test("분위수 선형 보간", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.9), 4.6);
});

test("사이클 — 하위 임계 진입, 중앙값 회복 청산, 겹치지 않음", () => {
  const xs = [0, -2, -1, 0.5, 1, -3, -2, -2, -2, -2, -2, 0.2];
  const cs = cycles(xs, { lo: -1.5, mid: 0, maxHold: 3 });
  assert.equal(cs.length, 3);
  assert.equal(cs[0].exitReason, "target");
  assert.equal(cs[0].i, 1);
  assert.equal(cs[0].j, 3);
  near(cs[0].delta, 2.5);
  assert.equal(cs[1].exitReason, "timeout");
  assert.equal(cs[1].i, 5);
  assert.equal(cs[1].hold, 3);
  assert.equal(cs[1].j, 8);
  assert.equal(cs[2].i, 9);
  assert.equal(cs[2].exitReason, "target");
});
