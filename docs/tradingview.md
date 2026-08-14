# 트레이딩뷰 연동 — 실시간 차트 탭

`/chart` 탭이 TradingView의 기본 기능(차트 · 지표 · 그리기 도구 · 심볼 검색)을
앱 안에서 그대로 쓰게 하는 방법을 기록한다. 구현·유지보수 시 이 문서가 기준이다.

## 1. 왜 위젯인가

**tradingview.com 본 사이트는 iframe 삽입을 차단한다** (`X-Frame-Options` /
`frame-ancestors`). "트레이딩뷰 페이지를 그대로 앱에 넣는" 직접적인 방법은 없고,
선택지는 셋뿐이다.

| 방법 | 판정 |
|---|---|
| 본 사이트를 iframe으로 삽입 | ✗ 브라우저가 차단. 불가능 |
| Charting Library (자체 호스팅) | ✗ 별도 승인 신청 + **시세 데이터를 직접 공급**해야 함 — "기본기능 그대로"가 아님 |
| **공식 Advanced Chart 위젯 임베드** | ✓ 채택. 무료, 실시간 시세 포함, 지표·그리기·심볼 검색 포함 |

위젯을 붙이는 방식도 둘을 비교했다.

| | (a) 공식 embed script 주입 — **채택** | (b) `s.tradingview.com/widgetembed/?...` iframe 직접 렌더 |
|---|---|---|
| 공식 지원 | TradingView가 배포하는 유일한 공식 코드 형태 | 스크립트가 내부적으로 만드는 URL. 문서화 안 됨 |
| 안정성 | 스크립트가 URL·파라미터 변경을 흡수 | 파라미터 스키마가 예고 없이 바뀔 수 있음 |
| 약관 | 공식 스니펫에 attribution 포함 → 자연 준수 | 수동 구성 → 위반 소지 |

앱 내부 위젯이 못 하는 것(레이아웃 저장, 알림 등 로그인 기반 기능)은 페이지
상단의 **"트레이딩뷰에서 열기 ↗"** 버튼이 본 사이트를 브라우저 새 탭으로 열어
보완한다.

## 2. 구조

| 파일 | 역할 |
|---|---|
| `src/app/(app)/chart/page.tsx` | 서버 컴포넌트 — 헤더, 열기 버튼, 높이 컨테이너. 초기 심볼(`DEFAULT_SYMBOL`)의 단일 정의처 |
| `src/app/(app)/chart/tradingview-widget.tsx` | `"use client"` — 위젯 DOM 조립·주입, 테마 감지, 정리 |
| `src/app/(app)/app-nav.tsx` | `LINKS`에 `/chart` 한 줄 (탭 등록 지점) |

동작 원리와 설계 결정:

- **스크립트 주입을 useEffect에서 직접 한다.** 공식 스니펫은 JSON 설정이
  `<script>` 태그의 *텍스트 내용*으로 들어가는 형태라 JSX로 표현할 수 없다.
  `next/script`도 쓰지 않는다 — Next의 스크립트 dedupe는 "한 번만 로드"가
  목적인데, 이 위젯은 스크립트 태그가 컨테이너 안에서 실행되는 것 자체가
  렌더링이라 테마 전환·재마운트마다 새 태그가 필요하다.
- **StrictMode 안전.** cleanup에서 `host.replaceChildren()`로 이전 위젯(iframe
  포함)을 통째로 걷어낸다. 첫 마운트의 스크립트가 로드 완료 전에 detach되어도
  detach된 컨테이너에 주입될 뿐 라이브 DOM에 중복이 생기지 않는다.
- **테마는 재생성으로 맞춘다.** 앱은 `prefers-color-scheme` 자동 다크모드인데
  위젯은 만든 뒤 테마를 바꿀 API가 없다. `matchMedia`로 감지해 테마가 바뀌면
  위젯을 새로 만든다. 이때 사용자가 바꿔 둔 심볼·그림은 초기화된다 — OS 테마
  전환은 드문 일이라 감수한다.
- **높이는 페이지가 잡는다.** `(app)` layout의 main은 `min-h` 체인이라 `h-full`이
  내려오지 않는다. layout을 고치면 모든 페이지에 영향이 가므로, 페이지에서
  `100dvh - (헤더+패딩+네비)` 계산으로 직접 잡고 `autosize: true`로 위젯이
  컨테이너를 채우게 한다.

## 3. 위젯 설정 옵션

`tradingview-widget.tsx`의 `JSON.stringify({...})` 안. 값을 바꾸면 다음 마운트부터 적용된다.

