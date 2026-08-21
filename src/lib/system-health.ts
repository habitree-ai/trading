/**
 * 봇이 지금 돌고 있는가 — 화면이 스스로 답하게 한다.
 *
 * 여태 이 판정은 "마지막 사이클이 9시간을 넘겼다" 한 줄이 전부였다. 실제로 어긋나는
 * 방식은 더 잘게 나뉜다: 사이클은 돌았는데 평가가 봉을 못 따라잡기도 하고, 상태는
 * 갱신됐는데 기록만 유실되기도 하고(`appendLog` 는 실패해도 사이클을 멈추지 않는다),
 * 사람 손이 필요한 경고가 판정 로그 안쪽에 조용히 쌓이기도 한다. 한 줄로 뭉뚱그리면
 * "봇이 죽었다"와 "봉 하나를 놓쳤다"가 같은 얼굴이 된다.
 *
 * 판정은 전부 이 순수 함수에 모은다 — 화면은 그리기만 하고, 기준은 테스트로 못 박는다.
 *
 * 읽는 자료는 봇이 남긴 것뿐이다(상태·잔고·판정·거래). 거래소에 따로 묻지 않는다:
 * 앱과 봇은 서로 다른 키를 쓰므로(2026-08-19 사고, `okx-live.ts` 주석) 여기서 조회한
 * 포지션은 봇이 매매하는 계좌의 것이 아닐 수 있다 — 대조의 근거가 되지 못한다.
 */
import { dateTime } from "@/lib/format";
import { BAR_MS, floorToBar } from "@/lib/okx";
import type {
  SystemDecision,
  SystemEquityPoint,
  SystemMode,
  SystemState,
  SystemTrade,
} from "@/lib/system-trading";
import type { Tone } from "@/lib/verdict";

/** 봇의 사이클 주기 — 4H 봉이 마감할 때마다 한 번 돈다. */
export const CYCLE_MS = BAR_MS["4H"];

/**
 * 마감 뒤 이만큼까지는 "제때"로 본다.
 *
 * 실행기는 마감 90초 뒤에 돌고, 봉 확정이 늦으면 2분 간격으로 두 번 더 시도한다.
 * 여유를 더 짧게 잡으면 정상적인 재시도가 매번 지연으로 보이고, 더 길게 잡으면
 * 놓친 봉이 다음 사이클에 묻힌다.
 */
const GRACE_MS = 20 * 60_000;

/** 사이클 수를 세는 창 — 하루치면 놓친 봉이 손가락으로 셀 만큼 드러난다. */
const WINDOW_MS = 24 * 3600_000;

/** 상태와 기록이 같은 사이클에서 남았다고 볼 간격. */
const SINK_SLACK_MS = 5 * 60_000;

/** 운전 상태 — 배지 하나로 읽히는 큰 답. 점검 항목은 그 근거를 나눠 말한다. */
export type RunState = "running" | "late" | "down" | "manual" | "never";

export interface HealthCheck {
  id: string;
  /** 무엇을 봤나 */
  label: string;
  /** 그 결과 한 마디 */
  value: string;
  /** 왜 그렇게 봤나 · 어긋났으면 무엇을 해야 하나 */
  detail: string;
  tone: Tone;
}

export interface SystemHealth {
  run: RunState;
  runLabel: string;
  runDetail: string;
  runTone: Tone;
  /** 마지막 사이클 — 봇이 남긴 기록(잔고 스냅샷·판정) 중 최신 시각 */
  lastCycleAt: number | null;
  /** 다음 봉 마감 — 사이클은 그 직후에 돈다. 자동 사이클이 없는 모드는 null. */
  nextCycleAt: number | null;
  checks: HealthCheck[];
}

