/**
 * M0 — OKX 계정 원장 분기 아카이브 수집 (bills-history-archive) · 다계정.
 *
 * positions-history(포지션 단위)와 fills-history(3개월)만으로는 과거 거래 전량을
 * 못 본다. 이 엔드포인트가 계정의 "모든 청구서"(거래·수수료·펀딩·이체·청산비용)를
 * 분기 단위 파일로 내준다 — 여기 있는 것이 그 계정 거래의 정본 전량이다.
 *
 * 계정은 lib/accounts.mjs 가 정의한다: live(.env 봇계정) + app(Vault 매매계정).
 * 신청은 계정별 일일 한도(50011)가 있다 — 최근 분기부터 신청해 한도를 아껴 쓰고,
 * 막히면 다음 실행에서 이어서 신청한다.
 *
 * 흐름: 분기별 신청(POST) → 생성 대기(state: ongoing) → fileHref 다운로드(zip)
 *      → CSV 추출·파싱 → data/bills-archive/ 원본 보존 + manual-bills.json 누적
 *      → 원장에서 라운드트립 재구성 → manual-trades.json 에 없는 거래만 편입.
 *
 * 사용: node re_sys/manual-archive.mjs   # 될 때까지(생성 중이면) 다시 실행하면 이어진다
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadData, saveData } from "./lib/data.mjs";
import { allAccounts, loadEnv, okxCall } from "./lib/accounts.mjs";

const ARCHIVE_DIR = join(DATA_DIR, "bills-archive");

/* ---------- 분기 목록 — 최근 분기부터 (신청 한도를 최근 데이터에 먼저 쓴다) ---------- */

function quarterList() {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curQ = Math.floor(now.getUTCMonth() / 3) + 1;
  const out = [];
  for (let y = 2023; y <= curY; y += 1) {
    for (let q = 1; q <= 4; q += 1) {
      if (y === curY && q >= curQ) break; // 진행 중 분기는 아카이브 불가(동기 API가 커버)
      out.push({ year: String(y), quarter: `Q${q}` });
    }
  }
  return out.reverse();
}

/* ---------- CSV 파싱 — 헤더 기반 ---------- */

function parseCsv(text) {
  const rows = [];
  let cur = [""];
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur[cur.length - 1] += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur[cur.length - 1] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") cur.push("");
    else if (ch === "\n" || ch === "\r") {
      if (cur.length > 1 || cur[0] !== "") { rows.push(cur); cur = [""]; }
    } else cur[cur.length - 1] += ch;
  }
  if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/* ---------- 메인 ---------- */

async function main() {
  const env = loadEnv();
  const accounts = await allAccounts(env);
  mkdirSync(ARCHIVE_DIR, { recursive: true });

  const store = loadData("manual-bills.json") ?? {};
  // 구 저장소(단일 계정) 이관 — quarters 가 최상위에 있으면 live 계정의 것이다.
  if (store.quarters && !store.accounts) {
    store.accounts = { live: { quarters: store.quarters } };
    delete store.quarters;
    for (const b of store.bills ?? []) b._account ??= "live";
  }
  store.accounts ??= {};
  store.bills ??= [];
  const billKey = (b) => `${b._account}:${b.billId || JSON.stringify(b)}`;
  const billMap = new Map(store.bills.map((b) => [billKey(b), b]));

  for (const acct of accounts) {
    store.accounts[acct.tag] ??= { quarters: {} };
    const quarters = store.accounts[acct.tag].quarters;
    console.log(`\n[${acct.name}]`);

    for (const { year, quarter } of quarterList()) {
      const tag = `${year}${quarter}`;
      if (quarters[tag]?.state === "done" || quarters[tag]?.state === "empty") continue;

      const st = await okxCall(acct.creds, "GET", `/api/v5/account/bills-history-archive?year=${year}&quarter=${quarter}`);
      const state = st.data?.[0]?.state ?? null;
      const href = st.data?.[0]?.fileHref ?? "";

      if (st.code === "51604" || state === null) {
        const ap = await okxCall(acct.creds, "POST", "/api/v5/account/bills-history-archive", { year, quarter });
        console.log(`  ${tag}: ${ap.code === "0" ? "신청 접수 — 생성 대기" : `신청 실패(${ap.code} ${ap.msg})`}`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (state === "ongoing" || !href) {
        console.log(`  ${tag}: 생성 중 — 나중에 다시 실행`);
        continue;
      }
      if (state === "failure") {
        quarters[tag] = { state: "empty", checkedAt: Date.now() };
        console.log(`  ${tag}: 데이터 없음(생성 실패 응답)`);
        continue;
      }

      const dirTag = `${acct.tag}-${tag}`;
      const zipPath = join(ARCHIVE_DIR, `${dirTag}.zip`);
      const res = await fetch(href);
      if (!res.ok) {
        console.log(`  ${tag}: 다운로드 실패 HTTP ${res.status}`);
        continue;
      }
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      execFileSync("powershell", ["-NoProfile", "-Command",
        `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${join(ARCHIVE_DIR, dirTag)}" -Force`]);
      const files = [];
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else if (e.name.toLowerCase().endsWith(".csv")) files.push(join(dir, e.name));
        }
      };
      walk(join(ARCHIVE_DIR, dirTag));
      if (!files.length) {
        console.log(`  ${tag}: 압축 해제 후 CSV 없음 — 다음 실행에서 재시도`);
        continue;
      }
      let rows = 0;
      for (const f of files) {
        const parsed = parseCsv(readFileSync(f, "utf8"));
        for (const b of parsed) {
          b._quarter = tag;
          b._account = acct.tag;
          billMap.set(billKey(b), b);
          rows += 1;
        }
      }
      quarters[tag] = { state: rows > 0 ? "done" : "empty", rows, downloadedAt: Date.now() };
      console.log(`  ${tag}: 완료 — ${rows}건`);
    }
    const done = Object.entries(store.accounts[acct.tag].quarters);
    console.log(`  확보: ${done.filter(([, v]) => v.state === "done").map(([k, v]) => `${k}(${v.rows})`).join(" ") || "없음"} · 빈 분기 ${done.filter(([, v]) => v.state === "empty").length}개`);
  }

  store.bills = [...billMap.values()];
  store.updatedAt = Date.now();
  saveData("manual-bills.json", store);
  console.log(`\n누적 청구서 ${store.bills.length}건 → re_sys/data/manual-bills.json (원본: data/bills-archive/)`);

  reconcile(store.bills);
}

