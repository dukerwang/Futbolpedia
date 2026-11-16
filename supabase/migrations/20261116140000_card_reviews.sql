-- Card review (services/cardReview.ts): inside the scout's day, the server re-rates current cards
-- whose window has closed and reviews its own prime re-rates before publishing them. Every review
-- is one row here, whatever its outcome. Like scout_journal, the table is written only by the
-- server with the secret key, which bypasses RLS; it has a public read policy and no insert,
-- update or delete policy, so a browser can read why a rating changed but never write the record.

create table if not exists public.card_reviews (
  id bigint generated always as identity primary key,
  day date not null,                                                   -- the UTC day of the scout's pass
  action text not null check (action in ('rerate_current', 'review_prime')),
  card_key text not null check (char_length(card_key) <= 200),         -- the reviewed card's key
  player text not null check (char_length(player) <= 120),
  player_slug text not null check (char_length(player_slug) <= 120),   -- toBasePlayerSlug of the name
  edition text not null check (char_length(edition) <= 40),
  reason text not null check (char_length(reason) <= 600),             -- why the review was opened, from the signals
  opened jsonb not null default '{}'::jsonb check (pg_column_size(opened) <= 20000), -- { kind, summary, evidence }
  old_card jsonb not null check (pg_column_size(old_card) <= 200000),
  draft jsonb check (pg_column_size(draft) <= 200000),                 -- the last draft; null when none was made
  verdict text not null check (verdict in ('accept', 'refuse', 'rerated')), -- rerated: a current card, published as a visitor's request is
  reasons jsonb not null default '[]'::jsonb check (pg_column_size(reasons) <= 20000),
  revise_notes text check (char_length(revise_notes) <= 4000),
  rounds jsonb not null default '[]'::jsonb check (pg_column_size(rounds) <= 50000), -- each draft's verdict, reasons and notes
  published boolean not null default false,
  published_card_key text check (char_length(published_card_key) <= 200),
  published_at timestamptz,
  old_overall integer,
  new_overall integer,
  created_at timestamptz not null default now()
);

create index if not exists card_reviews_published_key on public.card_reviews (published_card_key, created_at desc) where published;
create index if not exists card_reviews_player on public.card_reviews (player_slug, created_at desc);

alter table public.card_reviews enable row level security;
create policy "Public read" on public.card_reviews for select using (true);

-- The day's card work has its own budget line, so card reviews never starve snapshot builds.
alter table public.scout_journal add column if not exists card_budget integer not null default 0 check (card_budget >= 0);
alter table public.scout_journal add column if not exists card_calls_spent integer not null default 0 check (card_calls_spent >= 0);
