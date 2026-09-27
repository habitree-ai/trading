-- 청산 이후 계획 — 근거 아래 두 칸 (REQ-0084).
--
-- 근거는 "왜 들어갔는가"만 적는다. 손절로 끝나면 무엇을 하고 수익으로 끝나면 무엇을 할지를
-- 진입 때 미리 적어 두면, 청산 직후 즉흥적으로 결정하지 않게 된다. 손 입력 전용 — 동기화·주문
-- 경로는 이 열을 쓰지 않는다. 기존 행은 null(미기재).
alter table public.trades add column plan_on_loss text;
alter table public.trades add column plan_on_profit text;

comment on column public.trades.plan_on_loss is
  '청산 이후 계획 — 손절로 끝났을 때 할 일. 손 입력 전용, null 은 미기재.';
comment on column public.trades.plan_on_profit is
  '청산 이후 계획 — 수익으로 끝났을 때 할 일. 손 입력 전용, null 은 미기재.';
