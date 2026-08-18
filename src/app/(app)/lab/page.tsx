import { LAB_GROUP_META, listLabReports, type LabGroup } from "@/lib/lab";
import { DASH, dateTime } from "@/lib/format";

/**
 * 자료실 — 앱 밖에서 만들어진 연구 산출물의 입구.
 *
 * 여기 있는 것은 계좌 데이터가 아니다. 수동매매·시스템매매 화면이 "지금 내 돈이
 * 어떻게 됐나"를 보는 자리라면, 이 영역은 "그렇게 하기로 한 근거가 무엇이었나"를
 * 되짚는 자리다. 그래서 셋을 나눠 두었다.
 */

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return DASH;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export default function LabPage() {
  const reports = listLabReports();
  const missing = reports.filter((r) => !r.available).length;

  const groups: LabGroup[] = ["replay", "backtest", "doc"];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">자료실</h1>
        <p className="mt-1 text-sm text-dim">
          복기·백테스트 산출물은 이 앱과 코드를 공유하지 않는 별도 데이터 계층입니다. 결과물은
          스스로 완결된 HTML이고 재생성이 가능해 데이터베이스로 옮기지 않습니다 — 여기서는 찾아서
          열기만 합니다.
        </p>
      </header>

      {missing > 0 ? (
        <p className="rounded-xl border border-border bg-surface p-3 text-[12px] text-dim">
          {missing}건은 이 머신에 파일이 없습니다. 생성 스크립트를 돌리면 목록에서 바로 열립니다
          (<code className="rounded bg-surface-2 px-1">node re_sys/report.mjs</code> ·{" "}
          <code className="rounded bg-surface-2 px-1">node backtest-lab/report.mjs</code>).
        </p>
      ) : null}

      {groups.map((group) => {
        const rows = reports.filter((r) => r.group === group);
        if (rows.length === 0) return null;
        const meta = LAB_GROUP_META[group];

        return (
          <section key={group} className="space-y-2">
            <div>
              <h2 className="text-sm font-medium">{meta.label}</h2>
              <p className="text-[11.5px] text-dim">{meta.desc}</p>
            </div>

            <div className="grid gap-2 lg:grid-cols-2">
              {rows.map((r) => {
                const body = (
                  <>
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-[13px] font-medium">{r.title}</h3>
                      {!r.available ? (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
                          로컬 전용
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11.5px] leading-snug text-dim">{r.desc}</p>
                    <p className="tnum mt-2 text-[11px] text-dim">
                      {r.available
                        ? `${dateTime(new Date(r.modifiedAt!).toISOString())} · ${sizeLabel(r.bytes)}`
                        : "생성 전"}
                      <span className="ml-2 opacity-60">{r.path}</span>
                    </p>
                  </>
                );

                return r.available ? (
                  <a
                    key={r.key}
                    href={`/api/lab?key=${encodeURIComponent(r.key)}`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-beta"
                  >
                    {body}
                  </a>
                ) : (
                  <div
                    key={r.key}
                    className="rounded-xl border border-dashed border-border p-4 opacity-60"
                  >
                    {body}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
