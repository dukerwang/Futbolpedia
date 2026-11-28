-- The football knowledge base, phase 1: who a name means (services/kb/). Identity read from
-- Wikidata by code, with no model: sourced facts, never judgments, and no appearance or goal counts,
-- which are stale there. Every later layer of the knowledge base joins on wikidata_id.
-- Both tables are written only by the server, with the secret key, which bypasses RLS; neither has
-- an insert, update or delete policy, so a browser's publishable key can't change who a name means.
-- A row is read again from Wikidata once it is a week old (services/kb/store.ts).

create table if not exists public.kb_entities (
  wikidata_id text primary key check (wikidata_id ~ '^Q[1-9][0-9]*$'),
  kind text not null check (kind in ('player', 'club')),
  label text not null check (char_length(label) <= 200),
  aliases text[] not null default '{}',
  birth_date text check (birth_date ~ '^[0-9]{4}(-[0-9]{2}){0,2}$'),   -- YYYY, YYYY-MM or YYYY-MM-DD, as precisely as Wikidata knows
  nationality text[] not null default '{}',                            -- a player's sporting nationality, a club's country
  positions text[] not null default '{}',
  wikipedia_title text check (char_length(wikipedia_title) <= 300),    -- the English article
  external_ids jsonb not null default '{}'::jsonb check (pg_column_size(external_ids) <= 2048),  -- { espn, transfermarkt, fbref, sofascore, uefa }
  spells jsonb not null default '[]'::jsonb check (pg_column_size(spells) <= 32768),             -- [{ teamId, club, start, end, loan }], years
  current_club text check (char_length(current_club) <= 200),          -- worked out from the spells when read
  fetched_at timestamptz not null default now()
);

alter table public.kb_entities enable row level security;
create policy "Public read" on public.kb_entities for select using (true);

-- Which name and hint found which entities, so a repeat is answered without asking Wikidata. A name
-- is never matched against the entities above: that would settle it on whoever was stored first.
-- Its keys are what people typed, so it has no read policy either: only the server reads it.
create table if not exists public.kb_lookups (
  lookup_key text primary key check (char_length(lookup_key) <= 400),  -- the folded name and the parsed hint
  status text not null check (status in ('resolved', 'ambiguous')),
  entity_ids text[] not null check (cardinality(entity_ids) between 1 and 8),
  reason text check (char_length(reason) <= 300),
  fetched_at timestamptz not null default now()
);

alter table public.kb_lookups enable row level security;
