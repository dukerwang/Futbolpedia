-- Cards rated before the 2026-10-20 recalibration (CALIBRATION_EPOCH_MS) use the old rating
-- scale. Re-ratings read a player's previous cards as history, so old numbers would pull new
-- ratings back toward the old scale. Move them out of the live table into an archive.
--
-- "Rated at" follows the app's isRatedOnCurrentScale: the card's own createdAt stamp (ms),
-- falling back to the row's updated_at. The archive table has row-level security on and no
-- policies, so clients can't read it. To restore everything:
--   insert into public.player_profiles (id, player_slug, player_data, created_at, updated_at)
--   select id, player_slug, player_data, created_at, updated_at
--   from public.player_profiles_pre_recalibration
--   on conflict (player_slug) do nothing;
create table if not exists public.player_profiles_pre_recalibration (
  id uuid primary key,
  player_slug text not null,
  player_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz not null default now()
);

alter table public.player_profiles_pre_recalibration enable row level security;

with old_scale as (
  select id
  from public.player_profiles
  where coalesce(nullif(player_data->>'createdAt', '')::numeric, extract(epoch from updated_at) * 1000)
        < extract(epoch from timestamptz '2026-10-20T21:15:00Z') * 1000
),
archived as (
  insert into public.player_profiles_pre_recalibration (id, player_slug, player_data, created_at, updated_at)
  select p.id, p.player_slug, p.player_data, p.created_at, p.updated_at
  from public.player_profiles p
  join old_scale using (id)
  on conflict (id) do nothing
  returning id
)
delete from public.player_profiles p
using archived a
where p.id = a.id;
