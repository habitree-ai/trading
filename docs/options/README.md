# 옵션 분석 — 지표 정본 (출처 · 단위 · 산식 · 가정 · 해석 밴드)

화면은 `/options`, 코드는 `src/lib/options/`(수집 `okx.ts`·`deribit.ts`·`collect.ts`, 계산 `bs.ts`·`analyze.ts`,
해석 `guide.ts`). **이 문서가 정본이다.** 화면의 「무엇인가 · 어떻게 읽나」(`guide.ts` 의 `OPTION_GUIDE`)와
「지금 값의 뜻」 밴드가 여기와 어긋나면 이 문서를 먼저 고치고 코드를 따라 맞춘다.

저장하지 않는다. 화면을 열 때 두 거래소 공개 API 를 부르고(키 없음, fetch 60초 캐시, 일봉 300초) 그 자리에서
계산한다 — 이력 누적은 비목표(REQ-0070). 추이는 거래소가 주는 범위(OKX 8H × 72점 = 24일)만 보여 준다.

---

## 0. 단위 — 여기서 고정한다

| 값 | 단위 | 근거 |
|---|---|---|
| OI · 거래량 | **BTC 개수** | 두 거래소 모두 코인 정산. OKX `oiCcy`·`volCcy24h`(계약수 `oi`·`vol24h` 는 0.01 BTC 단위라 쓰지 않음), Deribit `open_interest`·`volume` |
| IV · DVOL · 실현변동성 | **소수**(0.38 = 38%), 연율 | Deribit `mark_iv`·DVOL 은 퍼센트로 오므로 ÷100. OKX `markVol` 은 이미 소수 |
| 가격(행사가·선도가·지수가·맥스페인·벽) | **USD** | |
| GEX | **USD / 현물 1% 변동** | §3.7 |
| 만기 키 | UTC `YYYY-MM-DD` | 두 거래소 모두 08:00 UTC 정산 — OKX `260925` 와 Deribit `25SEP26` 이 같은 키로 합쳐진다 |
| 시각 | 화면은 `Asia/Seoul`(`dateTime`) | OKX 테이커 1D 봉의 `ts` 는 봉의 끝(UTC+8 자정 = 16:00 UTC) |

`""`(OKX 의 빈 값)·`0`(만기 직전 종목의 IV)은 "값 없음" 이라 null 로 두고, 0 과 구분한다. 화면은 null 을 `—` 로 그린다.

## 1. 출처 (엔드포인트)

| 소스 키 | 엔드포인트 | 쓰는 필드 | 캐시 |
|---|---|---|---|
| `okx` | `GET /api/v5/public/open-interest?instType=OPTION&instFamily=BTC-USD` | `instId`, `oiCcy` — 종목 목록의 **기준**(OI 0·만기 지난 종목 제외) | 60s |
| `okx` | `GET /api/v5/public/opt-summary?instFamily=BTC-USD` | `markVol`(IV), `fwdPx`(선도가). `gammaBS`·`deltaBS` 는 검증용 | 60s |
| `okx` | `GET /api/v5/market/tickers?instType=OPTION&instFamily=BTC-USD` | `volCcy24h`(24h 거래량) | 60s |
| `okx` | `GET /api/v5/rubik/stat/option/open-interest-volume?ccy=BTC&period=8H` | `[ts, oi, vol]` 72행 | 60s |
| `okx` | `GET /api/v5/rubik/stat/option/open-interest-volume-ratio?ccy=BTC&period=8H` | `[ts, oiRatio, volRatio]` 72행 — **콜/풋**이라 파서가 1/x 로 뒤집어 풋/콜로 싣는다(2026-09-20 실측: 만기별 콜·풋 OI 합의 콜/풋 0.8381 = oiRatio) | 60s |
| `okx` | `GET /api/v5/rubik/stat/option/taker-block-volume?ccy=BTC&period=1D` | `[ts, callBuy, callSell, putBuy, putSell, callBlock, putBlock]` — 봉투 안에 납작한 배열 하나. `ts` 는 봉의 **끝**(UTC+8 자정), 값은 그 앞 하루치 확정값. 테이커 넷은 BTC(정산통화); **블록 둘은 단위 미상**(문서에 없고 실측도 BTC 가 아님 — 공개 블록 체결 합의 60~130배)이라 화면에 쓰지 않는다 | 60s |
| `deribit` | `GET /api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option` | `instrument_name`, `open_interest`, `volume`, `mark_iv`(%), `underlying_price`(선도가) | 60s |
| `dvol` | `GET /api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp&end_timestamp` | 마지막 봉의 `close`(%) — 최근 24h 창, 끝은 분 단위로 내림 | 60s |
| `candles` | `GET /api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1D&limit=32` | `confirm="1"` 인 봉의 종가만(진행 중인 오늘 봉 제외) | 300s |
| (지수가) | `GET /api/v5/market/index-tickers?instId=BTC-USD` → 실패·빈 값이면 `GET /api/v2/public/get_index_price?index_name=btc_usd` | `idxPx` / `index_price` — `sources` 키가 아니다 | 60s |

