-- Settled verdicts on questions about the past (services/debateVerdicts.ts): the scout's answer to
-- who was better, or in what order, on given versions and a given criterion, so later turns read it
-- as a prior. Keyed by the versions compared and the criterion, never by what a user typed. Design:
-- docs/superpowers/specs/2026-11-18-past-questions-deep-design.md.
--
-- Written only by the server, with the secret key, after it checks a proposed verdict itself: code
-- holds a card-settled criterion to the cards, and one model call reads the records and accepts or
-- refuses. A browser can propose a choice among subjects; no browser text is stored.
create table if not exists public.debate_verdicts (
  verdict_key text primary key check (char_length(verdict_key) <= 200),
  kind text not null check (kind in ('head_to_head', 'ranking')),
  criterion text not null check (char_length(criterion) <= 40),
  subject_set text not null check (char_length(subject_set) <= 2000),   -- sorted subject keys, joined by |
  scope_key text check (char_length(scope_key) <= 120),                  -- a ranking's field: position|period
  subjects jsonb not null check (pg_column_size(subjects) <= 16384),      -- [{ key, label }]
  verdict jsonb not null check (pg_column_size(verdict) <= 4096),         -- subject keys: the winner, or the order
  criteria jsonb not null check (pg_column_size(criteria) <= 4096),       -- the server's criterion names
  counter_case text not null default '' check (char_length(counter_case) <= 600),
  fingerprint text not null check (char_length(fingerprint) <= 2000),     -- each card's key, Overall and re-rate time
  era_mark timestamptz,                                                   -- newest era snapshot of its subjects when settled
  status text not null default 'current' check (status in ('current', 'contested')),
  departures integer not null default 0 check (departures between 0 and 1000),
  version integer not null check (version between 1 and 100),
  settled_at timestamptz not null default now()
);

create index if not exists debate_verdicts_subject_set on public.debate_verdicts (subject_set);
create index if not exists debate_verdicts_scope_key on public.debate_verdicts (scope_key);

alter table public.debate_verdicts enable row level security;

-- RLS: anyone may read; only the server writes, with the secret key, which bypasses RLS. There are
-- no insert, update or delete policies, so a browser's publishable key can't change the table.
create policy "Public read" on public.debate_verdicts for select using (true);

-- A stored verdict changes only for a reason: a newer build version, a re-rated card (the
-- fingerprint), a newer era snapshot of its subjects (the era mark), or a row that was contested.
-- Status and departure counts may change freely. Any other change of verdict is skipped.
create or replace function public.keep_debate_verdicts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.verdict is distinct from old.verdict
     and new.version <= old.version
     and new.fingerprint is not distinct from old.fingerprint
     and new.era_mark is not distinct from old.era_mark
     and old.status <> 'contested' then
    return null;  -- keep the stored row
  end if;
  new.verdict_key := old.verdict_key;
  new.kind := old.kind;
  new.criterion := old.criterion;
  return new;
end;
$$;

drop trigger if exists keep_debate_verdicts on public.debate_verdicts;
create trigger keep_debate_verdicts
  before update on public.debate_verdicts
  for each row execute function public.keep_debate_verdicts();
