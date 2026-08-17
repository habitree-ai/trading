/**
 * 페이퍼 북 DB 거울 — 파일이 정본, DB 는 최선-노력 사본.
 *
 * state-db.mjs(본대: DB 가 정본)와 철학이 다르다: 전방 검증 러너들은 파일 저장이
 * 정본으로 남는다(DB 장애가 페이퍼 사이클을 깨면 안 된다). 이 모듈은 같은 표
 * (system_state·system_trades·system_equity·system_decisions)에 북 이름 그대로
 * 복사해 "매매 진행이 머신 밖(앱·다른 기기)에서도 보이게" 한다.
 *
 * 전제: supabase/migrations/0020_system_books.sql 적용(enum 에 cand·ens·swing·manual 추가).
 * 적용 전에는 첫 실패에서 경고 한 번 남기고 이후 조용히 건너뛴다 — 러너는 멈추지 않는다.
 */

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const USER_ID = process.env.SYSTEM_BOT_USER_ID;

const enabled = Boolean(BASE && KEY && USER_ID);
let dead = false; // enum 미적용 등 구조적 실패 — 세션 동안 재시도하지 않는다.

async function rest(method, path, body, prefer) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
}

async function tryMirror(kind, fn) {
  if (!enabled || dead) return;
  try {
    await fn();
  } catch (e) {
    // enum 값 부재(22P02)·표 부재는 구조적 — 마이그레이션 전이다. 한 번만 알리고 끈다.
    if (/22P02|invalid input value for enum|relation .* does not exist/.test(e.message)) {
      dead = true;
      console.warn(`DB 거울 비활성(${kind}): ${e.message} — 0020 마이그레이션 적용 후 재시작하면 켜진다.`);
    } else {
      console.warn(`DB 거울 실패(${kind}): ${e.message}`);
    }
  }
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export async function mirrorState(book, state) {
  await tryMirror("state", () =>
    rest(
      "POST",
      "system_state?on_conflict=user_id,mode",
      {
        user_id: USER_ID,
        mode: book,
        equity: state.equity ?? null,
        last_bar_ts: state.lastBarTs ?? {},
        positions: state.positions ?? {},
      },
      "resolution=merge-duplicates",
    ));
}

export async function mirrorTradeOpen(book, pos) {
  await tryMirror("trade-open", () =>
    rest(
      "POST",
      "system_trades?on_conflict=user_id,mode,trade_id",
      {
        user_id: USER_ID,
        mode: book,
        trade_id: `${pos.member}-${pos.entryTs ?? pos.signalTs}`,
        member: pos.member,
        name: pos.name,
        side: pos.side,
        entry_ts: iso(pos.entryTs ?? pos.signalTs),
        entry_price: pos.entryPrice,
        stop: pos.stop,
        target: pos.target,
        lev: pos.lev,
        risk_pct: pos.riskPct,
        eq_at_entry: pos.eqAtEntry,
        signal: pos.signal ?? null,
        ord_id: pos.ordId ?? null,
        algo_cl_ord_id: pos.algoClOrdId ?? null,
        sz: pos.sz ?? null,
      },
      "resolution=merge-duplicates",
    ));
}

export async function mirrorTradeClose(book, rec) {
  await tryMirror("trade-close", () =>
    rest(
      "PATCH",
      `system_trades?user_id=eq.${USER_ID}&mode=eq.${book}&trade_id=eq.${encodeURIComponent(rec.tradeId)}`,
      {
        exit_ts: iso(rec.exitTs),
        exit_price: rec.exitPrice,
        exit_type: rec.exitType,
        hold_bars: rec.holdBars ?? null,
        net_pct: rec.netPct,
        pnl_usd: rec.pnlUsd ?? null,
        equity_after: rec.equityAfter ?? null,
        closed_at: new Date().toISOString(),
      },
    ));
}

export async function mirrorEquity(book, equity, openMembers) {
  await tryMirror("equity", () =>
    rest("POST", "system_equity", {
      user_id: USER_ID,
      mode: book,
      equity,
      open_members: openMembers ?? [],
    }));
}

/** 결정 기록은 신호·경고만 거울에 — 무사건 봉까지 복사하면 소음이 된다(전체는 파일에 있다). */
export async function mirrorDecision(book, d) {
  if (!d.fired && !d.warn) return;
  await tryMirror("decision", () =>
    rest("POST", "system_decisions", {
      user_id: USER_ID,
      mode: book,
      member: d.member ?? null,
      tf: d.tf ?? null,
      bar_ts: iso(d.barTs),
      fired: d.fired ?? null,
      action: d.action ?? null,
      skip: d.skip ?? null,
      warn: d.warn ?? null,
      indicators: d.indicators ?? null,
    }));
}
