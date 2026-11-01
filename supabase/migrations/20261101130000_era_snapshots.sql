-- Permanent era snapshots, shared by every user like club_snapshots but kept for good, since the
-- past doesn't change (services/eraSnapshots.ts):
--   club_season    a club's season: coach, usual XI and shape, record, what defined it
--   player_window  a player across the seasons a card rates: role, clubs, numbers, honours
--   debate         a settled debate's brief (criteria, versions, verdict), keyed by the question's
--                  words and the cards in play, so the same question gets the same verdict
-- Each row is built from Wikipedia, ESPN and a research pass the first time someone asks, then
-- read by everyone.
create table if not exists public.era_snapshots (
  snapshot_key text primary key check (char_length(snapshot_key) <= 200),  -- kind:subject-slug:period, or debate:hash:signature
  kind text not null check (kind in ('club_season', 'player_window', 'debate')),
  subject text not null check (char_length(subject) <= 200),
  period text not null check (char_length(period) <= 40),
  snapshot jsonb not null check (pg_column_size(snapshot) <= 65536),         -- { story, sources } or { brief }
  version integer not null check (version between 1 and 100),              -- ERA_SNAPSHOT_VERSION when built
  built_at timestamptz not null default now()
);

alter table public.era_snapshots enable row level security;

-- RLS: the app has no user accounts, so as with club_managers and club_snapshots, any client may
-- read a row and add one. Unlike those daily caches, a row here is meant to last, so a client can't
-- rewrite it: an update only goes through when it carries a newer build version (a rebuild after
-- ERA_SNAPSHOT_VERSION is bumped); any other update is skipped without an error. There's no delete
-- policy, so rows can't be deleted from the client. The size and version checks bound what a
-- client can store. What this doesn't stop is a client inserting a bad row for a key nobody has
-- built yet; a version bump rebuilds every row, which is the remedy.
create policy "Public read" on public.era_snapshots for select using (true);
create policy "Public insert" on public.era_snapshots for insert with check (true);
create policy "Public update" on public.era_snapshots for update using (true);

create or replace function public.keep_era_snapshots()
returns trigger
language plpgsql
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
