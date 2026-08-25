/**
 * M1 — 본인 매매 이력 수집·누적 (다계정).
 *
 * 출처 세 곳을 합친다:
 *   · OKX positions-history — 계정별 포지션 단위 이력 (live 봇계정 + app 매매계정)
 *   · 매매일지 DB(trades) — 앱 기록. OKX 에서 같은 posId 가 확인되면 OKX 쪽이 정본
 *   · (원장 아카이브 재구성분은 manual-archive.mjs 가 따로 편입한다)
 *
 * 캔들은 "거래당 창"이 아니라 100봉 정렬 청크로 받아 캐시한다(lib/windows.mjs) —
 * 단타 수천 건이 같은 시간대에 뭉치므로 요청 수가 활동 시간에 비례하게 된다.
 *
 * 키는 .env.local 과 Supabase Vault 에서만 읽는다. 이 파일 어디에도 키를 적지 말 것.
 */
import { fetchHistoryBack, loadData, saveData, saveDataText, toCsv } from "./lib/data.mjs";
import { allAccounts, loadEnv, okxGet } from "./lib/accounts.mjs";
import {
  chunkKey,
  chunkStarts,
  fetchChunk,
  loadChunkStore,
  pickTf,
  saveChunkStore,
  windowRange,
} from "./lib/windows.mjs";

/* ---------- OKX 이력 ---------- */

async function fetchPositionsHistory(creds) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 40; page += 1) {
    const rows = await okxGet(
      creds,
      `/api/v5/account/positions-history?instType=SWAP&limit=100${cursor ? `&after=${cursor}` : ""}`,
    );
    out.push(...rows);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].uTime;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/** 체결 단위 이력 — 보존창 약 3개월. 누적해 두면 포지션 이력보다 촘촘한 원장이 남는다. */
async function fetchFillsHistory(creds) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 80; page += 1) {
    const rows = await okxGet(
      creds,
      `/api/v5/trade/fills-history?instType=SWAP&limit=100${cursor ? `&after=${cursor}` : ""}`,
    );
    out.push(...rows);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].billId;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/** 펀딩비 정산 청구서(type 8) — 보유 비용의 실측. 보존창 약 3개월 → 누적. */
async function fetchFundingBills(creds) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 30; page += 1) {
    const rows = await okxGet(
      creds,
      `/api/v5/account/bills-archive?type=8&limit=100${cursor ? `&after=${cursor}` : ""}`,
    );
    out.push(...rows);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].billId;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/* ---------- 매매일지 DB ---------- */

async function fetchJournal(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const bq = await fetch(`${url}/rest/v1/books?select=id,name`, { headers });
  const books = await bq.json();
  const nameOf = new Map(books.map((b) => [b.id, b.name]));
  const tq = await fetch(`${url}/rest/v1/trades?select=*&order=entry_at.asc&limit=10000`, { headers });
  const rows = await tq.json();
  if (!Array.isArray(rows)) throw new Error(`매매일지 조회 실패: ${JSON.stringify(rows).slice(0, 200)}`);
  return rows.map((t) => ({ ...t, bookName: nameOf.get(t.book_id) ?? "?" }));
}

/* ---------- 통합 레코드 ---------- */

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function fromOkx(p, acct) {
  return {
    id: `${acct.idPrefix}-${p.posId}-${p.cTime}`,
    source: acct.tag === "live" ? "okx-live" : "okx-app",
    sourceName: acct.name,
    account: acct.tag,
    posId: p.posId,
    instId: p.instId,
    side: p.direction,
    lever: num(p.lever),
    mgnMode: p.mgnMode,
    entryTs: Number(p.cTime),
    exitTs: Number(p.uTime),
    entryPx: num(p.openAvgPx),
    exitPx: num(p.closeAvgPx),
    pnlUsd: num(p.realizedPnl ?? p.pnl),
    pnlGrossUsd: num(p.pnl),
    pnlRatioPct: num(p.pnlRatio) === null ? null : num(p.pnlRatio) * 100, // 증거금 대비 %
    feeUsd: num(p.fee),
    fundingUsd: num(p.fundingFee),
    liq: p.type === "3" || p.type === "4",
    adl: p.type === "5",
    closeType: p.type,
    stopPx: null,
    note: null,
  };
}

function fromJournal(t) {
  const inst = t.symbol.includes("-") ? t.symbol : `${t.symbol}-USDT-SWAP`;
  return {
    id: `db-${t.seq}`,
    source: "journal",
    sourceName: `매매일지(${t.bookName})`,
    account: "journal",
    okxPosId: t.okx_pos_id ?? null,
    instId: inst,
    side: t.side,
    lever: num(t.leverage),
    mgnMode: t.margin_mode,
    entryTs: Date.parse(t.entry_at),
    exitTs: t.exit_at ? Date.parse(t.exit_at) : null,
    entryPx: num(t.entry_price),
    exitPx: num(t.exit_price),
    pnlUsd: num(t.realized_pnl ?? t.pnl),
    pnlGrossUsd: num(t.pnl),
    pnlRatioPct: null,
    feeUsd: num(t.fee),
    fundingUsd: num(t.funding_fee),
    liq: false,
    adl: false,
    closeType: null,
    stopPx: num(t.stop_price),
    note: [t.setup, t.rationale, t.review, t.note].filter(Boolean).join(" · ") || null,
    result: t.result,
  };
}

/* ---------- 메인 ---------- */

