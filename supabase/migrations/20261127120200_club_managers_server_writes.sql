-- Coach lookups run and are stored on the server (services/clubManagerServer.ts) with the secret
-- key, which bypasses RLS. Browsers keep read access but can no longer insert or update a row, so
-- nobody can set the coach name the app treats as verified.
--
-- Order: apply AFTER the app with GET /api/clubs/manager is published, with SUPABASE_SECRET_KEY set.
-- Applied earlier, nothing breaks, but the app before it can't store its lookups for other users.
drop policy if exists "Public insert" on public.club_managers;
drop policy if exists "Public update" on public.club_managers;

-- Any browser could have written these rows. The table is a one-day cache, so it's emptied and the
-- server looks each club up again when someone next asks about it.
delete from public.club_managers;
