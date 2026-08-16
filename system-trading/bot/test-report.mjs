/**
 * 배선 테스트 리포트 — events-test-<mode>.jsonl 을 HTML로 만든다.
 *
 * 사용: node system-trading/bot/test-report.mjs [live|demo]
 *   → system-trading/docs/test-report.html
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mode = (process.argv[2] ?? "live").toLowerCase();
const src = join(here, "..", "data", `events-test-${mode}.jsonl`);
const out = join(here, "..", "docs", "test-report.html");

if (!existsSync(src)) {
  console.error(`기록이 없습니다: ${src} — 먼저 test-trade.mjs 를 실행하세요.`);
  process.exit(1);
}

const events = readFileSync(src, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const kst = (ms) =>
  new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 라운드별로 사건을 묶는다.
const rounds = new Map();
for (const e of events) {
  if (e.roundNo === undefined) continue;
  if (!rounds.has(e.roundNo)) rounds.set(e.roundNo, []);
  rounds.get(e.roundNo).push(e);
}
const starts = events.filter((e) => e.event === "test-start");
const lastStartIdx = starts.length ? events.lastIndexOf(starts[starts.length - 1]) : -1;
// CLI 세션(test-start)이 있으면 마지막 세션만, 앱 버튼만 썼으면 전체를 리포트한다.
const session = lastStartIdx >= 0 ? events.slice(lastStartIdx) : events;
const sessionRounds = new Map();
for (const e of session) {
  if (e.roundNo === undefined) continue;
  if (!sessionRounds.has(e.roundNo)) sessionRounds.set(e.roundNo, []);
  sessionRounds.get(e.roundNo).push(e);
}
const start = session.find((e) => e.event === "test-start") ?? {};
const end = session.find((e) => e.event === "test-end") ?? {};

const EXIT_LABEL = {
  tp: "목표 체결",
  sl: "손절 체결",
  algo: "브래킷 체결",
  "timeout-close": "시한 → 시장가 정리",
  "assumed-flat": "이미 청산됨 확인",
  "close-failed": "정리 실패 — 수동 확인!",
  "manual-close": "수동 정리(버튼)",
};
const APP_EVENT_LABEL = {
  "entry-try": "주문 시도",
  "entry-ok": "주문 접수",
  "entry-error": "주문 실패",
  "exit-bracket": "브래킷 체결 확인",
  "exit-assumed-flat": "이미 청산됨",
  "exit-manual-close": "수동 정리",
  "exit-error": "정리 실패",
};
const EXIT_EVENTS = ["exit-bracket", "exit-timeout-close", "exit-assumed-flat", "exit-close-FAILED"];
const isResolved = (evs) =>
  evs.some((e) => e.event === "entry-ok") &&
  evs.some((e) => EXIT_EVENTS.includes(e.event) && e.event !== "exit-close-FAILED");

const rows = [...sessionRounds.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([no, evs]) => {
    const entryTry = evs.find((e) => e.event === "entry-try");
    const entryOk = evs.find((e) => e.event === "entry-ok");
    const sig = evs.find((e) => e.event === "signal-fired");
    const exitEv = evs.find((e) => EXIT_EVENTS.includes(e.event));
    const done = evs.find((e) => e.event === "round-done");
    const timeoutEv = evs.find((e) => e.event === "signal-timeout");
    if (timeoutEv) {
      return `<tr><td>${no}</td><td colspan="7" style="color:var(--dim)">신호 대기 시간 초과 — 진입 시도 없음(배선 미검증 아님)</td><td style="color:var(--dim)">건너뜀</td></tr>`;
    }
    const ok = isResolved(evs);
    const exitType = exitEv?.exitType ?? (exitEv?.event === "exit-assumed-flat" ? "assumed-flat" : exitEv?.event === "exit-close-FAILED" ? "close-failed" : null);
    return `<tr>
      <td>${no}</td>
      <td>${sig ? `RSI ${Number(sig.prevRsi)}→${Number(sig.rsi)}` : "강제"}</td>
      <td>${entryTry?.side === "long" ? "롱" : "숏"}</td>
      <td>${entryTry ? Number(entryTry.refPx).toLocaleString() : "—"}</td>
      <td>${entryTry ? `${Number(entryTry.stop).toLocaleString()} / ${Number(entryTry.target).toLocaleString()}` : "—"}</td>
      <td>${entryOk ? `${Number(entryOk.latencyMs)}ms` : "—"}</td>
      <td>${exitType ? esc(EXIT_LABEL[exitType] ?? exitType) : "—"}</td>
      <td>${done?.heldMs ? Math.round(done.heldMs / 1000) + "초" : "—"}</td>
      <td class="${ok ? "up" : "down"}">${ok ? "왕복 성공" : "미완"}</td>
    </tr>`;
  })
  .join("");

// 신호가 안 와서 진입 자체가 없던 라운드는 분모에서 뺀다 — 배선이 시험되지 않은 것이지 실패가 아니다.
const attempted = [...sessionRounds.values()].filter((evs) => evs.some((e) => e.event === "entry-try"));
const total = attempted.length;
const okCount = attempted.filter(isResolved).length;

const timeline = session
  .map((e) => `<tr><td>${kst(e.at)}</td><td>${esc(e.event)}</td><td style="color:var(--dim)">${esc(JSON.stringify({ ...e, at: undefined, event: undefined }))}</td></tr>`)
  .join("");

const html = `<title>배선 테스트 결과</title>
<style>
  :root { color-scheme: dark; --bg:#0e1116; --surface:#161a21; --border:#2a3039; --ink:#e6e9ee; --dim:#8b95a3; --accent:#5b8cff; --profit:#26c281; --loss:#f0616d; --grid:#232935; }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg:#f7f8fa; --surface:#ffffff; --border:#e2e5ea; --ink:#14171c; --dim:#666e7a; --accent:#3b6ef5; --profit:#0f9d58; --loss:#dc3545; --grid:#eceef2; } }
  :root[data-theme="light"] { color-scheme: light; --bg:#f7f8fa; --surface:#ffffff; --border:#e2e5ea; --ink:#14171c; --dim:#666e7a; --accent:#3b6ef5; --profit:#0f9d58; --loss:#dc3545; --grid:#eceef2; }
  * { box-sizing:border-box; } .up{color:var(--profit)} .down{color:var(--loss)}
  body { margin:0; background:var(--bg); color:var(--ink); font-family:ui-sans-serif,system-ui,"Pretendard","Segoe UI","Malgun Gothic",sans-serif; font-size:14px; line-height:1.6; }
  .wrap { max-width:920px; margin:0 auto; padding:40px 20px 64px; }
  h1 { font-size:22px; font-weight:750; margin:0 0 4px; } h2 { font-size:16px; margin:36px 0 10px; }
  .meta { color:var(--dim); font-size:12.5px; margin:0 0 20px; }
  .verdict { border:1px solid var(--border); border-left:4px solid ${okCount === total && total > 0 ? "var(--profit)" : "var(--loss)"}; background:var(--surface); border-radius:10px; padding:12px 16px; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th,td { padding:8px 10px; text-align:left; white-space:nowrap; } th { color:var(--dim); font-size:11px; border-bottom:1px solid var(--border); }
  td { border-bottom:1px solid var(--grid); font-variant-numeric:tabular-nums; } tr:last-child td { border-bottom:none; }
  .scroll { overflow-x:auto; border-radius:10px; }
  footer { margin-top:40px; color:var(--dim); font-size:12px; border-top:1px solid var(--border); padding-top:14px; }
</style>
<div class="wrap">
  <h1>배선 테스트 결과</h1>
  <p class="meta">${esc(mode.toUpperCase())} · 1분봉 RSI 기준 · 최소 수량(${Number(start.minSz ?? 0.01)}계약) · 레버리지 ${Number(start.lev ?? 10)}배 ·
    목표 ±${Number(start.tpPct ?? 0.15)}% / 손절 ${Number(start.slPct ?? 0.1)}% ·
    시작 잔고 $${Number(start.equity ?? 0)} → 종료 잔고 $${end.equity !== undefined && end.equity !== null ? Number(end.equity) : "?"}</p>
  <div class="verdict"><b>${okCount}/${total} 라운드 왕복 완료</b> —
    ${okCount === total && total > 0 ? "진입·브래킷 부착·청산·기록의 전 배선이 동작한다." : "미완 라운드가 있다 — 아래 타임라인에서 원인을 확인할 것."}</div>
  <h2>라운드 요약 (CLI 실행)</h2>
  <div class="scroll"><table>
    <tr><th>#</th><th>트리거</th><th>방향</th><th>기준가</th><th>손절/목표</th><th>진입 지연</th><th>청산</th><th>보유</th><th>판정</th></tr>
    ${rows || '<tr><td colspan="9" style="color:var(--dim)">CLI 라운드 없음</td></tr>'}
  </table></div>
  ${(() => {
    const appEvents = session.filter((e) => e.source === "app");
    if (appEvents.length === 0) return "";
    const appRows = appEvents
      .map((e) => `<tr><td>${kst(e.at)}</td><td>${esc(APP_EVENT_LABEL[e.event] ?? e.event)}</td><td>${e.side === "long" ? "롱" : e.side === "short" ? "숏" : "—"}</td><td style="color:var(--dim)">${esc([e.refPx ? `기준가 ${e.refPx}` : "", e.stop ? `손절 ${e.stop}` : "", e.target ? `목표 ${e.target}` : "", e.ordId ? `ordId ${e.ordId}` : "", e.latencyMs ? `${e.latencyMs}ms` : "", e.actualPx ? `체결 ${e.actualPx}` : "", e.sz ? `${e.sz}계약` : "", e.error ?? ""].filter(Boolean).join(" · "))}</td></tr>`)
      .join("");
    return `<h2>앱 버튼 사건 (거래 페이지 실주문 테스트)</h2>
  <div class="scroll"><table>
    <tr><th>시각(KST)</th><th>사건</th><th>방향</th><th>상세</th></tr>
    ${appRows}
  </table></div>`;
  })()}
  <h2>전체 타임라인</h2>
  <div class="scroll"><table>
    <tr><th>시각(KST)</th><th>사건</th><th>데이터</th></tr>
    ${timeline}
  </table></div>
  <footer>이 테스트는 실전 기준(4H 쿼드)과 무관한 배선 검증이다 — 수량은 항상 최소, 손익은 목적이 아니다.
    기록 원본: system-trading/data/events-test-${mode}.jsonl</footer>
</div>`;

writeFileSync(out, html);
console.log(`리포트 생성: ${out} (${okCount}/${total} 라운드 완료)`);