| 옵션 | 현재 값 | 의미 |
|---|---|---|
| `autosize` | `true` | 컨테이너 크기를 그대로 따른다 (컨테이너에 높이 필수) |
| `symbol` | `OKX:BTCUSDT.P` | 초기 심볼 — `page.tsx`의 `DEFAULT_SYMBOL`에서 내려옴 |
| `interval` | `"60"` | 초기 봉 주기 (분 단위 문자열, `"D"` = 일봉) |
| `timezone` | `Asia/Seoul` | 차트 축 시각대 — 앱의 표시 원칙(`src/lib/format.ts`)과 동일 |
| `theme` | 감지값 | `light`/`dark` — `prefers-color-scheme` 따라감 |
| `style` | `"1"` | 캔들 차트 |
| `locale` | `kr` | 위젯 UI 한국어 |
| `allow_symbol_change` | `true` | 위젯 안에서 심볼 검색·변경 허용 |
| `hide_side_toolbar` | `false` | 좌측 그리기 도구 툴바 표시 |
| `support_host` | `https://www.tradingview.com` | 공식 스니펫 기본값 |

전체 옵션 목록: https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/

## 4. 심볼 표기

앱 내부(OKX API)와 트레이딩뷰의 표기가 다르다.

| 앱 내부 (`toInstId`) | 트레이딩뷰 |
|---|---|
| `BTC-USDT-SWAP` | `OKX:BTCUSDT.P` |
| `ETH-USDT-SWAP` | `OKX:ETHUSDT.P` |

규칙: `OKX:` 접두어 + 하이픈 제거 + 무기한(Perpetual)은 `.P` 접미어.
현물은 접미어 없이 `OKX:BTCUSDT`.

## 5. 제약사항

- **로그인 기반 기능 없음** — 차트 레이아웃 저장, 알림, 커스텀 지표는 위젯에서
  불가. "트레이딩뷰에서 열기" 버튼으로 본 사이트에서 이어서 한다.
- **그림·심볼은 휘발성** — 새로고침, 탭 이동 후 복귀, OS 테마 전환 시 초기화된다.
  위젯 iframe 안의 상태라 앱이 저장할 수 없다.
- **열기 버튼은 초기 심볼로 연다** — 위젯 안에서 바꾼 심볼을 앱이 알아낼 공식
  API가 없다 (iframe 내부는 크로스 오리진).
- **광고 차단기** — 확장 프로그램이 `s3.tradingview.com` 스크립트를 막으면 위젯
  영역이 빈 화면이 된다. 앱 버그가 아니다.
- **짧은 시간에 반복 새로고침하면 시세가 ∅로 지연될 수 있다** — 트레이딩뷰 측
  데이터 세션 제한으로 보이며(구현 검증 중 실제 관측), 잠시 뒤 다시 열면 정상.
- **시세는 트레이딩뷰 것** — 복기용 "당시 차트"(OKX `history-candles` 프록시)와
  데이터 출처가 다르므로 미세한 가격 차이가 있을 수 있다.

## 6. 약관 (지키지 않으면 위젯 사용 자격을 잃는다)

- **attribution 제거 금지** — `.tradingview-widget-copyright`의 "Track all markets
  on TradingView" 링크는 무료 위젯 사용 조건이다. 숨기거나 지우면 안 된다.
  위젯 div 높이의 `calc(100% - 32px)`가 이 줄의 자리다.
- 위젯이 표시하는 데이터를 긁어서 재가공·재배포하면 안 된다.

## 7. 유지보수

- 임베드 스크립트: `https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js`
  (위젯 iframe은 `s.tradingview.com`에서 뜬다).
- **CSP를 도입하게 되면** 허용 목록에 추가해야 한다 (현재 `next.config.ts`는 빈
  설정이라 조치 불요): `script-src`에 `s3.tradingview.com`, `frame-src`에
  `s.tradingview.com www.tradingview.com`.
- **"당시 차트"와의 역할 구분** — 이 탭은 *실시간 관찰*용이고,
  `src/components/trade-chart.tsx`는 *거래 복기*용(진입·청산 표시, 메모 저장)이다.
  서로 코드·데이터를 공유하지 않으며, 한쪽을 고칠 때 다른 쪽을 볼 필요 없다.
- 위젯이 갑자기 안 뜨면: ① 광고 차단기 확인 ② 브라우저 콘솔에서
  `embed-widget-advanced-chart.js` 로드 실패 여부 확인 ③ 위젯 문서에서 스크립트
  URL·옵션 변경 공지 확인.