OKX 여섯 호출은 `Promise.all` 이라 하나만 죽어도 `okx` 소스 전체가 실패다(종목 없이 이력만 있는 반쪽은 다룰 게 없다).
소스 넷은 `Promise.allSettled` 로 갈라 하나가 죽어도 나머지는 남기고 `sources.<key>` 에 `error: …` 가 적힌다.
응답은 왔는데 종목이 **0행**이면 그 거래소도 실패(`error: … 응답에 종목이 없습니다`)로 적는다 — 봉투 모양이 바뀌어 파서가
빈 배열을 돌린 경우가 "OI 0" 으로 읽히면 안 된다. OKX 는 종목은 있는데 tickers·opt-summary 가 빈 `data` 로 와 거래량·IV 가
전부 비어도 소스 실패로 돌린다(`fetchOkxOptions`) — 합산에서 0 으로 읽히는 것을 막는다.
**`okx`·`deribit` 둘 다 실패했을 때만** throw → `(app)/error.tsx` 카드(다시 시도).

## 2. 합산 vs 정본 — 지표마다 재료 범위가 다르다

| 지표 | 재료 | 이유 |
|---|---|---|
| 총 OI · 24h 거래량 · 풋콜비 · 맥스페인 · 콜벽/풋벽 · GEX | 두 거래소 **합산** | 정산통화(BTC)가 같아 그냥 더한다 |
| ATM IV · IV 기간구조 · 25Δ 스큐 · 선도가 | 거래소 **하나**(`ivVenue`) — Deribit 우선, IV 가 없으면 OKX | 두 거래소의 마크 IV 는 산출 방식이 달라 섞으면 스마일이 톱니가 된다. Deribit 이 BTC 옵션 OI 의 약 92%(2026-09-18: 422k vs 35k BTC) |
| DVOL | Deribit | Deribit 만 낸다 |
| 실현변동성 | OKX 1D 종가 | |
| 테이커 흐름 · 추이 | OKX | Deribit 은 공개 집계가 없다. 추이의 풋콜비는 OKX 한 곳 값이라 타일(합산)과 수준이 다르다 |

화면 머리에 `ivVenue` 가 어느 쪽인지 적고, OKX 로 대체됐으면 그렇다고 말한다.

## 3. 산식

### 3.1 풋콜비
`pcrOi = Σ풋 OI ÷ Σ콜 OI`, `pcrVol = Σ풋 24h 거래량 ÷ Σ콜 24h 거래량`. 분모 0 이면 null.

### 3.2 맥스페인 (만기별)
후보 행사가 K 마다 `payout(K) = Σ callOi·max(0, K − Kc) + Σ putOi·max(0, Kp − K)` 가 최소인 K.
후보는 그 만기의 행사가 집합, 동률이면 작은 K, OI 합 0 이면 null. BTC 개수 그대로 곱한다(정산통화가 같아 USD 환산 불필요).

### 3.3 ATM IV (만기별)
`ivVenue` 행 중 markIv 가 있는 것에서 **선도가**에 가장 가까운 행사가의 콜·풋 IV 평균(하나만 있으면 그것). 거리 동률이면 작은 행사가.
기준점은 그 만기 `ivVenue` 행의 첫 non-null `forward`, 없으면 지수가. 표의 「선도가」 칸은 선도가가 있을 때만 채우고 지수가를 대신 넣지 않는다.

