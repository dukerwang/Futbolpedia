-- The knowledge base's team strength: an Elo rating per club, computed by code from ESPN results
-- (services/kb/teamStrength.ts). Each snapshot is the ratings on the first of a month, at a
-- season's end, or the latest of the season in progress. The server builds and stores them with the
-- secret key, which bypasses RLS; anyone may read them, and a browser can't write them. A row for
-- team_id '*' marks a snapshot as complete, with its row count in `matches`.
create table if not exists public.kb_team_strength (
  team_id text not null check (char_length(team_id) <= 20),          -- ESPN team ID, or '*' for a marker
  club text not null check (char_length(club) <= 120),
  league text check (char_length(league) <= 60),                     -- ESPN slug of its latest numbered league
  league_match date,                                                 -- when that league match was
  in_europe boolean not null default false,                          -- has played in a UEFA competition
  rated_on date not null,
  kind text not null check (kind in ('month', 'season_end', 'latest')),
  rating double precision not null,
  matches integer not null check (matches >= 0),                     -- matches counted since 2003-04
  last_match date not null,
  built_at timestamptz not null default now(),
  primary key (team_id, rated_on, kind)
);

-- A snapshot is read whole, by date and kind; the markers are found by team_id through the key.
create index if not exists kb_team_strength_snapshot on public.kb_team_strength (rated_on, kind, team_id);

alter table public.kb_team_strength enable row level security;

create policy "Public read" on public.kb_team_strength for select using (true);
