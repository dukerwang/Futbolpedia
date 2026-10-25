-- Verified current head coach per club, shared by every user like the dossier cards.
-- Each row comes from a live Google-grounded search, cross-checked against API-Football's coach
-- record, and is refreshed at most once a day when someone first asks about the club.
-- This replaces the hand-maintained KNOWN_CLUB_MANAGERS table that used to live in code.
create table if not exists public.club_managers (
  club_key text primary key check (char_length(club_key) <= 120),   -- folded club slug, e.g. chelsea
  club_name text not null check (char_length(club_name) <= 120),
  coach text check (char_length(coach) <= 120),                      -- null when the search could not confirm one
  previous_coach text check (char_length(previous_coach) <= 120),    -- immediate predecessor, for stale-name rewrites
  coach_since date,
  source_url text check (char_length(source_url) <= 2000),
  source_date date,
  api_coach text check (char_length(api_coach) <= 120),              -- API-Football's record, kept for the cross-check
  sources_agree boolean,                                             -- null when API-Football had no record
  verified_at timestamptz not null default now()
);

alter table public.club_managers enable row level security;

-- The app has no user accounts, so any client may read and refresh a row (same as player_profiles).
create policy "Public read" on public.club_managers for select using (true);
create policy "Public insert" on public.club_managers for insert with check (true);
create policy "Public update" on public.club_managers for update using (true);
