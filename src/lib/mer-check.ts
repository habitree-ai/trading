/**
 * 추가 진입 체크리스트 8줄 — 추가 버튼을 누르기 전에 "지금 추가해도 되나"를 한 줄씩 판정한다(REQ-0102).
 *
 * 판정은 예(true)·아니오(false)·확인 불가(null) 셋이다. 확인 불가는 예가 아니다 —
 * 8줄 모두 예일 때만 통과(allOk). 미통과여도 다리 기록은 남긴다(D9).
 * 레벨은 앱이 정할 정의가 없어 사람이 고른다(비목표). 가속 신호 하루 경계는 KST.
 */
import type { CashFlow, Side } from '@/lib/domain';
import { EDGE_VERDICT_LABEL } from '@/lib/edge';
import { IMPULSE } from '@/lib/impulse';
import type { CheckItem, CheckKey } from '@/lib/legs';
import { daySums, kstDayKey, type LimitTrade } from '@/lib/loss-limits';
import { commonStopPrice, legSizing, type LegSizing, type MerZoneRow, type ZoneR } from '@/lib/mer';
import { previewAdd, type AddPreview } from '@/lib/position-r';
import type { ThresholdReport } from '@/lib/threshold/types';

export const CHECK_LABEL: Record<CheckKey, string> = {
  level: '레벨 2 이상',
  cr_zero: '기존 포지션 CR 0 · 손절 ≥ 공통 손절',
  zone_passed: 'MER 통과 구간 도달',
  zone_sample: '그 구간 표본 N ≥ 50',
  threshold: '임계점 경고 0 · 내 방향 켜짐 ≥ 1',
  risk_cap: '추가분 위험 ≤ 1R · 추가 뒤 CR ≤ 1 · E ≤ 2',
  cost_cap: '추가분 왕복 비용 ≤ 0.2R',
  no_accel: '가속 신호 0개',
};

/** 기준값 — 문서 실행 체크리스트 그대로. */
export const ADD_CHECK_RULES = {
  minLevel: 2,
  minSample: 50,
  maxLegRiskR: 1,
  maxCrAfter: 1,
  maxEAfter: 2,
  maxCostR: 0.2,
  /** 오늘 진입+다리가 이만큼 있으면 이번이 그 다음 번째 — 4번째부터 가속 */
  dailyEntryCap: 3,
} as const;

/** 레벨 1 — 피라미딩 금지(시뮬레이션만), 2 이상 추가 허용. */
export type TraderLevel = 1 | 2 | 3;

export type AccelKey = 'cooldown' | 'fourth_entry' | 'loss_day_deposit';

export interface AccelSignal {
  key: AccelKey;
  detail: string;
}

export interface AccelInput {
  nowMs: number;
  /** 가장 늦은 청산 시각 — `latestExit(derived)?.exitMs`. 없으면 null */
  lastExitMs: number | null;
  /** 진입 시각들 — 거래 entry_at + 다리 at (지금 하려는 추가는 빼고) */
  entryTimesMs: readonly number[];
  /** 청산 거래 — `closedLimitTrades(trades)` */
  closed: readonly LimitTrade[];
  cashFlows: readonly Pick<CashFlow, 'kind' | 'at' | 'amount'>[];
}

const EPS = 1e-9;
const minutes = (ms: number) => Math.ceil(ms / 60_000);

