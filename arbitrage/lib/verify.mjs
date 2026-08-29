/**
 * 시계열 검증 — oneway-fetch.mjs verify() 를 옮기고 허용치를 인자로 뺐다.
 *
 * 기준: 시각 단조 증가 위반 0 · 봉 경계 정렬(t % tfMs === 0) 위반 0 · 결측률 < maxMissPct.
 * 업비트는 체결이 없는 분에 봉을 만들지 않으므로 알트 1m 은 결측이 정상이다 — 그래서 허용치가 시리즈마다 다르다.
 */
export function verifySeries(name, rows, { tfMs, maxMissPct = 1, boundary = true } = {}) {
  if (!rows || !rows.length) return { ok: false, name, bars: 0, msg: "0봉" };
  let nonMono = 0;
  let offGrid = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0 && rows[i][0] <= rows[i - 1][0]) nonMono += 1;
    if (boundary && rows[i][0] % tfMs !== 0) offGrid += 1;
  }
  const spanMs = rows[rows.length - 1][0] - rows[0][0];
  const spanDays = spanMs / 86_400_000;
  const expected = Math.floor(spanMs / tfMs) + 1;
  const missPct = ((expected - rows.length) / expected) * 100;
  const ok = nonMono === 0 && offGrid === 0 && missPct < maxMissPct;
  const from = new Date(rows[0][0]).toISOString().slice(0, 16);
  const to = new Date(rows[rows.length - 1][0]).toISOString().slice(0, 16);
  const line =
    `${ok ? "✓" : "✗"} ${name}: ${rows.length.toLocaleString()}봉 · ${spanDays.toFixed(0)}일 · 결측 ${missPct.toFixed(2)}%` +
    ` (허용 ${maxMissPct}%) · 단조위반 ${nonMono} · 경계위반 ${offGrid} · ${from} → ${to}`;
  return {
    ok,
    name,
    bars: rows.length,
    spanDays: Math.round(spanDays),
    missPct: +missPct.toFixed(3),
    maxMissPct,
    nonMono,
    offGrid,
    from,
    to,
    line,
  };
}
