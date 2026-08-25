/**
 * ONEWAY 코어 — "한 방향으로 간 구간"을 정의하고 잘라 내는 곳.
 *
 * 이 회차의 질문은 전략이 아니라 시장 구조다: BTC가 1%·2%·3% 를 갈 때, 도중에
 * 되돌리지 않고 가는 일이 얼마나 자주 있으며 그때 차트가 어떤 모습이었는가.
 *
 * 정의(사전 등록):
 *   임펄스 leg = 극값까지 이어지되 그 안의 최대 되돌림이 한 번도 R% 에 닿지 않는,
 *   가장 이른 지점에서 시작하는 구간. 되돌림은 진행 중 갱신된 극값 대비로 잰다 —
 *   시작가 대비가 아니다. "1% 올랐어도 도중 1% 되밀리면 제외"가 곧 R=1% 로 자른 집합이다.
 *
 * 반전점에서 반전점까지를 그대로 쓰지 않는 이유는 push() 안에 적어 두었다 — 요약하면,
 * 지그재그의 상승 구간은 직전 저점에서 시작하지만 저점 직후는 아직 방향이 정해지지
 * 않은 구간이라 그 안에 R% 되밀림이 들어갈 수 있다. 그래서 유효 시작점을 다시 잡는다.
 * 그 결과 구간 사이에는 어디에도 속하지 않는 틈이 생긴다 — 방향이 확실하지 않았던 자리다.
 *
 * 봉내 순서 가정: 한 봉 안에서 고가·저가 중 무엇이 먼저인지 데이터는 말해 주지 않는다.
 * 여기서는 항상 "되돌림이 먼저"로 판정한다 — 같은 봉에서 극값 갱신과 R% 이탈이 함께
 * 성립하면 leg 를 끊고 극값은 갱신하지 않는다. leg 를 길게 보이게 하는 쪽이 아니라
 * 짧게 보이게 하는 쪽으로 틀리는 선택이고, 이 가정의 값은 1m 대조군이 재 준다.
 */

/** 캔들 인덱스 — 배열 포맷 [t,o,h,l,c,v] 를 이름으로 읽는다. */
export const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5;

/**
 * 되돌림 임계 R 로 전 구간을 겹치지 않는 leg 로 분해한다.
 *
 * @param {number[][]} rows [t,o,h,l,c,v] 오름차순
 * @param {number} r 되돌림 임계 (0.01 = 1%)
 * @returns {{dir:1|-1, si:number, ei:number, sp:number, ep:number, movePct:number, bars:number, ms:number, mae:number}[]}
 *   si/ei = 시작·종료 봉 인덱스, sp/ep = 시작·종료 가격(극값), mae = leg 중 시작가 대비 최대 역행 %
 */
