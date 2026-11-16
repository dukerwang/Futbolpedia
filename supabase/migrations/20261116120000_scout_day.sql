-- The scout's day (services/scoutDay.ts): once a day the server's planning call chooses what to
-- research, code carries it out within a call budget, and the pass is written to a journal.
-- Both tables are written only by the server, with the secret key, which bypasses RLS. Like
-- club_snapshots, they have a public read policy and no insert, update or delete policy, so a
-- browser's publishable key can't change what the writer reads or what the journal says.

-- One grounded search the scout ran for a club or a player, kept as a dated note. Chat reads the
-- notes from the last 14 days as evidence for their subject (services/scoutNotes.ts).
create table if not exists public.scout_notes (
  id bigint generated always as identity primary key,
  day date not null,                                                  -- the UTC day the note was written
  subject text not null check (char_length(subject) <= 120),          -- a club or a player, as the plan named it
  subject_key text not null check (char_length(subject_key) <= 120),  -- folded slug, as club_snapshots keys a club
  question text not null check (char_length(question) <= 300),
  note text not null check (char_length(note) <= 8000),               -- the dated digest, points dated by their source
  sources jsonb not null default '[]'::jsonb check (pg_column_size(sources) <= 4096),
  created_at timestamptz not null default now(),
  unique (day, subject_key, question)
);

create index if not exists scout_notes_subject_day on public.scout_notes (subject_key, day desc);

alter table public.scout_notes enable row level security;
create policy "Public read" on public.scout_notes for select using (true);

-- One row per UTC day: the signals the pass read, the plan with its reasons, what ran with its
-- call count and outcome, and what was skipped and why. A row is written when the pass starts
-- (status running) and finished when it ends (status done); a day with a done row is not run again.
create table if not exists public.scout_journal (
  day date primary key,
  status text not null check (status in ('running', 'done')),
  budget integer not null check (budget >= 0),
  calls_spent integer not null default 0 check (calls_spent >= 0),
  signals jsonb not null check (pg_column_size(signals) <= 200000),
  plan jsonb not null check (pg_column_size(plan) <= 50000),          -- { summary, actions: [{ type, ..., reason }] }
  ran jsonb not null default '[]'::jsonb check (pg_column_size(ran) <= 50000),
  skipped jsonb not null default '[]'::jsonb check (pg_column_size(skipped) <= 50000),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scout_journal enable row level security;
create policy "Public read" on public.scout_journal for select using (true);