export interface SystemHealthInput {
  mode: SystemMode;
  /** 실계좌인가 — 실주문 게이트 점검은 이 모드에서만 뜻이 있다. */
  real: boolean;
  state: SystemState | null;
  equity: readonly SystemEquityPoint[];
  /** 화면이 이미 읽어 둔 최근 판정. 경고는 이 창 안에서만 센다. */
  decisions: readonly SystemDecision[];
  trades: readonly SystemTrade[];
  now: number;
}

/** `1.2시간`·`37분` 처럼 사람이 읽는 길이. 앞뒤(전·뒤)는 부르는 쪽이 붙인다. */
export function spanLabel(ms: number): string {
  const m = Math.abs(ms) / 60_000;
  if (m < 1) return "1분 미만";
  if (m < 60) return `${Math.round(m)}분`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}시간`;
  return `${Math.round(h / 24)}일`;
}

const at = (ms: number) => dateTime(new Date(ms).toISOString());

/**
 * 지금까지 사이클이 돌았어야 할 봉 마감 시각들 — 오래된 것부터.
 *
 * 아직 유예 안에 있는 마감(방금 닫힌 봉)은 세지 않는다. 봇이 정상이어도 그 봉의
 * 기록은 아직 없고, 그걸 놓친 것으로 세면 사이클 직후마다 거짓 경보가 뜬다.
 */
function dueCloses(now: number, startedAt: number | null): number[] {
  const out: number[] = [];
  for (let c = floorToBar(now, "4H"); c > now - WINDOW_MS; c -= CYCLE_MS) {
    if (c + GRACE_MS > now) continue;
    if (startedAt !== null && c < startedAt) continue;
    out.push(c);
  }
  return out.reverse();
}

export function assessSystemHealth(input: SystemHealthInput): SystemHealth {
  const { mode, real, state, equity, decisions, trades, now } = input;

  // 사람이 눌러야 한 줄이 생기는 모드다 — 여기에 "지연"은 뜻이 없다.
  const auto = mode !== "manual";

  /*
   * 마지막 사이클은 봇이 **기록으로 남긴 흔적**으로 잰다(잔고 스냅샷·판정 중 최신).
   *
   * 상태 행의 `updated_at` 을 쓰지 않는 이유: 그 칸은 사이클 말고도 움직인다.
   * 킬스위치를 한 번 누르면 봇이 죽어 있어도 "방금 돌았다"가 되어, 이 판이 답해야 할
   * 바로 그 질문에 거짓으로 답하게 된다.
   */
  const lastEquityAt = equity.length ? equity[equity.length - 1].at : null;
  const lastDecisionAt = decisions.length ? Math.max(...decisions.map((d) => d.at)) : null;
  const marks = [lastEquityAt, lastDecisionAt].filter((t): t is number => t !== null);
  const lastCycleAt = marks.length ? Math.max(...marks) : null;
  const nextCycleAt = auto ? floorToBar(now, "4H") + CYCLE_MS : null;
  const since = lastCycleAt === null ? null : now - lastCycleAt;

  let run: RunState;
  if (!auto) run = "manual";
  else if (since === null) run = "never";
  else if (since <= CYCLE_MS + GRACE_MS) run = "running";
  else if (since <= 2 * CYCLE_MS + GRACE_MS) run = "late";
  else run = "down";

  const RUN_TEXT: Record<RunState, { label: string; tone: Tone; detail: string }> = {
    running: {
      label: "정상 가동",
      tone: "good",
      detail: `4시간마다 한 번 — 다음 사이클은 ${nextCycleAt === null ? "" : at(nextCycleAt)} 봉 마감 직후입니다.`,
    },
    late: {
      label: "지연",
      tone: "warn",
      detail:
        "사이클 하나를 건너뛴 것으로 보입니다. 열린 포지션의 손절·목표는 거래소 브래킷이 계속 지키지만, 시한 청산과 새 진입은 그동안 멈춰 있습니다.",
    },
    down: {
      label: "멈춤",
      tone: "bad",
      detail:
        "두 사이클이 넘도록 기록이 없습니다 — 봇이나 스케줄러가 죽었거나 봇을 돌리는 PC 가 꺼져 있습니다. 브래킷 보호는 거래소에 남지만 시한 청산·새 진입은 돌지 않습니다.",
    },
    manual: {
      label: "수동 모드",
      tone: "neutral",
      detail: "사람이 콘솔에서 넣는 모드입니다 — 자동 사이클이 없으므로 지연이라는 것도 없습니다.",
    },
    never: {
      label: "기록 없음",
      tone: "neutral",
      detail: "이 모드는 아직 한 번도 사이클을 남기지 않았습니다.",
    },
  };

  const checks: HealthCheck[] = [];

  // ① 마지막 사이클이 언제였나 — 배지의 직접적인 근거.
  if (auto) {
    checks.push({
      id: "cycle",
      label: "사이클 신선도",
      tone: RUN_TEXT[run].tone,
      value: since === null ? "기록 없음" : `${spanLabel(since)} 전`,
      detail:
        lastCycleAt === null
          ? "이 모드가 남긴 기록이 없습니다."
          : `마지막 ${at(lastCycleAt)} · 다음 ${nextCycleAt === null ? "" : at(nextCycleAt)} 봉 마감 직후`,
    });
  }

  // ② 하루치 봉마다 사이클이 하나씩 남았나 — "지금 살아 있다"와는 다른 질문이다.
  //    PC 가 자다 깨면 마지막 사이클은 방금이어도 그 사이 봉 두엇이 통째로 비어 있다.
  if (auto) {
    const startedAt = equity[0]?.at ?? state?.createdAt ?? null;
    const slots = dueCloses(now, startedAt);
    const missed = slots.filter((c) => !equity.some((p) => p.at >= c && p.at < c + CYCLE_MS));
    const shown = missed.slice(-3).map(at).join(", ");
    checks.push({
      id: "cadence",
      label: "최근 24시간 사이클",
      tone:
        slots.length === 0
          ? "neutral"
          : missed.length === 0
            ? "good"
            : missed.length === 1
              ? "warn"
              : "bad",
      value: slots.length === 0 ? "—" : `${slots.length - missed.length}/${slots.length}회`,
      detail:
        slots.length === 0
          ? "아직 하루가 차지 않았습니다."
          : missed.length === 0
            ? "마감된 봉마다 사이클이 하나씩 남았습니다."
            : `사이클이 없던 봉: ${shown}${missed.length > 3 ? " 외" : ""} — 그 봉의 신호는 다음 사이클에 "지나간 신호"로만 기록되고 진입하지 않습니다.`,
    });
  }

  // ③ 사이클은 돌았는데 평가가 뒤처지는 경우 — 캔들 조회가 계속 실패하면 이렇게 된다.
  const barTimes = Object.values(state?.lastBarTs ?? {});
  const evaluated = barTimes.length ? Math.max(...barTimes) : null;
  const dueBar = floorToBar(now - GRACE_MS, "4H") - CYCLE_MS;
  const lag = evaluated === null ? null : Math.max(0, Math.round((dueBar - evaluated) / CYCLE_MS));
  checks.push({
    id: "bars",
    label: "평가 봉",
    tone: lag === null ? "neutral" : lag === 0 ? "good" : lag === 1 ? "warn" : "bad",
    value: lag === null ? "—" : lag === 0 ? "최신 봉까지" : `${lag}봉 뒤`,
    detail:
      evaluated === null
        ? "아직 평가한 봉이 없습니다."
        : `마지막 평가 ${at(evaluated)} 봉 · 마감된 최신 봉 ${at(dueBar)} (4H 기준, 1D 기준은 같은 사이클에서 따라옵니다)`,
  });

  // ④ 한 사이클의 기록이 반쪽만 남았나 — 판정은 사이클 도중에, 잔고 스냅샷은 끝에 쓴다.
  //    기록 실패는 사이클을 멈추지 않으므로(`appendLog` 는 삼킨다) 어긋남이 여기서만 보인다.
  const sinkGap =
    lastDecisionAt !== null && lastEquityAt !== null ? lastDecisionAt - lastEquityAt : null;
  const sinkOk = sinkGap !== null && sinkGap <= SINK_SLACK_MS;
  checks.push({
    id: "sink",
    label: "기록 적재",
    tone: lastEquityAt === null || lastDecisionAt === null ? "neutral" : sinkOk ? "good" : "warn",
    value:
      lastEquityAt === null || lastDecisionAt === null
        ? "—"
        : sinkOk
          ? "사이클과 같이 남음"
          : "잔고 기록 누락",
    detail:
      lastEquityAt === null || lastDecisionAt === null
        ? "비교할 기록이 아직 없습니다."
        : sinkOk
          ? `잔고 스냅샷 ${at(lastEquityAt)} · 최근 판정 ${decisions.length}줄`
          : `판정은 ${at(lastDecisionAt)} 까지 남았는데 그 사이클의 잔고 스냅샷이 없습니다(마지막 ${at(lastEquityAt)}). 매매는 돌고 기록만 빠졌을 수 있습니다.`,
  });

  // ⑤ 봇 상태의 열린 포지션과 거래 표가 같은가 — 주문과 저장 사이에서 끊기면 갈라진다.
  const inState = Object.keys(state?.positions ?? {}).sort();
  const inTrades = trades
    .filter((t) => t.open)
    .map((t) => t.member)
    .sort();
  const onlyState = inState.filter((m) => !inTrades.includes(m));
  const onlyTrades = inTrades.filter((m) => !inState.includes(m));
  const matched = onlyState.length === 0 && onlyTrades.length === 0;
  checks.push({
    id: "positions",
    label: "포지션 정합",
    tone: matched ? "good" : "bad",
    value: matched ? `${inState.length}건 일치` : `상태 ${inState.length}건 · 거래표 ${inTrades.length}건`,
    detail: matched
      ? "봇 상태의 열린 포지션과 거래 표가 같습니다."
      : `한쪽에만 있는 기준: ${[
          ...onlyState.map((m) => `${m}(상태만)`),
          ...onlyTrades.map((m) => `${m}(거래표만)`),
        ].join(", ")} — 거래소 화면과 대조하세요.`,
  });

  // ⑥ 사람 손이 필요한 경고 — 판정 로그 안쪽에 있어 열어 보지 않으면 안 보인다.
  const warns = decisions.filter((d) => d.warn);
  checks.push({
    id: "warns",
    label: "경고",
    tone: warns.length === 0 ? "good" : "bad",
    value: `${warns.length}건`,
    detail:
      warns.length === 0
        ? `최근 판정 ${decisions.length}줄에 경고가 없습니다.`
        : `가장 최근 ${at(warns[0].at)} — 경고 목록과 판정 로그에서 전부 볼 수 있습니다.`,
  });

  // ⑦ 실주문을 무엇이 여는가 — 사이클이 돌아도 이게 닫혀 있으면 주문은 나가지 않는다.
  if (real) {
    checks.push({
      id: "gate",
      label: "실주문 게이트",
      tone: "neutral",
      value: state?.liveEnabled ? "실주문 허용" : "실주문 차단",
      detail: state?.liveEnabled
        ? "서버 사이클(n8n → /api/cron/quad)이 이 스위치를 게이트로 씁니다 — 지금은 신호가 나면 실제 주문이 나갑니다."
        : "서버 사이클은 이 스위치가 꺼져 있으면 평가도 하지 않고 건너뜁니다. 로컬에서 직접 실행할 때만 LIVE_TRADING_ACK 환경변수가 게이트입니다.",
    });
  }

  return {
    run,
    runLabel: RUN_TEXT[run].label,
    runDetail: RUN_TEXT[run].detail,
    runTone: RUN_TEXT[run].tone,
    lastCycleAt,
    nextCycleAt,
    checks,
  };
}
