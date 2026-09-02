"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { placeManualOrder, type ManualOrderState } from "@/app/(app)/order/actions";
import { OrderChart } from "@/app/(app)/order/order-chart";
import type { OrderAccountStatus } from "@/app/(app)/order/status";
import { DRAW_TOOLS, DrawToolbar, useDrawingBoard } from "@/components/drawing-board";
import { formatLevel } from "@/lib/annotation-levels";
import { isPositionKind, type Side } from "@/lib/domain";
import { num, pct } from "@/lib/format";
import {
  MAX_LEVERAGE,
  MIN_RATIONALE_CHARS,
  attachedTarget,
  gateOpen,
  marginNeeded,
  planGate,
  planRisk,
  sizeOrder,
  type DailyStatus,
  type OrderPlan,
} from "@/lib/manual-order";
import type { FieldSuggestions } from "@/lib/queries";
import { DAILY_MAX_LOSSES, DAILY_MAX_TRADES } from "@/lib/trade-rules";

/** 상품 규격 + 현재가 — `/api/instrument` 응답. */
interface Market {
  instId: string;
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
  szDecimals: number;
  pxDecimals: number;
  last: number;
}

/** 현재가를 다시 읽는 주기(ms) — 손절·목표의 방향 판정이 오래된 시세를 보지 않게. */
const PRICE_REFRESH_MS = 30_000;
/** 봉이 넘어갔는지 보는 주기(ms) — 4분할과 같다. */
const CHART_REFRESH_MS = 60_000;

/** 칩으로 보여 줄 최대 개수 — 거래 폼과 같은 숫자. */
const CHIP_LIMIT = 8;

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

