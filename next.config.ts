import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 자료실이 여는 리포트는 저장소에 커밋된 정적 HTML이다. 그런데 `src/lib/lab.ts` 는
   * 경로를 런타임에 조립해 `statSync`·`createReadStream` 으로 읽는다 — 파일 트레이싱이
   * 정적 분석으로는 찾을 수 없는 형태라, 이 선언이 없으면 배포 번들에서 통째로 빠지고
   * 화면에는 전부 "로컬 전용"으로 뜬다.
   *
   * 복기(`re_sys/out`)와 백테스트 실험장(`backtest-lab/out`)은 gitignore 대상이라
   * 애초에 배포에 올라가지 않는다. 여기 넣는 것은 커밋되는 `docs/` 산출물뿐이다.
   */
  outputFileTracingIncludes: {
    "/lab": ["./docs/backtest/**/*.html", "./system-trading/docs/**/*.html"],
    "/api/lab": ["./docs/backtest/**/*.html", "./system-trading/docs/**/*.html"],
    // 선배님 공개 페이지 — 정리 문서(md)와 글 색인(csv)을 요청 시점에 읽는다. 같은 이유다.
    // 차트/ 는 make_chart.py 가 만든 시세 대조 페이지(html·csv·json·png) — 목록과 route 가 요청 시점에 읽는다.
    "/blog": ["./선배님/*.md", "./선배님/인덱스.csv", "./선배님/차트/*"],
    "/blog/**": ["./선배님/*.md", "./선배님/인덱스.csv", "./선배님/차트/*"],
  },
  /**
   * 정적 분석기는 `readFileSync(join(cwd, "선배님", …))` 을 보고 폴더를 통째로 넣는다 —
   * 로컬에는 gitignore 된 원본 HTML·이미지 358MB 가 있어 그대로 두면 번들이 터진다.
   * 페이지가 읽는 것은 위의 md·csv 뿐이다.
   */
  outputFileTracingExcludes: {
    "/blog": ["./선배님/_수집원본/**", "./선배님/아카이브/**", "./선배님/이미지/**", "./선배님/_수집스크립트/**", "./선배님/*.html"],
    "/blog/**": ["./선배님/_수집원본/**", "./선배님/아카이브/**", "./선배님/이미지/**", "./선배님/_수집스크립트/**", "./선배님/*.html"],
  },
};

export default nextConfig;
