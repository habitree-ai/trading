/**
 * 상태·기록 저장 (Supabase) — 쿼드 본대 전용.
 *
 * `state.mjs`(파일)와 같은 계약을 제공한다: loadState / saveState / appendLog.
 * 바뀐 것은 저장 위치뿐이고, 부르는 쪽은 이 셋이 비동기가 된 만큼 await 만 붙이면 된다.
 *
 * 왜 state.mjs 를 고치지 않고 파일을 나눴나:
 *   전방 검증 러너들(candidates·ensemble-paper·swing-paper)이 같은 함수를 쓰는데,
 *   그쪽 북 이름은 "cand"·"ens"·"swing" 이라 `system_mode` enum(paper·demo·live)에 없다.
 *   한 파일을 DB 로 갈아끼우면 그 러너들이 통째로 죽는다. 본대만 옮기고 나머지는 둔다.
 *
 * 옮기는 이유는 봇을 돌리는 PC 밖에서도 상태가 보여야 하기 때문이다. 파일은 그 머신에
 * 갇혀 있어 앱이 읽지 못했고, 서버리스 함수에는 다음 호출까지 남는 파일이 없다.
 *
 * 필요한 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL · SUPABASE_SECRET_KEY · SYSTEM_BOT_USER_ID
 * service_role 키로 붙으므로 RLS 를 우회한다 — 이 키는 서버·로컬 봇에만 둔다.
 */

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const USER_ID = process.env.SYSTEM_BOT_USER_ID;

function assertEnv() {
  const missing = [
    ["NEXT_PUBLIC_SUPABASE_URL", BASE],
    ["SUPABASE_SECRET_KEY", KEY],
    ["SYSTEM_BOT_USER_ID", USER_ID],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `상태 저장에 필요한 환경변수가 없습니다: ${missing.join(", ")}\n` +
      "--env-file 로 .env.local 을 주입했는지 확인하세요.",
    );
  }
}

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
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** epoch ms → ISO. DB 의 시각 칸은 timestamptz 다(lastBarTs 만 ms 숫자 그대로 둔다). */
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export async function loadState(mode, paperStartEquity) {
  assertEnv();
  const rows = await rest("GET", `system_state?user_id=eq.${USER_ID}&mode=eq.${mode}&select=*`);
  const row = rows?.[0];
  if (row) {
    return {
      mode,
      createdAt: new Date(row.created_at).getTime(),
      // numeric 은 문자열로 오기도 한다 — 숫자로 고정하지 않으면 사이징이 문자열 연산이 된다.
      equity: row.equity === null || row.equity === undefined ? null : Number(row.equity),
      lastBarTs: row.last_bar_ts ?? {},
      positions: row.positions ?? {},
    };
  }
  // 첫 실행 — lastBarTs 가 비어 있으면 엔진은 최신 봉만 본다(놓친 봉 소급 없음).
  return {
    mode,
    createdAt: Date.now(),
    equity: mode === "paper" ? paperStartEquity : null,
    lastBarTs: {},
    positions: {},
  };
}

/**
 * 상태 저장 — 실패하면 던진다.
 *
 * 기록(appendLog)과 달리 이건 지나간 일의 기록이 아니라 다음 사이클의 재개 지점이다.
 * 조용히 삼키면 같은 봉을 다시 평가하거나, 열린 포지션을 잊은 채 또 들어간다.
 */
export async function saveState(state) {
  assertEnv();
  await rest(
    "POST",
    "system_state?on_conflict=user_id,mode",
    {
      user_id: USER_ID,
      mode: state.mode,
      equity: state.equity,
      last_bar_ts: state.lastBarTs,
      positions: state.positions,
    },
    // 보낸 칸만 덮어쓴다 — locked_until·live_enabled 는 건드리지 않는다.
    "resolution=merge-duplicates",
  );
}

/**
 * 기록 추가 — 실패해도 사이클을 멈추지 않는다.
 *
 * 알림(notify)과 같은 판단이다: 지나간 일의 기록이 매매를 깨서는 안 된다.
 * 유실은 콘솔 경고가 알린다.
 */
export async function appendLog(mode, name, obj) {
  try {
    assertEnv();
    if (name === "decisions") await insertDecision(mode, obj);
    else if (name === "equity") await insertEquity(mode, obj);
    else if (name === "trades") await saveTrade(mode, obj);
  } catch (e) {
    console.warn(`기록 실패(${name}): ${e.message}`);
  }
}

async function insertDecision(mode, obj) {
  await rest("POST", "system_decisions", {
    user_id: USER_ID,
    mode,
    member: obj.member ?? null,
    tf: obj.tf ?? null,
    bar_ts: iso(obj.barTs),
    fired: obj.fired ?? null,
    action: obj.action ?? null,
    skip: obj.skip ?? null,
    warn: obj.warn ?? null,
    indicators: obj.indicators ?? null,
  });
}

async function insertEquity(mode, obj) {
  await rest("POST", "system_equity", {
    user_id: USER_ID,
    mode,
    equity: obj.equity,
    open_members: obj.open ?? [],
  });
}

/**
 * 거래 — 진입은 행을 만들고, 청산은 그 행을 닫는다.
 *
 * 청산을 새 행으로 남기지 않는 이유는 `trades` 와 같다: 진입에 붙은 판정 지표와
 * 청산 결과가 갈라지면 "왜 들어갔고 어떻게 끝났나"를 한 줄로 읽을 수 없다.
 */
async function saveTrade(mode, obj) {
  if (obj.type === "open") {
    await rest(
      "POST",
      "system_trades?on_conflict=user_id,mode,trade_id",
      {
        user_id: USER_ID,
        mode,
        trade_id: `${obj.member}-${obj.entryTs}`,
        member: obj.member,
        name: obj.name,
        side: obj.side,
        entry_ts: iso(obj.entryTs),
        entry_price: obj.entryPrice,
        stop: obj.stop,
        target: obj.target,
        lev: obj.lev,
        risk_pct: obj.riskPct,
        eq_at_entry: obj.eqAtEntry,
        signal: obj.signal ?? null,
        ord_id: obj.ordId ?? null,
        algo_cl_ord_id: obj.algoClOrdId ?? null,
        sz: obj.sz ?? null,
        notional_usd: obj.notionalUsd ?? null,
      },
      "resolution=merge-duplicates",
    );
    return;
  }
  if (obj.type === "close") {
    await rest(
      "PATCH",
      `system_trades?user_id=eq.${USER_ID}&mode=eq.${mode}&trade_id=eq.${encodeURIComponent(obj.tradeId)}`,
      {
        exit_ts: iso(obj.exitTs),
        exit_price: obj.exitPrice,
        exit_type: obj.exitType,
        hold_bars: obj.holdBars ?? null,
        net_pct: obj.netPct,
        pnl_usd: obj.pnlUsd ?? null,
        equity_after: obj.equityAfter ?? null,
        closed_at: new Date().toISOString(),
      },
    );
  }
}
