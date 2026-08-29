# MTF 정렬 분석 — 1m · 15m · 1H · 4H 동방향 시점

1분봉부터 4시간봉까지 **네 타임프레임이 같은 방향**(상승 또는 하락)으로 정렬된 시점을 탐지하고,
그 **시작점**에서 각 봉의 기술적 분석 스냅샷을 기록한다.

## 질문

> BTC가 단기(1m)부터 중기(4H)까지 한 방향으로 움직이기 시작할 때, 각 봉에서 차트는 어떤 모습인가?

## 방향 정의 (oneway-ta `htfAlign`과 동일)

각 봉에서 **이미 마감된** 캔들만 사용 (미래 참조 없음):

```
상승(1): EMA20 > EMA50  AND  종가 > EMA20
하락(-1): EMA20 < EMA50  AND  종가 < EMA20
혼조(0): 그 외
```

**4-way 정렬**: 1m · 15m · 1H · 4H 네 봉 모두 같은 부호(1 또는 -1).

## 구조

```
mtf-align/
├─ README.md           이 파일
├─ analyze.mjs         P2 — 정렬 탐지 + TA 스냅샷
├─ report.mjs          P3 — HTML 리포트
└─ out/
   ├─ mtf-align.json           전체 결과
   └─ mtf-align-report.html    읽기용 리포트
```

캔들 캐시는 `scripts/backtest/.cache/oneway-{tf}.json` 을 공유한다.

## 실행

```bash
# 1) 캔들 수집 (1m 540일 · 15m/1H/4H 540일 — 공통 구간 맞춤)
node scripts/backtest/oneway-fetch.mjs 1m 15m 1H 4H

# 2) 분석
node --max-old-space-size=8192 mtf-align/analyze.mjs

# 3) 리포트
node mtf-align/report.mjs
```

## 산출물

| 파일 | 내용 |
|---|---|
| `out/mtf-align.json` | 정렬 시작 이벤트 전체 + 집계 프로파일 |
| `out/mtf-align-report.html` | TA 프로파일·빈도·샘플 이벤트 시각화 |

## 백테스트 시리즈와의 관계

기존 oneway 회차(2026-08-25)는 **단일 봉** 임펄스 시작점 프로파일을 봤다.
이 분석은 **네 봉 동시 정렬**이라는 더 엄격한 조건에서 시작점 TA를 본다 —
실전에서 "전 타임프레임이 같은 방향"일 때 참고할 자료.