### 3.4 25Δ 리스크 리버설 (만기별)
행마다 그 행의 markIv 로 BS 델타(r = 0, T = dte/365)를 내고, 콜은 +0.25·풋은 −0.25 를 **양쪽에서 감싸는** 두 점 사이를 선형보간.
`rr25 = IV(25Δ 콜) − IV(25Δ 풋)`. 감싸는 점이 없으면(행사가가 좁거나 만기 직전) null — 외삽하지 않는다.

### 3.5 실현변동성 30일
OKX 1D 마감 종가(오래된 것부터) 마지막 31개 → 로그수익률 30개 → 표본 표준편차(n − 1) × √365. 종가가 모자라거나 0 이하가 끼면 null.

### 3.6 IV − RV
`DVOL − RV30`(소수 차이, 화면은 %p). 어느 쪽이든 없으면 null.

### 3.7 GEX
행마다 `gex = sign × Γ_F × OI × F × S × 0.01` — `sign` 은 콜 +1 / 풋 −1, Γ_F 는 그 행의 markIv 로 낸 선도가 기준 감마
(Black-76, F = 행의 선도가, 없으면 지수가; r = 0; T = 잔여 ms / 365일), S 는 지수가. 현물 기준 감마가 Γ_F·F/S 라
현물 1% 의 헤지 USD 는 Γ_F·OI·F·S·0.01 이다(spot² 을 곱하면 원월에서 F/S 만큼 작다). 행사가별 합이 `byStrike`,
전체 합이 `total`(USD / 현물 1% 변동).
**플립 행사가**: 후보 행사가 K 마다 "현물이 K 였다면"(각 다리의 S 와 spot² 를 K 로) 총 GEX 를 다시 내고, 부호가 바뀌는
인접 쌍을 선형보간. 교차가 여럿이면 현재가에 가장 가까운 것.

OKX `gammaBS` 로 교차검증: 270326-90000-C 에서 Γ_F 1.75e-5 vs OKX 1.80e-5 — 비율이 만기마다 정확히 F/S 다(OKX 는 현물 기준 감마).

### 3.8 콜벽 · 풋벽
전체 만기 합의 행사가별 OI 에서, 현재가 **위**에서 콜 OI 최대 행사가 = 콜벽, **아래**에서 풋 OI 최대 행사가 = 풋벽.
그쪽에 행사가가 없거나 OI 최대가 0 이면 null. **지수가가 없으면 둘 다 null** — 위/아래가 없는데 전체 최대를 벽이라 부르지 않는다.
개별 만기 차트에서는 그리지 않는다(다른 행사가가 벽이다).

### 3.9 D-day
`dte = (만기 08:00 UTC − 수집 시각) / 1일`(소수). 표·타일·해석 문구 모두 **올림**(0.76일 남으면 `D-1` — 내일 만기).

### 3.10 헤드라인 "근월" — `pickHeadline`
만기 하루 이틀 앞 종목은 T 가 0 에 가까워 델타가 극단으로 몰리고 ATM IV·25Δ 스큐가 잡음이 된다
(실측 2026-09-18: D-1 RR +6.1%p, 다음 만기 null·+3.3%p). 그래서 한눈에 타일의 ATM IV, 스큐 해석, 기간구조 해석의
"근월" 은 **화면 D-day(올림)가 7 이상인 첫 만기**(`HEADLINE_MIN_DTE = 7`, 7 포함 — 잔여 6.2일도 D-7 이라 포함)다. 그런 만기가 없으면 첫 만기.
맥스페인 타일만 첫 만기(내일 만기의 끌림이 곧 관심사)를 쓴다. 만기별 표에는 전 만기가 그대로 있다.
`readIvTerm` 은 근월 앞의 만기 직전 점이 근월보다 1%p 넘게 높으면 문구 끝에 그 사실을 따로 말한다.

## 4. 가정 — 화면에 적어야 하는 것

- **GEX 는 추정치다.** 딜러가 콜 롱·풋 숏이라는 표준 가정(콜 +, 풋 −) 하나만 쓴다. 실제 딜러 포지션은 공개되지 않는다.
  부호와 자릿수만 참고하고 플립 행사가도 그 가정 아래의 경계다. 고도화는 비목표.
