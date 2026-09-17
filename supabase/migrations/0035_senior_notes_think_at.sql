-- 노트의 「내 생각」 작성일 — 내 생각이 처음 적힌 시각.
--
-- 노트 작성일(created_at)로는 안 된다: 원문(quote)을 먼저 넣고 생각은 며칠 뒤에 붙이는
-- 노트가 많다. 수정일(updated_at)은 원문·태그만 고쳐도 바뀐다.
--
-- 값은 트리거가 찍는다 — 화면의 서버 액션과 에이전트 CLI(scripts/senior-notes.mjs)가
-- 이 열을 모르고도 같은 규칙을 따르게. 규칙:
--   · 비어 있던 내 생각이 채워지면 now()
--   · 내 생각을 비우면 null
--   · 이미 있는 생각을 고치거나 덧붙이면 그대로 — "처음 적은 날"이다(마지막 수정은 updated_at)
--   · 내 생각이 그대로인 수정은 이 열을 건드리지 않는다(아래 채우기·손 보정이 가능하게)

alter table public.senior_notes add column think_at timestamptz;

comment on column public.senior_notes.think_at is
  '내 생각(think)이 처음 적힌 시각. 트리거 senior_notes_touch_think_at 이 관리한다. null = 아직 생각을 적지 않음';

create function public.senior_notes_touch_think_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if btrim(new.think) <> '' then
      new.think_at := coalesce(new.think_at, now());
    else
      new.think_at := null;
    end if;
  elsif new.think is distinct from old.think then
    if btrim(new.think) = '' then
      new.think_at := null;
    elsif btrim(old.think) = '' then
      new.think_at := now();
    else
      new.think_at := old.think_at;
    end if;
  end if;
  return new;
end;
$$;

-- 기존 행 채우기 — 생각이 있는 노트는 마지막 수정일로(2026-09-17 사용자 선택).
-- 트리거보다 먼저 돌려 규칙에 걸리지 않게 한다. updated_at 트리거가 now() 로 덮지 않도록
-- 이 문장 동안만 그 트리거를 끈다.
alter table public.senior_notes disable trigger senior_notes_touch_updated_at;
update public.senior_notes
   set think_at = updated_at
 where btrim(think) <> '';
alter table public.senior_notes enable trigger senior_notes_touch_updated_at;

create trigger senior_notes_touch_think_at
  before insert or update on public.senior_notes
  for each row execute function public.senior_notes_touch_think_at();