/* ---------- 원장 → 라운드트립 재구성 · 기존 이력과 대조 ---------- */

const OPEN = { 3: "long", 4: "short" };
const CLOSE = { 5: "long", 6: "short", 100: "long", 101: "short", 104: "long", 105: "short" };
const LIQ = new Set(["100", "101", "104", "105"]);

function reconstructTrades(bills, account) {
  const mine = bills.filter((b) => (b._account ?? "live") === account);
  return [...reconstructHedgeMode(mine), ...reconstructNetMode(mine)].map((p) =>
    toTradeRecord(p, account),
  );
}

/** 롱숏 분리 모드 — open long(3)/short(4), close long(5)/short(6) + 강제청산(100~105). */
function reconstructHedgeMode(bills) {
  const fills = bills
    .filter((b) => OPEN[b.subType] || CLOSE[b.subType])
    .map((b) => ({
      ts: Number(b.ts),
      instId: b.instId,
      dir: OPEN[b.subType] ?? CLOSE[b.subType],
      kind: OPEN[b.subType] ? "open" : "close",
      liq: LIQ.has(String(b.subType)),
      sz: Number(b.sz),
      px: Number(b.px),
      pnl: Number(b.pnl || 0),
      fee: Number(b.fee || 0),
      mgnMode: b.mgnMode,
    }))
    .sort((a, b) => a.ts - b.ts);

  const open = new Map();
  const trades = [];
  for (const f of fills) {
    const key = `${f.instId}|${f.dir}`;
    let p = open.get(key);
    if (f.kind === "open") {
      if (!p) { p = { instId: f.instId, dir: f.dir, entryTs: f.ts, sz: 0, entryNotional: 0, exitNotional: 0, closedSz: 0, pnl: 0, fee: 0, liq: false, mgnMode: f.mgnMode, exitTs: f.ts }; open.set(key, p); }
      p.sz += f.sz;
      p.entryNotional += f.sz * f.px;
      p.fee += f.fee;
    } else {
      if (!p) continue; // 창 시작 전에 열린 포지션의 잔여 청산 — 복원 불가
      p.closedSz += f.sz;
      p.exitNotional += f.sz * f.px;
      p.pnl += f.pnl;
      p.fee += f.fee;
      p.exitTs = f.ts;
      if (f.liq) p.liq = true;
      if (p.closedSz >= p.sz - 1e-9) {
        trades.push(p);
        open.delete(key);
      }
    }
  }
  return trades;
}

/**
 * 단방향(net) 모드 — 2024Q2 이전 구간은 buy(1)/sell(2)로 기록돼 있다.
 * 부호 있는 포지션을 재생한다: 0 → 보유 → 0 이 한 라운드트립이고,
 * 0 을 가로지르는 체결(플립)은 청산분과 신규 진입분으로 쪼갠다.
 * SPOT·MARGIN 의 1/2 는 포지션이 아니다 — SWAP 만 본다.
 */