- BS 에서 r = 0, 배당 없음. 두 거래소 모두 코인 정산이지만 감마는 USD 기준으로 환산해 더한다.
- 테이커 흐름은 OKX 하루치(UTC+8 하루 마감값)라 방향 참고용. 블록 거래량은 단위 미상이라 표시하지 않는다.
- 맥스페인 "끌림" 은 가설이지 규칙이 아니다 — 문구에 항상 그렇게 쓴다.

## 5. 해석 밴드 (`guide.ts`) — 관행값, 써 보고 조정

| 지표 | 밴드 | tone | 근거 |
|---|---|---|---|
| 풋콜비(OI·거래량) | ≥1.0 풋 우위 / 0.7~1.0 보통 / <0.7 콜 쏠림 | warn / neutral / warn | BTC 옵션은 콜이 늘 더 많아(커버드콜·상승 베팅) 평소 0.5~0.7 |
| DVOL | ≥80% 이벤트·패닉 / 60~80 높음 / 40~60 보통 / <40 조용 | bad / warn / neutral / warn | 2021 이후 대략 35~150 를 오감. 80 은 2022 폭락·ETF 급 이벤트 |
| IV − RV | >+10%p 두터운 프리미엄 / −5~+10 보통 / <−5 실현이 IV 초과 | warn / good / warn | 평소 변동성 프리미엄 0~10%p |
| 맥스페인 거리 | <2% 같은 자리 / 2~5% 가설 구간 / >5% OI 쏠림 | neutral / warn / warn | 만기 주 1~2% 는 늘 움직인다 |
| 25Δ 스큐 | <−5%p 강한 풋 / −5~0 약한 풋(평소) / 0~+3 콜 우위 / >+3 강한 콜 | bad / neutral / warn / bad | BTC 는 주식보다 풋 스큐가 약하다 |
| GEX | 양수 롱감마(억제) / 음수 숏감마(확대) | neutral / warn | 부호가 전부, 크기 밴드 없음 |
| IV 기간구조 | 근월(D-7↑ 첫 만기) < 최원월 콘탱고 / > 역전 / = 평평 | good / warn / neutral | 평평 밴드 없음 — 0.1%p 차이도 콘탱고라 말한다. 만기 직전 점이 더 높으면 문구 끝에 덧붙인다 |
| 테이커 흐름 | 콜 매수+풋 매도 강세 / 콜 매도+풋 매수 약세 / 둘 다 매수 변동성 매수 / 둘 다 매도 변동성 매도 | warn / warn / neutral / neutral | 순매수 = 매수 − 매도, >0 만 "매수" |
| 콜벽 · 풋벽 | 밴드 없음 — 거리와 "후보" 만 | neutral | OI 가 몰린 곳은 후보지 확정 지지/저항이 아니다 |

경계 포함: 풋콜비 1.0·0.7 은 위 밴드(≥), DVOL 40·60·80 은 위 밴드(≥), IV−RV −5·+10 은 보통 밴드, 맥스페인 2%·5% 는 가설
구간(>5% 가 멀다), 스큐 −5 는 위 밴드(−5~0 약한 풋, 강한 풋은 <−5), 0·+3 은 아래 밴드. null 은 전부 neutral 「재료 없음 — …」.

## 6. 실측 (2026-09-18, 이 머신 curl)

- OKX open-interest 1,772행 중 oiCcy>0·만기 남음 559행, OI 합 34,907 BTC, 만기 12개. 지수가 77,952~78,291.
- Deribit book summary 930행 → 778행, OI 422,415 BTC, 만기 12개(2026-09-19 … 2027-06-25). DVOL 34.08~34.15.
- 타 사이트 대조: 총 OI 는 Deribit 화면 총 OI ± 수집 시차, DVOL 은 Deribit 표시값과 일치, 근월 맥스페인은 같은 행사가여야 한다.

## 7. 비목표 (REQ-0070)

DB 저장·이력 누적, 옵션 주문·포지션·계좌 연동, BTC 외 기초자산, 전략 계산기·알림, GEX 딜러 포지션 추정 고도화,
`/research` 스냅샷 컬럼 확장.
