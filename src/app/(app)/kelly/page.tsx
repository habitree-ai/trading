import { StatTile } from "@/components/stat-tile";
import { DASH, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import { loadOkxKelly, MIN_SAMPLE, type KellyDimension } from "@/lib/okx-kelly";
import { readKelly, RELIABLE_SAMPLE, TONE_CLASS } from "@/lib/verdict";

/**
 * 과거데이터 분석 — OKX 전 이력을 켈리 기준으로 갈라 본다.
 *
 * 대시보드의 켈리는 앱에 적어 둔 북 하나를 본다. 지금 그 북은 몇 건짜리라 승률 한 건에
 * 값이 통째로 흔들린다. 실제로 무엇을 고칠지는 이쪽에서만 정해진다 — 두 계정의
 * 전 거래 4,000건대가 같은 산식을 통과한 결과다.
 *
 * 이 화면은 "얼마를 걸어야 하나"에 답하지 않는다. 전 구간 켈리가 음수라 답이 없기
 * 때문이다. 대신 **음수가 어디서 만들어졌는지**를 축마다 갈라 보여 준다.
 */

export default function KellyPage() {
  const report = loadOkxKelly();
  const { overall, period, source } = report;
  const verdict = readKelly(overall.kelly, overall.decided);

  // 보유시간은 부호가 갈리는 유일한 축이라 따로 세운다 — 나머지는 전 구간 음수다.
  const hold = report.dimensions.find((d) => d.key === "hold");
  const rest = report.dimensions.filter((d) => d.key !== "hold");

  // 표본이 받쳐 주는 칸 가운데 켈리가 양수인 것 — 이 데이터에 남은 유일한 근거다.
  const positives = report.dimensions
    .flatMap((d) => d.rows.map((r) => ({ dim: d.label, row: r })))
    .filter(({ row }) => row.kelly !== null && row.kelly > 0 && row.decided >= MIN_SAMPLE)
    .sort((a, b) => (b.row.kelly ?? 0) - (a.row.kelly ?? 0));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">과거데이터 분석</h1>
        <p className="mt-1 text-sm text-dim">
          OKX 두 계정의 청산 거래 {num(overall.n, 0)}건({period.from} ~ {period.to},{" "}
          {num(period.tradingDays, 0)}거래일)을 켈리 기준으로 갈랐습니다. 대시보드·복기 분석과 같은
          산식을 통과한 값입니다.
        </p>
      </header>

      {/* ── 1. 전 구간이 무엇을 말하는가 ───────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          전 구간 켈리{" "}
          <span className="font-normal text-dim">— 이 방식 전체를 한 줄로 요약하면</span>
        </h2>

        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="켈리 비율 (f*)"
            value={signedPct(overall.kelly)}
            valueClass={pnlClass(overall.kelly)}
            sub={`W ${pct(overall.winRate)} · b ${num(overall.payoffRatio, 2)}`}
            verdict={verdict}
          />
          <StatTile
            label="승률 W"
            value={pct(overall.winRate)}
            sub={`${num(overall.wins, 0)}승 ${num(overall.losses, 0)}패`}
          />
          <StatTile
            label="손익비 b"
            value={num(overall.payoffRatio, 2)}
            sub={`평균수익 ${num(overall.avgWin, 1)} / 평균손실 ${num(overall.avgLoss, 1)}`}
          />
          <StatTile
            label="순손익"
            value={signed(overall.netPnl, 0)}
            valueClass={pnlClass(overall.netPnl)}
            sub={`수수료 ${num(overall.feeUsd, 0)} · 강제청산 ${num(overall.liqCount, 0)}회`}
          />
        </div>

        <div className="mt-3 rounded-lg border border-loss/40 bg-loss/5 p-3 text-[11.5px] leading-relaxed">
          <p>
            <span className="text-loss">
              전 구간 f* 가 {signedPct(overall.kelly)} 입니다 — 켈리가 허용하는 베팅 크기가 없습니다.
            </span>{" "}
            <span className="text-dim">
              승률 {pct(overall.winRate)} 에 손익비 {num(overall.payoffRatio, 2)} 면 본전 승률은{" "}
              {pct(1 / (1 + (overall.payoffRatio ?? 1)), 1)} 이라, 이기는 폭이 지는 횟수를 못 메웁니다.
              이 상태에서 크기를 줄이는 것은 잃는 속도만 늦출 뿐이고 부호를 바꾸지 못합니다 —
              고쳐야 하는 것은 크기가 아니라 진입·청산 방식입니다.
            </span>
          </p>
          <p className="mt-1.5 text-dim">
            총수익 {num(overall.grossWin, 0)} · 총손실 {num(overall.grossLoss, 0)} · 수수료{" "}
            {num(overall.feeUsd, 0)} · 펀딩비 {signed(overall.fundingUsd, 0)}. 수수료만으로 총수익의{" "}
            {pct(Math.abs(overall.feeUsd) / overall.grossWin, 0)} 이 나갔습니다.
          </p>
        </div>
      </section>

      {/* ── 2. 부호가 갈리는 축 ────────────────────── */}
      {hold ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">
            보유시간{" "}
            <span className="font-normal text-dim">
              — 켈리 부호가 갈리는 유일한 축입니다. 2시간이 경계입니다
            </span>
          </h2>
          <div className="mt-3">
            <KellyTable dim={hold} showBar />
          </div>
          <p className="mt-3 rounded-lg border border-beta/40 bg-beta/5 p-3 text-[11.5px] leading-relaxed text-dim">
            <span className="text-beta">이 축은 진입 시점에 고르는 값이 아닙니다.</span>{" "}
            손절에 걸린 거래는 져서 일찍 닫히고 이익 거래는 오래 들고 가게 되므로, 보유시간과 결과는 서로를
            만듭니다 — &ldquo;오래 들면 이긴다&rdquo;로 읽으면 인과가 뒤집힙니다. 그래도 두 가지는
            남습니다: 30분–2시간 구간이 가장 깊게 음수라는 것(손절도 익절도 아닌 자리에서 끊고
            있다는 뜻), 그리고 2시간을 넘겨 들고 간 거래에서만 손익비가 1.5를 넘는다는 것입니다.
          </p>
        </section>
      ) : null}

      {/* ── 3. 표본이 받쳐 주는 양수 구간 ─────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          걸 만한 구간{" "}
          <span className="font-normal text-dim">
            — 전 차원에서 f* 가 양수이면서 표본 {MIN_SAMPLE}건을 넘는 칸
          </span>
        </h2>
        {positives.length === 0 ? (
          <p className="mt-3 text-xs text-dim">없습니다 — 모든 축의 모든 구간이 음수입니다.</p>
        ) : (
          <div className="mt-3 scroll-x">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-xs text-dim">
                <tr>
                  <th className="py-1 text-left font-medium">축</th>
                  <th className="py-1 text-left font-medium">구간</th>
                  <th className="py-1 text-right font-medium">거래</th>
                  <th className="py-1 text-right font-medium">승률</th>
                  <th className="py-1 text-right font-medium">손익비</th>
                  <th className="py-1 text-right font-medium">켈리 f*</th>
                  <th className="py-1 text-right font-medium">순손익</th>
                </tr>
              </thead>
              <tbody>
                {positives.map(({ dim, row }) => (
                  <tr key={`${dim}-${row.key}`} className="border-t border-border">
                    <td className="py-1.5 text-dim">{dim}</td>
                    <td className="py-1.5">{row.key}</td>
                    <td className="tnum py-1.5 text-right text-dim">{num(row.n, 0)}</td>
                    <td className="tnum py-1.5 text-right">{pct(row.winRate)}</td>
                    <td className="tnum py-1.5 text-right">{num(row.payoffRatio, 2)}</td>
                    <td className="tnum py-1.5 text-right font-medium text-profit">
                      {signedPct(row.kelly)}
                    </td>
                    <td className={`tnum py-1.5 text-right ${pnlClass(row.netPnl)}`}>
                      {signed(row.netPnl, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-snug text-dim">
          같은 거래가 여러 축에 겹쳐 나옵니다 — 축끼리 더하지 마세요. 표본 {MIN_SAMPLE}건 미만인
          칸은 여기 넣지 않았습니다: 2건짜리 종목이 f* +70%로 잡히는 것은 엣지가 아니라 잡음입니다.
        </p>
      </section>

      {/* ── 4. 나머지 축 전부 ─────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {rest.map((dim) => (
          <section key={dim.key} className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              {dim.label}
              {dim.hint ? (
                <span className="ml-2 text-xs font-normal text-dim">{dim.hint}</span>
              ) : null}
            </h2>
            <div className="mt-3">
              <KellyTable dim={dim} />
            </div>
          </section>
        ))}
      </div>

      {/* ── 5. 이 숫자가 어디서 왔나 ──────────────── */}
      <section className="rounded-xl border border-border bg-surface-2 p-4 text-[11.5px] leading-relaxed text-dim">
        <h2 className="text-sm font-medium text-text">출처와 한계</h2>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            원장: {source.origins.join(" · ")} — 종목 {num(source.symbols, 0)}개.{" "}
            {source.analyzedAt ? `${source.analyzedAt.slice(0, 10)} 분석분` : ""}
          </li>
          <li>
            손익은 수수료·펀딩비를 뺀 실현손익입니다. 켈리 산식은 대시보드·복기 분석과 같은{" "}
            <code className="rounded bg-surface px-1">kellyFraction</code> 을 씁니다 — 집계본에는
            승·패·평균수익·평균손실만 들어 있고 켈리는 화면에서 계산합니다.
          </li>
          <li>
            f* 는 <strong>자기자본</strong> 대비 비율인데 이 원장에는 거래 시점 잔액이 없어
            &ldquo;실제로 자금의 몇 %를 걸었나&rdquo;와 직접 견줄 수 없습니다. 참고로 손실 거래는{" "}
            <strong>증거금</strong>의 중앙값 {pct((report.lossMargin.median ?? 0) / 100, 1)},
            평균 {pct((report.lossMargin.mean ?? 0) / 100, 1)} 를 가져갔습니다 — 분모가 달라 켈리와
            같은 자리에 놓을 수 없는 값입니다.
          </li>
          <li>
            진입 의도는 기록이 아니라 진입 시점 차트 상태로 <strong>역추정</strong>한 값입니다
            (원장에 근거 칸이 비어 있습니다). 그 축의 숫자는 다른 축보다 약하게 읽어야 합니다.
          </li>
          <li>
            표본 {RELIABLE_SAMPLE}건 미만인 칸은 흐리게 표시하고 정렬에서 아래로 내렸습니다.
          </li>
          <li>
            갱신: <code className="rounded bg-surface px-1">node re_sys/kelly.mjs</code> — 원본은
            로컬에만 있고, 이 화면이 읽는 집계본(<code className="rounded bg-surface px-1">docs/kelly/okx-kelly.json</code>)만
            저장소에 들어갑니다.
          </li>
        </ul>
        <p className={`mt-2 ${TONE_CLASS[verdict.tone]}`}>{verdict.text}</p>
      </section>
    </div>
  );
}

