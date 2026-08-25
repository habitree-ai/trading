# re_sys — 쿼드 복기 시스템

OKX 과거 데이터 전량(상장 2019년~)을 로컬에 누적하고, 라이브 쿼드 봇과 **같은 부등식·같은 체결 규칙**으로
"언제 신호가 났고 → 들어갔다면 언제 어떻게 나왔나"를 전 기간 재현하는 복기 도구다.
현 시스템(system-trading/bot) 밖의 독립 데이터 계층이며, 판정 로직만 봇에서 import 한다 —
복기와 봇이 다른 것을 보면 복기가 아니다.

두 갈래의 복기가 있다:

- **쿼드 복기 (P1~P3)** — 시스템 전략의 신호·체결을 전 기간 재현
- **매매 복기 (M0~M3)** — 본인 매매 전 거래의 진입 의도를 차트 상태로 유추하고
  실패 원인을 분류·집계

매매 복기가 보는 OKX 계정은 **둘**이다(2026-08-18 점검에서 확인):
`.env.local` 키 = 봇·DOGE 계정(uid 6419\*\*\*), 앱 설정 → Supabase Vault 키 = **주 매매
계정**(uid 4966\*\*\*, 포지션 2,900+). 매매일지 11건은 후자에서 동기화된 것으로, posId
매칭으로 OKX 정본과 병합된다. 계정 정의: `lib/accounts.mjs`.

## 실행 순서

```bash
# 쿼드 복기 (시스템 전략)
node re_sys/fetch.mjs            # P1 캔들 수집·누적 (첫 실행: 전 구간 · 이후: 증분)
node re_sys/replay.mjs           # P2 신호·체결 복기 (기준별 독립 + 포트폴리오)
node re_sys/report.mjs           # P3 HTML 리포트 생성

# 매매 복기 (본인 매매)
node re_sys/manual-archive.mjs   # M0 분기 원장 아카이브 신청·다운로드·라운드트립 재구성 (비동기 — 될 때까지 재실행)
node re_sys/manual-fetch.mjs     # M1 거래·체결·펀딩청구서 수집·누적 + 트레이드별 캔들 창 캐시
node re_sys/manual-analyze.mjs   # M2 의도 유추·MFE/MAE·실패 분류·집계
node re_sys/manual-report.mjs    # M3 HTML 리포트 생성 (out/manual-report.html)

# 인덱스 — 리포트·데이터 재고 한눈에
node re_sys/index.mjs            # out/index.html
```

- `fetch.mjs --full` — 저장분을 무시하고 전 구간 재수집(복구·검증용).
- 검증 기준: 시각 단조 위반 0 · 결측률 <1%. 어긋나면 저장 없이 중단한다.
- 리포트: `re_sys/out/report.html` (최신) + `out/archive/report-YYYY-MM-DD.html` (회차 누적).

## 데이터 배치 (전부 gitignore — 재수집·재생성 가능)

| 파일 | 내용 |
|---|---|
| `data/candles-{SYM}-{TF}.json` / `.csv` | 확정봉 누적 — BTC·DOGE × 1D·4H·1H(전 구간)·15m(730일~)·5m(60일~). 캡 TF도 증분 실행이 쌓이면 캡을 넘어 자란다 |
| `data/funding-{SYM}.json` | 펀딩비 실측 누적 — OKX 보존창(≈95일)씩 받아 아카이브를 키운다 |
| `data/manual-fills.json` | 체결 단위 원장 누적 (보존창 ≈3개월 → 주기 실행으로 보존) |
| `data/manual-funding-bills.json` | 펀딩비 청구서(type 8) 누적 |
| `data/manual-bills.json` + `bills-archive/` | 분기 원장 아카이브(bills-history-archive) — 계정 전 청구서 정본. 원본 CSV 보존 |
| `data/replay.json` | 쿼드 복기 정본: 기준별 신호·트레이드·요약 + 포트폴리오 |
| `data/trades.csv` | 기준별 독립 트레이드 전량 (외부 분석용 로우데이터) |
| `data/signals.csv` | 발화 신호 전량 — 미진입·사유 포함 |
| `data/manual-trades.json` / `.csv` | 본인 매매 통합 이력 (두 OKX 계정 positions-history + 일지, posId 중복 병합) |
| `data/manual-chunks.json` | 캔들 청크 캐시(100봉 정렬, 1m~4H) — 거래 수가 아니라 활동 시간에 비례 |
| `data/manual-review.json` / `.csv` | 매매 복기 정본: 의도 유추·태그·실패 분류·집계 |
| `out/report.html` | 쿼드 복기 리포트 (브라우저로 열기) |
| `out/manual-report.html` | 매매 복기 리포트 — 실패 랭킹 + 전 거래 카드 |

매매 복기의 수집(M1)은 `.env.local` 의 OKX·Supabase 키를 읽는다(읽기 전용 조회).
OKX positions-history 보존창이 밀려도 로컬 누적분은 남는다 — 주기적으로 M1을 돌려두면
전량이 보존된다.

## 복기 규칙 (봇과의 동치성)

- 판정: 확정 봉에서만. `SIGNALS`·지표는 `../system-trading/bot/signals.mjs` 를 그대로 import.
- 진입: 신호 봉 다음 봉 **시가** (봇의 "마감 직후 시장가" 근사).
- 청산: 손절 우선 → 갭이면 시가 체결 · 목표는 목표가 체결 · 시한(`maxHoldBars`) 초과 시 종가 정리.
- 사이징: L = min(10, riskPct ÷ (손절폭% + feePct)) · 순손익 = (총손익% − feePct) × L.
- 두 층위: **기준별 독립**(한 기준 한 포지션) = 신호 이력 정본 · **포트폴리오**(동시 2개·리스크 합 20%·복리) = 쿼드 봇 근사.
- 미반영: 펀딩비 · 실슬리피지(수수료 추정에 포함) · 보유 중 미실현 낙폭(MDD는 청산 시점 기준).

## 설정 변경 시

기준·청산 폭은 `system-trading/bot/config.mjs` 가 정본이다. 바꾸면 `replay.mjs`·`report.mjs` 를
다시 돌려라 — 리포트에 당시 설정 스냅샷이 박혀 있어 회차 간 비교가 된다.