export function decompose(rows, r) {
  if (rows.length < 2) return [];
  const legs = [];

  // 첫 방향이 정해지기 전까지는 양쪽 극값을 함께 기른다. 방향이 정해지는 순간
  // leg 의 시작점은 반대쪽 극값이다 — 첫 봉이 아니다. (상승 leg 는 직전 저점에서 시작한다)
  let dir = 0;
  let pi = 0; // 직전 반전점(= 다음 leg 의 시작)
  let pp = rows[0][C];
  let xi = 0; // 진행 중 극값
  let xp = rows[0][C];
  let hiI = 0, hiP = rows[0][C];
  let loI = 0, loP = rows[0][C];

  const push = (d, si, ei, sp, ep) => {
    if (ei <= si) return;

    // 반전점에서 반전점까지를 그대로 쓰면 요청한 정의를 어긴다.
    //
    // 지그재그의 상승 구간은 "직전 저점"에서 시작하지만, 저점이 찍힌 뒤 상승이 R% 로
    // 확인되기까지는 아직 방향이 정해지지 않은 구간이다. 그 안에서 R% 되밀림이
    // 얼마든지 일어날 수 있고, 실제 BTC 데이터에서는 구간의 8% 가까이가 그랬다.
    //
    // 그래서 뒤에서부터 유효한 시작점을 다시 잡는다 — 되돌림이 한 번도 R% 에 닿지
    // 않은 채 극값까지 이어지는 가장 이른 지점. 잘라 낸 앞부분은 "방향이 확실하지
    // 않았던 구간"이고, 그래서 어느 임펄스에도 속하지 않는다.
    let start = si;
    let ext = sp;
    for (let k = si + 1; k <= ei; k += 1) {
      const back = d === 1 ? (ext - rows[k][L]) / ext : (rows[k][H] - ext) / ext;
      if (back >= r) {
        // 여기서 끊겼다 — 이 봉의 반대쪽 극값이 새 시작 후보다.
        start = k;
        ext = d === 1 ? rows[k][L] : rows[k][H];
      } else if (d === 1 ? rows[k][H] > ext : rows[k][L] < ext) {
        ext = d === 1 ? rows[k][H] : rows[k][L];
      }
    }
    if (start >= ei) return;
    if (start !== si) {
      si = start;
      sp = d === 1 ? rows[start][L] : rows[start][H];
    }
    // mae — 시작가 대비 최대 역행. 시작점이 곧 극값이라 대개 0 근처다. 그 자체가
    // 답이다: 임펄스의 출발선에 정확히 서 있었다면 견딜 것이 거의 없었다는 뜻.
    // retr — 진행 중 갱신된 극값 대비 최대 되돌림. 정의상 R 미만이지만, 그 안에서
    // 얼마나 깔끔하게 갔는지는 구간마다 다르다. "한 방향"의 실제 결이 여기 있다.
    // retr 은 본 루프와 같은 순서로 재야 한다 — 되돌림을 먼저 보고 극값은 그 다음에
    // 갱신한다. 순서를 뒤집으면 극값이 찍힌 봉의 반대쪽 꼬리가 되돌림으로 잡혀
    // (한 봉 안의 고·저 폭이므로 순서를 알 수 없는 값이다) R 을 넘어 버린다.
    let mae = 0, retr = 0;
    ext = sp;
    for (let k = si; k <= ei; k += 1) {
      const adverse = d === 1 ? (sp - rows[k][L]) / sp : (rows[k][H] - sp) / sp;
      if (adverse > mae) mae = adverse;
      if (k === si) continue; // 시작 봉의 반대쪽 꼬리는 이 구간의 것이 아니다
      if (d === 1) {
        const back = (ext - rows[k][L]) / ext;
        if (back > retr) retr = back;
        if (rows[k][H] > ext) ext = rows[k][H];
      } else {
        const back = (rows[k][H] - ext) / ext;
        if (back > retr) retr = back;
        if (rows[k][L] < ext) ext = rows[k][L];
      }
    }
    legs.push({
      dir: d,
      si, ei, sp, ep,
      movePct: ((ep - sp) / sp) * 100,
      bars: ei - si,
      ms: rows[ei][T] - rows[si][T],
      mae: mae * 100,
      retr: retr * 100,
    });
  };

  for (let i = 1; i < rows.length; i += 1) {
    const hi = rows[i][H], lo = rows[i][L];

    if (dir === 0) {
      // 방향 미정 — 지금까지의 고·저 범위가 R% 를 넘으면, 나중에 찍힌 극값 쪽이 현재 방향이다.
      if (hi > hiP) { hiP = hi; hiI = i; }
      if (lo < loP) { loP = lo; loI = i; }
      if ((hiP - loP) / loP >= r) {
        if (hiI > loI) { dir = 1; pi = loI; pp = loP; xi = hiI; xp = hiP; }
        else { dir = -1; pi = hiI; pp = hiP; xi = loI; xp = loP; }
      }
      continue;
    }

    if (dir === 1) {
      // 되돌림 먼저 — 같은 봉에서 둘 다 성립하면 끊는 쪽을 택한다.
      if ((xp - lo) / xp >= r) {
        push(1, pi, xi, pp, xp);
        pi = xi; pp = xp;
        dir = -1; xi = i; xp = lo;
      } else if (hi > xp) { xp = hi; xi = i; }
    } else {
      if ((hi - xp) / xp >= r) {
        push(-1, pi, xi, pp, xp);
        pi = xi; pp = xp;
        dir = 1; xi = i; xp = hi;
      } else if (lo < xp) { xp = lo; xi = i; }
    }
  }
  // 마지막 미확정 leg 는 버린다 — 아직 R% 로 확인되지 않았으므로 "끝난 구간"이 아니다.
  return legs;
}

/**
 * 진입 시점 관점 — 각 봉 종가에서 시작해 R% 역행이 나오기 전까지 도달한 최대 순행 폭.
 *
 * leg 분해가 "구간이 어디였나"라면 이쪽은 "그 시점에 서 있었다면 무엇을 얻었나"다.
 * 지표별 조건부 발생률은 전부 이 값 위에서 센다.
 *
 * @returns {{up:Float32Array, dn:Float32Array}} 각 봉의 상방·하방 최대 도달 %(양수)
 */
export function reachScan(rows, r, maxLook) {
  const n = rows.length;
  const up = new Float32Array(n);
  const dn = new Float32Array(n);
  const cap = maxLook ?? n;

  for (let i = 0; i < n; i += 1) {
    const start = rows[i][C];
    let peak = start, best = 0, doneUp = false;
    let trough = start, worst = 0, doneDn = false;
    const end = Math.min(n, i + 1 + cap);

    for (let j = i + 1; j < end; j += 1) {
      const hi = rows[j][H], lo = rows[j][L];
      if (!doneUp) {
        // 역행 먼저 — 봉내 순서 가정을 leg 분해와 같게 둔다.
        if ((peak - lo) / peak >= r) doneUp = true;
        else if (hi > peak) { peak = hi; const g = (peak - start) / start; if (g > best) best = g; }
      }
      if (!doneDn) {
        if ((hi - trough) / trough >= r) doneDn = true;
        else if (lo < trough) { trough = lo; const g = (start - trough) / start; if (g > worst) worst = g; }
      }
      if (doneUp && doneDn) break;
    }
    up[i] = best * 100;
    dn[i] = worst * 100;
  }
  return { up, dn };
}
