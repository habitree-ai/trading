/**
 * 거래소 잔액 스냅샷을 자금 곡선에 얹는다 — 일별 리샘플·공백 끊기·행 병합.
 *
 * 곡선의 기존 두 선(장부 잔액·매매 성과)은 거래가 실현될 때만 점이 선다. 스냅샷은
 * 거래와 무관한 시각에 찍힌다. 둘을 한 표(행 배열)에 넣어야 recharts 가 같은 시간축에
 * 그리므로, 시각의 합집합으로 행을 만들고 서로의 빈 자리를 정해진 규칙으로 채운다.
 *
 * REQ-0003 의 권고를 그대로 옮긴 규칙:
 * - 하루(한국 시간)에 여러 건이면 **마지막 건**만 남긴다
 * - 달력상 **이어지지 않는 날** 사이는 선을 끊는다 — 빈 구간이 "변동 없음"으로 읽히면 안 된다
 * - 북 시작일 전 스냅샷은 정의가 달라 제외한다
 */
import type { EquityPoint } from "@/components/charts";
import type { BalanceSnapshot } from "@/lib/domain";
import { date } from "@/lib/format";
import { dayKey } from "@/lib/metrics";

export interface SnapshotPoint {
  /** 그날 마지막 스냅샷의 시각(epoch ms) */
  t: number;
  /** 한국 시간 날짜 `YYYY-MM-DD` — 연속성 판정에 쓴다 */
  day: string;
  /** 거래소 잔액 — 미실현 손익 포함 */
  equity: number;
}

/** `YYYY-MM-DD` 두 날이 달력상 하루 차이인가. */
function consecutive(a: string, b: string): boolean {
  const diff = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return diff === 24 * 60 * 60_000;
}

/**
 * 일별 리샘플 — 북 시작일(한국 시간) 이후, 하루에 마지막 건.
 */
export function dailySnapshots(
  snapshots: readonly Pick<BalanceSnapshot, "at" | "equity">[],
  startDate: string,
): SnapshotPoint[] {
  const last = new Map<string, SnapshotPoint>();
  for (const s of snapshots) {
    const day = dayKey(s.at);
    if (day < startDate) continue;
    const t = Date.parse(s.at);
    const prev = last.get(day);
    if (!prev || t > prev.t) last.set(day, { t, day, equity: s.equity });
  }
  return [...last.values()].sort((a, b) => a.t - b.t);
}

/**
 * 곡선 행에 스냅샷 선을 병합한다.
 *
 * - 스냅샷 날짜에는 행을 새로 끼우고, 장부·성과 값은 **직전 행 그대로** 둔다 — 거래 사이에
 *   장부 잔액은 변하지 않으니 평평한 것이 맞다
 * - 거래 행에는 양옆 스냅샷이 이어진 날(달력상 연속)일 때만 선형 보간값을 넣는다. 그래야
 *   선이 거래 행에서 끊기지 않으면서도, 빈 날을 건너뛰는 자리에서는 끊긴다
 * - 곡선 첫 행보다 앞선 스냅샷은 버린다 — 이어 붙일 직전 행이 없다
 */
export function mergeSnapshotLine(
  curve: readonly EquityPoint[],
  daily: readonly SnapshotPoint[],
): EquityPoint[] {
  if (curve.length === 0) return [];
  const first = curve[0].t;
  const points = daily.filter((p) => p.t >= first);
  if (points.length === 0) return curve.map((row) => ({ ...row, snapshot: null }));

  const byT = new Map(points.map((p) => [p.t, p]));

  /** 거래 행 시각에 들어갈 스냅샷 값 — 같은 연속 구간 안이면 보간, 아니면 null. */
  const interpolate = (t: number): number | null => {
    let left: SnapshotPoint | null = null;
    let right: SnapshotPoint | null = null;
    for (const p of points) {
      if (p.t <= t) left = p;
      else {
        right = p;
        break;
      }
    }
    if (!left || !right || !consecutive(left.day, right.day)) return null;
    const ratio = (t - left.t) / (right.t - left.t);
    return left.equity + (right.equity - left.equity) * ratio;
  };

  const rows: EquityPoint[] = [];
  let ci = 0;
  let pi = 0;
  let carry: EquityPoint | null = null;
  let prevPoint: SnapshotPoint | null = null;

  while (ci < curve.length || pi < points.length) {
    const c = curve[ci];
    const p = points[pi];
    // 같은 시각이면 거래 행에 스냅샷 값을 얹는다 — 행을 둘로 나누지 않는다.
    if (c && (!p || c.t <= p.t)) {
      const exact = byT.get(c.t);
      const row: EquityPoint = { ...c, snapshot: exact ? exact.equity : interpolate(c.t) };
      rows.push(row);
      carry = row;
      ci += 1;
      if (exact) {
        prevPoint = exact;
        pi += 1;
      }
      continue;
    }
    if (!p || !carry) break;
    // 이어지지 않는 날 사이에는 빈 행을 하나 두어 선을 끊는다.
    if (prevPoint && !consecutive(prevPoint.day, p.day)) {
      rows.push({
        ...carry,
        t: p.t - 1,
        label: `${date(new Date(p.t).toISOString())} 공백`,
        withdrawnStep: 0,
        pnl: null,
        benchmark: null,
        snapshot: null,
      });
    }
    rows.push({
      ...carry,
      t: p.t,
      label: `${date(new Date(p.t).toISOString())} 거래소 잔액`,
      withdrawnStep: 0,
      pnl: null,
      benchmark: null,
      snapshot: p.equity,
    });
    prevPoint = p;
    pi += 1;
  }
  return rows;
}
