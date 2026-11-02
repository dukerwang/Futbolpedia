-- Club snapshots are built and stored by the server (services/snapshotServer.ts) with the secret
-- key, which bypasses RLS. Browsers keep read access but can no longer insert or update a row, so
-- nobody can change the facts every user's chat reads.
drop policy if exists "Public insert" on public.club_snapshots;
drop policy if exists "Public update" on public.club_snapshots;
