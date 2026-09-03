import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { SENIOR_CHART_DIR, isSeniorChartFile } from "@/lib/senior/charts";

/**
 * 시세 대조 차트 — `선배님/차트/` 의 파일을 그대로 흘려 보낸다.
 *
 * 정리 문서의 `[..](차트/x.html)` 링크가 공개 페이지에서는 `/blog/charts/x.html` 로 바뀐다
 * (`renderMarkdown`). 파일은 `make_chart.py` 가 만들어 커밋한 내 산출물(HTML·CSV·JSON·PNG)이고
 * 저장소 밖 경로는 열지 않는다 — 세그먼트에 `..` 이 있거나 허용 확장자가 아니면 404.
 *
 * 차트 HTML 은 CDN 의 lightweight-charts 를 읽고 자기 데이터로 그린다. 앱과 같은 출처로
 * 서빙하지만 내용이 내 저장소의 커밋이라 sandbox 로 격리하지 않는다(격리하면 CSV 링크·새 탭이 막힌다).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ file: string[] }> }) {
  const { file } = await ctx.params;
  const segments = file.map((s) => decodeURIComponent(s));
  const type = isSeniorChartFile(segments);
  if (!type) return NextResponse.json({ error: "없는 차트 파일입니다." }, { status: 404 });

  try {
    const body = await readFile(join(process.cwd(), SENIOR_CHART_DIR, ...segments));
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "이 배포에 차트 파일이 없습니다." }, { status: 404 });
  }
}
