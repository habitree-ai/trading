/**
 * SPOT-SIGNAL 회차 P1 — 업비트 KRW 전 종목 1H·4H·1D 캔들 수집 (REQ-0023 Phase A).
 *
 * 목적: 현물 진입 신호 4종(pullback·gc·breakout·squeeze) 백테스트의 원자료.
 * 구간: 2022-10-01 → 현재. 평가는 2023-01-01부터(앞 3개월은 지표 워밍업),
 *       OOS 분할은 학습 2023~2024 / 검증 2025~ (기획서에 사전 등록).
 *
 * 검증 기준(사전 등록 — 실행 전 고정):
 *   · 시각 단조 증가(중복 제거 후) 필수
 *   · 마지막 봉이 현재-2.5틱 이내(시리즈가 살아있는가) — 아니면 보고
 *   · 결측률은 [첫봉,끝봉] 구간 기준으로 기록. 1H 결측 >10% 종목은 백테스트 제외 목록에 올린다
 *     (업비트는 체결 없는 시간의 봉이 없다 — 저유동성 새벽 결측은 데이터 오류가 아니라 유동성 신호다)
 *   · 스테이블코인(KRW-USDT 등)은 유니버스에서 제외 — 페그 자산에 기술적 신호는 무의미
 *   · 유의(warning)·주의(caution) 플래그는 수집 시점 스냅샷으로 기록만 한다. 과거 구간
 *     백테스트에는 포함하고(당시엔 정상이었다), 실시간 스캐너(Phase B)에서만 현재 플래그로 제외
 *
 * 한도: 시세 그룹 IP당 10req/s → 동시 4 × 500ms = 8req/s (arbitrage/fetch-upbit.mjs 와 동일).
 * 헬퍼(fetchJson·pacedPool)는 arbitrage/lib/http.mjs 복제 — arbitrage/ 는 미커밋
 * 조사 영역이라 import 하면 클론에서 깨진다 (http.mjs 자신도 같은 이유의 복제본이다).
 *
 * 사용: node scripts/backtest/spot-signal-fetch.mjs [--only KRW-BTC,KRW-ETH] [--force]
 * 출력: scripts/backtest/.cache/spot/upbit-<market>-<tf>.json  ([t,o,h,l,c,v] · 1D는 +거래대금)
 *       scripts/backtest/.cache/spot/spot-universe.json / spot-fetch-report.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.upbit.com/v1";
const PAGE = 200;
const CONCURRENCY = 4;
const PAUSE_MS = 500;
const DAY = 86_400_000;
const FROM = Date.UTC(2022, 9, 1); // 2022-10-01
const STABLES = new Set(["USDT", "USDC", "DAI", "TUSD", "USDS", "PYUSD", "FDUSD", "USD1", "USDE"]);

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache", "spot");
const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

const TFS = {
  "1D": { unit: "D", ms: DAY },
  "4H": { unit: 240, ms: 240 * 60_000 },
  "1H": { unit: 60, ms: 60 * 60_000 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { retries = 6, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
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

async function pacedPool(items, worker) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map((it, j) => worker(it, i + j)));
    if (i + CONCURRENCY < items.length) await sleep(PAUSE_MS);
  }
}

/** 봉 파싱 — [t,o,h,l,c,v], 1D는 뒤에 KRW 거래대금 추가. 진행 중 봉은 t<to 로 잘린다. */
function parseRows(data, from, to, withTurnover) {
  const out = [];
  for (const r of data) {
    const t = Date.parse(`${r.candle_date_time_utc}Z`);
    if (t >= from && t < to) {
      const row = [t, r.opening_price, r.high_price, r.low_price, r.trade_price, r.candle_acc_trade_volume];
      if (withTurnover) row.push(r.candle_acc_trade_price);
      out.push(row);
    }
  }
  return out;
}

