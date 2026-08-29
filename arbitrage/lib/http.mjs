/**
 * 공용 HTTP — 재시도·백오프·페이싱.
 *
 * scripts/backtest/oneway-fetch.mjs 의 fetchPage(재시도) 와 배치 루프를 일반화한 것.
 * 원본은 BTC-USDT-SWAP 상수에 묶여 있어 import 할 수 없었다 — 그래서 복제했다.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON GET. 네트워크 오류·429·5xx 는 최대 `retries` 회 지수 대기 후 재시도.
 * 그 밖의 4xx 는 즉시 던진다(요청 자체가 틀린 것이라 재시도가 의미 없다).
 */
export async function fetchJson(url, { headers = {}, retries = 6, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers: { accept: "application/json", ...headers } });
    } catch (e) {
      if (attempt < retries) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(`network: ${e.message} — ${url.slice(0, 140)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(baseDelayMs * 1.5 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${url.slice(0, 140)} :: ${body.slice(0, 160)}`);
    }
    return res.json();
  }
}

/**
 * 항목을 `concurrency` 개씩 동시에 처리하고 묶음 사이에 `pauseMs` 쉰다.
 * 거래소 IP 한도(OKX 20req/2s, 업비트 10req/s) 아래에 머무르기 위한 가장 단순한 장치.
 * onProgress(done, total, elapsedSec) 로 진행률을 알린다.
 */
export async function pacedPool(items, worker, { concurrency, pauseMs, onProgress } = {}) {
  const out = new Array(items.length);
  const started = Date.now();
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((it, j) => worker(it, i + j)));
    results.forEach((r, j) => {
      out[i + j] = r;
    });
    const done = Math.min(i + concurrency, items.length);
    if (onProgress) onProgress(done, items.length, (Date.now() - started) / 1000);
    if (done < items.length) await sleep(pauseMs);
  }
  return out;
}

/** 한 줄 진행률(캐리지 리턴) — oneway-fetch 와 같은 모양. */
export function progress(label, done, total, elapsedSec, extra = "") {
  const eta = done > 0 ? elapsedSec * (total / done - 1) : 0;
  process.stdout.write(
    `\r  ${label}: ${done}/${total}p · 경과 ${(elapsedSec / 60).toFixed(1)}분 · 남은 ${(eta / 60).toFixed(1)}분 ${extra}   `,
  );
  if (done >= total) process.stdout.write("\n");
}
