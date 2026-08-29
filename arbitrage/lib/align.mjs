/**
 * 시계열 정렬. 모든 행은 [t, ...] 이고 t 는 UTC 봉 시작 ms, 오름차순.
 */

/** 여러 시리즈를 t 로 inner-join. 결과 행 = [t, rowA, rowB, ...]. 어느 하나라도 없는 t 는 버린다. */
export function joinAll(seriesList) {
  if (!seriesList.length) return [];
  const maps = seriesList.slice(1).map((rows) => new Map(rows.map((r) => [r[0], r])));
  const out = [];
  for (const a of seriesList[0]) {
    const t = a[0];
    const row = [t, a];
    let ok = true;
    for (const m of maps) {
      const b = m.get(t);
      if (!b) {
        ok = false;
        break;
      }
      row.push(b);
    }
    if (ok) out.push(row);
  }
  return out;
}

/**
 * forward-fill 조회기. 정렬된 rows 에서 "t 이하의 마지막 행"을 돌려준다.
 * 호출 순서가 오름차순이면 O(1) 로 움직인다. 반환 { row, exact } — exact 는 같은 t 가 있었는지.
 */
export function makeFfill(rows) {
  let i = 0;
  return (t) => {
    while (i + 1 < rows.length && rows[i + 1][0] <= t) i += 1;
    if (!rows.length || rows[i][0] > t) return { row: null, exact: false };
    return { row: rows[i], exact: rows[i][0] === t };
  };
}

/** [t,o,h,l,c,v] 를 k 배 봉으로 다운샘플(경계 = t - t % (tfMs*k)). 차트 용량을 줄이는 용도. */
export function downsample(rows, tfMs, k) {
  const span = tfMs * k;
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = r[0] - (r[0] % span);
    if (!cur || cur[0] !== b) {
      if (cur) out.push(cur);
      cur = [b, r[1], r[2], r[3], r[4], r[5]];
    } else {
      cur[2] = Math.max(cur[2], r[2]);
      cur[3] = Math.min(cur[3], r[3]);
      cur[4] = r[4];
      cur[5] += r[5];
    }
  }
  if (cur) out.push(cur);
  return out;
}
