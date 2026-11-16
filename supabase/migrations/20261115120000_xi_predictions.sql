-- The scout's XI track record (services/xiPredictions.ts). Before each match of a club people ask
-- about, the server stores two predictions of its starting XI: the one code works out from recent
-- lineups (predicted_code) and one a model adjusts for the club's story, absences and fixture
-- (predicted_adjusted). After the match it stores the lineup ESPN published and scores both.
-- One row per club and ESPN match id.
create table if not exists public.xi_predictions (
  club_key text not null check (char_length(club_key) <= 120),     -- folded club slug of the live data's name, as club_snapshots keys it
  match_id text not null check (char_length(match_id) <= 40),      -- ESPN event id
  club_name text not null check (char_length(club_name) <= 120),
  league text not null check (char_length(league) <= 120),
  kickoff_at timestamptz not null,
  opponent text not null check (char_length(opponent) <= 120),
  competition text not null check (char_length(competition) <= 120),
  home boolean not null,

  -- Predictions: { slots: [{ role, name, rotation? }] }, adjusted also { reasons: [string] }
  predicted_code jsonb not null check (pg_column_size(predicted_code) <= 16384),
  predicted_adjusted jsonb check (pg_column_size(predicted_adjusted) <= 16384), -- null when the adjusted call failed
  adjusted_status text not null check (adjusted_status in ('ok', 'failed')),
  formation_code text,
  formation_adjusted text,
  basis text not null check (basis in ('lineups', 'season_starts')),
  matches_read integer not null check (matches_read between 0 and 20),
  snapshot_built_at timestamptz not null,                         -- builtAt of the stored club snapshot used
  snapshot_version integer not null,
  predicted_at timestamptz not null default now(),

  -- Filled after the match
  actual jsonb check (pg_column_size(actual) <= 16384),            -- { starters: [{ name, role }] } from parseMatchLineup
  actual_formation text,
  scored_at timestamptz,
  late boolean not null default false,                             -- predicted after kickoff: scored but left out of the record
  names_right_code smallint check (names_right_code between 0 and 11),
  slots_right_code smallint check (slots_right_code between 0 and 11),
  formation_right_code boolean,                                    -- null when either side has no formation
  names_right_adjusted smallint check (names_right_adjusted between 0 and 11),
  slots_right_adjusted smallint check (slots_right_adjusted between 0 and 11),
  formation_right_adjusted boolean,

  primary key (club_key, match_id)
);

create index if not exists xi_predictions_club_kickoff on public.xi_predictions (club_key, kickoff_at desc);

alter table public.xi_predictions enable row level security;

-- RLS: anyone may read a row; only the server writes, with the secret key, which bypasses RLS.
-- There are no insert, update or delete policies, so a browser's publishable key can't change the
-- record.
create policy "Public read" on public.xi_predictions for select using (true);
