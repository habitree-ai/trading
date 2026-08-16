# 시스템 트레이딩 — 쿼드 공격형 (BTC-USDT-SWAP)

백테스트 시리즈(132조합 탐색 → 플레이북 Top 5 → 청산 관리 → 복리 병행 5방식)에서
검증된 **4개 기준을 한 계좌에 병행**하는 자동매매 시스템. 복리 검토의 ⑤ 구성 그대로다.

| 기준 | 봉 | 방향 | 청산 | 상세 |
|---|---|---|---|---|
| ① 골든크로스 | 4H | 롱 | 손절 1×ATR · 목표 3×ATR | [docs/criteria.md](docs/criteria.md) |
| ② RSI 과매도 반등 | 4H | 롱 | 손절 1×ATR · 목표 3×ATR | 〃 |
| ③ RSI 과매수 반락 | 4H | 숏 | 손절 2×ATR · 목표 4×ATR | 〃 |
| ④ 20봉 신저가 이탈 | 1D | 숏 | 손절 2% · 목표 4% | 〃 |

사이징: `레버리지 = min(10, 리스크% ÷ (손절폭% + 0.1%))` · 거래당 리스크 10%(설정) ·
동시 리스크 합 상한 20% · 격리 마진 · 시한 청산(4H 60봉 / 1D 20봉).

**백테스트 요약(720일, $100)**: $996 (+896%) · MDD −72.3% · 171건(월 7.5건) · 벤치마크 보유 $96.
⚠️ 인샘플 상한이다 — 실전은 [operations.md](docs/operations.md)의 **승격 사다리**
(페이퍼 → 데모 → 라이브 2% → 5% → 10%)를 따른다.

## 빠른 시작

```
# 0) 키 검증 (주문 없음·읽기 전용) — 키 유형·권한·포지션 모드·잔고 확인
node --env-file=.env.local system-trading/bot/check-keys.mjs

# 1) 페이퍼 모드 — API 키 없이 지금 바로. 신호 평가·가상 체결이 data/ 에 쌓인다.
node system-trading/bot/run.mjs --loop

# 2) 데모 모드 — OKX 모의거래 키 발급 후
copy system-trading\bot\.env.example system-trading\bot\.env    → 직접 키 입력
node --env-file=system-trading/bot/.env system-trading/bot/run.mjs --mode demo --loop

# 3) 라이브 — operations.md 승격 사다리 통과 후, 이중 안전장치 해제해야만 켜진다.
```

## 구조

```
system-trading/
├─ README.md              이 파일
├─ docs/
│  ├─ criteria.md         4개 기준 상세 명세 (판정의 정본)
│  ├─ operations.md       승격 사다리·일상 점검·장애 대응
│  └─ roadmap.md          고도화 로드맵 (한계·TODO)
├─ bot/
│  ├─ run.mjs             진입점 (paper | demo | live, --loop)
│  ├─ engine.mjs          사이클: 관리 → 평가 → 진입 → 기록
│  ├─ signals.mjs         4개 기준 판정 (백테스트와 동일 부등식)
│  ├─ indicators.mjs      Wilder RSI·ATR·SMA·20봉 최저 (백테스트와 동일 계산)
│  ├─ okx.mjs             OKX v5 클라이언트 (공개 + 서명, 데모 헤더)
│  ├─ state.mjs           상태·로그 저장
│  ├─ config.mjs          파라미터 (기준·리스크·상한)
│  └─ .env.example        키 양식 (.env 는 git 제외)
└─ data/                  ← 시스템 거래 데이터 (git 제외, 로컬 축적)
   ├─ state-<mode>.json       현재 상태 (잔고·열린 포지션·마지막 평가 봉)
   ├─ decisions-<mode>.jsonl  모든 평가 기록 — 신호 없던 봉도 남는다 (고도화 원재료)
   ├─ trades-<mode>.jsonl     진입·청산 전체 기록
   └─ equity-<mode>.jsonl     사이클별 잔고 스냅샷
```

## 안전 장치

- 기본 모드는 **페이퍼**(주문 없음, 키 불필요). 데모는 OKX 모의거래(`x-simulated-trading`).
- 라이브는 `--mode live` + 환경변수 `LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK` 둘 다 필요.
- 진입 주문에 손절·목표 브래킷이 **동시 부착** — 봇이 죽어도 보호는 거래소에 남는다.
- API 키는 `.env` 로만(커밋 제외), 권한은 거래만(출금 금지), IP 화이트리스트 권장.