async function main() {
  const env = loadEnv();
  const accounts = await allAccounts(env);

  const store = loadData("manual-trades.json");
  const map = new Map((store?.trades ?? []).map((t) => [t.id, t]));

  for (const acct of accounts) {
    const rows = await fetchPositionsHistory(acct.creds);
    console.log(`[${acct.name}] positions-history ${rows.length}건`);
    for (const p of rows) { const t = fromOkx(p, acct); map.set(t.id, t); }

    try {
      const fills = await fetchFillsHistory(acct.creds);
      const fStore = loadData("manual-fills.json");
      const fMap = new Map((fStore?.fills ?? []).map((f) => [`${f._account ?? "live"}:${f.billId}`, f]));
      for (const f of fills) { f._account = acct.tag; fMap.set(`${acct.tag}:${f.billId}`, f); }
      const all = [...fMap.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
      saveData("manual-fills.json", { updatedAt: Date.now(), fills: all });
      console.log(`  체결 원장 이번 ${fills.length}건 · 누적 ${all.length}건`);
    } catch (e) {
      console.log(`  체결 원장 조회 실패 — 건너뜀 (${e.message})`);
    }
    try {
      const bills = await fetchFundingBills(acct.creds);
      const bStore = loadData("manual-funding-bills.json");
      const bMap = new Map((bStore?.bills ?? []).map((b) => [`${b._account ?? "live"}:${b.billId}`, b]));
      for (const b of bills) { b._account = acct.tag; bMap.set(`${acct.tag}:${b.billId}`, b); }
      const all = [...bMap.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
      saveData("manual-funding-bills.json", { updatedAt: Date.now(), bills: all });
      console.log(`  펀딩 청구서 이번 ${bills.length}건 · 누적 ${all.length}건`);
    } catch (e) {
      console.log(`  펀딩 청구서 조회 실패 — 건너뜀 (${e.message})`);
    }
  }

  console.log("[매매일지 DB]");
  const dbRows = await fetchJournal(env);
  for (const r of dbRows) { const t = fromJournal(r); map.set(t.id, t); }
  // 같은 거래가 OKX 이력에도 있으면 일지 레코드는 물러난다 — OKX 쪽이 수수료·레버까지 정본.
  const posIds = new Set([...map.values()].filter((t) => t.source !== "journal" && t.posId).map((t) => String(t.posId)));
  let dropped = 0;
  for (const [id, t] of map) {
    if (t.source === "journal" && t.okxPosId && posIds.has(String(t.okxPosId))) { map.delete(id); dropped += 1; }
  }
  console.log(`  ${dbRows.length}건 (OKX 이력과 중복 ${dropped}건은 OKX 정본으로 대체)`);

  const trades = [...map.values()].sort((a, b) => a.entryTs - b.entryTs);
  saveData("manual-trades.json", { updatedAt: Date.now(), trades });
  console.log(`통합 거래 ${trades.length}건 (${new Date(trades[0].entryTs).toISOString().slice(0, 10)} → ${new Date(trades[trades.length - 1].entryTs).toISOString().slice(0, 10)})`);

  // 레짐(1D vs SMA200) 판정용 — 거래가 20건 이상인 종목 중 1D 저장이 없는 것만 전 구간 수집.
  const counts = new Map();
  for (const t of trades) counts.set(t.instId, (counts.get(t.instId) ?? 0) + 1);
  for (const [instId, n] of counts) {
    if (n < 20) continue;
    const sym = instId.split("-")[0];
    if (loadData(`candles-${sym}-1D.json`)) continue;
    const candles = await fetchHistoryBack("1D", { stopAtTs: null, maxPages: 100 }, instId);
    if (candles.length) {
      saveData(`candles-${sym}-1D.json`, { instId, bar: "1D", updatedAt: Date.now(), candles });
      console.log(`레짐용 1D: ${sym} ${candles.length}봉`);
    }
  }

  /* ---------- 캔들 청크 수집 ---------- */
  const chunkStore = loadChunkStore();
  const needed = new Map();
  for (const t of trades) {
    if (!t.exitTs) continue;
    const tf = pickTf(t.exitTs - t.entryTs);
    const { from, to } = windowRange(t, tf);
    for (const s of chunkStarts(from, to, tf.ms)) {
      const key = chunkKey(t.instId, tf.bar, s);
      if (chunkStore.chunks[key] === undefined) needed.set(key, { instId: t.instId, tf, start: s });
    }
  }
  console.log(`캔들 청크: 보유 ${Object.keys(chunkStore.chunks).length} · 필요 ${needed.size}`);
  let done = 0;
  for (const [key, n] of needed) {
    chunkStore.chunks[key] = await fetchChunk(n.instId, n.tf.bar, n.tf.ms, n.start);
    done += 1;
    if (done % 50 === 0) process.stdout.write(`\r  청크 ${done}/${needed.size}`);
    if (done % 300 === 0) saveChunkStore(chunkStore); // 크래시 대비 중간 저장
    await new Promise((r) => setTimeout(r, 130));
  }
  if (needed.size) process.stdout.write(`\r  청크 ${done}/${needed.size}\n`);
  saveChunkStore(chunkStore);

  const cols = ["id", "source", "account", "instId", "side", "lever", "entryTs", "exitTs", "entryPx", "exitPx", "pnlUsd", "pnlRatioPct", "feeUsd", "liq", "closeType", "stopPx"];
  saveDataText("manual-trades.csv", toCsv(trades, cols));
  console.log(`저장 완료 → re_sys/data/manual-trades.{json,csv} · manual-chunks.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