/** 가속 신호 — 청산 뒤 60분 안 · 하루 4번째 진입 · 손실 당일 입금. 켜진 것만 돌려준다. */
export function accelSignals(input: AccelInput): AccelSignal[] {
  const { nowMs, lastExitMs } = input;
  const today = kstDayKey(nowMs);
  const out: AccelSignal[] = [];

  if (lastExitMs !== null && nowMs >= lastExitMs && nowMs - lastExitMs < IMPULSE.baseWaitMs) {
    out.push({ key: 'cooldown', detail: `청산 뒤 ${minutes(nowMs - lastExitMs)}분 (대기 ${minutes(IMPULSE.baseWaitMs)}분)` });
  }

  const todayEntries = input.entryTimesMs.filter((t) => t <= nowMs && kstDayKey(t) === today).length;
  if (todayEntries >= ADD_CHECK_RULES.dailyEntryCap) {
    out.push({ key: 'fourth_entry', detail: `오늘 ${todayEntries + 1}번째 진입` });
  }

  // daySums 의 R 은 안 쓴다 — 손익 부호만 본다.
  const todayUsd = daySums(input.closed, 1).find((d) => d.day === today)?.usd ?? 0;
  // 입금 = 들어온 돈(온체인 입금 또는 거래계좌로 이체). 출금은 아니다.
  const deposited = input.cashFlows.some((f) => {
    const t = Date.parse(f.at);
    return f.kind !== 'withdrawal' && f.amount > 0 && t <= nowMs && kstDayKey(t) === today;
  });
  if (todayUsd < 0 && deposited) {
    out.push({ key: 'loss_day_deposit', detail: `오늘 손실 ${todayUsd.toFixed(2)} USDT 인데 입금` });
  }
  return out;
}

export interface AddCheckInput {
  side: Side;
  rBase: number;
  /** 1E 수량 — 흐름의 oneE. 없으면 E 를 못 잰다 */
  oneE: number | null;
  /** 진입 때 CR */
  cr0: number | null;
  /** 지금 포지션 */
  qty: number;
  avgPx: number;
  stopPx: number | null;
  /** 최초 진입가(첫 진입 체결) — 공통 손절의 기준 */
  entry0: number;
  feeRate: number;
  addPrice: number;
  /** 추가 수량 — 비우면 공통 손절 기준 1R 수량(legSizing) */
  addQty?: number | null;
  /** 고른 구간 — 구간 밖이면 null */
  zoneR: ZoneR | null;
  /** MER 표 — 못 읽었으면 null */
  merRows: readonly MerZoneRow[] | null;
  /** 임계점 — 수집 실패면 null */
  threshold: ThresholdReport | null;
  level: TraderLevel | null;
  accel: readonly AccelSignal[];
}

export interface AddCheckResult {
  /** 8줄 — CheckKey 순서 */
  items: CheckItem[];
  allOk: boolean;
  commonStop: number;
  sizing: LegSizing | null;
  /** 실제 판정에 쓴 추가 수량 */
  addQty: number | null;
  preview: AddPreview | null;
}

const item = (key: CheckKey, ok: boolean | null, detail: string, auto = true): CheckItem => ({ key, ok, auto, detail });

/** 여러 조건 묶음 — 하나라도 아니오면 아니오, 아니면 하나라도 모르면 확인 불가. */
const all = (oks: readonly (boolean | null)[]): boolean | null =>
  oks.includes(false) ? false : oks.includes(null) ? null : true;

const f2 = (v: number | null) => (v === null ? '—' : v.toFixed(2));

