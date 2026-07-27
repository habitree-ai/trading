-- 캡쳐에 있으나 쓰지 않던 정보 3가지를 반영한다.

-- 1) 주문번호 — 같은 거래를 두 번 등록하는 사고를 막는 유일한 열쇠.
--    IMG_5084 와 IMG_5087 은 폰 시계만 다른 동일 거래이고,
--    IMG_5083 은 그 거래의 청산 주문을 파고든 화면이다. 주문번호로만 알아볼 수 있다.
alter table public.trade_fills add column order_no text;

create unique index trade_fills_order_no_uniq
  on public.trade_fills (user_id, order_no)
  where order_no is not null;

-- 2) 펀딩피 분리 — 거래 수수료는 체결 비용, 펀딩피는 보유 비용이라 성격이 다르다.
--    합쳐 두면 "오래 들고 있어서 샌 돈"을 따로 볼 수 없다.
alter table public.trades add column funding_fee numeric;

comment on column public.trades.fee is '거래 수수료 — OKX `Trading fee`. 부호 포함(보통 음수)';
comment on column public.trades.funding_fee is '펀딩비 — OKX `Funding fee`. 보유 비용이라 거래 수수료와 나눠 둔다';

-- 3) 마진 모드 — 교차/격리는 청산 위험이 전혀 달라 복기 축이 된다.
--    text + CHECK 로 두면 생성 타입이 그냥 string 이라 코드에서 좁힐 수 없다.
create type public.margin_mode as enum ('cross', 'isolated');

alter table public.trades add column margin_mode public.margin_mode;
