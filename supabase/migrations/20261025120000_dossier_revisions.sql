-- Accepted dossier challenges. Each row is one user's accepted change to a shared card; the
-- shared card itself only changes at its next weekly re-rating (or early, on consensus).
create table if not exists public.dossier_revisions (
  id uuid primary key default gen_random_uuid(),
  card_slug text not null,              -- versioned slug of the shared card, e.g. pedri--current--2026-10-25
  player_base text not null,            -- base player slug, e.g. pedri
  edition text not null,                -- current | prime | season_snapshot | retro
  card_date date not null,
  deltas jsonb not null default '{}'::jsonb,  -- { "overall": 1, "vision": -2, ... }
  rationale text check (char_length(rationale) <= 4000),
  evidence text check (char_length(evidence) <= 4000),
  client_id text not null check (char_length(client_id) <= 64),
  created_at timestamptz not null default now()
);

create index if not exists dossier_revisions_card_slug_idx on public.dossier_revisions (card_slug);
create index if not exists dossier_revisions_player_idx
  on public.dossier_revisions (player_base, created_at desc);

alter table public.dossier_revisions enable row level security;

-- Anyone can read and log proposals (the app has no user accounts); nobody can edit or delete them.
create policy "Public read" on public.dossier_revisions for select using (true);
create policy "Public insert" on public.dossier_revisions for insert with check (true);