async function fetchSeries(market, tf, from) {
  const { unit, ms } = TFS[tf];
  const to = Math.floor(Date.now() / ms) * ms;
  const span = ms * PAGE;
  const pages = Math.max(1, Math.ceil((to - from) / span));
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const path = unit === "D" ? `${BASE}/candles/days` : `${BASE}/candles/minutes/${unit}`;
  const out = new Map();
  await pacedPool(cursors, async (c) => {
    const isoTo = new Date(c).toISOString().slice(0, 19) + "Z";
    const data = await fetchJson(`${path}?market=${market}&to=${isoTo}&count=${PAGE}`);
    for (const row of parseRows(data, from, to, unit === "D")) out.set(row[0], row);
  });
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

function verify(rows, ms) {
  if (!rows.length) return { bars: 0, missPct: null, stale: true };
  const span = rows[rows.length - 1][0] - rows[0][0];
  const expected = Math.floor(span / ms) + 1;
  const missPct = +(((expected - rows.length) / expected) * 100).toFixed(2);
  const stale = rows[rows.length - 1][0] < Date.now() - 2.5 * ms;
  return { bars: rows.length, missPct, stale, from: rows[0][0], to: rows[rows.length - 1][0] };
}

async function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  // 1) 유니버스 — KRW 마켓 전체, 스테이블 제외, 플래그는 기록만
  const all = await fetchJson(`${BASE}/market/all?is_details=true`);
  const krw = all.filter((m) => m.market.startsWith("KRW-"));
  const universe = [];
  for (const m of krw) {
    const sym = m.market.slice(4);
    if (STABLES.has(sym)) continue;
    const ev = m.market_event || {};
    const caution = ev.caution || {};
    universe.push({
      market: m.market,
      symbol: sym,
      korean: m.korean_name,
      warning: Boolean(ev.warning),
      caution: Object.keys(caution).filter((k) => caution[k]),
    });
  }

  // 2) 현재 24h 거래대금 (참고 스냅샷 — 백테스트의 유동성 분위는 1D 캔들 거래대금으로 계산)
  for (let i = 0; i < universe.length; i += 50) {
    const batch = universe.slice(i, i + 50);
    const rows = await fetchJson(`${BASE}/ticker?markets=${batch.map((c) => c.market).join(",")}`);
    const vol = new Map(rows.map((r) => [r.market, Number(r.acc_trade_price_24h)]));
    for (const c of batch) c.vol24hKrw = vol.get(c.market) ?? 0;
    await sleep(150);
  }
  universe.sort((a, b) => b.vol24hKrw - a.vol24hKrw);

  const list = only ? universe.filter((c) => only.includes(c.market)) : universe;
  console.log(`업비트 KRW ${krw.length}종 → 스테이블 제외 ${universe.length}종 · 수집 대상 ${list.length}종`);
  console.log(`구간 ${new Date(FROM).toISOString().slice(0, 10)} → 현재 · 1D+4H+1H\n`);

  const report = [];
  const started = Date.now();
  let done = 0;
  for (const c of list) {
    done += 1;
    const row = { market: c.market, korean: c.korean, vol24hKrw: c.vol24hKrw, tf: {} };
    let effFrom = FROM;
    for (const tf of ["1D", "4H", "1H"]) {
      const p = join(CACHE_DIR, `upbit-${c.market}-${tf}.json`);
      let rows;
      if (!force && existsSync(p)) {
        rows = JSON.parse(readFileSync(p, "utf8"));
      } else {
        rows = await fetchSeries(c.market, tf, effFrom);
        writeFileSync(p, JSON.stringify(rows));
      }
      if (tf === "1D" && rows.length) effFrom = Math.max(FROM, rows[0][0] - DAY); // 상장일 이후만 커서 계산
      row.tf[tf] = verify(rows, TFS[tf].ms);
    }
    row.excluded1H = row.tf["1H"].missPct === null || row.tf["1H"].missPct > 10;
    report.push(row);
    const elapsed = (Date.now() - started) / 1000;
    const eta = elapsed * (list.length / done - 1);
    console.log(
      `  [${String(done).padStart(3)}/${list.length}] ${c.market.padEnd(12)} 1H ${String(row.tf["1H"].bars).padStart(6)}봉 결측 ${String(row.tf["1H"].missPct).padStart(6)}% ${row.excluded1H ? "→ 제외후보" : ""} · 경과 ${(elapsed / 60).toFixed(1)}분 · 남은 ${(eta / 60).toFixed(0)}분`,
    );
  }

  writeFileSync(
    join(CACHE_DIR, "spot-universe.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: universe.length, list: universe }, null, 2),
  );
  writeFileSync(
    join(CACHE_DIR, "spot-fetch-report.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, report }, null, 2),
  );

  const excluded = report.filter((r) => r.excluded1H);
  const staleAny = report.filter((r) => ["1D", "4H", "1H"].some((tf) => r.tf[tf].stale));
  console.log(`\n✓ 수집 완료 — ${report.length}종`);
  console.log(
    `  1H 결측>10% 제외 후보 ${excluded.length}종: ${excluded
      .slice(0, 20)
      .map((r) => r.market.slice(4))
      .join(", ")}${excluded.length > 20 ? " …" : ""}`,
  );
  if (staleAny.length)
    console.log(`  ⚠ 최신봉 지연 ${staleAny.length}종: ${staleAny.slice(0, 10).map((r) => r.market.slice(4)).join(", ")}`);
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
