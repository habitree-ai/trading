/**
 * 기획 5종 + 대조군. 전부 "손실 상한은 진입 시점에 확정, 상방은 열어둔다"는 한 문장의 변주다.
 * initSl 은 ATR(14) 배수 = 1R. 이 값이 곧 사이징의 분모이며, 어떤 기획도 이 선을 넓히지 않는다.
 */
export const PLANS = [
  {
    key: "P1", name: "샹들리에 러너", family: "추적",
    initSl: 1.5, tp: null, trail: { type: "chandelier", mult: 3 }, trailArmR: 0,
    beArmR: null, partial: null, timeCut: null, pyramid: null,
    why: "LeBeau·Elder 의 고전. 최고가(22봉)에서 3ATR 뒤를 따라가며 절대 후퇴하지 않는다. 목표가를 두지 않아 추세가 가는 만큼 간다.",
    source: "Chandelier Exit — 22봉 최고가 − 3×ATR(22), StockCharts/QuantifiedStrategies",
  },
  {
    key: "P2", name: "터틀 러너(피라미딩)", family: "증량",
    initSl: 2, tp: null, trail: { type: "donchian" }, trailArmR: 0,
    beArmR: null, partial: null, timeCut: null, pyramid: { stepN: 0.5, max: 3 },
    why: "터틀 정통. 0.5N 전진마다 1유닛씩 최대 3회 증량하고, 반대편 돈치안(10봉) 이탈에서 전량 청산. 이기는 거래에 돈을 더 태우는 유일한 기획.",
    source: "Turtle Trading System — Donchian 진입, 0.5N 단위 피라미딩, 최대 4유닛",
  },
  {
    key: "P3", name: "절반익절 러너", family: "분할",
    initSl: 1.5, tp: null, trail: { type: "atr", mult: 3 }, trailArmR: 0,
    beArmR: null, partial: { atR: 1, frac: 0.5 }, timeCut: null, pyramid: null,
    why: "1R에서 절반을 덜어 총손실을 줄이고 나머지를 러너로 남긴다. PF는 오르고 기대값은 내려간다는 것이 통설 — 어느 쪽이 이기는지 본다.",
    source: "Scale-out vs all-in-all-out 비교 — PF 상승·EV 하락 트레이드오프",
  },
  {
    key: "P4", name: "데드머니 컷 러너", family: "시간",
    initSl: 1, tp: null, trail: { type: "atr", mult: 4 }, trailArmR: 0,
    beArmR: null, partial: null, timeCut: { needR: 0.5 }, pyramid: null,
    why: "하방을 둘로 고정한다 — 가격(1R)과 시간(K봉 안에 +0.5R 미달 시 강제 청산). 살아남은 거래에만 4ATR 광폭 추적을 허용해 길게 연다.",
    source: "MFE/MAE 기반 관리(Sweeney) — 도달 시간 분포로 죽은 거래를 걸러낸다",
  },
  {
    key: "P5", name: "2단 래칫 러너", family: "단계",
    initSl: 1.5, tp: null, trail: { type: "chandelier", mult: 3 }, trailArmR: 2,
    beArmR: 1, partial: null, timeCut: null, pyramid: null,
    why: "1R에서 손절을 진입가로 당기고(무손실화), 2R부터 샹들리에로 넘긴다. 연구는 조기 브레이크이븐이 기대값을 깎는다고 본다 — 반대 가설을 같은 판에 올린다.",
    source: "브레이크이븐 스톱 논쟁 — 손실 수는 줄지만 0 결과가 폭증한다는 반증 연구",
  },
  {
    key: "P6", name: "상한고정 피라미딩", family: "증량",
    initSl: 2, tp: null, trail: { type: "donchian" }, trailArmR: 0,
    beArmR: null, partial: null, timeCut: null, pyramid: { stepN: 0.5, max: 3 }, capRisk: true,
    why: "P2의 수익 구조는 그대로 두고 결함만 뺀다. 증량할 때마다 스톱을 끌어올려 **총 하방이 언제나 초기 1R 이내**가 되게 한다. 사용자가 요구한 문장 그대로의 설계.",
    source: "P2 결과에서 갭·증량 초과 43.5%·최악 −9.25R을 확인한 뒤 추가(사후 추가, README §6)",
  },
];

/** 대조군 — 기존 패러다임과 진입 무작위. 이 둘을 못 이기면 기획은 의미가 없다. */
export const CONTROLS = [
  {
    key: "C0", name: "대칭 고정기하(대조)", family: "대조",
    initSl: 1.5, tp: 3, trail: null, trailArmR: 0,
    beArmR: null, partial: null, timeCut: null, pyramid: null,
    why: "이전 11회차가 써 온 손절1.5·목표3 고정 기하. 상방이 닫혀 있다. 비대칭 설계가 이것을 이겨야 한다.",
    source: "backtest-lab 1~2회차 EXITS x3",
  },
];

export const ALL_PLANS = [...PLANS, ...CONTROLS];

/** 진입 계열 — 전 회차에서 살아남았거나(인사이드바) 러너 설계와 논리적으로 맞물리는 것만. */
export const ENTRIES = [
  { key: "inside-bar", why: "3개 회차에서 독립적으로 생존한 유일 신호. 수축→확장이라 진입가가 수축 끝단에 붙어 손절폭이 좁다 — 비대칭의 분모가 작다." },
  { key: "donchian-break", why: "터틀 정통 진입. 러너 설계의 원산지." },
  { key: "big-bar", why: "범위 2.5ATR 이상 방향봉 — 확장 국면 진입. 러너가 필요로 하는 추세의 출발점." },
  { key: "pivot-hh", why: "10봉 고점 돌파 + EMA50 위. 구조적 신고가." },
  { key: "supertrend-flip", why: "추세 전환 대표. 워크포워드에서 −(음수)였던 계열 — 청산 설계로 구제되는지 본다." },
  { key: "ttm-squeeze", why: "BB가 KC 안에 들어간 수축이 풀리는 봉. 인사이드바의 지표판." },
  { key: "macd-cross", why: "워크포워드 OOS 누적 +28.9%로 상위 3위였던 계열." },
  { key: "ema-cross", why: "가장 흔한 추세 진입. 기준선." },
];

export const FILTER_KEYS = ["f0", "f1"];

/** 러너를 위한 보유 한도 — 기존의 10~60배. 이 우리를 여는 것이 이번 회차의 본체다. */
export const MAX_HOLD = { "15m": 1920, "1H": 720, "4H": 540 };
/** 시간컷 K봉 — 약 2일. */
export const CUT_BARS = { "15m": 192, "1H": 48, "4H": 12 };
