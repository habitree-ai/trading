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
  },
};

export default nextConfig;