/**
 * 차원 하나의 표.
 *
 * 켈리 막대는 0을 가운데 두고 좌우로 뻗는다 — 부호가 색이 아니라 방향으로도 읽혀야
 * 보유시간처럼 한 축에서 부호가 뒤집히는 흐름이 한눈에 들어온다.
 */
function KellyTable({ dim, showBar = false }: { dim: KellyDimension; showBar?: boolean }) {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[30rem] text-sm">
        <thead className="text-xs text-dim">
          <tr>
            <th className="py-1 text-left font-medium">구간</th>
            <th className="py-1 text-right font-medium">거래</th>
            <th className="py-1 text-right font-medium">승률</th>
            <th className="py-1 text-right font-medium">손익비</th>
            <th className="py-1 text-right font-medium">켈리 f*</th>
            {showBar ? <th className="py-1 text-left font-medium">　</th> : null}
            <th className="py-1 text-right font-medium">순손익</th>
          </tr>
        </thead>
        <tbody>
          {dim.rows.map((row) => {
            const thin = row.decided < MIN_SAMPLE;
            return (
              <tr key={row.key} className="border-t border-border">
                <td className={`max-w-[12rem] truncate py-1.5 ${thin ? "text-dim" : ""}`} title={row.key}>
                  {row.key}
                </td>
                <td className="tnum py-1.5 text-right text-dim">
                  {num(row.n, 0)}
                  <span className="ml-1 text-[11px]">
                    ({row.wins}/{row.losses})
                  </span>
                </td>
                <td className="tnum py-1.5 text-right">{pct(row.winRate)}</td>
                <td className="tnum py-1.5 text-right">{num(row.payoffRatio, 2)}</td>
                <td
                  className={`tnum py-1.5 text-right font-medium ${
                    thin ? "text-dim" : pnlClass(row.kelly)
                  }`}
                >
                  {signedPct(row.kelly)}
                </td>
                {showBar ? (
                  <td className="py-1.5 pl-2">
                    <KellyBar value={row.kelly} muted={thin} />
                  </td>
                ) : null}
                <td className={`tnum py-1.5 text-right ${thin ? "text-dim" : pnlClass(row.netPnl)}`}>
                  {signed(row.netPnl, 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 켈리 막대가 담는 폭 — 이보다 큰 값은 끝에서 잘린다(−119% 같은 칸이 표를 뭉갠다). */
const BAR_RANGE = 0.6;

function KellyBar({ value, muted }: { value: number | null; muted: boolean }) {
  if (value === null) return <span className="text-[11px] text-dim">{DASH}</span>;

  const clamped = Math.max(-BAR_RANGE, Math.min(BAR_RANGE, value));
  const width = (Math.abs(clamped) / BAR_RANGE) * 50;
  const positive = clamped >= 0;

  return (
    <div className="relative h-2 w-24 rounded-sm bg-surface-2" aria-hidden>
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 rounded-sm ${
          muted ? "bg-border" : positive ? "bg-profit" : "bg-loss"
        }`}
        style={
          positive
            ? { left: "50%", width: `${width}%` }
            : { right: "50%", width: `${width}%` }
        }
      />
    </div>
  );
}