function reconstructNetMode(bills) {
  const fills = bills
    .filter((b) => b.instType === "SWAP" && (b.subType === "1" || b.subType === "2"))
    .map((b) => ({
      ts: Number(b.ts),
      instId: b.instId,
      sign: b.subType === "1" ? 1 : -1,
      sz: Number(b.sz),
      px: Number(b.px),
      pnl: Number(b.pnl || 0),
      fee: Number(b.fee || 0),
      mgnMode: b.mgnMode,
    }))
    .sort((a, b) => a.ts - b.ts);

  const state = new Map(); // instId → { pos, trip }
  const trades = [];
  const newTrip = (f, sz) => ({
    instId: f.instId, dir: f.sign > 0 ? "long" : "short", entryTs: f.ts, exitTs: f.ts,
    sz, entryNotional: sz * f.px, exitNotional: 0, closedSz: 0, pnl: 0, fee: 0, liq: false, mgnMode: f.mgnMode,
  });
  for (const f of fills) {
    const st = state.get(f.instId) ?? { pos: 0, trip: null };
    state.set(f.instId, st);
    if (st.pos === 0 || Math.sign(st.pos) === f.sign) {
      // 신규 또는 증량
      if (!st.trip) st.trip = newTrip(f, 0);
      st.trip.sz += f.sz;
      st.trip.entryNotional += f.sz * f.px;
      st.trip.fee += f.fee;
      st.pos += f.sign * f.sz;
      continue;
    }
    // 감량·청산·플립
    const closeSz = Math.min(f.sz, Math.abs(st.pos));
    if (st.trip) {
      st.trip.closedSz += closeSz;
      st.trip.exitNotional += closeSz * f.px;
      st.trip.pnl += f.pnl;
      st.trip.fee += f.fee;
      st.trip.exitTs = f.ts;
    }
    st.pos += f.sign * f.sz;
    if (Math.abs(st.pos) < 1e-9) {
      if (st.trip) trades.push(st.trip);
      st.trip = null;
      st.pos = 0;
    } else if (Math.sign(st.pos) === f.sign) {
      // 플립 — 이전 트립을 닫고 잔여 수량으로 새 트립을 연다
      if (st.trip) trades.push(st.trip);
      st.trip = newTrip(f, f.sz - closeSz);
    }
  }
  return trades;
}

function toTradeRecord(p, account) {
  return {
    id: `bill-${account}-${p.instId}-${p.dir}-${p.entryTs}`,
    source: "okx-archive",
    sourceName: `OKX 원장(${account})`,
    account,
    instId: p.instId,
    side: p.dir,
    lever: null, // 청구서에는 레버가 없다 — 증거금 기준 지표는 이 거래에선 생략된다
    mgnMode: p.mgnMode,
    entryTs: p.entryTs,
    exitTs: p.exitTs,
    entryPx: p.entryNotional / p.sz,
    exitPx: p.closedSz > 0 ? p.exitNotional / p.closedSz : null,
    pnlUsd: Math.round((p.pnl + p.fee) * 100) / 100,
    pnlGrossUsd: Math.round(p.pnl * 100) / 100,
    pnlRatioPct: null,
    feeUsd: Math.round(p.fee * 10000) / 10000,
    fundingUsd: null,
    liq: p.liq,
    adl: false,
    closeType: null,
    stopPx: null,
    note: null,
  };
}

function reconcile(bills) {
  const tStore = loadData("manual-trades.json");
  if (!tStore) return;
  const existing = tStore.trades;
  const acctOf = (t) => t.account ?? (t.id.startsWith("okxv-") ? "app" : "live");
  const overlaps = (a, b) =>
    a.instId === b.instId && a.side === b.side &&
    a.entryTs <= (b.exitTs ?? b.entryTs) + 60_000 && (a.exitTs ?? a.entryTs) >= b.entryTs - 60_000;

  let freshAll = [];
  for (const account of new Set(bills.map((b) => b._account ?? "live"))) {
    const recon = reconstructTrades(bills, account);
    const mine = existing.filter((e) => e.source !== "journal" && acctOf(e) === account);
    const fresh = recon.filter((r) => !mine.some((e) => overlaps(r, e)));
    console.log(`원장 재구성[${account}]: 라운드트립 ${recon.length}건 · 기존 이력과 대조 → 신규 ${fresh.length}건`);
    freshAll = freshAll.concat(fresh);
  }
  if (freshAll.length) {
    tStore.trades = [...existing, ...freshAll].sort((a, b) => a.entryTs - b.entryTs);
    tStore.updatedAt = Date.now();
    saveData("manual-trades.json", tStore);
    console.log("  → manual-trades.json 에 편입. manual-fetch(캔들 창) → analyze → report 를 다시 돌려라.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