export function evaluateAddChecklist(input: AddCheckInput): AddCheckResult {
  const { side, rBase, oneE, addPrice, zoneR } = input;
  const dir = side === 'long' ? 1 : -1;
  const commonStop = commonStopPrice(side, input.entry0, input.feeRate);
  const sizing = legSizing(side, rBase, oneE ?? 0, addPrice, commonStop, input.feeRate);
  const manual = input.addQty ?? null;
  const addQty = manual !== null && manual > 0 ? manual : (sizing?.qty ?? null);

  // 추가 0 으로 돌려 지금 상태(before)를 같은 식으로 얻는다.
  const pv = previewAdd({ ...input, addPrice, addQty: addQty ?? 0 });
  const preview = addQty !== null ? pv : null;

  // 1 레벨 — 사람이 고른다
  const level =
    input.level === null
      ? item('level', null, '레벨을 고르세요', false)
      : input.level >= ADD_CHECK_RULES.minLevel
        ? item('level', true, `레벨 ${input.level}`, false)
        : item('level', false, '레벨 1 — 피라미딩 금지, 시뮬레이션만', false);

  // 2 지금 CR 0 && 손절이 공통 손절보다 이익 쪽(같아도 됨)
  const crNow = pv.before.cr;
  const stop = input.stopPx;
  const crZero =
    stop === null || crNow === null
      ? item('cr_zero', false, '손절 없음')
      : item(
          'cr_zero',
          crNow <= EPS && dir * (stop - commonStop) >= -EPS,
          `CR ${f2(crNow)} · 손절 ${stop} / 공통 ${commonStop.toFixed(2)}`,
        );

  // 3·4 구간
  const row = zoneR === null || input.merRows === null ? null : (input.merRows.find((r) => r.zoneR === zoneR) ?? null);
  const zonePassed =
    zoneR === null
      ? item('zone_passed', false, '구간 밖 — 구간을 고르지 않음')
      : input.merRows === null
        ? item('zone_passed', null, 'MER 표 없음')
        : row === null
          ? item('zone_passed', null, `+${zoneR}R 행 없음`)
          : item('zone_passed', row.pass, `+${zoneR}R MER ${f2(row.mer)} · ${EDGE_VERDICT_LABEL[row.verdict]}`);
  const zoneSample =
    row === null
      ? item('zone_sample', null, zoneR === null ? '구간 없음' : 'MER 표 없음')
      : item(
          'zone_sample',
          row.stats.n >= ADD_CHECK_RULES.minSample,
          `N ${row.stats.n}/${ADD_CHECK_RULES.minSample}${row.stats.n < ADD_CHECK_RULES.minSample ? ' — 시뮬레이션만' : ''}`,
        );

  // 5 임계점 — 측정된 것만으로 판단, 켜짐 0 에 미측정이 있으면 확인 불가
  let threshold: CheckItem;
  const report = input.threshold;
  if (report === null) {
    threshold = item('threshold', null, '임계점 수집 실패');
  } else {
    const { warnings, on, measuredCount } = report.summary;
    const tag = `${measuredCount}/4 측정`;
    if (measuredCount === 0) threshold = item('threshold', null, tag);
    else if (warnings[side].length > 0) threshold = item('threshold', false, `경고 ${warnings[side].join(', ')} · ${tag}`);
    else if (on[side] >= 1) threshold = item('threshold', true, `켜짐 ${on[side]} · ${tag}`);
    else if (measuredCount < 4) threshold = item('threshold', null, `켜짐 0 · ${tag} — 미측정 있음`);
    else threshold = item('threshold', false, `켜짐 0 · ${tag}`);
  }

  // 6 위험 상한 — 추가분 위험(공통 손절 기준) ≤ 1R, 추가 뒤 CR ≤ 1, E ≤ 2
  let riskCap: CheckItem;
  if (addQty === null || preview === null) {
    riskCap = item('risk_cap', false, '추가가가 공통 손절보다 불리한 쪽');
  } else {
    const legRiskR = (dir * (addPrice - commonStop) * addQty) / rBase;
    const { cr, e } = preview.after;
    const ok = all([
      legRiskR > 0 && legRiskR <= ADD_CHECK_RULES.maxLegRiskR + EPS,
      cr === null ? null : cr <= ADD_CHECK_RULES.maxCrAfter + EPS,
      e === null ? null : e <= ADD_CHECK_RULES.maxEAfter + EPS,
    ]);
    riskCap = item('risk_cap', ok, `추가분 ${f2(legRiskR)}R · 뒤 CR ${f2(cr)} · E ${f2(e)}`);
  }

  // 7 비용 — 추가분 자기 위험 대비 왕복 수수료
  const costCap =
    sizing === null
      ? item('cost_cap', null, '비용 R 계산 불가')
      : item('cost_cap', sizing.costR <= ADD_CHECK_RULES.maxCostR + EPS, `비용 ${f2(sizing.costR)}R`);

  // 8 가속 신호
  const noAccel =
    input.accel.length === 0
      ? item('no_accel', true, '없음')
      : item('no_accel', false, input.accel.map((a) => a.detail).join(' · '));

  const items = [level, crZero, zonePassed, zoneSample, threshold, riskCap, costCap, noAccel];
  return { items, allOk: items.every((i) => i.ok === true), commonStop, sizing, addQty, preview };
}