function numOf(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 근거 게이트 주문 패널 — 차트(근거를 그리는 자리)와 폼(근거를 적는 자리), 그리고 게이트.
 *
 * 게이트의 규칙은 `manual-order.ts` 가 정하고 여기서는 그 결과를 보여 줄 뿐이다. 서버 액션도
 * 같은 함수를 돌리므로 여기서 열린 버튼은 서버에서도 열려 있다(시세가 그 사이 크게 움직인
 * 경우만 예외이고, 그때는 서버가 이유를 적어 거절한다).
 */
export function OrderPanel({
  status,
  suggestions,
  daily,
  halfKelly,
  now: initialNow,
}: {
  status: OrderAccountStatus;
  suggestions: FieldSuggestions;
  daily: DailyStatus;
  /** 절반 켈리(0~1) — 완결 거래가 모자라면 null */
  halfKelly: number | null;
  now: number;
}) {
  const [symbol, setSymbol] = useState("BTC");
  const [symbolInput, setSymbolInput] = useState("BTC");
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CHART_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  /* ---------- 상품·현재가 ---------- */
  const [market, setMarket] = useState<Market | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/instrument?symbol=${encodeURIComponent(symbol)}`);
        const json: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as { error: unknown }).error)
              : "상품 정보를 가져오지 못했습니다.";
          throw new Error(message);
        }
        if (!cancelled) {
          setMarket(json as Market);
          setMarketError(null);
        }
      } catch (e) {
        if (!cancelled) setMarketError(e instanceof Error ? e.message : "알 수 없는 오류");
      }
    }
    void load();
    const id = setInterval(load, PRICE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  /* ---------- 폼 ---------- */
  const [side, setSide] = useState<Side>("long");
  const [notional, setNotional] = useState("");
  const [leverage, setLeverage] = useState("10");
  const [stop, setStop] = useState("");
  const [tps, setTps] = useState(["", "", ""]);
  const [setup, setSetup] = useState("");
  const [rationale, setRationale] = useState("");
  const [emotion, setEmotion] = useState("");
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ManualOrderState>({});

  const board = useDrawingBoard();

  /**
   * 차트 손익 툴 → 폼.
   *
   * 가장 최근에 그리거나 옮긴 손익 툴의 [진입, 손절, 목표] 가 방향·손절·TP1 이 된다.
   * 진입은 시장가라 참고값이고 폼에는 넣지 않는다. 같은 도형을 같은 자리에 두고는 다시
   * 덮어쓰지 않는다 — 손으로 고친 값이 렌더마다 되돌아가면 안 된다.
   */
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    const latest = board.annotations
      .filter((a) => isPositionKind(a.kind))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .at(-1);
    if (!latest) return;
    const key = `${latest.id}:${latest.updated_at}`;
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    setSide(latest.kind === "long" ? "long" : "short");
    setStop(formatLevel(latest.points[1]?.p));
    setTps((cur) => [formatLevel(latest.points[2]?.p), cur[1], cur[2]]);
    setNote("차트 손익 툴의 손절·목표를 폼에 넣었습니다.");
  }, [board.annotations]);

  const commitSymbol = () => {
    const next = symbolInput.trim().toUpperCase();
    if (next === "" || next === symbol) {
      setSymbolInput(symbol);
      return;
    }
    setSymbol(next);
    setSymbolInput(next);
    setMarket(null);
    board.clear("종목을 바꿔 그린 내용을 비웠습니다.");
  };

  /* ---------- 계산 — 화면과 서버가 같은 함수를 본다 ---------- */
  const price = market?.last ?? null;
  const plan: OrderPlan = useMemo(
    () => ({
      side,
      price: price ?? 0,
      stop: numOf(stop),
      targets: tps.map(numOf),
      notionalUsd: numOf(notional),
      leverage: numOf(leverage),
      setup,
      rationale,
    }),
    [side, price, stop, tps, notional, leverage, setup, rationale],
  );
  const minNotional = market ? market.minSz * market.ctVal * market.last : null;
  const gate = useMemo(() => planGate(plan, { minNotional }), [plan, minNotional]);
  const sizing =
    market && plan.notionalUsd !== null
      ? sizeOrder({
          notionalUsd: plan.notionalUsd,
          price: market.last,
          ctVal: market.ctVal,
          lotSz: market.lotSz,
          szDecimals: market.szDecimals,
        })
      : null;
  const margin = sizing && plan.leverage ? marginNeeded(sizing.notional, plan.leverage) : null;
  const equity = status.order?.equity ?? null;
  const risk = planRisk(plan, equity);
  const target = attachedTarget(plan.targets);

  const accountOk = status.hasKeys && status.order !== null && status.match === true && status.errors.length === 0;
  const sizeOk = sizing !== null && market !== null && sizing.contracts >= market.minSz;
  const balanceOk = margin !== null && equity !== null && equity >= margin.need;
  const ready = market !== null && gateOpen(gate) && accountOk && sizeOk && balanceOk;

  const halfKellyAmount = halfKelly !== null && equity !== null ? halfKelly * equity : null;
  const overKelly = risk !== null && halfKellyAmount !== null && risk.riskAmount > halfKellyAmount;

  const submit = () => {
    startTransition(async () => {
      setState({});
      try {
        const fd = new FormData();
        fd.set("symbol", symbol);
        fd.set("side", side);
        fd.set("notional_usd", notional);
        fd.set("leverage", leverage);
        fd.set("stop_price", stop);
        fd.set("tp1_price", tps[0]);
        fd.set("tp2_price", tps[1]);
        fd.set("tp3_price", tps[2]);
        fd.set("setup", setup);
        fd.set("rationale", rationale);
        fd.set("emotion", emotion);
        fd.set("ack", ack ? "on" : "");
        fd.set(
          "annotations",
          JSON.stringify(
            board.annotations.map((a) => ({
              kind: a.kind,
              points: a.points,
              text: a.text,
              color: a.color,
              line_width: a.line_width ?? null,
              line_style: a.line_style ?? null,
            })),
          ),
        );
        setState(await placeManualOrder({}, fd));
      } catch {
        // 액션이 던지면 주문이 나갔는지 모호하다 — 재클릭 유도 전에 확인부터 시키는 문구.
        setState({
          error: "요청이 중단됐습니다 — 주문 접수 여부가 불확실합니다. 거래소 포지션을 확인한 뒤 다시 시도하세요.",
        });
      } finally {
        // 성공이든 실패든 다음 주문은 다시 확인부터 — 연타로 나가는 실주문은 없다.
        setAck(false);
      }
    });
  };

  const resetForNext = () => {
    setState({});
    setStop("");
    setTps(["", "", ""]);
    setRationale("");
    setEmotion("");
    setNote(null);
    board.clear(null);
    appliedRef.current = null;
  };

  const { tool, positionStep, problem, notice } = board;

  return (
    <div className="space-y-4">
      {/* ── 계좌 — 주문이 어디로 나가는지가 숫자로 먼저 보여야 한다 ── */}
      <AccountCard status={status} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── 차트 — 근거를 그리는 자리 ── */}
        <section className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            <label className="mr-1 flex items-center gap-1 text-xs text-dim">
              종목
              <input
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                onBlur={commitSymbol}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitSymbol();
                }}
                className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text uppercase outline-none focus:border-accent"
                aria-label="종목 — OKX USDT 무기한"
              />
            </label>
            <span className="tnum mr-1 text-[11px] text-dim">
              {market ? (
                <>
                  현재가 <b className="text-text">{market.last.toLocaleString()}</b>
                </>
              ) : marketError ? (
                <span className="text-loss">{marketError}</span>
              ) : (
                "시세 읽는 중…"
              )}
            </span>
            <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
            <DrawToolbar board={board} />
          </div>

          <OrderChart symbol={symbol} now={now} board={board} />

          <p className="truncate text-[10px] text-dim">
            {positionStep ? (
              <b className="text-accent">
                {tool === "long" ? "롱" : "숏"} 손익 — {positionStep} (진입 → 손절 → 목표). 다 찍으면 폼에
                들어갑니다.
              </b>
            ) : tool !== "none" ? (
              <b className="text-accent">
                {DRAW_TOOLS.find((t) => t.tool === tool)?.hint} — 다시 누르면 끕니다.
              </b>
            ) : problem ? (
              <b className="text-loss">{problem}</b>
            ) : notice ? (
              notice
            ) : (
              <>
                손익 툴로 손절·목표를 찍으면 폼에 들어갑니다 · 눌러 고르고 끌어 이동 · 더블클릭 수치 입력 ·{" "}
                <b className="text-text">Del</b> 삭제 · <b className="text-text">Ctrl+Z</b> 되돌리기 · 그린
                것은 주문과 함께 거래에 저장됩니다
              </>
            )}
          </p>
        </section>

        {/* ── 폼 — 근거를 적는 자리 ── */}
        <section className="space-y-3 rounded-xl border border-border bg-surface p-3">
          <div>
            <span className={LABEL}>방향</span>
            <div className="flex gap-2">
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  aria-pressed={side === s}
                  className={`flex-1 rounded-lg border px-3 py-2 text-center text-sm ${
                    side === s
                      ? s === "long"
                        ? "border-profit text-profit"
                        : "border-loss text-loss"
                      : "border-border text-dim"
                  }`}
                >
                  {s === "long" ? "롱 (L)" : "숏 (S)"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="o-notional">
                투입 (명목가, USDT)
              </label>
              <input
                id="o-notional"
                value={notional}
                onChange={(e) => setNotional(e.target.value)}
                inputMode="decimal"
                className={`${INPUT} tnum`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="o-leverage">
                레버리지 (1~{MAX_LEVERAGE})
              </label>
              <input
                id="o-leverage"
                value={leverage}
                onChange={(e) => setLeverage(e.target.value)}
                inputMode="decimal"
                className={`${INPUT} tnum`}
              />
            </div>
          </div>
          <p className="tnum text-[11px] text-dim">
            {sizing && market ? (
              <>
                {sizing.sz}계약 ≈ {num(sizing.notional, 2)} USDT · 증거금 {num(margin?.margin ?? null, 2)}
                {margin ? <> · 필요 잔고 {num(margin.need, 2)}</> : null}
                {minNotional !== null ? <> · 최소 {num(minNotional, 2)}</> : null}
              </>
            ) : (
              "투입을 적으면 계약 수·증거금이 계산됩니다 (시장가 · 격리)"
            )}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="o-stop">
                손절가 *
              </label>
              <input
                id="o-stop"
                value={stop}
                onChange={(e) => setStop(e.target.value)}
                inputMode="decimal"
                className={`${INPUT} tnum`}
              />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <label className={LABEL} htmlFor={`o-tp${i + 1}`}>
                  TP{i + 1}
                  {i === 0 ? " *" : ""}
                </label>
                <input
                  id={`o-tp${i + 1}`}
                  value={tps[i]}
                  onChange={(e) =>
                    setTps((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  inputMode="decimal"
                  className={`${INPUT} tnum`}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-dim">
            {target !== undefined
              ? "손절과 목표가 거래소 브래킷으로 함께 걸립니다."
              : plan.targets.filter((t) => t !== null).length > 1
                ? "TP 가 여러 단이라 손절만 걸립니다 — 분할 익절은 거래소에서 직접 겁니다."
                : "손절은 항상 거래소에 함께 걸립니다."}
          </p>

          {/* 리스크 — 이 주문에서 잃을 수 있는 돈 */}
          <div className="rounded-lg border border-border bg-bg p-2.5 text-[12px]">
            {risk ? (
              <>
                <div className="tnum">
                  손절 시 <b className={overKelly ? "text-loss" : "text-text"}>−{num(risk.riskAmount, 2)} USDT</b>
                  {risk.riskPctOfEquity !== null ? (
                    <span className="text-dim"> (잔고의 {pct(risk.riskPctOfEquity, 2)})</span>
                  ) : null}
                  {" · "}손익비 <b className="text-text">{num(risk.rr, 2)}</b>
                  <span className="text-dim">
                    {" "}
                    (손절폭 {pct(risk.riskPct * 100, 2)} · 목표폭 {pct(risk.rewardPct * 100, 2)})
                  </span>
                </div>
                {halfKellyAmount !== null ? (
                  <div className={`tnum mt-1 ${overKelly ? "text-loss" : "text-dim"}`}>
                    권장 상한(½ 켈리) ≈ {num(halfKellyAmount, 2)} USDT
                    {overKelly ? " — 이 주문의 리스크가 상한을 넘습니다" : ""}
                  </div>
                ) : null}
              </>
            ) : (
              <span className="text-dim">손절·목표·투입을 채우면 리스크와 손익비가 나옵니다.</span>
            )}
          </div>

          <div>
            <label className={LABEL} htmlFor="o-setup">
              기준 (셋업) *
            </label>
            <input
              id="o-setup"
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              list="o-setup-list"
              className={INPUT}
            />
            <datalist id="o-setup-list">
              {suggestions.setup.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
            {suggestions.setup.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestions.setup.slice(0, CHIP_LIMIT).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setSetup(o)}
                    aria-pressed={setup === o}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${
                      setup === o ? "border-accent text-accent" : "border-border text-dim"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div>
            <div className="mb-1 flex items-baseline gap-2">
              <label className="text-xs text-dim" htmlFor="o-rationale">
                근거 * <span className="text-dim/70">왜 지금, 왜 여기서, 어디서 틀렸다고 볼 것인가</span>
              </label>
              <span
                className={`tnum ml-auto text-[11px] ${
                  rationale.trim().length >= MIN_RATIONALE_CHARS ? "text-profit" : "text-dim"
                }`}
              >
                {rationale.trim().length}/{MIN_RATIONALE_CHARS}자
              </span>
            </div>
            <textarea
              id="o-rationale"
              rows={4}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className={INPUT}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="o-emotion">
              감정 <span className="text-dim/70">지금 상태 — 같은 말로 적어야 통계가 묶인다</span>
            </label>
            <input
              id="o-emotion"
              value={emotion}
              onChange={(e) => setEmotion(e.target.value)}
              list="o-emotion-list"
              className={INPUT}
            />
            <datalist id="o-emotion-list">
              {suggestions.emotion.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>

          {/* 하루 규칙 — 경고만 한다 */}
          <p
            className={`text-[11px] ${
              daily.overEntries || daily.overLosses ? "font-medium text-loss" : "text-dim"
            }`}
          >
            오늘 {daily.nextEntryNo}번째 진입 (상한 {DAILY_MAX_TRADES}건) · 오늘 손실 {daily.lossesToday}건 (
            {DAILY_MAX_LOSSES}건이면 종료)
            {daily.overEntries ? " — 상한을 넘는 진입입니다" : ""}
            {daily.overLosses ? " — 오늘은 그만두기로 한 날입니다" : ""}
          </p>

          {/* 게이트 — 전부 초록이어야 버튼이 열린다 */}
          <ul className="space-y-1 rounded-lg border border-border bg-bg p-2.5 text-[12px]">
            {gate.map((g) => (
              <GateRow key={g.key} ok={g.ok} label={g.label} detail={g.detail} />
            ))}
            <GateRow
              ok={accountOk}
              label="계좌 일치"
              detail={
                accountOk
                  ? `주문 계좌 uid ${status.order?.uid}`
                  : (status.errors[0] ?? "주문 키 없음")
              }
            />
            <GateRow
              ok={sizeOk}
              label="계약 수"
              detail={sizing && market ? `${sizing.sz}계약 (최소 ${market.minSz})` : "시세·투입 필요"}
            />
            <GateRow
              ok={balanceOk}
              label="잔고"
              detail={
                equity === null
                  ? "계좌를 읽지 못했습니다"
                  : margin
                    ? `${num(equity, 2)} / 필요 ${num(margin.need, 2)}`
                    : `${num(equity, 2)} USDT`
              }
            />
          </ul>

          {note ? <p className="text-[11px] text-accent">{note}</p> : null}

          {state.ok ? (
            <div className="rounded-lg border border-profit/50 bg-profit/10 p-3 text-xs">
              <p className="text-profit">{state.ok.detail}</p>
              <div className="mt-2 flex gap-2">
                <Link
                  href={`/trades/${state.ok.tradeId}`}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
                >
                  거래 열기 →
                </Link>
                <button
                  type="button"
                  onClick={resetForNext}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim hover:text-text"
                >
                  다음 주문 준비
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 border-t border-border pt-3">
              <label className="flex items-center gap-1.5 text-xs text-dim">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                실제 자금으로 주문됨을 확인했습니다
              </label>
              <button
                type="button"
                disabled={pending || !ack || !ready}
                onClick={submit}
                className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 ${
                  side === "long" ? "bg-profit" : "bg-loss"
                }`}
              >
                {pending
                  ? "주문 중…"
                  : ready
                    ? `${side === "long" ? "롱" : "숏"} 시장가 주문 (${symbol})`
                    : "근거 게이트가 닫혀 있습니다"}
              </button>
              {state.error ? (
                <p className={`text-xs ${state.ordId ? "font-semibold text-loss" : "text-loss"}`}>
                  {state.error}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function GateRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className={ok ? "text-profit" : "text-loss"} aria-hidden>
        {ok ? "✓" : "✗"}
      </span>
      <span className={ok ? "" : "text-loss"}>{label}</span>
      <span className="tnum ml-auto truncate text-right text-dim">{detail}</span>
    </li>
  );
}

/**
 * 주문이 나갈 계좌 — 08-19 사고의 교훈 그대로, uid 를 숫자로 적는다.
 *
 * 동기화 계좌와 나란히 놓아 같은지 한눈에 보이게 한다. 키가 없으면 어느 계좌의 키를
 * 만들어야 하는지(동기화 계좌 uid)를 알려 준다.
 */
function AccountCard({ status }: { status: OrderAccountStatus }) {
  const tone = status.match === true && status.errors.length === 0 ? "border-profit/40" : "border-loss/50";
  return (
    <section className={`rounded-xl border ${tone} bg-surface p-4`}>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        <div>
          <h2 className="text-sm font-medium">주문이 나갈 계좌</h2>
          {status.order ? (
            <p className="tnum mt-1 text-[13px]">
              uid <b>{status.order.uid}</b>
              {status.order.mainUid && status.order.mainUid !== status.order.uid ? (
                <span className="text-dim"> · 서브계정 (메인 {status.order.mainUid})</span>
              ) : (
                <span className="text-dim"> · 메인 계정</span>
              )}
              <span className="text-dim"> · 잔고 {num(status.order.equity, 2)} USDT</span>
            </p>
          ) : status.hasKeys ? (
            <p className="mt-1 text-[13px] text-loss">계좌를 확인하지 못했습니다.</p>
          ) : (
            <p className="mt-1 text-[13px] text-dim">
              주문 키(<code className="rounded bg-surface-2 px-1">OKX_MANUAL_API_KEY</code> ·{" "}
              <code className="rounded bg-surface-2 px-1">OKX_MANUAL_API_SECRET</code> ·{" "}
              <code className="rounded bg-surface-2 px-1">OKX_MANUAL_API_PASSPHRASE</code>)가 없습니다 — 거래
              권한으로 발급해 넣으면 열립니다.
            </p>
          )}
        </div>
        <div>
          <h2 className="text-sm font-medium">이 북이 받는 계좌 (동기화)</h2>
          <p className="tnum mt-1 text-[13px]">
            {status.sync ? (
              <>
                uid <b>{status.sync.uid}</b>
              </>
            ) : (
              <span className="text-dim">연결 안 됨</span>
            )}
          </p>
        </div>
        <div className="self-center">
          {status.match === true ? (
            <span className="rounded border border-profit px-2 py-1 text-xs font-semibold text-profit">
              같은 계좌
            </span>
          ) : status.match === false ? (
            <span className="rounded border border-loss px-2 py-1 text-xs font-semibold text-loss">
              다른 계좌 — 주문 닫힘
            </span>
          ) : (
            <span className="rounded border border-border px-2 py-1 text-xs text-dim">확인 불가 — 주문 닫힘</span>
          )}
        </div>
      </div>
      {status.errors.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11.5px] text-loss">
          {status.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-[11px] text-dim">
        주문은 이 키의 계좌로, 청산 기록은 동기화 계좌에서 온다 — 둘이 다르면 방금 만든 거래가 영원히 안
        닫히므로 같을 때만 연다. 시장가 · 격리 · 손절 브래킷 부착.
      </p>
    </section>
  );
}
