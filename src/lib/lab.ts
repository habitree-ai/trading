/**
 * 자료실 — 앱 밖에서 생성된 연구 산출물을 앱 안에서 찾을 수 있게.
 *
 * 복기(`re_sys`)와 백테스트(`backtest-lab`)는 이 앱과 코드를 공유하지 않는 독립
 * 데이터 계층이다. 결과물은 스스로 완결된 HTML 리포트이고 재생성이 가능해 저장소에
 * 넣지 않는다(gitignore). 그래서 DB로 올리지 않는다 — 옮기면 정본이 둘이 된다.
 *
 * 여기서 하는 일은 목록을 세우고 열어 주는 것뿐이다. 파일은 이 PC의 작업 폴더에
 * 있으므로, 배포 환경에서는 목록에 "로컬 전용"으로 표시되고 열리지 않는다.
 */
import { readdirSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

export type LabGroup = "replay" | "backtest" | "doc";

export const LAB_GROUP_META: Record<LabGroup, { label: string; desc: string }> = {
  replay: {
    label: "복기 리포트",
    desc: "OKX 전 이력을 봇과 같은 규칙으로 재현한 결과 — 시스템 전략(쿼드)과 본인 매매 두 갈래",
  },
  backtest: {
    label: "백테스트 아카이브",
    desc: "회차별 검증 원장 — 사전 등록한 질문에 답한 기록이고, 뒤에 고치지 않는다",
  },
  doc: {
    label: "운영 문서",
    desc: "봇 기준·운영 절차의 정본. 화면의 설명이 이것과 어긋나면 문서가 옳다",
  },
};

interface LabEntry {
  key: string;
  group: LabGroup;
  title: string;
  desc: string;
  /** 저장소 루트 기준 상대 경로 — 이 목록에 있는 파일만 열린다. */
  path: string;
}

/**
 * 고정 카탈로그.
 *
 * 파일 이름을 그대로 목록에 쓰지 않는 이유: `asym-report.html` 이 무엇을 답한
 * 회차인지는 파일명이 말해 주지 않는다. 리포트를 여는 이유가 곧 제목이어야 한다.
 */
const CATALOG: LabEntry[] = [
  {
    key: "replay-quad",
    group: "replay",
    title: "쿼드 복기 — 시스템 전략 전 기간",
    desc: "4개 기준의 신호와 체결을 상장 이후 전 구간에서 재현. 봇과 같은 부등식·같은 체결 규칙을 쓴다",
    path: "re_sys/out/report.html",
  },
  {
    key: "replay-manual",
    group: "replay",
    title: "매매 복기 — 본인 거래 전량",
    desc: "OKX 두 계정의 전 포지션을 진입 의도로 유추하고 실패 원인을 분류·집계. 실패 랭킹 + 거래 카드",
    path: "re_sys/out/manual-report.html",
  },
  {
    key: "replay-index",
    group: "replay",
    title: "복기 인덱스",
    desc: "리포트와 수집 데이터의 재고 현황 한 장",
    path: "re_sys/out/index.html",
  },
  {
    key: "bt-asym",
    group: "backtest",
    title: "비대칭 회차 — 손익 구조를 기울여 얻는 것",
    desc: "손절·목표 비대칭 조합의 전수 탐색과 대조군",
    path: "backtest-lab/out/asym-report.html",
  },
  {
    key: "bt-compound",
    group: "backtest",
    title: "복리 병행 회차 — 여러 기준을 함께 굴릴 때",
    desc: "구성·사이징을 바꿔 가며 복리 곡선이 어떻게 갈리는지",
    path: "backtest-lab/out/compound-report.html",
  },
  {
    key: "bt-stress",
    group: "backtest",
    title: "스트레스 / 전방검증(WFA)",
    desc: "구간을 잘라 밖에서 검증했을 때 남는 것 — 인샘플 상한과의 거리",
    path: "backtest-lab/out/stress-report.html",
  },
  {
    key: "bt-wfa",
    group: "backtest",
    title: "WFA 상세",
    desc: "워크포워드 창별 성적 원장",
    path: "backtest-lab/out/wfa-report.html",
  },
  {
    key: "bt-frontier",
    group: "backtest",
    title: "프런티어 회차 — 월 10%가 어디에 있는가",
    desc: "월수익률–MDD–파산확률 프런티어. 목표치의 실제 크기를 못 박은 회차",
    path: "backtest-lab/out/report.html",
  },
  {
    key: "doc-status",
    group: "doc",
    title: "시스템 상태 콘솔",
    desc: "봇 러너들의 기획·상태 대시보드 (정적 스냅샷)",
    path: "system-trading/docs/status.html",
  },
  {
    key: "doc-test",
    group: "doc",
    title: "실주문 배선 검증 리포트",
    desc: "라이브 승격 전 주문·브래킷·청산 경로를 실제로 태워 본 기록",
    path: "system-trading/docs/test-report.html",
  },
];

export interface LabReport extends LabEntry {
  /** 이 머신에 파일이 있는가 — 없으면 목록에는 남되 열 수 없다. */
  available: boolean;
  bytes: number | null;
  modifiedAt: number | null;
}

function describe(entry: LabEntry): LabReport {
  try {
    const st = statSync(join(process.cwd(), entry.path));
    return { ...entry, available: true, bytes: st.size, modifiedAt: st.mtimeMs };
  } catch {
    return { ...entry, available: false, bytes: null, modifiedAt: null };
  }
}

/** 회차 누적 아카이브 — 파일 이름에 날짜가 들어 있어 목록을 스캔해서 세운다. */
const ARCHIVE_DIR = "re_sys/out/archive";

function archiveReports(): LabReport[] {
  let names: string[];
  try {
    names = readdirSync(join(process.cwd(), ARCHIVE_DIR));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".html"))
    .sort()
    .reverse()
    .map((name) =>
      describe({
        key: `archive-${name.replace(/\.html$/, "")}`,
        group: "replay",
        title: `보관본 — ${name.replace(/\.html$/, "")}`,
        desc: "지난 회차의 복기 리포트 스냅샷",
        path: `${ARCHIVE_DIR}/${name}`,
      }),
    );
}

export function listLabReports(): LabReport[] {
  return [...CATALOG.map(describe), ...archiveReports()];
}

/**
 * 열 수 있는 파일인가 — 목록에 있는 경로만 통과시킨다.
 *
 * 키로 찾고 다시 경로를 정규화해 확인하는 것은 이중 방어다. 카탈로그가 유일한
 * 출처이므로 키 조회만으로 충분하지만, 아카이브 항목은 파일 이름에서 키가 만들어져
 * 앞으로 스캔 범위가 넓어질 수 있다.
 */
export function resolveLabPath(key: string): string | null {
  const found = listLabReports().find((r) => r.key === key && r.available);
  if (!found) return null;

  const rel = normalize(found.path);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  if (!rel.endsWith(".html")) return null;
  return join(process.cwd(), rel);
}
