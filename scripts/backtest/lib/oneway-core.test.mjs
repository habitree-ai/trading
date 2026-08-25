/**
 * ONEWAY 코어 검증 — 결론 전체가 이 잘라내기 규칙 위에 서므로 합성 픽스처로 못 박는다.
 * 사용: node scripts/backtest/lib/oneway-core.test.mjs
 */
import { decompose, reachScan } from "./oneway-core.mjs";

let fail = 0;
const eq = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-6;
  if (!ok) { fail += 1; console.log(`  ✗ ${name}: ${got} ≠ ${want}`); }
  else console.log(`  ✓ ${name}`);
};
const ok = (name, cond) => {
  if (!cond) { fail += 1; console.log(`  ✗ ${name}`); } else console.log(`  ✓ ${name}`);
};

/** 종가 배열을 캔들로 — 고·저는 종가와 같게 두어 봉내 순서 가정을 무력화한다. */
const bars = (closes) => closes.map((c, i) => [i * 60000, c, c, c, c, 1]);

console.log("\n[1] 단조 상승 뒤 되돌림 → leg 하나, 폭은 시작→고점");
{
  // 100 → 105 (5%) 상승 후 105 → 103 (1.90% 되돌림)
  const legs = decompose(bars([100, 101, 102, 103, 104, 105, 104, 103]), 0.01);
  eq("leg 수", legs.length, 1);
  eq("방향", legs[0].dir, 1);
  eq("폭 %", +legs[0].movePct.toFixed(4), 5);
  eq("시작가", legs[0].sp, 100);
  eq("끝가", legs[0].ep, 105);
}

console.log("\n[2] R 미만 되돌림은 leg 를 끊지 않는다");
{
  // 100 → 102 → 101.5(0.49% 되돌림, R=1% 미만) → 104 → 102 (1.92% 되돌림)
  const legs = decompose(bars([100, 102, 101.5, 104, 102]), 0.01);
  eq("leg 수", legs.length, 1);
  eq("폭 %", +legs[0].movePct.toFixed(4), 4);
  ok("내부 되돌림이 R 미만", legs[0].mae < 1);
}

console.log("\n[3] 요청 정의 재현 — 1% 올랐어도 도중 1% 되밀리면 그 구간은 1% leg 가 아니다");
{
  // 100 → 100.9 → 99.8(고점 대비 1.09% 하락) → 101.5
  const legs = decompose(bars([100, 100.9, 99.8, 100.6, 101.5, 100.4]), 0.01);
  const upLegs = legs.filter((l) => l.dir === 1);
  ok("시작봉 100 에서 출발하는 1%+ 상승 leg 는 없다", !upLegs.some((l) => l.si === 0 && l.movePct >= 1));
  ok("되돌림 저점 99.8 이 새 leg 의 시작이 된다", upLegs.some((l) => Math.abs(l.sp - 99.8) < 1e-9));
  ok("잡힌 leg 안에는 1% 되돌림이 없다", legs.every((l) => l.retr < 1));
}

console.log("\n[4] 하락 leg 도 대칭으로 잡힌다");
{
  const legs = decompose(bars([100, 99, 98, 97, 96, 95, 96, 97]), 0.01);
  eq("leg 수", legs.length, 1);
  eq("방향", legs[0].dir, -1);
  eq("폭 %", +legs[0].movePct.toFixed(4), -5);
}

console.log("\n[5] 봉내 순서 가정 — 극값 갱신과 R% 이탈이 같은 봉이면 끊는 쪽");
{
  // 3번째 봉이 고가 106(신고점)이면서 저가 100.0 — 직전 극값 102 대비 1.96% 이탈
  const rows = [
    [0, 100, 100, 100, 100, 1],
    [60000, 100, 102, 100, 102, 1],
    [120000, 102, 106, 100, 101, 1],
  ];
  const legs = decompose(rows, 0.01);
  eq("leg 수", legs.length, 1);
  eq("끝가는 갱신 전 극값", legs[0].ep, 102);
}

console.log("\n[6] reachScan — R% 역행 전 최대 순행");
{
  const rows = bars([100, 101, 102, 100.9, 103]);
  const { up } = reachScan(rows, 0.01, 100);
  // 0번 봉(종가 100)에서: 102까지 올라간 뒤 100.9 는 고점 대비 1.08% → 여기서 종료. 최대 순행 2%.
  eq("0번 봉 상방 도달", +up[0].toFixed(4), 2);
}

console.log("\n[7] 구간 내 되돌림(retr)은 정의상 항상 R 미만이다");
{
  // 극값이 찍힌 봉의 반대쪽 꼬리가 길어도 그것은 되돌림이 아니다 — 한 봉 안의
  // 고·저 순서를 모르는 이상, 봉내 폭을 되돌림으로 세면 R 을 넘는 값이 나온다.
  const rows = [
    [0, 100, 100, 100, 100, 1],
    [60000, 100, 102, 99.9, 102, 1],
    [120000, 102, 110, 101, 103, 1], // 신고점 110, 저가 101 — 봉내 폭이 8%
    [180000, 103, 103.2, 108.5, 108.5, 1],
  ];
  const legs = decompose(rows, 0.01);
  ok("leg 가 나온다", legs.length >= 1);
  ok("retr < R", legs.every((l) => l.retr < 1));
}

console.log("\n[8] leg 는 겹치지 않고 이어 붙는다");
{
  const rows = bars([100, 104, 100, 105, 99, 104, 100]);
  const legs = decompose(rows, 0.01);
  ok("leg ≥ 3", legs.length >= 3);
  let overlap = false;
  for (let i = 1; i < legs.length; i += 1) if (legs[i].si < legs[i - 1].ei) overlap = true;
  // 유효 시작점을 다시 잡으면 구간 사이에 틈이 생긴다 — 방향이 확실하지 않았던 자리다.
  ok("구간이 겹치지 않는다", !overlap);
  ok("방향이 번갈아 나온다", legs.every((l, i) => i === 0 || l.dir !== legs[i - 1].dir));
}

console.log(fail === 0 ? "\n전부 통과\n" : `\n${fail}건 실패\n`);
process.exit(fail === 0 ? 0 : 1);
