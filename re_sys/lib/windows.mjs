/**
 * 트레이드 주변 캔들 — 청크 캐시.
 *
 * 거래가 수천 건이면 "거래당 창 하나"는 같은 봉을 수백 번 다시 받는다.
 * 단타는 하루에 수십 건씩 뭉치므로, 캔들을 100봉 정렬 청크로 받아 캐시하면
 * 요청 수가 거래 수가 아니라 "활동 시간"에 비례한다.
 *
 * 저장: data/manual-chunks.json — { "instId|tf|startTs": [봉...] }.
 * 빈 배열도 저장한다(상장폐지 종목 등) — 없는 데이터를 영원히 재요청하지 않게.
 */
import { loadData, saveData } from "./data.mjs";

export const TF_LADDER = [
  { bar: "1m", ms: 60_000, maxHoldMs: 60 * 60_000 },
  { bar: "5m", ms: 5 * 60_000, maxHoldMs: 8 * 3_600_000 },
  { bar: "15m", ms: 15 * 60_000, maxHoldMs: 36 * 3_600_000 },
  { bar: "1H", ms: 3_600_000, maxHoldMs: 8 * 86_400_000 },
  { bar: "4H", ms: 4 * 3_600_000, maxHoldMs: Infinity },
];
export const PRE_BARS = 90;
export const POST_BARS = 10;
const CHUNK = 100;

export function pickTf(holdMs) {
  return TF_LADDER.find((t) => holdMs <= t.maxHoldMs);
}

export function windowRange(trade, tf) {
  const from = Math.floor(trade.entryTs / tf.ms) * tf.ms - PRE_BARS * tf.ms;
  const to = Math.min(Math.floor(trade.exitTs / tf.ms) * tf.ms + POST_BARS * tf.ms, Date.now());
  return { from, to };
}

export function chunkStarts(from, to, ms) {
  const size = CHUNK * ms;
  const first = Math.floor(from / size) * size;
  const out = [];
  for (let s = first; s <= to; s += size) out.push(s);
  return out;
}

export function loadChunkStore() {
  return loadData("manual-chunks.json") ?? { chunks: {} };
}

export function saveChunkStore(store) {
  store.updatedAt = Date.now();
  saveData("manual-chunks.json", store);
}

export const chunkKey = (instId, bar, start) => `${instId}|${bar}|${start}`;

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg}`);
    return json.data;
  } catch (err) {
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw err;
  }
}

/** 청크 하나(정렬 100봉)를 받는다 — after 커서는 "이 시각보다 오래된 봉". */
export async function fetchChunk(instId, bar, ms, start) {
  const size = CHUNK * ms;
  let rows;
  try {
    rows = await getJson(
      `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&after=${start + size}&limit=${CHUNK}`,
    );
  } catch (e) {
    // 상장폐지 종목(51001 등)은 캔들이 없다 — 빈 청크로 기록하고 넘어간다.
    if (/51001|instrument/i.test(String(e.message))) return [];
    throw e;
  }
  return rows
    .filter((r) => r[8] === "1")
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .filter((c) => c.t >= start && c.t < start + size)
    .sort((a, b) => a.t - b.t);
}

/** 캐시된 청크에서 [from, to] 구간을 조립한다. 청크가 하나도 없으면 null. */
export function getWindow(store, instId, tf, from, to) {
  const out = [];
  let any = false;
  for (const s of chunkStarts(from, to, tf.ms)) {
    const c = store.chunks[chunkKey(instId, tf.bar, s)];
    if (c === undefined) continue;
    any = true;
    for (const bar of c) if (bar.t >= from && bar.t <= to) out.push(bar);
  }
  if (!any || !out.length) return null;
  return out.sort((a, b) => a.t - b.t);
}
