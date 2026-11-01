-- Each club's situation snapshot, shared by every user like club_managers: the first-choice XI,
-- absences and form worked out from live match data, plus what changed since last season and what
-- is distinctive this season, read from a research pass. Built when someone first asks about the
-- club and rebuilt at most once a day (services/clubSnapshots.ts), so every user and turn works
-- from the same facts.
create table if not exists public.club_snapshots (
  club_key text primary key check (char_length(club_key) <= 120),   -- folded club slug of the live data's name, e.g. arsenal
  club_name text not null check (char_length(club_name) <= 120),
  league text not null check (char_length(league) <= 120),
  snapshot jsonb not null check (pg_column_size(snapshot) <= 65536), -- { core, story, sources }
  version integer not null,                                          -- SNAPSHOT_VERSION when built; older versions are rebuilt
  built_at timestamptz not null default now()
);

alter table public.club_snapshots enable row level security;

-- The app has no user accounts, so any client may read and refresh a row (same as club_managers).
create policy "Public read" on public.club_snapshots for select using (true);
create policy "Public insert" on public.club_snapshots for insert with check (true);
create policy "Public update" on public.club_snapshots for update using (true);
