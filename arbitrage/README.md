# 아비트라지 타당성 조사 — OKX ↔ 업비트

> 정본: `out/arbitrage-report.html` (자기완결 HTML). 데이터는 `out/arbitrage.json`.
> 백로그: `.backlog/…REQ-0011_spike_…arbitrage-feasibility.md` · 계획서 `~/.claude/plans/okx-wiggly-quill.md`.
> 이 문서와 리포트가 다르면 리포트(JSON 에서 생성)가 옳다. 작성 기준일 2026-08-26.

## 질문

> 업비트–OKX 가격 차이(김치프리미엄), OKX 현물–스왑 베이시스·펀딩, 업비트 내부 마켓 간 괴리를
> 수수료·전송·규제까지 넣고 재면, **시스템 거래로 굴릴 수 있는 구조가 있는가?**

여섯 구조를 같은 데이터로 재고 사전 등록한 기준으로 판정한다.

| 키 | 구조 | 자금 전송 | 왕복 비용(추정) |
|---|---|---|---|
| A | 전송형 김프 (OKX↔업비트 실물 이동, 헤지 유/무) | 있음 | 0.25~0.5% + 출금비 |
| B | 헤지형 김프 (업비트 현물 롱 + OKX 스왑 숏) | 없음 | 0.20% |
| C | 종목 간 상대 프리미엄 (코인 − BTC, 4다리) | 없음 | 0.40% |
| D | OKX 현물–스왑 펀딩 캐리 · 코인마진 분기 베이시스 (**기준선**) | 없음 | 0.30% |
| E | 업비트 삼각 (KRW · BTC · USDT 마켓) | 없음 | 0.35% + 스프레드 |
| F | 테더 프리미엄 vs 코인 프리미엄 (진단) | — | — |

## 정의

```
P_coin,X = 업비트 KRW-X / (OKX X-USDT × 업비트 KRW-USDT) − 1   테더 김프 (1m·1D, 2024-06-07~)
P_usd,X  = 업비트 KRW-X / (OKX X-USDT × USD/KRW(ECB)) − 1      달러 김프 (1D, 3년)
P_usdt   = KRW-USDT / USD/KRW − 1                                테더 프리미엄
R_X      = P_coin,X − P_coin,BTC                                 상대 프리미엄
D        = KRW-BTC / (USDT-BTC × KRW-USDT) − 1                   업비트 삼각 괴리
basis    = 스왑/현물 − 1 ;  만기 연환산 = (F/지수 − 1) × 365 / 잔존일
```

## 구조

```
arbitrage/
├─ README.md
├─ fees.config.json      수수료 정본 (verified 플래그·출처·가정값)
├─ lib/
│   ├─ http.mjs          fetchJson(재시도·백오프) · pacedPool · progress
│   ├─ cache.mjs         .cache / out 경로, fetch-report 병합
│   ├─ verify.mjs        결측률·단조증가·봉경계 검증
│   ├─ align.mjs         inner-join · forward-fill · 다운샘플
│   ├─ premium.mjs       산식·통계·사이클 (순수 함수)
│   └─ premium.test.mjs  손계산 픽스처 (node --test)
├─ universe.mjs          업비트 KRW ∩ OKX 현물 ∩ OKX 스왑 → 30종
├─ fetch-fx.mjs          Frankfurter USD/KRW 일봉 3년
├─ fetch-upbit.mjs       업비트 캔들 (1m/5m 90일 · 1D 3년 · KRW-USDT · USDT 마켓)
├─ fetch-okx.mjs         OKX 현물·스왑 캔들 · BTC-USD 지수 · 분기물 · 펀딩(OKX+Binance)
├─ book-logger.mjs       호가 로거 (5초, 48h, 분리 실행)
├─ book-summarize.mjs    호가 → 실행 가능 스프레드 · 선후행 · 삼각
├─ analyze.mjs           프리미엄 통계 + 전략 A~F + 판정표 → out/arbitrage.json
├─ report.mjs            JSON → template.html → out/arbitrage-report.html
├─ template.html
├─ .cache/               원시 데이터 (gitignore)
└─ out/                  arbitrage.json · arbitrage-report.html
```

## 실행

```bash
node arbitrage/universe.mjs
node arbitrage/fetch-fx.mjs
node arbitrage/fetch-upbit.mjs          # 약 20분
node --max-old-space-size=4096 arbitrage/fetch-okx.mjs   # 약 1~2시간
# 호가 로거 — 별도 프로세스로 24~48h
node arbitrage/book-logger.mjs --hours 48
node arbitrage/book-summarize.mjs        # 로거가 24h 이상 쌓인 뒤
node --test arbitrage/lib/premium.test.mjs
node --max-old-space-size=4096 arbitrage/analyze.mjs
node arbitrage/report.mjs
```

`fetch-*` 는 캐시가 있으면 건너뛴다(`--force` 로 재수집, `--only` 로 일부만).

## 검증 기준 (사전 등록)

- 수집: 시각 단조 증가 위반 0 · 봉경계 정렬 100% · 결측률 BTC/ETH/USDT 계열 < 1%, 알트 1m < 5%, 업비트 USDT 마켓은 얇음 표시
- 불변식(어기면 analyze 중단): |P_coin| < 20% · |P_usdt| < 10% · |basis| < 2% · |D| < 2% · BTC·ETH 1m 조인 커버리지 ≥ 95% · 환율 결측 0
- 판정 기준은 `analyze.mjs` 의 `CRITERIA` 에 고정 — 데이터를 본 뒤 바꾸지 않는다

## 데이터 출처에서 확인한 사실

- 업비트 공개 API 는 무인증, 1분봉이 2019년까지 있다. 체결 없는 분은 봉이 없다. `KRW-USDT` 는 2024-06-07 상장.
- OKX `1D` 는 UTC+8 경계 → `1Dutc` 를 쓴다. USDT 마진 만기선물은 2026-06-26 폐지 → 코인마진 `BTC-USD-분기`.
- OKX 펀딩 이력은 약 95일만 → 3년은 Binance 대리(겹치는 구간 상관을 리포트에 표시).
- Dunamu 환율 API 는 사용 불가 → Frankfurter(ECB) 일봉, 주말은 forward-fill 표시.
- 업비트 트래블룰 "계정주 확인" 목록에 OKX 포함(2026-06-30). 김프 환치기 대법원 2025-09-11 유죄 취지 파기환송(영업성 핵심). 과세 2027-01-01 예정(미확정).
