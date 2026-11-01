-- Permanent era snapshots, shared by every user like club_snapshots but kept for good, since the
-- past doesn't change (services/eraSnapshots.ts):
--   club_season    a club's season: coach, usual XI and shape, record, what defined it
--   player_window  a player across the seasons a card rates: role, clubs, numbers, honours
-- Each row is built on the server from Wikipedia, ESPN and a research pass the first time someone
-- asks (services/snapshotServer.ts), then read by everyone.
create table if not exists public.era_snapshots (
  snapshot_key text primary key check (char_length(snapshot_key) <= 200),  -- kind:subject-slug:period
  kind text not null check (kind in ('club_season', 'player_window')),
  subject text not null check (char_length(subject) <= 200),
  period text not null check (char_length(period) <= 40),
  snapshot jsonb not null check (pg_column_size(snapshot) <= 65536),         -- { story, sources }
  version integer not null check (version between 1 and 100),              -- ERA_SNAPSHOT_VERSION when built
  built_at timestamptz not null default now()
);

alter table public.era_snapshots enable row level security;

-- RLS: anyone may read a row; only the server writes, with the secret key, which bypasses RLS.
-- There are no insert, update or delete policies, so a browser's publishable key can't change the
-- table. A row is meant to last, so even the server replaces one only with a newer build version
-- (a rebuild after ERA_SNAPSHOT_VERSION is bumped); any other update is skipped without an error.
create policy "Public read" on public.era_snapshots for select using (true);

create or replace function public.keep_era_snapshots()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version <= old.version then
    return null;  -- keep the stored row
  end if;
  new.snapshot_key := old.snapshot_key;
  new.kind := old.kind;
  return new;
end;
$$;

drop trigger if exists keep_era_snapshots on public.era_snapshots;
create trigger keep_era_snapshots
  before update on public.era_snapshots
  for each row execute function public.keep_era_snapshots();
